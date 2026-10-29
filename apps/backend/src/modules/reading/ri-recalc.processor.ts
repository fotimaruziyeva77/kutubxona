/**
 * RiRecalcProcessor — Plan 02-03 Task 2 (RI-01 + FRAUD-05 reading-speed signal)
 *
 * BullMQ WorkerHost (concurrency 10) that processes one 1000-user chunk per
 * job. The cron in ReadingService.scheduleNightlyRecalculation fans out
 * N = ceil(activeUserCount / 1000) chunks via Queue.addBulk in a single Redis
 * round-trip. At 5M users this is 5000 jobs × ~12s/job × 10 concurrent ≈
 * 100 minutes wall-clock — closes C6 (sequential nightly loop projected
 * 69 hours).
 *
 * Reads via PrismaReplicaService (DATABASE_REPLICA_URL — falls back to primary
 * when unset). Writes via PrismaService (primary). Plan 02-02's
 * range-partitioned ReadingIndex makes createMany cheap because PG routes
 * inserts by partition key.
 *
 * Reading-speed Trust Score signal (FRAUD-05) is computed in the same pass:
 *   pages/hour > 100 OR borrow-to-return < 30min → trustScore -= 5
 * The decrement is BOUNDED — at most one -5 per chunk per user, even if
 * multiple suspicious transactions exist (avoids stacking false positives
 * when a user happens to return several books on the same day).
 *
 * Comprehension pass-rate signal (FRAUD-05 — Plan 02-05 Task 3, signal 3/3):
 *   last-30-day pass rate > 0.8 → +5 trust delta
 *   last-30-day pass rate < 0.4 → -5 trust delta
 *   mid-range (0.4..0.8) → no change
 * The combined cumulative delta (speed + comprehension) is bounded to
 * [-10, +10] per chunk per user (T-02-25) and applied via a single
 * prisma.user.update call.
 *
 * Location signal (signal 4) is explicitly deferred to v2 per research
 * Open Q 2 (no GPS storage in V1 schema; would require a new column).
 *
 * Threat register coverage:
 *   T-02-12 (DoS via flooding) — jobId dedupe at dispatcher (Task 3)
 *   T-02-13 (duplicate RI rows on retry) — RI.id is cuid() so per-row
 *           uniqueness is automatic; partition PK = (id, calculatedAt)
 *   T-02-16 (trust-score gaming via slow reads) — two-sided gate: only
 *           impossibly-fast OR implausibly-quick triggers; plausible-pace
 *           leaves trustScore unchanged
 */

import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { RI_RECALC_QUEUE } from "../../infra/queue/queue-names";
// C5 fix: score matematikasi endi modul-ichki shared util da — ilgari bu
// yerda inlined COEF/WEIGHTS nusxasi va `userTx.length * COEF.LIBRARY`
// duplicate-counting bug'i bor edi. computeReadingScore DISTINCT bookId /
// DISTINCT isbn-per-source qoidasini qo'llaydi va reading.service.ts ning
// on-demand yo'li bilan paritetni konstruksiya bo'yicha kafolatlaydi.
import { computeReadingScore, ReadingScoreComponents } from "./reading-score.util";

// FRAUD-05 reading-speed gate (Plan 02-03 threat T-02-16):
// pages-per-hour > 100 OR hours-held < 0.5 are both -5 trust signals.
const SUSPICIOUS_PAGES_PER_HOUR = 100;
const SUSPICIOUS_MIN_HOURS = 0.5;
const TRUST_SCORE_PENALTY = 5;

// FRAUD-05 comprehension pass-rate gate (Plan 02-05 Task 3 — signal 3/3):
// Last-30-day pass rate > 0.8 → +5; < 0.4 → -5. Mid-range = no contribution.
// Combined with the reading-speed signal above, the per-chunk cumulative
// delta is bounded to [-10, +10] (T-02-25) to prevent runaway accumulation
// across pathological signal combinations.
const COMPREHENSION_HIGH_RATE = 0.8;
const COMPREHENSION_LOW_RATE = 0.4;
const COMPREHENSION_BONUS = 5;
const COMPREHENSION_PENALTY = 5;
const TRUST_DELTA_BOUND = 10;

// P2 hygiene — trustScore yakuniy qiymati [0, 100] oralig'ida qoladi.
// Avval cheksiz `increment` ishlatilardi: bir necha oy ketma-ket -5/-10
// signallari trustScore ni manfiyga (yoki bonuslar 100 dan oshiqqa)
// surib yuborishi mumkin edi. Delta chegarasi (±10) o'z joyida qoladi;
// qo'shimcha ravishda yakuniy qiymat clamp qilinadi.
const TRUST_SCORE_MIN = 0;
const TRUST_SCORE_MAX = 100;

