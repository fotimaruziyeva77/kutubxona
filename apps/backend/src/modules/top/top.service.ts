import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { FraudService } from "../ai/fraud.service";
import { StatsGateway } from "../../infra/gateway/stats.gateway";
import { BadgeService } from "../badge/badge.service";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";
// Plan 05-03 T1 (STAT-05 foundation) — getAgeGroup promoted to a shared util.
// Before: Phase 3 inline definition here with 4 buckets and no `unknown`.
// After: imported from common/utils/age-group.util.ts so AdminService can
// reuse the exact same boundary semantics for getAgeBreakdown.
import { getAgeGroup, type AgeGroup as SharedAgeGroup } from "../../common/utils/age-group.util";
import { Prisma, Severity, UserGender, UserType } from "@prisma/client";

// Top-100 Final Score formulasi og'irliklari (TZ §5.2)
const FINAL_WEIGHTS = {
  verifiedReading: 0.40,
  consistency:     0.15,
  diversity:       0.10,
  comprehension:   0.15,
  discipline:      0.10,
  trust:           0.10
};

// Top-100 filter API surface accepts the 4 named buckets only (no 'unknown').
// SharedAgeGroup adds 'unknown' for missing DOBs; Top-100 entries are gated
// by ACTIVE users whose DOB is always set, so the local AgeGroup alias keeps
// the call-site narrower than the util's return type.
type AgeGroup = Exclude<SharedAgeGroup, "unknown">;

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// ── FIX H9 (OOM): chunk o'lchami — RiRecalcProcessor bilan bir xil (1000) ───
// computeMonthlyTop100 endi 5M ACTIVE foydalanuvchini BITTA findMany bilan
// emas, 1000-talik cursor-sahifalangan chunklarda o'qiydi. Oylik job uchun
// ketma-ket (inline) chunklash yetarli — wall-clock kritik emas, xotira kritik.
const TOP100_SCAN_CHUNK_SIZE = 1000;

// DRAFT sifatida saqlanadigan nomzodlar soni — mavjud semantika (200: Top-100
// + zaxira, FLAGGED tushib qolganlar o'rnini admin ko'rishi uchun).
const TOP100_DRAFT_POOL_SIZE = 200;

// FIX H8 leader-lock TTL — subscription.service.ts FIX F bilan bir xil (2 soat).
const TOP100_CRON_LOCK_TTL_SEC = 2 * 60 * 60;

// ── FIX H10: Asia/Tashkent kalendar kuni ─────────────────────────────────────
// K8s podlar UTC da ishlaydi (Plan 04-04 FIX E topilmasi), shuning uchun
// `new Date().getDate()` 02:00 Tashkent paytida HALI oldingi UTC kunini
// qaytaradi. O'zbekiston doimiy UTC+5 (DST yo'q) — Click/Donate webhook
// kodidagi "+05:00" ankerlash precedentiga mos ravishda offset bilan
// Tashkent kalendar qismlarini hisoblaymiz.
const TASHKENT_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;

function tashkentDayInfo(now = new Date()): {
  day: number;
  lastDay: number;
  dateStr: string; // YYYY-MM-DD (Tashkent)
} {
  const t = new Date(now.getTime() + TASHKENT_UTC_OFFSET_MS);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth(); // 0-based
  const day = t.getUTCDate();
  // Keyingi oyning 0-kuni = joriy oyning oxirgi kuni (fevral 28/29 ham to'g'ri)
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { day, lastDay, dateStr };
}

// FIX H9: chunk scoringda ishlatiladigan minimal strukturaviy tip —
// faqat scoring uchun zarur maydonlar (xotira chegarasi shu yerda).
interface ScoringUser {
  id: string;
  dob: Date | string | null;
  gender: UserGender;
  type: UserType;
  trustScore: number;
  transactions: Array<{
    bookId: string | null;
    returnedAt: Date | null;
    penaltyDays: number;
    book?: { genre: string | null; isbn?: string | null } | null;
  }>;
  isbnScans: Array<{
    isbn: string | null;
    source: string | null;
    confirmedAt: Date | null;
  }>;
  comprehensionTests: Array<{ id?: string }>;
}

// FIX H9: chunklar bo'ylab to'planadigan KICHIK obyekt — relation massivlari
// chunk tugagach GC ga qaytadi, faqat shu skalyar natija saqlanadi.
interface ScoredCandidate {
  userId: string;
  gender: UserGender;
  type: UserType;
  ageGroup: SharedAgeGroup;
  score: number;
  components: {
    verifiedReading: number;
    consistency: number;
    diversity: number;
    comprehension: number;
    discipline: number;
    trust: number;
  };
}

// ── Previous month (UTC) — used by the 1st-day auto-publish cron ─────────────
// On the 1st of a month the cron is publishing the JUST-ENDED month, not the
// current calendar month.
function previousMonthKey(date = new Date()): string {
  const prev = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return monthKey(prev);
}

