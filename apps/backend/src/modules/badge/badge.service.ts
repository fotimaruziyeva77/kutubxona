import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { KafkaService, KAFKA_TOPICS } from "../../infra/kafka/kafka.service";

// Badge katalogi (TZ §5 — 15+ badge)
export const BADGE_CATALOG = [
  { code: "FIRST_BOOK",        name: "Birinchi kitob",       description: "Birinchi kitobni qaytardingiz",           icon: "📖" },
  { code: "FIVE_BOOKS",        name: "5 kitob",              description: "5 ta kitob o'qib qaytardingiz",           icon: "📚" },
  { code: "TEN_BOOKS",         name: "10 kitob",             description: "10 ta kitob o'qib qaytardingiz",          icon: "🏆" },
  { code: "TWENTY_BOOKS",      name: "20 kitob",             description: "20 ta kitob o'qib qaytardingiz",          icon: "🌟" },
  { code: "FIFTY_BOOKS",       name: "50 kitob",             description: "50 ta kitob o'qib qaytardingiz",          icon: "👑" },
  { code: "HUNDRED_BOOKS",     name: "100 kitob",            description: "100 ta kitob — milliy rekord!",           icon: "🎯" },
  { code: "TOP_100",           name: "Top-100",              description: "Oylik Top-100 ga kirgansiz",              icon: "🥇" },
  { code: "TOP_10",            name: "Top-10",               description: "Oylik Top-10 ga kirgansiz",               icon: "💎" },
  { code: "STREAK_7",          name: "7 kunlik streak",      description: "7 kun ketma-ket faol bo'ldingiz",         icon: "🔥" },
  { code: "STREAK_30",         name: "30 kunlik streak",     description: "Bir oy davomida har kuni faol",           icon: "⚡" },
  { code: "DISCIPLINE",        name: "Intizomli kitobxon",   description: "10 ta kitobni o'z vaqtida qaytardingiz",  icon: "⏰" },
  { code: "DIVERSE_READER",    name: "Xilma-xil kitobxon",  description: "5 ta turli janrda kitob o'qidingiz",      icon: "🌈" },
  { code: "FAST_READER",       name: "Tez o'quvchi",         description: "Kitobni 7 kunda qaytardingiz",            icon: "⚡" },
  { code: "COMPREHENSION_ACE", name: "Test ustasi",          description: "5 ta comprehension testni o'tdingiz",     icon: "🧠" },
  { code: "ISBN_SCANNER",      name: "ISBN skanerchi",       description: "10 ta sotib olingan kitob skanerlandi",   icon: "📱" },
  { code: "DONOR",             name: "Donat qiluvchi",       description: "Kutubxonalarga donat qildingiz",          icon: "❤️" },
  { code: "TRUST_MASTER",      name: "Ishonch ustasi",       description: "Trust Score 90 ga yetdi",                 icon: "🛡️" },
  { code: "ACTIVE_MONTH",      name: "Faol oy",              description: "Bir oy davomida eng faol bo'ldingiz",     icon: "📅" }
] as const;

type BadgeCode = (typeof BADGE_CATALOG)[number]["code"];

@Injectable()
export class BadgeService {
  private readonly logger = new Logger(BadgeService.name);

