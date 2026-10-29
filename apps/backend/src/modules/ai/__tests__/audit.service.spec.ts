import { AuditService } from "../audit.service";
import { Severity } from "@prisma/client";
import { ALERT_TYPES } from "../../../common/constants/alert-types.const";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const makeMockPrisma = () => ({
  readingIndex: {
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  library: {
    findMany: jest.fn(),
  },
  club: {
    findMany: jest.fn(),
  },
  bookTransaction: {
    groupBy: jest.fn(),
  },
  book: {
    findUnique: jest.fn(),
  },
  aiAuditLog: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $queryRaw: jest.fn(),
});

const makeMockReplica = () => ({
  readingIndex: {
    groupBy: jest.fn().mockResolvedValue([]),
    findMany: jest.fn().mockResolvedValue([]),
  },
  library: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  club: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  bookTransaction: {
    groupBy: jest.fn().mockResolvedValue([]),
  },
  book: {
    findUnique: jest.fn(),
  },
  aiAuditLog: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
  // Plan 05-05 T1 — _buildTumanRiMap + _checkInactiveTumans both use
  // replica.$queryRaw. Returns empty for "no-issue" default state.
  $queryRaw: jest.fn().mockResolvedValue([]),
});

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
  // Audit H8 — cron leader lock; default "acquired" so runAuditCycle bodies run.
  setNx: jest.fn().mockResolvedValue(true),
};

const mockKafka = {
  emitTumanRiDropped: jest.fn().mockResolvedValue(undefined),
};

const mockGateway = {
  emitNewAlert: jest.fn(),
  emitAlertResolved: jest.fn(),
};

// ── Helper factories ───────────────────────────────────────────────────────────

let mockPrisma: ReturnType<typeof makeMockPrisma>;
let mockReplica: ReturnType<typeof makeMockReplica>;