@Injectable()
export class TopService {
  private readonly logger = new Logger(TopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replica: PrismaReplicaService,
    private readonly fraud: FraudService,
    // Plan 03-04 TOP-07 + GAME-01: real-time WebSocket emit + badge awards
    // wired into the publication path. Both are best-effort side effects —
    // emit failures must NOT roll back the status transition.
    private readonly gateway: StatsGateway,
    private readonly badge: BadgeService,
    // FIX H8 — Redis SETNX leader lock (subscription.service.ts FIX F /
    // admin.service.ts markBookForOrder pattern). Optional, chunki eski unit
    // testlar TopService ni 5-arg konstruktor bilan quradi; runtime DI har
    // doim ta'minlaydi (CacheModule @Global). Lock YO'Q bo'lsa cron wrapper
    // school.service.refreshRankingCache kabi warn + skip qiladi.
    @Optional() private readonly redisLock?: RedisLockService,
  ) {}

  /**
   * Plan 03-04 TOP-07 (D-TOP-06 defense-in-depth): build the WebSocket
   * broadcast payload from a freshly-confirmed month. Names are masked at
   * EMIT time via maskNameIfMinor — not just at HTTP-API time — so that
   * any subscriber sees the anonymized form on the wire.
   *
   * Returns an array of {rank, score, user:{name, sifatId, type, ageGroup}}
   * suitable for direct broadcast. Truncated to 100 (Top-100 limit).
   */
  private async _buildBroadcastPayload(month: string) {
    const entries = await this.prisma.top100Entry.findMany({
      where: { month, status: "CONFIRMED" },
      orderBy: { rank: "asc" },
      take: 100,
      include: {
        user: {
          select: { name: true, sifatId: true, dob: true, type: true },
        },
      },
    });
    return entries.map((e) => ({
      rank: e.rank,
      score: e.score,
      ageGroup: e.ageGroup,
      gender: e.gender,
      user: {
        name: maskNameIfMinor(e.user.name, e.user.dob),
        sifatId: e.user.sifatId,
        type: e.user.type,
      },
    }));
  }

