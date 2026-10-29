import { ReconciliationService } from "../reconciliation.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { StatsGateway } from "../../../infra/gateway/stats.gateway";
import { CacheService } from "../../../infra/cache/cache.service";

function buildMocks() {
  const mockPrisma = {
    library: { findMany: jest.fn() },
    book: {
      aggregate: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bookTransaction: {
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bookTransfer: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    aiAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const mockGateway = { emitNewAlert: jest.fn() };
  // Audit H8 — cron leader lock; default "acquired" so the cron body runs.
  const mockCache = { setNx: jest.fn().mockResolvedValue(true) };
  return { mockPrisma, mockGateway, mockCache };
}

describe("ReconciliationService", () => {
  let service: ReconciliationService;
  let mockPrisma: ReturnType<typeof buildMocks>["mockPrisma"];
  let mockGateway: ReturnType<typeof buildMocks>["mockGateway"];
  let mockCache: ReturnType<typeof buildMocks>["mockCache"];

  beforeEach(() => {
    const m = buildMocks();
    mockPrisma = m.mockPrisma;
    mockGateway = m.mockGateway;
    mockCache = m.mockCache;
    service = new ReconciliationService(
      mockPrisma as unknown as PrismaService,
      mockGateway as unknown as StatsGateway,
      mockCache as unknown as CacheService,
    );
    jest.clearAllMocks();
    mockPrisma.library.findMany.mockResolvedValue([]);
    mockPrisma.bookTransfer.findMany.mockResolvedValue([]);
    mockPrisma.aiAuditLog.create.mockResolvedValue({});
    mockCache.setNx.mockResolvedValue(true);
  });

  describe("reconcileInventory cron", () => {
    it("kelishuvga mos kelganda hech qanday alert yozmaydi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib1", name: "Karmana" },
      ]);
      mockPrisma.book.aggregate.mockResolvedValue({
        _sum: { totalCount: 100, availableCount: 95 },
      });
      mockPrisma.bookTransaction.count.mockResolvedValue(5); // BORROWED
      mockPrisma.bookTransfer.count.mockResolvedValue(0); // PENDING

      const result = await service.reconcileInventory();

      // expected = 100 - 5 - 0 = 95, actual = 95, 0% discrepancy → no alert
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(mockGateway.emitNewAlert).not.toHaveBeenCalled();
      expect(result!.alertsRaised).toBe(0);
    });

    // Audit H8 — multi-replica leader lock: non-leader replicas must no-op.
    it("leader lock held (setNx=false) → cron no-ops, no scan runs", async () => {
      mockCache.setNx.mockResolvedValueOnce(false);

      const result = await service.reconcileInventory();

      expect(result).toBeUndefined();
      expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("5% dan oshganda CRITICAL alert yozadi va gateway emit qiladi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib1", name: "Karmana" },
      ]);
      mockPrisma.book.aggregate.mockResolvedValue({
        _sum: { totalCount: 100, availableCount: 85 },
      });
      mockPrisma.bookTransaction.count.mockResolvedValue(5);
      mockPrisma.bookTransfer.count.mockResolvedValue(0);

      const result = await service.reconcileInventory();

      // expected = 100 - 5 - 0 = 95, actual = 85, discrepancy = 10/95 = 10.5%
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      expect(call.data.scope).toBe("KUTUBXONA");
      expect(call.data.scopeId).toBe("lib1");
      expect(call.data.issueType).toBe("INVENTORY_DISCREPANCY");
      expect(call.data.severity).toBe("CRITICAL");
      expect(mockGateway.emitNewAlert).toHaveBeenCalledTimes(1);
      expect(result!.alertsRaised).toBe(1);
    });

    it("PENDING BookTransfer ni expected_available hisobiga oladi (roaming carve-out)", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib1", name: "Karmana" },
      ]);
      mockPrisma.book.aggregate.mockResolvedValue({
        _sum: { totalCount: 100, availableCount: 92 },
      });
      mockPrisma.bookTransaction.count.mockResolvedValue(5);
      mockPrisma.bookTransfer.count.mockResolvedValue(3); // 3 in-flight

      const result = await service.reconcileInventory();

      // expected = 100 - 5 - 3 = 92, actual = 92, 0% → NO alert
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(result!.alertsRaised).toBe(0);
      // Verify the bookTransfer query was scoped to fromLibraryId + PENDING
      expect(mockPrisma.bookTransfer.count).toHaveBeenCalledWith({
        where: { fromLibraryId: "lib1", status: "PENDING" },
      });
    });

    it("kitob mavjud bo'lmagan kutubxonani o'tkazib yuboradi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib1", name: "Empty" },
      ]);
      mockPrisma.book.aggregate.mockResolvedValue({
        _sum: { totalCount: 0, availableCount: 0 },
      });
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.bookTransfer.count.mockResolvedValue(0);

      const result = await service.reconcileInventory();

      // expected = 0 → skip
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(result!.alertsRaised).toBe(0);
    });

    it("D-4: ALERT-ONLY — book.update va bookTransaction.update HECH qachon chaqirilmaydi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib1", name: "Karmana" },
      ]);
      mockPrisma.book.aggregate.mockResolvedValue({
        _sum: { totalCount: 100, availableCount: 80 }, // big discrepancy
      });
      mockPrisma.bookTransaction.count.mockResolvedValue(5);
      mockPrisma.bookTransfer.count.mockResolvedValue(0);

      await service.reconcileInventory();

      // The cron NEVER mutates inventory state. Detection only.
      expect(mockPrisma.book.update).not.toHaveBeenCalled();
      expect(mockPrisma.book.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookTransaction.update).not.toHaveBeenCalled();
      expect(mockPrisma.bookTransaction.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("flagStuckTransfers (R5)", () => {
    it("30+ kun PENDING transfer uchun WARNING alert yozadi", async () => {
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      mockPrisma.library.findMany.mockResolvedValue([]);
      mockPrisma.bookTransfer.findMany.mockResolvedValue([
        {
          id: "tr1",
          transactionId: "tx1",
          fromLibraryId: "libA",
          toLibraryId: "libB",
          requestedAt: oldDate,
        },
        {
          id: "tr2",
          transactionId: "tx2",
          fromLibraryId: "libC",
          toLibraryId: "libD",
          requestedAt: oldDate,
        },
      ]);

      const result = await service.reconcileInventory();

      // 2 stuck transfer rows → 2 audit log writes with STUCK_TRANSFER type
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledTimes(2);
      const calls = mockPrisma.aiAuditLog.create.mock.calls;
      expect(calls[0][0].data.issueType).toBe("STUCK_TRANSFER");
      // WARNING maps to MEDIUM (Prisma enum has no WARNING / INFO).
      expect(calls[0][0].data.severity).toBe("MEDIUM");
      expect(result!.stuckCount).toBe(2);
    });

    it("30 kun ichidagi PENDING transfer ni flag qilmaydi", async () => {
      mockPrisma.library.findMany.mockResolvedValue([]);
      // findMany returns [] because the WHERE filter excluded fresh ones
      mockPrisma.bookTransfer.findMany.mockResolvedValue([]);

      const result = await service.reconcileInventory();

      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(result!.stuckCount).toBe(0);
      // Verify the findMany WAS called with the 30-day cutoff predicate
      expect(mockPrisma.bookTransfer.findMany).toHaveBeenCalled();
      const args = mockPrisma.bookTransfer.findMany.mock.calls[0][0];
      expect(args.where.status).toBe("PENDING");
      expect(args.where.requestedAt.lt).toBeInstanceOf(Date);
    });
  });
});
