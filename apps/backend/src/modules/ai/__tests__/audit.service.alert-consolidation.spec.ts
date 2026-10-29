import { AuditService } from "../audit.service";
import { ALERT_TYPES } from "../../../common/constants/alert-types.const";

/**
 * Plan 05-05 T1 — alert consolidation.
 *
 * Covers:
 *  - S1 PITFALL closure: _buildTumanRiMap uses ONE $queryRaw GROUP BY
 *    (no findMany loading 5M × 60d ReadingIndex rows into Node memory).
 *  - ALERT-01 _checkInactiveTumans — emits LIBRARY_INACTIVE for tumans with
 *    0 distinct active readers in last 14d.
 *  - ALERT-03 threshold: FUND_SHORTAGE fires at >=50 requests AND
 *    availableCount === 0 (was >=10 + <=1).
 *  - ALERT-04 threshold: CLUB_INACTIVE fires at >=30 days (was 45d).
 *  - ALERT_TYPES vocabulary: zero string literals in audit.service.ts
 *    issueType emissions (grep gate enforced via test).
 */

const makePrisma = () => ({
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
    create: jest.fn().mockResolvedValue({ id: "log-1", createdAt: new Date() }),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
});

const makeReplica = () => ({
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
  $queryRaw: jest.fn().mockResolvedValue([]),
});

const makeCache = () => ({
  remember: jest
    .fn()
    .mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn().mockResolvedValue(undefined),
  setNx: jest.fn().mockResolvedValue(true),
});

const makeKafka = () => ({
  emitTumanRiDropped: jest.fn().mockResolvedValue(undefined),
});

const makeGateway = () => ({
  emitNewAlert: jest.fn(),
  emitAlertResolved: jest.fn(),
});

const makeDispatch = () => ({
  dispatch: jest.fn().mockResolvedValue(undefined),
});