  // ── FIX H10: oy-oxiriga NISBIY kunlik dispetcher (02:00 Asia/Tashkent) ───
  //
  // Eski jadval kalendar kunlariga mixlangan edi:
  //   "0 2 28 * *" draft, "0 2 29 * *" fraud, "0 2 30 * *" review.
  // Fevralda 29/30 MAVJUD EMAS — fevral DRAFTlari hech qachon
  // READY_FOR_PUBLISH ga yetmasdi va fraud-gate butunlay o'tkazib yuborilardi
  // (25×BHM mukofot fraud tekshiruvisiz e'lon qilinish xavfi).
  //
  // Yangi jadval — oyning OXIRGI kuniga nisbatan (Asia/Tashkent):
  //   ┌──────────────┬─────────────────────────┬─────────┬─────────┬─────────┐
  //   │ Bosqich      │ Metod                   │ 28-kun  │ 30-kun  │ 31-kun  │
  //   │              │                         │ (fevral)│  oy     │  oy     │
  //   ├──────────────┼─────────────────────────┼─────────┼─────────┼─────────┤
  //   │ lastDay - 3  │ computeMonthlyTop100    │   25    │   27    │   28    │
  //   │ lastDay - 2  │ aiFraudCheck            │   26    │   28    │   29    │
  //   │ lastDay - 1  │ adminReviewWindowOpen   │   27    │   29    │   30    │
  //   │ keyingi oy 1 │ autoPublish (alohida    │ mart 1  │  1-kun  │  1-kun  │
  //   │              │ cron, o'zgarmagan)      │         │         │         │
  //   └──────────────┴─────────────────────────┴─────────┴─────────┴─────────┘
  // 31-kunlik oylarda eski 28/29/30 jadval bilan AYNAN mos keladi.
  //
  // FIX H8: bosqich aniqlangach Redis SETNX leader lock olinadi
  // (subscription.service.ts FIX F pattern) — 3 replicadan faqat bittasi
  // pipeline'ni yurgizadi. Biznes metodlari (computeMonthlyTop100,
  // aiFraudCheck, adminReviewWindowOpen) nomi/signaturasi O'ZGARMAGAN va
  // lock-siz qoladi — admin manual-trigger endpointlari to'g'ridan-to'g'ri
  // chaqiraveradi.
  @Cron("0 2 * * *", { timeZone: "Asia/Tashkent" })
  async monthEndPipelineDispatcher(now: Date = new Date()) {
    const { day, lastDay, dateStr } = tashkentDayInfo(now);

    let stage: "draft" | "fraud" | "review" | null = null;
    if (day === lastDay - 3) stage = "draft";
    else if (day === lastDay - 2) stage = "fraud";
    else if (day === lastDay - 1) stage = "review";

    if (!stage) {
      // Oddiy kun — hech qanday bosqich rejalashtirilmagan (lock ham olinmaydi).
      return { dispatched: null, day, lastDay };
    }

    if (!this.redisLock) {
      this.logger.warn(
        "monthEndPipelineDispatcher skipped — RedisLockService not wired (dev/tests)",
      );
      return { dispatched: null, day, lastDay };
    }

    const lockKey = `cron:top100:${stage}:${dateStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, TOP100_CRON_LOCK_TTL_SEC, dateStr);
    if (!lock.first) {
      this.logger.log(
        `monthEndPipelineDispatcher: leader lock not acquired (${lockKey}) — another replica owns the run. Skipping.`,
      );
      return { dispatched: null, day, lastDay };
    }

    this.logger.log(
      `Top-100 dispetcher: kun ${day}/${lastDay} (Tashkent) → bosqich "${stage}" ishga tushmoqda`,
    );
    switch (stage) {
      case "draft":
        await this.computeMonthlyTop100();
        break;
      case "fraud":
        await this.aiFraudCheck();
        break;
      case "review":
        await this.adminReviewWindowOpen();
        break;
    }
    return { dispatched: stage, day, lastDay };
  }

  // ── Oylik Top-100 hisoblash — DRAFT (dispetcher: lastDay-3, 02:00 Tashkent)
  // State machine entry: DRAFT. Per D-1, heavy read fan-out runs on the
  // replica; the upsert pipeline writes to primary.
  //
  // FIX H9 (OOM): avval BARCHA ACTIVE foydalanuvchilar bitta findMany bilan
  // 12 oylik nested relationlar bilan yuklanardi — 5M foydalanuvchida 2GB
  // konteyner OOM bo'ladi. Endi id bo'yicha barqaror tartiblangan cursor
  // pagination bilan 1000-talik chunklarda o'qiymiz (RiRecalcProcessor
  // chunking g'oyasi, lekin oylik job uchun inline ketma-ket). Chunkdan
  // faqat kichik ScoredCandidate obyektlari to'planadi; relation massivlari
  // chunk tugashi bilan GC ga qaytadi.
  async computeMonthlyTop100() {
    const month = monthKey();
    this.logger.log(`Top-100 hisoblanmoqda: ${month}`);

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // D-1: replica read for the 5M+ user fan-out — chunked (FIX H9).
    let scored: ScoredCandidate[] = [];
    let cursor: string | null = null;
    let chunkCount = 0;
    let scannedUsers = 0;

    for (;;) {
      // orderBy id asc — barqaror tartib cursor sahifalash uchun shart
      // (RiRecalcProcessor dagi kabi: retry/drift himoyasi).
      const users: ScoringUser[] = await this.replica.user.findMany({
        where: { status: "ACTIVE" },
        orderBy: { id: "asc" },
        take: TOP100_SCAN_CHUNK_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, dob: true, gender: true, type: true, trustScore: true,
          transactions: {
            where: { status: "RETURNED", returnedAt: { gte: oneYearAgo } },
            select: {
              bookId: true,
              returnedAt: true,
              penaltyDays: true,
              // isbn — FR1 asar-darajasida dedup (roaming teshigi), genre — diversity
              book: { select: { genre: true, isbn: true } },
            },
          },
          isbnScans: {
            where: { confirmed: true, confirmedAt: { gte: oneYearAgo } },
            select: { isbn: true, source: true, confirmedAt: true },
          },
          comprehensionTests: { where: { passed: true }, select: { id: true } },
        },
      });

      if (users.length === 0) break;
      chunkCount++;
      scannedUsers += users.length;

      for (const u of users) {
        scored.push(this._scoreUser(u, oneYearAgo, thirtyDaysAgo));
      }

      // FIX H9 (xotira chegarasi): faqat eng yaxshi 200 nomzod keyingi
      // chunkga o'tadi — 5M userda ham akkumulyator ≤ ~1200 obyekt bo'ladi.
      // V8 Array#sort BARQAROR (stable), shuning uchun natija "hammasini
      // sortlab slice(0, 200)" bilan AYNAN bir xil: teng score larda avval
      // skanerlangan (id asc) foydalanuvchi ustun turadi.
      if (scored.length > TOP100_DRAFT_POOL_SIZE) {
        scored.sort((a, b) => b.score - a.score);
        scored = scored.slice(0, TOP100_DRAFT_POOL_SIZE);
      }

      this.logger.debug(
        `Top-100 ${month}: chunk ${chunkCount} (${users.length} foydalanuvchi) skorlandi`,
      );

      cursor = users[users.length - 1].id;
      if (users.length < TOP100_SCAN_CHUNK_SIZE) break;
    }

    this.logger.log(
      `Top-100 ${month}: ${scannedUsers} ta ACTIVE foydalanuvchi ${chunkCount} ta chunkda skanerlandi`,
    );

    // Saralash va Top-100 yozish (oxirgi chunk prune qilinmagan bo'lishi mumkin)
    const sorted = scored.sort((a, b) => b.score - a.score).slice(0, TOP100_DRAFT_POOL_SIZE);

    // Mavjud DRAFT larni o'chirish (primary)
    await this.prisma.top100Entry.deleteMany({ where: { month, status: "DRAFT" } });

    // Yangi yozishlar (primary)
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      await this.prisma.top100Entry.upsert({
        where: { userId_month: { userId: s.userId, month } },
        update: { rank: i + 1, score: s.score, components: s.components, status: "DRAFT" },
        create: {
          userId: s.userId,
          month,
          rank: i + 1,
          score: s.score,
          components: s.components,
          gender: s.gender,
          ageGroup: s.ageGroup,
          userType: s.type,
          status: "DRAFT"
        }
      });
    }

    this.logger.log(`Top-100 ${month}: ${sorted.length} ta foydalanuvchi DRAFT saqlandi`);
    return { month, count: sorted.length };
  }

  // ── Bitta foydalanuvchi uchun Final Score (TZ §5.2) ──────────────────────
  // FIX H9 bilan chunk loopdan ajratildi; semantika avvalgi inline map bilan
  // BIR XIL, faqat FIX C5 (verifiedReading dedup) qo'llangan.
  private _scoreUser(
    u: ScoringUser,
    oneYearAgo: Date,
    thirtyDaysAgo: Date,
  ): ScoredCandidate {
    const recentTx = u.transactions.filter(
      (t) => t.returnedAt && t.returnedAt >= thirtyDaysAgo
    );
    const recentIsbn = u.isbnScans.filter(
      (s) => s.confirmedAt && s.confirmedAt >= thirtyDaysAgo
    );

    // 1. Verified Reading (40%) — koeffitsientli kitob soni (max 100)
    //
    // FIX C5 (yuqori yarmi): avval `u.transactions.length` ishlatilardi —
    // BIR XIL kitob N marta qaytarilsa N ball yig'ilardi (o'z-o'ziga
    // qaytarish sikli bilan 25×BHM mukofotni "fermerlash" mumkin edi).
    // Endi har manba ichida DISTINCT kitob hisoblanadi:
    //   kutubxona: RETURNED tranzaksiyalar orasida distinct ASAR — kalit
    //     book.isbn (FR1: bookId kutubxonaga bog'langan nusxa; roaming bilan
    //     bir asar har kutubxonada yangi bookId olardi), fallback bookId
    //   ISBN scan: tasdiqlangan skanlar orasida distinct isbn (manba bo'yicha)
    // Tarixiy duplikatlar ma'lumotlarda mavjud — dedup scoring vaqtida.
    // Bir asar = bir manbada bir ball.
    const distinctLibBooks = new Set(
      u.transactions
        .map((t) => t.book?.isbn || t.bookId)
        .filter((key): key is string => Boolean(key))
    );
    const distinctIsbnBooks = new Set(
      u.isbnScans
        .filter((s) => s.source !== "MUTOLAA")
        .map((s) => s.isbn)
        .filter((i): i is string => Boolean(i))
    );
    const distinctMutolaaBooks = new Set(
      u.isbnScans
        .filter((s) => s.source === "MUTOLAA")
        .map((s) => s.isbn)
        .filter((i): i is string => Boolean(i))
    );
    const libWeighted = distinctLibBooks.size * 1.0;
    const isbnWeighted = distinctIsbnBooks.size * 0.9;
    const mutolaaWeighted = distinctMutolaaBooks.size * 0.85;
    const verifiedReading = Math.min((libWeighted + isbnWeighted + mutolaaWeighted) * 5, 100);

    // 2. Consistency (15%) — haftalik muntazamlik
    const weeks = new Set<number>();
    for (const t of recentTx) {
      if (t.returnedAt) weeks.add(Math.floor(t.returnedAt.getTime() / (7 * 86400000)));
    }
    for (const s of recentIsbn) {
      if (s.confirmedAt) weeks.add(Math.floor(s.confirmedAt.getTime() / (7 * 86400000)));
    }
    const consistency = Math.min(weeks.size * 25, 100);

    // 3. Diversity (10%) — janr xilma-xilligi (12-month rolling window).
    // Plan 03-02: align with verifiedReading by filtering transactions on
    // returnedAt >= oneYearAgo. Older returns must not contribute genre
    // uniqueness — they were excluded from verifiedReading anyway by the
    // findMany where clause; this filter defends against future selects
    // that may relax that clause.
    const genres = new Set(
      u.transactions
        .filter((t) => t.returnedAt && t.returnedAt >= oneYearAgo)
        .map((t) => t.book?.genre)
        .filter(Boolean)
    );
    const diversity = Math.min(genres.size * 15, 100);

    // 4. Comprehension (15%) — o'tilgan testlar
    const comprehension = Math.min(u.comprehensionTests.length * 20, 100);

    // 5. Discipline (10%) — kechikmaslik
    const lateCount = u.transactions.filter((t) => t.penaltyDays > 0).length;
    const discipline = Math.max(0, 100 - lateCount * 10);

    // 6. Trust Score (10%)
    const trust = Math.min(u.trustScore, 100);

    const score =
      verifiedReading * FINAL_WEIGHTS.verifiedReading +
      consistency     * FINAL_WEIGHTS.consistency +
      diversity       * FINAL_WEIGHTS.diversity +
      comprehension   * FINAL_WEIGHTS.comprehension +
      discipline      * FINAL_WEIGHTS.discipline +
      trust           * FINAL_WEIGHTS.trust;

    return {
      userId: u.id,
      gender: u.gender,
      type: u.type,
      ageGroup: getAgeGroup(u.dob),
      score: Math.round(score * 10) / 10,
      components: { verifiedReading, consistency, diversity, comprehension, discipline, trust }
    };
  }

  // ── AI fraud check (dispetcher: lastDay-2) — DRAFT → FRAUD_CHECKED | FLAGGED
  // FIX H10: avval "0 2 29 * *" ga mixlangan edi — fevralda hech qachon
  // ishlamasdi (fraud-gate to'liq o'tkazib yuborilardi). Endi
  // monthEndPipelineDispatcher chaqiradi; metod o'zi lock-siz qoladi
  // (admin manual-trigger uchun).
  // Plan 03-02 (FRAUD-07): each DRAFT entry runs through the 4-layer
  // verifyTop100Candidate gate. Pass → FRAUD_CHECKED; fail → FLAGGED with
  // reasons[] merged into the components Json blob (no schema change).
  // All status mutations wrapped in $transaction interactive form to race-
  // proof against concurrent admin overrides (T-03-02-T).
  async aiFraudCheck() {
    const month = monthKey();
    this.logger.log(`Top-100 AI fraud check: ${month}`);

    const drafts = await this.prisma.top100Entry.findMany({
      where: { month, status: "DRAFT" },
      select: { id: true, userId: true, components: true },
    });

    let passed = 0;
    let flagged = 0;

    for (const entry of drafts) {
      const verdict = await this.fraud.verifyTop100Candidate(entry.userId);

      await this.prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as PrismaService;
        if (verdict.passed) {
          await txClient.top100Entry.update({
            where: { id: entry.id },
            data: { status: "FRAUD_CHECKED" },
          });
          passed++;
        } else {
          const existing = (entry.components ?? {}) as Record<string, unknown>;
          await txClient.top100Entry.update({
            where: { id: entry.id },
            data: {
              status: "FLAGGED",
              components: { ...existing, flagReasons: verdict.reasons } as Prisma.InputJsonValue,
            },
          });
          flagged++;
        }

        await txClient.aiAuditLog.create({
          data: {
            scope: "TOP100",
            scopeId: month,
            issueType: "STATE_TRANSITION",
            severity: verdict.passed ? Severity.LOW : Severity.HIGH,
            analysis: verdict.passed
              ? `AI fraud check passed for userId=${entry.userId} (entryId=${entry.id})`
              : `AI fraud check FAILED for userId=${entry.userId}: ${verdict.reasons.join(", ")}`,
            recommendation: verdict.passed
              ? "Proceed to admin review window"
              : "Admin review required before publish",
          },
        });
      });
    }

    this.logger.log(
      `Top-100 ${month} AI fraud check: ${passed} passed, ${flagged} FLAGGED of ${drafts.length} drafts`
    );
    return { month, passed, flagged, total: drafts.length };
  }

  // ── Admin review window (dispetcher: lastDay-1) — FRAUD_CHECKED → READY_FOR_PUBLISH
  // FIX H10: avval "0 2 30 * *" ga mixlangan edi — fevralda DRAFTlar hech
  // qachon READY_FOR_PUBLISH ga yetmasdi. Endi monthEndPipelineDispatcher
  // chaqiradi; metod o'zi lock-siz qoladi (admin manual-trigger uchun).
  // Idempotent: rerunning is a no-op because the where clause matches only
  // entries still in FRAUD_CHECKED. FLAGGED entries are NOT touched per D-2.
  async adminReviewWindowOpen() {
    const month = monthKey();
    this.logger.log(`Top-100 admin review window opens: ${month}`);

    const result = await this.prisma.top100Entry.updateMany({
      where: { month, status: "FRAUD_CHECKED" },
      data: { status: "READY_FOR_PUBLISH" },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "TOP100",
        scopeId: month,
        issueType: "STATE_TRANSITION",
        severity: Severity.LOW,
        analysis: `Admin review window opened: ${result.count} entries transitioned FRAUD_CHECKED → READY_FOR_PUBLISH`,
        recommendation: "Admins have 24 hours to flag / reject / confirm before auto-publish",
      },
    });

    this.logger.log(`Top-100 ${month}: ${result.count} entries READY_FOR_PUBLISH`);
    return { month, count: result.count };
  }

  // ── 1-kun: publish cron wrapper — jadval "0 2 1 * *" O'ZGARMAGAN ─────────
  // FIX H8: 3 replica bir vaqtda autoPublish ni yurgizmasligi uchun Redis
  // SETNX leader lock (subscription.service.ts FIX F pattern). Biznes metodi
  // autoPublish() nomi/signaturasi o'zgarmagan va lock-siz qoladi.
  @Cron("0 2 1 * *")
  async autoPublishCron() {
    if (!this.redisLock) {
      this.logger.warn(
        "autoPublishCron skipped — RedisLockService not wired (dev/tests)",
      );
      return;
    }
    const { dateStr } = tashkentDayInfo();
    const lockKey = `cron:top100:publish:${dateStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, TOP100_CRON_LOCK_TTL_SEC, dateStr);
    if (!lock.first) {
      this.logger.log(
        `autoPublishCron: leader lock not acquired (${lockKey}) — another replica owns the run. Skipping.`,
      );
      return;
    }
    return this.autoPublish();
  }

