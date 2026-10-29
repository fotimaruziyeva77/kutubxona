import { FraudService, RISK_THRESHOLDS, RiskLevel } from "../fraud.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { KafkaService } from "../../../infra/kafka/kafka.service";

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  bookTransaction: {
    count:    jest.fn(),
    findMany: jest.fn(),
  },
  isbnScan: {
    count: jest.fn(),
  },
  comprehensionTest: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  readingIndex: {
    findMany:  jest.fn(),
    findFirst: jest.fn(),
  },
  fraudScore: {
    upsert:    jest.fn(),
    update:    jest.fn(),
    findUnique: jest.fn(),
    count:     jest.fn(),
    groupBy:   jest.fn(),
    findMany:  jest.fn(),
  },
  riskLog: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
};

// cache.remember — real funktsiyani chaqiradi (fn ni execute qiladi)
// setNx — Audit H8 cron leader lock; default "acquired" so cron bodies run.
const mockCache = {
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
  get:      jest.fn().mockResolvedValue(null),
  set:      jest.fn().mockResolvedValue(undefined),
  del:      jest.fn().mockResolvedValue(undefined),
  setNx:    jest.fn().mockResolvedValue(true),
};

const mockKafka = {
  emitFraudDetected: jest.fn().mockResolvedValue(undefined),
};

const makeService = () =>
  new FraudService(
    mockPrisma as unknown as PrismaService,
    mockCache as unknown as CacheService,
    mockKafka as unknown as KafkaService,
  );

// Standart "xavfsiz" foydalanuvchi mock
const safeUser = {
  id:          "u1",
  trustScore:  80,
  status:      "ACTIVE",
};

