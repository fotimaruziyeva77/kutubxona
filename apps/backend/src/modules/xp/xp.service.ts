import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { KafkaService, KAFKA_TOPICS } from "../../infra/kafka/kafka.service";
import {
  XP_REWARD,
  XpReason,
  levelForXp,
  nextStreak,
  startOfUtcDay,
} from "./xp-level.util";

export interface XpAwardResult {
  xp: number;
  level: number;
  leveledUp: boolean;
  currentStreak: number;
  longestStreak: number;
  streakExtended: boolean;
}

/**
 * XpService — gamifikatsiya poydevori (XP + Level + Streak).
 *
 * BadgeService bilan bir xil naqsh: `award*` metodlari tasdiqlangan o'qish
 * hodisasidan keyin fire-and-forget chaqiriladi (transactions.service.ts,
 * reading.service.ts), Kafka emit esa faqat broadcast — u yiqilsa XP baribir
 * saqlanadi.
 */
@Injectable()
export class XpService {
  private readonly logger = new Logger(XpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly kafka?: KafkaService,
  ) {}

  /** Kitob qaytarildi (kutubxonachi QR skan qildi). */
  awardForBookReturn(userId: string) {
    return this.award(userId, "BOOK_RETURN");
  }

  /** Comprehension test o'tildi → IsbnScan tasdiqlandi. */
  awardForComprehensionPass(userId: string) {
    return this.award(userId, "COMPREHENSION_PASS");
  }

  /** Kitobxon do'kon xaridini tasdiqladi. */
  awardForStorePurchase(userId: string) {
    return this.award(userId, "STORE_PURCHASE");
  }

  /** Mutolaa platformasidan 90%+ o'qilgan kitob sinxronlandi. */
  awardForMutolaaSync(userId: string) {
    return this.award(userId, "MUTOLAA_SYNC");
  }

  /**
   * XP qo'shish + streak yangilash.
   *
   * UserXp qatori lazy yaratiladi — 5M mavjud foydalanuvchi uchun oldindan
   * backfill qilinmaydi, qator birinchi tasdiqlangan hodisada paydo bo'ladi.
   *
   * Interactive $transaction: read-modify-write bo'lgani uchun (streak oldingi
   * qiymatga bog'liq) atomik bo'lishi shart — aks holda bir vaqtda kelgan
   * ikkita hodisa bir-birining streak yangilanishini yo'qotardi.
   */
  private async award(userId: string, reason: XpReason): Promise<XpAwardResult> {
    const amount = XP_REWARD[reason];
    const now = new Date();

    const result = await this.prisma.$transaction(async (p) => {
      const existing = await p.userXp.findUnique({ where: { userId } });

      const prevXp = existing?.xp ?? 0;
      const prevLevel = existing?.level ?? 1;

      const streak = nextStreak(
        existing?.lastActiveDate ?? null,
        existing?.currentStreak ?? 0,
        existing?.longestStreak ?? 0,
        now,
      );

      const newXp = prevXp + amount;
      const newLevel = levelForXp(newXp).level;
      // Kun boshiga normallashtirish — bir kun ichidagi keyingi hodisalar
      // daysBetween() ni 0 qiladi, ya'ni streak takror o'smaydi.
      const activeDate = startOfUtcDay(now);

      await p.userXp.upsert({
        where: { userId },
        create: {
          userId,
          xp: newXp,
          level: newLevel,
          currentStreak: streak.currentStreak,
          longestStreak: streak.longestStreak,
          lastActiveDate: activeDate,
        },
        update: {
          xp: newXp,
          level: newLevel,
          currentStreak: streak.currentStreak,
          longestStreak: streak.longestStreak,
          lastActiveDate: activeDate,
        },
      });

      return {
        xp: newXp,
        level: newLevel,
        leveledUp: newLevel > prevLevel,
        currentStreak: streak.currentStreak,
        longestStreak: streak.longestStreak,
        streakExtended: !streak.sameDay,
      };
    });

    this.logger.log(
      `XP: ${userId} +${amount} (${reason}) → ${result.xp} XP, level ${result.level}, streak ${result.currentStreak}`,
    );

    if (this.kafka && result.leveledUp) {
      this.kafka
        .emit({
          topic: KAFKA_TOPICS.XP_LEVEL_UP,
          key: userId,
          value: {
            userId,
            level: result.level,
            xp: result.xp,
            occurredAt: now.toISOString(),
          },
        })
        .catch((err) => {
          this.logger.warn(
            `XP_LEVEL_UP emit failed (XP persisted): ${(err as Error).message}`,
          );
        });
    }

    return result;
  }

  /**
   * Profil uchun XP holati.
   *
   * Hali birorta tasdiqlangan hodisasi bo'lmagan foydalanuvchi uchun ham
   * to'liq nol-holat qaytariladi (null emas) — frontend "0 XP, 1-level"
   * ni ko'rsatadi, bu to'qib chiqarilgan raqam emas, haqiqiy boshlang'ich holat.
   */
  async getForUser(userId: string) {
    const row = await this.prisma.userXp.findUnique({ where: { userId } });
    const xp = row?.xp ?? 0;
    const info = levelForXp(xp);

    return {
      xp,
      level: info.level,
      levelName: info.name,
      nextLevelXp: info.nextLevelXp,
      xpToNextLevel: info.xpToNextLevel,
      progressPct: info.progressPct,
      currentStreak: row?.currentStreak ?? 0,
      longestStreak: row?.longestStreak ?? 0,
      lastActiveDate: row?.lastActiveDate ?? null,
    };
  }
}
