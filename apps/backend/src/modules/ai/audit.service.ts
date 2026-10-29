import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { KafkaService } from "../../infra/kafka/kafka.service";
import { StatsGateway } from "../../infra/gateway/stats.gateway";
import { AlertDispatchService } from "./alert-dispatch.service";
import { PredictService, RootCauseAnalysis } from "./predict.service";
import { ALERT_TYPES } from "../../common/constants/alert-types.const";
import { Severity } from "@prisma/client";

export interface AuditIssue {
  scope: "TUMAN" | "KUTUBXONA" | "KLUB" | "IDORA";
  scopeId: string;
  scopeName: string;
  issueType: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  analysis: string;
  recommendation: string;
  data?: Record<string, unknown>;
}

// ── Audit chegaralari ─────────────────────────────────────────────────────────
// Plan 05-05 T1 — threshold fixes:
//   * CLUB_DEBATE_DAYS 45 → 30 (ALERT-04)
//   * FUND_SHORTAGE_REQS 10 → 50 (ALERT-03)
//   * FUND_SHORTAGE_AVAIL <=1 → ===0 (ALERT-03)
const THRESHOLDS = {
  RI_DROP_WARNING:    10,  // % pasayish → warning
  RI_DROP_CRITICAL:   20,  // % pasayish → critical
  RI_RISING:          15,  // % o'sish → AXBOROT (ALERT-05 weekly)
  INACTIVE_DAYS:      14,  // Tuman/kutubxona faolsiz kun → critical
  CLUB_DEBATE_DAYS:   30,  // Plan 05-05 ALERT-04: was 45, now 30 days
  FUND_SHORTAGE_REQS: 50,  // Plan 05-05 ALERT-03: was 10, now 50 requests
} as const;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly kafka: KafkaService,
    private readonly gateway: StatsGateway,
    // Plan 05-05 T1 — replica routing for ALL heavy reads (S1 PITFALL closure).
    // Optional + nullable fallback so existing 4-arg unit tests still work;
    // runtime DI always supplies the replica because PrismaModule is @Global().
    @Optional() private readonly replicaParam?: PrismaReplicaService,
    // Plan 05-05 T2 — AlertDispatchService recipient-aware fan-out. Optional
    // because the legacy 4-arg constructor signature must keep working for
    // older specs that don't care about dispatch.
    @Optional() private readonly alertDispatch?: AlertDispatchService,
    // Plan 07-04 — PredictService for triggerRootCauseForTuman (AI-03).
    // Optional to preserve backward-compatible constructor signatures.
    @Optional() private readonly predictService?: PredictService,
  ) {}

  /**
   * Read-side Prisma client. Routes ALL heavy aggregations to the read
   * replica when DI supplied one (production + audit cron path). Falls back
   * to the primary client when unset (tests, single-node dev).
   */
  private get replica(): PrismaService | PrismaReplicaService {
    return this.replicaParam ?? this.prisma;
  }

  // ── Asosiy audit — har 15 daqiqada ──────────────────────────────────────

  @Cron("*/15 * * * *")
  async runAuditCycle() {
    // Audit H8 — Redis SETNX leader lock (mirrors AdminService
    // stats-preagg-tuman): replicas:3 in prod fire this @Cron concurrently.
    // Minute-bucket key is shared by all replicas of the same tick; TTL 840s
    // (14 min) stays below the 15-min cadence so the next tick is never
    // blocked by a stale key.
    const minuteBucket = new Date().toISOString().slice(0, 16);
    const lockKey = `cron:ai-audit-cycle:${minuteBucket}`;
    const acquired = await this.cache.setNx(lockKey, "1", 840);
    if (!acquired) {
      this.logger.debug(`[ai-audit-cycle] leader lock held — skipping ${minuteBucket}`);
      return;
    }

    this.logger.log("AI Audit sikli boshlanadi…");

    const issues = await Promise.all([
      this._checkTumanRiDrops(),
      this._checkInactiveLibraries(),
      this._checkInactiveTumans(),
      this._checkInactiveClubs(),
      this._checkFundShortages(),
    ]);

    const allIssues = issues.flat();

    for (const issue of allIssues) {
      await this._persistAndNotify(issue);
    }

    this.logger.log(`Audit sikli tugadi: ${allIssues.length} muammo aniqlandi`);
  }

  // ── Tuman RI pasayishi tekshiruvi ─────────────────────────────────────────

  private async _checkTumanRiDrops(): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Plan 05-05 T1 — S1 PITFALL closure. Old impl loaded all ReadingIndex
    // rows (5M users × 60d = ~300M rows) into Node memory; new impl is a
    // single SQL GROUP BY returning ≤500 summary rows.
    const tumanMap = await this._buildTumanRiMap();

    for (const [tumanId, { current, previous, name }] of Object.entries(tumanMap)) {
      if (previous <= 0) continue;
      const dropPercent = ((previous - current) / previous) * 100;

      if (dropPercent >= THRESHOLDS.RI_DROP_CRITICAL) {
        issues.push({
          scope: "TUMAN",
          scopeId: tumanId,
          scopeName: name,
          issueType: ALERT_TYPES.RI_DROPPED,
          severity: "CRITICAL",
          analysis:
            `${name} tumanida kitobxonlik indeksi ${dropPercent.toFixed(1)}% pasaydi ` +
            `(oldin: ${previous.toFixed(1)}, hozir: ${current.toFixed(1)}).`,
          recommendation:
            "Tuman admini kutubxona holati, xodim o'zgarishi va fond yangilanishini tekshirsin.",
          data: { current, previous, dropPercent, tumanId },
        });
        await this.kafka.emitTumanRiDropped({
          tumanId,
          currentAvg: current,
          previousAvg: previous,
          dropPercent,
        });
      } else if (dropPercent >= THRESHOLDS.RI_DROP_WARNING) {
        issues.push({
          scope: "TUMAN",
          scopeId: tumanId,
          scopeName: name,
          issueType: ALERT_TYPES.RI_DROPPED,
          severity: "WARNING",
          analysis:
            `${name} tumanida kitobxonlik indeksi ${dropPercent.toFixed(1)}% pasaydi.`,
          recommendation: "Faollik sabablari ko'rib chiqilsin.",
          data: { current, previous, dropPercent },
        });
      }
    }

    return issues;
  }

  // ── Faolsiz kutubxonalar ──────────────────────────────────────────────────

  private async _checkInactiveLibraries(): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const cutoff = new Date(Date.now() - THRESHOLDS.INACTIVE_DAYS * 24 * 60 * 60 * 1000);

    const libraries = await this.replica.library.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        type: true,
        transactions: {
          where: { borrowedAt: { gte: cutoff } },
          select: { id: true },
          take: 1,
        },
      },
    });

    for (const lib of libraries) {
      if (lib.transactions.length === 0) {
        issues.push({
          scope: "KUTUBXONA",
          scopeId: lib.id,
          scopeName: lib.name,
          issueType: ALERT_TYPES.LIBRARY_INACTIVE,
          severity: "CRITICAL",
          analysis: `"${lib.name}" kutubxonasida ${THRESHOLDS.INACTIVE_DAYS} kun davomida hech qanday kitob harakati bo'lmadi.`,
          recommendation:
            "Kutubxona ta'mirda yoki yopilganmi? Kutubxonachi va muassasa adminga darhol xabar yuboring.",
        });
      }
    }

    return issues;
  }

  // ── Faolsiz tumanlar (Plan 05-05 ALERT-01 NEW) ────────────────────────────
  //
  // Detects tumans with 0 distinct active readers in the last 14d. Routes
  // via TUMAN scope so AlertDispatchService can fan out to TUMAN_ADMIN +
  // VILOYAT_ADMIN per the matrix.
  //
  // SQL: LEFT JOIN Tuman → Address → User → ReadingIndex; GROUP BY tuman;
  // HAVING COUNT(DISTINCT ri.userId) = 0.

  private async _checkInactiveTumans(): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    const rows = await this.replica.$queryRaw<
      Array<{ tuman_id: string; tuman_name: string }>
    >`
      SELECT t.id AS tuman_id, t.name AS tuman_name
      FROM "Tuman" t
      LEFT JOIN "Address" a ON a."tumanId" = t.id
      LEFT JOIN "User" u ON u."addressId" = a.id AND u.status = 'ACTIVE'::"UserStatus"
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id
        AND ri."calculatedAt" >= NOW() - INTERVAL '14 days'
      GROUP BY t.id, t.name
      HAVING COUNT(DISTINCT ri."userId") = 0
    `;

    for (const row of rows) {
      issues.push({
        scope: "TUMAN",
        scopeId: row.tuman_id,
        scopeName: row.tuman_name,
        issueType: ALERT_TYPES.LIBRARY_INACTIVE,
        severity: "CRITICAL",
        analysis: `"${row.tuman_name}" tumanida so'nggi 14 kun davomida hech qanday faol kitobxon yo'q.`,
        recommendation:
          "Tuman adminiga darhol xabar yuboring. Kutubxonalar holati va faollikni tekshiring.",
      });
    }

    return issues;
  }

  // ── Faolsiz Jadidlar izidan klublari ─────────────────────────────────────

  private async _checkInactiveClubs(): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];
    const cutoff = new Date(Date.now() - THRESHOLDS.CLUB_DEBATE_DAYS * 24 * 60 * 60 * 1000);

    const clubs = await this.replica.club.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        institutionId: true,
        debates: {
          where: { heldAt: { gte: cutoff } },
          select: { id: true },
          take: 1,
        },
        _count: { select: { members: true } },
      },
    });

    for (const club of clubs) {
      if (club.debates.length === 0) {
        issues.push({
          scope: "KLUB",
          scopeId: club.id,
          scopeName: club.name,
          issueType: ALERT_TYPES.CLUB_INACTIVE,
          severity: "WARNING",
          analysis:
            `"${club.name}" klubi ${THRESHOLDS.CLUB_DEBATE_DAYS} kundan ko'proq vaqt debat o'tkazmadi. ` +
            `A'zolar soni: ${club._count.members}.`,
          recommendation:
            "Klub rahbariga eslatma yuboring. Debat mavzusi va sanasini rejalash tavsiya qilinadi.",
        });
      }
    }

    return issues;
  }

  // ── Fond yetishmovchiligi ─────────────────────────────────────────────────
  //
  // Plan 05-05 T1 ALERT-03 threshold update:
  //   * having: { _count: { gte: 50 } }   (was 10)
  //   * book.availableCount === 0          (was <= 1)

  private async _checkFundShortages(): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Ko'p so'ralgan lekin nusxasi yo'q kitoblar (30 kun)
    const hotBooks = await this.replica.bookTransaction.groupBy({
      by: ["bookId"],
      where: {
        type: "RESERVE",
        borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { bookId: true },
      having: { bookId: { _count: { gte: THRESHOLDS.FUND_SHORTAGE_REQS } } },
      orderBy: { _count: { bookId: "desc" } },
      take: 20,
    });

    for (const { bookId, _count } of hotBooks) {
      const book = await this.replica.book.findUnique({
        where: { id: bookId },
        select: { id: true, title: true, author: true, availableCount: true, library: { select: { name: true } } },
      });
      if (!book) continue;

      // ALERT-03 strict zero requirement — only fire when fully depleted.
      if (book.availableCount === 0) {
        issues.push({
          scope: "KUTUBXONA",
          scopeId: book.library?.name ?? bookId,
          scopeName: book.title,
          issueType: ALERT_TYPES.FUND_SHORTAGE,
          severity: "WARNING",
          analysis:
            `"${book.title}" (${book.author}) ${_count.bookId} marta so'raldi lekin mavjud nusxa yo'q.`,
          recommendation: `Ushbu kitob uchun zudlik bilan qo'shimcha nusxa xarid qilish tavsiya etiladi.`,
          data: { bookId, requests: _count.bookId, available: book.availableCount },
        });
      }
    }

    return issues;
  }

  // ── Tuman RI o'sishi (Plan 05-05 ALERT-05 — weekly AXBOROT) ──────────────
  //
  // Monday 09:00 Asia/Tashkent — detects tumans with 15%+ RI rise. Severity
  // INFO; AlertDispatchService defers RI_RISING to a Monday 09:30 weekly
  // digest per Q3 user decision.

  @Cron("0 9 * * 1", {
    name: "audit-ri-rising-weekly",
    timeZone: "Asia/Tashkent",
  })
  async checkTumanRiRises(): Promise<void> {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // Fires Mondays only, so the day bucket is unique per run; TTL 2h is
    // well above the scan's runtime.
    const day = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:audit-ri-rising-weekly:${day}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[audit-ri-rising-weekly] leader lock held — skipping ${day}`);
      return;
    }

    this.logger.log("[audit] weekly RI-rising scan boshlanadi (ALERT-05)");
    const tumanMap = await this._buildTumanRiMap();

    for (const [tumanId, { current, previous, name }] of Object.entries(tumanMap)) {
      if (previous <= 0) continue;
      const risePercent = ((current - previous) / previous) * 100;

      if (risePercent >= THRESHOLDS.RI_RISING) {
        const issue: AuditIssue = {
          scope: "TUMAN",
          scopeId: tumanId,
          scopeName: name,
          issueType: ALERT_TYPES.RI_RISING,
          severity: "INFO",
          analysis:
            `${name} tumanida kitobxonlik indeksi ${risePercent.toFixed(1)}% o'sdi ` +
            `(oldin: ${previous.toFixed(1)}, hozir: ${current.toFixed(1)}).`,
          recommendation:
            "Yaxshi natija — sabablarni tahlil qilib boshqa tumanlarga tavsiya bering.",
          data: { current, previous, risePercent, tumanId },
        };
        await this._persistAndNotify(issue);
      }
    }
  }

  // ── Muammoni saqlash va xabar yuborish ───────────────────────────────────

  private async _persistAndNotify(issue: AuditIssue) {
    // Bir xil muammo bugun allaqachon qayd etilganmi?
    const existing = await this.prisma.aiAuditLog.findFirst({
      where: {
        scope: issue.scope,
        scopeId: issue.scopeId,
        issueType: issue.issueType,
        resolved: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (existing) return; // Takrorlanmaslik

    const severity =
      issue.severity === "CRITICAL"
        ? Severity.CRITICAL
        : issue.severity === "WARNING"
        ? Severity.MEDIUM
        : Severity.LOW;

    const log = await this.prisma.aiAuditLog.create({
      data: {
        scope: issue.scope,
        scopeId: issue.scopeId,
        issueType: issue.issueType,
        severity,
        analysis: issue.analysis,
        recommendation: issue.recommendation,
      },
    });

    // WebSocket orqali admin panelga darhol yuborish
    this.gateway.emitNewAlert({
      id: log.id,
      scope: issue.scope,
      scopeName: issue.scopeName,
      issueType: issue.issueType,
      severity: issue.severity,
      analysis: issue.analysis,
      recommendation: issue.recommendation,
      createdAt: log.createdAt,
    });

    // Plan 05-05 T2 — AlertDispatchService recipient-aware fan-out. Best-
    // effort side effect — log + swallow on failure so the AiAuditLog row
    // remains intact for retry/manual processing (matches Plan 03-04 pattern).
    if (this.alertDispatch) {
      try {
        await this.alertDispatch.dispatch(log);
      } catch (err) {
        this.logger.error(
          `[audit] dispatch failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[${issue.severity}] ${issue.issueType} — ${issue.scopeName}: ${issue.analysis.slice(0, 80)}…`
    );
  }

  // ── Tuman RI xaritasi qurish (Plan 05-05 T1 — S1 PITFALL closure) ────────
  //
  // BEFORE: findMany of all ReadingIndex rows in the last 60d, loaded into
  // Node memory, then aggregated by tuman in a JS loop. With 5M users x
  // ~60d/user = ~300M rows. OOM at production scale.
  //
  // AFTER: single replica $queryRaw with GROUP BY tumanId that returns a
  // ≤500-row summary (current 14d avg, previous 14-28d avg). Memory ceiling
  // drops by ~6 orders of magnitude.
  //
  // SQL routes through the read replica (PrismaReplicaService).

  private async _buildTumanRiMap(): Promise<
    Record<string, { current: number; previous: number; name: string }>
  > {
    const rows = await this.replica.$queryRaw<
      Array<{
        tumanId: string;
        tuman_name: string | null;
        current_ri: number | null;
        previous_ri: number | null;
      }>
    >`
      WITH ri_by_tuman AS (
        SELECT a."tumanId" AS tuman_id, ri.score, ri."calculatedAt"
        FROM "ReadingIndex" ri
        JOIN "User" u ON u.id = ri."userId"
        JOIN "Address" a ON a.id = u."addressId"
        WHERE ri."calculatedAt" >= NOW() - INTERVAL '28 days'
          AND a."tumanId" IS NOT NULL
      )
      SELECT
        r.tuman_id AS "tumanId",
        t.name AS tuman_name,
        AVG(CASE WHEN r."calculatedAt" >= NOW() - INTERVAL '14 days' THEN r.score END)::float AS current_ri,
        AVG(CASE WHEN r."calculatedAt" < NOW() - INTERVAL '14 days' THEN r.score END)::float AS previous_ri
      FROM ri_by_tuman r
      LEFT JOIN "Tuman" t ON t.id = r.tuman_id
      GROUP BY r.tuman_id, t.name
    `;

    const result: Record<string, { current: number; previous: number; name: string }> = {};
    for (const row of rows) {
      if (!row.tumanId) continue;
      result[row.tumanId] = {
        current: Number(row.current_ri ?? 0),
        previous: Number(row.previous_ri ?? 0),
        name: row.tuman_name ?? row.tumanId,
      };
    }
    return result;
  }

  // ── PERF-05 — Monthly partition cleanup (24-month retention) ─────────────
  //
  // Runs on the 1st of each month at 02:00 UTC. Detaches and drops
  // AiAuditLog partitions older than 24 months. Matches the ReadingIndex
  // 13-month pattern from Phase 2 (RI-03) but with 24-month retention
  // per PERF-05 requirement.

  @Cron("0 2 1 * *", {
    name: "audit-partition-archive",
    timeZone: "Asia/Tashkent",
  })
  async archiveOldAuditPartitions(): Promise<void> {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern). DDL
    // (DETACH/DROP PARTITION) from 3 replicas at once would deadlock on the
    // parent-table lock; month-bucket key + 2h TTL gates a single leader.
    const monthBucket = new Date().toISOString().slice(0, 7);
    const lockKey = `cron:audit-partition-archive:${monthBucket}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[audit-partition-archive] leader lock held — skipping ${monthBucket}`);
      return;
    }

    this.logger.log("[audit] monthly partition cleanup starting (PERF-05)");

    const now = new Date();
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 24, 1);

    // Iterate over months from a reasonable start (2024-01) up to cutoff
    const startYear = 2024;
    const startMonth = 1;

    let year = startYear;
    let month = startMonth;

    while (
      year < cutoffDate.getFullYear() ||
      (year === cutoffDate.getFullYear() && month < cutoffDate.getMonth() + 1)
    ) {
      const partitionName = `AiAuditLog_y${year}_m${String(month).padStart(2, "0")}`;

      try {
        await this.prisma.$executeRawUnsafe(
          `ALTER TABLE "AiAuditLog" DETACH PARTITION "${partitionName}"`,
        );
        this.logger.log(`[audit] detached partition: ${partitionName}`);

        await this.prisma.$executeRawUnsafe(
          `DROP TABLE IF EXISTS "${partitionName}"`,
        );
        this.logger.log(`[audit] dropped partition: ${partitionName}`);
      } catch (err) {
        // Partition may not exist (already dropped or never created) — idempotent
        this.logger.warn(
          `[audit] partition ${partitionName} not found or already dropped: ${(err as Error).message}`,
        );
      }

      // Advance to next month
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }

    this.logger.log("[audit] monthly partition cleanup complete (PERF-05)");
  }

  // ── AI-03: RCA trigger for Kafka consumer + cron ─────────────────────────
  //
  // Public method callable from both the 15-min cron (runAuditCycle) and the
  // new KafkaAuditConsumer. Delegates to PredictService.analyzeRootCause and
  // logs the result to AiAuditLog with ALERT_TYPES.ROOT_CAUSE_ANALYSIS.

  async triggerRootCauseForTuman(tumanId: string): Promise<RootCauseAnalysis | null> {
    if (!this.predictService) {
      this.logger.warn("[audit] PredictService not available -- skipping RCA");
      return null;
    }

    try {
      const rca = await this.predictService.analyzeRootCause(tumanId, "RI_DROP");

      await this.prisma.aiAuditLog.create({
        data: {
          scope: "TUMAN",
          scopeId: tumanId,
          issueType: ALERT_TYPES.ROOT_CAUSE_ANALYSIS,
          severity: Severity.LOW,
          analysis: rca.summary,
          recommendation: rca.causes[0]?.recommendation ?? "Batafsil tahlil talab qilinadi.",
        },
      });

      this.logger.log(`[audit] RCA completed for tuman ${tumanId}: ${rca.causes.length} causes found`);
      return rca;
    } catch (err) {
      this.logger.error(`[audit] RCA failed for tuman ${tumanId}: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Audit loglari olish (API uchun) ───────────────────────────────────────

  async getAuditLogs(filters: {
    scope?: string;
    severity?: string;
    resolved?: boolean;
    limit?: number;
  }) {
    return this.cache.remember(
      `audit:logs:${JSON.stringify(filters)}`,
      60,
      async () => {
        return this.replica.aiAuditLog.findMany({
          where: {
            ...(filters.scope ? { scope: filters.scope } : {}),
            ...(filters.severity ? { severity: filters.severity as Severity } : {}),
            ...(filters.resolved !== undefined ? { resolved: filters.resolved } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: filters.limit ?? 100,
        });
      }
    );
  }

  async resolveAuditLog(id: string) {
    const log = await this.prisma.aiAuditLog.update({
      where: { id },
      data: { resolved: true },
    });
    await this.cache.del(`audit:logs:*`);
    this.gateway.emitAlertResolved(id);
    return log;
  }
}
