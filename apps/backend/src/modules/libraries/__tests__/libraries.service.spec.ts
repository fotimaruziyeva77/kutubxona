import {
  NotFoundException,
  BadRequestException,
  ForbiddenException
} from "@nestjs/common";
import { LibrariesService } from "../libraries.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { LibraryStatus, LibraryType } from "@prisma/client";

const mockLib = {
  id: "lib1",
  code: "LIB-GOV-08012-001",
  type: LibraryType.GOV,
  name: "Karmana kutubxonasi",
  regionId: "tuman1",
  tumanId: "tuman1",
  viloyatId: "viloyat1",
  status: LibraryStatus.PENDING,
  fundCount: 100,
  frozenReason: null,
  books: [],
  approvalLogs: [{ id: "log1", action: "SUBMITTED", createdAt: new Date() }],
  subscriptions: [],
  address: "Karmana, Markaziy ko'cha 1",
  phone: "+998612345678",
  workHours: "09:00-18:00",
  latitude: 40.1391,
  longitude: 65.3694,
  createdAt: new Date(),
  updatedAt: new Date()
};

const mockActiveLib = { ...mockLib, status: LibraryStatus.ACTIVE, approvalLogs: [] };

const mockPrisma = {
  library: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn()
  },
  libraryApprovalLog: {
    create: jest.fn()
  },
  book: {
    aggregate: jest.fn(),
    update: jest.fn()
  },
  bookTransfer: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  // findOne() readerCount ni Institution.libraryId orqali hisoblaydi
  // (libraries.service.ts:139). Bu modellarsiz findOne ga tayanadigan
  // har bir test TypeError bilan yiqilardi.
  institution: {
    findFirst: jest.fn()
  },
  user: {
    count: jest.fn()
  },
  $transaction: jest.fn()
};

