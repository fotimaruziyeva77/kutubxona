import { ReadingService } from "../reading.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany:   jest.fn().mockResolvedValue([]),
    count:      jest.fn().mockResolvedValue(0),
  },
  readingIndex: {
    findFirst: jest.fn(),
    findMany:  jest.fn(),
    create:    jest.fn()
  },
  bookTransaction: { findMany: jest.fn() },
  isbnScan:        { findMany: jest.fn().mockResolvedValue([]) },
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
};

const mockQueue = {
  addBulk: jest.fn().mockResolvedValue([])
} as unknown as Queue;

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined)
} as unknown as CacheService;

describe("ReadingService", () => {
  let service: ReadingService;

  beforeEach(() => {
    service = new ReadingService(
      mockPrisma as unknown as PrismaService,
      mockQueue,
      mockCache
    );
    jest.clearAllMocks();
    // Default: 'remember' just executes the supplied fetcher.
    (mockCache.remember as jest.Mock).mockImplementation(
      (_k: string, _t: number, fn: () => unknown) => fn()
    );
  });

  describe("getReadingIndex", () => {
    it("mavjud foydalanuvchi uchun oxirgi indeksni qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1" });
      mockPrisma.readingIndex.findFirst.mockResolvedValue({ userId: "u1", score: 72.5 });

      const result = await service.getReadingIndex("u1");

      expect(result).toEqual({ userId: "u1", score: 72.5 });
    });

    it("indeks yo'q bo'lsa default 0 qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1" });
      mockPrisma.readingIndex.findFirst.mockResolvedValue(null);

      const result = await service.getReadingIndex("u1");

      expect(result.score).toBe(0);
      expect(result.calculatedAt).toBeNull();
    });

    it("foydalanuvchi topilmasa NotFoundException tashlaydi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getReadingIndex("notfound"))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe("getHistory", () => {
    it("oxirgi 12 oy tarixini qaytaradi", async () => {
      const history = Array.from({ length: 5 }, (_, i) => ({
        userId: "u1",
        score: 60 + i,
        calculatedAt: new Date()
      }));
      mockPrisma.readingIndex.findMany.mockResolvedValue(history);

      const result = await service.getHistory("u1");

      expect(mockPrisma.readingIndex.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "u1" }, take: 12 })
      );
      expect(result).toHaveLength(5);
    });
  });

  describe("recalculateForUser", () => {
    it("hisoblangan score 0–100 oralig'ida bo'ladi", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.readingIndex.create.mockResolvedValue({ score: 0, components: {} });

      const result = await service.recalculateForUser("u1");

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("kitoblar bor bo'lsa score yuqori bo'ladi", async () => {
      const now = new Date();
      const borrowedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const returnedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { bookId: "b1", borrowedAt, returnedAt },
        { bookId: "b2", borrowedAt, returnedAt },
        { bookId: "b3", borrowedAt, returnedAt }
      ]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");

      expect(result.score).toBeGreaterThan(0);
    });

    it("muddati o'tgan kitob intizom ballini pasaytiradi", async () => {
      const borrowedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const returnedAt = new Date();

      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { bookId: "b1", borrowedAt, returnedAt, penaltyDays: 6, book: { genre: "Roman" } }
      ]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      expect(components.discipline).toBeLessThan(100);
    });

    // ── RI-02 / STORE-03: per-source coefficient sum ─────────────────────────
    it("applies per-source coefficient (RI-02 / STORE-03)", async () => {
      const now = new Date();
      const confirmedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      // One library transaction (RETURNED)
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        {
          bookId: "b1",
          borrowedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
          returnedAt: confirmedAt,
          penaltyDays: 0,
          book: { genre: "Roman" }
        }
      ]);

      // One scan of each non-library source (distinct isbns — C5 dedup
      // hisobga olinganda har biri alohida kredit).
      mockPrisma.isbnScan.findMany.mockResolvedValue([
        { source: "USER_SCAN", isbn: "978-x1", confirmedAt },
        { source: "STORE_MANUAL", isbn: "978-x2", confirmedAt },
        { source: "MUTOLAA", isbn: "978-x3", confirmedAt },
        { source: "EBOOK", isbn: "978-x4", confirmedAt }
      ]);

      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      // Sanity: counts surface per-source so downstream Top-100 fairness is auditable.
      expect(components.totalLibrary).toBe(1);
      expect(components.totalIsbn).toBe(4); // sum of all non-library sources

      // Per-source weighted sum: 1 lib (1.0) + 1 scan (0.9) + 1 store (0.9)
      //                        + 1 mutolaa (0.85) + 1 ebook (0.8) = 4.45
      // booksCount = min(4.45 * 10, 100) = 44.5 → rounded = 45
      expect(components.booksCount).toBe(45);
    });

    it("MUTOLAA-only user accrues 0.85x books-count (RI-02)", async () => {
      const now = new Date();
      const confirmedAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      // C5: ikki XIL isbn — distinct hisoblanadi (sync insert-guard tufayli
      // MUTOLAA qatorlari odatda allaqachon unique, lekin scoring baribir
      // distinct qoidasini qo'llaydi).
      mockPrisma.isbnScan.findMany.mockResolvedValue([
        { source: "MUTOLAA", isbn: "978-m1", confirmedAt },
        { source: "MUTOLAA", isbn: "978-m2", confirmedAt }
      ]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      // 2 distinct MUTOLAA isbn × 0.85 = 1.7 → booksCount = min(17, 100) = 17
      expect(components.booksCount).toBe(17);
    });

    // ── C5 (CRITICAL): duplicate-counting fix — DISTINCT bookId / isbn ──────
    // Avval `allTx.length * 1.0` edi: bitta kitobni 10 marta olib-qaytarish
    // booksCount ni 100 ga to'ldirardi (Top-100 mukofot fermasi).
    it("C5: bitta kitobni 10 marta qaytarish faqat 1 kitob krediti beradi", async () => {
      const now = new Date();
      const borrowedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      const returnedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      mockPrisma.bookTransaction.findMany.mockResolvedValue(
        Array.from({ length: 10 }, () => ({
          bookId: "b1",
          borrowedAt,
          returnedAt,
          penaltyDays: 0,
          book: { genre: "Roman" }
        }))
      );
      mockPrisma.isbnScan.findMany.mockResolvedValue([]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      // Avval: min(10 × 1.0 × 10, 100) = 100. Endi: DISTINCT bookId = 1 → 10.
      expect(components.booksCount).toBe(10);
      expect(components.totalLibrary).toBe(1);
      // Dedup FAQAT kitob kreditiga tegadi — faollik xom event asosida
      // qoladi (10 event → cap 100), intizom ham o'zgarmaydi.
      expect(components.activity).toBe(100);
      expect(components.discipline).toBe(100);
    });

    it("C5: 3 xil kitob → 3 kitob krediti (30 ball)", async () => {
      const now = new Date();
      const borrowedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const returnedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman" } },
        { bookId: "b2", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Tarix" } },
        { bookId: "b3", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "She'riyat" } }
      ]);
      mockPrisma.isbnScan.findMany.mockResolvedValue([]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      expect(components.booksCount).toBe(30);
      expect(components.totalLibrary).toBe(3);
    });

    it("C5: bir xil ISBN ikki marta skan qilinsa bir marta kreditlanadi", async () => {
      const now = new Date();
      const confirmedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.isbnScan.findMany.mockResolvedValue([
        { source: "USER_SCAN", isbn: "9789943452787", confirmedAt },
        { source: "USER_SCAN", isbn: "9789943452787", confirmedAt }
      ]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      // 1 distinct isbn × 0.9 × 10 = 9
      expect(components.booksCount).toBe(9);
      expect(components.totalScan).toBe(1);
      expect(components.totalIsbn).toBe(1);
    });

    it("C5: manbalar aro aralash dublikatlar tabiiy kalit bo'yicha dedup qilinadi", async () => {
      const now = new Date();
      const borrowedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      const returnedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const confirmedAt = returnedAt;

      // b1 ×3 + b2 ×1 → 2 distinct kutubxona kitobi
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman" } },
        { bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman" } },
        { bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman" } },
        { bookId: "b2", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Tarix" } }
      ]);
      // USER_SCAN x1 ×2 → 1 distinct; MUTOLAA m1 ×2 → 1 distinct
      mockPrisma.isbnScan.findMany.mockResolvedValue([
        { source: "USER_SCAN", isbn: "978-x1", confirmedAt },
        { source: "USER_SCAN", isbn: "978-x1", confirmedAt },
        { source: "MUTOLAA", isbn: "978-m1", confirmedAt },
        { source: "MUTOLAA", isbn: "978-m1", confirmedAt }
      ]);
      mockPrisma.readingIndex.create.mockImplementation((args) =>
        Promise.resolve(args.data)
      );

      const result = await service.recalculateForUser("u1");
      const components = result.components as Record<string, number>;

      // 2×1.0 + 1×0.9 + 1×0.85 = 3.75 → min(37.5, 100) → round = 38
      expect(components.booksCount).toBe(38);
      expect(components.totalLibrary).toBe(2);
      expect(components.totalScan).toBe(1);
      expect(components.totalMutolaa).toBe(1);
      expect(components.totalIsbn).toBe(2);
    });
  });

  // ── Plan 02-03 Task 3: scheduleNightlyRecalculation addBulk fan-out ────────
  describe("scheduleNightlyRecalculation", () => {
    it("enqueues Math.ceil(activeUserCount / 1000) chunks via a single addBulk", async () => {
      mockPrisma.user.count.mockResolvedValue(2500);

      await service.scheduleNightlyRecalculation();

      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      const jobs = (mockQueue.addBulk as jest.Mock).mock.calls[0][0] as Array<unknown>;
      expect(jobs).toHaveLength(3); // ceil(2500 / 1000)
    });

    it("each job uses a deterministic jobId ri-recalc:YYYY-MM-DD:N", async () => {
      mockPrisma.user.count.mockResolvedValue(1500);

      await service.scheduleNightlyRecalculation();

      const jobs = (mockQueue.addBulk as jest.Mock).mock.calls[0][0] as Array<{
        opts: { jobId: string };
      }>;
      expect(jobs).toHaveLength(2);
      expect(jobs[0].opts.jobId).toMatch(/^ri-recalc:\d{4}-\d{2}-\d{2}:0$/);
      expect(jobs[1].opts.jobId).toMatch(/^ri-recalc:\d{4}-\d{2}-\d{2}:1$/);
    });

    it("each job has attempts: 3 and exponential backoff with delay 5000ms", async () => {
      mockPrisma.user.count.mockResolvedValue(500);

      await service.scheduleNightlyRecalculation();

      const jobs = (mockQueue.addBulk as jest.Mock).mock.calls[0][0] as Array<{
        opts: { attempts: number; backoff: { type: string; delay: number } };
      }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].opts.attempts).toBe(3);
      expect(jobs[0].opts.backoff).toEqual({ type: "exponential", delay: 5000 });
    });

    it("job data has chunkIndex / offset / limit / scheduledAt fields", async () => {
      mockPrisma.user.count.mockResolvedValue(2500);

      await service.scheduleNightlyRecalculation();

      const jobs = (mockQueue.addBulk as jest.Mock).mock.calls[0][0] as Array<{
        name: string;
        data: { chunkIndex: number; offset: number; limit: number; scheduledAt: string };
      }>;
      expect(jobs[0].name).toBe("ri-chunk");
      expect(jobs[0].data.chunkIndex).toBe(0);
      expect(jobs[0].data.offset).toBe(0);
      expect(jobs[0].data.limit).toBe(1000);
      expect(jobs[1].data.offset).toBe(1000);
      expect(jobs[2].data.offset).toBe(2000);
      // All chunks share the same scheduledAt date.
      expect(jobs[0].data.scheduledAt).toBe(jobs[2].data.scheduledAt);
    });

    it("does NOT loop sequentially over recalculateForUser", async () => {
      mockPrisma.user.count.mockResolvedValue(500);
      const spy = jest.spyOn(service, "recalculateForUser").mockResolvedValue({} as never);

      await service.scheduleNightlyRecalculation();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("addBulk is a no-op when there are no active users", async () => {
      mockPrisma.user.count.mockResolvedValue(0);

      await service.scheduleNightlyRecalculation();

      // addBulk may be called with an empty array OR skipped — either is fine
      // as long as no recalculateForUser side-effect runs.
      const calls = (mockQueue.addBulk as jest.Mock).mock.calls;
      if (calls.length > 0) {
        expect(calls[0][0]).toEqual([]);
      }
    });

    it("recalculateForUser is preserved untouched for ad-hoc admin usage", async () => {
      // Smoke: the single-user method still exists and is callable.
      expect(typeof service.recalculateForUser).toBe("function");
    });
  });

  // ── RI-04 (Plan 02-04): delta endpoint ─────────────────────────────────────
  describe("computeDelta", () => {
    it("returns daily/weekly/monthly windows with the correct math", async () => {
      // 4 sequential findFirst calls inside Promise.all:
      //   latest=60, prevDaily=55, prevWeekly=40, prevMonthly=30
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 60, calculatedAt: new Date() })
        .mockResolvedValueOnce({ score: 55, calculatedAt: new Date() })
        .mockResolvedValueOnce({ score: 40, calculatedAt: new Date() })
        .mockResolvedValueOnce({ score: 30, calculatedAt: new Date() });

      const result = await service.computeDelta("u1");

      expect(result.daily).toEqual({ current: 60, prev: 55, delta: 5, pct: 9.1 });
      expect(result.weekly.current).toBe(60);
      expect(result.weekly.prev).toBe(40);
      expect(result.weekly.delta).toBe(20);
      expect(result.monthly.delta).toBe(30);
      expect(result.monthly.pct).toBe(100);
    });

    it("returns null fields when a window has no previous record", async () => {
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 60, calculatedAt: new Date() }) // latest
        .mockResolvedValueOnce(null) // no prevDaily
        .mockResolvedValueOnce(null) // no prevWeekly
        .mockResolvedValueOnce(null); // no prevMonthly

      const result = await service.computeDelta("u1");

      expect(result.daily).toEqual({ current: 60, prev: null, delta: null, pct: null });
      expect(result.weekly).toEqual({ current: 60, prev: null, delta: null, pct: null });
      expect(result.monthly).toEqual({ current: 60, prev: null, delta: null, pct: null });
    });

    it("returns all-null when there is no RI history at all", async () => {
      mockPrisma.readingIndex.findFirst.mockResolvedValue(null);

      const result = await service.computeDelta("u1");

      expect(result.daily.current).toBeNull();
      expect(result.daily.delta).toBeNull();
    });

    it("uses CacheService.remember with 1h TTL keyed by userId", async () => {
      mockPrisma.readingIndex.findFirst.mockResolvedValue({ score: 50 });

      await service.computeDelta("u1");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "ri:delta:u1",
        3600,
        expect.any(Function)
      );
    });

    it("cache hit on second call avoids the prisma round-trip", async () => {
      // First call computes; second call returns the cached value.
      const cached = {
        daily: { current: 70, prev: 60, delta: 10, pct: 16.7 },
        weekly: { current: 70, prev: 50, delta: 20, pct: 40 },
        monthly: { current: 70, prev: 40, delta: 30, pct: 75 }
      };
      let callCount = 0;
      (mockCache.remember as jest.Mock).mockImplementation(
        async (_k: string, _t: number, fn: () => Promise<unknown>) => {
          callCount++;
          if (callCount === 1) return fn();
          return cached;
        }
      );
      mockPrisma.readingIndex.findFirst
        .mockResolvedValueOnce({ score: 60 })
        .mockResolvedValueOnce({ score: 55 })
        .mockResolvedValueOnce({ score: 40 })
        .mockResolvedValueOnce({ score: 30 });

      await service.computeDelta("u1");
      const second = await service.computeDelta("u1");

      expect(second).toEqual(cached);
      // findFirst was called 4 times in the first invocation and 0 in the
      // second (cache short-circuit).
      expect(mockPrisma.readingIndex.findFirst).toHaveBeenCalledTimes(4);
    });
  });

  // ── RI-03 (Plan 02-04): monthly partition cleanup cron ─────────────────────
  describe("monthlyPartitionCleanup", () => {
    beforeEach(() => {
      (mockPrisma.$executeRawUnsafe as jest.Mock).mockResolvedValue(0);
    });

    it("DETACHes + DROPs the partition for (current - 13 months)", async () => {
      // Pin date to June 1, 2026 → drop target = May 2025 → 'ReadingIndex_y2025_m05'
      jest.useFakeTimers().setSystemTime(new Date("2026-06-01T04:00:00Z"));

      await service.monthlyPartitionCleanup();

      const calls = (mockPrisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => c[0]);
      const detach = calls.find((sql: string) => /DETACH PARTITION/.test(sql));
      const drop = calls.find((sql: string) => /DROP TABLE IF EXISTS/.test(sql));
      expect(detach).toMatch(/"ReadingIndex_y2025_m05"/);
      expect(drop).toMatch(/"ReadingIndex_y2025_m05"/);

      jest.useRealTimers();
    });

    it("CREATEs the (current + 3 months) partition with correct range bounds", async () => {
      // June 2026 + 3 = September 2026 → 'ReadingIndex_y2026_m09'
      // Range: ['2026-09-01', '2026-10-01')
      jest.useFakeTimers().setSystemTime(new Date("2026-06-01T04:00:00Z"));

      await service.monthlyPartitionCleanup();

      const calls = (mockPrisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => c[0]);
      const create = calls.find((sql: string) => /CREATE TABLE IF NOT EXISTS/.test(sql));
      expect(create).toMatch(/"ReadingIndex_y2026_m09"/);
      expect(create).toMatch(/FROM \('2026-09-01'\) TO \('2026-10-01'\)/);

      jest.useRealTimers();
    });

    it("idempotent: tolerates a missing old partition (DETACH error swallowed)", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-06-01T04:00:00Z"));
      // First call (DETACH) throws — partition already gone. The cron must
      // continue to the CREATE step rather than abort the whole job.
      (mockPrisma.$executeRawUnsafe as jest.Mock)
        .mockRejectedValueOnce(new Error("partition does not exist"))
        .mockResolvedValue(0);

      await expect(service.monthlyPartitionCleanup()).resolves.toBeUndefined();

      // CREATE must still have fired.
      const calls = (mockPrisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => c[0]);
      const hasCreate = calls.some((sql: string) => /CREATE TABLE IF NOT EXISTS/.test(sql));
      expect(hasCreate).toBe(true);

      jest.useRealTimers();
    });

    it("partition name format is ReadingIndex_yYYYY_mMM (zero-padded month)", async () => {
      // January 2027 → 'ReadingIndex_y2027_m01' (note the leading zero)
      jest.useFakeTimers().setSystemTime(new Date("2027-01-01T04:00:00Z"));

      await service.monthlyPartitionCleanup();

      const calls = (mockPrisma.$executeRawUnsafe as jest.Mock).mock.calls.map((c) => c[0]);
      const drop = calls.find((sql: string) => /DETACH PARTITION/.test(sql));
      // January 2027 - 13 months = December 2025
      expect(drop).toMatch(/"ReadingIndex_y2025_m12"/);

      jest.useRealTimers();
    });
  });

  // ── TOP-08 (Plan 03-02 Task 2): SQL-paginated leaderboard ──────────────────
  // Bug: previous body loaded all users into memory then .sort().slice().
  // Fix: $queryRaw with LIMIT $1 OFFSET $2 — composite index from Phase 1
  // INFRA-06 makes this O(top-N).
  describe("getLeaderboard (TOP-08)", () => {
    type RawMock = jest.Mock & { __lastCall?: unknown };
    let $queryRaw: RawMock;

    beforeEach(() => {
      // Replace prisma.$queryRaw with a captured jest fn so we can assert
      // both the call shape and the bound parameters.
      $queryRaw = jest.fn() as RawMock;
      (mockPrisma as unknown as { $queryRaw: jest.Mock }).$queryRaw = $queryRaw;
    });

    it("calls $queryRaw with LIMIT and OFFSET bound parameters", async () => {
      $queryRaw.mockResolvedValue([
        { userId: "u1", score: 90, calculatedAt: new Date() },
        { userId: "u2", score: 80, calculatedAt: new Date() },
      ]);

      await service.getLeaderboard(10, 20);

      expect($queryRaw).toHaveBeenCalledTimes(1);
      // tagged-template call form: $queryRaw(strings, ...values)
      const args = $queryRaw.mock.calls[0];
      // Bound values come after the TemplateStringsArray
      const boundValues = args.slice(1);
      expect(boundValues).toContain(10);
      expect(boundValues).toContain(20);
    });

    it("returns raw query result with no further .sort/.slice mutation", async () => {
      const rows = [
        { userId: "u1", score: 95, name: "Adult Reader", dob: new Date("2000-01-01") },
        { userId: "u2", score: 80, name: "Child Reader", dob: new Date(Date.now() - 12 * 365.25 * 86400000) },
      ];
      $queryRaw.mockResolvedValue(rows);

      const result = await service.getLeaderboard(10, 0);

      // Order is preserved (no in-memory re-sort)
      expect(result[0].userId).toBe("u1");
      expect(result[1].userId).toBe("u2");
      // Length matches the rows returned by SQL — no additional .slice
      expect(result).toHaveLength(2);
    });

    it("applies maskNameIfMinor to result rows (TOP-06 enforcement)", async () => {
      const adultDob = new Date("2000-01-01");
      const childDob = new Date(Date.now() - 12 * 365.25 * 86400000);
      $queryRaw.mockResolvedValue([
        { userId: "u-adult", score: 95, name: "Anvar Karimov", dob: adultDob, calculatedAt: new Date() },
        { userId: "u-child", score: 80, name: "Bobur Toshmatov", dob: childDob, calculatedAt: new Date() },
      ]);

      const result = await service.getLeaderboard(10, 0);

      expect(result[0].name).toBe("Anvar Karimov");
      // Minor name initials
      expect(result[1].name).toMatch(/^B\.T\.$/);
    });

    it("pagination: offset shifts the window", async () => {
      $queryRaw.mockResolvedValue([{ userId: "u3", score: 70, calculatedAt: new Date() }]);

      await service.getLeaderboard(5, 100);

      const args = $queryRaw.mock.calls[0];
      const boundValues = args.slice(1);
      expect(boundValues).toContain(5);
      expect(boundValues).toContain(100);
    });

    it("default limit=100 offset=0 when no args supplied", async () => {
      $queryRaw.mockResolvedValue([]);

      await service.getLeaderboard();

      const args = $queryRaw.mock.calls[0];
      const boundValues = args.slice(1);
      expect(boundValues).toContain(100);
      expect(boundValues).toContain(0);
    });
  });
});
