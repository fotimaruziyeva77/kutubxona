import { apiClient } from "@/lib/api-client";

/**
 * XP / Level / Streak — gamifikatsiya poydevori.
 *
 * MUHIM (H17 "halol landing" tamoyilining kengaytmasi): bu yerdagi HAR BIR
 * son backend tomonidan haqiqiy hodisalardan hisoblanadi. Frontendda hech
 * qanday qiymat o'ylab topilmaydi, taxmin qilinmaydi yoki "chiroyli ko'rinsin"
 * uchun to'ldirilmaydi. Ma'lumot kelmasa — blok umuman ko'rsatilmaydi
 * (`XpCard` `null` qaytaradi), soxta 0 yoki "taxminan" ko'rsatilmaydi.
 */
export type XpState = {
  xp: number;
  level: number;
  levelName: string;
  /** Keyingi levelga kerak bo'lgan umumiy XP. Oxirgi levelda `null`. */
  nextLevelXp: number | null;
  /** Keyingi levelgacha qolgan XP. Oxirgi levelda `null`. */
  xpToNextLevel: number | null;
  /** Joriy level ichidagi progress (0–100). */
  progressPct: number;
  currentStreak: number;
  longestStreak: number;
  /** ISO sana yoki `null` — hali birorta tasdiqlangan hodisa yo'q. */
  lastActiveDate: string | null;
};

/** O'z XP holati. Xato bo'lsa `null` — chaqiruvchi blokni yashiradi. */
export async function fetchMyXp(): Promise<XpState | null> {
  const res = await apiClient("/xp/me");
  if (!res.ok) return null;
  return res.json();
}
