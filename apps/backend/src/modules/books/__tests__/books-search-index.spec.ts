import type { Client } from "@elastic/elasticsearch";
import type { PrismaClient } from "@prisma/client";
import {
  BOOKS_SEARCH_INDEX,
  buildBookSearchQuery,
  bulkIndexBooks,
  ensureBooksIndex,
  escapeWildcard,
  indexBooksWhere,
  isTruthyFlag,
  reindexAllBooks,
  toBookDocument,
  type BookForIndex
} from "../books-search-index";
import { BOOKS_INDEX_MAPPING, BOOKS_INDEX_NAME } from "../../../infra/elasticsearch/indices";

/**
 * Kitob qidiruv indeksi (2026-11-13): yagona indeks `sifat_books`, Prisma
 * fallback bilan bir xil filtr ma'nosi, `_id` = Postgres ID, qayta to'ldirish.
 */
function book(id: string, extra: Partial<BookForIndex> = {}): BookForIndex {
  return {
    id,
    isbn: "9789943452787",
    title: "Alpomish",
    author: "Xalq dostoni",
    genre: "Doston",
    lang: "uz-Latn",
    pages: 240,
    year: 2020,
    availableCount: 3,
    libraryId: "lib1",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    ...extra
  };
}

function makeEs() {
  return {
    indices: {
      exists: jest.fn().mockResolvedValue(true),
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      refresh: jest.fn().mockResolvedValue({})
    },
    bulk: jest.fn().mockResolvedValue({ errors: false, items: [] })
  };
}
const asClient = (es: ReturnType<typeof makeEs>) => es as unknown as Client;

