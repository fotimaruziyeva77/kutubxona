import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";

export interface PredictionPoint {
  month: string;
  value: number;
  predicted: boolean;
  confidenceLow?: number;
  confidenceHigh?: number;
}

export interface RootCause {
  factor: string;
  description: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  evidence: string;
  recommendation: string;
}

export interface RootCauseAnalysis {
  scopeId: string;
  scopeType: "TUMAN" | "KUTUBXONA" | "MAKTAB";
  issue: string;
  causes: RootCause[];
  summary: string;
  generatedAt: string;
}

@Injectable()
export class PredictService {
  private readonly logger = new Logger(PredictService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ── Tuman RI bashorati (1 oylik) ──────────────────────────────────────────

  async predictTumanRi(
    tumanId: string,
    monthsAhead = 1
  ): Promise<{
    historical: PredictionPoint[];
    forecast: PredictionPoint[];
    trend: "up" | "down" | "stable";
    confidence: number;
    yearlyGoalProbability: number;
  }> {
    const cacheKey = `predict:tuman:${tumanId}:${monthsAhead}`;
    return this.cache.remember(cacheKey, 1800, async () => {
      const historicalData = await this._getTumanMonthlyRi(tumanId, 12);

      if (historicalData.length < 3) {
        return {
          historical: historicalData,
          forecast: [],
          trend: "stable",
          confidence: 0.3,
          yearlyGoalProbability: 0.5,
        };
      }

      // Chiziqli trend (Simple Linear Regression)
      const { slope, intercept, r2 } = this._linearRegression(
        historicalData.map((_, i) => i),
        historicalData.map((d) => d.value)
      );

      const forecast: PredictionPoint[] = [];
      const lastIdx = historicalData.length - 1;

      for (let i = 1; i <= monthsAhead; i++) {
        const predicted = slope * (lastIdx + i) + intercept;
        const stdErr = this._stdError(historicalData.map((d) => d.value), slope, intercept);
        const margin = 1.96 * stdErr; // 95% confidence interval

        const nextDate = new Date();
        nextDate.setMonth(nextDate.getMonth() + i);
        const monthLabel = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;

        forecast.push({
          month: monthLabel,
          value: Math.max(0, Math.min(100, Math.round(predicted * 10) / 10)),
          predicted: true,
          confidenceLow: Math.max(0, Math.round((predicted - margin) * 10) / 10),
          confidenceHigh: Math.min(100, Math.round((predicted + margin) * 10) / 10),
        });
      }

      const trend: "up" | "down" | "stable" =
        slope > 0.5 ? "up" : slope < -0.5 ? "down" : "stable";

      // Yillik maqsad (RI 60+ ball → "yaxshi" hisobi)
      const lastValue = historicalData[historicalData.length - 1]?.value ?? 0;
      const yearlyGoalProbability = Math.min(
        1,
        Math.max(0, (lastValue + slope * 6) / 70)
      );

      return {
        historical: historicalData,
        forecast,
        trend,
        confidence: Math.min(0.95, Math.max(0.3, r2)),
        yearlyGoalProbability: Math.round(yearlyGoalProbability * 100) / 100,
      };
    });
  }

  // ── Fond yetishmovchiligi bashorati ───────────────────────────────────────

  async predictFundShortage(libraryId: string): Promise<{
    booksAtRisk: Array<{ bookId: string; title: string; daysUntilZero: number }>;
    summary: string;
  }> {
    const cacheKey = `predict:fund:${libraryId}`;
    return this.cache.remember(cacheKey, 900, async () => {
      const books = await this.prisma.book.findMany({
        where: { libraryId, availableCount: { gt: 0 } },
        select: {
          id: true,
          title: true,
          availableCount: true,
          transactions: {
            where: {
              type: "BORROW",
              borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            },
            select: { id: true },
          },
        },
        take: 100,
      });

      const atRisk = books
        .map((book) => {
          const dailyBorrowRate = book.transactions.length / 30;
          const daysUntilZero =
            dailyBorrowRate > 0
              ? Math.floor(book.availableCount / dailyBorrowRate)
              : 999;
          return { bookId: book.id, title: book.title, daysUntilZero };
        })
        .filter((b) => b.daysUntilZero < 14)
        .sort((a, b) => a.daysUntilZero - b.daysUntilZero);

      const summary =
        atRisk.length === 0
          ? "Keyingi 2 haftada fond yetishmovchiligi kutilmaydi."
          : `${atRisk.length} ta kitob 2 hafta ichida tugashi mumkin.`;

      return { booksAtRisk: atRisk, summary };
    });
  }

  // ── Root Cause Analysis ───────────────────────────────────────────────────

  async analyzeRootCause(
    tumanId: string,
    issue: "RI_DROP" | "LOW_COVERAGE" | "INACTIVE_LIBRARY"
  ): Promise<RootCauseAnalysis> {
    const cacheKey = `rca:${tumanId}:${issue}`;
    return this.cache.remember(cacheKey, 3600, async () => {
      const causes: RootCause[] = [];

      // ── Sabab 1: Kutubxona ta'mir/yopiq ──────────────────────────────────
      const inactiveLibs = await this.prisma.library.findMany({
        where: {
          tumanId,
          status: "ACTIVE",
          transactions: {
            none: { borrowedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
          },
        },
        select: { id: true, name: true },
      });

      if (inactiveLibs.length > 0) {
        causes.push({
          factor: "LIBRARY_INACTIVE",
          description: `${inactiveLibs.length} ta kutubxona 14+ kun faolsiz`,
          impact: "HIGH",
          evidence: `Faolsiz kutubxonalar: ${inactiveLibs.map((l) => l.name).join(", ")}`,
          recommendation:
            "Kutubxona direktori va muassasa adminga darhol bog'laning. Ta'mir sabab bo'lsa muddatni tekshiring.",
        });
      }

      // ── Sabab 2: Fond yangalanmagan (6+ oy) ───────────────────────────────
      const staleLibs = await this.prisma.library.count({
        where: {
          tumanId,
          updatedAt: { lte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
        },
      });

      if (staleLibs > 0) {
        causes.push({
          factor: "STALE_FUND",
          description: `${staleLibs} ta kutubxona fondi 6+ oy yangilanmagan`,
          impact: "MEDIUM",
          evidence: `Oxirgi fond yangilanish sanasidan ${Math.floor(180 / 30)} oy o'tgan`,
          recommendation:
            "Yangi kitoblar sotib olish yoki donatsiya yo'li bilan fond yangilanishi zarur.",
        });
      }

      // ── Sabab 3: 15-25 yosh segmenti faoliyati pasayishi ─────────────────
      const youngUsers = await this.prisma.bookTransaction.count({
        where: {
          type: "BORROW",
          borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          user: {
            address: { tumanId },
            dob: {
              gte: new Date(Date.now() - 25 * 365 * 24 * 60 * 60 * 1000),
              lte: new Date(Date.now() - 15 * 365 * 24 * 60 * 60 * 1000),
            },
          },
        },
      });

      if (youngUsers < 10) {
        causes.push({
          factor: "YOUTH_DISENGAGEMENT",
          description: "15-25 yoshli kitobxonlar faolligi past",
          impact: "MEDIUM",
          evidence: `Bu oy faqat ${youngUsers} ta yosh kitobxon faol bo'lgan`,
          recommendation:
            "Jadidlar izidan klublari faollashtirish va maktablar bilan koordinatsiya kerak.",
        });
      }

      // ── Sabab 4: Mavsumiy ta'sir (yoz ta'tili, imtihon) ─────────────────
      const month = new Date().getMonth() + 1;
      const isSeasonalDip = month >= 6 && month <= 8;
      if (isSeasonalDip) {
        causes.push({
          factor: "SEASONAL_EFFECT",
          description: "Yoz ta'tili davrida kitobxonlik tabiiy ravishda kamayadi",
          impact: "LOW",
          evidence: `Hozirgi oy: ${month}-oy (yoz ta'tili davri)`,
          recommendation:
            "Yozgi kitobxonlik dasturlari, ochiqdagi tadbirlar va onlayn katalog faollashtirilsin.",
        });
      }

      // ── Sabab 5: Raqobatchi hudud taqqoslash ─────────────────────────────
      if (causes.length === 0) {
        causes.push({
          factor: "UNKNOWN",
          description: "Aniq sabab aniqlanmadi",
          impact: "LOW",
          evidence: "Standart ko'rsatkichlardan sezilarli og'ish kuzatilmadi",
          recommendation:
            "Kutubxonachi va mahalla vakillar bilan suhbat o'tkazish tavsiya qilinadi.",
        });
      }

      const topCause = causes[0];
      const summary =
        `Tahlil natijasida asosiy sabab: ${topCause.description}. ` +
        `${topCause.recommendation}`;

      return {
        scopeId: tumanId,
        scopeType: "TUMAN",
        issue,
        causes: causes.sort((a, b) => {
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          return order[a.impact] - order[b.impact];
        }),
        summary,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  // ── Yillik maqsad erishish ehtimoli (respublika) ─────────────────────────

  async nationalGoalForecast(): Promise<{
    currentProgress: number;
    targetBooks: number;
    probability: number;
    trend: string;
    forecast: string;
  }> {
    const cacheKey = "predict:national:goal";
    return this.cache.remember(cacheKey, 3600, async () => {
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      const TARGET = 10; // 10 kitob/kishi/yil

      const [totalUsers, booksThisYear] = await Promise.all([
        this.prisma.user.count({ where: { status: "ACTIVE" } }),
        this.prisma.bookTransaction.count({
          where: {
            type: "BORROW",
            borrowedAt: { gte: yearStart },
          },
        }),
      ]);

      const monthsElapsed = new Date().getMonth() + 1;
      const avgBooksPerPerson = totalUsers > 0 ? booksThisYear / totalUsers : 0;
      const projectedYearly = (avgBooksPerPerson / monthsElapsed) * 12;
      const probability = Math.min(1, Math.max(0, projectedYearly / TARGET));

      const trend =
        projectedYearly > TARGET * 0.9
          ? "📈 Maqsadga erishish mumkin"
          : projectedYearly > TARGET * 0.6
          ? "⚠️ O'rtacha holat — qo'shimcha chora kerak"
          : "🔴 Maqsadga erishish qiyin — tezkor harakat zarur";

      return {
        currentProgress: Math.round(avgBooksPerPerson * 100) / 100,
        targetBooks: TARGET,
        probability: Math.round(probability * 100),
        trend,
        forecast: `Hozirgi trendda yil oxirida o'rtacha ${projectedYearly.toFixed(1)} kitob/kishi bo'ladi`,
      };
    });
  }

  // ── Ichki yordamchi metodlar ──────────────────────────────────────────────

  private async _getTumanMonthlyRi(
    tumanId: string,
    monthsBack: number
  ): Promise<PredictionPoint[]> {
    const result: PredictionPoint[] = [];

    for (let i = monthsBack - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);

      const records = await this.prisma.readingIndex.findMany({
        where: {
          calculatedAt: { gte: monthStart, lte: monthEnd },
          user: { address: { tumanId } },
        },
        select: { score: true },
        take: 5000,
      });

      const avg =
        records.length > 0
          ? records.reduce((s, r) => s + r.score, 0) / records.length
          : 0;

      result.push({
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        value: Math.round(avg * 10) / 10,
        predicted: false,
      });
    }

    return result;
  }

  // ── Chiziqli regresiya ────────────────────────────────────────────────────

  private _linearRegression(
    x: number[],
    y: number[]
  ): { slope: number; intercept: number; r2: number } {
    const n = x.length;
    if (n < 2) return { slope: 0, intercept: y[0] ?? 0, r2: 0 };

    const xMean = x.reduce((a, b) => a + b, 0) / n;
    const yMean = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (x[i] - xMean) * (y[i] - yMean);
      denominator += (x[i] - xMean) ** 2;
    }

    const slope = denominator !== 0 ? numerator / denominator : 0;
    const intercept = yMean - slope * xMean;

    // R² hisoblash
    const ssRes = y.reduce((s, yi, i) => s + (yi - (slope * x[i] + intercept)) ** 2, 0);
    const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
    const r2 = ssTot !== 0 ? 1 - ssRes / ssTot : 0;

    return { slope, intercept, r2: Math.max(0, r2) };
  }

  private _stdError(y: number[], slope: number, intercept: number): number {
    const n = y.length;
    if (n < 3) return 5;
    const residuals = y.map((yi, i) => (yi - (slope * i + intercept)) ** 2);
    return Math.sqrt(residuals.reduce((a, b) => a + b, 0) / (n - 2));
  }
}
