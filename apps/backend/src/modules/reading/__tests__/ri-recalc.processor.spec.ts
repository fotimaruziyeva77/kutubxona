/**
 * RiRecalcProcessor spec (Plan 02-03 Task 2)
 *
 * Asserts:
 *  1. A chunk produces exactly one createMany call against the primary
 *  2. Per-source coefficient is honored (parity with reading.service.ts so the
 *     batch path doesn't diverge from the ad-hoc recalculateForUser path)
 *  3. Trust Score reading-speed signal (FRAUD-05) decrements by 5 for
 *     impossibly-fast reads (pages/hour > 100) or implausibly-quick (< 30 min)
 *     and leaves plausible-pace readers untouched
 *  4. Users with zero activity still get a RI row (history continuity)
 *  5. job.updateProgress(100) is called at the end
 */

import { Job } from "bullmq";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { RiRecalcProcessor, RiRecalcJobData } from "../ri-recalc.processor";
import { computeReadingScore } from "../reading-score.util";

type AnyMock = jest.Mock<unknown, unknown[]>;

const makePrimary = () => ({
  readingIndex: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  user: { update: jest.fn().mockResolvedValue({}) }
}) as unknown as PrismaService;

const makeReplica = (
  users: Array<{ id: string; trustScore: number }>,
  tx: unknown[],
  scans: unknown[],
  tests: unknown[] = []
) =>
  ({
    user: { findMany: jest.fn().mockResolvedValue(users) },
    bookTransaction: { findMany: jest.fn().mockResolvedValue(tx) },
    isbnScan: { findMany: jest.fn().mockResolvedValue(scans) },
    comprehensionTest: { findMany: jest.fn().mockResolvedValue(tests) }
  }) as unknown as PrismaReplicaService;

const makeJob = (data: RiRecalcJobData): Job<RiRecalcJobData> =>
  ({
    id: `ri-recalc:${data.scheduledAt}:${data.chunkIndex}`,
    name: "ri-chunk",
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: jest.fn().mockResolvedValue(undefined)
  }) as unknown as Job<RiRecalcJobData>;