describe("books-search-index", () => {
  it("indeks — infra mapping'dagi `sifat_books` (eski dinamik `books` emas)", () => {
    expect(BOOKS_SEARCH_INDEX).toBe(BOOKS_INDEX_NAME);
    expect(BOOKS_SEARCH_INDEX).toBe("sifat_books");
  });

  describe("toBookDocument", () => {
    it("asosiy maydonlar + kutubxona nomi/turi/hudud + geo nuqta + createdAt ISO", () => {
      const doc = toBookDocument(
        book("b1", {
          library: { name: "8-maktab kutubxonasi", type: "SCH", regionId: "UZ-14-001", latitude: 41.31, longitude: 69.28 }
        })
      );
      expect(doc).toEqual({
        id: "b1",
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Doston",
        lang: "uz-Latn",
        pages: 240,
        year: 2020,
        availableCount: 3,
        libraryId: "lib1",
        libraryName: "8-maktab kutubxonasi",
        libraryType: "SCH",
        regionId: "UZ-14-001",
        location: { lat: 41.31, lon: 69.28 },
        createdAt: "2026-01-15T10:00:00.000Z"
      });
    });

    it("kutubxona yo'q yoki koordinatasi to'liq emas — ixtiyoriy maydonlar qo'shilmaydi", () => {
      const doc = toBookDocument(book("b1", { createdAt: null, library: { name: null, latitude: 41.3, longitude: null } }));
      expect(doc).not.toHaveProperty("libraryName");
      expect(doc).not.toHaveProperty("location");
      expect(doc).not.toHaveProperty("regionId");
      expect(Number.isNaN(Date.parse(doc.createdAt))).toBe(false);
    });
  });

  it("escapeWildcard: *, ?, \\ literal bo'ladi", () => {
    expect(escapeWildcard("a*b?c\\d")).toBe("a\\*b\\?c\\\\d");
    expect(escapeWildcard("Roman")).toBe("Roman");
  });

  it("isTruthyFlag: faqat true / \"true\" / \"1\"", () => {
    for (const v of [true, "true", "1"]) expect(isTruthyFlag(v)).toBe(true);
    for (const v of [false, "false", "0", "", undefined, null]) expect(isTruthyFlag(v)).toBe(false);
  });

  describe("buildBookSearchQuery — Prisma fallback bilan bir xil ma'no", () => {
    it("q va filtr yo'q — hammasi, nomi bo'yicha alifbo tartibi", () => {
      expect(buildBookSearchQuery({})).toEqual({
        query: { bool: { filter: [] } },
        sort: [{ "title.keyword": { order: "asc" } }]
      });
    });

    it("janr — \"ichida bor\", katta-kichik harfsiz (term emas: avval 0 natija berardi)", () => {
      const { query } = buildBookSearchQuery({ genre: " Tarix " });
      expect(query).toEqual({
        bool: { filter: [{ wildcard: { genre: { value: "*Tarix*", case_insensitive: true } } }] }
      });
      const escaped = buildBookSearchQuery({ genre: "a*" }).query as { bool: { filter: unknown[] } };
      expect(escaped.bool.filter[0]).toEqual({ wildcard: { genre: { value: "*a\\**", case_insensitive: true } } });
    });

    it("til — prefiks (\"uz\" → uz, uz-Latn, uz-Cyrl); kutubxona — aniq; mavjudlik — faqat \"true\" da", () => {
      const { query } = buildBookSearchQuery({ lang: "uz", libraryId: "lib1", available: "true" });
      expect((query as { bool: { filter: unknown[] } }).bool.filter).toEqual([
        { prefix: { lang: { value: "uz", case_insensitive: true } } },
        { term: { libraryId: "lib1" } },
        { range: { availableCount: { gt: 0 } } }
      ]);
      const notAvailable = buildBookSearchQuery({ available: "false" }).query as { bool: { filter: unknown[] } };
      expect(notAvailable.bool.filter).toEqual([]);
    });

    it("matnli q — nomi/muallif (lotin + kirill subfield'lari) fuzzy; ISBN bandi yo'q; relevantlik bo'yicha", () => {
      const { query, sort } = buildBookSearchQuery({ q: "Alpomsh", genre: "Doston" });
      expect(query).toEqual({
        bool: {
          should: [
            {
              multi_match: {
                query: "Alpomsh",
                fields: ["title^3", "title.cyrillic^3", "author^2", "author.cyrillic^2"],
                fuzziness: "AUTO"
              }
            }
          ],
          minimum_should_match: 1,
          filter: [{ wildcard: { genre: { value: "*Doston*", case_insensitive: true } } }]
        }
      });
      expect(sort).toEqual([{ _score: { order: "desc" } }, { "title.keyword": { order: "asc" } }]);
    });

    it("raqamli q (chiziqcha bilan) — qo'shimcha ISBN qism-qidiruvi", () => {
      const { query } = buildBookSearchQuery({ q: "978-9943" });
      const should = (query as { bool: { should: unknown[] } }).bool.should;
      expect(should).toHaveLength(2);
      expect(should[1]).toEqual({ wildcard: { isbn: { value: "*9789943*" } } });
    });
  });

  describe("ensureBooksIndex", () => {
    it("bor bo'lsa — hech narsa yaratilmaydi", async () => {
      const es = makeEs();
      await expect(ensureBooksIndex(asClient(es))).resolves.toBe("exists");
      expect(es.indices.create).not.toHaveBeenCalled();
    });

    it("yo'q bo'lsa — BOOKS_INDEX_MAPPING (o'zbek/ICU analizatorlari) bilan yaratiladi", async () => {
      const es = makeEs();
      es.indices.exists.mockResolvedValue(false);
      await expect(ensureBooksIndex(asClient(es))).resolves.toBe("created");
      expect(es.indices.create).toHaveBeenCalledWith({ index: "sifat_books", ...BOOKS_INDEX_MAPPING });
    });

    it("recreate — o'chirib, qayta yaratadi", async () => {
      const es = makeEs();
      await expect(ensureBooksIndex(asClient(es), { recreate: true })).resolves.toBe("recreated");
      expect(es.indices.delete).toHaveBeenCalledWith({ index: "sifat_books" });
      expect(es.indices.create).toHaveBeenCalledTimes(1);
    });

    it("parallel yaratilgan (resource_already_exists) — muvaffaqiyat; boshqa xato — tashlanadi", async () => {
      const es = makeEs();
      es.indices.exists.mockResolvedValue(false);
      es.indices.create.mockRejectedValueOnce({ meta: { body: { error: { type: "resource_already_exists_exception" } } } });
      await expect(ensureBooksIndex(asClient(es))).resolves.toBe("exists");
      es.indices.create.mockRejectedValueOnce(new Error("cluster_block_exception"));
      await expect(ensureBooksIndex(asClient(es))).rejects.toThrow("cluster_block_exception");
    });
  });

  describe("bulkIndexBooks", () => {
    it("bo'sh ro'yxat — ES chaqirilmaydi", async () => {
      const es = makeEs();
      await expect(bulkIndexBooks(asClient(es), [])).resolves.toEqual({ indexed: 0, failed: 0 });
      expect(es.bulk).not.toHaveBeenCalled();
    });

    it("har kitob `_id` = Postgres ID bilan; 60 s timeout; xatolar sanaladi", async () => {
      const es = makeEs();
      es.bulk.mockResolvedValueOnce({
        errors: true,
        items: [{ index: { status: 201 } }, { index: { status: 400, error: { type: "mapper_parsing_exception" } } }]
      });
      const result = await bulkIndexBooks(asClient(es), [book("b1"), book("b2")]);
      expect(result).toEqual({ indexed: 1, failed: 1 });
      const [params, options] = es.bulk.mock.calls[0];
      expect(params.refresh).toBe(false);
      expect(options).toEqual({ requestTimeout: 60_000 });
      expect(params.operations[0]).toEqual({ index: { _index: "sifat_books", _id: "b1" } });
      expect(params.operations[1]).toMatchObject({ id: "b1", title: "Alpomish" });
      expect(params.operations[2]).toEqual({ index: { _index: "sifat_books", _id: "b2" } });
    });
  });

  describe("indexBooksWhere / reindexAllBooks", () => {
    function makePrisma(pages: BookForIndex[][], total = 3) {
      const findMany = jest.fn();
      for (const p of pages) findMany.mockResolvedValueOnce(p);
      findMany.mockResolvedValue([]);
      return { book: { findMany, count: jest.fn().mockResolvedValue(total) } };
    }
    const asPrisma = (p: ReturnType<typeof makePrisma>) => p as unknown as Pick<PrismaClient, "book">;

    it("ID bo'yicha kursor bilan partiyalab o'qiydi; where va kutubxona select uzatiladi", async () => {
      const es = makeEs();
      const prisma = makePrisma([[book("b1"), book("b2")], [book("b3")]]);
      const done: number[] = [];
      const result = await indexBooksWhere(
        { prisma: asPrisma(prisma), es: asClient(es) },
        { updatedAt: { gte: new Date("2026-11-13T00:00:00Z") } },
        { batchSize: 2, onBatch: (n) => done.push(n) }
      );
      expect(result).toEqual({ indexed: 3, failed: 0 });
      expect(es.bulk).toHaveBeenCalledTimes(2);
      expect(done).toEqual([2, 3]);
      const [first, second] = prisma.book.findMany.mock.calls.map((c) => c[0]);
      expect(first).toMatchObject({ take: 2, orderBy: { id: "asc" }, where: { updatedAt: { gte: expect.any(Date) } } });
      expect(first).not.toHaveProperty("cursor");
      expect(first.include.library.select).toEqual({ name: true, type: true, regionId: true, latitude: true, longitude: true });
      expect(second).toMatchObject({ skip: 1, cursor: { id: "b2" } });
    });

    it("reindexAllBooks: indeksni ta'minlaydi, hammasini yozadi, refresh qiladi va hisobot qaytaradi", async () => {
      const es = makeEs();
      es.indices.exists.mockResolvedValue(false);
      const prisma = makePrisma([[book("b1"), book("b2"), book("b3")]]);
      const result = await reindexAllBooks({ prisma: asPrisma(prisma), es: asClient(es) });
      expect(es.indices.create).toHaveBeenCalledTimes(1);
      expect(es.indices.refresh).toHaveBeenCalledWith({ index: "sifat_books" });
      expect(result).toMatchObject({ index: "sifat_books", indexState: "created", total: 3, indexed: 3, failed: 0 });
      expect(typeof result.tookMs).toBe("number");
    });
  });
});