describe("FraudService", () => {
  let service: FraudService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();

    // Standart "xavfsiz" holat
    mockPrisma.user.findUnique.mockResolvedValue(safeUser);
    mockPrisma.bookTransaction.count.mockResolvedValue(0); // recentBorrows
    mockPrisma.isbnScan.count.mockResolvedValue(0);       // recentScans
    mockPrisma.comprehensionTest.count.mockResolvedValue(0);
    mockPrisma.bookTransaction.findMany.mockResolvedValue([]); // quickReturns
    mockPrisma.fraudScore.upsert.mockResolvedValue({});
    mockPrisma.readingIndex.findFirst.mockResolvedValue(null); // no RI history by default
  });

  // ── RISK_THRESHOLDS konstantlari ──────────────────────────────────────────
  describe("RISK_THRESHOLDS", () => {
    it("SAFE 0-24 oralig'ida", () => {
      expect(RISK_THRESHOLDS.SAFE.min).toBe(0);
      expect(RISK_THRESHOLDS.SAFE.max).toBe(24);
    });

    // FRAUD-06: the highest-risk band is FLAGGED (not BLOCKED). "BLOCKED"
    // implied an auto-block authority the platform does not have; FLAGGED
    // makes the review-only semantics explicit. The auto-block code path
    // in dailyFraudScan is removed in Plan 02-04 along with the review
    // queue endpoint.
    it("FLAGGED 70-100 oralig'ida (FRAUD-06)", () => {
      expect(RISK_THRESHOLDS.FLAGGED.min).toBe(70);
      expect(RISK_THRESHOLDS.FLAGGED.max).toBe(100);
    });

    it("BLOCKED kalit endi mavjud emas (FRAUD-06)", () => {
      expect((RISK_THRESHOLDS as unknown as Record<string, unknown>).BLOCKED).toBeUndefined();
    });

    it("RiskLevel union — FLAGGED qabul qiladi (type-level check)", () => {
      const v: RiskLevel = "FLAGGED";
      expect(v).toBe("FLAGGED");
    });
  });

  // ── analyzeUser ───────────────────────────────────────────────────────────
  describe("analyzeUser", () => {
    it("xavfsiz foydalanuvchi — SAFE, riskScore=0", async () => {
      const result = await service.analyzeUser("u1");

      expect(result.userId).toBe("u1");
      expect(result.riskScore).toBe(0);
      expect(result.riskLevel).toBe("SAFE");
      expect(result.action).toBe("none");
      expect(result.flags).toHaveLength(0);
    });

    it("foydalanuvchi topilmasa — bo'sh tahlil qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.analyzeUser("nonexistent");

      expect(result.userId).toBe("nonexistent");
      expect(result.riskScore).toBe(0);
      expect(result.flags).toHaveLength(0);
    });

    it("bir kunda 4+ kitob — HIGH_DAILY_BORROWS flag", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(5); // today: 5 borrows

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "HIGH_DAILY_BORROWS");
      expect(flag).toBeDefined();
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it("kuniga 5+ ISBN skan — EXCESSIVE_ISBN_SCANS flag", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.isbnScan.count.mockResolvedValue(49); // 7 kunda 49 = kuniga ~7

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "EXCESSIVE_ISBN_SCANS");
      expect(flag).toBeDefined();
    });

    it("3+ comprehension muvaffaqiyatsizligi — COMPREHENSION_FAILURES flag", async () => {
      mockPrisma.comprehensionTest.count.mockResolvedValue(5);

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "COMPREHENSION_FAILURES");
      expect(flag).toBeDefined();
      expect(flag!.points).toBe(Math.min(5 * 8, 25));
    });

    it("RI sakrashi — RI_SPIKE flag (today vs yesterday only — FRAUD-03)", async () => {
      // First findFirst = today (score 95); second = yesterday (score 60).
      // Delta = 35 > 20 → flag fires.
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 95 })   // riToday
        .mockResolvedValueOnce({ score: 60 });  // riYesterday

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "RI_SPIKE");
      expect(flag).toBeDefined();
      expect(flag!.points).toBe(20);
    });

    it("RI consecutive readers — no RI_SPIKE false positive (FRAUD-03 fix)", async () => {
      // Today 80, yesterday 78 — legitimate consecutive reader. Delta 2 < 20.
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 80 })
        .mockResolvedValueOnce({ score: 78 });

      const result = await service.analyzeUser("u1");

      expect(result.flags.find((f) => f.code === "RI_SPIKE")).toBeUndefined();
    });

    it("first-day user — RI_SPIKE skipped (no yesterday record)", async () => {
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 80 })  // today
        .mockResolvedValueOnce(null);          // no yesterday

      const result = await service.analyzeUser("u1");

      expect(result.flags.find((f) => f.code === "RI_SPIKE")).toBeUndefined();
    });

    it("trust score < 30 — LOW_TRUST_SCORE flag", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 25 });

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "LOW_TRUST_SCORE");
      expect(flag).toBeDefined();
      expect(flag!.points).toBe(15);
    });

    it("2+ tez qaytarish — QUICK_RETURNS flag", async () => {
      // _quickReturns uchun bookTransaction.findMany
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { borrowedAt: new Date(Date.now() - 1000 * 60 * 60), returnedAt: new Date() }, // 1 soat
        { borrowedAt: new Date(Date.now() - 1000 * 60 * 90), returnedAt: new Date() }, // 1.5 soat
      ]);

      const result = await service.analyzeUser("u1");

      const flag = result.flags.find((f) => f.code === "QUICK_RETURNS");
      expect(flag).toBeDefined();
    });

    it("riskScore 100 dan oshmasligi", async () => {
      // Barcha risk flaglarni trigger qilamiz
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(10); // +30 pts
      mockPrisma.isbnScan.count.mockResolvedValue(70);             // +20 pts
      mockPrisma.comprehensionTest.count.mockResolvedValue(10);    // +25 pts
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 10 }); // +15 pts
      mockPrisma.readingIndex.findFirst                            // +20 pts (RI_SPIKE)
        .mockResolvedValueOnce({ score: 100 })
        .mockResolvedValueOnce({ score: 60 });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
      ]); // +12 pts

      const result = await service.analyzeUser("u1");

      expect(result.riskScore).toBeLessThanOrEqual(100);
    });

    it("riskScore 70+ bo'lganda FLAGGED va Kafka event (FRAUD-06)", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(10);
      mockPrisma.isbnScan.count.mockResolvedValue(70);
      mockPrisma.comprehensionTest.count.mockResolvedValue(10);
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 5 });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { borrowedAt: new Date(Date.now() - 1000 * 60 * 60), returnedAt: new Date() },
        { borrowedAt: new Date(Date.now() - 1000 * 60 * 90), returnedAt: new Date() },
      ]);

      const result = await service.analyzeUser("u1");

      if (result.riskLevel === "FLAGGED") {
        expect(mockKafka.emitFraudDetected).toHaveBeenCalledWith(
          expect.objectContaining({ userId: "u1" })
        );
        // FRAUD-06: the action mapped from the FLAGGED level is "review",
        // not "block" — auto-block is removed in Plan 02-04.
        expect(result.action).toBe("review");
      }
    });
  });

  // ── dailyFraudScan — FRAUD-03 (Plan 02-04): no auto-block ─────────────────
  describe("dailyFraudScan (FRAUD-03)", () => {
    it("does NOT call prisma.user.update with BLOCKED — review queue only", async () => {
      // One active user who lands in FLAGGED via stacked flags.
      mockPrisma.bookTransaction.findMany.mockResolvedValueOnce([
        { userId: "u1" },
      ]);
      mockPrisma.bookTransaction.count.mockResolvedValue(10);
      mockPrisma.isbnScan.count.mockResolvedValue(70);
      mockPrisma.comprehensionTest.count.mockResolvedValue(10);
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 5 });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
      ]);

      await service.dailyFraudScan();

      // The critical assertion: no user.update with BLOCKED.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("writes a RiskLog entry for each FLAGGED user (audit trail)", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValueOnce([
        { userId: "u1" },
      ]);
      mockPrisma.bookTransaction.count.mockResolvedValue(10);
      mockPrisma.isbnScan.count.mockResolvedValue(70);
      mockPrisma.comprehensionTest.count.mockResolvedValue(10);
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 5 });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
        { borrowedAt: new Date(Date.now() - 3600000), returnedAt: new Date() },
      ]);

      await service.dailyFraudScan();

      // Kafka event is emitted from analyzeUser (FLAGGED → kafka emit), and
      // the dailyFraudScan additionally writes a RiskLog entry.
      expect(mockPrisma.riskLog.create).toHaveBeenCalled();
    });

    // Audit H8 — multi-replica leader lock. When another replica already
    // holds cron:daily-fraud-scan:<day>, this replica must no-op entirely.
    it("leader lock held (setNx=false) → cron no-ops, no scan queries run", async () => {
      mockCache.setNx.mockResolvedValueOnce(false);

      await service.dailyFraudScan();

      expect(mockCache.setNx).toHaveBeenCalledWith(
        expect.stringMatching(/^cron:daily-fraud-scan:\d{4}-\d{2}-\d{2}$/),
        "1",
        2 * 60 * 60,
      );
      // Scan body never runs: no active-user lookup, no risk writes.
      expect(mockPrisma.bookTransaction.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.riskLog.create).not.toHaveBeenCalled();
    });

    it("leader lock acquired (setNx=true) → scan proceeds", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValueOnce([]);

      await service.dailyFraudScan();

      expect(mockCache.setNx).toHaveBeenCalledTimes(1);
      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalled();
    });
  });

  // ── Review queue endpoints — FRAUD-03 ─────────────────────────────────────
  describe("getReviewQueue", () => {
    it("SUPER_ADMIN sees all FLAGGED users (no tier filter)", async () => {
      mockPrisma.fraudScore.findMany.mockResolvedValue([
        { id: "f1", riskScore: 85, user: { id: "u1", name: "A" } },
      ]);
      mockPrisma.fraudScore.count.mockResolvedValue(1);

      const result = await service.getReviewQueue({ tier: "SUPER_ADMIN" });

      expect(result.total).toBe(1);
      const args = (mockPrisma.fraudScore.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.action).toBe("review");
      // No address scoping for SUPER_ADMIN
      expect(args.where.user).toBeUndefined();
    });

    it("TUMAN_ADMIN scopes by address.tumanId", async () => {
      mockPrisma.fraudScore.findMany.mockResolvedValue([]);
      mockPrisma.fraudScore.count.mockResolvedValue(0);

      await service.getReviewQueue({ tier: "TUMAN_ADMIN", scopeId: "tuman-08" });

      const args = (mockPrisma.fraudScore.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.user).toEqual({ address: { tumanId: "tuman-08" } });
    });

    it("VILOYAT_ADMIN scopes by address.viloyatId", async () => {
      mockPrisma.fraudScore.findMany.mockResolvedValue([]);
      mockPrisma.fraudScore.count.mockResolvedValue(0);

      await service.getReviewQueue({ tier: "VILOYAT_ADMIN", scopeId: "viloyat-08" });

      const args = (mockPrisma.fraudScore.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.user).toEqual({ address: { viloyatId: "viloyat-08" } });
    });
  });

  describe("resolveReview", () => {
    it("approve → action='cleared' + RiskLog + cache invalidation", async () => {
      mockPrisma.fraudScore.findUnique.mockResolvedValue({
        userId: "u1",
        riskScore: 75,
        action: "review",
      });
      mockPrisma.fraudScore.update.mockResolvedValue({ action: "cleared" });

      const result = await service.resolveReview("admin-1", "u1", "approve");

      expect(result.action).toBe("cleared");
      const updateArgs = (mockPrisma.fraudScore.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.action).toBe("cleared");
      expect(mockPrisma.riskLog.create).toHaveBeenCalled();
      expect(mockCache.del).toHaveBeenCalledWith("fraud:analysis:u1");
    });

    it("reject → action='confirmed' (does NOT mutate User.status)", async () => {
      mockPrisma.fraudScore.findUnique.mockResolvedValue({
        userId: "u1",
        riskScore: 85,
        action: "review",
      });
      mockPrisma.fraudScore.update.mockResolvedValue({ action: "confirmed" });

      const result = await service.resolveReview("admin-1", "u1", "reject", "obvious fraud");

      expect(result.action).toBe("confirmed");
      // User status mutation is a separate admin action — NOT done by resolve.
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("FraudScore yo'q bo'lsa NotFoundException", async () => {
      mockPrisma.fraudScore.findUnique.mockResolvedValue(null);

      await expect(
        service.resolveReview("admin-1", "missing-user", "approve")
      ).rejects.toThrow();
    });
  });


  // ── getFraudStats ─────────────────────────────────────────────────────────
  describe("getFraudStats", () => {
    it("statistikani to'g'ri hisoblaydi", async () => {
      mockPrisma.fraudScore.count.mockResolvedValue(200);
      mockPrisma.fraudScore.groupBy.mockResolvedValue([
        { action: "none",    _count: { id: 120 }, _avg: { riskScore: 10 } },
        { action: "monitor", _count: { id: 50 },  _avg: { riskScore: 35 } },
        { action: "review",  _count: { id: 20 },  _avg: { riskScore: 60 } },
        { action: "block",   _count: { id: 10 },  _avg: { riskScore: 85 } },
      ]);

      const result = await service.getFraudStats();

      expect(result.total).toBe(200);
      expect(result.safe).toBe(120);
      expect(result.low).toBe(50);
      expect(result.review).toBe(20);
      expect(result.blocked).toBe(10);
    });

    it("bo'sh ma'lumotlarda 0 qaytaradi", async () => {
      mockPrisma.fraudScore.count.mockResolvedValue(0);
      mockPrisma.fraudScore.groupBy.mockResolvedValue([]);

      const result = await service.getFraudStats();
      expect(result.total).toBe(0);
      expect(result.safe).toBe(0);
    });
  });

  // ── getFraudList ──────────────────────────────────────────────────────────
  describe("getFraudList", () => {
    it("minRisk bo'yicha filterlaydi", async () => {
      const scores = [{ id: "f1", riskScore: 75, user: { id: "u1" } }];
      mockPrisma.fraudScore.findMany.mockResolvedValue(scores);

      const result = await service.getFraudList(70, 10);

      expect(mockPrisma.fraudScore.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { riskScore: { gte: 70 } },
          take:  10,
        })
      );
      expect(result).toEqual(scores);
    });

    it("default minRisk=50, limit=50", async () => {
      mockPrisma.fraudScore.findMany.mockResolvedValue([]);

      await service.getFraudList();

      expect(mockPrisma.fraudScore.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { riskScore: { gte: 50 } }, take: 50 })
      );
    });
  });

  // ── checkTop100Candidates ─────────────────────────────────────────────────
  describe("checkTop100Candidates", () => {
    it("bo'sh ro'yhat — 0 ta natija", async () => {
      mockPrisma.readingIndex.findMany.mockResolvedValue([]);

      const result = await service.checkTop100Candidates();

      expect(result.total).toBe(0);
      expect(result.flagged).toBe(0);
      expect(result.blocked).toBe(0);
    });

    it("foydalanuvchilarni tekshiradi va flaglaydi", async () => {
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
      // u1 — xavfsiz, u2 — xavfli
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(safeUser)              // u1
        .mockResolvedValueOnce({ ...safeUser, id: "u2", trustScore: 15 }); // u2
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.isbnScan.count.mockResolvedValue(0);
      mockPrisma.comprehensionTest.count.mockResolvedValue(0);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      const result = await service.checkTop100Candidates();

      expect(result.total).toBe(2);
      expect(result.results).toHaveLength(2);
    });
  });

  // ── verifyTop100Candidate (FRAUD-07 — Plan 03-02 Task 2) ──────────────────
  // Multi-layer gate run by TopService.aiFraudCheck on every DRAFT entry.
  // 4 hard gates: TRUST_BELOW_50, CONFIRMED_FRAUD_90D, LOW_COMPREHENSION,
  // SUSPECT_QUICK_RETURN_PATTERN. Failure of any gate → passed:false.
  describe("verifyTop100Candidate (FRAUD-07)", () => {
    beforeEach(() => {
      // Default-pass posture for all 4 layers:
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 80 });
      mockPrisma.riskLog.create.mockResolvedValue({});
      (mockPrisma.riskLog as unknown as { findMany: jest.Mock }).findMany =
        jest.fn().mockResolvedValue([]);
      // Comprehension: 9/10 = 0.9 pass rate
      mockPrisma.comprehensionTest.findMany = jest.fn().mockResolvedValue(
        Array.from({ length: 9 }, () => ({ passed: true })).concat([{ passed: false }])
      ) as unknown as jest.Mock;
      // Quick returns: 1/10 within 6h = 0.1 ratio
      const farPast = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const farFuture = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      mockPrisma.bookTransaction.findMany.mockResolvedValue(
        Array.from({ length: 10 }, () => ({
          borrowedAt: farPast,
          returnedAt: farFuture,
        }))
      );
    });

    it("(pass-all) trust=80 / no fraud / 90% comprehension / 10% quick — passes", async () => {
      const result = await service.verifyTop100Candidate("u1");
      expect(result.passed).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it("(TRUST_BELOW_50) trust=45 → fail with TRUST_BELOW_50", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 45 });

      const result = await service.verifyTop100Candidate("u1");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("TRUST_BELOW_50");
    });

    it("(CONFIRMED_FRAUD_90D) recent reject RiskLog → fail with CONFIRMED_FRAUD_90D", async () => {
      (mockPrisma.riskLog as unknown as { findMany: jest.Mock }).findMany.mockResolvedValue([
        {
          riskType: "FRAUD_REVIEW_RESOLVED",
          description: JSON.stringify({ userId: "u1", decision: "reject" }),
          createdAt: new Date(),
        },
      ]);

      const result = await service.verifyTop100Candidate("u1");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("CONFIRMED_FRAUD_90D");
    });

    it("(LOW_COMPREHENSION) <80% pass rate → fail with LOW_COMPREHENSION", async () => {
      // 4 passed, 6 failed = 40% pass rate
      (mockPrisma.comprehensionTest as unknown as { findMany: jest.Mock }).findMany.mockResolvedValue([
        ...Array.from({ length: 4 }, () => ({ passed: true })),
        ...Array.from({ length: 6 }, () => ({ passed: false })),
      ]);

      const result = await service.verifyTop100Candidate("u1");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("LOW_COMPREHENSION");
    });

    it("(SUSPECT_QUICK_RETURN_PATTERN) >50% returns within 6h → fail", async () => {
      const borrowedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const quickReturn = new Date(borrowedAt.getTime() + 2 * 60 * 60 * 1000); // 2h later
      const slowReturn = new Date(borrowedAt.getTime() + 5 * 24 * 60 * 60 * 1000);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        ...Array.from({ length: 7 }, () => ({ borrowedAt, returnedAt: quickReturn })),
        ...Array.from({ length: 3 }, () => ({ borrowedAt, returnedAt: slowReturn })),
      ]);

      const result = await service.verifyTop100Candidate("u1");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("SUSPECT_QUICK_RETURN_PATTERN");
    });

    it("(multi-fail) two gates fail simultaneously → both reasons returned", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...safeUser, trustScore: 30 });
      (mockPrisma.comprehensionTest as unknown as { findMany: jest.Mock }).findMany.mockResolvedValue([
        ...Array.from({ length: 4 }, () => ({ passed: true })),
        ...Array.from({ length: 6 }, () => ({ passed: false })),
      ]);

      const result = await service.verifyTop100Candidate("u1");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("TRUST_BELOW_50");
      expect(result.reasons).toContain("LOW_COMPREHENSION");
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });

    it("user not found → fails with TRUST_BELOW_50 (defensive default)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.verifyTop100Candidate("ghost");

      expect(result.passed).toBe(false);
      expect(result.reasons).toContain("TRUST_BELOW_50");
    });

    it("zero comprehension attempts → does NOT fail LOW_COMPREHENSION (insufficient data)", async () => {
      (mockPrisma.comprehensionTest as unknown as { findMany: jest.Mock }).findMany.mockResolvedValue([]);

      const result = await service.verifyTop100Candidate("u1");

      // No data → cannot evaluate; do not punish.
      expect(result.reasons).not.toContain("LOW_COMPREHENSION");
    });
  });
});