function makeService(): AuditService {
  return new AuditService(
    mockPrisma as any,
    mockCache as any,
    mockKafka as any,
    mockGateway as any,
    mockReplica as any,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AuditService", () => {
  let service: AuditService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma = makeMockPrisma();
    mockReplica = makeMockReplica();
    service = makeService();
  });

  // ── getAuditLogs ────────────────────────────────────────────────────────────

  describe("getAuditLogs", () => {
    it("returns cached audit logs with no filters", async () => {
      const logs = [{ id: "log-1", issueType: ALERT_TYPES.RI_DROPPED }];
      mockReplica.aiAuditLog.findMany.mockResolvedValue(logs);

      const result = await service.getAuditLogs({});

      expect(result).toEqual(logs);
      expect(mockCache.remember).toHaveBeenCalled();
      expect(mockReplica.aiAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: "desc" }, take: 100 })
      );
    });

    it("applies scope filter", async () => {
      mockReplica.aiAuditLog.findMany.mockResolvedValue([]);

      await service.getAuditLogs({ scope: "TUMAN" });

      expect(mockReplica.aiAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ scope: "TUMAN" }) })
      );
    });

    it("applies severity filter", async () => {
      mockReplica.aiAuditLog.findMany.mockResolvedValue([]);

      await service.getAuditLogs({ severity: "CRITICAL" });

      expect(mockReplica.aiAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ severity: "CRITICAL" }) })
      );
    });

    it("applies resolved filter", async () => {
      mockReplica.aiAuditLog.findMany.mockResolvedValue([]);

      await service.getAuditLogs({ resolved: false });

      expect(mockReplica.aiAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ resolved: false }) })
      );
    });

    it("respects custom limit", async () => {
      mockReplica.aiAuditLog.findMany.mockResolvedValue([]);

      await service.getAuditLogs({ limit: 50 });

      expect(mockReplica.aiAuditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 })
      );
    });
  });

  // ── resolveAuditLog ─────────────────────────────────────────────────────────

  describe("resolveAuditLog", () => {
    it("updates log resolved=true, clears cache, emits gateway event", async () => {
      const updated = { id: "log-1", resolved: true };
      mockPrisma.aiAuditLog.update.mockResolvedValue(updated);

      const result = await service.resolveAuditLog("log-1");

      expect(mockPrisma.aiAuditLog.update).toHaveBeenCalledWith({
        where: { id: "log-1" },
        data: { resolved: true },
      });
      expect(mockCache.del).toHaveBeenCalledWith("audit:logs:*");
      expect(mockGateway.emitAlertResolved).toHaveBeenCalledWith("log-1");
      expect(result).toEqual(updated);
    });
  });

  // ── runAuditCycle ───────────────────────────────────────────────────────────

  describe("runAuditCycle", () => {
    beforeEach(() => {
      // Defaults — no issues found anywhere
      mockReplica.library.findMany.mockResolvedValue([]);
      mockReplica.club.findMany.mockResolvedValue([]);
      mockReplica.bookTransaction.groupBy.mockResolvedValue([]);
      mockReplica.$queryRaw.mockResolvedValue([]);
    });

    it("runs without throwing when no issues are found", async () => {
      await expect(service.runAuditCycle()).resolves.toBeUndefined();
    });

    it("persists a CRITICAL RI drop and emits kafka + gateway events", async () => {
      // _buildTumanRiMap (1st $queryRaw call) returns one tuman with big drop.
      // _checkInactiveTumans (2nd $queryRaw call) returns empty.
      mockReplica.$queryRaw
        .mockResolvedValueOnce([
          { tumanId: "tuman-1", tuman_name: "Karmana", current_ri: 40, previous_ri: 80 },
        ])
        .mockResolvedValueOnce([]);

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-new",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockKafka.emitTumanRiDropped).toHaveBeenCalled();
      expect(mockGateway.emitNewAlert).toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalled();
    });

    it("persists a WARNING RI drop (10-20%)", async () => {
      mockReplica.$queryRaw
        .mockResolvedValueOnce([
          { tumanId: "tuman-2", tuman_name: "T2", current_ri: 72, previous_ri: 80 },
        ])
        .mockResolvedValueOnce([]);

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-warn",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalled();
    });

    it("skips persisting if same issue already logged today", async () => {
      mockReplica.$queryRaw
        .mockResolvedValueOnce([
          { tumanId: "tuman-3", tuman_name: "T3", current_ri: 40, previous_ri: 80 },
        ])
        .mockResolvedValueOnce([]);

      // Existing log found → should skip
      mockPrisma.aiAuditLog.findFirst.mockResolvedValue({ id: "existing-log" });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(mockGateway.emitNewAlert).not.toHaveBeenCalled();
    });

    it("creates CRITICAL alert for inactive library", async () => {
      mockReplica.library.findMany.mockResolvedValue([
        { id: "lib-1", name: "Test kutubxona", type: "GOV", transactions: [] },
      ]);

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-lib",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.LIBRARY_INACTIVE }),
        })
      );
    });

    it("skips active libraries that have transactions", async () => {
      mockReplica.library.findMany.mockResolvedValue([
        { id: "lib-2", name: "Faol kutubxona", type: "GOV", transactions: [{ id: "tx-1" }] },
      ]);

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.LIBRARY_INACTIVE }),
        })
      );
    });

    it("creates WARNING alert for inactive club", async () => {
      mockReplica.club.findMany.mockResolvedValue([
        {
          id: "club-1",
          name: "Jadidlar izidan",
          institutionId: "school-1",
          debates: [],
          _count: { members: 12 },
        },
      ]);

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-club",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.CLUB_INACTIVE }),
        })
      );
    });

    it("skips clubs that have recent debates", async () => {
      mockReplica.club.findMany.mockResolvedValue([
        {
          id: "club-2",
          name: "Faol klub",
          institutionId: "school-2",
          debates: [{ id: "debate-1" }],
          _count: { members: 8 },
        },
      ]);

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.CLUB_INACTIVE }),
        })
      );
    });

    it("creates FUND_SHORTAGE warning for hot books with 0 availability (ALERT-03)", async () => {
      mockReplica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-1", _count: { bookId: 80 } },
      ]);
      mockReplica.book.findUnique.mockResolvedValue({
        id: "book-1",
        title: "Alpomish",
        author: "Xalq",
        availableCount: 0, // Plan 05-05 T1 — must be exactly 0 now
        library: { name: "Tuman kutubxonasi" },
      });

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-fund",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.FUND_SHORTAGE }),
        })
      );
    });

    it("skips books with sufficient availability (> 0) — ALERT-03 strict zero", async () => {
      mockReplica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-2", _count: { bookId: 80 } },
      ]);
      mockReplica.book.findUnique.mockResolvedValue({
        id: "book-2",
        title: "Kitob",
        author: "Muallif",
        availableCount: 5,
        library: { name: "Kutubxona" },
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: ALERT_TYPES.FUND_SHORTAGE }),
        })
      );
    });

    it("skips book if findUnique returns null", async () => {
      mockReplica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-ghost", _count: { bookId: 80 } },
      ]);
      mockReplica.book.findUnique.mockResolvedValue(null);

      await expect(service.runAuditCycle()).resolves.toBeUndefined();
    });

    it("uses fallback scopeId when library name is null", async () => {
      mockReplica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-3", _count: { bookId: 80 } },
      ]);
      mockReplica.book.findUnique.mockResolvedValue({
        id: "book-3",
        title: "Kitob 3",
        author: "Muallif",
        availableCount: 0,
        library: null,
      });

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-3",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scopeId: "book-3" }),
        })
      );
    });

    it("maps CRITICAL severity to CRITICAL in DB", async () => {
      mockReplica.library.findMany.mockResolvedValue([
        { id: "lib-3", name: "Ta'mirdagi kutubxona", type: "GOV", transactions: [] },
      ]);

      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "log-sev",
        createdAt: new Date(),
      });

      await service.runAuditCycle();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ severity: Severity.CRITICAL }),
        })
      );
    });

    it("skips tuman with previous RI = 0", async () => {
      mockReplica.$queryRaw
        .mockResolvedValueOnce([
          { tumanId: "tuman-zero", tuman_name: "TZ", current_ri: 50, previous_ri: 0 },
        ])
        .mockResolvedValueOnce([]);

      await service.runAuditCycle();

      expect(mockKafka.emitTumanRiDropped).not.toHaveBeenCalled();
    });

    it("skips rows with missing tumanId", async () => {
      // _buildTumanRiMap should drop rows where tumanId is null.
      mockReplica.$queryRaw
        .mockResolvedValueOnce([
          { tumanId: null, tuman_name: null, current_ri: 50, previous_ri: 80 },
        ])
        .mockResolvedValueOnce([]);

      await expect(service.runAuditCycle()).resolves.toBeUndefined();
    });
  });
});
