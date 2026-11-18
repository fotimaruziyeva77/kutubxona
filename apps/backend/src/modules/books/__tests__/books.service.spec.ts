import { NotFoundException, BadRequestException, ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { BooksService } from "../books.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

// Mock @nestjs/elasticsearch to avoid @elastic/elasticsearch resolution
jest.mock("@nestjs/elasticsearch", () => ({
  ElasticsearchService: jest.fn(),
  ElasticsearchModule: { register: jest.fn().mockReturnValue({ module: class {}, providers: [], exports: [] }) },
  InjectElasticsearch: () => () => undefined,
}));

// Mock store service import chain to avoid transitive ES resolution
jest.mock("../../store/store.service", () => ({
  StoreService: jest.fn(),
}));

import { ElasticsearchService } from "@nestjs/elasticsearch";

// fetch ni mock qilish
global.fetch = jest.fn();

const mockBook = {
  id: "b1",
  isbn: "9789943452787",
  title: "Alpomish",
  author: "Xalq dostoni",
  genre: "Epik",
  lang: "uz",
  pages: 320,
  year: 2020,
  coverUrl: null,
  totalCount: 5,
  availableCount: 5,
  libraryId: "lib1",
  library: { id: "lib1", name: "Karmana kutubxonasi" },
  createdAt: new Date(),
  updatedAt: new Date()
};

const mockPrisma = {
  book: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    // create() dublikat ISBN tekshiruvi uchun findFirst ishlatadi
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    aggregate: jest.fn(),
    // M16 — searchFallback endi haqiqiy total uchun count() ishlatadi
    count: jest.fn()
  },
  library: {
    update: jest.fn()
  },
  user: {
    findUnique: jest.fn()
  },
  // remove(): berish/qaytarish tarixi tekshiruvi (FK Restrict → 409)
  bookTransaction: {
    count: jest.fn()
  }
};

const mockEs = {
  index: jest.fn().mockResolvedValue({}),
  search: jest.fn(),
  delete: jest.fn().mockResolvedValue({}),
  // `sifat_books` indeksi (books-search-index.ts): yaratish, bulk, son
  count: jest.fn().mockResolvedValue({ count: 0 }),
  bulk: jest.fn().mockResolvedValue({ errors: false, items: [] }),
  indices: {
    exists: jest.fn().mockResolvedValue(true),
    create: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    refresh: jest.fn().mockResolvedValue({})
  }
};

const mockImportQueue = {
  add: jest.fn().mockResolvedValue({ id: "import-job-1" }),
  getJob: jest.fn()
} as unknown as Queue;

const mockStoreService = {
  searchStoreProducts: jest.fn().mockResolvedValue({ total: 0, page: 1, limit: 5, data: [] }),
};

