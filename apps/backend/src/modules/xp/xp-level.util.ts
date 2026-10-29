/**
 * xp-level.util.ts — XP → Level va streak hisoblash uchun pure funksiyalar.
 *
 * reading-score.util.ts bilan bir xil naqsh: barcha qoidalar bitta side-effect
 * siz modulda, shuning uchun service va testlar bir xil natijani kafolatlaydi.
 */

/** Har bir hodisa turi uchun XP qiymati. */
export const XP_REWARD = {
  // Kutubxona kitobi — tasdiq zanjiri eng kuchli (kutubxonachi QR skan qiladi).
  BOOK_RETURN: 50,
  // ISBN skan + comprehension test — test o'tilgani uchun kitob o'qilgani isbotlangan.
  COMPREHENSION_PASS: 40,
  // Do'kon xaridi tasdig'i — test yo'q, faqat xarid fakti.
  STORE_PURCHASE: 30,
  // Mutolaa — platforma progressi (90%+ o'qilgan).
  MUTOLAA_SYNC: 30,
} as const;

export type XpReason = keyof typeof XP_REWARD;

/**
 * Level chegaralari — kumulyativ XP.
 *
 * Nomlar CLAUDE.md dagi kitobxonlik sayohati atamalari bilan mos:
 * Yangi kitobxon → Kitobxon → Bilimdon → Mutolaa ustasi → Afsona.
 */
export const LEVEL_THRESHOLDS = [
  { level: 1, minXp: 0,    name: "Yangi kitobxon" },
  { level: 2, minXp: 300,  name: "Kitobxon" },
  { level: 3, minXp: 900,  name: "Bilimdon" },
  { level: 4, minXp: 2000, name: "Mutolaa ustasi" },
  { level: 5, minXp: 4000, name: "Afsona" },
] as const;

export interface LevelInfo {
  level: number;
  name: string;
  /** Shu levelning boshlanish XP si. */
  currentLevelXp: number;
  /** Keyingi level uchun kerakli XP — oxirgi levelda null. */
  nextLevelXp: number | null;
  /** Keyingi levelgacha qolgan XP — oxirgi levelda null. */
  xpToNextLevel: number | null;
  /** Shu level ichidagi progress 0–100 — oxirgi levelda 100. */
  progressPct: number;
}

/** Berilgan XP uchun to'liq level ma'lumoti. */
export function levelForXp(xp: number): LevelInfo {
  const safeXp = Math.max(0, Math.floor(xp));

  let idx = 0;
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (safeXp >= LEVEL_THRESHOLDS[i].minXp) {
      idx = i;
      break;
    }
  }

  const current = LEVEL_THRESHOLDS[idx];
  const next = LEVEL_THRESHOLDS[idx + 1] ?? null;

  if (!next) {
    return {
      level: current.level,
      name: current.name,
      currentLevelXp: current.minXp,
      nextLevelXp: null,
      xpToNextLevel: null,
      progressPct: 100,
    };
  }

  const span = next.minXp - current.minXp;
  const gained = safeXp - current.minXp;

  return {
    level: current.level,
    name: current.name,
    currentLevelXp: current.minXp,
    nextLevelXp: next.minXp,
    xpToNextLevel: next.minXp - safeXp,
    progressPct: Math.round((gained / span) * 100),
  };
}

/** UTC kalendar kun boshiga normallashtirish (soat/daqiqa tashlanadi). */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Ikki sana orasidagi to'liq kalendar kun farqi (UTC). */
export function daysBetween(from: Date, to: Date): number {
  const ms = startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime();
  return Math.round(ms / 86_400_000);
}

export interface StreakResult {
  currentStreak: number;
  longestStreak: number;
  /** Bir kunda ikkinchi hodisa — streak o'zgarmaydi, XP baribir beriladi. */
  sameDay: boolean;
}

/**
 * Streak yangilash qoidasi:
 *   - lastActiveDate yo'q          → streak 1 dan boshlanadi
 *   - o'sha kun (farq 0)           → streak o'zgarmaydi (sameDay)
 *   - ertasi kun (farq 1)          → streak +1
 *   - 2+ kun tanaffus              → streak 1 ga qayta tiklanadi
 *   - kelajakdagi sana (farq < 0)  → sameDay kabi ishlanadi (soat mintaqasi/
 *                                    soat siljishiga qarshi fail-safe: streak
 *                                    hech qachon noto'g'ri o'smaydi)
 */
export function nextStreak(
  lastActiveDate: Date | null,
  currentStreak: number,
  longestStreak: number,
  now: Date,
): StreakResult {
  if (!lastActiveDate) {
    return { currentStreak: 1, longestStreak: Math.max(longestStreak, 1), sameDay: false };
  }

  const diff = daysBetween(lastActiveDate, now);

  if (diff <= 0) {
    return { currentStreak, longestStreak, sameDay: true };
  }

  const next = diff === 1 ? currentStreak + 1 : 1;
  return {
    currentStreak: next,
    longestStreak: Math.max(longestStreak, next),
    sameDay: false,
  };
}