  // ── 1-kun: auto-publish — READY_FOR_PUBLISH → CONFIRMED ─────────────────
  // D-2: FLAGGED entries are NOT included in the where clause, so they stay
  // FLAGGED. The published month has gaps at the flagged rank slots; we DO
  // NOT renumber to fill them. The audit row records both counts.
  async autoPublish() {
    const prevMonth = previousMonthKey();
    this.logger.log(`Top-100 auto-publish: ${prevMonth}`);

    const confirmedResult = await this.prisma.top100Entry.updateMany({
      where: { month: prevMonth, status: "READY_FOR_PUBLISH" },
      data: { status: "CONFIRMED" },
    });

    const flaggedCount = await this.prisma.top100Entry.count({
      where: { month: prevMonth, status: "FLAGGED" },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "TOP100",
        scopeId: prevMonth,
        issueType: "STATE_TRANSITION",
        severity: Severity.LOW,
        analysis: `Auto-publish ${prevMonth}: ${confirmedResult.count} CONFIRMED, ${flaggedCount} FLAGGED slots preserved (no renumbering)`,
        recommendation: flaggedCount > 0
          ? "Rank gaps remain at FLAGGED positions per D-2 — manual SUPER_ADMIN action required to resolve"
          : "Monthly Top-100 published successfully",
      },
    });