describe("LibrariesService", () => {
  let service: LibrariesService;

  beforeEach(() => {
    service = new LibrariesService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
    // Default: kutubxonaga bog'langan muassasa yo'q → readerCount = 0.
    // Testlar kerak bo'lsa o'zi qayta yozadi.
    mockPrisma.institution.findFirst.mockResolvedValue(null);
    mockPrisma.user.count.mockResolvedValue(0);
  });

  // ── findAll ───────────────────────────────────────────────────────────────
  describe("findAll", () => {
    it("barcha kutubxonalarni qaytaradi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([mockLib, mockActiveLib]);
      const result = await service.findAll();
      expect(result).toHaveLength(2);
    });

    it("status filtr bilan qaytaradi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([mockLib]);
      await service.findAll(LibraryStatus.PENDING);
      expect(mockPrisma.library.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: LibraryStatus.PENDING }) })
      );
    });
  });

  // ── findOne ───────────────────────────────────────────────────────────────
  describe("findOne", () => {
    it("mavjud kutubxonani qaytaradi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockLib);
      const result = await service.findOne("lib1");
      expect(result.code).toBe("LIB-GOV-08012-001");
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(null);
      await expect(service.findOne("notfound")).rejects.toThrow(NotFoundException);
    });
  });

  // ── findByCode ────────────────────────────────────────────────────────────
  describe("findByCode", () => {
    it("kod bo'yicha qaytaradi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockLib);
      const result = await service.findByCode("LIB-GOV-08012-001");
      expect(result.id).toBe("lib1");
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(null);
      await expect(service.findByCode("WRONG")).rejects.toThrow(NotFoundException);
    });
  });

  // ── create ────────────────────────────────────────────────────────────────
  describe("create", () => {
    it("yangi kutubxona yaratadi va LIB kodi generatsiya qiladi", async () => {
      mockPrisma.library.count.mockResolvedValue(0);
      mockPrisma.library.create.mockResolvedValue({ ...mockLib, code: "LIB-GOV-TUMAN1-001" });

      const result = await service.create({
        type: LibraryType.GOV,
        name: "Test kutubxona",
        regionId: "tuman1",
        tumanId: "tuman1"
      });

      expect(mockPrisma.library.create).toHaveBeenCalled();
      expect(result.code).toContain("LIB-GOV");
    });

    it("maktab kutubxonasi SCH prefiksi bilan", async () => {
      mockPrisma.library.count.mockResolvedValue(2);
      mockPrisma.library.create.mockResolvedValue({ ...mockLib, type: LibraryType.SCH, code: "LIB-SCH-TUMAN1-003" });

      const result = await service.create({
        type: LibraryType.SCH,
        name: "8-maktab kutubxonasi",
        regionId: "tuman1"
      });

      expect(result.type).toBe(LibraryType.SCH);
    });

    // ── Plan 04-04 audit-fix FIX C (SEC HIGH input validation) ──────────
    //
    // Service-layer defence in depth: the DTO class-validator runs at the
    // controller via global ValidationPipe; the service re-checks so that
    // any internal caller (CLI / seed / future API) is also gated.
    describe("FIX C — Library.name input validation (service layer)", () => {
      beforeEach(() => {
        mockPrisma.library.count.mockResolvedValue(0);
        mockPrisma.library.create.mockResolvedValue(mockLib);
      });

      it("strips CR/LF from name before persisting (service-layer defence in depth)", async () => {
        // The DTO class-validator rejects CR/LF at the controller, but if a
        // caller bypasses the ValidationPipe the service strips CR/LF and
        // persists a single-line name. The persisted name must not contain
        // any control char.
        await service.create({
          type: LibraryType.GOV,
          name: "Test\nLibrary",
          regionId: "tuman1",
        });
        const persistedName = (mockPrisma.library.create as jest.Mock).mock
          .calls[0][0].data.name;
        expect(persistedName).not.toMatch(/[\r\n]/);
        expect(persistedName).toBe("Test Library");
      });

      it("rejects name containing URL fragment https://", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "Test https://evil.uz library",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it("rejects name containing bit.ly", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "Click bit.ly/fishy",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it("rejects name containing t.me telegram link", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "Join t.me/group",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it("rejects name longer than 120 chars", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "A".repeat(121),
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it("rejects empty / single-char name", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "A",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it("accepts a normal Cyrillic name", async () => {
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "Карманинский кутубхона",
            regionId: "tuman1",
          }),
        ).resolves.toBeDefined();
      });

      it("accepts a normal Latin name with hyphens and digits", async () => {
        await expect(
          service.create({
            type: LibraryType.SCH,
            name: "8-maktab kutubxonasi",
            regionId: "tuman1",
          }),
        ).resolves.toBeDefined();
      });

      it("strips CR/LF from a name that passes legacy validation by inserting space", async () => {
        // A name that, after CR/LF stripping, still fails the URL check
        // should be rejected — i.e. CR/LF doesn't bypass URL detection.
        await expect(
          service.create({
            type: LibraryType.GOV,
            name: "name\rhttps://evil",
            regionId: "tuman1",
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  // ── update ────────────────────────────────────────────────────────────────
  describe("update", () => {
    it("kutubxona ma'lumotlarini yangilaydi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockLib);
      mockPrisma.library.update.mockResolvedValue({ ...mockLib, name: "Yangi nom" });

      const result = await service.update("lib1", { name: "Yangi nom" });
      expect(result.name).toBe("Yangi nom");
    });
  });

  // ── approveByTuman ────────────────────────────────────────────────────────
  describe("approveByTuman", () => {
    it("PENDING kutubxonani tuman admin tasdiqlaydi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockLib);
      mockPrisma.libraryApprovalLog.create.mockResolvedValue({});

      const result = await service.approveByTuman("lib1", "admin1");
      expect(mockPrisma.libraryApprovalLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: "TUMAN_APPROVED" }) })
      );
      expect(result.message).toContain("Super admin");
    });

    it("ACTIVE kutubxonani tasdiqlashga BadRequest", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockActiveLib);
      await expect(service.approveByTuman("lib1", "admin1")).rejects.toThrow(BadRequestException);
    });

    it("allaqachon TUMAN_APPROVED bo'lsa BadRequest", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        ...mockLib,
        approvalLogs: [{ action: "TUMAN_APPROVED" }]
      });
      await expect(service.approveByTuman("lib1", "admin1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── approveBySuperAdmin ───────────────────────────────────────────────────
  describe("approveBySuperAdmin", () => {
    it("TUMAN_APPROVED dan keyin ACTIVE qiladi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        ...mockLib,
        approvalLogs: [{ action: "TUMAN_APPROVED" }]
      });
      mockPrisma.library.update.mockResolvedValue({ ...mockLib, status: LibraryStatus.ACTIVE });

      const result = await service.approveBySuperAdmin("lib1", "superadmin1");
      expect(result.status).toBe(LibraryStatus.ACTIVE);
    });

    it("tuman tasdiqisiz super approve BadRequest", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockLib);
      await expect(service.approveBySuperAdmin("lib1", "sa1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── freeze / unfreeze ─────────────────────────────────────────────────────
  describe("freeze / unfreeze", () => {
    it("faol kutubxonani muzlatadi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockActiveLib);
      mockPrisma.library.update.mockResolvedValue({ ...mockActiveLib, status: LibraryStatus.FROZEN });

      const result = await service.freeze("lib1", "Ta'mirga bordi", "admin1");
      expect(result.status).toBe(LibraryStatus.FROZEN);
    });

    it("sabab bo'lmasa BadRequest", async () => {
      await expect(service.freeze("lib1", "", "admin1")).rejects.toThrow(BadRequestException);
    });

    it("muzlatilgan kutubxonani ochadi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        ...mockActiveLib,
        status: LibraryStatus.FROZEN
      });
      mockPrisma.library.update.mockResolvedValue({ ...mockActiveLib, status: LibraryStatus.ACTIVE });

      const result = await service.unfreeze("lib1", "admin1");
      expect(result.status).toBe(LibraryStatus.ACTIVE);
    });

    it("muzlatilmagan kutubxonani ochish BadRequest", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockActiveLib);
      await expect(service.unfreeze("lib1", "admin1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── softDelete ────────────────────────────────────────────────────────────
  describe("softDelete", () => {
    it("'ROZIMAN' bilan o'chiradi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue(mockActiveLib);
      mockPrisma.library.update.mockResolvedValue({ ...mockActiveLib, status: LibraryStatus.DELETED });

      const result = await service.softDelete("lib1", "ROZIMAN", "sa1");
      expect(result.status).toBe(LibraryStatus.DELETED);
    });

    it("boshqa so'z bilan ForbiddenException", async () => {
      await expect(service.softDelete("lib1", "HA", "sa1")).rejects.toThrow(ForbiddenException);
    });

    it("allaqachon o'chirilgan bo'lsa BadRequest", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({ ...mockActiveLib, status: LibraryStatus.DELETED });
      await expect(service.softDelete("lib1", "ROZIMAN", "sa1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── getInventoryReport ────────────────────────────────────────────────────
  describe("getInventoryReport", () => {
    it("inventarizatsiya hisobotini qaytaradi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        ...mockActiveLib,
        fundCount: 100,
        books: [
          { id: "b1", totalCount: 90, availableCount: 80 },
          { id: "b2", totalCount: 5, availableCount: 5 }
        ]
      });

      const report = await service.getInventoryReport("lib1");
      expect(report.dbBookCount).toBe(95);
      expect(report.availableCount).toBe(85);
      expect(report.borrowedCount).toBe(10);
      expect(report.discrepancy).toBe(5);
      expect(report.alert).toBe(true); // 5% threshold
    });

    it("to'liq moslik bo'lganda alert:false", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        ...mockActiveLib,
        fundCount: 100,
        books: [{ id: "b1", totalCount: 100, availableCount: 80 }]
      });

      const report = await service.getInventoryReport("lib1");
      expect(report.discrepancy).toBe(0);
      expect(report.alert).toBe(false);
    });
  });

  // ── confirmTransfer (BOOK-02 Plan 02-05) ──────────────────────────────────
  describe("confirmTransfer", () => {
    const sourceLibraryId = "lib-navoiy";
    const transferId = "transfer-1";
    const bookId = "book-alpomish";
    const directorId = "director-navoiy";

    const pendingTransfer = {
      id: transferId,
      transactionId: "tx-1",
      fromLibraryId: sourceLibraryId,
      toLibraryId: "lib-tashkent",
      status: "PENDING",
      requestedAt: new Date(),
      confirmedAt: null,
      confirmedById: null,
      fromLibrary: {
        id: sourceLibraryId,
        institutionId: "inst-1",
        institution: { id: "inst-1", directorId }
      },
      transaction: {
        id: "tx-1",
        bookId,
        book: { id: bookId, libraryId: sourceLibraryId }
      }
    };

    function runInteractiveTransaction() {
      mockPrisma.$transaction.mockImplementation(
        async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
          fn(mockPrisma as unknown as typeof mockPrisma)
      );
    }

    it("happy path: source-library director confirms — updates BookTransfer + atomic increment", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(pendingTransfer);
      mockPrisma.bookTransfer.update.mockResolvedValue({
        ...pendingTransfer,
        status: "CONFIRMED",
        confirmedAt: new Date(),
        confirmedById: directorId
      });
      mockPrisma.book.update.mockResolvedValue({ id: bookId });

      const result = await service.confirmTransfer(sourceLibraryId, transferId, {
        id: directorId,
        role: "KUTUBXONACHI"
      });

      // BookTransfer updated → status=CONFIRMED + confirmedAt + confirmedById
      expect(mockPrisma.bookTransfer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: transferId },
          data: expect.objectContaining({
            status: "CONFIRMED",
            confirmedById: directorId
          })
        })
      );
      const updateArgs = mockPrisma.bookTransfer.update.mock.calls[0][0] as {
        data: { confirmedAt: Date };
      };
      expect(updateArgs.data.confirmedAt).toBeInstanceOf(Date);

      // book.update called with atomic { increment: 1 } — race-safe
      expect(mockPrisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: bookId },
          data: { availableCount: { increment: 1 } }
        })
      );

      expect(result.confirmed).toBe(true);
    });

    it("SUPER_ADMIN can confirm even without directorId match", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(pendingTransfer);
      mockPrisma.bookTransfer.update.mockResolvedValue({ ...pendingTransfer, status: "CONFIRMED" });
      mockPrisma.book.update.mockResolvedValue({ id: bookId });

      const result = await service.confirmTransfer(sourceLibraryId, transferId, {
        id: "rogue-admin",
        role: "SUPER_ADMIN"
      });

      expect(result.confirmed).toBe(true);
      expect(mockPrisma.book.update).toHaveBeenCalled();
    });

    it("rejects non-owner with ForbiddenException", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(pendingTransfer);

      await expect(
        service.confirmTransfer(sourceLibraryId, transferId, {
          id: "outsider",
          role: "KUTUBXONACHI"
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects double-confirm (already CONFIRMED)", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue({
        ...pendingTransfer,
        status: "CONFIRMED"
      });

      const err = await service
        .confirmTransfer(sourceLibraryId, transferId, {
          id: directorId,
          role: "KUTUBXONACHI"
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/allaqachon/i);
    });

    it("rejects when libraryId does not match fromLibraryId", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(pendingTransfer);

      await expect(
        service.confirmTransfer("wrong-library", transferId, {
          id: directorId,
          role: "KUTUBXONACHI"
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("NotFoundException when transfer does not exist", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmTransfer(sourceLibraryId, transferId, {
          id: directorId,
          role: "KUTUBXONACHI"
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("availableCount increment uses atomic { increment: 1 } not read-then-write", async () => {
      runInteractiveTransaction();
      mockPrisma.bookTransfer.findUnique.mockResolvedValue(pendingTransfer);
      mockPrisma.bookTransfer.update.mockResolvedValue({ ...pendingTransfer, status: "CONFIRMED" });
      mockPrisma.book.update.mockResolvedValue({ id: bookId });

      await service.confirmTransfer(sourceLibraryId, transferId, {
        id: directorId,
        role: "KUTUBXONACHI"
      });

      // Cross-check: book.update was the atomic-increment variant, no
      // findUnique → arithmetic → update sequence.
      const bookUpdateCall = mockPrisma.book.update.mock.calls[0][0] as {
        data: { availableCount: unknown };
      };
      expect(bookUpdateCall.data.availableCount).toEqual({ increment: 1 });
    });
  });

  // ── findNearby ────────────────────────────────────────────────────────────
  describe("findNearby", () => {
    it("yaqin kutubxonalarni masofaga qarab tartiblaydi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { ...mockActiveLib, id: "lib1", latitude: 40.1391, longitude: 65.3694 },
        { ...mockActiveLib, id: "lib2", latitude: 41.2995, longitude: 69.2401 } // Toshkent
      ]);

      const result = await service.findNearby(40.1390, 65.3695, 10);
      expect(result[0].id).toBe("lib1");
      expect(result[0].distanceKm).toBeLessThan(1);
    });

    it("radius tashqarisidagi kutubxonalarni chiqarmaydi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { ...mockActiveLib, latitude: 41.2995, longitude: 69.2401 } // ~300km uzoq
      ]);

      const result = await service.findNearby(40.1390, 65.3695, 10);
      expect(result).toHaveLength(0);
    });
  });
});