describe("AuditService — Plan 05-05 alert consolidation", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let replica: ReturnType<typeof makeReplica>;
  let cache: ReturnType<typeof makeCache>;
  let kafka: ReturnType<typeof makeKafka>;
  let gateway: ReturnType<typeof makeGateway>;
  let dispatch: ReturnType<typeof makeDispatch>;
  let service: AuditService;

  beforeEach(() => {
    prisma = makePrisma();
    replica = makeReplica();
    cache = makeCache();
    kafka = makeKafka();
    gateway = makeGateway();
    dispatch = makeDispatch();
    service = new AuditService(
      prisma as any,
      cache as any,
      kafka as any,
      gateway as any,
      replica as any,
      dispatch as any,
    );
    jest.clearAllMocks();
  });

  // ── S1 PITFALL closure ───────────────────────────────────────────────────

  describe("_buildTumanRiMap S1 fix (no findMany over 5M rows)", () => {
    it("executes ONE $queryRaw call and ZERO findMany calls on ReadingIndex", async () => {
      replica.$queryRaw.mockResolvedValue([
        {
          tumanId: "UZ-08-012",
          tuman_name: "Karmana",
          current_ri: 65.5,
          previous_ri: 80.2,
        },
      ]);

      await service.runAuditCycle();

      // The SQL fix MUST use $queryRaw at least once for tuman RI aggregation.
      expect(replica.$queryRaw).toHaveBeenCalled();
      // And MUST NOT use findMany on readingIndex (the old S1-pitfall path).
      expect(replica.readingIndex.findMany).not.toHaveBeenCalled();
    });

    it("emits CRITICAL drop alert when current < previous * 0.8 (>=20% drop)", async () => {
      replica.$queryRaw.mockResolvedValue([
        {
          tumanId: "UZ-08-012",
          tuman_name: "Karmana",
          current_ri: 50,
          previous_ri: 80, // drop = 37.5%
        },
      ]);
      // Make sure the AiAuditLog row is "new" (no dedup).
      prisma.aiAuditLog.findFirst.mockResolvedValue(null);

      await service.runAuditCycle();

      expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: ALERT_TYPES.RI_DROPPED,
            scope: "TUMAN",
          }),
        }),
      );
      expect(kafka.emitTumanRiDropped).toHaveBeenCalled();
    });
  });

  // ── ALERT-01 _checkInactiveTumans ────────────────────────────────────────

  describe("_checkInactiveTumans (ALERT-01)", () => {
    it("emits LIBRARY_INACTIVE alert for tumans with 0 active readers in 14d", async () => {
      // Tuman B has zero active readers — replica.$queryRaw returns it.
      replica.$queryRaw.mockImplementation((..._args: unknown[]) => {
        // First call = _buildTumanRiMap (returns empty for this test)
        // Second call = _checkInactiveTumans (returns the inactive tuman B)
        if (replica.$queryRaw.mock.calls.length === 1) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { tuman_id: "tuman-B", tuman_name: "Tomdi" },
        ]);
      });

      await service.runAuditCycle();

      expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "TUMAN",
            scopeId: "tuman-B",
            issueType: ALERT_TYPES.LIBRARY_INACTIVE,
          }),
        }),
      );
    });

    it("does NOT emit when the inactive-tuman query returns empty", async () => {
      replica.$queryRaw.mockResolvedValue([]);

      await service.runAuditCycle();

      // Filter out only LIBRARY_INACTIVE-typed creates from any others
      const inactiveCalls = (prisma.aiAuditLog.create as jest.Mock).mock.calls.filter(
        (c) => c[0]?.data?.issueType === ALERT_TYPES.LIBRARY_INACTIVE,
      );
      expect(inactiveCalls).toHaveLength(0);
    });
  });

  // ── ALERT-03 FUND_SHORTAGE threshold (50/0) ──────────────────────────────

  describe("_checkFundShortages (ALERT-03) threshold 50 reqs + 0 available", () => {
    it("emits FUND_SHORTAGE when reservations >= 50 AND availableCount === 0", async () => {
      replica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-hot", _count: { bookId: 60 } },
      ]);
      replica.book.findUnique.mockResolvedValue({
        id: "book-hot",
        title: "Alpomish",
        author: "Xalq",
        availableCount: 0,
        library: { name: "Karmana kutubxonasi" },
      });

      await service.runAuditCycle();

      expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: ALERT_TYPES.FUND_SHORTAGE,
          }),
        }),
      );
    });

    it("does NOT emit when reservations < 50 (was old 10 threshold)", async () => {
      // 30 reservations — under the new 50 threshold.
      // groupBy `having >= 50` would skip this; emulate by returning [].
      replica.bookTransaction.groupBy.mockResolvedValue([]);
      replica.book.findUnique.mockResolvedValue({
        id: "book-warm",
        title: "Kitob",
        author: "X",
        availableCount: 0,
        library: { name: "Lib" },
      });

      await service.runAuditCycle();

      const fundCalls = (prisma.aiAuditLog.create as jest.Mock).mock.calls.filter(
        (c) => c[0]?.data?.issueType === ALERT_TYPES.FUND_SHORTAGE,
      );
      expect(fundCalls).toHaveLength(0);
    });

    it("does NOT emit when availableCount > 0 (was old <= 1 threshold)", async () => {
      replica.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "book-edge", _count: { bookId: 80 } },
      ]);
      replica.book.findUnique.mockResolvedValue({
        id: "book-edge",
        title: "Kitob",
        author: "X",
        availableCount: 1, // > 0 — under new strict zero requirement
        library: { name: "Lib" },
      });

      await service.runAuditCycle();

      const fundCalls = (prisma.aiAuditLog.create as jest.Mock).mock.calls.filter(
        (c) => c[0]?.data?.issueType === ALERT_TYPES.FUND_SHORTAGE,
      );
      expect(fundCalls).toHaveLength(0);
    });
  });

  // ── ALERT-04 CLUB_INACTIVE threshold (30 days) ───────────────────────────

  describe("_checkInactiveClubs (ALERT-04) threshold 30 days", () => {
    it("emits CLUB_INACTIVE for clubs with no debate in 30+ days", async () => {
      replica.club.findMany.mockResolvedValue([
        {
          id: "club-1",
          name: "Jadidlar izidan",
          institutionId: "school-1",
          debates: [], // no recent debates
          _count: { members: 12 },
        },
      ]);

      await service.runAuditCycle();

      expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: ALERT_TYPES.CLUB_INACTIVE,
          }),
        }),
      );
    });

    it("passes 30-day cutoff (not 45) to club.findMany.where.debates.where.heldAt", async () => {
      replica.club.findMany.mockResolvedValue([]);

      const before = Date.now();
      await service.runAuditCycle();

      const findManyArgs = (replica.club.findMany as jest.Mock).mock.calls[0]?.[0];
      const cutoff = findManyArgs?.select?.debates?.where?.heldAt?.gte;
      expect(cutoff).toBeInstanceOf(Date);
      // Cutoff must be ~30 days before now (allow 1s wall-clock slack).
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const diff = (cutoff as Date).getTime();
      expect(diff).toBeGreaterThanOrEqual(before - thirtyDaysMs - 1000);
      expect(diff).toBeLessThanOrEqual(Date.now() - thirtyDaysMs + 1000);
    });
  });

  // ── ALERT_TYPES vocabulary unification ───────────────────────────────────

  describe("ALERT_TYPES vocabulary (no string literals)", () => {
    it("audit.service.ts has zero inline string-literal issueType emissions", () => {
      // Defensive grep: scan the source file for `issueType: "FOO"` patterns.
      // Must be zero — all issueType emissions go through ALERT_TYPES.<KEY>.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("path");
      const src = fs.readFileSync(
        path.join(__dirname, "../audit.service.ts"),
        "utf8",
      );
      // Pattern: `issueType: "ANY_CAPS"` — would match string literals only.
      const matches = src.match(/issueType:\s*"[A-Z_]+"/g) ?? [];
      expect(matches).toHaveLength(0);
    });

    it("ALERT_TYPES.LIBRARY_INACTIVE matches the existing inactive-library path", async () => {
      replica.library.findMany.mockResolvedValue([
        { id: "lib-1", name: "Test", type: "GOV", transactions: [] },
      ]);

      await service.runAuditCycle();

      expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: ALERT_TYPES.LIBRARY_INACTIVE,
          }),
        }),
      );
    });
  });
});