    // Plan 03-04 TOP-07 + GAME-01: real-time broadcast + badge awards.
    // RESEARCH R2 (accepted V1 race): emit happens AFTER the status update
    // is persisted; if emit throws the publish stays committed (the next
    // tick / manual confirmMonth call re-emits). Errors are swallowed so a
    // dead Redis/Kafka does not roll back the publish itself.
    try {
      const payload = await this._buildBroadcastPayload(prevMonth);
      this.gateway.emitTop100Update(prevMonth, payload);
    } catch (err) {
      this.logger.warn(
        `Top-100 ${prevMonth} broadcast emit failed (publish stays): ${(err as Error).message}`,
      );
    }

    // GAME-01: award TOP_10 / TOP_100 badges to confirmed entries.
    try {
      await this.badge.checkTopEntries(prevMonth);
    } catch (err) {
      this.logger.warn(
        `Top-100 ${prevMonth} badge award failed: ${(err as Error).message}`,
      );
    }

    // GAME-01 ACTIVE_MONTH: award to top-decile RI delta candidates.
    // V1 LIMITATION (per plan-checker WARNING-3): we approximate "top 10%"
    // as the top-200 Top100Entry candidates for prevMonth (we already
    // computed/persisted them on the 28th). A user ranked 201st with high
    // RI delta is missed. V2 should move this to a dedicated scan after
    // scheduleNightlyRecalculation that paginates the full ReadingIndex
    // table. The approximation is conservative (under-awards, never
    // over-awards) so it's safe for V1 mukofot semantics.
    try {
      const candidates = await this.prisma.top100Entry.findMany({
        where: { month: prevMonth },
        select: { userId: true },
        take: 200,
      });
      for (const c of candidates ?? []) {
        await this.badge.checkActiveMonth(c.userId, prevMonth);
      }
    } catch (err) {
      this.logger.warn(
        `Top-100 ${prevMonth} ACTIVE_MONTH check failed: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Top-100 ${prevMonth} auto-publish: ${confirmedResult.count} CONFIRMED, ${flaggedCount} FLAGGED skipped`
    );
    return { month: prevMonth, confirmed: confirmedResult.count, flaggedSkipped: flaggedCount };
  }

