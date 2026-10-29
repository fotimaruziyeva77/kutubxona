import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import { FraudService } from "./fraud.service";
import { AuditService } from "./audit.service";
import { NlqService, NlqResponse } from "./nlq.service";
import { PredictService } from "./predict.service";
import { RecommendService, BookRecommendation } from "./recommend.service";
import { REPORT_QUEUE } from "../../infra/queue/queue-names";
import { Severity } from "@prisma/client";
import { escapeHtml } from "../../common/utils/escape-html.util";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly pdf: PdfService,
    private readonly fraud: FraudService,
    private readonly audit: AuditService,
    private readonly nlq: NlqService,
    private readonly predict: PredictService,
    private readonly recommend: RecommendService,
    @InjectQueue(REPORT_QUEUE) private readonly reportQueue: Queue,
  ) {}

  // ── NL Interface ──────────────────────────────────────────────────────────

  async query(question: string, userId?: string): Promise<NlqResponse> {
    return this.nlq.query(question, userId);
  }

  async getNlqHistory(userId: string) {
    return this.nlq.getQueryHistory(userId);
  }

  // ── Fraud Detection ───────────────────────────────────────────────────────

  async analyzeUserFraud(userId: string) {
    return this.fraud.analyzeUser(userId);
  }

  async checkTop100Fraud() {
    return this.fraud.checkTop100Candidates();
  }

  async getFraudStats() {
    return this.fraud.getFraudStats();
  }

  async getFraudList(minRisk = 50, limit = 50) {
    return this.fraud.getFraudList(minRisk, limit);
  }

  // ── Audit Engine ──────────────────────────────────────────────────────────

  async getAuditLogs(filters: {
    scope?: string;
    severity?: string;
    resolved?: boolean;
    limit?: number;
  }) {
    return this.audit.getAuditLogs(filters);
  }

  async resolveAuditLog(id: string) {
    return this.audit.resolveAuditLog(id);
  }

  // Eski API bilan moslik uchun
  async createAuditLog(data: {
    scope: string;
    scopeId: string;
    issueType: string;
    severity: Severity;
    analysis: string;
    recommendation: string;
  }) {
    return this.prisma.aiAuditLog.create({ data });
  }

  // ── Predictive Analytics ──────────────────────────────────────────────────

  async predictTumanRi(tumanId: string, monthsAhead?: number) {
    return this.predict.predictTumanRi(tumanId, monthsAhead);
  }

  async predictFundShortage(libraryId: string) {
    return this.predict.predictFundShortage(libraryId);
  }

  async analyzeRootCause(tumanId: string, issue: "RI_DROP" | "LOW_COVERAGE" | "INACTIVE_LIBRARY") {
    return this.predict.analyzeRootCause(tumanId, issue);
  }

  async nationalGoalForecast() {
    return this.predict.nationalGoalForecast();
  }

  // ── Book Recommendations ──────────────────────────────────────────────────

  async getRecommendations(userId: string, limit?: number): Promise<BookRecommendation[]> {
    return this.recommend.getRecommendations(userId, limit);
  }

  async getClubRecommendations(clubId: string, limit?: number): Promise<BookRecommendation[]> {
    return this.recommend.getClubRecommendations(clubId, limit);
  }

  // ── Avtomatik hisobotlar (S8-T10) ─────────────────────────────────────────

  @Cron("0 6 1 * *") // Har oyning 1-kuni soat 06:00 da
  async generateMonthlyReports() {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // replicas:3 in prod would each enqueue ~500 report jobs; month-bucket
    // key + 2h TTL gates a single leader. Key is distinct from AdminService's
    // cron:monthly-reports:<month> (different job, different queue).
    const monthBucket = new Date().toISOString().slice(0, 7);
    const lockKey = `cron:ai-monthly-reports:${monthBucket}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[ai-monthly-reports] leader lock held — skipping ${monthBucket}`);
      return;
    }

    this.logger.log("Oylik AI hisobotlari generatsiya boshlanadi…");

    const libraries = await this.prisma.library.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, tumanId: true, viloyatId: true },
      take: 500,
    });

    for (const lib of libraries) {
      await this.reportQueue.add("monthly-ai-report", {
        type: "library",
        libraryId: lib.id,
        libraryName: lib.name,
        month: this._previousMonth(),
      }, { delay: Math.random() * 60_000 }); // Tasodifiy kechikish (queue bosimi uchun)
    }

    this.logger.log(`${libraries.length} ta kutubxona uchun oylik hisobot job yaratildi`);
  }

  async generateAiReport(libraryId: string): Promise<{
    html: string;
    summary: string;
    insights: string[];
  }> {
    const cacheKey = `ai:report:${libraryId}:${this._previousMonth()}`;
    return this.cache.remember(cacheKey, 3600 * 24, async () => {
      const [library, transactions, riData] = await Promise.all([
        this.prisma.library.findUnique({
          where: { id: libraryId },
          select: { name: true, tumanId: true, viloyatId: true },
        }),
        this.prisma.bookTransaction.count({
          where: {
            book: { libraryId },
            type: "BORROW",
            borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        }),
        this.prisma.readingIndex.aggregate({
          where: {
            calculatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          _avg: { score: true },
        }),
      ]);

      const avgRi = riData._avg.score ?? 0;
      const libName = library?.name ?? libraryId;

      const insights: string[] = [];
      if (transactions < 10) {
        insights.push("⚠️ Bu oy kitob berish juda kam — faollik oshirilishi kerak");
      } else {
        insights.push(`✅ Bu oy ${transactions} ta kitob berildi — yaxshi natija`);
      }
      if (avgRi < 40) {
        insights.push("🔴 O'rtacha Reading Index past — kitobxonlar bilan individual ishlash zarur");
      } else if (avgRi >= 60) {
        insights.push("🟢 Reading Index yaxshi darajada — davom ettirilsin");
      }

      const summary =
        `${libName} kutubxonasida bu oy ${transactions} ta kitob berildi. ` +
        `O'rtacha Reading Index: ${avgRi.toFixed(1)} ball. ` +
        (insights[0] ?? "");

      // XSS (P2, 2026-06-10): libName — DB'dan kelgan string (kutubxona nomi
      // admin formidan kiradi); HTML hisobotga escapeHtml'siz qo'yish stored
      // XSS edi. pdf.service/invoice.service bilan bir xil shared util.
      const html = `
        <div style="font-family: Arial; padding: 20px;">
          <h2>${escapeHtml(libName)} — Oylik AI Hisobot (${this._previousMonth()})</h2>
          <hr/>
          <h3>Asosiy ko'rsatkichlar</h3>
          <ul>
            <li>Berilgan kitoblar: <strong>${transactions}</strong></li>
            <li>O'rtacha RI: <strong>${avgRi.toFixed(1)}</strong></li>
          </ul>
          <h3>AI Tahlil va Tavsiyalar</h3>
          <ul>
            ${insights.map((i) => `<li>${i}</li>`).join("")}
          </ul>
          <p style="color: #888; font-size: 12px;">Ushbu hisobot SIFAT LIBRARY AI tizimi tomonidan avtomatik yaratilgan.</p>
        </div>
      `;

      return { html, summary, insights };
    });
  }

  // ── Top-100 AI tekshiruvi — oyning 29-kuni (S8-T12) ─────────────────────

  @Cron("0 1 29 * *") // Har oyning 29-kuni soat 01:00 da
  async top100FraudCheck() {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // Month-bucket key + 2h TTL; non-leaders skip. The manual trigger path
    // (checkTop100Fraud → fraud.checkTop100Candidates) stays lock-free.
    const monthBucket = new Date().toISOString().slice(0, 7);
    const lockKey = `cron:top100-fraud-check:${monthBucket}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[top100-fraud-check] leader lock held — skipping ${monthBucket}`);
      return;
    }

    this.logger.log("Top-100 AI tekshiruvi boshlanadi (oyning 29-kuni)…");
    const result = await this.fraud.checkTop100Candidates();
    this.logger.log(
      `Top-100 tekshiruvi: ${result.total} tekshirildi, ` +
      `${result.flagged} flaglandi, ${result.blocked} bloklandi`
    );
    return result;
  }

  // ── Model monitoring dashboard (S8-T11) ──────────────────────────────────

  async getModelMonitoring() {
    return this.cache.remember("ai:monitoring", 600, async () => {
      const [fraudStats, auditCount, totalUsers] = await Promise.all([
        this.fraud.getFraudStats(),
        this.prisma.aiAuditLog.count({ where: { resolved: false } }),
        this.prisma.user.count({ where: { status: "ACTIVE" } }),
      ]);

      // Fraud modeli "sog'ligi" — false positive ko'p bo'lsa past
      const fraudCoverage =
        fraudStats.total > 0
          ? Math.round(((fraudStats.total - fraudStats.blocked) / fraudStats.total) * 100)
          : 100;

      // 30 kunda bloklangan vs total
      const blockedLast30 = await this.prisma.fraudScore.count({
        where: {
          riskScore: { gte: 70 },
          checkedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      });
      const fraudRate = totalUsers > 0 ? (blockedLast30 / totalUsers) * 100 : 0;

      return {
        fraudModel: {
          status: fraudCoverage >= 90 ? "healthy" : "degraded",
          coverage: fraudCoverage,
          blockedLast30,
          fraudRate: Math.round(fraudRate * 100) / 100,
          stats: fraudStats,
        },
        auditEngine: {
          unresolvedAlerts: auditCount,
          status: auditCount < 10 ? "healthy" : auditCount < 50 ? "warning" : "critical",
        },
        lastChecked: new Date().toISOString(),
      };
    });
  }

  // ── Ichki yordamchi ───────────────────────────────────────────────────────

  private _previousMonth(): string {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