export interface RiRecalcJobData {
  chunkIndex: number;
  offset: number;
  limit: number;
  scheduledAt: string; // YYYY-MM-DD
}

interface ChunkUser {
  id: string;
  trustScore: number;
}

interface ChunkTransaction {
  userId: string;
  bookId: string; // C5: distinct-bookId krediti uchun
  borrowedAt: Date | null;
  returnedAt: Date | null;
  penaltyDays: number;
  book?: { genre: string | null; pages: number } | null;
}

interface ChunkScan {
  userId: string;
  isbn: string; // C5: distinct-isbn-per-source krediti uchun
  source: string;
  confirmedAt: Date | null;
}

interface ChunkComprehensionTest {
  isbnScan: { userId: string };
  passed: boolean;
  createdAt: Date;
}

@Processor(RI_RECALC_QUEUE, { concurrency: 10 })
export class RiRecalcProcessor extends WorkerHost {
  private readonly logger = new Logger(RiRecalcProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replica: PrismaReplicaService
  ) {
    super();
  }

  async process(job: Job<RiRecalcJobData>): Promise<void> {
    const { chunkIndex, offset, limit, scheduledAt } = job.data;

    try {
      // (1) Load users from replica with deterministic ordering.
      // orderBy id asc is critical: a stable ordering prevents drift across
      // retries (research Risk 2 — duplicate RI rows on retried chunk would
      // come from a different user set without stable order).
      const users = await this.replica.user.findMany({
        where: { status: "ACTIVE" },
        skip: offset,
        take: limit,
        orderBy: { id: "asc" },
        select: { id: true, trustScore: true }
      }) as ChunkUser[];

      if (users.length === 0) {
        await job.updateProgress(100);
        return;
      }

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      const userIds = users.map(u => u.id);

      // (2) Batched reads from replica.
      const [transactions, scans, comprehensionTests] = await Promise.all([
        this.replica.bookTransaction.findMany({
          where: {
            userId: { in: userIds },
            status: "RETURNED",
            returnedAt: { gte: oneYearAgo }
          },
          select: {
            userId: true,
            bookId: true, // C5: dedup kaliti
            borrowedAt: true,
            returnedAt: true,
            penaltyDays: true,
            book: { select: { genre: true, pages: true } }
          }
        }) as Promise<ChunkTransaction[]>,
        this.replica.isbnScan.findMany({
          where: {
            userId: { in: userIds },
            confirmed: true,
            confirmedAt: { gte: oneYearAgo }
          },
          select: { userId: true, isbn: true, source: true, confirmedAt: true }
        }) as Promise<ChunkScan[]>,
        // FRAUD-05 signal 3/3: comprehension pass-rate over last 30 days.
        // Joined via isbnScan.userId so the per-user grouping below stays O(N).
        this.replica.comprehensionTest.findMany({
          where: {
            isbnScan: { userId: { in: userIds } },
            createdAt: { gte: thirtyDaysAgo }
          },
          select: {
            isbnScan: { select: { userId: true } },
            passed: true,
            createdAt: true
          }
        }) as Promise<ChunkComprehensionTest[]>
      ]);

      // (3) Group by userId.
      const txByUser = new Map<string, ChunkTransaction[]>();
      for (const t of transactions) {
        const arr = txByUser.get(t.userId) ?? [];
        arr.push(t);
        txByUser.set(t.userId, arr);
      }
      const scansByUser = new Map<string, ChunkScan[]>();
      for (const s of scans) {
        const arr = scansByUser.get(s.userId) ?? [];
        arr.push(s);
        scansByUser.set(s.userId, arr);
      }
      // Group comprehension tests by their reader (isbnScan.userId).
      const testsByUser = new Map<string, ChunkComprehensionTest[]>();
      for (const ct of comprehensionTests) {
        const uid = ct.isbnScan?.userId;
        if (!uid) continue;
        const arr = testsByUser.get(uid) ?? [];
        arr.push(ct);
        testsByUser.set(uid, arr);
      }

      // (4) Compute RI rows + trust-score deltas in-process.
      const calculatedAt = now;
      const riRows: Array<{
        userId: string;
        score: number;
        components: ReadingScoreComponents;
        calculatedAt: Date;
      }> = [];
      // Clamp uchun absolyut maqsad qiymatlar (delta emas) — chunk boshida
      // o'qilgan user.trustScore dan hisoblanadi (read-modify-write).
      const trustTargets = new Map<string, number>();

      for (const user of users) {
        const userTx = txByUser.get(user.id) ?? [];
        const userScans = scansByUser.get(user.id) ?? [];

        // ── C5 fix: shared pure scorer (reading-score.util.ts) ──────────────
        // Kutubxona krediti = DISTINCT bookId, scan kreditlari = DISTINCT
        // isbn per source. Dedup JS da, allaqachon yuklangan per-user
        // massivlar ichida — qo'shimcha so'rov yo'q (N+1 emas), chunk
        // query shakli o'zgarmagan (faqat bookId/isbn select ga qo'shildi).
        const { score, components } = computeReadingScore(userTx, userScans, now);

        riRows.push({
          userId: user.id,
          score,
          components,
          calculatedAt
        });

        // ── FRAUD-05 reading-speed signal (bounded one penalty per user) ───
        let speedDelta = 0;
        for (const t of userTx) {
          if (speedDelta !== 0) break;
          if (!t.borrowedAt || !t.returnedAt) continue;
          const hoursHeld = (t.returnedAt.getTime() - t.borrowedAt.getTime()) / 3_600_000;
          if (hoursHeld <= 0) continue;

          const pages = t.book?.pages ?? 0;
          const pagesPerHour = pages > 0 ? pages / hoursHeld : 0;

          if (pagesPerHour > SUSPICIOUS_PAGES_PER_HOUR || hoursHeld < SUSPICIOUS_MIN_HOURS) {
            speedDelta = -TRUST_SCORE_PENALTY;
          }
        }

        // ── FRAUD-05 comprehension pass-rate signal (Plan 02-05 Task 3) ───
        // The high/low gates intentionally leave a mid-range null zone — only
        // strong signals nudge trust. Combined with the reading-speed gate
        // above, the cumulative delta is bounded to [-TRUST_DELTA_BOUND,
        // +TRUST_DELTA_BOUND] before applying. T-02-25: a +5/-5 step is
        // small enough that gameability provides limited upside, and FRAUD-01
        // (random answerIdx) + FRAUD-02 (min-time gate) make farming costly.
        let compDelta = 0;
        const userTests = testsByUser.get(user.id) ?? [];
        if (userTests.length > 0) {
          const passedCount = userTests.filter((t) => t.passed).length;
          const passRate = passedCount / userTests.length;
          if (passRate > COMPREHENSION_HIGH_RATE) compDelta = COMPREHENSION_BONUS;
          else if (passRate < COMPREHENSION_LOW_RATE) compDelta = -COMPREHENSION_PENALTY;
        }

        // Combined bounded delta — at most one User.update per chunk per user.
        const cumulative = speedDelta + compDelta;
        if (cumulative !== 0) {
          const bounded = Math.max(
            -TRUST_DELTA_BOUND,
            Math.min(TRUST_DELTA_BOUND, cumulative)
          );
          // P2 hygiene — yakuniy qiymat [0, 100] ga clamp qilinadi. Chunk
          // boshida replikadan o'qilgan trustScore asosida absolyut qiymat
          // yoziladi (read-modify-write); clamp natijasida qiymat o'zgarmasa
          // (masalan, 0 da turgan userga yana -10) yozuv umuman qilinmaydi.
          const target = Math.max(
            TRUST_SCORE_MIN,
            Math.min(TRUST_SCORE_MAX, user.trustScore + bounded)
          );
          if (target !== user.trustScore) {
            trustTargets.set(user.id, target);
          }
        }
      }

      // (5) Bulk writes against primary. createMany once per chunk.
      await this.prisma.readingIndex.createMany({ data: riRows });

      // (6) Trust-score writes — bounded to chunk size (≤1000), serialized
      // (no Promise.all) to avoid hammering the primary's connection pool.
      // P2 hygiene — `increment` o'rniga clamp qilingan absolyut qiymat
      // yoziladi, shu tariqa trustScore hech qachon [0, 100] dan chiqmaydi.
      for (const [userId, target] of trustTargets) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { trustScore: target }
        });
      }

      await job.updateProgress(100);

      this.logger.log(
        `RI chunk ${chunkIndex} done: ${riRows.length} RI rows, ${trustTargets.size} trust writes (scheduledAt=${scheduledAt})`
      );
    } catch (error) {
      this.logger.error(
        `RI chunk ${chunkIndex} failed (offset=${offset}, limit=${limit}, scheduledAt=${scheduledAt}): ${(error as Error).message}`
      );
      // Re-throw so BullMQ honors the configured backoff/retry policy.
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<RiRecalcJobData>, error: Error) {
    this.logger.error(
      `RI chunk job failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
      { jobId: job.id, chunkIndex: job.data.chunkIndex, scheduledAt: job.data.scheduledAt }
    );

    if (job.attemptsMade === job.opts.attempts) {
      this.logger.error(`RI chunk DLQ: ${job.id}`);
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`RI chunk job completed: ${job.id}`);
  }
}