  // ── Admin: oyni tasdiqlash (DRAFT → CONFIRMED) — legacy bulk override ────
  // Plan 03-04 TOP-07: mirrors autoPublish's broadcast emit. Used when the
  // SUPER_ADMIN clicks "Force Publish" on /dashboard/top-review.
  async confirmMonth(month: string) {
    await this.prisma.top100Entry.updateMany({
      where: { month, status: "DRAFT" },
      data: { status: "CONFIRMED" }
    });

    try {
      const payload = await this._buildBroadcastPayload(month);
      this.gateway.emitTop100Update(month, payload);
    } catch (err) {
      this.logger.warn(
        `confirmMonth ${month} broadcast emit failed (confirm stays): ${(err as Error).message}`,
      );
    }

    return { confirmed: true, month };
  }

  // ── Admin overrides (Plan 03-02 — manual transitions during 30→1 window) ─
  // All wrapped in $transaction interactive form per RESEARCH.md concurrency
  // safety. Each emits an AiAuditLog row for the append-only trail.

  async flagUser(month: string, userId: string, reason?: string) {
    return this._overrideStatus({
      month,
      userId,
      newStatus: "FLAGGED",
      reason,
      mergeComponents: reason ? { flagReason: reason } : undefined,
    });
  }

  async clearFlag(month: string, userId: string) {
    return this._overrideStatus({
      month,
      userId,
      newStatus: "FRAUD_CHECKED",
      reason: "Admin cleared flag",
      // Strip flagReasons key from the components blob.
      stripComponentKeys: ["flagReasons", "flagReason"],
    });
  }