describe("BooksService", () => {
  let service: BooksService;

  // `.env` unit-testlarga ham yuklanadi (throttle.const.ts dotenv chaqiradi):
  // lokal `.env` da ELASTICSEARCH_ENABLED=false bo'lsa ES testlari yiqilardi.
  // Bu spec ES YOQILGAN holatni sinaydi — bayroqni aniq o'rnatamiz.
  const prevEsEnabled = process.env.ELASTICSEARCH_ENABLED;
  beforeAll(() => {
    process.env.ELASTICSEARCH_ENABLED = "true";
  });
  afterAll(() => {
    if (prevEsEnabled === undefined) delete process.env.ELASTICSEARCH_ENABLED;
    else process.env.ELASTICSEARCH_ENABLED = prevEsEnabled;
  });

  beforeEach(() => {
    service = new BooksService(
      mockPrisma as unknown as PrismaService,
      mockEs as unknown as ElasticsearchService,
      mockImportQueue,
      mockStoreService as any,
    );
    jest.clearAllMocks();
    mockPrisma.book.aggregate.mockResolvedValue({ _sum: { totalCount: 10 } });
    mockPrisma.book.count.mockResolvedValue(1);
    // Default: dublikat yo'q (create() yangi yozuv yaratadi)
    mockPrisma.book.findFirst.mockResolvedValue(null);
    mockPrisma.library.update.mockResolvedValue({});
    (mockImportQueue.add as jest.Mock).mockResolvedValue({ id: "import-job-1" });
  });

  // ── findAll ───────────────────────────────────────────────────────────────
  describe("findAll", () => {
    it("barcha kitoblarni library bilan va jami son bilan qaytaradi ({ total, page, limit, data })", async () => {
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      mockPrisma.book.count.mockResolvedValue(1);
      const result = await service.findAll();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe("Alpomish");
      expect(result).toEqual(expect.objectContaining({ total: 1, page: 1, limit: 50 }));
    });

    it("libraryId filtr bilan qaytaradi (findMany va count bir xil where)", async () => {
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      mockPrisma.book.count.mockResolvedValue(1);
      await service.findAll({ libraryId: "lib1" });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib1" } })
      );
      expect(mockPrisma.book.count).toHaveBeenCalledWith({ where: { libraryId: "lib1" } });
    });

    it("fond filtrlari: q — nomi/muallif (insensitive) + ISBN (chiziqchasiz), janr, til, faqat mavjud", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);
      await service.findAll({ q: " 978-9943 ", genre: "epik", lang: "uz", available: true });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { title: { contains: "978-9943", mode: "insensitive" } },
              { author: { contains: "978-9943", mode: "insensitive" } },
              { isbn: { contains: "9789943" } }
            ],
            genre: { contains: "epik", mode: "insensitive" },
            // "uz" → "uz", "uz-Latn", "uz-Cyrl" (DB'da kodlar aralash)
            lang: { startsWith: "uz", mode: "insensitive" },
            availableCount: { gt: 0 }
          }
        })
      );
    });

    it("available: false → mavjudlik filtri qo'shilmaydi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);
      await service.findAll({ libraryId: "lib1", available: false });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib1" } })
      );
    });

    // AUDIT-REPORT M16 — majburiy pagination
    it("M16: default take 50, skip 0 (avval butun jadval qaytarilardi)", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);
      await service.findAll();
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 })
      );
    });

    it("M16: limit 100000 → take 200 ga clamp qilinadi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);
      const result = await service.findAll({ page: 1, limit: 100000 });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 })
      );
      expect(result.limit).toBe(200);
    });

    it("M16: page 3 + limit 10 → skip 20", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);
      await service.findAll({ libraryId: "lib1", page: 3, limit: 10 });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib1" }, skip: 20, take: 10 })
      );
    });

    it("M16: noto'g'ri (NaN/manfiy) qiymatlar xavfsiz defaultlarga tushadi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      await service.findAll({ page: Number("abc"), limit: -5 });
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 50 })
      );
    });
  });

  // ── findOne ───────────────────────────────────────────────────────────────
  describe("findOne", () => {
    it("mavjud kitobni qaytaradi", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      const result = await service.findOne("b1");
      expect(result.isbn).toBe("9789943452787");
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(null);
      await expect(service.findOne("notfound")).rejects.toThrow(NotFoundException);
    });
  });

  // ── isValidIsbn (QAT'IY mod-10) ───────────────────────────────────────────
  describe("isValidIsbn", () => {
    it("to'g'ri ISBN-13 ni tasdiqlaydi", () => {
      expect(service.isValidIsbn("9789943452787")).toBe(true);
      expect(service.isValidIsbn("978-9943-452-78-7")).toBe(true);
    });

    it("noto'g'ri ISBN ni rad etadi", () => {
      expect(service.isValidIsbn("1234567890123")).toBe(false);
      expect(service.isValidIsbn("978994345278")).toBe(false); // 12 raqam
    });

    it("demo ISBN (noto'g'ri check-digit) qat'iy tekshiruvda rad etiladi", () => {
      // 9789943000014 check-digit'i 8 bo'lishi kerak — qat'iy tekshiruv false.
      expect(service.isValidIsbn("9789943000014")).toBe(false);
    });
  });

  // ── isIsbnFormat (YUMSHOQ — create() ishlatadi) ───────────────────────────
  describe("isIsbnFormat", () => {
    it("13 xonali 978/979 ISBN'ni qabul qiladi (check-digit'dan qat'i nazar)", () => {
      expect(service.isIsbnFormat("9789943452787")).toBe(true);
      expect(service.isIsbnFormat("978-9943-000-01-4")).toBe(true); // demo, chiziqchali
      expect(service.isIsbnFormat("9799943000014")).toBe(true); // 979 prefiks
    });

    it("buzilgan kiritishni rad etadi", () => {
      expect(service.isIsbnFormat("123")).toBe(false); // qisqa
      expect(service.isIsbnFormat("9789943abc014")).toBe(false); // raqam emas
      expect(service.isIsbnFormat("1234567890123")).toBe(false); // 978/979 emas
      expect(service.isIsbnFormat("")).toBe(false);
    });
  });

  // ── create ────────────────────────────────────────────────────────────────
  describe("create", () => {
    it("yangi kitob qo'shadi va ES ga indekslaydi", async () => {
      mockPrisma.book.create.mockResolvedValue(mockBook);

      const result = await service.create({
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epik",
        libraryId: "lib1"
      });

      expect(result.title).toBe("Alpomish");
      expect(result.duplicate).toBe(false);
      expect(mockEs.index).toHaveBeenCalled();
      expect(mockPrisma.library.update).toHaveBeenCalled();
    });

    // CREATE format-only validatsiya: demo ISBN (noto'g'ri check-digit) saqlanadi.
    it("demo ISBN (9789943000014, noto'g'ri check-digit) muvaffaqiyatli saqlanadi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue(null);
      mockPrisma.book.create.mockResolvedValue({ ...mockBook, isbn: "9789943000014" });

      const result = await service.create({
        isbn: "9789943000014",
        title: "Demo kitob",
        author: "Muallif",
        genre: "Umumiy",
        libraryId: "lib1"
      });

      expect(result.duplicate).toBe(false);
      expect(mockPrisma.book.create).toHaveBeenCalled();
      // chiziqchasiz toza ISBN saqlanadi
      expect(mockPrisma.book.create.mock.calls[0][0].data.isbn).toBe("9789943000014");
    });

    it("chiziqchali ISBN'ni toza holatga keltirib saqlaydi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue(null);
      mockPrisma.book.create.mockResolvedValue(mockBook);

      await service.create({
        isbn: "978-9943-000-01-4",
        title: "X",
        author: "Y",
        genre: "Z",
        libraryId: "lib1"
      });

      expect(mockPrisma.book.create.mock.calls[0][0].data.isbn).toBe("9789943000014");
    });

    // Dublikat: shu ISBN shu kutubxonada bor → nusxa qo'shiladi (yangi yozuv yo'q).
    it("dublikat ISBN (bir xil kutubxona) → nusxa qo'shiladi, yangi yozuv yaratilmaydi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue({
        ...mockBook,
        totalCount: 5,
        availableCount: 3
      });
      mockPrisma.book.update.mockResolvedValue({
        ...mockBook,
        totalCount: 7,
        availableCount: 5
      });

      const result = await service.create({
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epik",
        totalCount: 2,
        libraryId: "lib1"
      });

      expect(result.duplicate).toBe(true);
      expect(result.message).toContain("allaqachon fondda");
      expect(mockPrisma.book.create).not.toHaveBeenCalled();
      // total + available 2 taga oshdi
      expect(mockPrisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { totalCount: 7, availableCount: 5 }
        })
      );
    });

    // Dublikat ISBN boshqa kutubxonada → yangi yozuv yaratiladi (ruxsat).
    it("bir xil ISBN boshqa kutubxonada → yangi yozuv yaratiladi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue(null); // lib2 da yo'q
      mockPrisma.book.create.mockResolvedValue({ ...mockBook, libraryId: "lib2" });

      const result = await service.create({
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epik",
        libraryId: "lib2"
      });

      expect(result.duplicate).toBe(false);
      expect(mockPrisma.book.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isbn: "9789943452787", libraryId: "lib2" } })
      );
      expect(mockPrisma.book.create).toHaveBeenCalled();
    });

    it("buzilgan ISBN (raqam emas / noto'g'ri uzunlik) bilan BadRequestException", async () => {
      await expect(
        service.create({ isbn: "1111111111111", title: "X", author: "Y", genre: "Z", libraryId: "lib1" })
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ────────────────────────────────────────────────────────────────
  describe("create — ISBN-10 va ISBN'siz kitob", () => {
    it("ISBN-10 ni ISBN-13 ga aylantirib saqlaydi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue(null);
      mockPrisma.book.create.mockResolvedValue(mockBook);

      await service.create({ isbn: "5-17-012345-X", title: "Kitob", author: "Muallif", genre: "Umumiy", libraryId: "lib1" });

      const saved = mockPrisma.book.create.mock.calls[0][0].data.isbn;
      expect(saved).toMatch(/^978517012345\d$/);
      expect(service.isValidIsbn(saved)).toBe(true);
    });

    it("ISBN bo'sh bo'lsa ichki EAN-13 kod (2...) beradi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue(null);
      mockPrisma.book.create.mockResolvedValue(mockBook);

      await service.create({ isbn: "", title: "Eski kitob", author: "Muallif", genre: "Umumiy", libraryId: "lib1" });

      const code = mockPrisma.book.create.mock.calls[0][0].data.isbn;
      expect(code).toMatch(/^2\d{12}$/);
      expect(service.isValidIsbn(code)).toBe(true); // nazorat raqami to'g'ri — shtrix-kod sifatida o'qiladi
    });

    it("ISBN'siz kitob shu kutubxonada bor bo'lsa — nusxa qo'shadi", async () => {
      mockPrisma.book.findFirst.mockResolvedValue({ ...mockBook, isbn: "2000000000015", totalCount: 2, availableCount: 2 });
      mockPrisma.book.update.mockResolvedValue({ ...mockBook, totalCount: 3 });

      const result = await service.create({ isbn: "", title: "Eski kitob", author: "Muallif", genre: "Umumiy", libraryId: "lib1", totalCount: 1 });

      expect(result.duplicate).toBe(true);
      expect(mockPrisma.book.create).not.toHaveBeenCalled();
    });

    it("ISBN'siz kitobda nom yoki muallif bo'lmasa — 400", async () => {
      await expect(
        service.create({ isbn: "", title: "", author: "Muallif", genre: "Umumiy", libraryId: "lib1" }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getCover", () => {
    it("data-URL (JPEG) — rasm baytlari va to'g'ri MIME", async () => {
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
      mockPrisma.book.findUnique.mockResolvedValue({ coverUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
      const r = await service.getCover("b1");
      expect(r).toEqual({ kind: "image", mime: "image/jpeg", data: bytes });
    });

    it("tashqi https URL — redirect", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ coverUrl: "https://covers.openlibrary.org/b/id/1-M.jpg" });
      await expect(service.getCover("b1")).resolves.toEqual({ kind: "redirect", url: "https://covers.openlibrary.org/b/id/1-M.jpg" });
    });

    it("SVG data-URL (skript bo'lishi mumkin) berilmaydi — 404", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ coverUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
      await expect(service.getCover("b1")).rejects.toThrow(NotFoundException);
    });

    it("muqova yo'q — 404", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ coverUrl: null });
      await expect(service.getCover("b1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("update", () => {
    it("kitob ma'lumotlarini yangilaydi", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      mockPrisma.book.update.mockResolvedValue({ ...mockBook, title: "Yangi nom" });

      const result = await service.update("b1", { title: "Yangi nom" });
      expect(result.title).toBe("Yangi nom");
      expect(mockEs.index).toHaveBeenCalled();
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────
  describe("remove", () => {
    it("kitobni o'chiradi (barcha nusxalar joyida, tarix yo'q)", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.book.delete.mockResolvedValue({});

      const result = await service.remove("b1");
      expect(result.message).toContain("o'chirildi");
      expect(mockPrisma.bookTransaction.count).toHaveBeenCalledWith({ where: { bookId: "b1" } });
      expect(mockEs.delete).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
    });

    it("kitobxonlardagi nusxa bo'lsa 409 — avval qaytarilishi kerak", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ ...mockBook, totalCount: 5, availableCount: 3 });
      mockPrisma.book.delete.mockClear();

      await expect(service.remove("b1")).rejects.toThrow(ConflictException);
      await expect(service.remove("b1")).rejects.toThrow("2 ta nusxa hozir kitobxonlarda");
      expect(mockPrisma.book.delete).not.toHaveBeenCalled();
    });

    it("berish/qaytarish tarixi bo'lsa 409 (FK Restrict → avval 500 chiqardi)", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      mockPrisma.bookTransaction.count.mockResolvedValue(4);
      mockPrisma.book.delete.mockClear();

      await expect(service.remove("b1")).rejects.toThrow("4 ta berish/qaytarish yozuvi");
      expect(mockPrisma.book.delete).not.toHaveBeenCalled();
    });
  });

  // ── lookupIsbn ────────────────────────────────────────────────────────────
  describe("lookupIsbn", () => {
    it("Open Library API dan kitob ma'lumotini oladi", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          "ISBN:9789943452787": {
            title: "Alpomish",
            authors: [{ name: "Xalq dostoni" }],
            number_of_pages: 320,
            publish_date: "2020",
            subjects: [{ name: "Epik" }],
            cover: { medium: "https://example.com/cover.jpg" }
          }
        })
      });

      const result = await service.lookupIsbn("9789943452787");
      expect(result?.title).toBe("Alpomish");
      expect(result?.author).toBe("Xalq dostoni");
      expect(result?.pages).toBe(320);
    });

    it("API da topilmasa null qaytaradi", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const result = await service.lookupIsbn("9789943452787");
      expect(result).toBeNull();
    });

    // GRACEFUL: noto'g'ri format endi XATO chiqarmaydi — null qaytaradi
    // (controller 200 + null beradi, frontend yumshoq maslahat ko'rsatadi).
    it("noto'g'ri formatdagi ISBN'da xato chiqarmasdan null qaytaradi", async () => {
      const result = await service.lookupIsbn("1234567890123"); // 978/979 emas
      expect(result).toBeNull();
      // tashqi API'ga umuman so'rov yuborilmaydi
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("juda qisqa ISBN'da null qaytaradi (xato emas)", async () => {
      const result = await service.lookupIsbn("123");
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("Open Library'da yo'q bo'lsa Google Books'dan oladi", async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            items: [{ volumeInfo: { title: "O'tkan kunlar", authors: ["Abdulla Qodiriy"], pageCount: 400, publishedDate: "2019-05-01", language: "uz", imageLinks: { thumbnail: "http://books.google.com/x.jpg" } } }]
          })
        });

      const result = await service.lookupIsbn("9789943452787");
      expect(result?.title).toBe("O'tkan kunlar");
      expect(result?.author).toBe("Abdulla Qodiriy");
      expect(result?.year).toBe(2019);
      expect(result?.coverUrl).toBe("https://books.google.com/x.jpg");
      expect((global.fetch as jest.Mock).mock.calls[1][0]).toContain("googleapis.com/books/v1/volumes?q=isbn:9789943452787");
    });

    it("Open Library 404/5xx bo'lsa null qaytaradi", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false });
      const result = await service.lookupIsbn("9789943452787");
      expect(result).toBeNull();
    });
  });

  // ── Excel import — BOOK-01 (Plan 02-04): async via BullMQ ─────────────────
  describe("enqueueImport", () => {
    it("queues a BOOK_IMPORT job and returns { jobId, status: 'queued' }", async () => {
      (mockImportQueue.add as jest.Mock).mockResolvedValue({ id: "queued-job-42" });

      const buf = Buffer.from("fake-xlsx-bytes");
      const result = await service.enqueueImport(buf, "lib1", "uploader-1");

      expect(result).toEqual({ jobId: "queued-job-42", status: "queued" });
      expect(mockImportQueue.add).toHaveBeenCalledTimes(1);
      const [name, data] = (mockImportQueue.add as jest.Mock).mock.calls[0];
      expect(name).toBe("book-import");
      expect(data.libraryId).toBe("lib1");
      expect(data.uploaderUserId).toBe("uploader-1");
      // fileBase64 round-trips the buffer
      expect(Buffer.from(data.fileBase64, "base64").toString()).toBe("fake-xlsx-bytes");
    });
  });

  describe("getImportStatus", () => {
    it("returns 'unknown' when the job does not exist", async () => {
      (mockImportQueue.getJob as jest.Mock).mockResolvedValue(null);
      const result = await service.getImportStatus("missing");
      expect(result.status).toBe("unknown");
      expect(result.processed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("reports running progress + processed/total/errors from job.data", async () => {
      (mockImportQueue.getJob as jest.Mock).mockResolvedValue({
        getState: jest.fn().mockResolvedValue("active"),
        data: { processed: 42, total: 100, errors: [{ row: 3, reason: "ISBN noto'g'ri" }] },
        progress: 42
      });

      const result = await service.getImportStatus("job-1");
      expect(result.status).toBe("active");
      expect(result.processed).toBe(42);
      expect(result.total).toBe(100);
      expect(result.errors).toHaveLength(1);
      expect(result.progress).toBe(42);
    });

    it("reports 'completed' with the final processed count", async () => {
      (mockImportQueue.getJob as jest.Mock).mockResolvedValue({
        getState: jest.fn().mockResolvedValue("completed"),
        data: { processed: 100, total: 100, errors: [] },
        progress: 100
      });

      const result = await service.getImportStatus("job-2");
      expect(result.status).toBe("completed");
      expect(result.processed).toBe(100);
      expect(result.progress).toBe(100);
    });
  });

  // ── search (ES fallback) ──────────────────────────────────────────────────
  describe("search", () => {
    it("ES: `sifat_books` dan ID + tartib + jami; maydonlar (kutubxona bilan) bazadan, ES tartibida", async () => {
      mockEs.search.mockResolvedValue({
        hits: { total: { value: 2 }, hits: [{ _id: "b2" }, { _id: "b1" }] }
      });
      const b2 = { ...mockBook, id: "b2", title: "Mehrobdan chayon" };
      mockPrisma.book.findMany.mockResolvedValue([mockBook, b2]); // baza tartibi boshqacha

      const result = await service.search({ q: "Alpomish" });

      expect(mockEs.search).toHaveBeenCalledWith(
        expect.objectContaining({ index: "sifat_books", _source: false, track_total_hits: true })
      );
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["b2", "b1"] } },
        include: { library: true }
      });
      expect(result.total).toBe(2);
      expect(result.data.map((b) => (b as { id: string }).id)).toEqual(["b2", "b1"]);
      // Avval ES yo'lida `library` yo'q edi — karta kutubxonaga havola bera olmasdi
      expect((result.data[1] as { library: { name: string } }).library.name).toBe("Karmana kutubxonasi");
    });

    it("ES bazada yo'q (eskirgan) ID qaytarsa — natijadan tashlab yuboriladi", async () => {
      mockEs.search.mockResolvedValue({
        hits: { total: { value: 2 }, hits: [{ _id: "b1" }, { _id: "ghost" }] }
      });
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      const result = await service.search({ q: "Alpomish" });
      expect(result.data).toHaveLength(1);
    });

    it("ES 0 natija (bo'sh/eskirgan indeks) — bazada qayta tekshiriladi, kitob yo'qolmaydi", async () => {
      mockEs.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      mockPrisma.book.count.mockResolvedValue(1);

      const result = await service.search({ q: "Alpomish" });
      expect(result.total).toBe(1);
      expect((result.data[0] as Record<string, unknown>)["title"]).toBe("Alpomish");
      // Bu ES xatosi emas — cooldown boshlanmaydi
      expect((service as unknown as { esCooldownUntil: number }).esCooldownUntil).toBe(0);
    });

    it("noto'g'ri sahifa (?page=abc) — 1-sahifa; ES xato bermaydi, cooldown yoqilmaydi", async () => {
      mockEs.search.mockResolvedValue({ hits: { total: { value: 1 }, hits: [{ _id: "b1" }] } });
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      const result = await service.search({ q: "Alpomish", page: "abc" as unknown as number });

      expect(mockEs.search).toHaveBeenCalledWith(expect.objectContaining({ from: 0 }));
      expect(result.page).toBe(1);
      expect((service as unknown as { esCooldownUntil: number }).esCooldownUntil).toBe(0);
    });

    it("fallback: til prefiks bo'yicha; query-string'dagi available=\"false\" filtrlamaydi", async () => {
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);

      await service.search({ lang: "uz", available: "false" as unknown as boolean });

      const where = mockPrisma.book.findMany.mock.calls[0][0].where;
      expect(where.lang).toEqual({ startsWith: "uz", mode: "insensitive" });
      expect(where).not.toHaveProperty("availableCount");
    });

    it("ES down bo'lganda Prisma fallback ishlatadi", async () => {
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      const result = await service.search({ q: "Alpomish" });
      expect((result.data[0] as Record<string, unknown>)["title"]).toBe("Alpomish");
    });

    // ES yiqilganda har qidiruv requestTimeout+retry (~3.5 s) kutmasligi uchun
    // birinchi xatodan keyin 60 s davomida ES'ga umuman murojaat qilinmaydi.
    it("ES yiqilgandan keyin cooldown: keyingi qidiruv ES'ga urinmaydi, cooldown tugagach yana urinadi", async () => {
      mockEs.search.mockClear();
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      await service.search({ q: "Alpomish" });
      expect(mockEs.search).toHaveBeenCalledTimes(1);

      // Cooldown ichida — ES tiklangan bo'lsa ham chaqirilmaydi, to'g'ridan-to'g'ri Prisma
      mockEs.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });
      const second = await service.search({ q: "Alpomish" });
      expect(mockEs.search).toHaveBeenCalledTimes(1);
      expect((second.data[0] as Record<string, unknown>)["title"]).toBe("Alpomish");

      // Cooldown tugadi — ES yana ishlatiladi
      (service as unknown as { esCooldownUntil: number }).esCooldownUntil = 0;
      await service.search({ q: "Alpomish" });
      expect(mockEs.search).toHaveBeenCalledTimes(2);
    });

    it("ES o'chirilgan (ELASTICSEARCH_ENABLED=false) holatda cooldown boshlanmaydi", async () => {
      (service as unknown as { esEnabled: boolean }).esEnabled = false;
      mockEs.search.mockClear();
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      await service.search({ q: "Alpomish" });
      expect(mockEs.search).not.toHaveBeenCalled();
      expect((service as unknown as { esCooldownUntil: number }).esCooldownUntil).toBe(0);
    });

    // ── AUDIT-REPORT M16 — limit clamp (ES + fallback) va to'g'ri total ─────
    it("M16: ES yo'lida limit 5000 → size 100 ga clamp", async () => {
      mockEs.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });

      const result = await service.search({ q: "x", limit: 5000 });

      expect(mockEs.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 100 })
      );
      expect(result.limit).toBe(100);
    });

    it("M16: ES yo'lida limit berilmasa default 20", async () => {
      mockEs.search.mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });

      await service.search({ q: "x" });

      expect(mockEs.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 20 })
      );
    });

    it("M16: fallback yo'lida limit 5000 → take 100; total = prisma.count()", async () => {
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      mockPrisma.book.count.mockResolvedValue(137);

      const result = await service.search({ q: "Alpomish", limit: 5000 });

      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 })
      );
      // total endi sahifa uzunligi (books.length=1) emas — haqiqiy soni.
      expect(result.total).toBe(137);
      expect(result.limit).toBe(100);
    });

    it("M16: fallback count() findMany bilan BIR XIL where bilan chaqiriladi", async () => {
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.count.mockResolvedValue(0);

      await service.search({ q: "Alpomish", genre: "Epik", available: true });

      const findManyWhere = mockPrisma.book.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.book.count.mock.calls[0][0].where;
      expect(countWhere).toEqual(findManyWhere);
    });
  });

  // ── Elasticsearch indeksi: yozish, qayta to'ldirish, sinxronizatsiya ──────
  describe("ES indeksi (sifat_books)", () => {
    it("indexBook: indeks bir marta tekshiriladi, hujjat `_id` = kitob ID, kutubxona nomi bilan", async () => {
      await service.indexBook(mockBook);
      await service.indexBook({ ...mockBook, id: "b2" });

      expect(mockEs.indices.exists).toHaveBeenCalledTimes(1);
      expect(mockEs.index).toHaveBeenCalledWith({
        index: "sifat_books",
        id: "b1",
        document: expect.objectContaining({ id: "b1", title: "Alpomish", libraryName: "Karmana kutubxonasi" })
      });
    });

    it("indexBook: indeks yo'q bo'lsa — avval mapping bilan yaratiladi (ES dinamik yaratmasin)", async () => {
      mockEs.indices.exists.mockResolvedValueOnce(false);
      await service.indexBook(mockBook);
      expect(mockEs.indices.create).toHaveBeenCalledWith(expect.objectContaining({ index: "sifat_books", mappings: expect.any(Object) }));
      expect(mockEs.indices.create.mock.invocationCallOrder[0]).toBeLessThan(mockEs.index.mock.invocationCallOrder[0]);
    });

    it("indexBook: ES xatosi kitobni saqlashni to'xtatmaydi va indeks keyingi safar qayta tekshiriladi", async () => {
      mockEs.index.mockRejectedValueOnce(new Error("ES down"));
      await expect(service.indexBook(mockBook)).resolves.toBeUndefined();
      await service.indexBook(mockBook);
      expect(mockEs.indices.exists).toHaveBeenCalledTimes(2);
    });

    it("remove: hujjat `sifat_books` dan o'chiriladi", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.book.delete.mockResolvedValue({});
      await service.remove("b1");
      expect(mockEs.delete).toHaveBeenCalledWith({ index: "sifat_books", id: "b1" });
    });

    it("reindexAll: ES o'chiq bo'lsa 503", async () => {
      (service as unknown as { esEnabled: boolean }).esEnabled = false;
      await expect(service.reindexAll()).rejects.toThrow(ServiceUnavailableException);
      expect(mockEs.bulk).not.toHaveBeenCalled();
    });

    it("reindexAll: bazadagi barcha kitoblar yoziladi, refresh, cooldown tozalanadi", async () => {
      (service as unknown as { esCooldownUntil: number }).esCooldownUntil = Date.now() + 60_000;
      mockPrisma.book.count.mockResolvedValue(2);
      mockPrisma.book.findMany.mockResolvedValueOnce([mockBook, { ...mockBook, id: "b2" }]).mockResolvedValue([]);

      const result = await service.reindexAll({ recreate: true });

      expect(mockEs.indices.delete).toHaveBeenCalledWith({ index: "sifat_books" });
      expect(mockEs.bulk).toHaveBeenCalledTimes(1);
      expect(mockEs.indices.refresh).toHaveBeenCalledWith({ index: "sifat_books" });
      expect(result).toMatchObject({ index: "sifat_books", indexState: "recreated", total: 2, indexed: 2, failed: 0 });
      expect((service as unknown as { esCooldownUntil: number }).esCooldownUntil).toBe(0);
    });

    it("backfillIfEmpty: indeks bo'sh va bazada kitob bor — to'liq to'ldiradi; bo'sh emas — tegmaydi", async () => {
      mockEs.count.mockResolvedValueOnce({ count: 0 });
      mockPrisma.book.count.mockResolvedValue(1);
      mockPrisma.book.findMany.mockResolvedValueOnce([mockBook]).mockResolvedValue([]);
      await expect(service.backfillIfEmpty()).resolves.toBe(true);
      expect(mockEs.bulk).toHaveBeenCalledTimes(1);

      mockEs.bulk.mockClear();
      mockEs.count.mockResolvedValueOnce({ count: 214 });
      await expect(service.backfillIfEmpty()).resolves.toBe(false);
      expect(mockEs.bulk).not.toHaveBeenCalled();
    });

    it("onApplicationBootstrap: ES ishlamasa ham ishga tushish yiqilmaydi", async () => {
      mockEs.count.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
    });

    it("syncChangedBooks: oxirgi sinxronizatsiyadan (−1 daqiqa) beri o'zgargan kitoblarni indekslaydi", async () => {
      (service as unknown as { esBackfillChecked: boolean }).esBackfillChecked = true;
      const lastSync = new Date("2020-01-01T10:00:00.000Z");
      (service as unknown as { lastEsSyncAt: Date }).lastEsSyncAt = lastSync;
      mockPrisma.book.findMany.mockResolvedValueOnce([mockBook]).mockResolvedValue([]);

      await expect(service.syncChangedBooks()).resolves.toEqual({ indexed: 1, failed: 0 });

      const where = mockPrisma.book.findMany.mock.calls[0][0].where;
      expect(where.updatedAt.gte.toISOString()).toBe("2020-01-01T09:59:00.000Z");
      expect((service as unknown as { lastEsSyncAt: Date }).lastEsSyncAt.getTime()).toBeGreaterThan(lastSync.getTime());
    });

    it("syncChangedBooks: ES o'chiq yoki cooldown'da — hech narsa qilmaydi", async () => {
      (service as unknown as { esCooldownUntil: number }).esCooldownUntil = Date.now() + 60_000;
      await expect(service.syncChangedBooks()).resolves.toBeNull();
      (service as unknown as { esEnabled: boolean }).esEnabled = false;
      (service as unknown as { esCooldownUntil: number }).esCooldownUntil = 0;
      await expect(service.syncChangedBooks()).resolves.toBeNull();
      expect(mockEs.bulk).not.toHaveBeenCalled();
    });
  });

  // ── scanUserQr ────────────────────────────────────────────────────────────
  describe("scanUserQr", () => {
    it("SifatId bo'yicha foydalanuvchi va aktiv transaksiyalarni qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        name: "Alisher Navoiy",
        sifatId: "SL-UZ-14-001-0001-00001",
        type: "CITIZEN",
        status: "ACTIVE",
        trustScore: 80,
        transactions: [{ status: "BORROWED", book: { title: "Alpomish" } }]
      });

      const result = await service.scanUserQr("SL-UZ-14-001-0001-00001");
      expect(result.name).toBe("Alisher Navoiy");
      expect(result.transactions).toHaveLength(1);
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.scanUserQr("SL-NOTEXIST")).rejects.toThrow(NotFoundException);
    });
  });
});
