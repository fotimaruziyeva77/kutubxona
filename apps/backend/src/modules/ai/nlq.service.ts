import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { NLQ_TEMPLATES, NlqTemplate } from "./nlq-templates";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";

// ── Region aniqlash (H13 fix) ────────────────────────────────────────────────
// Eski versiya nomlarni o'ylab topilgan "UZ-08" kodlarga moslab, ularni
// `address.viloyatId` (cuid!) bilan solishtirardi — join HECH QACHON mos
// kelmasdi va har bir region uchun 0 qaytarardi. Endi region DB dagi haqiqiy
// Viloyat yozuvidan (slug/name, apostrof/registrga sezgir emas) topiladi.

/** Qo'shimcha yozilish shakllari → seed.ts dagi kanonik slug */
const REGION_EXTRA_ALIASES: Record<string, string> = {
  "fergana": "fargona",          // ruscha/inglizcha shakl → Farg'ona
  "qoraqalpoq": "qoraqalpogiston",
  "karakalpak": "qoraqalpogiston",
};

/** Apostrof variantlari (o', g', ʻ, ’ ...) va registrni tekislash */
function normalizeUz(s: string): string {
  return s.toLowerCase().replace(/[’'`ʻʼ‘]/g, "").trim();
}

interface RegionEntry {
  /** Viloyat.id — haqiqiy cuid (DB join uchun) */
  id: string;
  /** Kanonik nom — javob matnida ko'rsatiladi ("Farg'ona") */
  name: string;
  slug: string;
  /** Savol matnida qidiriladigan normalizatsiya qilingan shakllar */
  candidates: string[];
}

/** So'rov beruvchining geografik vakolat doirasi (LOW-b/LOW-c fix) */
interface CallerScope {
  role: string | null;
  viloyatId?: string;
  tumanId?: string;
  /** true — vakolat doirasi aniqlanmadi: PII so'rovlar (top_readers) bo'sh qaytadi */
  restricted: boolean;
  /** Cache kalitining rol+hudud segmenti — foydalanuvchilararo cache sizishini to'xtatadi */
  cacheSeg: string;
}

// ── So'rov niyati — NLQ_TEMPLATES dan kelib chiqadi ──────────────────────────
type QueryIntent = (typeof NLQ_TEMPLATES)[number]["intent"] | "unknown";

interface ParsedQuery {
  intent: QueryIntent;
  matchedTemplate?: NlqTemplate;
  region?: string;
  regionId?: string;
  timeframe?: "today" | "week" | "month" | "year";
  metric?: string;
  rawText: string;
}

export interface NlqResponse {
  question: string;
  answer: string;
  data?: unknown;
  chartType?: "line" | "bar" | "pie" | "table" | "number";
  chartData?: unknown;
  confidence: number; // 0-1
  usedLlm: boolean;
}

@Injectable()
export class NlqService {
  private readonly logger = new Logger(NlqService.name);
  private readonly openaiKey: string | undefined;

  /** Region xaritasi in-memory L1 cache (L2 — Redis, pastdagi _getRegionEntries) */
  private regionCache: { entries: RegionEntry[]; expiresAt: number } | null = null;
  private static readonly REGION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 daqiqa
  private static readonly REGION_CACHE_KEY = "nlq:regions:v1";

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {
    this.openaiKey = this.config.get<string>("OPENAI_API_KEY");
  }

  // ── Asosiy so'rov qabul qilish ────────────────────────────────────────────

  async query(question: string, userId?: string): Promise<NlqResponse> {
    // LOW-a fix: cache kaliti rol+hudud bilan nomlanadi. Eski `nlq:<savol>`
    // kaliti barcha foydalanuvchilar o'rtasida bo'linar edi — tuman admin
    // super adminning milliy javobini (PII bilan) olishi mumkin edi.
    const scope = await this._resolveCallerScope(userId);
    const cacheKey = `nlq:${scope.cacheSeg}:${question.toLowerCase().trim().slice(0, 80)}`;
    return this.cache.remember(cacheKey, 300, async () => {
      const parsed = await this._parseQuery(question);
      this.logger.log(`NLQ niyat: ${parsed.intent} | region: ${parsed.region ?? "yo'q"}`);

      let response: NlqResponse;

      switch (parsed.intent) {
        case "region_stats":
          response = await this._handleRegionStats(parsed);
          break;
        case "inactive_clubs":
          response = await this._handleInactiveClubs(parsed);
          break;
        case "missing_books":
          response = await this._handleMissingBooks(parsed);
          break;
        case "trend_analysis":
          response = await this._handleTrendAnalysis(parsed);
          break;
        case "top_readers":
          response = await this._handleTopReaders(parsed, scope);
          break;
        case "goal_progress":
          response = await this._handleGoalProgress(parsed);
          break;
        default:
          response = await this._handleUnknown(parsed);
      }

      // Agar OpenAI API sozlangan bo'lsa — javobni boyitish
      if (this.openaiKey && response.confidence < 0.8) {
        try {
          response = await this._enrichWithLlm(question, response);
        } catch (err) {
          this.logger.warn(`LLM boyitish xatosi: ${(err as Error).message}`);
        }
      }

      return response;
    });
  }

  // ── Caller scope (LOW-a / LOW-c) ──────────────────────────────────────────
  // ai.controller fraud review-queue patterni: rol JWT da, geografik doira
  // adminning o'z manzilidan (address.tumanId / viloyatId) olinadi.

  private async _resolveCallerScope(userId?: string): Promise<CallerScope> {
    if (!userId) {
      // Guard ortida bu holat bo'lmasligi kerak — fail-closed.
      return { role: null, restricted: true, cacheSeg: "anon:none" };
    }

    const caller = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        address: { select: { tumanId: true, viloyatId: true } },
      },
    });

    if (!caller) {
      return { role: null, restricted: true, cacheSeg: "anon:none" };
    }

    const role = String(caller.role);

    if (role === "SUPER_ADMIN") {
      return { role, restricted: false, cacheSeg: "SUPER_ADMIN:national" };
    }

    if (role === "VILOYAT_ADMIN") {
      const viloyatId = caller.address?.viloyatId;
      return viloyatId
        ? { role, viloyatId, restricted: false, cacheSeg: `${role}:viloyat:${viloyatId}` }
        : { role, restricted: true, cacheSeg: `${role}:none` };
    }

    if (role === "TUMAN_ADMIN" || role === "MUASSASA_ADMIN") {
      const tumanId = caller.address?.tumanId;
      return tumanId
        ? { role, tumanId, restricted: false, cacheSeg: `${role}:tuman:${tumanId}` }
        : { role, restricted: true, cacheSeg: `${role}:none` };
    }

    // Boshqa rollar (endpoint RolesGuard bilan yopiq, baribir fail-closed)
    return { role, restricted: true, cacheSeg: `${role}:none` };
  }

  // ── Region xaritasi — DB dan (H13) ────────────────────────────────────────
  // Viloyat jadvali kichik (14 yozuv) va deyarli o'zgarmaydi: L1 in-memory
  // (10 daqiqa) + L2 Redis (10 daqiqa) cache. DB xatosida bo'sh ro'yhat —
  // savol region filtrisiz (milliy) davom etadi.

  private async _getRegionEntries(): Promise<RegionEntry[]> {
    if (this.regionCache && this.regionCache.expiresAt > Date.now()) {
      return this.regionCache.entries;
    }

    let rows: Array<{ id: string; name: string; slug: string }> = [];
    let loadFailed = false;
    try {
      rows = await this.cache.remember(
        NlqService.REGION_CACHE_KEY,
        Math.floor(NlqService.REGION_CACHE_TTL_MS / 1000),
        () =>
          this.prisma.viloyat.findMany({
            select: { id: true, name: true, slug: true },
          }),
      );
    } catch (err) {
      this.logger.warn(`Region xaritasini yuklab bo'lmadi: ${(err as Error).message}`);
      rows = [];
      loadFailed = true;
    }

    const entries: RegionEntry[] = (rows ?? []).map((v) => {
      const candidates = new Set<string>([normalizeUz(v.name), normalizeUz(v.slug)]);
      for (const [alias, slug] of Object.entries(REGION_EXTRA_ALIASES)) {
        if (slug === v.slug) candidates.add(normalizeUz(alias));
      }
      return { id: v.id, name: v.name, slug: v.slug, candidates: [...candidates].filter(Boolean) };
    });

    // Muvaffaqiyatsiz yuklashni faqat 30 soniyaga eslab qolamiz — DB
    // tiklanishi bilan region aniqlash qayta ishlay boshlaydi.
    this.regionCache = {
      entries,
      expiresAt: Date.now() + (loadFailed ? 30_000 : NlqService.REGION_CACHE_TTL_MS),
    };
    return entries;
  }

  // ── So'rov tahlili (NLQ_TEMPLATES keyword matching) ────────────────────────

  private async _parseQuery(text: string): Promise<ParsedQuery> {
    const lower = text.toLowerCase();
    const parsed: ParsedQuery = { intent: "unknown", rawText: text };

    // Region aniqlash — DB dagi haqiqiy Viloyat yozuvlari bo'yicha.
    // Eng uzun mos kelgan shakl yutadi: "toshkent viloyati" so'rovi
    // "Toshkent shahar"ni emas, "Toshkent viloyati"ni tanlaydi.
    const normalizedQuestion = normalizeUz(lower);
    const regions = await this._getRegionEntries();
    let bestRegion: RegionEntry | undefined;
    let bestLen = 0;
    for (const entry of regions) {
      for (const candidate of entry.candidates) {
        if (candidate.length > bestLen && normalizedQuestion.includes(candidate)) {
          bestRegion = entry;
          bestLen = candidate.length;
        }
      }
    }
    if (bestRegion) {
      parsed.region = bestRegion.name; // kanonik nom — javob matni uchun
      parsed.regionId = bestRegion.id; // haqiqiy cuid — DB join uchun
    }

    // Vaqt oralig'i
    if (lower.includes("bugun")) parsed.timeframe = "today";
    else if (lower.includes("hafta")) parsed.timeframe = "week";
    else if (lower.includes("oy") || lower.includes("this month")) parsed.timeframe = "month";
    else if (lower.includes("yil")) parsed.timeframe = "year";
    else parsed.timeframe = "month";

    // Niyat aniqlash — NLQ_TEMPLATES keyword matching
    // Template with the highest keyword match count wins.
    // Uses simple substring includes (Uzbek stems: "pasay" matches "pasaydi").
    // When scores are tied, the template with fewer total keywords wins
    // (more specific = better match).
    let bestMatch: NlqTemplate | undefined;
    let bestScore = 0;
    let bestSpecificity = Infinity;

    for (const template of NLQ_TEMPLATES) {
      let score = 0;
      for (const keyword of template.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          score++;
        }
      }
      // Tie-break: prefer template with fewer keywords (more specific match)
      const specificity = template.keywords.length;
      if (score > bestScore || (score === bestScore && score > 0 && specificity < bestSpecificity)) {
        bestScore = score;
        bestMatch = template;
        bestSpecificity = specificity;
      }
    }

    if (bestMatch && bestScore > 0) {
      parsed.intent = bestMatch.intent;
      parsed.matchedTemplate = bestMatch;
    } else if (parsed.region) {
      // Fallback: region detected but no keyword match -> region_stats
      const regionTemplate = NLQ_TEMPLATES.find((t) => t.intent === "region_stats");
      parsed.intent = "region_stats";
      parsed.matchedTemplate = regionTemplate;
    }

    return parsed;
  }

  // ── Region statistikasi ───────────────────────────────────────────────────

  private async _handleRegionStats(q: ParsedQuery): Promise<NlqResponse> {
    const since = this._sinceDate(q.timeframe ?? "month");

    const [activeUsers, totalBorrows, avgRi] = await Promise.all([
      this.prisma.user.count({
        where: {
          status: "ACTIVE",
          ...(q.regionId
            ? { address: { viloyatId: q.regionId } }
            : {}),
        },
      }),
      this.prisma.bookTransaction.count({
        where: {
          type: "BORROW",
          borrowedAt: { gte: since },
          ...(q.regionId
            ? { user: { address: { viloyatId: q.regionId } } }
            : {}),
        },
      }),
      this._getAvgRi(q.regionId),
    ]);

    const regionLabel = q.region
      ? q.region.charAt(0).toUpperCase() + q.region.slice(1)
      : "O'zbekiston";

    const answer =
      `${regionLabel}da bu ${q.timeframe === "month" ? "oy" : q.timeframe ?? "oy"} uchun:\n` +
      `• Faol kitobxonlar: ${activeUsers.toLocaleString()}\n` +
      `• O'qilgan kitoblar: ${totalBorrows.toLocaleString()}\n` +
      `• O'rtacha Reading Index: ${avgRi.toFixed(1)} ball`;

    return {
      question: q.rawText,
      answer,
      data: { activeUsers, totalBorrows, avgRi },
      chartType: "number",
      chartData: [
        { label: "Faol kitobxonlar", value: activeUsers },
        { label: "O'qilgan kitoblar", value: totalBorrows },
        { label: "O'rtacha RI", value: Math.round(avgRi * 10) / 10 },
      ],
      confidence: 0.9,
      usedLlm: false,
    };
  }

  // ── Faolsiz klublar ───────────────────────────────────────────────────────

  private async _handleInactiveClubs(q: ParsedQuery): Promise<NlqResponse> {
    const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

    const inactive = await this.prisma.club.findMany({
      where: {
        status: "ACTIVE",
        debates: { none: { heldAt: { gte: cutoff } } },
      },
      select: {
        id: true,
        name: true,
        institution: { select: { name: true, tumanId: true } },
        _count: { select: { members: true } },
        debates: { orderBy: { heldAt: "desc" }, take: 1, select: { heldAt: true } },
      },
      take: 20,
    });

    const rows = inactive.map((c) => ({
      klub: c.name,
      muassasa: c.institution?.name ?? "—",
      azo: c._count.members,
      oxirgiDebat: c.debates[0]?.heldAt
        ? Math.floor((Date.now() - c.debates[0].heldAt.getTime()) / (1000 * 60 * 60 * 24)) + " kun oldin"
        : "Hech qachon",
    }));

    const answer =
      inactive.length === 0
        ? "Barcha klublar faol — so'nggi 45 kunda debat o'tkazgan."
        : `${inactive.length} ta klub 45+ kun debat o'tkazmagan.\n` +
          inactive
            .slice(0, 5)
            .map((c) => `• ${c.name} (${c.institution?.name ?? "—"})`)
            .join("\n") +
          (inactive.length > 5 ? `\n... va yana ${inactive.length - 5} ta` : "");

    return {
      question: q.rawText,
      answer,
      data: rows,
      chartType: "table",
      chartData: rows,
      confidence: 0.95,
      usedLlm: false,
    };
  }

  // ── Fond yetishmovchiligi ─────────────────────────────────────────────────

  private async _handleMissingBooks(q: ParsedQuery): Promise<NlqResponse> {
    const since = this._sinceDate("month");

    const hotBooks = await this.prisma.bookTransaction.groupBy({
      by: ["bookId"],
      where: { type: "RESERVE", borrowedAt: { gte: since } },
      _count: { bookId: true },
      orderBy: { _count: { bookId: "desc" } },
      take: 10,
    });

    const enriched = [];
    for (const { bookId, _count } of hotBooks) {
      const book = await this.prisma.book.findUnique({
        where: { id: bookId },
        select: { title: true, author: true, availableCount: true },
      });
      if (!book) continue;
      enriched.push({
        kitob: book.title,
        muallif: book.author,
        sorovlar: _count.bookId,
        mavjud: book.availableCount,
      });
    }

    const answer =
      enriched.length === 0
        ? "Fond yetishmovchiligi aniqlanmadi."
        : `Eng ko'p so'raladigan lekin yetishmayotgan kitoblar:\n` +
          enriched
            .slice(0, 5)
            .map((b) => `• "${b.kitob}" — ${b.sorovlar} so'rov, ${b.mavjud} nusxa`)
            .join("\n");

    return {
      question: q.rawText,
      answer,
      data: enriched,
      chartType: "table",
      chartData: enriched,
      confidence: 0.9,
      usedLlm: false,
    };
  }

  // ── Trend tahlili ─────────────────────────────────────────────────────────

  private async _handleTrendAnalysis(q: ParsedQuery): Promise<NlqResponse> {
    // Oxirgi 6 oy bo'yicha oylik borrow soni
    const months = 6;
    const chartData = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);

      const count = await this.prisma.bookTransaction.count({
        where: {
          type: "BORROW",
          borrowedAt: { gte: monthStart, lte: monthEnd },
          ...(q.regionId ? { user: { address: { viloyatId: q.regionId } } } : {}),
        },
      });

      chartData.push({
        oy: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        kitoblar: count,
      });
    }

    const lastTwo = chartData.slice(-2);
    const trend =
      lastTwo.length === 2 && lastTwo[0].kitoblar > 0
        ? ((lastTwo[1].kitoblar - lastTwo[0].kitoblar) / lastTwo[0].kitoblar) * 100
        : 0;

    const trendStr =
      trend > 0 ? `📈 +${trend.toFixed(1)}% o'sish` : `📉 ${trend.toFixed(1)}% pasayish`;

    const regionLabel = q.region
      ? q.region.charAt(0).toUpperCase() + q.region.slice(1) + "da"
      : "Respublikada";

    const answer =
      `${regionLabel} so'nggi 6 oylik kitobxonlik trendi:\n` +
      chartData.map((d) => `• ${d.oy}: ${d.kitoblar.toLocaleString()} kitob`).join("\n") +
      `\n\nYakuniy trend: ${trendStr}`;

    return {
      question: q.rawText,
      answer,
      data: chartData,
      chartType: "line",
      chartData,
      confidence: 0.85,
      usedLlm: false,
    };
  }

  // ── Top kitobxonlar ───────────────────────────────────────────────────────
  // LOW-c fix: kitobxon ism+sifatId — PII. So'rov beruvchining geografik
  // doirasi MAJBURIY qo'llanadi (TUMAN_ADMIN → o'z tumani, VILOYAT_ADMIN →
  // o'z viloyati) va ismlar maskNameIfMinor (TOP-06) dan o'tadi.

  private async _handleTopReaders(q: ParsedQuery, scope: CallerScope): Promise<NlqResponse> {
    if (scope.restricted) {
      return {
        question: q.rawText,
        answer:
          "Hududiy vakolat doirangiz aniqlanmadi — kitobxonlar ro'yhati ko'rsatilmaydi. " +
          "Profilingizdagi manzil ma'lumotlarini tekshiring yoki administratorga murojaat qiling.",
        data: [],
        chartType: "table",
        chartData: [],
        confidence: 0.9,
        usedLlm: false,
      };
    }

    // Doira + so'ralgan region kesishmasi (AND): tuman admin boshqa viloyatni
    // so'rasa, kesishma bo'sh to'plam bo'ladi — ma'lumot sizmaydi.
    const geoConditions: Array<Record<string, unknown>> = [];
    if (q.regionId) geoConditions.push({ address: { viloyatId: q.regionId } });
    if (scope.tumanId) geoConditions.push({ address: { tumanId: scope.tumanId } });
    else if (scope.viloyatId) geoConditions.push({ address: { viloyatId: scope.viloyatId } });

    const top = await this.prisma.readingIndex.findMany({
      where: {
        calculatedAt: { gte: this._sinceDate("month") },
        ...(geoConditions.length ? { user: { AND: geoConditions } } : {}),
      },
      distinct: ["userId"],
      orderBy: { score: "desc" },
      take: 10,
      include: { user: { select: { name: true, sifatId: true, dob: true } } },
    });

    const rows = top.map((r, i) => ({
      o_rin: i + 1,
      ism: maskNameIfMinor(r.user?.name, r.user?.dob),
      id: r.user?.sifatId ?? "—",
      ball: Math.round(r.score * 10) / 10,
    }));

    const regionLabel = q.region
      ? q.region.charAt(0).toUpperCase() + q.region.slice(1) + "da"
      : "Respublikada";

    const answer =
      `${regionLabel} bu oyning eng faol kitobxonlari:\n` +
      rows
        .slice(0, 5)
        .map((r) => `${r.o_rin}. ${r.ism} — ${r.ball} ball`)
        .join("\n");

    return {
      question: q.rawText,
      answer,
      data: rows,
      chartType: "table",
      chartData: rows,
      confidence: 0.9,
      usedLlm: false,
    };
  }

  // ── Maqsad progress ───────────────────────────────────────────────────────

  private async _handleGoalProgress(q: ParsedQuery): Promise<NlqResponse> {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const ANNUAL_GOAL = 10; // 10 kitob/yil PQ-9

    const [usersWithGoal, totalBorrows] = await Promise.all([
      this.prisma.user.count({ where: { status: "ACTIVE" } }),
      this.prisma.bookTransaction.groupBy({
        by: ["userId"],
        where: { type: "BORROW", borrowedAt: { gte: yearStart } },
        _count: { userId: true },
        having: { userId: { _count: { gte: ANNUAL_GOAL } } },
      }),
    ]);

    const achieved = totalBorrows.length;
    const percent = usersWithGoal > 0 ? (achieved / usersWithGoal) * 100 : 0;

    const answer =
      `Yillik 10 kitob maqsadi holati:\n` +
      `• Jami faol kitobxon: ${usersWithGoal.toLocaleString()}\n` +
      `• Maqsadga erishganlar: ${achieved.toLocaleString()} (${percent.toFixed(1)}%)\n` +
      `• Holat: ${percent >= 50 ? "✅ Yaxshi" : percent >= 30 ? "⚠️ O'rtacha" : "🔴 Yetarli emas"}`;

    return {
      question: q.rawText,
      answer,
      data: { usersWithGoal, achieved, percent },
      chartType: "number",
      chartData: [
        { label: "Maqsadga erishganlar", value: achieved },
        { label: "Jami kitobxonlar", value: usersWithGoal },
        { label: "Foiz", value: Math.round(percent * 10) / 10 },
      ],
      confidence: 0.88,
      usedLlm: false,
    };
  }

  // ── Noma'lum so'rov ───────────────────────────────────────────────────────

  private async _handleUnknown(q: ParsedQuery): Promise<NlqResponse> {
    return {
      question: q.rawText,
      answer:
        "So'rovingizni to'liq tushuna olmadim. Quyidagilarni so'rashingiz mumkin:\n" +
        "• \"Navoiyda bu oy kitobxonlik qanday?\"\n" +
        "• \"Qaysi maktablarda klub faoliyatsiz?\"\n" +
        "• \"Qaysi kitob ko'p so'ralmoqda, lekin yo'q?\"\n" +
        "• \"Yillik maqsadga erishilganmi?\"",
      confidence: 0,
      usedLlm: false,
    };
  }

  // ── OpenAI bilan boyitish ─────────────────────────────────────────────────

  private async _enrichWithLlm(question: string, base: NlqResponse): Promise<NlqResponse> {
    if (!this.openaiKey) return base;

    const systemPrompt = `Siz SIFAT LIBRARY platformasining O'zbek tilidagi AI yordamchisisiz.
Sizga ma'lumotlar bazasidan olingan statistika beriladi.
Foydalanuvchi savoliga qisqa, aniq va professional javob bering.
Faqat berilgan ma'lumotlardan foydalaning.`;

    const userPrompt = `Savol: ${question}\n\nHisoblangan ma'lumotlar:\n${JSON.stringify(base.data, null, 2)}\n\nDastlabki javob:\n${base.answer}\n\nYaxshilangan javob bering:`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI xatosi: ${response.status}`);

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return {
      ...base,
      answer: json.choices[0]?.message.content ?? base.answer,
      usedLlm: true,
      confidence: 0.92,
    };
  }

  // ── Savollar tarixi olish ─────────────────────────────────────────────────

  async getQueryHistory(userId: string) {
    // Future: Prisma da saqlash. Hozir cache dan
    return this.cache.remember(`nlq:history:${userId}`, 3600, async () => [] as NlqResponse[]);
  }

  // ── Yordamchi metodlar ────────────────────────────────────────────────────

  private _sinceDate(timeframe: string): Date {
    const now = Date.now();
    switch (timeframe) {
      case "today": return new Date(now - 24 * 60 * 60 * 1000);
      case "week":  return new Date(now - 7 * 24 * 60 * 60 * 1000);
      case "year":  return new Date(now - 365 * 24 * 60 * 60 * 1000);
      default:      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    }
  }

  private async _getAvgRi(viloyatId?: string): Promise<number> {
    const records = await this.prisma.readingIndex.findMany({
      where: {
        calculatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        ...(viloyatId ? { user: { address: { viloyatId } } } : {}),
      },
      select: { score: true },
      take: 10_000,
    });
    if (records.length === 0) return 0;
    return records.reduce((s, r) => s + r.score, 0) / records.length;
  }
}