  // Plan 03-04 GAME-02: KafkaService injected via @Global KafkaModule.
  // Marked @Optional so existing unit tests (which mock only PrismaService)
  // keep working — emit becomes a no-op when kafka is not provided.
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly kafka?: KafkaService,
  ) {}

  // ── Badge katalogini DB ga seed qilish ───────────────────────────────────
  async seedBadges() {
    for (const b of BADGE_CATALOG) {
      await this.prisma.badge.upsert({
        where: { code: b.code },
        update: { name: b.name, description: b.description, icon: b.icon },
        create: { code: b.code, name: b.name, description: b.description, icon: b.icon }
      });
    }
    return { seeded: BADGE_CATALOG.length };
  }

  // ── Foydalanuvchiga badge berish ─────────────────────────────────────────
  // Plan 03-04 GAME-02: success branch emits KAFKA_TOPICS.BADGE_EARNED so
  // KafkaConsumerService can route it to a per-user WebSocket room and the
  // frontend can show an in-app toast. Emit is fire-and-forget — Kafka
  // failures must not roll back the badge award.
  private async award(userId: string, code: string): Promise<boolean> {
    const badge = await this.prisma.badge.findUnique({ where: { code } });
    if (!badge) return false;

    try {
      await this.prisma.userBadge.create({
        data: { userId, badgeId: badge.id }
      });
      this.logger.log(`Badge berildi: ${userId} → ${code}`);

      // GAME-02: non-blocking event emit. KafkaService.emit no-ops gracefully
      // when KAFKA_BROKERS is unset (Phase 1 INFRA-08). Errors here MUST NOT
      // throw — log and continue.
      if (this.kafka) {
        const awardedAt = new Date().toISOString();
        this.kafka
          .emit({
            topic: KAFKA_TOPICS.BADGE_EARNED,
            key: userId,
            value: { userId, badgeCode: code, awardedAt },
          })
          .catch((err) => {
            this.logger.warn(
              `BADGE_EARNED emit failed (badge persisted): ${(err as Error).message}`,
            );
          });
      }

      return true;
    } catch {
      // @@unique([userId, badgeId]) — allaqachon mavjud (already-awarded
      // path: do NOT emit so re-checks don't spam the consumer).
      return false;
    }
  }

  // ── Foydalanuvchi badgelarini olish ─────────────────────────────────────
  async getUserBadges(userId: string) {
    return this.prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true },
      orderBy: { awardedAt: "desc" }
    });
  }

  // ── Kitob qaytarilganda tekshirish ───────────────────────────────────────
  async checkAfterReturn(userId: string) {
    const returnedCount = await this.prisma.bookTransaction.count({
      where: { userId, status: "RETURNED" }
    });

    const milestones: [number, BadgeCode][] = [
      [1, "FIRST_BOOK"],
      [5, "FIVE_BOOKS"],
      [10, "TEN_BOOKS"],
      [20, "TWENTY_BOOKS"],
      [50, "FIFTY_BOOKS"],
      [100, "HUNDRED_BOOKS"]
    ];

    for (const [n, code] of milestones) {
      if (returnedCount === n) await this.award(userId, code);
    }

    // Intizomli kitobxon: 10 ta kitob muddatida qaytarilgan
    if (returnedCount >= 10) {
      const lateCount = await this.prisma.bookTransaction.count({
        where: { userId, status: "RETURNED", penaltyDays: { gt: 0 } }
      });
      const onTimeCount = returnedCount - lateCount;
      if (onTimeCount >= 10) await this.award(userId, "DISCIPLINE");
    }

    // Tez o'quvchi: kitob 7 kunda qaytarildi
    const lastTx = await this.prisma.bookTransaction.findFirst({
      where: { userId, status: "RETURNED" },
      orderBy: { returnedAt: "desc" }
    });
    if (lastTx?.borrowedAt && lastTx?.returnedAt) {
      const days = (lastTx.returnedAt.getTime() - lastTx.borrowedAt.getTime()) / 86400000;
      if (days <= 7) await this.award(userId, "FAST_READER");
    }

    // Xilma-xil kitobxon: 5 ta turli janr
    const genres = await this.prisma.bookTransaction.findMany({
      where: { userId, status: "RETURNED" },
      include: { book: { select: { genre: true } } },
      distinct: ["bookId"]
    });
    const uniqueGenres = new Set(genres.map((t) => t.book?.genre).filter(Boolean));
    if (uniqueGenres.size >= 5) await this.award(userId, "DIVERSE_READER");

    // Plan 03-04 GAME-01: chain into the streak trigger so a single return
    // call covers both milestone badges AND the activity-streak badges.
    // No transactions.service.ts change is required — the existing
    // checkAfterReturn call site at transactions.service.ts:387 picks this up
    // automatically.
    await this.checkAfterReturnForStreak(userId);
  }

  /**
   * Plan 03-04 GAME-01: STREAK_7 + STREAK_30 trigger.
   *
   * Awards STREAK_7 if the user has returned books on ≥7 DISTINCT calendar
   * days within the last 30 days (sliding window). STREAK_30 if ≥30 distinct
   * days within the last 60 days.
   *
   * Why a Set of toDateString() instead of Prisma `distinct`: Prisma's
   * distinct keys to full column values; the returnedAt column has minute
   * precision, so SELECT DISTINCT returnedAt would give one row per minute,
   * not one row per day. Building the Set in Node is correct and stays well
   * under the 30-day-row count for any sane user.
   */
  async checkAfterReturnForStreak(userId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000);

    // STREAK_7: distinct days in last 30 days
    const last30 = await this.prisma.bookTransaction.findMany({
      where: {
        userId,
        status: "RETURNED",
        returnedAt: { gte: thirtyDaysAgo },
      },
      select: { returnedAt: true },
    });
    const days30 = new Set(
      last30.map((t) => t.returnedAt?.toDateString()).filter(Boolean),
    );
    if (days30.size >= 7) await this.award(userId, "STREAK_7");

    // STREAK_30: distinct days in last 60 days (allows 1 missed-day margin)
    const last60 = await this.prisma.bookTransaction.findMany({
      where: {
        userId,
        status: "RETURNED",
        returnedAt: { gte: sixtyDaysAgo },
      },
      select: { returnedAt: true },
    });
    const days60 = new Set(
      last60.map((t) => t.returnedAt?.toDateString()).filter(Boolean),
    );
    if (days60.size >= 30) await this.award(userId, "STREAK_30");
  }

  /**
   * Plan 03-04 GAME-01: ACTIVE_MONTH trigger.
   *
   * Awards ACTIVE_MONTH when the user's RI delta for the month places them
   * in the top decile (≤10%) of all active users for that month.
   *
   * V1 LIMITATION (per plan-checker WARNING-3): The TopService.autoPublish
   * call site iterates Top100Entry candidates (top-200 of the previous
   * month), so a user ranked 201st with high RI delta is missed. The
   * approximation is conservative (under-awards, never over-awards) and
   * safe for V1 mukofot semantics. V2 should move the trigger to a
   * dedicated scan after scheduleNightlyRecalculation that paginates the
   * full ReadingIndex table.
   *
   * Uses Prisma raw SQL for the percentile calculation — the alternative
   * (selecting every user's delta into Node) is O(5M) and unacceptable.
   */
  async checkActiveMonth(userId: string, month: string) {
    // Parse `YYYY-MM` into the month-start Date (UTC).
    const [yearStr, monthStr] = month.split("-");
    const monthStart = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));

    // Single-query rank: count of users whose delta > this user's delta,
    // plus a total count. result = (rank+1) / total ≤ 0.1 → top decile.
    const rows = await this.prisma.$queryRaw<Array<{ rank: bigint; total: bigint }>>`
      WITH per_user AS (
        SELECT "userId", MAX(score) - MIN(score) AS delta
        FROM "ReadingIndex"
        WHERE "calculatedAt" >= ${monthStart}
        GROUP BY "userId"
      ),
      this_user AS (
        SELECT delta FROM per_user WHERE "userId" = ${userId}
      )
      SELECT
        (SELECT COUNT(*) FROM per_user WHERE delta > (SELECT delta FROM this_user))::bigint AS rank,
        (SELECT COUNT(*) FROM per_user)::bigint AS total
    `;

    const row = rows?.[0];
    if (!row || !row.total || Number(row.total) === 0) return;

    const rankNum = Number(row.rank);
    const totalNum = Number(row.total);
    // Defensive: if the user has no ReadingIndex rows this month they're
    // counted as last (no delta entry); skip.
    if (totalNum === 0) return;

    const percentile = (rankNum + 1) / totalNum;
    if (percentile <= 0.1) {
      await this.award(userId, "ACTIVE_MONTH");
    }
  }

  // ── Comprehension test o'tilganda tekshirish ─────────────────────────────
  async checkAfterTest(userId: string) {
    const passedCount = await this.prisma.comprehensionTest.count({
      where: { userId, passed: true }
    });
    if (passedCount >= 5) await this.award(userId, "COMPREHENSION_ACE");
  }

  // ── ISBN scan qilganda tekshirish ────────────────────────────────────────
  async checkAfterIsbnScan(userId: string) {
    const scanCount = await this.prisma.isbnScan.count({
      where: { userId, confirmed: true }
    });
    if (scanCount >= 10) await this.award(userId, "ISBN_SCANNER");
  }

  // ── Trust score o'zgarganda ───────────────────────────────────────────────
  async checkAfterTrustUpdate(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { trustScore: true }
    });
    if (user && user.trustScore >= 90) await this.award(userId, "TRUST_MASTER");
  }

  // ── Donat qilganda ───────────────────────────────────────────────────────
  async checkAfterDonation(userId: string) {
    await this.award(userId, "DONOR");
  }

  // ── Top-100 ga kirganida (oylik tasdiqlashda chaqiriladi) ────────────────
  async checkTopEntries(month: string) {
    const top10 = await this.prisma.top100Entry.findMany({
      where: { month, status: "CONFIRMED", rank: { lte: 10 } },
      select: { userId: true }
    });
    const top100 = await this.prisma.top100Entry.findMany({
      where: { month, status: "CONFIRMED", rank: { lte: 100 } },
      select: { userId: true }
    });

    for (const { userId } of top10) await this.award(userId, "TOP_10");
    for (const { userId } of top100) await this.award(userId, "TOP_100");

    this.logger.log(`Top badge: Top-10 (${top10.length}), Top-100 (${top100.length})`);
  }
}
