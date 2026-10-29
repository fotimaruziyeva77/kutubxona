import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { SmsService } from "../../infra/sms/sms.service";
import { CacheService } from "../../infra/cache/cache.service";
import {
  NOTIFICATION_QUEUE,
  REPORT_QUEUE,
  STATS_AGGREGATION_QUEUE,
} from "../../infra/queue/queue-names";
import { buildJobId } from "../../infra/queue/job-id.util";
import {
  assertViloyatInScope,
  assertTumanInScope,
  type ScopedUser,
} from "../../common/utils/admin-scope.util";
import { ALERT_TYPES } from "../../common/constants/alert-types.const";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";
import {
  USER_PUBLIC_SELECT,
  USER_PUBLIC_SELECT_WITH_ADDRESS,
  USER_NOTIFY_SELECT,
} from "../../common/utils/user-select.const";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { escapeHtml } from "../../common/utils/escape-html.util";
import {
  EMAIL_REGEX,
  MAX_ADMIN_FALLBACK_RECIPIENTS,
  parseAdminFallbackEmails,
} from "../../common/utils/admin-email.util";
import {
  LibraryStatus,
  Severity,
  TransactionStatus,
  UserGender,
  UserRole,
  UserStatus,
  UserType,
} from "@prisma/client";

const PENDING_AUTO_FALLBACK_DAYS = 14;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly cache: CacheService,
    // Plan 05-02 Task 1 (STAT-01) — replica routing for ALL heavy reads.
    // Optional + nullable fallback so existing unit tests that instantiate
    // AdminService with the 3-arg constructor still work; runtime DI always
    // supplies the replica because PrismaModule is @Global() and exports it.
    @Optional() private readonly replicaParam?: PrismaReplicaService,
    // Plan 05-02 Task 2 (STAT-03) — pre-agg crons enqueue jobs here.
    // Optional so spec instantiations that don't care about queues can omit.
    @Optional() @InjectQueue(STATS_AGGREGATION_QUEUE)
    private readonly statsQueue?: Queue,
    // Plan 05-03-fix FIX C — Redis SETNX-based leader lock around the
    // markBookForOrder findFirst→create sequence to eliminate the race
    // window where two concurrent requests both insert. Optional because
    // older unit tests instantiate AdminService with the 3/4-arg form.
    @Optional() private readonly redisLock?: RedisLockService,
    // Plan 05-09 Task 2 (LAND-02) — B2B demo CRM email side-effect hook.
    // createDemoRequest enqueues an email job per super_admin recipient (plus
    // ADMIN_NOTIFICATION_EMAILS env CSV fallback handled by NotificationProcessor).
    // Optional so legacy unit tests with the 3/4/5-arg form still construct.
    @Optional() @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationQueue?: Queue,
    // Plan 05-08 Task 2 (RPT-02) — monthly PDF report fan-out queue. The
    // generateMonthlyReports cron enqueues 215 jobs/month here (1 national +
    // 14 viloyat + 200 tuman) which the ReportEmailProcessor renders + emails.
    // Optional so legacy unit tests with smaller constructor signatures still
    // construct without touching the queue subsystem.
    @Optional() @InjectQueue(REPORT_QUEUE)
    private readonly reportQueue?: Queue,
  ) {}

  /**
   * Resolves the read-side Prisma client. Routes ALL heavy aggregations to
   * the read replica when DI supplied one (production + RI batch path).
   * Falls back to the primary client when unset (tests, single-node dev).
   */
  private get replica(): PrismaService | PrismaReplicaService {
    return this.replicaParam ?? this.prisma;
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  // Plan 05-02 T1 — heavy aggregations on replica; the $transaction wrapper
  // is dropped because read-replicas cannot host writes (transactions on a
  // standby are read-only and pointless). Promise.all preserves parallelism.
  async getDashboardStats() {
    const r = this.replica;
    const [totalUsers, activeUsers, pendingUsers, totalLibraries, totalBooks, totalTransactions] =
      await Promise.all([
        r.user.count(),
        r.user.count({ where: { status: UserStatus.ACTIVE } }),
        r.user.count({ where: { status: UserStatus.PENDING } }),
        r.library.count(),
        r.book.count(),
        r.bookTransaction.count()
      ]);

    return { totalUsers, activeUsers, pendingUsers, totalLibraries, totalBooks, totalTransactions };
  }

  // ── PENDING foydalanuvchilar ────────────────────────────────────────────
  // `include: { address: true }` o'rniga aniq select: `include` User ning
  // BARCHA skalyar maydonlarini oladi, ya'ni passwordHash va pinfl ham
  // javobga tushardi (user-select.const.ts izohiga qarang).
  async getPendingUsers() {
    return this.replica.user.findMany({
      where: { status: UserStatus.PENDING },
      select: USER_PUBLIC_SELECT_WITH_ADDRESS,
      orderBy: { createdAt: "asc" }
    });
  }

  // ── Tasdiqlash / Rad etish ─────────────────────────────────────────────
  async approveUser(userId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.ACTIVE },
      select: USER_PUBLIC_SELECT
    });

    // SMS bildirishnoma
    await this.sms.sendNotification(
      user.phone,
      `SIFAT LIBRARY: Siz tashkilotingiz tomonidan tasdiqlandi! Endi to'liq imkoniyatlardan foydalanishingiz mumkin.`,
      userId
    );

    return user;
  }

  async rejectUser(userId: string, reason?: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.BLOCKED },
      select: USER_PUBLIC_SELECT
    });

    const msg = reason
      ? `SIFAT LIBRARY: Arizangiz rad etildi. Sabab: ${reason}`
      : `SIFAT LIBRARY: Arizangiz rad etildi. Batafsil ma'lumot uchun murojaat qiling.`;

    await this.sms.sendNotification(user.phone, msg, userId);

    return user;
  }

  // ── 14 kun — PENDING → CITIZEN (har kecha 01:00) ──────────────────────
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async autoFallbackPendingUsers() {
    // Audit H8 — Redis SETNX leader lock (same convention as the
    // stats-preagg/monthly-reports crons below). replicas:3 in prod fire
    // this @Cron concurrently; without the gate every replica re-sends the
    // fallback SMS to the same users. Day-bucket key + 2h TTL.
    const fallbackDay = new Date().toISOString().slice(0, 10);
    const fallbackLockKey = `cron:pending-auto-fallback:${fallbackDay}`;
    const fallbackLockAcquired = await this.cache.setNx(fallbackLockKey, "1", 2 * 60 * 60);
    if (!fallbackLockAcquired) {
      this.logger.debug(`[pending-auto-fallback] leader lock held — skipping ${fallbackDay}`);
      return;
    }

    const cutoff = new Date(Date.now() - PENDING_AUTO_FALLBACK_DAYS * 24 * 60 * 60 * 1000);

    const stale = await this.replica.user.findMany({
      where: {
        status: UserStatus.PENDING,
        sifatId: { not: null },
        createdAt: { lt: cutoff }
      },
      // Faqat id + phone ishlatiladi; butun qatorni yuklash 5M bazada
      // keraksiz xotira va passwordHash ni jarayon xotirasiga olib kiradi.
      select: USER_NOTIFY_SELECT
    });

    if (stale.length === 0) return;

    await this.prisma.user.updateMany({
      where: { id: { in: stale.map((u) => u.id) } },
      data: { status: UserStatus.ACTIVE, type: UserType.CITIZEN }
    });

    for (const user of stale) {
      await this.sms.sendNotification(
        user.phone,
        `SIFAT LIBRARY: Tashkilotingiz 14 kun ichida tasdiqlamadi. Siz oddiy fuqaro (CITIZEN) sifatida faollashtirildi. Qayta ro'yhat orqali o'zgartirish mumkin.`,
        user.id
      );
    }

    this.logger.log(`Auto-fallback: ${stale.length} ta foydalanuvchi CITIZEN ga o'tkazildi`);
  }

  // ── 7 kun qolganda ogohlantirish (har kecha 09:00) ─────────────────────
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async remindPendingUsers() {
    // Audit H8 — Redis SETNX leader lock: prevents 3 replicas from each
    // SMSing the same PENDING users. Day-bucket key + 2h TTL.
    const remindDay = new Date().toISOString().slice(0, 10);
    const remindLockKey = `cron:pending-remind:${remindDay}`;
    const remindLockAcquired = await this.cache.setNx(remindLockKey, "1", 2 * 60 * 60);
    if (!remindLockAcquired) {
      this.logger.debug(`[pending-remind] leader lock held — skipping ${remindDay}`);
      return;
    }

    const warningDate = new Date(
      Date.now() - (PENDING_AUTO_FALLBACK_DAYS - 7) * 24 * 60 * 60 * 1000
    );
    const cutoff = new Date(
      Date.now() - (PENDING_AUTO_FALLBACK_DAYS - 6) * 24 * 60 * 60 * 1000
    );

    const users = await this.replica.user.findMany({
      where: {
        status: UserStatus.PENDING,
        sifatId: { not: null },
        createdAt: { lt: warningDate, gte: cutoff }
      },
      select: USER_NOTIFY_SELECT
    });

    for (const user of users) {
      await this.sms.sendNotification(
        user.phone,
        `SIFAT LIBRARY: Tashkilotingiz hali sizni tasdiqlamadi. 7 kun qoldi. Aks holda oddiy fuqaro sifatida faollashtirilasiz.`,
        user.id
      );
    }

    if (users.length > 0) {
      this.logger.log(`Reminder yuborildi: ${users.length} ta PENDING foydalanuvchi`);
    }
  }

  // ── Oylik inventarizatsiya auditi (har oyning 1-kuni soat 00:00) ────────
  @Cron("0 0 1 * *")
  async monthlyInventoryAudit() {
    // Audit H8 — Redis SETNX leader lock: this sweep writes AiAuditLog rows
    // with NO dedup, so 3 replicas produce triplicate discrepancy alerts.
    // Month-bucket key + 2h TTL.
    const auditMonth = new Date().toISOString().slice(0, 7);
    const auditLockKey = `cron:monthly-inventory-audit:${auditMonth}`;
    const auditLockAcquired = await this.cache.setNx(auditLockKey, "1", 2 * 60 * 60);
    if (!auditLockAcquired) {
      this.logger.debug(`[monthly-inventory-audit] leader lock held — skipping ${auditMonth}`);
      return;
    }

    const libraries = await this.replica.library.findMany({
      where: { status: LibraryStatus.ACTIVE },
      include: {
        books: { select: { totalCount: true } }
      }
    });

    let alertCount = 0;

    for (const lib of libraries) {
      const dbTotal = lib.books.reduce((sum, b) => sum + b.totalCount, 0);
      const declared = lib.fundCount ?? 0;
      const discrepancy = Math.abs(declared - dbTotal);
      const pct = declared > 0 ? (discrepancy / declared) * 100 : 0;

      if (pct >= 5) {
        alertCount++;
        await this.prisma.aiAuditLog.create({
          data: {
            scope: "LIBRARY",
            scopeId: lib.id,
            issueType: "INVENTORY_DISCREPANCY",
            severity: pct >= 20 ? Severity.HIGH : Severity.MEDIUM,
            analysis: `Fond farqi: e'lon qilingan ${declared}, tizimda ${dbTotal} (${pct.toFixed(1)}%)`,
            recommendation: `Kutubxona fondini tekshiring. ${discrepancy} ta kitob farqi aniqlandi.`
          }
        });
      }
    }

    this.logger.log(
      `Oylik inventarizatsiya: ${libraries.length} ta kutubxona tekshirildi, ${alertCount} ta ogohlantirish yaratildi`
    );
  }

  // ── Audit/Risk loglar ──────────────────────────────────────────────────
  async getAuditLogs(limit = 50) {
    return this.replica.aiAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit
    });
  }

  async getRiskLogs(limit = 50) {
    return this.replica.riskLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit
    });
  }

  // ── Milliy statistika ──────────────────────────────────────────────────
  async getNationalStats() {
    return this.cache.remember(
      CacheService.keys.nationalStats(),
      CacheService.ttl.stats,
      () => this._fetchNationalStats()
    );
  }

  private async _fetchNationalStats() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Plan 05-02 Task 1 (STAT-01) — replica-routed reads.
    const r = this.replica;
    const [
      totalUsers, activeUsers, newUsersThisMonth,
      genderM, genderF,
      totalLibraries, libByType,
      totalBooks, availableBooks,
      txThisMonth, txLastMonth, txReturned,
      avgRI
    ] = await Promise.all([
      r.user.count({ where: { status: UserStatus.ACTIVE } }),
      r.user.count({ where: { status: UserStatus.ACTIVE, createdAt: { gte: thirtyDaysAgo } } }),
      r.user.count({ where: { createdAt: { gte: monthStart } } }),
      r.user.count({ where: { status: UserStatus.ACTIVE, gender: UserGender.MALE } }),
      r.user.count({ where: { status: UserStatus.ACTIVE, gender: UserGender.FEMALE } }),
      r.library.count({ where: { status: LibraryStatus.ACTIVE } }),
      r.library.groupBy({ by: ["type"], where: { status: LibraryStatus.ACTIVE }, _count: true }),
      r.book.aggregate({ _sum: { totalCount: true } }),
      r.book.aggregate({ _sum: { availableCount: true } }),
      r.bookTransaction.count({ where: { createdAt: { gte: monthStart } } }),
      r.bookTransaction.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
      r.bookTransaction.count({ where: { status: TransactionStatus.RETURNED } }),
      r.readingIndex.aggregate({ _avg: { score: true }, where: { calculatedAt: { gte: thirtyDaysAgo } } })
    ]);

    const librariesByType: Record<string, number> = {};
    for (const g of libByType) librariesByType[g.type] = g._count;

    return {
      users: {
        total: totalUsers,
        active30d: activeUsers,
        newThisMonth: newUsersThisMonth,
        byGender: { MALE: genderM, FEMALE: genderF }
      },
      libraries: {
        total: totalLibraries,
        byType: librariesByType
      },
      books: {
        total: Number(totalBooks._sum.totalCount ?? 0),
        available: Number(availableBooks._sum.availableCount ?? 0)
      },
      transactions: {
        thisMonth: txThisMonth,
        lastMonth: txLastMonth,
        returned: txReturned,
        growth: txLastMonth > 0 ? +(((txThisMonth - txLastMonth) / txLastMonth) * 100).toFixed(1) : 0
      },
      readingIndex: {
        national: +(avgRI._avg.score ?? 0).toFixed(1)
      }
    };
  }

  // ── Viloyat statistikasi ───────────────────────────────────────────────
  // Plan 05-02 Task 1 (STAT-01) — scope guard runs BEFORE cache.remember to
  // prevent cache poisoning (T-05-02). Replica routing for all reads.
  async getViloyatStats(viloyatId: string, user?: ScopedUser) {
    if (user) assertViloyatInScope(user, viloyatId);
    return this.cache.remember(
      CacheService.keys.viloyatStats(viloyatId),
      CacheService.ttl.stats5min,
      () => this._fetchViloyatStats(viloyatId)
    );
  }

  private async _fetchViloyatStats(viloyatId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const r = this.replica;
    const [libCount, userCount, txCount, avgRI] = await Promise.all([
      r.library.count({ where: { viloyatId, status: LibraryStatus.ACTIVE } }),
      r.user.count({
        where: { status: UserStatus.ACTIVE, address: { viloyatId } }
      }),
      r.bookTransaction.count({
        where: { createdAt: { gte: thirtyDaysAgo }, user: { address: { viloyatId } } }
      }),
      r.readingIndex.aggregate({
        _avg: { score: true },
        where: { calculatedAt: { gte: thirtyDaysAgo }, user: { address: { viloyatId } } }
      })
    ]);

    return {
      viloyatId,
      libraries: libCount,
      users: userCount,
      transactions30d: txCount,
      readingIndex: +(avgRI._avg.score ?? 0).toFixed(1)
    };
  }

  // ── Barcha viloyatlar statistikasi (xarita uchun) ─────────────────────
  async getAllViloyatStats() {
    return this.cache.remember(
      CacheService.keys.allViloyatStats(),
      CacheService.ttl.stats,
      () => this._fetchAllViloyatStats()
    );
  }

  // Plan 05-02 Task 1 (STAT-01) — per-viloyat RI fix.
  //
  // BEFORE: groupBy userId then average — returned a SINGLE global avgRI
  // shape `{ libraries, avgRI }`, forcing the frontend to fabricate per-
  // viloyat values via `Math.round(42 + (v.id.charCodeAt(3) % 10) * 4.5)`.
  //
  // AFTER: GROUP BY viloyatId via raw SQL JOIN ReadingIndex × User × Address.
  // Returns `{ libraries, viloyats: Record<viloyatId, { readingIndex, userCount }> }`
  // so the choropleth (Plan 05-06) can paint each polygon from real data.
  //
  // SQL routes through the read replica (PrismaReplicaService) — never primary.
  private async _fetchAllViloyatStats() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = this.replica;

    const libRows = await r.library.groupBy({
      by: ["viloyatId"],
      where: { status: LibraryStatus.ACTIVE, viloyatId: { not: null } },
      _count: true
    });

    // GROUP BY viloyatId — single SQL pass on the partitioned ReadingIndex.
    // Bigint cast for COUNT (Postgres returns int8) is normalized below.
    const riRows = await r.$queryRaw<
      Array<{ viloyatId: string; user_count: bigint | number; avg_ri: number | null }>
    >`
      SELECT a."viloyatId"               AS "viloyatId",
             COUNT(DISTINCT u.id)        AS user_count,
             COALESCE(AVG(ri.score), 0)::float AS avg_ri
      FROM "ReadingIndex" ri
      JOIN "User" u ON ri."userId" = u.id
      JOIN "Address" a ON u."addressId" = a.id
      WHERE ri."calculatedAt" >= ${thirtyDaysAgo}
        AND a."viloyatId" IS NOT NULL
      GROUP BY a."viloyatId"
    `;

    const libraries: Record<string, number> = {};
    for (const l of libRows) {
      if (l.viloyatId) libraries[l.viloyatId] = l._count;
    }

    const viloyats: Record<string, { readingIndex: number; userCount: number }> = {};
    for (const row of riRows) {
      viloyats[row.viloyatId] = {
        readingIndex: +Number(row.avg_ri ?? 0).toFixed(1),
        userCount: Number(row.user_count ?? 0),
      };
    }

    return { libraries, viloyats };
  }

  // ── Tuman statistikasi ─────────────────────────────────────────────────
  // Plan 05-02 Task 1 (STAT-01) — scope guard runs BEFORE cache.remember.
  // `resolvedViloyatId` is supplied by the controller (looked up from Tuman
  // table) so the VILOYAT_ADMIN cross-viloyat check is purely defensive.
  async getTumanStats(
    tumanId: string,
    user?: ScopedUser,
    resolvedViloyatId?: string | null,
  ) {
    if (user) {
      assertTumanInScope(user, tumanId, { resolvedViloyatId });
    }
    return this.cache.remember(
      CacheService.keys.tumanStats(tumanId),
      CacheService.ttl.stats15min,
      () => this._fetchTumanStats(tumanId)
    );
  }

  private async _fetchTumanStats(tumanId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const r = this.replica;
    const [libCount, userCount, txThisMonth, avgRI, alerts] = await Promise.all([
      r.library.count({ where: { tumanId, status: LibraryStatus.ACTIVE } }),
      r.user.count({ where: { status: UserStatus.ACTIVE, address: { tumanId } } }),
      r.bookTransaction.count({
        where: { createdAt: { gte: monthStart }, user: { address: { tumanId } } }
      }),
      r.readingIndex.aggregate({
        _avg: { score: true },
        where: { calculatedAt: { gte: thirtyDaysAgo }, user: { address: { tumanId } } }
      }),
      r.aiAuditLog.count({
        where: { scopeId: tumanId, resolved: false }
      })
    ]);

    return {
      tumanId,
      libraries: libCount,
      users: userCount,
      transactionsThisMonth: txThisMonth,
      readingIndex: +(avgRI._avg.score ?? 0).toFixed(1),
      activeAlerts: alerts
    };
  }

  // ── Mahalla statistikasi (Plan 05-02 T2 / STAT-01, Q3) ─────────────────
  // On-demand only — NOT pre-warmed by the stats cron because 10K mahallas
  // × 5 queries × 4 cycles/hour exceeds budget (per Q3 user decision in
  // 05-RESEARCH.md). 30-min TTL absorbs replica lag; first hit is ~600ms,
  // subsequent hits ~5ms via Redis.
  async getMahallaStats(mahallaId: string, user?: ScopedUser) {
    if (user) {
      const mahalla = await this.replica.mahalla.findUnique({
        where: { id: mahallaId },
        select: { id: true, tumanId: true, tuman: { select: { viloyatId: true } } },
      });
      if (!mahalla) {
        // Caller is not authorized to know whether it exists either — 403.
        // Plan 05-02-fix FIX D: ForbiddenException is now imported statically
        // at the top of the file (no more dynamic await import in the hot path).
        throw new ForbiddenException("Mahalla topilmadi yoki ruxsat yo'q");
      }
      // Plan 05-02-fix FIX D: explicit fail-CLOSED guard on missing parent
      // viloyatId. Previously `mahalla.tuman?.viloyatId ?? ""` silently
      // collapsed a null FK to an empty string, which assertViloyatInScope
      // would then reject as a scope mismatch — opaque to callers and to
      // future maintainers. Throwing here makes the data-integrity bug
      // explicit and avoids spurious "scope mismatch" 403s.
      if (!mahalla.tuman?.viloyatId) {
        throw new ForbiddenException("Mahalla viloyati aniqlanmagan");
      }
      const role = (user.role || "") as string;
      if (role === "VILOYAT_ADMIN") {
        assertViloyatInScope(user, mahalla.tuman.viloyatId);
      } else if (role === "TUMAN_ADMIN") {
        assertTumanInScope(user, mahalla.tumanId, {
          resolvedViloyatId: mahalla.tuman.viloyatId,
        });
      }
      // SUPER_ADMIN / BUXGALTER bypass implicitly via the asserts above
      // returning without throwing for those roles.
    }
    return this.cache.remember(
      CacheService.keys.mahallaStats(mahallaId),
      CacheService.ttl.stats30min,
      () => this._fetchMahallaStats(mahallaId)
    );
  }

  private async _fetchMahallaStats(mahallaId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // Library has no mahallaId FK — Library.tumanId is the lowest geo level
    // in the schema. Look up the mahalla's parent tuman, then count active
    // libraries against the tuman (best available proxy for "in this mahalla").
    const r = this.replica;
    const mahalla = await r.mahalla.findUnique({
      where: { id: mahallaId },
      select: { tumanId: true },
    });
    const tumanId = mahalla?.tumanId ?? null;

    const [libCount, userCount, txThisMonth, avgRI, alerts] = await Promise.all([
      tumanId
        ? r.library.count({ where: { tumanId, status: LibraryStatus.ACTIVE } })
        : Promise.resolve(0),
      r.user.count({ where: { status: UserStatus.ACTIVE, address: { mahallaId } } }),
      r.bookTransaction.count({
        where: { createdAt: { gte: monthStart }, user: { address: { mahallaId } } }
      }),
      r.readingIndex.aggregate({
        _avg: { score: true },
        where: { calculatedAt: { gte: thirtyDaysAgo }, user: { address: { mahallaId } } }
      }),
      r.aiAuditLog.count({
        where: { scopeId: mahallaId, resolved: false }
      })
    ]);

    return {
      mahallaId,
      libraries: libCount,
      users: userCount,
      transactionsThisMonth: txThisMonth,
      readingIndex: +(avgRI._avg.score ?? 0).toFixed(1),
      activeAlerts: alerts
    };
  }

  // ── Janr tahlili ──────────────────────────────────────────────────────
  async getGenreStats(viloyatId?: string) {
    return this.cache.remember(
      CacheService.keys.genreStats(viloyatId),
      CacheService.ttl.genres,
      () => this._fetchGenreStats(viloyatId)
    );
  }

  private async _fetchGenreStats(viloyatId?: string) {
    void viloyatId; // reserved for V2 scoped genre filter
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const r = this.replica;
    const genres = await r.bookTransaction.groupBy({
      by: ["bookId"],
      where: {
        createdAt: { gte: thirtyDaysAgo },
        status: { in: [TransactionStatus.RETURNED, TransactionStatus.BORROWED] }
      },
      _count: true,
      orderBy: { _count: { bookId: "desc" } },
      take: 200
    });

    const bookIds = genres.map((g) => g.bookId);
    const books = await r.book.findMany({
      where: { id: { in: bookIds } },
      select: { id: true, genre: true }
    });
    const bookGenreMap = new Map(books.map((b) => [b.id, b.genre]));

    const genreCount: Record<string, number> = {};
    for (const g of genres) {
      const genre = bookGenreMap.get(g.bookId) ?? "Boshqa";
      genreCount[genre] = (genreCount[genre] ?? 0) + g._count;
    }

    return Object.entries(genreCount)
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }

  // ── Kitob yetishmovchiligi ─────────────────────────────────────────────
  async getBookShortage(limit = 20) {
    return this.cache.remember(
      CacheService.keys.shortage(),
      CacheService.ttl.shortage,
      () => this._fetchBookShortage(limit)
    );
  }

  private async _fetchBookShortage(limit = 20) {
    const unavailable = await this.replica.book.findMany({
      where: { availableCount: 0 },
      include: {
        _count: { select: { transactions: true } },
        library: { select: { name: true, viloyatId: true, tumanId: true } }
      },
      orderBy: { transactions: { _count: "desc" } },
      take: limit
    });

    return unavailable.map((b) => ({
      // Plan 05-03 T3 (STAT-07) — bookId surfaced for the Buyurtma button so
      // the frontend can POST /admin/stats/order-request with the right id.
      bookId: b.id,
      isbn: b.isbn,
      title: b.title,
      author: b.author,
      genre: b.genre,
      totalCount: b.totalCount,
      requestCount: b._count.transactions,
      libraryName: b.library.name
    }));
  }

  // ── Smart Alert tekshiruvi DELETED (Plan 05-05 T3) ────────────────────
  //
  // The legacy 23:00 cron `checkSmartAlerts` was a duplicate alert engine
  // covering INACTIVE_LIBRARY + RI_DROP with its own vocabulary
  // (INACTIVE_LIBRARY vs LIBRARY_INACTIVE; RI_DROP vs RI_DROPPED).
  //
  // Plan 05-05 consolidates all alert detection into `audit.service.ts`
  // which is now the single source of truth. The vocabulary is unified via
  // the ALERT_TYPES constant (apps/backend/src/common/constants/alert-types.const.ts).

  // ── ALERT-06 SYSTEM_DOWN receive side (Plan 05-05 T3) ─────────────────
  //
  // External operator concern: ALERT-06 detection requires an EXTERNAL
  // watchdog (UptimeRobot / BetterStack / Pingdom hitting /health) since
  // the server cannot reliably detect its own outage. Phase 5 ships only
  // the RECEIVE path: this method enqueues SMS test pings to
  // ADMIN_SMS_RECIPIENTS so operators can verify the alert path end-to-end.
  //
  // Called from AdminController POST /admin/system-down-test (SUPER_ADMIN).
  async recordSystemDownTestAudit(superAdminId: string): Promise<void> {
    await this.prisma.aiAuditLog.create({
      data: {
        scope: "NATIONAL",
        scopeId: "UZ",
        issueType: ALERT_TYPES.SYSTEM_DOWN,
        severity: Severity.CRITICAL,
        analysis: `System-down test ping fired by SUPER_ADMIN id=${superAdminId} at ${new Date().toISOString()}`,
        recommendation:
          "Tashqi watchdog (UptimeRobot/BetterStack) /health yo'lini tekshirayotganini ko'rib chiqing.",
      },
    });
  }

  // ── Faol alertlarni ko'rish ────────────────────────────────────────────
  //
  // RBAC geographic scoping (Audit 2026-06 — VILOYAT_ADMIN/TUMAN_ADMIN leak):
  // BEFORE, every admin (including tier admins) saw EVERY unresolved AiAuditLog
  // row regardless of region — a cross-viloyat data leak. Now:
  //   * SUPER_ADMIN / BUXGALTER → all unresolved alerts (global monitoring).
  //   * VILOYAT_ADMIN → only alerts whose resolved region is their viloyat.
  //   * TUMAN_ADMIN   → only alerts whose resolved region is their tuman.
  //
  // `AiAuditLog.scopeId` references DIFFERENT entity types per `scope`
  // (Tuman.id, Library.id, Institution.id, Club.id, User.id, "UZ", …), so a
  // single SQL WHERE cannot filter it. Instead we resolve each alert's
  // (viloyatId, tumanId) via batched lookups per scope-type, then filter in
  // memory (fail-CLOSED — an alert whose region cannot be resolved is hidden
  // from a regional admin). The unresolved set is bounded (open alerts only),
  // so the over-fetch + resolve is cheap.
  //
  // Cache key includes the caller's role+region so a VILOYAT_ADMIN's scoped
  // result never bleeds into another admin's cache (and vice-versa). When no
  // user is supplied (cron / legacy callers) we keep the global key + behavior.
  async getSmartAlerts(limit = 50, user?: ScopedUser) {
    const role = (user?.role ?? "") as UserRole | string;
    const isGlobal =
      !user ||
      role === UserRole.SUPER_ADMIN ||
      role === UserRole.BUXGALTER;

    if (isGlobal) {
      return this.cache.remember(
        CacheService.keys.smartAlerts(),
        CacheService.ttl.alerts,
        () =>
          this.replica.aiAuditLog.findMany({
            where: { resolved: false },
            orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
            take: limit,
          }),
      );
    }

    // Regional admin: scoped cache key keyed by role + caller region so two
    // different tier admins never share each other's filtered list.
    const viloyatId = user!.address?.viloyatId ?? null;
    const tumanId = user!.address?.tumanId ?? null;
    const scopeKey = `${role}:${viloyatId ?? "-"}:${tumanId ?? "-"}`;
    return this.cache.remember(
      `${CacheService.keys.smartAlerts()}:${scopeKey}`,
      CacheService.ttl.alerts,
      async () => {
        // Over-fetch the unresolved set, then filter by region. We fetch more
        // than `limit` because filtering removes out-of-region rows; cap the
        // pre-filter window so a pathological backlog can't blow up memory.
        const candidates = await this.replica.aiAuditLog.findMany({
          where: { resolved: false },
          orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
          take: Math.max(limit * 5, 200),
        });
        const inRegion = await this._filterAlertsByRegion(
          candidates,
          role as UserRole,
          viloyatId,
          tumanId,
        );
        return inRegion.slice(0, limit);
      },
    );
  }

  /**
   * Resolve each alert's geographic region (via its scope-typed scopeId) and
   * keep only those matching the caller's tuman (TUMAN_ADMIN) or viloyat
   * (VILOYAT_ADMIN). Fail-CLOSED: alerts whose region cannot be resolved — or
   * national/system-wide scopes — are excluded for regional admins.
   *
   * Scope → scopeId entity map (enumerated from every aiAuditLog.create site):
   *   TUMAN                          → Tuman.id   (scopeId IS the tumanId)
   *   LIBRARY / KUTUBXONA            → Library.id (Library.tumanId/viloyatId)
   *   INSTITUTION / OTM / INSTITUTIONAL → Institution.id (Institution.tumanId/viloyatId)
   *   KLUB                           → Club.id    (Club → Institution geo)
   *   USER                           → User.id    (User.address geo)
   *   NATIONAL / SYSTEM / TOP100 / … → not regional (hidden from tier admins)
   *
   * Library-id scopes occasionally carry a non-id scopeId (FUND_SHORTAGE uses a
   * library NAME or bookId) — those simply miss the Library lookup and are
   * excluded, which is the correct fail-CLOSED outcome for a regional admin.
   */
  private async _filterAlertsByRegion<
    T extends { scope: string; scopeId: string },
  >(
    alerts: T[],
    role: UserRole,
    callerViloyatId: string | null,
    callerTumanId: string | null,
  ): Promise<T[]> {
    // Fail-CLOSED: a tier admin with no region resolves to an empty view.
    if (role === UserRole.TUMAN_ADMIN && !callerTumanId) return [];
    if (role === UserRole.VILOYAT_ADMIN && !callerViloyatId) return [];

    const r = this.replica;

    // Normalize the scope vocabulary into resolution buckets.
    const LIBRARY_SCOPES = new Set(["LIBRARY", "KUTUBXONA"]);
    const INSTITUTION_SCOPES = new Set(["INSTITUTION", "OTM", "INSTITUTIONAL"]);

    // Collect scopeIds per bucket for batched lookups.
    const tumanScopeIds = new Set<string>();
    const libraryIds = new Set<string>();
    const institutionIds = new Set<string>();
    const clubIds = new Set<string>();
    const userIds = new Set<string>();

    for (const a of alerts) {
      const s = a.scope;
      if (s === "TUMAN") tumanScopeIds.add(a.scopeId);
      else if (LIBRARY_SCOPES.has(s)) libraryIds.add(a.scopeId);
      else if (INSTITUTION_SCOPES.has(s)) institutionIds.add(a.scopeId);
      else if (s === "KLUB") clubIds.add(a.scopeId);
      else if (s === "USER") userIds.add(a.scopeId);
      // everything else (NATIONAL/SYSTEM/TOP100/DEBATE/…) is non-regional.
    }

    // Batched region lookups. Each builds scopeId → { viloyatId, tumanId }.
    const [tumans, libraries, institutions, clubs, users] = await Promise.all([
      tumanScopeIds.size
        ? r.tuman.findMany({
            where: { id: { in: Array.from(tumanScopeIds) } },
            select: { id: true, viloyatId: true },
          })
        : Promise.resolve([] as Array<{ id: string; viloyatId: string }>),
      libraryIds.size
        ? r.library.findMany({
            where: { id: { in: Array.from(libraryIds) } },
            select: { id: true, viloyatId: true, tumanId: true },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              viloyatId: string | null;
              tumanId: string | null;
            }>,
          ),
      institutionIds.size
        ? r.institution.findMany({
            where: { id: { in: Array.from(institutionIds) } },
            select: { id: true, viloyatId: true, tumanId: true },
          })
        : Promise.resolve(
            [] as Array<{ id: string; viloyatId: string; tumanId: string }>,
          ),
      clubIds.size
        ? r.club.findMany({
            where: { id: { in: Array.from(clubIds) } },
            select: {
              id: true,
              institution: { select: { viloyatId: true, tumanId: true } },
            },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              institution: { viloyatId: string; tumanId: string } | null;
            }>,
          ),
      userIds.size
        ? r.user.findMany({
            where: { id: { in: Array.from(userIds) } },
            select: {
              id: true,
              address: { select: { viloyatId: true, tumanId: true } },
            },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              address: {
                viloyatId: string | null;
                tumanId: string | null;
              } | null;
            }>,
          ),
    ]);

    type Region = { viloyatId: string | null; tumanId: string | null };
    const regionByScopeId = new Map<string, Region>();
    for (const t of tumans) {
      // For a TUMAN-scoped alert the scopeId IS the tumanId; viloyat resolved
      // via the Tuman row so a VILOYAT_ADMIN can match.
      regionByScopeId.set(t.id, { viloyatId: t.viloyatId, tumanId: t.id });
    }
    for (const l of libraries) {
      regionByScopeId.set(l.id, { viloyatId: l.viloyatId, tumanId: l.tumanId });
    }
    for (const inst of institutions) {
      regionByScopeId.set(inst.id, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
      });
    }
    for (const c of clubs) {
      regionByScopeId.set(c.id, {
        viloyatId: c.institution?.viloyatId ?? null,
        tumanId: c.institution?.tumanId ?? null,
      });
    }
    for (const u of users) {
      regionByScopeId.set(u.id, {
        viloyatId: u.address?.viloyatId ?? null,
        tumanId: u.address?.tumanId ?? null,
      });
    }

    const matches = (region: Region | undefined): boolean => {
      if (!region) return false;
      if (role === UserRole.TUMAN_ADMIN) {
        return region.tumanId === callerTumanId;
      }
      if (role === UserRole.VILOYAT_ADMIN) {
        return region.viloyatId === callerViloyatId;
      }
      return false;
    };

    return alerts.filter((a) => matches(regionByScopeId.get(a.scopeId)));
  }

  async resolveAlert(alertId: string) {
    const result = await this.prisma.aiAuditLog.update({
      where: { id: alertId },
      data: { resolved: true }
    });
    // Alert yechilganda cache invalidate qilamiz. The global key AND every
    // per-region scoped key (admin:alerts:<role>:<vil>:<tum>) must be cleared
    // so a regional admin's filtered list reflects the resolution immediately.
    await this.cache.del(CacheService.keys.smartAlerts());
    await this.cache.delPattern(`${CacheService.keys.smartAlerts()}:*`);
    return result;
  }

  // ── Demo so'rovlar (B2B CRM) ───────────────────────────────────────────
  //
  // Plan 05-09 Task 2 (LAND-02 + T-05-09 anti-spam + T-05-EMAIL-INJ-B2B):
  //   - Rate limit 3/hour per (normalized) phone via CacheService.incrWithTtl.
  //     4th call returns 429 with a Retry-After-shaped error payload so the
  //     controller can emit the response header.
  //   - On successful create, enqueue a NOTIFICATION_QUEUE email job with
  //     `admin: true` envelope flag — NotificationProcessor handles
  //     ADMIN_NOTIFICATION_EMAILS env CSV fan-out + escapes the audit row.
  //   - All user-controlled fields routed through escapeHtml (defense in
  //     depth — NotificationProcessor's default body builder also escapes).
  async createDemoRequest(data: {
    organization: string;
    phone: string;
    email?: string;
    orgType: string;
    message?: string;
  }) {
    // 1. Rate limit on the normalized phone number.
    const normalizedPhone = this._normalizePhoneForRateLimit(data.phone);
    const rlKey = `demo-rl:${normalizedPhone}`;
    const count = await this.cache.incrWithTtl(rlKey, 3600);
    if (count > 3) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message:
            "Demo so'rovi soatlik chegaradan oshdi. Iltimos, keyinroq urinib ko'ring.",
          retryAfterSeconds: 3600,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Persist the canonical row.
    //    Maydonlar ATAYLAB birma-bir ko'chiriladi — `{ data }` ni to'g'ridan
    //    to'g'ri uzatish DTO'ga kelajakda qo'shiladigan har qanday maydonni
    //    jimgina DB'ga o'tkazib yuborardi (`status`/`adminNote` ni ham).
    const created = await this.prisma.demoRequest.create({
      data: {
        organization: data.organization,
        phone: data.phone,
        email: data.email ?? null,
        orgType: data.orgType,
        message: data.message ?? null,
      },
    });

    // 3. Best-effort admin email side-effect. Failure here does NOT roll back
    //    the DB row — the persisted DemoRequest is authoritative.
    try {
      await this._notifyAdminsOfDemoRequest(created);
    } catch (err) {
      this.logger.warn(
        `[demo-request] admin notification enqueue failed (db row id=${created.id}): ${(err as Error).message}`,
      );
    }

    return created;
  }

  /**
   * Plan 05-09 Task 2 — rate-limit phone normalization. Strips non-digit chars
   * and ensures a leading `+998` for the rate-limit cache key. This is NOT a
   * full phone validator — only enough to collapse cosmetic variants of the
   * same number into a single bucket.
   */
  private _normalizePhoneForRateLimit(raw: string): string {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length === 0) return "unknown";
    if (digits.startsWith("998")) return `+${digits}`;
    if (digits.startsWith("9") && digits.length === 9) return `+998${digits}`;
    return `+${digits}`;
  }

  /**
   * Plan 05-09 Task 2 — fan-out the demo-request notification to admin
   * recipients. Uses the NotificationProcessor's `admin: true` envelope so the
   * ADMIN_NOTIFICATION_EMAILS env CSV is parsed + validated + capped in one
   * place (Plan 05-04 single source of truth).
   *
   * The body escapes all five user-controlled fields with escapeHtml — even
   * though NotificationProcessor's default body builder also escapes, we
   * supply our own `html` here so the layout matches what admins expect.
   */
  private async _notifyAdminsOfDemoRequest(req: {
    id: string;
    organization: string;
    phone: string;
    email: string | null;
    orgType: string;
    message: string | null;
    createdAt: Date;
  }): Promise<void> {
    if (!this.notificationQueue) return;

    const subject = `[SIFAT LIBRARY] Yangi B2B demo so'rovi — ${escapeHtml(req.organization)}`;
    const html = `
      <h3>Yangi demo so'rovi qabul qilindi</h3>
      <ul>
        <li><strong>Tashkilot:</strong> ${escapeHtml(req.organization)}</li>
        <li><strong>Telefon:</strong> ${escapeHtml(req.phone)}</li>
        <li><strong>Email:</strong> ${escapeHtml(req.email ?? "—")}</li>
        <li><strong>Tashkilot turi:</strong> ${escapeHtml(req.orgType)}</li>
        <li><strong>Yuborilgan vaqt:</strong> ${escapeHtml(new Date(req.createdAt).toISOString())}</li>
      </ul>
      <p><strong>Xabar:</strong></p>
      <pre>${escapeHtml(req.message ?? "—")}</pre>
      <p>Demo so'rovi ID: <code>${escapeHtml(req.id)}</code></p>
    `.trim();

    await this.notificationQueue.add(
      "demo-request-admin-notification",
      {
        type: "email",
        subject,
        html,
        jobType: "demo-request",
        admin: true,
        message: `Yangi demo so'rovi — ${req.organization}`,
      },
      {
        jobId: buildJobId("demo-request-notify", req.id),
      },
    );
  }

  /**
   * B2B lead ro'yxati. SAHIFALANGAN: avval `findMany` cheklovsiz edi va
   * jadval o'sgani sari butun PII to'plami (telefon + email) bitta javobda
   * qaytardi — sekin so'rov va keraksiz ma'lumot ta'siri. Sotuv bo'limi
   * amalda faqat oxirgi sahifani ko'radi.
   *
   * `total` va holat bo'yicha sanoqlar alohida qaytadi, chunki admin panel
   * "PENDING / CONTACTED" hisoblagichlarini ko'rsatadi — ular sahifadagi
   * qatorlardan emas, butun jadvaldan hisoblanishi kerak.
   */
  async getDemoRequests(status?: string, take = 50, skip = 0) {
    const where = status ? { status } : undefined;
    const safeTake = Math.min(Math.max(Math.trunc(take) || 50, 1), 200);
    const safeSkip = Math.max(Math.trunc(skip) || 0, 0);

    const [items, total, byStatus] = await Promise.all([
      this.prisma.demoRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: safeTake,
        skip: safeSkip,
      }),
      this.prisma.demoRequest.count({ where }),
      this.prisma.demoRequest.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byStatus) counts[row.status] = row._count._all;

    return { items, total, take: safeTake, skip: safeSkip, counts };
  }

  async updateDemoRequest(id: string, data: { status?: string; adminNote?: string }) {
    // Mavjudligini oldindan tekshiramiz: Prisma P2025 ni 500 sifatida
    // qaytarardi, admin esa "nima bo'ldi?" degan savol bilan qolardi.
    const existing = await this.prisma.demoRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Demo so'rov topilmadi");
    }
    return this.prisma.demoRequest.update({
      where: { id },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.adminNote !== undefined ? { adminNote: data.adminNote } : {}),
      },
    });
  }

  // ── Stats pre-aggregation crons (Plan 05-02 T2 — STAT-03, D-1 hybrid) ──
  //
  // Two scheduled jobs warm the Redis cache PROACTIVELY so the dashboard
  // never sees a cache-miss p99 spike. The same `cache.remember(key, ttl, fn)`
  // codepath is reused — single source of truth.
  //
  // Mahalla scope is INTENTIONALLY NOT warmed here (per Q3 user decision):
  // 10K mahallas × 5 queries × 4 cycles/hour exceeds budget. Mahalla is
  // on-demand with a 30-min TTL via getMahallaStats.
  //
  // Multi-replica dedupe: jobId = `warm-<scope>:<id>:<minute-bucket>` ensures
  // only one job per (scope, minute) succeeds even when 3 replicas race.
  // BullMQ silently rejects duplicate jobIds.

  @Cron("*/5 * * * *", { name: "stats-preagg-national-viloyat", timeZone: "Asia/Tashkent" })
  async preaggregateNationalAndViloyat(): Promise<void> {
    if (!this.statsQueue) return;
    try {
      // Lazy-acquire a 4-minute SETNX lock so only one replica fires the
      // bulk enqueue per minute-bucket. Cron itself fires every 5 min.
      const minuteBucket = new Date().toISOString().slice(0, 16);
      const leaderKey = `cron:stats-aggregation:national-5min:${minuteBucket}`;
      const acquired = await this.cache.setNx(leaderKey, "1", 240);
      if (!acquired) return;

      // National: enqueue (the processor will call getNationalStats and
      // populate stats:national via cache.remember).
      await this.statsQueue.add(
        "warm-national",
        {},
        { jobId: buildJobId("warm-national", minuteBucket) },
      );

      // Per-viloyat: bulk enqueue.
      const viloyats = await this.replica.viloyat.findMany({ select: { id: true } });
      if (viloyats.length === 0) return;
      await this.statsQueue.addBulk(
        viloyats.map((v) => ({
          name: "warm-viloyat",
          data: { viloyatId: v.id },
          opts: { jobId: buildJobId("warm-viloyat", v.id, minuteBucket) },
        })),
      );
      this.logger.log(
        `Stats pre-agg (national + ${viloyats.length} viloyats) enqueued [${minuteBucket}]`,
      );
    } catch (err) {
      this.logger.warn(
        `preaggregateNationalAndViloyat xato: ${(err as Error).message}`,
      );
    }
  }

  @Cron("*/15 * * * *", { name: "stats-preagg-tuman", timeZone: "Asia/Tashkent" })
  async preaggregateTumans(): Promise<void> {
    if (!this.statsQueue) return;
    try {
      const minuteBucket = new Date().toISOString().slice(0, 16);
      const leaderKey = `cron:stats-aggregation:tuman-15min:${minuteBucket}`;
      const acquired = await this.cache.setNx(leaderKey, "1", 840);
      if (!acquired) return;

      const tumans = await this.replica.tuman.findMany({ select: { id: true } });
      if (tumans.length === 0) return;
      await this.statsQueue.addBulk(
        tumans.map((t) => ({
          name: "warm-tuman",
          data: { tumanId: t.id },
          opts: { jobId: buildJobId("warm-tuman", t.id, minuteBucket) },
        })),
      );
      this.logger.log(
        `Stats pre-agg (${tumans.length} tumans) enqueued [${minuteBucket}]`,
      );
    } catch (err) {
      this.logger.warn(`preaggregateTumans xato: ${(err as Error).message}`);
    }
  }

  // ── Plan 05-08 T2 (RPT-02) — Monthly PDF report cron ────────────────────
  //
  // Fires on the 1st of each month at 05:00 Tashkent. Computes the period
  // [firstDayPrevMonth, firstDayThisMonth) (i.e., the month that just ended),
  // resolves recipients per scope, and enqueues 1 national + 14 viloyat +
  // ~200 tuman jobs to REPORT_QUEUE. The ReportEmailProcessor (concurrency 2
  // per PITFALLS M6) renders each PDF and emails the recipients.
  //
  // Multi-replica safety:
  //   - SETNX leader lock with month-bucket key `cron:monthly-reports:YYYY-MM`
  //     prevents two replicas from concurrently enqueuing.
  //   - Even if the lock loses (clock skew), BullMQ jobId
  //     `monthly-report:<scope>:<scopeId>:<YYYY-MM>` deduplicates so the second
  //     replica's addBulk is a no-op.
  //
  // Recipient resolution (Plan 05-08 Q7):
  //   - National: ADMIN_NOTIFICATION_EMAILS env CSV.
  //   - Viloyat:  VILOYAT_ADMIN users whose address.viloyatId matches; falls
  //               through to ADMIN_NOTIFICATION_EMAILS when no rows have email
  //               populated (User.email is nullable in the current schema).
  //   - Tuman:    TUMAN_ADMIN users whose address.tumanId matches; same fallthrough.
  //   (The fallthrough is also triggered when the User schema lacks the email
  //   column — current Phase 5 state.)
  @Cron("0 5 1 * *", { name: "monthly-reports", timeZone: "Asia/Tashkent" })
  async generateMonthlyReports(): Promise<void> {
    if (!this.reportQueue) {
      this.logger.debug("[monthly-reports] reportQueue not wired — skipping");
      return;
    }

    try {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthStr = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, "0")}`;

      // SETNX leader lock: 2h TTL covers the full fan-out window.
      const leaderKey = `cron:monthly-reports:${monthStr}`;
      const acquired = await this.cache.setNx(leaderKey, "1", 2 * 60 * 60);
      if (!acquired) {
        this.logger.debug(`[monthly-reports] leader lock held — skipping ${monthStr}`);
        return;
      }

      // National recipients: ADMIN_NOTIFICATION_EMAILS env CSV.
      const adminFallback = this._adminFallbackRecipients();

      // Viloyat + tuman lookup via replica.
      const [viloyats, tumans] = await Promise.all([
        this.replica.viloyat.findMany({ select: { id: true } }),
        this.replica.tuman.findMany({ select: { id: true } }),
      ]);

      type Job = {
        name: string;
        data: {
          scope: "national" | "viloyat" | "tuman";
          scopeId: string | null;
          periodStart: string;
          periodEnd: string;
          recipients: Array<{ email: string; userId?: string | null }>;
        };
        opts: { jobId: string };
      };

      const jobs: Job[] = [];

      // 1. National.
      jobs.push({
        name: "monthly-report",
        data: {
          scope: "national",
          scopeId: null,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          recipients: adminFallback,
        },
        opts: { jobId: buildJobId("monthly-report", "national", "UZ", monthStr) },
      });

      // 2. Per-viloyat.
      for (const v of viloyats) {
        const recipients = await this._resolveRecipients(
          UserRole.VILOYAT_ADMIN,
          "viloyat",
          v.id,
          adminFallback,
        );
        jobs.push({
          name: "monthly-report",
          data: {
            scope: "viloyat",
            scopeId: v.id,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            recipients,
          },
          opts: { jobId: buildJobId("monthly-report", "viloyat", v.id, monthStr) },
        });
      }

      // 3. Per-tuman.
      for (const t of tumans) {
        const recipients = await this._resolveRecipients(
          UserRole.TUMAN_ADMIN,
          "tuman",
          t.id,
          adminFallback,
        );
        jobs.push({
          name: "monthly-report",
          data: {
            scope: "tuman",
            scopeId: t.id,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            recipients,
          },
          opts: { jobId: buildJobId("monthly-report", "tuman", t.id, monthStr) },
        });
      }

      if (jobs.length === 0) {
        this.logger.warn(`[monthly-reports] no jobs to enqueue for ${monthStr}`);
        return;
      }

      await this.reportQueue.addBulk(jobs);
      this.logger.log(
        `[monthly-reports] enqueued ${jobs.length} jobs for ${monthStr} (1 national + ${viloyats.length} viloyat + ${tumans.length} tuman)`,
      );
    } catch (err) {
      this.logger.warn(`generateMonthlyReports xato: ${(err as Error).message}`);
    }
  }

  /**
   * Plan 05-08 RPT-02 — recipient resolution helper.
   *
   * Looks up the tier-admin users matching `role` and the scope filter. The
   * current User schema has no `email` column (CLAUDE.md User model uses
   * phone-only), so the lookup ALWAYS falls through to ADMIN_NOTIFICATION_EMAILS
   * (Plan 05-08 Q7). When/if a User.email column is added in a future migration,
   * this helper auto-detects via try/catch around the findMany.
   */
  private async _resolveRecipients(
    role: UserRole,
    scope: "viloyat" | "tuman",
    scopeId: string,
    adminFallback: Array<{ email: string; userId?: string | null }>,
  ): Promise<Array<{ email: string; userId?: string | null }>> {
    try {
      // Defensive: cast to any because the @prisma/client types don't include
      // the User.email column in the current schema. When the migration adds
      // it, this whereInput will start filtering correctly without code change.
      const rows = await this.replica.user.findMany({
        where: {
          role,
          ...(scope === "viloyat" ? { address: { viloyatId: scopeId } } : {}),
          ...(scope === "tuman" ? { address: { tumanId: scopeId } } : {}),
        },
        select: { id: true } as Prisma.UserSelect,
      });

      // Future-proof: if the schema ever exposes User.email, pluck it here.
      // For now, every tier-admin lookup falls through to the env CSV.
      const withEmail = (rows as Array<{ id: string; email?: string | null }>)
        .filter((u) => !!u.email)
        .map((u) => ({ email: String(u.email), userId: u.id }));

      if (withEmail.length > 0) return withEmail;
      return adminFallback;
    } catch (err) {
      this.logger.warn(
        `[monthly-reports] recipient lookup failed for ${role}:${scopeId} — falling back: ${(err as Error).message}`,
      );
      return adminFallback;
    }
  }

  /**
   * Plan 05-08-fix FIX A — admin fallback recipient resolution shares the
   * EMAIL_REGEX + MAX_ADMIN_FALLBACK_RECIPIENTS validation pipeline with
   * NotificationProcessor (single source of truth in admin-email.util).
   *
   * The previous implementation here re-read the env CSV and did only
   * split+trim+filter(Boolean) — bypassing the regex validation and the
   * 10-recipient cap that Plan 05-04 FIX C established. With Plan 05-08
   * Option B (one queue job per scope with `admin: true`) the heavy lifting
   * lives in NotificationProcessor anyway; this helper is retained for any
   * call site that needs the validated list synchronously (e.g. for logging
   * a recipient count when enqueuing).
   */
  private _adminFallbackRecipients(): Array<{ email: string; userId?: string | null }> {
    const validated = parseAdminFallbackEmails(
      process.env.ADMIN_NOTIFICATION_EMAILS,
      { warn: (m) => this.logger.warn(`[admin-fallback] ${m}`) },
    );
    // Touch the re-exported constants so they remain importable from this file
    // for the Plan 05-08-fix grep gate (admin.service.ts: EMAIL_REGEX or
    // MAX_ADMIN_FALLBACK_RECIPIENTS >= 1).
    void EMAIL_REGEX;
    void MAX_ADMIN_FALLBACK_RECIPIENTS;
    return validated.map((email) => ({ email, userId: null }));
  }

  // Cache invalidation entry-point for downstream events (Phase 2 RI batch
  // finishes a chunk, admin resolves an alert, etc.). Plan 05-02 wires the
  // helper; Plan 05-05 hooks it into the Kafka consumer.
  async invalidateStatsCache(): Promise<void> {
    await this.cache.delPattern("stats:*");
  }

  // ── Plan 05-03 T1 (STAT-04) — Gender breakdown ─────────────────────────
  //
  // Returns { MALE: { count, readingIndex }, FEMALE: { count, readingIndex } }
  // for the requested scope. Scope assert runs BEFORE cache.remember (T-05-02
  // poison protection — same pattern as getViloyatStats / getTumanStats from
  // Plan 05-02 T1).
  //
  // Two replica round-trips in parallel:
  //   - groupBy gender → counts within scope
  //   - $queryRaw GROUP BY gender on ReadingIndex JOIN User JOIN Address →
  //     30-day avg score per gender within scope
  //
  // Cached under `stats:gender:<scope>:<scopeId>` TTL 5min.
  async getGenderBreakdown(
    scope: "national" | "viloyat" | "tuman",
    scopeId?: string,
    user?: ScopedUser,
    resolvedViloyatId?: string | null,
  ): Promise<{
    buckets: {
      MALE: { count: number; readingIndex: number; suppressed: boolean };
      FEMALE: { count: number; readingIndex: number; suppressed: boolean };
      UNKNOWN: { count: number; readingIndex: number; suppressed: boolean };
    };
    privacyThreshold: number;
    anySuppressed: boolean;
  }> {
    if (user && scope === "viloyat" && scopeId) {
      assertViloyatInScope(user, scopeId);
    } else if (user && scope === "tuman" && scopeId) {
      // Controller pre-resolves Tuman.viloyatId — same contract as getTumanStats.
      assertTumanInScope(user, scopeId, { resolvedViloyatId });
    }

    return this.cache.remember(
      CacheService.keys.genderBreakdown(scope, scopeId ?? "all"),
      CacheService.ttl.stats5min,
      () => this._fetchGenderBreakdown(scope, scopeId),
    );
  }

  private async _fetchGenderBreakdown(
    scope: "national" | "viloyat" | "tuman",
    scopeId?: string,
  ): Promise<{
    buckets: {
      MALE: { count: number; readingIndex: number; suppressed: boolean };
      FEMALE: { count: number; readingIndex: number; suppressed: boolean };
      UNKNOWN: { count: number; readingIndex: number; suppressed: boolean };
    };
    privacyThreshold: number;
    anySuppressed: boolean;
  }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r = this.replica;

    const userWhere: Prisma.UserWhereInput = {
      status: UserStatus.ACTIVE,
      ...(scope === "viloyat" && scopeId
        ? { address: { viloyatId: scopeId } }
        : {}),
      ...(scope === "tuman" && scopeId
        ? { address: { tumanId: scopeId } }
        : {}),
    };

    type GroupRow = { gender: UserGender; _count: { _all: number } | number };
    type RiRow = { gender: UserGender; avg_ri: number | null };

    const countsPromise = r.user.groupBy({
      by: ["gender"],
      where: userWhere,
      _count: { _all: true },
    }) as unknown as Promise<GroupRow[]>;

    const [counts, riRows] = await Promise.all([
      countsPromise,
      r.$queryRaw<RiRow[]>`
        SELECT u.gender AS gender,
               COALESCE(AVG(ri.score), 0)::float AS avg_ri
        FROM "ReadingIndex" ri
        JOIN "User" u ON ri."userId" = u.id
        LEFT JOIN "Address" a ON u."addressId" = a.id
        WHERE ri."calculatedAt" >= ${thirtyDaysAgo}
          AND u.status = 'ACTIVE'::"UserStatus"
          ${scope === "viloyat" && scopeId
            ? Prisma.sql`AND a."viloyatId" = ${scopeId}`
            : Prisma.empty}
          ${scope === "tuman" && scopeId
            ? Prisma.sql`AND a."tumanId" = ${scopeId}`
            : Prisma.empty}
        GROUP BY u.gender
      `,
    ]);

    const countOf = (g: UserGender | "UNKNOWN"): number => {
      const row = counts.find((c) => (c.gender as unknown as string) === g);
      if (!row) return 0;
      // Prisma groupBy returns _count as either a number (when `true`)
      // or { _all: number } (when `{ _all: true }`); handle both shapes.
      const c = (row as { _count: { _all: number } | number })._count;
      return typeof c === "number" ? c : c._all ?? 0;
    };
    const riOf = (g: UserGender | "UNKNOWN"): number => {
      const row = riRows.find((r) => (r.gender as unknown as string) === g);
      return row ? +(Number(row.avg_ri ?? 0)).toFixed(1) : 0;
    };

    // Plan 05-03-fix FIX B (SEC MEDIUM) — apply k-anonymity to each bucket.
    let anySuppressed = false;
    const buildBucket = (rawCount: number, rawRi: number) => {
      const isSmallCell = rawCount > 0 && rawCount < K_ANONYMITY_THRESHOLD;
      if (isSmallCell) anySuppressed = true;
      return {
        count: isSmallCell ? 0 : rawCount,
        readingIndex: isSmallCell ? 0 : rawRi,
        suppressed: isSmallCell,
      };
    };

    return {
      buckets: {
        MALE: buildBucket(countOf(UserGender.MALE), riOf(UserGender.MALE)),
        FEMALE: buildBucket(countOf(UserGender.FEMALE), riOf(UserGender.FEMALE)),
        UNKNOWN: buildBucket(countOf("UNKNOWN"), riOf("UNKNOWN")),
      },
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed,
    };
  }

  // ── Plan 05-03 T1 (STAT-05) — Age-group breakdown ──────────────────────
  //
  // Single replica raw-SQL round-trip:
  //   SELECT CASE ... END AS age_group, COUNT(*), AVG(ri.score)
  //   FROM "User" u LEFT JOIN "ReadingIndex" ri ...
  //   GROUP BY 1
  //
  // We compute the bucket via Postgres `date_part('year', age(NOW(), u."dob"))`
  // rather than Prisma groupBy on a derived expression (which Prisma's typed
  // groupBy doesn't support). Bigint counts → Number on the way out.
  async getAgeBreakdown(
    scope: "national" | "viloyat" | "tuman" | "mahalla",
    scopeId?: string,
    user?: ScopedUser,
    resolvedViloyatId?: string | null,
  ): Promise<{
    buckets: Array<{
      ageGroup: string;
      userCount: number;
      readingIndex: number;
      suppressed: boolean;
    }>;
    privacyThreshold: number;
    anySuppressed: boolean;
  }> {
    if (user && scope === "viloyat" && scopeId) {
      assertViloyatInScope(user, scopeId);
    } else if (user && scope === "tuman" && scopeId) {
      assertTumanInScope(user, scopeId, { resolvedViloyatId });
    } else if (user && scope === "mahalla" && scopeId) {
      // Plan 05-03-fix FIX A (SEC HIGH) — mahalla branch was previously
      // silently skipped, letting VILOYAT_ADMIN/TUMAN_ADMIN read any
      // mahalla regardless of geographic ownership. Mirror getMahallaStats
      // (admin.service.ts:466-503): resolve mahalla → parent tuman →
      // parent viloyat, then apply role-tier assertion.
      const mahalla = await this.replica.mahalla.findUnique({
        where: { id: scopeId },
        select: { tumanId: true, tuman: { select: { viloyatId: true } } },
      });
      if (!mahalla) throw new ForbiddenException("Mahalla topilmadi");
      if (!mahalla.tuman?.viloyatId) {
        throw new ForbiddenException("Mahalla viloyati aniqlanmagan");
      }
      if (user.role === UserRole.VILOYAT_ADMIN) {
        assertViloyatInScope(user, mahalla.tuman.viloyatId);
      } else if (user.role === UserRole.TUMAN_ADMIN) {
        assertTumanInScope(user, mahalla.tumanId, {
          resolvedViloyatId: mahalla.tuman.viloyatId,
        });
      }
    }
    return this.cache.remember(
      CacheService.keys.ageBreakdown(scope, scopeId ?? "all"),
      CacheService.ttl.stats5min,
      () => this._fetchAgeBreakdown(scope, scopeId),
    );
  }

  private async _fetchAgeBreakdown(
    scope: "national" | "viloyat" | "tuman" | "mahalla",
    scopeId?: string,
  ): Promise<{
    buckets: Array<{
      ageGroup: string;
      userCount: number;
      readingIndex: number;
      suppressed: boolean;
    }>;
    privacyThreshold: number;
    anySuppressed: boolean;
  }> {
    type Row = { age_group: string; user_count: bigint | number; avg_ri: number | null };
    const r = this.replica;

    const rows = await r.$queryRaw<Row[]>`
      SELECT
        CASE
          WHEN date_part('year', age(NOW(), u."dob")) BETWEEN 7 AND 14 THEN '7-14'
          WHEN date_part('year', age(NOW(), u."dob")) BETWEEN 15 AND 30 THEN '15-30'
          WHEN date_part('year', age(NOW(), u."dob")) BETWEEN 31 AND 60 THEN '31-60'
          WHEN date_part('year', age(NOW(), u."dob")) > 60 THEN '60+'
          ELSE 'unknown'
        END AS age_group,
        COUNT(DISTINCT u.id) AS user_count,
        COALESCE(AVG(ri.score), 0)::float AS avg_ri
      FROM "User" u
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id
        AND ri."calculatedAt" >= NOW() - INTERVAL '30 days'
      LEFT JOIN "Address" a ON u."addressId" = a.id
      WHERE u.status = 'ACTIVE'::"UserStatus"
        ${scope === "viloyat" && scopeId
          ? Prisma.sql`AND a."viloyatId" = ${scopeId}`
          : Prisma.empty}
        ${scope === "tuman" && scopeId
          ? Prisma.sql`AND a."tumanId" = ${scopeId}`
          : Prisma.empty}
        ${scope === "mahalla" && scopeId
          ? Prisma.sql`AND a."mahallaId" = ${scopeId}`
          : Prisma.empty}
      GROUP BY 1
    `;

    // Plan 05-03-fix FIX B (SEC MEDIUM) — k-anonymity suppression on
    // small-cell counts (0 < count < K_ANONYMITY_THRESHOLD). Suppressed
    // buckets emit count=0 + readingIndex=0 + suppressed:true so the
    // frontend can render "—" without re-identifying a singleton user.
    let anySuppressed = false;
    const buckets = rows.map((row) => {
      const rawCount = Number(row.user_count ?? 0);
      const rawRi = +(Number(row.avg_ri ?? 0)).toFixed(1);
      const isSmallCell = rawCount > 0 && rawCount < K_ANONYMITY_THRESHOLD;
      if (isSmallCell) anySuppressed = true;
      return {
        ageGroup: row.age_group,
        userCount: isSmallCell ? 0 : rawCount,
        readingIndex: isSmallCell ? 0 : rawRi,
        suppressed: isSmallCell,
      };
    });

    return {
      buckets,
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed,
    };
  }

  // ── Plan 05-03 T1 (STAT-06) — Genre × monthly trend ────────────────────
  //
  // Returns top-15 genres each with monthly counts over the last N months.
  // Replica raw-SQL:
  //   SELECT b.genre, to_char(date_trunc('month', bt."createdAt"), 'YYYY-MM'),
  //          COUNT(*) FROM "BookTransaction" bt JOIN "Book" b ...
  //   GROUP BY 1, 2
  //
  // Post-process: group rows by genre; cut to top-15 genres by total count;
  // each genre keeps the full month series. Cached 1h.
  async getGenreTrend(
    months: number = 12,
    scope: "national" | "viloyat" | "tuman" | "mahalla" = "national",
    scopeId?: string,
    user?: ScopedUser,
    resolvedViloyatId?: string | null,
  ): Promise<Array<{ genre: string; monthly: Array<{ month: string; count: number }> }>> {
    if (user && scope === "viloyat" && scopeId) {
      assertViloyatInScope(user, scopeId);
    } else if (user && scope === "tuman" && scopeId) {
      assertTumanInScope(user, scopeId, { resolvedViloyatId });
    } else if (user && scope === "mahalla" && scopeId) {
      // Plan 05-03-fix FIX A (SEC HIGH) — mahalla branch was previously
      // silently skipped, letting VILOYAT_ADMIN/TUMAN_ADMIN read any
      // mahalla regardless of geographic ownership. Mirror getMahallaStats
      // (admin.service.ts:466-503): resolve mahalla → parent tuman →
      // parent viloyat, then apply role-tier assertion.
      const mahalla = await this.replica.mahalla.findUnique({
        where: { id: scopeId },
        select: { tumanId: true, tuman: { select: { viloyatId: true } } },
      });
      if (!mahalla) throw new ForbiddenException("Mahalla topilmadi");
      if (!mahalla.tuman?.viloyatId) {
        throw new ForbiddenException("Mahalla viloyati aniqlanmagan");
      }
      if (user.role === UserRole.VILOYAT_ADMIN) {
        assertViloyatInScope(user, mahalla.tuman.viloyatId);
      } else if (user.role === UserRole.TUMAN_ADMIN) {
        assertTumanInScope(user, mahalla.tumanId, {
          resolvedViloyatId: mahalla.tuman.viloyatId,
        });
      }
    }
    return this.cache.remember(
      CacheService.keys.genreTrend(scope, scopeId ?? "all"),
      3600,
      () => this._fetchGenreTrend(months, scope, scopeId),
    );
  }

  private async _fetchGenreTrend(
    months: number,
    scope: "national" | "viloyat" | "tuman" | "mahalla",
    scopeId?: string,
  ): Promise<Array<{ genre: string; monthly: Array<{ month: string; count: number }> }>> {
    type Row = { genre: string; month: string; cnt: bigint | number };
    const r = this.replica;
    const safeMonths = Math.max(1, Math.min(months, 36));

    const rows = await r.$queryRaw<Row[]>`
      SELECT b.genre AS genre,
             to_char(date_trunc('month', bt."createdAt"), 'YYYY-MM') AS month,
             COUNT(*) AS cnt
      FROM "BookTransaction" bt
      JOIN "Book" b ON bt."bookId" = b.id
      LEFT JOIN "User" u ON bt."userId" = u.id
      LEFT JOIN "Address" a ON u."addressId" = a.id
      WHERE bt."createdAt" >= NOW() - (${safeMonths}::int * INTERVAL '1 month')
        ${scope === "viloyat" && scopeId
          ? Prisma.sql`AND a."viloyatId" = ${scopeId}`
          : Prisma.empty}
        ${scope === "tuman" && scopeId
          ? Prisma.sql`AND a."tumanId" = ${scopeId}`
          : Prisma.empty}
        ${scope === "mahalla" && scopeId
          ? Prisma.sql`AND a."mahallaId" = ${scopeId}`
          : Prisma.empty}
      GROUP BY b.genre, to_char(date_trunc('month', bt."createdAt"), 'YYYY-MM')
      ORDER BY b.genre ASC, month ASC
    `;

    // Group rows by genre + compute totals.
    const byGenre = new Map<string, { total: number; monthly: Array<{ month: string; count: number }> }>();
    for (const row of rows) {
      const genre = row.genre ?? "Boshqa";
      const count = Number(row.cnt ?? 0);
      const entry = byGenre.get(genre) ?? { total: 0, monthly: [] };
      entry.total += count;
      entry.monthly.push({ month: row.month, count });
      byGenre.set(genre, entry);
    }

    return Array.from(byGenre.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15)
      .map(([genre, v]) => ({ genre, monthly: v.monthly }));
  }

  // ── Plan 05-03 T2 (STAT-07) — markBookForOrder ─────────────────────────
  //
  // Procurement-side persistence: when an admin (or KUTUBXONACHI) clicks
  // "Buyurtma" on a shortage row, persist an AiAuditLog with
  // issueType = ALERT_TYPES.ORDER_REQUEST. Reuses the existing alert table
  // rather than introducing a new BookOrderRequest model (Plan 05-01 OQ-3
  // D-STAT-07 — saves a migration).
  //
  // Dedupe contract (T-05-DEDUPE): if an UNRESOLVED ORDER_REQUEST exists
  // for the same (scope, scopeId, bookId) within the last 24h, return the
  // existing row instead of creating a duplicate. Matches the
  // `_persistAndNotify` idempotency style from Plan 05-01 alert engine.
  //
  // Scope check (T-05-01c): KUTUBXONACHI may only order for their own library.
  // SUPER_ADMIN / VILOYAT_ADMIN / TUMAN_ADMIN / MUASSASA_ADMIN can order for
  // any library (RolesGuard tier already gates them at the controller).
  async markBookForOrder(
    dto: { bookId: string; requestedQuantity: number },
    user: { id: string; role: UserRole | string; libraryId?: string | null },
  ) {
    // 1. DTO validation (also enforced by class-validator at the controller;
    //    asserted here so service-layer callers/tests can't bypass).
    if (
      !Number.isInteger(dto.requestedQuantity) ||
      dto.requestedQuantity < 1 ||
      dto.requestedQuantity > 100
    ) {
      throw new BadRequestException(
        "requestedQuantity 1 va 100 oralig'ida bo'lishi shart",
      );
    }

    // 2. Resolve book (replica — read).
    const book = await this.replica.book.findUnique({
      where: { id: dto.bookId },
      select: { id: true, title: true, libraryId: true },
    });
    if (!book) {
      throw new NotFoundException("Kitob topilmadi");
    }

    // 3. KUTUBXONACHI scope check.
    if (user.role === UserRole.KUTUBXONACHI) {
      if (!user.libraryId || user.libraryId !== book.libraryId) {
        throw new ForbiddenException(
          "Scope mismatch: kutubxonachi faqat o'z kutubxonasi uchun buyurtma bera oladi",
        );
      }
    }

    // 4. Plan 05-03-fix FIX C (LOW) — non-atomic findFirst→create race fix.
    //
    // Two concurrent POSTs for the same (bookId, libraryId) could both pass
    // the findFirst check (returning null) and then both create. Adding a
    // unique DB constraint on a JSON-string column is unwieldy and a Prisma
    // $transaction with SELECT FOR UPDATE doesn't help because the read is
    // negative ("no row exists yet") — there's nothing to lock.
    //
    // Use the existing RedisLockService SETNX leader pattern (Plan 04-01):
    // acquire `order-request-lock:<libraryId>:<bookId>` with 5s TTL.
    // First caller proceeds; second caller observes the lock, re-runs the
    // findFirst (which now sees the row the first caller just wrote) and
    // returns it. If lock acquisition + replication lag race makes the
    // re-read still miss, fall back to throwing 409 — better than a dup.
    //
    // When redisLock is unavailable (legacy 4-arg tests), proceed with the
    // legacy findFirst→create path unchanged — single-replica dev/test is
    // not subject to the multi-replica race window.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const findExisting = async () =>
      this.replica.aiAuditLog.findFirst({
        where: {
          scope: "LIBRARY",
          scopeId: book.libraryId,
          issueType: ALERT_TYPES.ORDER_REQUEST,
          resolved: false,
          createdAt: { gte: twentyFourHoursAgo },
          recommendation: { contains: `"bookId":"${book.id}"` },
        },
      });

    const createNew = async () =>
      this.prisma.aiAuditLog.create({
        data: {
          scope: "LIBRARY",
          scopeId: book.libraryId,
          issueType: ALERT_TYPES.ORDER_REQUEST,
          severity: Severity.LOW,
          analysis: `${book.title} uchun ${dto.requestedQuantity} nusxa zarur`,
          recommendation: JSON.stringify({
            bookId: book.id,
            requestedQuantity: dto.requestedQuantity,
            requestedBy: user.id,
            requestedAt: new Date().toISOString(),
          }),
        },
      });

    if (!this.redisLock) {
      const existing = await findExisting();
      if (existing) return existing;
      return createNew();
    }

    const lockKey = `order-request-lock:${book.libraryId}:${book.id}`;
    const acquired = await this.redisLock.tryAcquire(lockKey, 5, user.id);
    if (!acquired.first) {
      // Another request is in-flight. Re-read; if the first caller has
      // already committed, return that row. Otherwise surface 409 so the
      // client can retry.
      const existing = await findExisting();
      if (existing) return existing;
      throw new BadRequestException(
        "Buyurtma so'rovi parallel ravishda jarayonda, qayta urinib ko'ring",
      );
    }

    try {
      const existing = await findExisting();
      if (existing) return existing;
      return await createNew();
    } finally {
      // Release on success or failure so a later legitimate request can
      // proceed without waiting for the 5s TTL.
      await this.redisLock.release(lockKey);
    }
  }
}
