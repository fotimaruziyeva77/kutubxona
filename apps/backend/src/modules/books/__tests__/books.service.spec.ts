import { NotFoundException, BadRequestException } from "@nestjs/common";
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
  }
};

const mockEs = {
  index: jest.fn().mockResolvedValue({}),
  search: jest.fn(),
  delete: jest.fn().mockResolvedValue({})
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
    it("barcha kitoblarni library bilan qaytaradi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      const result = await service.findAll();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Alpomish");
    });

    it("libraryId filtr bilan qaytaradi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);
      await service.findAll("lib1");
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib1" } })
      );
    });

    // AUDIT-REPORT M16 — majburiy pagination
    it("M16: default take 50, skip 0 (avval butun jadval qaytarilardi)", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      await service.findAll();
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 })
      );
    });

    it("M16: limit 100000 → take 200 ga clamp qilinadi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      await service.findAll(undefined, 1, 100000);
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 })
      );
    });

    it("M16: page 3 + limit 10 → skip 20", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      await service.findAll("lib1", 3, 10);
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib1" }, skip: 20, take: 10 })
      );
    });

    it("M16: noto'g'ri (NaN/manfiy) qiymatlar xavfsiz defaultlarga tushadi", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);
      await service.findAll(undefined, Number("abc"), -5);
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
    it("kitobni o'chiradi", async () => {
      mockPrisma.book.findUnique.mockResolvedValue(mockBook);
      mockPrisma.book.delete.mockResolvedValue({});

      const result = await service.remove("b1");
      expect(result.message).toContain("o'chirildi");
      expect(mockEs.delete).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
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
    it("Elasticsearch mavjud bo'lsa ES natijalarini qaytaradi", async () => {
      mockEs.search.mockResolvedValue({
        hits: {
          total: { value: 1 },
          hits: [{ _id: "b1", _source: { title: "Alpomish", author: "Xalq dostoni" } }]
        }
      });

      const result = await service.search({ q: "Alpomish" });
      expect(result.total).toBe(1);
      expect((result.data[0] as Record<string, unknown>)["title"]).toBe("Alpomish");
    });

    it("ES down bo'lganda Prisma fallback ishlatadi", async () => {
      mockEs.search.mockRejectedValue(new Error("ES unavailable"));
      mockPrisma.book.findMany.mockResolvedValue([mockBook]);

      const result = await service.search({ q: "Alpomish" });
      expect((result.data[0] as Record<string, unknown>)["title"]).toBe("Alpomish");
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
