import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { BooksService } from "../books.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

jest.mock("@nestjs/elasticsearch", () => ({
  ElasticsearchService: jest.fn(),
  InjectElasticsearch: () => () => undefined,
}));
jest.mock("../../store/store.service", () => ({ StoreService: jest.fn() }));

import { ElasticsearchService } from "@nestjs/elasticsearch";

// POST /books/import — kutubxona egaligi tekshiruvi.
// KUTUBXONACHI / MUASSASA_ADMIN faqat o'z kutubxonasiga (User → Institution →
// libraryId), SUPER_ADMIN istalganiga; libraryId yo'q → 400.
describe("BooksService.enqueueImport — library ownership", () => {
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    institution: { findUnique: jest.fn() },
    book: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      aggregate: jest.fn(),
    },
    library: { update: jest.fn() },
  };
  const mockEs = { index: jest.fn(), delete: jest.fn() };
  const mockQueue = { add: jest.fn(), getJob: jest.fn() };
  const buf = Buffer.from("xlsx");
  let service: BooksService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueue.add.mockResolvedValue({ id: "job-1" });
    service = new BooksService(
      mockPrisma as unknown as PrismaService,
      mockEs as unknown as ElasticsearchService,
      mockQueue as unknown as Queue,
      {} as any,
    );
  });

  const ownsLibrary = (libraryId: string | null) => {
    mockPrisma.user.findUnique.mockResolvedValue({
      schoolId: "school-1",
      universityId: null,
      organizationId: null,
    });
    mockPrisma.institution.findUnique.mockResolvedValue({ libraryId });
  };

  it.each(["KUTUBXONACHI", "MUASSASA_ADMIN"])(
    "%s can import into the library they manage",
    async (role) => {
      ownsLibrary("lib-own");
      const res = await service.enqueueImport(buf, "lib-own", { id: "u1", role });
      expect(res).toEqual({ jobId: "job-1", status: "queued" });
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add.mock.calls[0][1].libraryId).toBe("lib-own");
      expect(mockPrisma.institution.findUnique).toHaveBeenCalledWith({
        where: { id: "school-1" },
        select: { libraryId: true },
      });
    },
  );

  it.each(["KUTUBXONACHI", "MUASSASA_ADMIN"])(
    "%s gets 403 for another library and nothing is queued",
    async (role) => {
      ownsLibrary("lib-own");
      await expect(
        service.enqueueImport(buf, "lib-other", { id: "u1", role }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockQueue.add).not.toHaveBeenCalled();
    },
  );

  it("403 when the staff user has no linked library (fail-closed)", async () => {
    ownsLibrary(null);
    await expect(
      service.enqueueImport(buf, "lib-any", { id: "u1", role: "KUTUBXONACHI" }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("403 for roles without library management (e.g. TUMAN_ADMIN)", async () => {
    await expect(
      service.enqueueImport(buf, "lib-any", { id: "u1", role: "TUMAN_ADMIN" }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("SUPER_ADMIN can import into any library without a lookup", async () => {
    const res = await service.enqueueImport(buf, "lib-any", { id: "sa", role: "SUPER_ADMIN" });
    expect(res.jobId).toBe("job-1");
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("400 when libraryId is missing (%p)", async (libraryId) => {
    await expect(
      service.enqueueImport(buf, libraryId, { id: "sa", role: "SUPER_ADMIN" }),
    ).rejects.toThrow(BadRequestException);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });
});

// POST/PUT/DELETE /books — xuddi shu egalik qoidasi (create: dto.libraryId,
// update/remove: kitobning DB dagi libraryId si).
describe("BooksService write endpoints — library ownership", () => {
  const book = { id: "b1", libraryId: "lib-own", title: "Alpomish", library: { id: "lib-own" } };
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    institution: { findUnique: jest.fn() },
    book: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      aggregate: jest.fn(),
    },
    library: { update: jest.fn() },
  };
  const mockEs = { index: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) };
  let service: BooksService;
  const dto = { isbn: "9789943452787", title: "Alpomish", author: "Xalq", genre: "Epik" };

  beforeEach(() => {
    jest.clearAllMocks();
    // Kitob yozish testi ES ga bog'liq bo'lmasin
    process.env.ELASTICSEARCH_ENABLED = "false";
    service = new BooksService(
      mockPrisma as unknown as PrismaService,
      mockEs as unknown as ElasticsearchService,
      { add: jest.fn(), getJob: jest.fn() } as unknown as Queue,
      {} as any,
    );
    mockPrisma.user.findUnique.mockResolvedValue({
      schoolId: "school-1",
      universityId: null,
      organizationId: null,
    });
    mockPrisma.institution.findUnique.mockResolvedValue({ libraryId: "lib-own" });
    mockPrisma.book.findUnique.mockResolvedValue(book);
    mockPrisma.book.findFirst.mockResolvedValue(null);
    mockPrisma.book.create.mockResolvedValue(book);
    mockPrisma.book.update.mockResolvedValue(book);
    mockPrisma.book.delete.mockResolvedValue({});
    mockPrisma.book.aggregate.mockResolvedValue({ _sum: { totalCount: 1 } });
  });

  afterAll(() => {
    delete process.env.ELASTICSEARCH_ENABLED;
  });

  const librarian = { id: "u1", role: "KUTUBXONACHI" };

  describe("create", () => {
    it("allows staff to add a book to their own library", async () => {
      await service.create({ ...dto, libraryId: "lib-own" }, librarian);
      expect(mockPrisma.book.create).toHaveBeenCalled();
    });

    it("403 for another library — nothing written", async () => {
      await expect(
        service.create({ ...dto, libraryId: "lib-other" }, { id: "u1", role: "MUASSASA_ADMIN" }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.book.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.book.create).not.toHaveBeenCalled();
    });

    it("400 when libraryId is missing", async () => {
      await expect(
        service.create({ ...dto, libraryId: "" }, { id: "sa", role: "SUPER_ADMIN" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.book.create).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN can add to any library", async () => {
      await service.create({ ...dto, libraryId: "lib-other" }, { id: "sa", role: "SUPER_ADMIN" });
      expect(mockPrisma.book.create).toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("allows staff to edit a book in their own library", async () => {
      await service.update("b1", { title: "Yangi" }, librarian);
      expect(mockPrisma.book.update).toHaveBeenCalled();
    });

    it("403 when the book belongs to another library", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ ...book, libraryId: "lib-other" });
      await expect(service.update("b1", { title: "Yangi" }, librarian)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.book.update).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("allows MUASSASA_ADMIN to delete a book in their own library", async () => {
      await service.remove("b1", { id: "u1", role: "MUASSASA_ADMIN" });
      expect(mockPrisma.book.delete).toHaveBeenCalledWith({ where: { id: "b1" } });
    });

    it("403 when the book belongs to another library", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ ...book, libraryId: "lib-other" });
      await expect(
        service.remove("b1", { id: "u1", role: "MUASSASA_ADMIN" }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.book.delete).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN can delete in any library", async () => {
      mockPrisma.book.findUnique.mockResolvedValue({ ...book, libraryId: "lib-other" });
      await service.remove("b1", { id: "sa", role: "SUPER_ADMIN" });
      expect(mockPrisma.book.delete).toHaveBeenCalled();
    });
  });
});
