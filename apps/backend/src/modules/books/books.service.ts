import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type OnApplicationBootstrap
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { BOOK_IMPORT_QUEUE } from "../../infra/queue/queue-names";
import { StoreService } from "../store/store.service";
import { BookImportProcessor } from "./books-import.processor";
import {
  BOOKS_SEARCH_INDEX,
  buildBookSearchQuery,
  ensureBooksIndex,
  indexBooksWhere,
  isTruthyFlag,
  reindexAllBooks,
  toBookDocument,
  type BookForIndex,
  type ReindexResult
} from "./books-search-index";
import * as ExcelJS from "exceljs";
import { randomInt } from "crypto";

// ISBN'siz kitoblar uchun ichki EAN-13 kod prefiksi (GS1: 2xx — ichki foydalanish).
export const INTERNAL_CODE_PREFIX = "2";

export interface CreateBookDto {
  isbn: string;
  title: string;
  author: string;
  genre: string;
  lang?: string;
  pages?: number;
  year?: number;
  coverUrl?: string;
  description?: string;
  totalCount?: number;
  libraryId: string;
}

// lookupIsbn natijasi: avvalgi kitob ma'lumotlari (lokal bazadan yoki tashqi
// Open Library'dan). `source` qaysi manbadan kelganini bildiradi — UI mos
// xabar ko'rsatadi ("Bazadan yuklandi" vs "Open Library'dan").
export type IsbnLookupResult = Partial<CreateBookDto> & {
  source?: "local" | "external";
};

// create() natijasi: kitob obyekti + frontend uchun aniq holat belgisi.
// `duplicate` true bo'lsa — shu ISBN shu kutubxonada allaqachon bor edi va
// nusxa qo'shildi (yangi yozuv yaratilmadi). `message` — UI ko'rsatadigan
// o'zbekcha matn (toast emas, yumshoq xabar).
export type CreateBookResult = BookWithLibrary & {
  duplicate: boolean;
  message?: string;
};

// Prisma `book.create({ include: { library: true } })` qaytaradigan shakl.
// Aniq tiplash uchun minimal interfeys (test mock'lari ham shu shaklda).
interface BookWithLibrary {
  id: string;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  lang: string;
  pages: number;
  year: number;
  coverUrl: string | null;
  description: string | null;
  totalCount: number;
  availableCount: number;
  libraryId: string;
  [key: string]: unknown;
}

export interface UpdateBookDto {
  title?: string;
  author?: string;
  genre?: string;
  lang?: string;
  pages?: number;
  year?: number;
  coverUrl?: string;
  description?: string;
  totalCount?: number;
  availableCount?: number;
}

export interface SearchBooksDto {
  q?: string;
  genre?: string;
  lang?: string;
  libraryId?: string;
  available?: boolean;
  lat?: number;
  lon?: number;
  page?: number;
  limit?: number;
}

// AUDIT-REPORT M16 — pagination chegaralari. search() uchun limit har doim
// [1, 100] oralig'iga, findAll() uchun [1, 200] oralig'iga qisqartiriladi —
// aks holda ?limit=100000 bilan butun jadvalni tortib olish mumkin edi.
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 100;
const FIND_ALL_LIMIT_DEFAULT = 50;
const FIND_ALL_LIMIT_MAX = 200;

