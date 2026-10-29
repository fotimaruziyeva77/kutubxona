import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Prisma, Severity } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { KafkaService } from "../../infra/kafka/kafka.service";

// ── Risk daraja chegaralari ───────────────────────────────────────────────────
// FRAUD-06: the highest-risk band is FLAGGED (not BLOCKED). "BLOCKED"
// implied an auto-block authority we do not have; FLAGGED makes the
// review-only semantics explicit. The dailyFraudScan auto-block path
// (lines ~234-240 below) is removed in Plan 02-04 along with the review
// queue endpoint; we keep it here so the rename is mechanical.
export const RISK_THRESHOLDS = {
  SAFE:    { min: 0,  max: 24 },  // Xavfsiz — hech qanday harakat kerak emas
  LOW:     { min: 25, max: 49 },  // Past xavf — kuzatish
  REVIEW:  { min: 50, max: 69 },  // Tekshiruv — admin ko'rishi kerak
  FLAGGED: { min: 70, max: 100 }, // Belgilangan — admin tekshiruvi shart
} as const;

export type RiskLevel = "SAFE" | "LOW" | "REVIEW" | "FLAGGED";

export interface FraudFlag {
  code: string;
  description: string;
  points: number;
}

export interface FraudAnalysis {
  userId: string;
  riskScore: number;
  riskLevel: RiskLevel;
  flags: FraudFlag[];
  action: "none" | "monitor" | "review" | "block";
  checkedAt: string;
}

