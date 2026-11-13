import type { Client, estypes } from "@elastic/elasticsearch";
import type { Prisma, PrismaClient } from "@prisma/client";
import { BOOKS_INDEX_MAPPING, BOOKS_INDEX_NAME } from "../../infra/elasticsearch/indices";

/**
 * Kitob qidiruv indeksi — YAGONA manba (2026-11-13).
 *
 * NEGA: avval `BooksService` kitoblarni `books` indeksiga (dinamik mapping,
 * standart analizator) yozib, undan qidirardi; o'zbek/ICU analizatorli
 * `sifat_books` indeksini esa infra `SearchService` yaratardi va hech kim
 * ishlatmasdi. Oqibatlar: (1) kirill↔lotin va o'zbek stop-so'zlari ishlamasdi;
 * (2) janr `term` filtri tahlil qilingan matnga tushib 0 natija berardi;
 * (3) seed/eski kitoblar umuman indekslanmagan — ES yoqilsa qidiruv bo'sh;
 * (4) Excel import `_id`siz yozardi — hujjatlarni yangilab/o'chirib bo'lmasdi.
 *
 * Endi: indeks nomi va mapping — `infra/elasticsearch/indices.ts`; hujjat
 * shakli, so'rov, indeks yaratish va qayta to'ldirish — shu fayl. BooksService,
 * BookImportProcessor va `src/scripts/es-reindex.ts` faqat shu funksiyalarni
 * chaqiradi. ES faqat ID + tartib + jami sonni beradi; ko'rsatiladigan
 * maydonlar (muqova, nusxalar, kutubxona) har doim Postgres'dan olinadi.
 */
export const BOOKS_SEARCH_INDEX = BOOKS_INDEX_NAME;

/** Katta bulk so'rovlar uchun (modul default'i 2 s — fail-fast qidiruv uchun). */
const BULK_TIMEOUT_MS = 60_000;

export interface BookSearchFilters {
  q?: string;
  genre?: string;
  lang?: string;
  libraryId?: string;
  /** Query-string'dan "true"/"false" satri ham kelishi mumkin. */
  available?: boolean | string;
}