// Query-string dan kelgan limit string bo'lishi mumkin (SearchBooksDto —
// interface, ValidationPipe transform qilmaydi) — Number() + NaN himoyasi.
function clampLimit(raw: number | undefined, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

// Sahifa raqami ham query-string'dan keladi: "abc" → NaN → ES `from: NaN` xato
// berib, HAMMA uchun 60 s cooldown yoqilardi (har kim ?page=abc bilan ES'ni
// o'chirib qo'ya olardi); Prisma `skip: NaN` esa 500. Noto'g'ri qiymat → 1.
function clampPage(raw: number | string | undefined): number {
  const n = Math.floor(Number(raw ?? 1));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export interface BookImportJobData {
  libraryId: string;
  uploaderUserId: string;
  fileBase64: string; // ≤10MB cap is enforced upstream by FileInterceptor
}

export interface BookImportStatus {
  status: "queued" | "active" | "completed" | "failed" | "delayed" | "waiting" | "paused" | "unknown";
  processed: number;
  total: number;
  /** FR2: fondda allaqachon bor ISBN qatorlari (o'tkazib yuborilgan). */
  skipped: number;
  errors: { row: number; reason: string }[];
  progress: number;
}

@Injectable()
export class BooksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly es: ElasticsearchService,
    @InjectQueue(BOOK_IMPORT_QUEUE)
    private readonly importQueue: Queue<BookImportJobData>,
    private readonly storeService: StoreService,
    private readonly importProcessor: BookImportProcessor,
  ) {}

  // Navbat (Redis/BullMQ) javob bermasa import shu so'rovning o'zida bajariladi;
  // natija qisqa muddat xotirada turadi va status endpoint'i uni qaytaradi.
  private readonly syncImports = new Map<string, BookImportStatus & { at: number }>();
  private static readonly QUEUE_TIMEOUT_MS = 5000;

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("queue timeout")), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  // ES o'chirilgan bo'lsa (ELASTICSEARCH_ENABLED=false) qidiruv to'g'ridan-to'g'ri
  // Prisma'ga o'tadi va indekslash o'tkazib yuboriladi — o'lik ES portiga har
  // chaqiruvda ~8s osilishning oldini oladi. Default yoqilgan (production: ES bor).
  private readonly esEnabled = process.env.ELASTICSEARCH_ENABLED !== "false";

  // ES ulanish xatosidan keyin shuncha vaqt ES'ga qayta urinilmaydi (cooldown).
  // Aks holda yiqilgan ES'da HAR qidiruv requestTimeout + retry (~3.5 s) kutib,
  // keyin Prisma'ga o'tardi — foydalanuvchi uchun qidiruv "sekin" ko'rinardi.
  // Cooldown tugagach bitta urinish yana qilinadi (ES qayta tiklangan bo'lsa
  // ishlashda davom etadi).
  private static readonly ES_COOLDOWN_MS = 60_000;
  private esCooldownUntil = 0;

  // `sifat_books` mapping bilan mavjudligi tekshirilganmi (yozishdan oldin —
  // aks holda ES indeksni dinamik mapping bilan o'zi yaratib qo'yadi). ES
  // xatosida qayta tekshirish uchun false ga qaytariladi.
  private booksIndexReady = false;
  // Bo'sh indeksni bir marta to'ldirish tekshiruvi (bootstrap yoki cron'da).
  private esBackfillChecked = false;
  // "O'zgargan kitoblar" sinxronizatsiyasining oxirgi muvaffaqiyatli vaqti.
  private lastEsSyncAt = new Date();

  // ── Barcha kitoblar ───────────────────────────────────────────────────────
  // AUDIT-REPORT M16 — majburiy pagination: default 50, maksimum 200. Avval
  // butun books jadvali bitta so'rovda qaytarilardi. Javob shakli (massiv)
  // o'zgarmagan — mavjud chaqiruvchilar buzilmaydi, faqat hajm chegaralanadi.
  /**
   * Fond ro'yxati (boshqaruv paneli) — DB'dan, TO'LIQ qatorlar bilan.
   *
   * Nega `search()` emas: ES indeksida `totalCount`, `coverUrl`, `description`
   * yo'q (indexBook) — fond jadvali uchun ular shart. Shuning uchun bu yerda
   * Prisma, ixtiyoriy filtrlar (q — nomi/muallif/ISBN, janr, til, mavjudlik)
   * va jami son. Javob: { total, page, limit, data } — sahifalash uchun
   * (2026-11-01; avval faqat massiv edi, yagona chaqiruvchi — fond sahifasi).
   */
  async findAll(
    params: {
      libraryId?: string;
      q?: string;
      genre?: string;
      lang?: string;
      available?: boolean;
      /** Kitobxon kashfiyoti: o'z hududidagi kutubxonalar fondi. */
      viloyatId?: string;
      tumanId?: string;
      /** true — faqat faol (tasdiqlangan) kutubxonalar fondi. */
      activeLibraries?: boolean;
      page?: number;
      limit?: number;
    } = {}
  ) {
    const take = clampLimit(params.limit, FIND_ALL_LIMIT_DEFAULT, FIND_ALL_LIMIT_MAX);
    const pageNum = Number(params.page ?? 1);
    const safePage = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;
    const q = params.q?.trim();
    const genre = params.genre?.trim();
    const where = {
      ...(params.libraryId ? { libraryId: params.libraryId } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { author: { contains: q, mode: "insensitive" as const } },
              { isbn: { contains: q.replace(/[-\s]/g, "") } }
            ]
          }
        : {}),
      ...(genre ? { genre: { contains: genre, mode: "insensitive" as const } } : {}),
      // Til kodlari DB'da aralash ("uz", "uz-Latn", "uz-Cyrl") — prefiks bo'yicha.
      ...(params.lang ? { lang: { startsWith: params.lang, mode: "insensitive" as const } } : {}),
      ...(params.available ? { availableCount: { gt: 0 } } : {}),
      ...(params.viloyatId || params.tumanId || params.activeLibraries
        ? {
            library: {
              ...(params.viloyatId ? { viloyatId: params.viloyatId } : {}),
              ...(params.tumanId ? { tumanId: params.tumanId } : {}),
              ...(params.activeLibraries ? { status: "ACTIVE" as const } : {})
            }
          }
        : {})
    };
    const [data, total] = await Promise.all([
      this.prisma.book.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { library: true },
        skip: (safePage - 1) * take,
        take
      }),
      this.prisma.book.count({ where })
    ]);
    return { total, page: safePage, limit: take, data };
  }

  // ── Excel import shabloni (.xlsx) ──────────────────────────────────────────
  // Kutubxonachi/muassasa admini shablonni yuklab oladi, to'ldiradi va import
  // qiladi. Ustunlar import-processor o'qiydigan sarlavhalarga MOS keladi.
  async buildBookTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "SIFAT LIBRARY";
    const ws = wb.addWorksheet("Kitoblar");

    ws.columns = [
      { header: "ISBN", key: "isbn", width: 20 },
      { header: "Nomi", key: "title", width: 36 },
      { header: "Muallif", key: "author", width: 26 },
      { header: "Janr", key: "genre", width: 18 },
      { header: "Til", key: "lang", width: 10 },
      { header: "Sahifalar", key: "pages", width: 12 },
      { header: "Yil", key: "year", width: 10 },
      { header: "Nusxa", key: "count", width: 10 }
    ];

    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
    head.alignment = { vertical: "middle", horizontal: "left" };
    head.height = 22;

    // Namuna qatorlar (admin o'chirib o'rniga o'zinikini yozadi).
    ws.addRow({ isbn: "9789943000012", title: "Cho'l gulini sug'orma", author: "Abdulla Oripov", genre: "She'riyat", lang: "uz", pages: 120, year: 2015, count: 5 });
    ws.addRow({ isbn: "9789943111222", title: "O'tkan kunlar", author: "Abdulla Qodiriy", genre: "Roman", lang: "uz", pages: 400, year: 1925, count: 3 });

    const arrayBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ── Bitta kitob ───────────────────────────────────────────────────────────
  async findOne(id: string) {
    const book = await this.prisma.book.findUnique({
      where: { id },
      include: { library: true }
    });
    if (!book) throw new NotFoundException("Kitob topilmadi");
    return book;
  }

  // ── Kitob qo'shish ────────────────────────────────────────────────────────
  // ISBN tekshiruvi CREATE da format-only (isIsbnFormat) — qat'iy mod-10
  // check-digit emas. Sabab: demo/seed kitoblari (mas. 9789943000014) va
  // ko'plab haqiqiy nashrlar noto'g'ri/eski check-digit bilan keladi, lekin
  // ular baribir yaroqli 13 xonali ISBN. Format-only tolerantligi demo va
  // real dunyo kitoblarining ikkalasi ham saqlanishini ta'minlaydi.
  async create(dto: CreateBookDto): Promise<CreateBookResult> {
    // ISBN'siz kitob (eski nashrlar, qo'lyozma, mahalliy nashriyot): ISBN bo'sh
    // keladi → ichki kod (2xxxxxxxxxxxx) beriladi. Shu kutubxonada nomi va
    // muallifi bir xil ISBN'siz kitob bo'lsa — yangi yozuv emas, nusxa qo'shiladi.
    const noIsbn = !(dto.isbn ?? "").trim();
    if (!noIsbn && !this.isIsbnFormat(this.normalizeIsbn(dto.isbn)))
      throw new BadRequestException(
        "ISBN noto'g'ri — 13 xonali (978/979 bilan) yoki 10 xonali bo'lishi kerak. ISBN yo'q bo'lsa, maydonni bo'sh qoldiring."
      );
    if (noIsbn && (!dto.title?.trim() || !dto.author?.trim()))
      throw new BadRequestException("ISBN'siz kitob uchun nom va muallif majburiy");

    let cleanIsbn = noIsbn ? "" : this.normalizeIsbn(dto.isbn);
    // CreateBookDto interface'dir (klass emas) — ValidationPipe transform
    // ishlamaydi, shuning uchun raqamlar string/null/NaN/undefined kelishi
    // mumkin. Prisma Int maydoniga string berilsa 500 bo'ladi — bu yerda
    // har qanday qiymatni xavfsiz songa aylantiramiz.
    const total = Math.max(1, Math.trunc(Number(dto.totalCount)) || 1);
    const pages = Math.max(0, Math.trunc(Number(dto.pages)) || 0);
    const year = Math.trunc(Number(dto.year)) || 0;

    // Dublikat ISBN: shu kutubxonada bor bo'lsa — yangi yozuv yaratmasdan
    // nusxa qo'shamiz (total + available). Book modelida ISBN ga @@unique
    // yo'q, shuning uchun bu DB darajasida emas, biznes-mantiq darajasida
    // hal qilinadi. Boshqa kutubxonada bo'lsa — yangi yozuv yaratiladi.
    const existing = noIsbn
      ? await this.prisma.book.findFirst({
          where: {
            libraryId: dto.libraryId,
            isbn: { startsWith: INTERNAL_CODE_PREFIX },
            title: { equals: dto.title.trim(), mode: "insensitive" },
            author: { equals: dto.author.trim(), mode: "insensitive" },
          },
        })
      : await this.prisma.book.findFirst({
          where: { isbn: cleanIsbn, libraryId: dto.libraryId }
        });
    if (noIsbn && !existing) cleanIsbn = await this.generateInternalCode(dto.libraryId);

    if (existing) {
      const updated = await this.prisma.book.update({
        where: { id: existing.id },
        data: {
          totalCount: existing.totalCount + total,
          availableCount: existing.availableCount + total,
          // Mavjud yozuvda muqova/tavsif BO'SH bo'lsa va endi berilgan bo'lsa —
          // to'ldiramiz. Mavjud (bo'sh bo'lmagan) qiymat HECH QACHON ustiga
          // yozilmaydi — nusxa qo'shish ma'lumotni buzmaydi.
          ...(!existing.coverUrl && dto.coverUrl ? { coverUrl: dto.coverUrl } : {}),
          ...(!existing.description && dto.description
            ? { description: dto.description }
            : {})
        },
        include: { library: true }
      });
      await this.indexBook(updated);
      await this.updateLibraryFundCount(dto.libraryId);
      return {
        ...(updated as unknown as BookWithLibrary),
        duplicate: true,
        message: `Bu kitob allaqachon fondda — ${total} ta nusxa qo'shildi (jami ${updated.totalCount})`
      };
    }

    let book: BookWithLibrary;
    try {
      book = (await this.prisma.book.create({
        data: {
          isbn: cleanIsbn,
          title: dto.title,
          author: dto.author,
          genre: dto.genre,
          lang: dto.lang ?? "uz",
          pages,
          year,
          coverUrl: dto.coverUrl,
          description: dto.description ?? null,
          totalCount: total,
          availableCount: total,
          libraryId: dto.libraryId
        },
        include: { library: true }
      })) as unknown as BookWithLibrary;
    } catch (err) {
      // FR2: (libraryId, isbn) unique — yuqoridagi `existing` tekshiruvi bilan
      // bir vaqtda ikki kutubxonachi bir ISBN'ni qo'shsa, ikkinchisi shu yerga
      // tushadi. Ikkinchi qator yaratilmaydi; mijoz qayta yuborsa nusxa
      // sifatida qo'shiladi.
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          "Bu ISBN shu kutubxona fondiga hozirgina qo'shildi — nusxa sonini oshirish uchun qayta yuboring"
        );
      }
      throw err;
    }

    await this.indexBook(book);
    await this.updateLibraryFundCount(dto.libraryId);
    return { ...(book as unknown as BookWithLibrary), duplicate: false };
  }

  // ── Muqova rasmi (GET /books/:id/cover) ───────────────────────────────────
  // Faqat xavfsiz raster formatlar: SVG (ichida skript bo'lishi mumkin) va
  // boshqa turlar shu domendan berilmaydi. Tashqi URL (Open Library/Google)
  // bo'lsa — o'sha manzilga yo'naltiramiz.
  async getCover(
    id: string,
  ): Promise<{ kind: "image"; mime: string; data: Buffer } | { kind: "redirect"; url: string }> {
    const book = await this.prisma.book.findUnique({ where: { id }, select: { coverUrl: true } });
    const url = book?.coverUrl?.trim();
    if (!url) throw new NotFoundException("Muqova yo'q");
    const m = url.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (m) {
      const mime = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
      return { kind: "image", mime, data: Buffer.from(m[2], "base64") };
    }
    if (/^https:\/\//i.test(url)) return { kind: "redirect", url };
    throw new NotFoundException("Muqova yo'q");
  }

  // ── Kitob tahrirlash ──────────────────────────────────────────────────────
  async update(id: string, dto: UpdateBookDto) {
    const book = await this.findOne(id);
    const updated = await this.prisma.book.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.author !== undefined ? { author: dto.author } : {}),
        ...(dto.genre !== undefined ? { genre: dto.genre } : {}),
        ...(dto.lang !== undefined ? { lang: dto.lang } : {}),
        ...(dto.pages !== undefined ? { pages: dto.pages } : {}),
        ...(dto.year !== undefined ? { year: dto.year } : {}),
        ...(dto.coverUrl !== undefined ? { coverUrl: dto.coverUrl } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.totalCount !== undefined ? { totalCount: dto.totalCount } : {}),
        ...(dto.availableCount !== undefined ? { availableCount: dto.availableCount } : {})
      },
      include: { library: true }
    });
    await this.indexBook(updated);
    if (dto.totalCount !== undefined) await this.updateLibraryFundCount(book.libraryId);
    return updated;
  }

  // ── Kitob o'chirish ───────────────────────────────────────────────────────
  async remove(id: string) {
    const book = await this.findOne(id);
    // Kitobxonlardagi (qaytarilmagan) nusxalar bo'lsa — o'chirib bo'lmaydi:
    // faol tranzaksiya kitobsiz qolardi. Avval qaytarilsin.
    const borrowed = book.totalCount - book.availableCount;
    if (borrowed > 0) {
      throw new ConflictException(
        `${borrowed} ta nusxa hozir kitobxonlarda — avval qaytarilishi kerak`
      );
    }
    // Berish/qaytarish tarixi (BookTransaction.bookId, Restrict): avval FK
    // xatosi → 500 "Internal server error" chiqardi. Tarix Reading Index va
    // audit uchun saqlanadi — aniq 409 bilan tushuntiramiz (2026-11-01).
    const history = await this.prisma.bookTransaction.count({ where: { bookId: id } });
    if (history > 0) {
      throw new ConflictException(
        `Bu kitob bo'yicha ${history} ta berish/qaytarish yozuvi bor — tarix saqlanishi uchun o'chirib bo'lmaydi. Nusxalar sonini kamaytiring.`
      );
    }
    await this.prisma.book.delete({ where: { id } });
    await this.removeBookFromIndex(id);
    await this.updateLibraryFundCount(book.libraryId);
    return { message: "Kitob o'chirildi" };
  }

  // ── ISBN validatsiya va avtoto'ldirish ────────────────────────────────────
  // isValidIsbn — QAT'IY tekshiruv: 13 xona + to'g'ri mod-10 check-digit.
  // Faqat informatsion maqsadda saqlanadi (mas. lookup uchun "ideal" ISBN
  // aniqlash). CREATE bunga TAYANMAYDI — ko'p haqiqiy/demo ISBN'lar check-
  // digit'i noto'g'ri bo'lsa-da yaroqli; create() isIsbnFormat() ishlatadi.
  isValidIsbn(isbn: string): boolean {
    const clean = isbn.replace(/[-\s]/g, "");
    if (clean.length !== 13 || !/^\d+$/.test(clean)) return false;
    const sum = clean.split("").reduce((acc, d, i) => acc + parseInt(d) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }

  // isIsbnFormat — YUMSHOQ tekshiruv: 13 xonali raqam (978/979 prefiks ixtiyoriy),
  // chiziqcha/bo'shliqlar ruxsat. Check-digit tekshirilmaydi (demo + real-world
  // tolerantlik). create() shuni ishlatadi — shubhasiz buzilgan kiritish
  // (raqam bo'lmagan, noto'g'ri uzunlik) baribir rad etiladi.
  isIsbnFormat(isbn: string): boolean {
    if (!isbn) return false;
    const clean = isbn.replace(/[-\s]/g, "");
    return /^(?:978|979)\d{10}$/.test(clean);
  }

  // Chiziqcha/bo'shliqni olib tashlaydi; ISBN-10 bo'lsa ISBN-13 ga aylantiradi
  // (978 + 9 raqam + yangi nazorat raqami). Boshqa ko'rinishlar o'zgarishsiz.
  normalizeIsbn(raw: string): string {
    const clean = (raw ?? "").replace(/[-\s]/g, "").toUpperCase();
    if (/^\d{9}[\dX]$/.test(clean)) {
      const body = "978" + clean.slice(0, 9);
      return body + this.ean13CheckDigit(body);
    }
    return clean;
  }

  private ean13CheckDigit(first12: string): string {
    const sum = first12.split("").reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
    return String((10 - (sum % 10)) % 10);
  }

  // ISBN'siz kitob uchun ichki EAN-13 kod: "2" bilan boshlanadi — bu oraliq
  // do'kon/tashkilot ichki kodlari uchun ajratilgan, haqiqiy ISBN (978/979)
  // bilan hech qachon to'qnashmaydi; shtrix-kod sifatida chop etish mumkin.
  private async generateInternalCode(libraryId: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const body = INTERNAL_CODE_PREFIX + String(randomInt(0, 1e11)).padStart(11, "0");
      const code = body + this.ean13CheckDigit(body);
      const taken = await this.prisma.book.findFirst({ where: { libraryId, isbn: code }, select: { id: true } });
      if (!taken) return code;
    }
    throw new ConflictException("Ichki kod yaratib bo'lmadi — qayta urinib ko'ring");
  }

  // lookupIsbn — HECH QACHON xato chiqarmaydi. Format noto'g'ri yoki Open
  // Library'da yozuv bo'lmasa null qaytaradi (controller 200 + null beradi),
  // shunda frontend "topilmadi — qo'lda to'ldiring" yumshoq maslahatini
  // ko'rsatadi, qizil xato toast emas.
  async lookupIsbn(isbn: string): Promise<IsbnLookupResult | null> {
    const cleanIsbn = this.normalizeIsbn(isbn);
    if (cleanIsbn.length < 10) return null;

    // 1) LOKAL BAZA BIRINCHI — bu ISBN avval qo'shilgan bo'lsa, o'sha kitobning
    //    to'liq ma'lumotini (nom, muallif, janr, til, sahifa, yil, muqova,
    //    tavsif) qaytaramiz. O'zbek kitoblari tashqi API'da ko'pincha yo'q,
    //    shuning uchun lokal baza asosiy manba. Eng so'nggi yozuv olinadi.
    const local = await this.prisma.book.findFirst({
      where: { isbn: cleanIsbn },
      orderBy: { createdAt: "desc" }
    });
    if (local) {
      return {
        isbn: cleanIsbn,
        title: local.title,
        author: local.author,
        genre: local.genre,
        lang: local.lang,
        pages: local.pages,
        year: local.year,
        coverUrl: local.coverUrl ?? undefined,
        description: local.description ?? undefined,
        source: "local"
      };
    }

    // 2) TASHQI Open Library — faqat to'g'ri formatli (978/979) ISBN uchun.
    if (!this.isIsbnFormat(cleanIsbn)) return null;

    try {
      const res = await fetch(
        `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) return this.lookupGoogleBooks(cleanIsbn);
      const data = (await res.json()) as Record<string, unknown>;
      const book = data[`ISBN:${cleanIsbn}`] as {
        title?: string;
        authors?: { name: string }[];
        number_of_pages?: number;
        publish_date?: string;
        subjects?: { name: string }[];
        cover?: { medium?: string };
      } | undefined;

      if (!book) return this.lookupGoogleBooks(cleanIsbn);

      return {
        isbn: cleanIsbn,
        title: book.title,
        author: book.authors?.[0]?.name,
        pages: book.number_of_pages,
        year: book.publish_date ? parseInt(book.publish_date.slice(-4)) || 0 : 0,
        genre: book.subjects?.[0]?.name ?? "Umumiy",
        coverUrl: book.cover?.medium,
        source: "external"
      };
    } catch {
      return this.lookupGoogleBooks(cleanIsbn);
    }
  }

  // Zaxira manba: Google Books (kalitsiz ochiq API). Open Library'da yo'q
  // kitoblar (jumladan ba'zi o'zbek/rus nashrlari) ko'pincha shu yerda bor.
  private async lookupGoogleBooks(cleanIsbn: string): Promise<IsbnLookupResult | null> {
    try {
      const res = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}&maxResults=1`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        items?: {
          volumeInfo?: {
            title?: string;
            subtitle?: string;
            authors?: string[];
            pageCount?: number;
            publishedDate?: string;
            categories?: string[];
            language?: string;
            description?: string;
            imageLinks?: { thumbnail?: string; smallThumbnail?: string };
          };
        }[];
      };
      const v = data.items?.[0]?.volumeInfo;
      if (!v?.title) return null;
      const lang = v.language && ["uz", "ru", "en", "kaa"].includes(v.language) ? v.language : undefined;
      const cover = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail;
      return {
        isbn: cleanIsbn,
        title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
        author: v.authors?.join(", "),
        pages: v.pageCount,
        year: v.publishedDate ? parseInt(v.publishedDate.slice(0, 4)) || 0 : 0,
        genre: v.categories?.[0],
        lang,
        coverUrl: cover?.replace(/^http:/, "https:"),
        description: v.description?.slice(0, 1000),
        source: "external"
      };
    } catch {
      return null;
    }
  }

  // ── Excel import (BOOK-01, Plan 02-04) ────────────────────────────────────
  // Synchronous parsing replaced by a BullMQ job (BOOK_IMPORT_QUEUE). The
  // HTTP request returns 202 + { jobId } immediately; the UI polls
  // GET /books/import/:jobId/status for progress + final errors.
  //
  // V1 file payload: base64 inline in the job payload (FileInterceptor enforces
  // a 10MB cap upstream, so the worst-case Redis memory pressure per job is
  // ~13MB after base64 expansion — acceptable for nightly admin uploads).
  // V2 MinIO offload deferred: when admin upload volume grows past a few/day,
  // swap fileBase64 for an objectKey and have the processor stream from MinIO.
  async enqueueImport(
    buffer: Buffer,
    libraryId: string,
    uploaderUserId: string
  ): Promise<{ jobId: string; status: "queued" | "completed" }> {
    try {
      const job = await this.withTimeout(this.importQueue.add(
      "book-import",
      {
        libraryId,
        uploaderUserId,
        fileBase64: buffer.toString("base64")
      },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 10000 },
        removeOnComplete: { count: 50 },
        removeOnFail: false
      }
    ), BooksService.QUEUE_TIMEOUT_MS);
      return { jobId: String(job.id), status: "queued" };
    } catch (err) {
      this.logger.warn(`BOOK_IMPORT navbati ishlamadi (${(err as Error).message}) — sinxron import`);
    }

    const jobId = `sync-${Date.now()}-${randomInt(1e9)}`;
    let data: Record<string, unknown> = { libraryId, uploaderUserId, fileBase64: buffer.toString("base64") };
    const fakeJob = {
      id: jobId,
      get data() { return data; },
      opts: { attempts: 1 },
      attemptsMade: 0,
      updateData: async (d: Record<string, unknown>) => { data = d; },
      updateProgress: async () => undefined
    };
    const r = await this.importProcessor.process(fakeJob as unknown as Parameters<BookImportProcessor["process"]>[0]);
    const now = Date.now();
    for (const [k, v] of this.syncImports) if (now - v.at > 30 * 60_000) this.syncImports.delete(k);
    this.syncImports.set(jobId, {
      status: "completed", processed: r.processed, total: r.total, skipped: r.skipped,
      errors: r.errors, progress: 100, at: now
    });
    return { jobId, status: "completed" };
  }

  // GET /books/import/:jobId/status — UI polls this every ~2s during import.
  // Returns the normalized BullMQ state, the running processed/total counters
  // (written by the processor via job.updateData), and any per-row errors.
  async getImportStatus(jobId: string): Promise<BookImportStatus> {
    const sync = this.syncImports.get(jobId);
    if (sync) {
      const { at: _at, ...rest } = sync;
      return rest;
    }
    const job = await this.withTimeout(this.importQueue.getJob(jobId), BooksService.QUEUE_TIMEOUT_MS)
      .catch(() => undefined);
    if (!job) {
      return { status: "unknown", processed: 0, total: 0, skipped: 0, errors: [], progress: 0 };
    }

    const state = (await job.getState()) as BookImportStatus["status"];
    const data = (job.data ?? {}) as Partial<BookImportJobData & {
      processed?: number;
      total?: number;
      skipped?: number;
      errors?: { row: number; reason: string }[];
    }>;
    const progressRaw = job.progress;
    const progress =
      typeof progressRaw === "number"
        ? progressRaw
        : typeof progressRaw === "object" && progressRaw !== null && "percent" in progressRaw
          ? Number((progressRaw as { percent: number }).percent)
          : 0;

    return {
      status: state,
      processed: data.processed ?? 0,
      total: data.total ?? 0,
      skipped: data.skipped ?? 0,
      errors: data.errors ?? [],
      progress: Math.round(progress)
    };
  }

  // ── Elasticsearch full-text qidiruv ───────────────────────────────────────
  async search(dto: SearchBooksDto) {
    const { q } = dto;
    const page = clampPage(dto.page);
    // AUDIT-REPORT M16 — limit ES yo'lida ham clamp qilinadi (max 100).
    const limit = clampLimit(dto.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
    const from = (page - 1) * limit;

    // 1) ES: faqat ID'lar + relevantlik tartibi + jami son. O'chirilgan yoki
    //    cooldown'da bo'lsa umuman murojaat qilinmaydi (o'lik portga ~8 s
    //    osilish yo'q). ES'ning O'ZI yiqilsa — cooldown boshlanadi.
    let es: { total: number; ids: string[] } | null = null;
    if (this.esEnabled && Date.now() >= this.esCooldownUntil) {
      try {
        const { query, sort } = buildBookSearchQuery(dto);
        const esResult = await this.es.search({
          index: BOOKS_SEARCH_INDEX,
          from,
          size: limit,
          query,
          sort,
          track_total_hits: true,
          _source: false
        });
        const total = esResult.hits.total;
        es = {
          total: typeof total === "object" ? total.value : (total ?? 0),
          ids: esResult.hits.hits.map((h) => h._id).filter((id): id is string => typeof id === "string")
        };
      } catch (err) {
        this.esCooldownUntil = Date.now() + BooksService.ES_COOLDOWN_MS;
        this.booksIndexReady = false;
        this.logger.warn(`ES qidiruv xatosi — ${BooksService.ES_COOLDOWN_MS / 1000} s Prisma: ${(err as Error).message}`);
      }
    }

    // 2) Natija maydonlari (muqova, nusxalar, kutubxona) — HAR DOIM Postgres'dan:
    //    ES hujjatida ular yo'q va mavjudlik soni eskirgan bo'lishi mumkin.
    //    ES 0 natija bersa — bazada qayta tekshiriladi: indeks bo'sh yoki
    //    eskirgan bo'lsa ham kitob "topilmadi" deb ko'rsatilmaydi.
    let libraryResult: { total: number; page: number; limit: number; data: object[] };
    if (es && es.total > 0) {
      libraryResult = { total: es.total, page, limit, data: await this.hydrateBooks(es.ids) };
    } else {
      libraryResult = await this.searchFallback(dto);
      if (es && libraryResult.total > 0) {
        this.logger.warn(
          `ES 0 natija, bazada ${libraryResult.total} ta — "${BOOKS_SEARCH_INDEX}" indeksi to'liq emas (npm run es:reindex)`
        );
      }
    }

    // Phase 8 Plan 08-02: include store results alongside library results (SHOP-04)
    let storeResults: object[] = [];
    if (q) {
      try {
        const storeSearch = await this.storeService.searchStoreProducts({
          q,
          lat: dto.lat !== undefined ? Number(dto.lat) : undefined,
          lon: dto.lon !== undefined ? Number(dto.lon) : undefined,
          inStock: true,
          page: 1,
          limit: 5,
        });
        storeResults = (storeSearch.data ?? []).map((item: Record<string, unknown>) => ({
          storeName: item.storeName,
          price: item.price,
          stockCount: item.stockCount,
          distance: item.distance,
          premiumBadge: item.premiumBadge,
          slug: item.slug,
          title: item.title,
          author: item.author,
          isbn: item.isbn,
          storeId: item.storeId,
        }));
      } catch {
        // Store search failure must not break library search
        storeResults = [];
      }
    }

    return {
      ...libraryResult,
      storeResults,
    };
  }

  // ── Prisma fallback qidiruv (ES down bo'lganda) ───────────────────────────
  async searchFallback(dto: SearchBooksDto) {
    const { q, genre, lang, libraryId, available } = dto;
    const page = clampPage(dto.page);
    // AUDIT-REPORT M16 — limit fallback yo'lida ham clamp qilinadi (max 100).
    const limit = clampLimit(dto.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
    const skip = (page - 1) * limit;

    const where = {
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { author: { contains: q, mode: "insensitive" as const } },
              { isbn: { contains: q } }
            ]
          }
        : {}),
      ...(genre ? { genre: { contains: genre, mode: "insensitive" as const } } : {}),
      // Til kodlari bazada aralash ("uz", "uz-Latn", "uz-Cyrl") — prefiks
      // bo'yicha (ES so'rovi va fond ro'yxati bilan bir xil ma'no).
      ...(lang ? { lang: { startsWith: lang, mode: "insensitive" as const } } : {}),
      ...(libraryId ? { libraryId } : {}),
      // Query-string'dagi "false" satri truthy — faqat haqiqiy "true" filtrlaydi.
      ...(isTruthyFlag(available) ? { availableCount: { gt: 0 } } : {})
    };

    // AUDIT-REPORT M16 — total endi sahifadagi elementlar soni emas, balki
    // butun filtr bo'yicha haqiqiy soni (books.length faqat take gacha edi —
    // pagination UI 2-sahifadan boshlab "jami" ni noto'g'ri ko'rsatardi).
    const [books, total] = await Promise.all([
      this.prisma.book.findMany({
        where,
        skip,
        take: limit,
        include: { library: true },
        orderBy: { title: "asc" }
      }),
      this.prisma.book.count({ where })
    ]);

    return { total, page, limit, data: books };
  }

  // ── QR scan: foydalanuvchi tekshirish ─────────────────────────────────────
  async scanUserQr(sifatId: string) {
    const user = await this.prisma.user.findUnique({
      where: { sifatId },
      select: {
        id: true,
        name: true,
        sifatId: true,
        type: true,
        status: true,
        trustScore: true,
        transactions: {
          where: { status: { in: ["BORROWED", "RESERVED"] } },
          include: { book: { select: { id: true, title: true, author: true, isbn: true } } },
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    return user;
  }

  // ── Elasticsearch indekslash ──────────────────────────────────────────────
  // Indeks, hujjat shakli va so'rov — `./books-search-index.ts` (yagona manba).

  /** `sifat_books` mapping bilan mavjud bo'lishini (bir marta) ta'minlaydi. */
  private async ensureIndexOnce(): Promise<void> {
    if (this.booksIndexReady) return;
    await ensureBooksIndex(this.es);
    this.booksIndexReady = true;
  }

  async indexBook(book: BookForIndex) {
    if (!this.esEnabled) return;
    try {
      await this.ensureIndexOnce();
      await this.es.index({ index: BOOKS_SEARCH_INDEX, id: book.id, document: toBookDocument(book) });
    } catch (err) {
      // Indekslash xatosi kitobni saqlashni to'xtatmaydi: qidiruv Prisma
      // fallback'da topadi, 5 daqiqalik sinxronizatsiya keyin tiklaydi.
      this.booksIndexReady = false;
      this.logger.debug(`ES indekslash o'tkazib yuborildi (${book.id}): ${(err as Error).message}`);
    }
  }

  private async removeBookFromIndex(id: string) {
    if (!this.esEnabled) return;
    try {
      await this.es.delete({ index: BOOKS_SEARCH_INDEX, id });
    } catch {
      // Hujjat yo'q bo'lishi mumkin — e'tiborsiz; qidiruv natijasi baribir
      // bazadan to'ldiriladi (o'chirilgan kitob ko'rinmaydi).
    }
  }

  /** ES ID'lari tartibida Postgres'dan to'liq kitoblar (kutubxona bilan). */
  private async hydrateBooks(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.book.findMany({
      where: { id: { in: ids } },
      include: { library: true }
    });
    const byId = new Map(rows.map((b) => [b.id, b]));
    const ordered = ids.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => b !== undefined);
    if (ordered.length < ids.length) {
      this.logger.warn(
        `ES ${ids.length - ordered.length} ta bazada yo'q hujjat qaytardi — npm run es:reindex -- --recreate tavsiya etiladi`
      );
    }
    return ordered;
  }

  /**
   * Indeksni Postgres'dagi barcha kitoblar bilan qayta to'ldiradi (idempotent).
   * `recreate` — indeksni o'chirib, mapping bilan qayta yaratadi (eskirgan
   * hujjatlar ham tozalanadi). SUPER_ADMIN endpoint va `npm run es:reindex`.
   */
  async reindexAll(opts: { recreate?: boolean } = {}): Promise<ReindexResult> {
    if (!this.esEnabled) {
      throw new ServiceUnavailableException(
        "Elasticsearch o'chirilgan (ELASTICSEARCH_ENABLED=false) — qidiruv Prisma orqali ishlaydi"
      );
    }
    const startedAt = new Date();
    const result = await reindexAllBooks({ prisma: this.prisma, es: this.es }, { recreate: opts.recreate });
    this.booksIndexReady = true;
    this.esBackfillChecked = true;
    this.esCooldownUntil = 0;
    this.lastEsSyncAt = startedAt;
    this.logger.log(
      `ES "${result.index}" qayta to'ldirildi: ${result.indexed}/${result.total} (xato ${result.failed}, ${result.tookMs} ms)`
    );
    return result;
  }

  /**
   * Indeks bo'sh, bazada kitob bor bo'lsa — to'liq to'ldiradi. ES birinchi
   * marta yoqilganda qidiruv o'zi ishlab ketsin (qo'lda reindex unutilsa ham).
   * Qaytaradi: to'ldirildimi.
   */
  async backfillIfEmpty(): Promise<boolean> {
    if (!this.esEnabled) return false;
    await this.ensureIndexOnce();
    const { count } = await this.es.count({ index: BOOKS_SEARCH_INDEX });
    if (count > 0) {
      this.esBackfillChecked = true;
      return false;
    }
    const dbCount = await this.prisma.book.count();
    if (dbCount === 0) {
      this.esBackfillChecked = true;
      return false;
    }
    this.logger.log(`ES "${BOOKS_SEARCH_INDEX}" bo'sh — ${dbCount} ta kitob indekslanmoqda`);
    await this.reindexAll();
    return true;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.esEnabled) return;
    // Fon rejimi: ES sekin/o'chiq bo'lsa ham ilova ishga tushishi kutmaydi.
    void this.backfillIfEmpty().catch((err) =>
      this.logger.warn(`ES dastlabki to'ldirish o'tkazib yuborildi (cron qayta urinadi): ${(err as Error).message}`)
    );
  }

  /**
   * Har 5 daqiqada: oxirgi sinxronizatsiyadan beri o'zgargan kitoblarni
   * (`updatedAt`) qayta indekslaydi. Mavjudlik soni berish/qaytarish/roaming'da
   * (transactions, libraries modullari) o'zgaradi — ularning har biriga ES
   * chaqiruvini qo'shish o'rniga bitta joy. Ko'rsatiladigan son baribir bazadan;
   * bu faqat "Faqat mavjud" filtrini ≤5 daqiqa aniqlikda ushlab turadi.
   */
  @Cron("*/5 * * * *", { name: "books-es-sync", timeZone: "Asia/Tashkent" })
  async syncChangedBooks(): Promise<{ indexed: number; failed: number } | null> {
    if (!this.esEnabled || Date.now() < this.esCooldownUntil) return null;
    const tickStart = new Date();
    try {
      if (!this.esBackfillChecked && (await this.backfillIfEmpty())) return null;
      await this.ensureIndexOnce();
      // 1 daqiqalik ustma-ustlik — uzoq tranzaksiyalar va soat farqi uchun.
      const since = new Date(this.lastEsSyncAt.getTime() - 60_000);
      const result = await indexBooksWhere({ prisma: this.prisma, es: this.es }, { updatedAt: { gte: since } });
      this.lastEsSyncAt = tickStart;
      return result;
    } catch (err) {
      this.booksIndexReady = false;
      this.logger.warn(`ES sinxronizatsiya o'tkazib yuborildi: ${(err as Error).message}`);
      return null;
    }
  }

  private async updateLibraryFundCount(libraryId: string) {
    const agg = await this.prisma.book.aggregate({
      where: { libraryId },
      _sum: { totalCount: true }
    });
    await this.prisma.library.update({
      where: { id: libraryId },
      data: { fundCount: agg._sum.totalCount ?? 0 }
    });
  }
}