describe("RiRecalcProcessor", () => {
  it("processes a chunk and calls readingIndex.createMany exactly once with one row per user", async () => {
    const users = [
      { id: "u1", trustScore: 50 },
      { id: "u2", trustScore: 50 },
      { id: "u3", trustScore: 50 }
    ];
    const primary = makePrimary();
    const replica = makeReplica(users, [], []);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
    expect(createMany).toHaveBeenCalledTimes(1);
    const arg = createMany.mock.calls[0][0] as { data: unknown[] };
    expect(arg.data).toHaveLength(3);
  });

  it("applies per-source coefficient (parity with reading.service.ts RI-02 fix)", async () => {
    const now = new Date();
    const confirmedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const borrowedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const users = [{ id: "u1", trustScore: 50 }];
    const tx = [
      {
        userId: "u1",
        bookId: "b1",
        borrowedAt,
        returnedAt: confirmedAt,
        penaltyDays: 0,
        book: { genre: "Roman", pages: 200 }
      }
    ];
    const scans = [
      { userId: "u1", source: "USER_SCAN", isbn: "x1", confirmedAt },
      { userId: "u1", source: "STORE_MANUAL", isbn: "x2", confirmedAt },
      { userId: "u1", source: "MUTOLAA", isbn: "x3", confirmedAt },
      { userId: "u1", source: "EBOOK", isbn: "x4", confirmedAt }
    ];

    const primary = makePrimary();
    const replica = makeReplica(users, tx, scans);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
    const arg = createMany.mock.calls[0][0] as { data: Array<{ components: Record<string, number> }> };
    const components = arg.data[0].components;

    // 1 lib (1.0) + 1 scan (0.9) + 1 store (0.9) + 1 mutolaa (0.85) + 1 ebook (0.8) = 4.45
    // booksCountScore = min(44.5, 100) = 44.5 → rounded = 45
    expect(components.booksCount).toBe(45);
    expect(components.totalLibrary).toBe(1);
    expect(components.totalScan).toBe(1);
    expect(components.totalStore).toBe(1);
    expect(components.totalMutolaa).toBe(1);
    expect(components.totalEbook).toBe(1);
  });

  // ── C5 (CRITICAL): nightly batch ham DISTINCT bookId / isbn sanaydi ───────
  // Avval `userTx.length * COEF.LIBRARY` edi — bitta kitobni 10 marta
  // qaytarish tungi qayta hisoblashda ham booksCount ni 100 ga to'ldirardi.
  describe("C5 dedup (distinct bookId / distinct isbn per source)", () => {
    const now = new Date();
    const borrowedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const returnedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    it("10 returns of the SAME book credit exactly 1 distinct book", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      const tx = Array.from({ length: 10 }, () => ({
        userId: "u1",
        bookId: "b1",
        borrowedAt,
        returnedAt,
        penaltyDays: 0,
        book: { genre: "Roman", pages: 200 }
      }));

      const primary = makePrimary();
      const replica = makeReplica(users, tx, []);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
      const arg = createMany.mock.calls[0][0] as { data: Array<{ components: Record<string, number> }> };
      const components = arg.data[0].components;

      // Avval: min(10 × 1.0 × 10, 100) = 100. Endi: 1 distinct → 10.
      expect(components.booksCount).toBe(10);
      expect(components.totalLibrary).toBe(1);
      // FR3: faollik ham distinct asar bo'yicha — 10 xom event, 1 asar → 25.
      expect(components.activity).toBe(25);
    });

    it("3 distinct books credit 3; mixed duplicates across sources deduped per key", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      // b1 ×2 + b2 + b3 → 3 distinct kutubxona kitobi
      const tx = [
        { userId: "u1", bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman", pages: 200 } },
        { userId: "u1", bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman", pages: 200 } },
        { userId: "u1", bookId: "b2", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Tarix", pages: 300 } },
        { userId: "u1", bookId: "b3", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "She'riyat", pages: 100 } }
      ];
      // USER_SCAN x1 ×2 → 1; EBOOK e1 ×3 → 1
      const scans = [
        { userId: "u1", source: "USER_SCAN", isbn: "978-x1", confirmedAt: returnedAt },
        { userId: "u1", source: "USER_SCAN", isbn: "978-x1", confirmedAt: returnedAt },
        { userId: "u1", source: "EBOOK", isbn: "978-e1", confirmedAt: returnedAt },
        { userId: "u1", source: "EBOOK", isbn: "978-e1", confirmedAt: returnedAt },
        { userId: "u1", source: "EBOOK", isbn: "978-e1", confirmedAt: returnedAt }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, tx, scans);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
      const arg = createMany.mock.calls[0][0] as { data: Array<{ components: Record<string, number> }> };
      const components = arg.data[0].components;

      // 3×1.0 + 1×0.9 + 1×0.8 = 4.7 → min(47, 100) = 47
      expect(components.booksCount).toBe(47);
      expect(components.totalLibrary).toBe(3);
      expect(components.totalScan).toBe(1);
      expect(components.totalEbook).toBe(1);
      expect(components.totalIsbn).toBe(2);
    });

    it("parity: chunk row equals computeReadingScore output for identical inputs", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      const tx = [
        { userId: "u1", bookId: "b1", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Roman", pages: 200 } },
        { userId: "u1", bookId: "b1", borrowedAt, returnedAt, penaltyDays: 3, book: { genre: "Roman", pages: 200 } },
        { userId: "u1", bookId: "b2", borrowedAt, returnedAt, penaltyDays: 0, book: { genre: "Tarix", pages: 300 } }
      ];
      const scans = [
        { userId: "u1", source: "MUTOLAA", isbn: "978-m1", confirmedAt: returnedAt },
        { userId: "u1", source: "MUTOLAA", isbn: "978-m1", confirmedAt: returnedAt },
        { userId: "u1", source: "STORE_MANUAL", isbn: "978-s1", confirmedAt: returnedAt }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, tx, scans);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
      const arg = createMany.mock.calls[0][0] as {
        data: Array<{ score: number; components: Record<string, number> }>;
      };

      // Fixturelar oyna chegaralaridan kunlar uzoqda — millisekundlik `now`
      // farqi natijani o'zgartira olmaydi. Ikkala yo'l bitta pure funksiyani
      // chaqirgani uchun score VA components aynan teng bo'lishi shart.
      const expected = computeReadingScore(tx, scans, new Date());
      expect(arg.data[0].score).toBe(expected.score);
      expect(arg.data[0].components).toEqual(expected.components);
    });
  });

  it("decrements trust score by 5 for impossibly-fast reads (FRAUD-05 reading-speed)", async () => {
    const now = new Date();
    const borrowedAt = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago
    const returnedAt = now;

    const users = [{ id: "u1", trustScore: 50 }];
    const tx = [
      {
        userId: "u1",
        bookId: "b1",
        borrowedAt,
        returnedAt,
        penaltyDays: 0,
        // 200 pages in 1 hour = 200 pages/hour > 100 threshold → -5 trust
        book: { genre: "Roman", pages: 200 }
      }
    ];

    const primary = makePrimary();
    const replica = makeReplica(users, tx, []);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const update = (primary.user as unknown as { update: AnyMock }).update;
    expect(update).toHaveBeenCalledTimes(1);
    // P2 clamp fix — endi increment emas, clamp qilingan absolyut qiymat
    // yoziladi: 50 + (-5) = 45.
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { trustScore: 45 }
    });
  });

  it("does NOT decrement trust score for plausible-pace readers", async () => {
    const now = new Date();
    // 200 pages in 10 hours = 20 pages/hour (plausible) — no decrement
    const borrowedAt = new Date(now.getTime() - 10 * 60 * 60 * 1000);
    const returnedAt = now;

    const users = [{ id: "u1", trustScore: 50 }];
    const tx = [
      {
        userId: "u1",
        bookId: "b1",
        borrowedAt,
        returnedAt,
        penaltyDays: 0,
        book: { genre: "Roman", pages: 200 }
      }
    ];

    const primary = makePrimary();
    const replica = makeReplica(users, tx, []);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const update = (primary.user as unknown as { update: AnyMock }).update;
    expect(update).not.toHaveBeenCalled();
  });

  it("decrements trust score by 5 for implausibly-quick reads (< 30 min)", async () => {
    const now = new Date();
    // returned 10 minutes after borrow → hoursHeld < 0.5 → -5
    const borrowedAt = new Date(now.getTime() - 10 * 60 * 1000);
    const returnedAt = now;

    const users = [{ id: "u1", trustScore: 50 }];
    const tx = [
      {
        userId: "u1",
        bookId: "b1",
        borrowedAt,
        returnedAt,
        penaltyDays: 0,
        book: { genre: "Roman", pages: 50 }
      }
    ];

    const primary = makePrimary();
    const replica = makeReplica(users, tx, []);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const update = (primary.user as unknown as { update: AnyMock }).update;
    expect(update).toHaveBeenCalledTimes(1);
    // P2 clamp fix — absolyut yozuv: 50 + (-5) = 45.
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { trustScore: 45 }
    });
  });

  it("includes users with zero activity in createMany (history continuity)", async () => {
    const users = [{ id: "u1", trustScore: 50 }];
    const primary = makePrimary();
    const replica = makeReplica(users, [], []);
    const processor = new RiRecalcProcessor(primary, replica);

    await processor.process(makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    }));

    const createMany = (primary.readingIndex as unknown as { createMany: AnyMock }).createMany;
    const arg = createMany.mock.calls[0][0] as { data: Array<{ score: number; userId: string; components: Record<string, number> }> };
    expect(arg.data).toHaveLength(1);
    expect(arg.data[0].userId).toBe("u1");
    // No-activity user: booksCount=0, consistency=0, diversity=0, activity=0,
    // discipline=100 (no overdue) → 100 * 0.15 = 15. The RI row exists to
    // preserve history continuity even when score is rock-bottom.
    expect(arg.data[0].components.booksCount).toBe(0);
    expect(arg.data[0].components.activity).toBe(0);
  });

  // ── Plan 02-05 Task 3: FRAUD-05 comprehension pass-rate signal (3/3) ─────
  describe("FRAUD-05 comprehension pass-rate signal", () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

    it("comprehension pass-rate > 0.8 adds +5 to trust score", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      // 4 tests, 4 passed → 1.0 > 0.8 → +5
      const tests = [
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, [], [], tests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).toHaveBeenCalledTimes(1);
      // P2 clamp fix — absolyut yozuv: 50 + 5 = 55.
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { trustScore: 55 }
      });
    });

    it("comprehension pass-rate < 0.4 subtracts 5 from trust score", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      // 5 tests, 1 passed → 0.2 < 0.4 → -5
      const tests = [
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, [], [], tests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).toHaveBeenCalledTimes(1);
      // P2 clamp fix — absolyut yozuv: 50 + (-5) = 45.
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { trustScore: 45 }
      });
    });

    it("mid-range pass-rate (0.4..0.8) leaves trust score unchanged", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      // 4 tests, 2 passed → 0.5 — no comprehension contribution
      const tests = [
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, [], [], tests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).not.toHaveBeenCalled();
    });

    it("no tests in 30d window — no comprehension contribution", async () => {
      const users = [{ id: "u1", trustScore: 50 }];
      const primary = makePrimary();
      const replica = makeReplica(users, [], [], []);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).not.toHaveBeenCalled();
    });

    it("combined reading-speed (-5) + comprehension (-5) bounded to single -10 delta", async () => {
      const now = new Date();
      const borrowedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago → -5 reading-speed
      const returnedAt = now;

      const users = [{ id: "u1", trustScore: 50 }];
      const tx = [
        {
          userId: "u1",
          bookId: "b1",
          borrowedAt,
          returnedAt,
          penaltyDays: 0,
          book: { genre: "Roman", pages: 50 }
        }
      ];
      // 5 tests, 1 passed → -5 comprehension
      const tests = [
        { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
        { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate }
      ];

      const primary = makePrimary();
      const replica = makeReplica(users, tx, [], tests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(makeJob({
        chunkIndex: 0,
        offset: 0,
        limit: 1000,
        scheduledAt: "2026-06-06"
      }));

      const update = (primary.user as unknown as { update: AnyMock }).update;
      // Single update per user — both signals collapsed into one delta
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        // -5 (reading-speed) + -5 (comprehension) = -10, within [-10, +10]
        // bound; P2 clamp fix — absolyut yozuv: 50 - 10 = 40.
        data: { trustScore: 40 }
      });
    });
  });

  // ── P2 hygiene — trustScore [0, 100] clamp ────────────────────────────────
  describe("trustScore clamp to [0, 100]", () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const failingTests = [
      { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
      { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate },
      { isbnScan: { userId: "u1" }, passed: false, createdAt: recentDate }
    ];
    const passingTests = [
      { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
      { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate },
      { isbnScan: { userId: "u1" }, passed: true, createdAt: recentDate }
    ];
    const job = () =>
      makeJob({ chunkIndex: 0, offset: 0, limit: 1000, scheduledAt: "2026-06-10" });

    it("floor: trustScore 3 with -10 cumulative delta writes 0 (not -7)", async () => {
      const now = new Date();
      const tx = [
        {
          userId: "u1",
          bookId: "b1",
          borrowedAt: new Date(now.getTime() - 10 * 60 * 1000), // 10 min → -5 speed
          returnedAt: now,
          penaltyDays: 0,
          book: { genre: "Roman", pages: 50 }
        }
      ];
      const primary = makePrimary();
      // -5 (speed) + -5 (comprehension 0/3 pass) = -10; 3 - 10 → clamp 0
      const replica = makeReplica([{ id: "u1", trustScore: 3 }], tx, [], failingTests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(job());

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { trustScore: 0 }
      });
    });

    it("ceiling: trustScore 98 with +5 delta writes 100 (not 103)", async () => {
      const primary = makePrimary();
      const replica = makeReplica([{ id: "u1", trustScore: 98 }], [], [], passingTests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(job());

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { trustScore: 100 }
      });
    });

    it("no-op write skipped: trustScore 0 with negative delta stays 0 (no update)", async () => {
      const primary = makePrimary();
      const replica = makeReplica([{ id: "u1", trustScore: 0 }], [], [], failingTests);
      const processor = new RiRecalcProcessor(primary, replica);

      await processor.process(job());

      const update = (primary.user as unknown as { update: AnyMock }).update;
      expect(update).not.toHaveBeenCalled();
    });
  });

  it("calls job.updateProgress(100) at end of process()", async () => {
    const users = [{ id: "u1", trustScore: 50 }];
    const primary = makePrimary();
    const replica = makeReplica(users, [], []);
    const processor = new RiRecalcProcessor(primary, replica);

    const job = makeJob({
      chunkIndex: 0,
      offset: 0,
      limit: 1000,
      scheduledAt: "2026-06-06"
    });
    await processor.process(job);

    expect(job.updateProgress).toHaveBeenCalledWith(100);
  });
});