  async rejectEntry(month: string, userId: string) {
    return this._overrideStatus({
      month,
      userId,
      newStatus: "REJECTED",
      reason: "Admin rejected entry",
    });
  }

  async confirmEntry(month: string, userId: string) {
    return this._overrideStatus({
      month,
      userId,
      newStatus: "CONFIRMED",
      reason: "Admin manually confirmed entry",
    });
  }

  private async _overrideStatus(params: {
    month: string;
    userId: string;
    newStatus: string;
    reason?: string;
    mergeComponents?: Record<string, unknown>;
    stripComponentKeys?: string[];
  }) {
    const { month, userId, newStatus, reason, mergeComponents, stripComponentKeys } = params;

    const existing = await this.prisma.top100Entry.findMany({
      where: { month, userId },
      select: { id: true, components: true },
      take: 1,
    });
    if (existing.length === 0) {
      throw new NotFoundException(
        `Top100Entry topilmadi: month=${month} userId=${userId}`,
      );
    }
    const entry = existing[0];

    return this.prisma.$transaction(async (tx) => {
      const txClient = tx as unknown as PrismaService;

      let nextComponents = (entry.components ?? {}) as Record<string, unknown>;
      if (stripComponentKeys) {
        nextComponents = { ...nextComponents };
        for (const k of stripComponentKeys) delete nextComponents[k];
      }
      if (mergeComponents) {
        nextComponents = { ...nextComponents, ...mergeComponents };
      }

      await txClient.top100Entry.update({
        where: { id: entry.id },
        data: {
          status: newStatus,
          components: nextComponents as Prisma.InputJsonValue,
        },
      });

      await txClient.aiAuditLog.create({
        data: {
          scope: "TOP100",
          scopeId: month,
          issueType: "STATE_TRANSITION",
          severity: newStatus === "FLAGGED" || newStatus === "REJECTED"
            ? Severity.HIGH
            : Severity.MEDIUM,
          analysis: `Admin override: entry ${entry.id} (userId=${userId}) → ${newStatus}${reason ? ` (${reason})` : ""}`,
          recommendation:
            newStatus === "FLAGGED"
              ? "Verify the flag reason and either clear or reject"
              : newStatus === "REJECTED"
                ? "Entry permanently rejected — will not auto-publish"
                : "Manual transition recorded",
        },
      });

      return { month, userId, status: newStatus };
    }).then((result) => {
      // Plan 03-04 TOP-07: broadcast the admin override to subscribers of
      // `top100:{month}`. The payload is intentionally minimal — only the
      // userId + action — so the frontend can invalidate its React Query
      // cache without leaking the audit reason over the wire.
      // Side-effect runs OUTSIDE the $transaction (transaction-success
      // .then chain) so emit failures cannot roll back the persisted
      // status mutation.
      try {
        const action: "flagged" | "cleared" | "rejected" | "confirmed" =
          newStatus === "FLAGGED" ? "flagged" :
          newStatus === "REJECTED" ? "rejected" :
          newStatus === "FRAUD_CHECKED" ? "cleared" :
          "confirmed";
        this.gateway.emitTop100UserFlagged(month, userId, action);
      } catch (err) {
        this.logger.warn(
          `Admin override emit failed for ${userId} ${newStatus} (mutation persisted): ${(err as Error).message}`,
        );
      }
      return result;
    });
  }

  // ── Ochiq Top-100 so'rash ────────────────────────────────────────────────

  async getTop100(filters: {
    month?: string;
    gender?: UserGender;
    ageGroup?: AgeGroup;
    userType?: UserType;
    limit?: number;
    offset?: number;
  }) {
    const month = filters.month ?? monthKey();
    const limit = Math.min(filters.limit ?? 100, 100);
    const offset = filters.offset ?? 0;

    const where: Record<string, unknown> = {
      month,
      status: "CONFIRMED",
      ...(filters.gender ? { gender: filters.gender } : {}),
      ...(filters.ageGroup ? { ageGroup: filters.ageGroup } : {}),
      ...(filters.userType ? { userType: filters.userType } : {})
    };

    const [entries, total] = await Promise.all([
      this.prisma.top100Entry.findMany({
        where,
        orderBy: { rank: "asc" },
        take: limit,
        skip: offset,
        include: {
          user: {
            select: {
              name: true,
              sifatId: true,
              gender: true,
              dob: true,
              type: true,
              address: {
                select: { viloyatId: true, tumanId: true }
              }
            }
          }
        }
      }),
      this.prisma.top100Entry.count({ where })
    ]);

    return {
      month,
      total,
      entries: entries.map((e) => ({
        rank: e.rank,
        score: e.score,
        components: e.components,
        ageGroup: e.ageGroup,
        gender: e.gender,
        userType: e.userType,
        // TOP-06: shared masker — masks names of users aged ≤14.
        user: {
          name: maskNameIfMinor(e.user.name, e.user.dob),
          sifatId: e.user.sifatId,
          type: e.user.type,
          viloyatId: e.user.address?.viloyatId
        }
      }))
    };
  }

