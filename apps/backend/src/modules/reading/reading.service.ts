import { Injectable, NotFoundException, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { RI_RECALC_QUEUE } from "../../infra/queue/queue-names";
import type { RiRecalcJobData } from "./ri-recalc.processor";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";
// C5 fix: koeffitsientlar, og'irliklar va butun score hisoblash endi
// reading-score.util.ts dagi yagona pure funksiyada — nightly processor
// bilan baytma-bayt paritet konstruksiya bo'yicha kafolatlanadi.
import { computeReadingScore } from "./reading-score.util";
import { XpService } from "../xp/xp.service";

// Plan 02-03 RI-01: chunk size for the nightly fan-out. 1000 users per chunk
// keeps the replica's per-query result set small enough that the in-process
// grouping stays bounded (≤1000 entries per Map).
const RI_CHUNK_SIZE = 1000;

export interface WindowDelta {
  current: number | null;
  prev: number | null;
  delta: number | null;
  pct: number | null;
}

@Injectable()
export class ReadingService {
  private readonly logger = new Logger(ReadingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(RI_RECALC_QUEUE) private readonly riQueue: Queue<RiRecalcJobData>,
    private readonly cache?: CacheService,
    // @Optional: mavjud unit testlar ReadingService ni 3 pozitsion argument
    // bilan quradi (BadgeService dagi kafka bilan bir xil naqsh) — XP berish
    // shunda jim o'tkazib yuboriladi, RI hisoblash o'zgarmaydi.
    @Optional() private readonly xp?: XpService
  ) {}

  async getReadingIndex(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const latest = await this.prisma.readingIndex.findFirst({
      where: { userId },
      orderBy: { calculatedAt: "desc" }
    });

    return latest ?? { userId, score: 0, components: {}, calculatedAt: null };
  }

  async getHistory(userId: string) {
    return this.prisma.readingIndex.findMany({
      where: { userId },
      orderBy: { calculatedAt: "desc" },
      take: 12
    });
  }

  // ── Har kecha 00:00 — RI batch fan-out (RI-01, Plan 02-03) ─────────────────
  //
  // Replaces the legacy `for (user of users) await recalculateForUser(id)` loop
  // (projected ~69 hours at 5M users — C6 critical pitfall). Now: count active
  // users, addBulk N chunk jobs in a single Redis round-trip, return.
  // RiRecalcProcessor (concurrency 10) drains the queue against the
  // DATABASE_REPLICA_URL streaming standby; primary stays free for live
  // traffic during the batch window.
  //
  // jobId is deterministic — `ri-recalc:YYYY-MM-DD:N` — so if the cron fires
  // twice the same UTC day (timezone DST edge cases, process restart) BullMQ
  // dedupes by jobId at enqueue time (T-02-12 mitigation).
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduleNightlyRecalculation(): Promise<void> {
    const activeUserCount = await this.prisma.user.count({
      where: { status: "ACTIVE" }
    });

    const totalChunks = Math.ceil(activeUserCount / RI_CHUNK_SIZE);
    this.logger.log(
      `Scheduling RI recalc: ${activeUserCount} active users -> ${totalChunks} chunks`
    );

    // YYYY-MM-DD in UTC — shared across all chunks so the jobId date suffix
    // is stable for the whole batch.
    const scheduledDate = new Date().toISOString().slice(0, 10);

    const jobs = Array.from({ length: totalChunks }, (_, i) => ({
      name: "ri-chunk",
      data: {
        chunkIndex: i,
        offset: i * RI_CHUNK_SIZE,
        limit: RI_CHUNK_SIZE,
        scheduledAt: scheduledDate
      } satisfies RiRecalcJobData,
      opts: {
        jobId: `ri-recalc:${scheduledDate}:${i}`,
        attempts: 3,
        backoff: { type: "exponential" as const, delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: false as const
      }
    }));

    if (jobs.length === 0) {
      this.logger.log("RI recalc skipped: no active users");
      return;
    }

    await this.riQueue.addBulk(jobs);
    this.logger.log(`RI recalc dispatched: ${totalChunks} chunks queued`);
  }

  // ── RI-03 (Plan 02-04): monthly partition lifecycle ──────────────────────
  //
  // Runs at 04:00 on the 1st of each month, Asia/Tashkent local time thanks
  // to INFRA-05's TZ=Asia/Tashkent container env. Three operations:
  //   (a) DETACH + DROP the partition that's now (current_month - 13 months
  //       old) — the ReadingIndex partition lifecycle is bounded at 13
  //       months of hot data; older readings move to "deferred archive"
  //       (intentionally NOT MinIO-dumped in V1 — research permits cold
  //       drop because audit-log retention is a separate concern)
  //   (b) CREATE the partition for (current_month + 3) so we always have
  //       a forward margin of 2-3 months
  //   (c) idempotent: missing-old-partition and already-existing-new are
  //       both tolerated (DROP TABLE IF EXISTS; CREATE TABLE IF NOT EXISTS)
  //
  // Each op is wrapped in its own try-catch so a failure on one doesn't
  // abort the others — partition operations are independent.
  @Cron("0 4 1 * *")
  async monthlyPartitionCleanup(): Promise<void> {
    const now = new Date();

    // D4 (iyul auditi): prod'da replicas:3 — uchala replika bir vaqtda DDL
    // (DETACH/DROP PARTITION) bajarsa parent-jadval lock'ida deadlock bo'ladi.
    // audit.service.ts dagi SETNX leader-lock naqshi: oy-bucket kalit + 2 soat
    // TTL — faqat bitta replika yuradi. Cache yo'q bo'lsa (unit test) — davom.
    if (this.cache) {
      const monthBucket = now.toISOString().slice(0, 7);
      const acquired = await this.cache.setNx(
        `cron:ri-partition-monthly:${monthBucket}`, "1", 2 * 60 * 60
      );
      if (!acquired) {
        this.logger.debug(`[ri-partition-monthly] leader lock held — skipping ${monthBucket}`);
        return;
      }
    }

    // (a) DROP the 13-months-ago partition.
    const dropTarget = new Date(now);
    dropTarget.setMonth(dropTarget.getMonth() - 13);
    const dropName = this._partitionName(dropTarget);
    try {
      await this.prisma.$executeRawUnsafe(
        `ALTER TABLE "ReadingIndex" DETACH PARTITION "${dropName}" CONCURRENTLY;`
      );
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${dropName}";`);
      this.logger.log(`RI partition dropped: ${dropName}`);
    } catch (err) {
      // Idempotent — missing partition is fine (DETACH on a non-existent
      // partition raises; DROP IF EXISTS doesn't).
      this.logger.warn(
        `RI partition ${dropName} drop skipped: ${(err as Error).message}`
      );
    }

    // (b) CREATE the forward partitions: current+1 … current+3.
    //
    // D2 (iyul auditi): avval FAQAT current+3 yaratilardi. Migratsiya M oyida
    // qo'llanib M+2 gacha partitsiya bergan; cron birinchi marta M+1 da yurib
    // M+4 ni yaratardi — M+3 hech qachon yaratilmay, 3 oydan keyin har
    // readingIndex.create() "no partition of relation" bilan yiqilardi.
    // Endi oraliqdagi barcha yetishmayotganlar IF NOT EXISTS bilan yaratiladi.
    for (const monthsAhead of [1, 2, 3]) {
      const createTarget = new Date(now);
      createTarget.setMonth(createTarget.getMonth() + monthsAhead);
      const createName = this._partitionName(createTarget);
      const rangeStart = this._partitionRangeStart(createTarget);
      const rangeEnd = this._partitionRangeEnd(createTarget);
      try {
        await this.prisma.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "${createName}" PARTITION OF "ReadingIndex" ` +
            `FOR VALUES FROM ('${rangeStart}') TO ('${rangeEnd}');`
        );
        this.logger.log(`RI partition ensured: ${createName} [${rangeStart}, ${rangeEnd})`);
      } catch (err) {
        this.logger.warn(
          `RI partition ${createName} create skipped: ${(err as Error).message}`
        );
      }
    }
  }

  private _partitionName(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `ReadingIndex_y${y}_m${m}`;
  }

  private _partitionRangeStart(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }

  private _partitionRangeEnd(d: Date): string {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const y = next.getFullYear();
    const m = String(next.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }

  async recalculateForUser(userId: string) {
    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    // Kutubxona tranzaksiyalari (RETURNED) — bookId default select da bor;
    // book.isbn FR1 dedup kaliti (asar), book.genre diversity uchun.
    const allTx = await this.prisma.bookTransaction.findMany({
      where: { userId, status: "RETURNED", returnedAt: { gte: oneYearAgo } },
      include: { book: { select: { genre: true, isbn: true } } }
    });

    // ISBN scan (tasdiqlangan) — isbn + source default select da bor.
    const isbnScans = await this.prisma.isbnScan.findMany({
      where: { userId, confirmed: true, confirmedAt: { gte: oneYearAgo } }
    });

    // C5 fix: barcha komponent matematikasi reading-score.util.ts da.
    // Kutubxona krediti = DISTINCT bookId (×1.0), scan krediti = DISTINCT
    // isbn per source (×0.9/0.85/0.8). Bir kitobni 10 marta qaytarish endi
    // 1 kredit beradi. Og'irliklar va qolgan komponentlar o'zgarmagan.
    const { score, components } = computeReadingScore(allTx, isbnScans, now);

    return this.prisma.readingIndex.create({
      data: { userId, score, components }
    });
  }

  // ── Mutolaa API sinxronlash ───────────────────────────────────────────────
  // Mutolaa platformasidan o'qilgan sahifalar import qilinadi.
  // source = "MUTOLAA" bo'lgan IsbnScan yozuvlari orqali.
  async syncMutolaaProgress(userId: string, isbn: string, pagesRead: number, totalPages: number) {
    if (totalPages <= 0 || pagesRead <= 0) return;
    const progress = pagesRead / totalPages;
    if (progress < 0.9) return; // 90% dan kam o'qilsa hisoblanmaydi

    // Duplicate tekshiruvi — insert-time guard. DB darajasida unique
    // constraint yo'q, shuning uchun bu yakka himoya emas: C5 fix bo'yicha
    // scoring vaqtida ham DISTINCT isbn qoidasi qo'llanadi
    // (reading-score.util.ts), tarixiy/race dublikatlar kredit bermaydi.
    const exists = await this.prisma.isbnScan.findFirst({
      where: { userId, isbn, source: "MUTOLAA" }
    });
    if (exists) return { skipped: true, reason: "duplicate" };

    const book = await this.prisma.book.findFirst({ where: { isbn } });
    await this.prisma.isbnScan.create({
      data: {
        userId,
        isbn,
        title: book?.title ?? isbn,
        author: book?.author ?? "—",
        source: "MUTOLAA",
        confirmed: true,
        confirmedAt: new Date()
      }
    });

    this.xp?.awardForMutolaaSync(userId).catch(() => {});

    return { synced: true };
  }

  // ── RI delta (RI-04, Plan 02-04) ────────────────────────────────────────
  //
  // GET /reading/:userId/delta — returns {daily, weekly, monthly} deltas
  // using the composite @@index([userId, calculatedAt]) for three fast
  // point queries. Cached 1h in Redis keyed by ri:delta:{userId} — the
  // nightly RiRecalcProcessor invalidation is handled by TTL expiry (1h is
  // tight enough that staleness is bounded; on heavy reads we add explicit
  // invalidation in a follow-up).
  //
  // Window semantics:
  //   - daily   = today's latest vs. yesterday's latest
  //   - weekly  = today's latest vs. latest <= 7 days ago
  //   - monthly = today's latest vs. latest <= 30 days ago
  //
  // For each window: prev=null → delta=null, pct=null (preserves "no data"
  // vs. "zero progress" distinction).
  async computeDelta(userId: string): Promise<{
    daily: WindowDelta;
    weekly: WindowDelta;
    monthly: WindowDelta;
  }> {
    const fetcher = async () => this._fetchDelta(userId);
    if (this.cache) {
      return this.cache.remember(`ri:delta:${userId}`, 3600, fetcher);
    }
    return fetcher();
  }

  private async _fetchDelta(userId: string): Promise<{
    daily: WindowDelta;
    weekly: WindowDelta;
    monthly: WindowDelta;
  }> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(startOfToday.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [latest, prevDaily, prevWeekly, prevMonthly] = await Promise.all([
      this.prisma.readingIndex.findFirst({
        where: { userId },
        orderBy: { calculatedAt: "desc" },
        select: { score: true, calculatedAt: true },
      }),
      this.prisma.readingIndex.findFirst({
        where: {
          userId,
          calculatedAt: { gte: startOfYesterday, lt: startOfToday },
        },
        orderBy: { calculatedAt: "desc" },
        select: { score: true, calculatedAt: true },
      }),
      this.prisma.readingIndex.findFirst({
        where: { userId, calculatedAt: { lt: sevenDaysAgo } },
        orderBy: { calculatedAt: "desc" },
        select: { score: true, calculatedAt: true },
      }),
      this.prisma.readingIndex.findFirst({
        where: { userId, calculatedAt: { lt: thirtyDaysAgo } },
        orderBy: { calculatedAt: "desc" },
        select: { score: true, calculatedAt: true },
      }),
    ]);

    const current = latest?.score ?? null;

    return {
      daily: this._computeWindow(current, prevDaily?.score ?? null),
      weekly: this._computeWindow(current, prevWeekly?.score ?? null),
      monthly: this._computeWindow(current, prevMonthly?.score ?? null),
    };
  }

  private _computeWindow(
    current: number | null,
    prev: number | null
  ): WindowDelta {
    if (current === null || prev === null) {
      return { current, prev, delta: null, pct: null };
    }
    const delta = Math.round((current - prev) * 10) / 10;
    const pct = prev > 0 ? Math.round((delta / prev) * 100 * 10) / 10 : null;
    return { current, prev, delta, pct };
  }

  // ── Leaderboard (eng yuqori RI lar) — TOP-08 (Plan 03-02 Task 2) ────────
  //
  // SQL-paginated: LIMIT $1 OFFSET $2 on a DISTINCT-ON subquery, indexed by
  // the (userId, calculatedAt) composite from Phase 1 INFRA-06. O(top-N)
  // memory — closes the previous bug that loaded all 5M users into Node and
  // sorted in JS (T-03-02-D DoS register).
  //
  // TOP-06: minor names are masked at the result-mapping layer using the
  // shared maskNameIfMinor helper (Plan 03-01). Public endpoint — defence
  // applied here, NOT optional.
  async getLeaderboard(
    limit = 100,
    offset = 0,
  ): Promise<Array<{
    userId: string;
    score: number;
    name: string;
    calculatedAt: Date;
  }>> {
    const rows = await this.prisma.$queryRaw<Array<{
      userId: string;
      score: number;
      name: string;
      dob: Date | null;
      calculatedAt: Date;
    }>>`
      SELECT
        latest."userId",
        latest.score,
        latest."calculatedAt",
        u.name,
        u.dob
      FROM (
        SELECT DISTINCT ON ("userId") "userId", score, "calculatedAt"
        FROM "ReadingIndex"
        ORDER BY "userId", "calculatedAt" DESC
      ) AS latest
      JOIN "User" u ON u.id = latest."userId"
      ORDER BY latest.score DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return rows.map((r) => ({
      userId: r.userId,
      score: r.score,
      // TOP-06: shared masker — children's names are initialised at emit time.
      name: maskNameIfMinor(r.name, r.dob),
      calculatedAt: r.calculatedAt,
    }));
  }
}
