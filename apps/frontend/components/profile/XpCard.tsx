"use client";

/**
 * XpCard — gamifikatsiya poydevori (XP + Level + Streak) profil kartasi.
 *
 * DIZAYN QARORI (senior yondashuv, DESIGN.md):
 *  • Level halqasi — sahifadagi yagona "katta raqam". Ikkinchi katta element
 *    qo'shilsa ikkalasi ham diqqatni yo'qotadi.
 *  • Oltin (accent) FAQAT yutuq uchun: level raqami va streak alangasi.
 *    Struktura (progress yo'lakchasi, ramkalar) — brand navy. Bu qoida
 *    landing sahifasida ham qo'llangan (rangning ma'nosi bo'lsin).
 *  • Streak 0 bo'lsa alanga ko'rsatilmaydi — bo'sh yutuqni bayram qilish
 *    ishonchni yo'qotadi.
 *
 * HALOLLIK: barcha sonlar backenddan keladi (`/xp/me`). Ma'lumot yo'q bo'lsa
 * karta butunlay render qilinmaydi — o'ylab topilgan 0 yoki "—" emas.
 */

import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { fetchMyXp } from "@/lib/api/xp";
import { fadeUp, respectMotion } from "@/lib/motion";

const fmt = (n: number) => new Intl.NumberFormat("uz-UZ").format(n);

export function XpCard({ enabled = true }: { enabled?: boolean }) {
  const reduce = useReducedMotion();
  const { data, isLoading } = useQuery({
    queryKey: ["my-xp"],
    queryFn: fetchMyXp,
    enabled,
    staleTime: 30_000,
  });

  // Yuklanmoqda yoki ma'lumot yo'q — soxta qiymat ko'rsatmaymiz.
  if (isLoading || !data) return null;

  const { xp, level, levelName, nextLevelXp, xpToNextLevel, progressPct, currentStreak, longestStreak } = data;
  const isMaxLevel = nextLevelXp === null;

  return (
    <motion.div variants={respectMotion(fadeUp, reduce)} initial="hidden" animate="visible">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Kitobxonlik sayohati</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* ── Level + XP ─────────────────────────────────────────────── */}
          <div className="flex items-center gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-50 text-2xl font-bold text-accent-700 ring-1 ring-accent-200"
              aria-hidden="true"
            >
              {level}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-500">{level}-daraja</p>
              <p className="truncate text-xl font-bold text-slate-900">{levelName}</p>
              <p className="text-xs text-slate-400">{fmt(xp)} XP to&apos;plandi</p>
            </div>
          </div>

          {/* ── Keyingi levelgacha progress ────────────────────────────── */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-600">
                {isMaxLevel ? "Eng yuqori daraja" : `Keyingi darajagacha ${fmt(xpToNextLevel!)} XP`}
              </span>
              {!isMaxLevel && (
                <span className="tabular-nums text-slate-400">
                  {fmt(xp)} / {fmt(nextLevelXp!)}
                </span>
              )}
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Daraja progressi"
            >
              {/* Kenglik BIRINCHI render'dayoq to'g'ri qiymatda chiziladi —
                  ataylab, "0 dan o'sib chiqish" effektisiz.
                  Sabab: bu yo'lakcha HAQIQIY ma'lumotni ko'rsatadi, bezak emas.
                  0 dan animatsiya qilish uchun mount'dan keyingi yangilanish
                  kerak bo'lardi (motion/rAF yoki useEffect+setState) — lekin
                  sahifa fonda ochilganda brauzer rAF ni throttle qiladi va React
                  passiv effektlarni kechiktiradi, natijada foydalanuvchi 330/900
                  o'rniga BO'SH yo'lakchani ko'rardi. Bu — noto'g'ri ma'lumot.
                  transition faqat keyingi o'zgarishlar uchun (refetch yangi XP
                  qiymatini keltirsa, yo'lakcha silliq siljiydi). */}
              <div
                className="h-full rounded-full bg-brand-600 transition-[width] duration-700 ease-out motion-reduce:transition-none"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* ── Streak — faqat haqiqiy streak bo'lganda ────────────────── */}
          {currentStreak > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-accent-200 bg-accent-50 p-3">
              <Icon.streak
                size={ICON_SIZE.md}
                className="shrink-0 text-accent-600"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {currentStreak} kun ketma-ket
                </p>
                <p className="text-xs text-slate-500">
                  {longestStreak > currentStreak
                    ? `Eng uzun: ${longestStreak} kun`
                    : "Bu — sizning rekordingiz"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