@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly kafka: KafkaService,
  ) {}

  // ── Foydalanuvchi fraud tahlili ───────────────────────────────────────────

  async analyzeUser(userId: string): Promise<FraudAnalysis> {
    const cacheKey = `fraud:analysis:${userId}`;
    return this.cache.remember(cacheKey, 300, async () => {
      const flags: FraudFlag[] = [];
      let riskScore = 0;

      // FRAUD-03 (Plan 02-04): RI_SPIKE now compares TODAY vs YESTERDAY
      // explicitly, not the oldest of the last-5 records. The old window
      // was a flat false-positive generator for legitimate consecutive
      // readers because the 5th-back record could be 2 weeks old.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const [user, recentTransactions, recentScans, comprehensionFailures, riToday, riYesterday] =
        await Promise.all([
          this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, trustScore: true, status: true },
          }),
          this._recentBorrows(userId, 1), // bugungi
          this._recentIsbnScans(userId, 7), // 7 kunlik
          this._comprehensionFailures(userId, 30), // 30 kunlik
          this.prisma.readingIndex.findFirst({
            where: { userId, calculatedAt: { gte: startOfToday } },
            orderBy: { calculatedAt: "desc" },
            select: { score: true },
          }),
          this.prisma.readingIndex.findFirst({
            where: { userId, calculatedAt: { lt: startOfToday } },
            orderBy: { calculatedAt: "desc" },
            select: { score: true },
          }),
        ]);

      if (!user) return this._emptyAnalysis(userId);

      // ── Qoida 1: Bir kunda ko'p kitob (>3) ─────────────────────────────
      if (recentTransactions >= 4) {
        const pts = Math.min((recentTransactions - 3) * 15, 30);
        flags.push({
          code: "HIGH_DAILY_BORROWS",
          description: `Bugun ${recentTransactions} ta kitob olindi (odatiy limit: 3)`,
          points: pts,
        });
        riskScore += pts;
      }

      // ── Qoida 2: Ko'p ISBN skan (kuniga >5) ────────────────────────────
      const dailyScans = recentScans / 7;
      if (dailyScans > 5) {
        const pts = Math.min(Math.floor((dailyScans - 5) * 5), 20);
        flags.push({
          code: "EXCESSIVE_ISBN_SCANS",
          description: `O'rtacha kuniga ${dailyScans.toFixed(1)} ta ISBN skan (odatiy: ≤5)`,
          points: pts,
        });
        riskScore += pts;
      }

      // ── Qoida 3: Comprehension test muvaffaqiyatsizligi ────────────────
      if (comprehensionFailures >= 3) {
        const pts = Math.min(comprehensionFailures * 8, 25);
        flags.push({
          code: "COMPREHENSION_FAILURES",
          description: `30 kunda ${comprehensionFailures} ta test muvaffaqiyatsiz`,
          points: pts,
        });
        riskScore += pts;
      }

      // ── Qoida 4: RI sakrashi (bir kunda +20 ball) ─────────────────────
      // FRAUD-03 (Plan 02-04): compare today vs yesterday only. If either
      // record is missing (first-day user, no nightly recalc yet) we skip
      // the rule — no false positives for legitimate new users.
      if (riToday && riYesterday) {
        const riDelta = riToday.score - riYesterday.score;
        if (riDelta > 20) {
          flags.push({
            code: "RI_SPIKE",
            description: `Reading Index ${riDelta.toFixed(1)} ball oshdi (shubhali tezlik)`,
            points: 20,
          });
          riskScore += 20;
        }
      }

      // ── Qoida 5: Trust score past bo'lsa qo'shimcha ────────────────────
      if (user.trustScore !== null && user.trustScore < 30) {
        flags.push({
          code: "LOW_TRUST_SCORE",
          description: `Trust score: ${user.trustScore} (past chegarasi: 30)`,
          points: 15,
        });
        riskScore += 15;
      }

      // ── Qoida 6: Tezkor kitob qaytarish (< 2 soat) ────────────────────
      const quickReturns = await this._quickReturns(userId);
      if (quickReturns >= 2) {
        flags.push({
          code: "QUICK_RETURNS",
          description: `${quickReturns} ta kitob 2 soatdan kam ushlanib qaytarildi`,
          points: 12,
        });
        riskScore += 12;
      }

      riskScore = Math.min(riskScore, 100);
      const riskLevel = this._getRiskLevel(riskScore);
      const action = this._getAction(riskLevel);

      const analysis: FraudAnalysis = {
        userId,
        riskScore,
        riskLevel,
        flags,
        action,
        checkedAt: new Date().toISOString(),
      };

      // DB ga saqlash
      await this._persistFraudScore(userId, riskScore, flags, action);

      // FLAGGED holatida Kafka event — admin tekshiruvini ishga tushiradi.
      if (riskLevel === "FLAGGED") {
        await this.kafka.emitFraudDetected({
          userId,
          riskScore,
          flags: flags.map((f) => f.code),
        });
      }

      return analysis;
    });
  }

  // ── FRAUD-07 (Plan 03-02 Task 2): multi-layer Top-100 candidate gate ─────
  //
  // Composes 4 HARD gates on top of analyzeUser. Used by TopService.aiFraudCheck
  // (29-day cron) to decide DRAFT → FRAUD_CHECKED vs DRAFT → FLAGGED.
  //
  // Gates (any fail → passed=false; ALL reasons collected, not first-fail-only):
  //   1. TRUST_BELOW_50            — User.trustScore < 50 (covers null/missing)
  //   2. CONFIRMED_FRAUD_90D       — RiskLog (last 90 days) contains a row whose
  //                                  description matches /"decision":"reject"/
  //                                  for this userId. Phase 2 admin review
  //                                  rejections feed this signal.
  //   3. LOW_COMPREHENSION         — last-30-day comprehension pass rate < 0.8.
  //                                  Insufficient data (zero attempts) is NOT
  //                                  a failure — we cannot punish a user who
  //                                  hasn't taken a test yet.
  //   4. SUSPECT_QUICK_RETURN_PATTERN — > 50% of the user's last-30-day
  //                                  RETURNED transactions had a borrow-to-
  //                                  return delta < 6 hours.
  //
  // T-03-02-S mitigation: financial-stakes fraud (25x BHM ≈ $2.5k per winner)
  // demands defence in depth above analyzeUser's daily-pattern checks. This
  // is the prize-gate, not a continuous monitor.
  async verifyTop100Candidate(userId: string): Promise<{
    passed: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];
    const now = Date.now();
    const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const sixHoursMs = 6 * 60 * 60 * 1000;

    // Layer 1 — Trust Score gate
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { trustScore: true },
    });
    if (!user || user.trustScore === null || user.trustScore < 50) {
      reasons.push("TRUST_BELOW_50");
    }

    // Layer 2 — Confirmed fraud in the past 90 days. We scan RiskLog and look
    // for any FRAUD_REVIEW_RESOLVED row whose JSON description embeds both
    // this userId AND a "decision":"reject" string. The Phase 2 _writeRiskLog
    // emits exactly that shape.
    const riskRows = await this.prisma.riskLog.findMany({
      where: {
        createdAt: { gte: ninetyDaysAgo },
        description: { contains: userId },
      },
      select: { description: true },
    });
    if (riskRows.some((r) => /"decision"\s*:\s*"reject"/.test(r.description))) {
      reasons.push("CONFIRMED_FRAUD_90D");
    }

    // Layer 3 — Comprehension pass-rate. Zero attempts → unevaluable, do not
    // flag. This is intentional: a candidate who passes the OTHER gates but
    // happens never to have taken a test should still be eligible.
    const tests = await this.prisma.comprehensionTest.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
      select: { passed: true },
    });
    if (tests.length > 0) {
      const passed = tests.filter((t) => t.passed).length;
      const passRate = passed / tests.length;
      if (passRate < 0.8) reasons.push("LOW_COMPREHENSION");
    }

    // Layer 4 — Quick-return pattern. Empty history → no signal, do not flag.
    const recentReturns = await this.prisma.bookTransaction.findMany({
      where: {
        userId,
        status: "RETURNED",
        returnedAt: { gte: thirtyDaysAgo },
      },
      select: { borrowedAt: true, returnedAt: true },
    });
    if (recentReturns.length > 0) {
      const quickCount = recentReturns.filter(
        (t) =>
          t.borrowedAt &&
          t.returnedAt &&
          t.returnedAt.getTime() - t.borrowedAt.getTime() < sixHoursMs,
      ).length;
      const ratio = quickCount / recentReturns.length;
      if (ratio > 0.5) reasons.push("SUSPECT_QUICK_RETURN_PATTERN");
    }

    return { passed: reasons.length === 0, reasons };
  }

  // ── Top-100 tekshiruvi (oyning 29-kuni chaqiriladi) ──────────────────────

  async checkTop100Candidates(): Promise<{
    total: number;
    flagged: number;
    blocked: number;
    results: Array<{ userId: string; riskScore: number; riskLevel: RiskLevel }>;
  }> {
    const currentMonth = this._currentMonth();

    // Oylik reytingdagi eng yuqori 150 foydalanuvchi (Top-100 + zaxira)
    const topUsers = await this.prisma.readingIndex.findMany({
      where: {
        calculatedAt: {
          gte: new Date(`${currentMonth}-01`),
        },
      },
      distinct: ["userId"],
      orderBy: { score: "desc" },
      take: 150,
      select: { userId: true },
    });

    const results = [];
    let flagged = 0;
    let blocked = 0;

    for (const { userId } of topUsers) {
      const analysis = await this.analyzeUser(userId);
      results.push({
        userId,
        riskScore: analysis.riskScore,
        riskLevel: analysis.riskLevel,
      });
      if (analysis.riskLevel !== "SAFE") flagged++;
      // `blocked` counter name is kept for the public response shape; it now
      // counts FLAGGED users (highest-risk band). Will be renamed to
      // `flaggedHighRisk` when the public API is versioned in Plan 02-04.
      if (analysis.riskLevel === "FLAGGED") blocked++;
    }

    this.logger.log(
      `Top-100 AI tekshiruvi: ${topUsers.length} ta tekshirildi, ` +
      `${flagged} ta flaglandi, ${blocked} ta bloklandi`
    );

    return { total: topUsers.length, flagged, blocked, results };
  }

  // ── Bulk fraud scanning (scheduled) ──────────────────────────────────────

  @Cron("0 3 * * *") // Har kuni soat 03:00 da
  async dailyFraudScan() {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // docker-compose.prod.yml runs replicas:3, so this @Cron fires on every
    // replica; only the SETNX winner sweeps, the rest log + return. Day-bucket
    // key + 2h TTL (well above the scan's expected runtime of minutes).
    const day = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:daily-fraud-scan:${day}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[daily-fraud-scan] leader lock held — skipping ${day}`);
      return;
    }

    this.logger.log("Kunlik fraud skan boshlanadi…");

    // Oxirgi 7 kunda faol bo'lgan foydalanuvchilar
    const activeUsers = await this.prisma.bookTransaction.findMany({
      where: {
        borrowedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      distinct: ["userId"],
      select: { userId: true },
      take: 10_000,
    });

    let processed = 0;
    let highRisk = 0;
    let queuedForReview = 0;

    for (const { userId } of activeUsers) {
      const analysis = await this.analyzeUser(userId);
      processed++;
      if (analysis.riskScore >= 50) highRisk++;

      // FRAUD-03 (Plan 02-04): the dailyFraudScan no longer auto-blocks
      // FLAGGED users. The platform does not have unilateral block
      // authority over real citizens — admin review (TUMAN_ADMIN /
      // VILOYAT_ADMIN / SUPER_ADMIN) is required. The FraudScore upsert
      // inside analyzeUser already wrote action='review' for this case;
      // we additionally log a RiskLog entry so the audit trail captures
      // the cron-driven detection.
      if (analysis.riskLevel === "FLAGGED") {
        queuedForReview++;
        await this._writeRiskLog({
          userId,
          riskScore: analysis.riskScore,
          flagCodes: analysis.flags.map((f) => f.code),
          detectedBy: "fraud-cron",
          severity: Severity.HIGH,
        });
        // Kafka emit is already done from analyzeUser when riskLevel ===
        // 'FLAGGED'. No need to re-emit here.
      }
    }

    this.logger.log(
      `Kunlik fraud skan: ${processed} foydalanuvchi, ${highRisk} yuqori risk, ${queuedForReview} review navbatiga`
    );
  }

  // ── Admin review queue (FRAUD-03, Plan 02-04) ─────────────────────────────
  //
  // SUPER_ADMIN sees all FLAGGED users. VILOYAT_ADMIN sees only users whose
  // address.viloyatId matches their scopeId. TUMAN_ADMIN sees only their
  // tuman. Service-layer where-clause enforcement; the controller passes
  // the admin tier + scopeId from the JWT payload.

  async getReviewQueue(params: {
    tier: "SUPER_ADMIN" | "VILOYAT_ADMIN" | "TUMAN_ADMIN" | "MUASSASA_ADMIN";
    scopeId?: string;
    limit?: number;
    offset?: number;
  }) {
    const { tier, scopeId, limit = 50, offset = 0 } = params;

    const where: Prisma.FraudScoreWhereInput = { action: "review" };

    if (tier === "TUMAN_ADMIN" && scopeId) {
      where.user = { address: { tumanId: scopeId } };
    } else if (tier === "VILOYAT_ADMIN" && scopeId) {
      where.user = { address: { viloyatId: scopeId } };
    }
    // SUPER_ADMIN + MUASSASA_ADMIN see all (MUASSASA admin scoping is by
    // institution, not geography — they can still see flagged users from
    // their own institution via the existing /users/pending flow).

    const [items, total] = await Promise.all([
      this.prisma.fraudScore.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
              sifatId: true,
              status: true,
              trustScore: true,
              address: {
                select: { viloyatId: true, tumanId: true, mahallaId: true },
              },
            },
          },
        },
        orderBy: { riskScore: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.fraudScore.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async resolveReview(
    adminId: string,
    userId: string,
    decision: "approve" | "reject",
    notes?: string
  ) {
    // 'approve' = admin clears the flag (user is fine), action='cleared'
    // 'reject'  = admin confirms fraud, action='confirmed'. Actual User
    //             status mutation (BLOCKED) remains a separate admin action
    //             via the existing user-management endpoints — this resolve
    //             only updates the FraudScore + audit trail.
    const existing = await this.prisma.fraudScore.findUnique({
      where: { userId },
    });
    if (!existing) {
      throw new NotFoundException("FraudScore yozuvi topilmadi");
    }

    const newAction = decision === "approve" ? "cleared" : "confirmed";

    const updated = await this.prisma.fraudScore.update({
      where: { userId },
      data: { action: newAction, checkedAt: new Date() },
    });

    await this._writeRiskLog({
      userId,
      riskScore: existing.riskScore,
      flagCodes: [],
      detectedBy: `admin:${adminId}`,
      severity: decision === "reject" ? Severity.HIGH : Severity.LOW,
      decision,
      notes,
    });

    // Invalidate the cached fraud analysis so a subsequent analyzeUser
    // call picks up the new action immediately.
    await this.cache.del(`fraud:analysis:${userId}`);

    return { resolved: true, action: updated.action };
  }

  private async _writeRiskLog(params: {
    userId: string;
    riskScore: number;
    flagCodes: string[];
    detectedBy: string;
    severity: Severity;
    decision?: "approve" | "reject";
    notes?: string;
  }): Promise<void> {
    try {
      const flagJson = JSON.stringify({
        userId: params.userId,
        riskScore: params.riskScore,
        flagCodes: params.flagCodes,
        decision: params.decision,
        notes: params.notes,
      });
      await this.prisma.riskLog.create({
        data: {
          riskType: params.decision ? "FRAUD_REVIEW_RESOLVED" : "FRAUD_DETECTED",
          severity: params.severity,
          description: flagJson,
          mitigationStatus: params.decision ?? "pending",
        },
      });
    } catch (err) {
      // RiskLog write failures should not crash the calling cron — log
      // and continue.
      this.logger.warn(`RiskLog yozish muvaffaqiyatsiz: ${(err as Error).message}`);
    }
  }

  // ── Fraud score statistikasi (admin uchun) ────────────────────────────────

  async getFraudStats() {
    return this.cache.remember("fraud:stats", 600, async () => {
      const [total, byLevel] = await Promise.all([
        this.prisma.fraudScore.count(),
        this.prisma.fraudScore.groupBy({
          by: ["action"],
          _count: { id: true },
          _avg: { riskScore: true },
        }),
      ]);

      const safe     = byLevel.find((b) => b.action === "none")?._count.id ?? 0;
      const low      = byLevel.find((b) => b.action === "monitor")?._count.id ?? 0;
      const review   = byLevel.find((b) => b.action === "review")?._count.id ?? 0;
      const blocked  = byLevel.find((b) => b.action === "block")?._count.id ?? 0;

      return { total, safe, low, review, blocked };
    });
  }

  async getFraudList(minRisk = 50, limit = 50) {
    return this.prisma.fraudScore.findMany({
      where: { riskScore: { gte: minRisk } },
      include: {
        user: { select: { id: true, name: true, phone: true, sifatId: true, status: true } },
      },
      orderBy: { riskScore: "desc" },
      take: limit,
    });
  }

  // ── Ichki yordamchi metodlar ──────────────────────────────────────────────

  private async _recentBorrows(userId: string, days: number): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.prisma.bookTransaction.count({
      where: { userId, type: "BORROW", borrowedAt: { gte: since } },
    });
  }

  private async _recentIsbnScans(userId: string, days: number): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.prisma.isbnScan.count({
      where: { userId, createdAt: { gte: since } },
    });
  }

  private async _comprehensionFailures(userId: string, days: number): Promise<number> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.prisma.comprehensionTest.count({
      where: {
        userId,
        passed: false,
        createdAt: { gte: since },
      },
    });
  }

  private async _quickReturns(userId: string): Promise<number> {
    const twoHours = 2 * 60 * 60 * 1000;
    const transactions = await this.prisma.bookTransaction.findMany({
      where: {
        userId,
        status: "RETURNED",
        borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: { borrowedAt: true, returnedAt: true },
    });
    return transactions.filter(
      (t) =>
        t.returnedAt &&
        t.borrowedAt &&
        t.returnedAt.getTime() - t.borrowedAt.getTime() < twoHours
    ).length;
  }

  private async _persistFraudScore(
    userId: string,
    riskScore: number,
    flags: FraudFlag[],
    action: string
  ) {
    await this.prisma.fraudScore.upsert({
      where: { userId },
      update: {
        riskScore,
        flags: flags.map((f) => f.code) as unknown as import("@prisma/client").Prisma.JsonArray,
        action,
        checkedAt: new Date(),
      },
      create: {
        userId,
        riskScore,
        flags: flags.map((f) => f.code) as unknown as import("@prisma/client").Prisma.JsonArray,
        action,
        checkedAt: new Date(),
      },
    });
  }

  private _getRiskLevel(score: number): RiskLevel {
    if (score >= RISK_THRESHOLDS.FLAGGED.min) return "FLAGGED";
    if (score >= RISK_THRESHOLDS.REVIEW.min)  return "REVIEW";
    if (score >= RISK_THRESHOLDS.LOW.min)     return "LOW";
    return "SAFE";
  }

  // FRAUD-06: FLAGGED maps to action="review" (NOT "block"). This aligns
  // with the FRAUD-03 review-queue semantics that Plan 02-04 wires up.
  // Downstream consumers (FraudScore.action column, getFraudStats) now see
  // "review" as the source-of-truth label for the highest-risk band.
  private _getAction(level: RiskLevel): FraudAnalysis["action"] {
    const map: Record<RiskLevel, FraudAnalysis["action"]> = {
      SAFE:    "none",
      LOW:     "monitor",
      REVIEW:  "review",
      FLAGGED: "review",
    };
    return map[level];
  }

  private _emptyAnalysis(userId: string): FraudAnalysis {
    return {
      userId,
      riskScore: 0,
      riskLevel: "SAFE",
      flags: [],
      action: "none",
      checkedAt: new Date().toISOString(),
    };
  }

  private _currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
