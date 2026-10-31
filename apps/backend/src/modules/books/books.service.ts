import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException
} from "@nestjs/common";
import { ElasticsearchService } from "@nestjs/elasticsearch";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { BOOK_IMPORT_QUEUE } from "../../infra/queue/queue-names";
import { StoreService } from "../store/store.service";
import * as ExcelJS from "exceljs";

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

const ES_INDEX = "books";

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
export class BooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly es: ElasticsearchService,
    @InjectQueue(BOOK_IMPORT_QUEUE)
    private readonly importQueue: Queue<BookImportJobData>,
    private readonly storeService: StoreService,
  ) {}

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

  // ── Barcha kitoblar ───────────────────────────────────────────────────────
  // AUDIT-REPORT M16 — majburiy pagination: default 50, maksimum 200. Avval
  // butun books jadvali bitta so'rovda qaytarilardi. Javob shakli (massiv)
  // o'zgarmagan — mavjud chaqiruvchilar buzilmaydi, faqat hajm chegaralanadi.
  async findAll(libraryId?: string, page = 1, limit = FIND_ALL_LIMIT_DEFAULT) {
    const take = clampLimit(limit, FIND_ALL_LIMIT_DEFAULT, FIND_ALL_LIMIT_MAX);
    const pageNum = Number(page);
    const safePage = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;
    return this.prisma.book.findMany({
      where: libraryId ? { libraryId } : {},
      orderBy: { createdAt: "desc" },
      include: { library: true },
      skip: (safePage - 1) * take,
      take
    });
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
    if (!this.isIsbnFormat(dto.isbn))
      throw new BadRequestException(
        "ISBN noto'g'ri — 13 xonali raqam bo'lishi kerak (978/979 bilan)"
      );

    const cleanIsbn = dto.isbn.replace(/[-\s]/g, "");
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
    const existing = await this.prisma.book.findFirst({
      where: { isbn: cleanIsbn, libraryId: dto.libraryId }
    });

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

  // lookupIsbn — HECH QACHON xato chiqarmaydi. Format noto'g'ri yoki Open
  // Library'da yozuv bo'lmasa null qaytaradi (controller 200 + null beradi),
  // shunda frontend "topilmadi — qo'lda to'ldiring" yumshoq maslahatini
  // ko'rsatadi, qizil xato toast emas.
  async lookupIsbn(isbn: string): Promise<IsbnLookupResult | null> {
    const cleanIsbn = (isbn ?? "").replace(/[-\s]/g, "");
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
      const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const book = data[`ISBN:${cleanIsbn}`] as {
        title?: string;
        authors?: { name: string }[];
        number_of_pages?: number;
        publish_date?: string;
        subjects?: { name: string }[];
        cover?: { medium?: string };
      } | undefined;

      if (!book) return null;

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
  ): Promise<{ jobId: string; status: "queued" }> {
    const job = await this.importQueue.add(
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
    );

    return { jobId: String(job.id), status: "queued" };
  }

  // GET /books/import/:jobId/status — UI polls this every ~2s during import.
  // Returns the normalized BullMQ state, the running processed/total counters
  // (written by the processor via job.updateData), and any per-row errors.
  async getImportStatus(jobId: string): Promise<BookImportStatus> {
    const job = await this.importQueue.getJob(jobId);
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
    const { q, genre, lang, libraryId, available, page = 1 } = dto;
    // AUDIT-REPORT M16 — limit ES yo'lida ham clamp qilinadi (max 100).
    const limit = clampLimit(dto.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
    const from = (page - 1) * limit;

    let libraryResult: { total: number | unknown; page: number; limit: number; data: object[] };

    try {
      // ES o'chirilgan bo'lsa darhol fallback'ga o'tamiz (catch ushlaydi) —
      // o'lik ES portiga ulanish ~8s osilishining oldini oladi.
      if (!this.esEnabled) throw new Error("Elasticsearch disabled");
      if (Date.now() < this.esCooldownUntil) throw new Error("Elasticsearch cooldown");
      const must: object[] = [];
      const filter: object[] = [];

      if (q) {
        must.push({
          multi_match: {
            query: q,
            fields: ["title^3", "author^2", "genre", "isbn"],
            fuzziness: "AUTO"
          }
        });
      }
      if (genre) filter.push({ term: { genre } });
      if (lang) filter.push({ term: { lang } });
      if (libraryId) filter.push({ term: { libraryId } });
      if (available) filter.push({ range: { availableCount: { gt: 0 } } });

      const esResult = await this.es.search({
        index: ES_INDEX,
        from,
        size: limit,
        query: {
          bool: {
            must: must.length ? must : [{ match_all: {} }],
            filter
          }
        }
      });

      const hits = esResult.hits.hits as { _id: string; _source: Record<string, unknown> }[];
      libraryResult = {
        total: typeof esResult.hits.total === "object" ? esResult.hits.total.value : esResult.hits.total,
        page,
        limit,
        data: hits.map((h) => ({ id: h._id, ...h._source }))
      };
    } catch {
      // Elasticsearch mavjud bo'lmasa Prisma fallback. ES'ning O'ZI yiqilgan
      // bo'lsa (o'chirilgan yoki cooldown emas) — cooldown boshlanadi.
      if (this.esEnabled && Date.now() >= this.esCooldownUntil) {
        this.esCooldownUntil = Date.now() + BooksService.ES_COOLDOWN_MS;
      }
      libraryResult = await this.searchFallback(dto);
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
    const { q, genre, lang, libraryId, available, page = 1 } = dto;
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
      ...(lang ? { lang } : {}),
      ...(libraryId ? { libraryId } : {}),
      ...(available ? { availableCount: { gt: 0 } } : {})
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
  async indexBook(book: {
    id: string;
    isbn: string;
    title: string;
    author: string;
    genre: string;
    lang: string;
    pages: number;
    year: number;
    availableCount: number;
    libraryId: string;
  }) {
    if (!this.esEnabled) return;
    try {
      await this.es.index({
        index: ES_INDEX,
        id: book.id,
        document: {
          isbn: book.isbn,
          title: book.title,
          author: book.author,
          genre: book.genre,
          lang: book.lang,
          pages: book.pages,
          year: book.year,
          availableCount: book.availableCount,
          libraryId: book.libraryId
        }
      });
    } catch {
      // ES indekslash muvaffaqiyatsiz bo'lsa log qilamiz, lekin xato chiqarmaymiz
    }
  }

  private async removeBookFromIndex(id: string) {
    if (!this.esEnabled) return;
    try {
      await this.es.delete({ index: ES_INDEX, id });
    } catch {
      // ignore
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