  // ── Mavjud oylar ro'yhati ────────────────────────────────────────────────
  async getAvailableMonths() {
    const months = await this.prisma.top100Entry.findMany({
      where: { status: "CONFIRMED" },
      distinct: ["month"],
      select: { month: true },
      orderBy: { month: "desc" }
    });
    return months.map((m) => m.month);
  }

  // ── Hududiy reyting (tuman/viloyat bo'yicha RI o'rtachasi) ───────────────
  async getRegionalRanking(type: "tuman" | "viloyat") {
    // ReadingIndex so'nggi ma'lumotlarini hududga bo'lib o'rtalashtirish
    const result = await this.prisma.$queryRaw<Array<{
      regionId: string;
      avgScore: number;
      userCount: number;
    }>>`
      SELECT
        a.${type === "viloyat" ? '"viloyatId"' : '"tumanId"'} as "regionId",
        AVG(ri.score) as "avgScore",
        COUNT(DISTINCT u.id) as "userCount"
      FROM "ReadingIndex" ri
      JOIN "User" u ON u.id = ri."userId"
      JOIN "Address" a ON a.id = u."addressId"
      WHERE ri."calculatedAt" > NOW() - INTERVAL '7 days'
        AND a.${type === "viloyat" ? '"viloyatId"' : '"tumanId"'} IS NOT NULL
      GROUP BY a.${type === "viloyat" ? '"viloyatId"' : '"tumanId"'}
      ORDER BY "avgScore" DESC
      LIMIT 50
    `;

    return result;
  }

  /**
   * Plan 03-04 TOP-07: admin review queue for /dashboard/top-review UI.
   *
   * Returns all NON-CONFIRMED entries (DRAFT, FRAUD_CHECKED, READY_FOR_PUBLISH,
   * FLAGGED, REJECTED) for the given month, so the SUPER_ADMIN can decide
   * flag/clear/reject/confirm before the 1-day auto-publish cron fires.
   *
   * Distinct from `getDraftMonth` (which excludes REJECTED). This endpoint
   * surfaces REJECTED so admins can audit historical decisions during the
   * review window.
   *
   * Per TOP-06: minor names are masked (T-03-02-I disposition).
   */
  async getAdminReviewQueue(month?: string) {
    const m = month ?? monthKey();
    const entries = await this.prisma.top100Entry.findMany({
      where: {
        month: m,
        status: {
          in: ["DRAFT", "FRAUD_CHECKED", "READY_FOR_PUBLISH", "FLAGGED", "REJECTED"],
        },
      },
      orderBy: [{ status: "asc" }, { rank: "asc" }],
      take: 200,
      include: {
        user: {
          select: {
            name: true,
            sifatId: true,
            trustScore: true,
            dob: true,
          },
        },
      },
    });
    const masked = entries.map((e) => ({
      id: e.id,
      userId: e.userId,
      month: e.month,
      rank: e.rank,
      score: e.score,
      status: e.status,
      components: e.components,
      gender: e.gender,
      ageGroup: e.ageGroup,
      userType: e.userType,
      user: {
        name: maskNameIfMinor(e.user.name, e.user.dob),
        sifatId: e.user.sifatId,
        trustScore: e.user.trustScore,
      },
    }));
    return { month: m, count: masked.length, entries: masked };
  }

  // ── Admin: DRAFT/FRAUD_CHECKED/READY_FOR_PUBLISH holatlarini ko'rish ────
  // Per TOP-06: minor names are masked here too — admins under T-03-02-I
  // disposition do not need full child names for the review workflow.
  async getDraftMonth(month?: string) {
    const m = month ?? monthKey();
    const entries = await this.prisma.top100Entry.findMany({
      where: {
        month: m,
        status: { in: ["DRAFT", "FRAUD_CHECKED", "READY_FOR_PUBLISH", "FLAGGED"] },
      },
      orderBy: { rank: "asc" },
      take: 120,
      include: {
        user: { select: { name: true, sifatId: true, trustScore: true, dob: true } }
      }
    });
    const masked = entries.map((e) => ({
      ...e,
      user: {
        ...e.user,
        name: maskNameIfMinor(e.user.name, e.user.dob),
      },
    }));
    return { month: m, count: masked.length, entries: masked };
  }
}