/** Indeks hujjati uchun kerakli kitob maydonlari (`library` ixtiyoriy). */
export interface BookForIndex {
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
  createdAt?: Date | string | null;
  library?: {
    name?: string | null;
    type?: string | null;
    regionId?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
}

export interface BookIndexDocument {
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
  libraryName?: string;
  libraryType?: string;
  regionId?: string;
  location?: { lat: number; lon: number };
  createdAt: string;
}

export interface ReindexResult {
  index: string;
  /** Indeks holati qayta to'ldirishdan oldin. */
  indexState: "exists" | "created" | "recreated";
  total: number;
  indexed: number;
  failed: number;
  tookMs: number;
}

// To'liq Client: `Pick<Client, "bulk">` metodning `this: That` kontekstini
// yo'qotadi (TS2769). Nest'ning ElasticsearchService — shu Client'ning o'zi.
type EsClient = Client;
type PrismaBooks = Pick<PrismaClient, "book">;

/** "true" | "1" | true → true. Query-string'dagi "false" truthy bo'lib qolmasin. */
export function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

/** Wildcard so'rovidagi maxsus belgilar (`*`, `?`, `\`) — foydalanuvchi matni literal bo'lsin. */
export function escapeWildcard(s: string): string {
  return s.replace(/[\\*?]/g, (c) => `\\${c}`);
}

export function toBookDocument(book: BookForIndex): BookIndexDocument {
  const lib = book.library ?? undefined;
  const lat = lib?.latitude;
  const lon = lib?.longitude;
  const createdAt =
    book.createdAt instanceof Date
      ? book.createdAt.toISOString()
      : typeof book.createdAt === "string" && book.createdAt
        ? book.createdAt
        : new Date().toISOString();
  return {
    id: book.id,
    isbn: book.isbn,
    title: book.title,
    author: book.author,
    genre: book.genre,
    lang: book.lang,
    pages: book.pages,
    year: book.year,
    availableCount: book.availableCount,
    libraryId: book.libraryId,
    ...(lib?.name ? { libraryName: lib.name } : {}),
    ...(lib?.type ? { libraryType: lib.type } : {}),
    ...(lib?.regionId ? { regionId: lib.regionId } : {}),
    ...(typeof lat === "number" && typeof lon === "number" ? { location: { lat, lon } } : {}),
    createdAt
  };
}

/**
 * Qidiruv so'rovi — Prisma fallback (`BooksService.searchFallback`) bilan BIR XIL
 * ma'noda:
 *   - q: nomi/muallif (lotin + kirill subfield'lari, fuzzy — imlo xatosiga
 *     chidamli) yoki ISBN qismi;
 *   - janr: "ichida bor", katta-kichik harfsiz ("Tarix" → "Tarixiy roman");
 *   - til: prefiks ("uz" → "uz", "uz-Latn", "uz-Cyrl");
 *   - kutubxona: aniq; mavjudlik: availableCount > 0.
 * q bo'lmasa — nomi bo'yicha alifbo tartibi (fallback'dagi `orderBy: title`).
 */
export function buildBookSearchQuery(f: BookSearchFilters): {
  query: estypes.QueryDslQueryContainer;
  sort: estypes.SortCombinations[];
} {
  const q = f.q?.trim();
  const genre = f.genre?.trim();
  const lang = f.lang?.trim();

  const filter: estypes.QueryDslQueryContainer[] = [];
  if (genre) {
    filter.push({ wildcard: { genre: { value: `*${escapeWildcard(genre)}*`, case_insensitive: true } } });
  }
  if (lang) filter.push({ prefix: { lang: { value: lang, case_insensitive: true } } });
  if (f.libraryId) filter.push({ term: { libraryId: f.libraryId } });
  if (isTruthyFlag(f.available)) filter.push({ range: { availableCount: { gt: 0 } } });

  if (!q) {
    return { query: { bool: { filter } }, sort: [{ "title.keyword": { order: "asc" } }] };
  }

  const should: estypes.QueryDslQueryContainer[] = [
    {
      multi_match: {
        query: q,
        fields: ["title^3", "title.cyrillic^3", "author^2", "author.cyrillic^2"],
        fuzziness: "AUTO"
      }
    }
  ];
  const isbnPart = q.replace(/[-\s]/g, "").toUpperCase();
  if (/^\d[\dX]{2,12}$/.test(isbnPart)) {
    should.push({ wildcard: { isbn: { value: `*${isbnPart}*` } } });
  }
  return {
    query: { bool: { should, minimum_should_match: 1, filter } },
    sort: [{ _score: { order: "desc" } }, { "title.keyword": { order: "asc" } }]
  };
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { meta?: { body?: { error?: { type?: string } } }; message?: string };
  return (
    e?.meta?.body?.error?.type === "resource_already_exists_exception" ||
    /resource_already_exists_exception/.test(e?.message ?? "")
  );
}

/**
 * Indeksni `BOOKS_INDEX_MAPPING` bilan yaratadi (bo'lmasa). `recreate` — o'chirib,
 * qaytadan yaratadi (mapping o'zgarganda yoki eskirgan hujjatlarni tozalashda).
 * Muhim: hujjat yozishdan OLDIN chaqirilsin — aks holda ES indeksni dinamik
 * mapping bilan o'zi yaratib qo'yadi va analizatorlar yo'qoladi.
 */
export async function ensureBooksIndex(
  es: EsClient,
  opts: { recreate?: boolean } = {}
): Promise<"exists" | "created" | "recreated"> {
  const exists = await es.indices.exists({ index: BOOKS_SEARCH_INDEX });
  if (exists && !opts.recreate) return "exists";
  if (exists) await es.indices.delete({ index: BOOKS_SEARCH_INDEX });
  try {
    await es.indices.create({ index: BOOKS_SEARCH_INDEX, ...BOOKS_INDEX_MAPPING });
  } catch (err) {
    // Parallel replika/SearchService allaqachon yaratgan bo'lsa — muvaffaqiyat.
    if (isAlreadyExists(err)) return "exists";
    throw err;
  }
  return exists ? "recreated" : "created";
}

/** Kitoblarni `_id` = Postgres ID bilan upsert qiladi; xato bergan qatorlar soni qaytadi. */
export async function bulkIndexBooks(
  es: EsClient,
  books: BookForIndex[],
  opts: { refresh?: boolean } = {}
): Promise<{ indexed: number; failed: number }> {
  if (books.length === 0) return { indexed: 0, failed: 0 };
  const operations = books.flatMap((b) => [
    { index: { _index: BOOKS_SEARCH_INDEX, _id: b.id } },
    toBookDocument(b)
  ]);
  const res = await es.bulk(
    { operations, refresh: opts.refresh ? "wait_for" : false },
    { requestTimeout: BULK_TIMEOUT_MS }
  );
  const failed = res?.errors ? (res.items ?? []).filter((it) => it.index?.error).length : 0;
  return { indexed: books.length - failed, failed };
}

const LIBRARY_FIELDS = { name: true, type: true, regionId: true, latitude: true, longitude: true } as const;

/**
 * `where` ga mos kitoblarni ID bo'yicha kursor bilan (batch) indekslaydi.
 * To'liq qayta to'ldirish ham, "o'zgarganlar" sinxronizatsiyasi ham shu yerdan.
 */
export async function indexBooksWhere(
  deps: { prisma: PrismaBooks; es: EsClient },
  where: Prisma.BookWhereInput = {},
  opts: { batchSize?: number; onBatch?: (done: number) => void } = {}
): Promise<{ indexed: number; failed: number }> {
  const batchSize = Math.min(Math.max(Math.floor(opts.batchSize ?? 500), 1), 5000);
  let indexed = 0;
  let failed = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await deps.prisma.book.findMany({
      where,
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      include: { library: { select: LIBRARY_FIELDS } }
    });
    if (batch.length === 0) break;
    const r = await bulkIndexBooks(deps.es, batch);
    indexed += r.indexed;
    failed += r.failed;
    opts.onBatch?.(indexed + failed);
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1].id;
  }
  return { indexed, failed };
}

/** Indeksni Postgres'dagi BARCHA kitoblar bilan qayta to'ldiradi (idempotent). */
export async function reindexAllBooks(
  deps: { prisma: PrismaBooks; es: EsClient },
  opts: { batchSize?: number; recreate?: boolean; onBatch?: (done: number, total: number) => void } = {}
): Promise<ReindexResult> {
  const started = Date.now();
  const indexState = await ensureBooksIndex(deps.es, { recreate: opts.recreate });
  const total = await deps.prisma.book.count();
  const { indexed, failed } = await indexBooksWhere(deps, {}, {
    batchSize: opts.batchSize,
    onBatch: (done) => opts.onBatch?.(done, total)
  });
  await deps.es.indices.refresh({ index: BOOKS_SEARCH_INDEX });
  return { index: BOOKS_SEARCH_INDEX, indexState, total, indexed, failed, tookMs: Date.now() - started };
}
