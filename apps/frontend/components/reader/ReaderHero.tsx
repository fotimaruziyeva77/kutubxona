"use client";

/**
 * ReaderHero — kitobxon sahifasining birinchi ekrani.
 *
 * NEGA SHUNDAY: avval sahifa "Parolni o'zgartirish" kartasi bilan
 * boshlanardi, keyin "Rol: KITOBXON", "Ishonch reytingi" kabi ichki
 * atamalar kelardi. 14 yoshli o'quvchi uchun bu ma'nosiz — u yerda
 * o'zining YUTUG'ini ko'rishi kerak: qaysi darajada, necha kun ketma-ket
 * o'qiyapti, yillik maqsadga qancha qoldi.
 *
 * Vizual ierarxiya bitta: daraja halqasi. Ikkinchi "katta raqam"
 * qo'shilsa ikkalasi ham diqqatni yo'qotadi.
 *
 * HALOLLIK: barcha sonlar backenddan keladi. XP ma'lumoti bo'lmasa
 * daraja bloki umuman chizilmaydi — soxta "0-daraja" ko'rsatilmaydi.
 */

import { useTranslations } from "next-intl";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import type { XpState } from "@/lib/api/xp";

const fmt = (n: number) => new Intl.NumberFormat("uz-UZ").format(n);

/** Kun bo'yicha salomlashish kaliti — kichik, lekin sahifani "tirik" qiladi. */
function greetingKey(hour: number): "night" | "morning" | "day" | "evening" {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

export function ReaderHero({
  name,
  xp,
  booksThisYear,
  yearlyGoal = 10,
  /** Salomlashishni hisoblash uchun soat — SSR/klient farqini oldini olish
   *  uchun tashqaridan beriladi (`null` bo'lsa salomlashish chizilmaydi). */
  hour,
}: {
  name: string;
  xp: XpState | null;
  booksThisYear: number;
  yearlyGoal?: number;
  hour: number | null;
}) {
  const t = useTranslations("ReaderBits.hero");
  const goalPct = Math.min(
    100,
    Math.round((booksThisYear / Math.max(yearlyGoal, 1)) * 100),
  );
  const remaining = Math.max(0, yearlyGoal - booksThisYear);
  const goalDone = booksThisYear >= yearlyGoal;

  return (
    <section className="ink-surface overflow-hidden rounded-2xl p-5 text-white sm:p-6">
      {/* Salom */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {hour !== null && (
            <p className="text-sm text-brand-100">{t(greetingKey(hour))},</p>
          )}
          <h1 className="truncate text-xl font-bold sm:text-2xl">{name}</h1>
        </div>
        {xp && xp.currentStreak > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-400/20 px-3 py-1.5 text-sm font-bold text-accent-300 ring-1 ring-accent-400/30">
            <Icon.streak aria-hidden="true" size={ICON_SIZE.sm} />
            {t("streakDays", { count: xp.currentStreak })}
          </span>
        )}
      </div>

      {/* Daraja — faqat haqiqiy ma'lumot bo'lganda */}
      {xp && (
        <div className="mt-6 flex items-center gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-400 text-2xl font-bold text-brand-950"
            aria-hidden="true"
          >
            {xp.level}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold">{xp.levelName}</p>
            <p className="text-xs text-brand-100">{fmt(xp.xp)} XP</p>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/15"
              role="progressbar"
              aria-valuenow={xp.progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t("levelProgress")}
            >
              <div
                className="h-full rounded-full bg-accent-400 transition-[width] duration-700 ease-out motion-reduce:transition-none"
                style={{ width: `${xp.progressPct}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-brand-100/80">
              {xp.nextLevelXp === null
                ? t("maxLevel")
                : t("toNextLevel", { xp: fmt(xp.xpToNextLevel ?? 0) })}
            </p>
          </div>
        </div>
      )}

      {/* Yillik maqsad — PQ-9 ning "yiliga 10 kitob" maqsadi shaxsiy
          ko'rinishda. Bu — o'quvchini qaytib kelishga undaydigan asosiy
          ko'rsatkich, shuning uchun hero ichida. */}
      <div className="mt-6 rounded-xl bg-white/10 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold">{t("yearlyGoal")}</p>
          <p className="text-sm tabular-nums text-brand-100">
            {t("goalCount", { done: booksThisYear, goal: yearlyGoal })}
          </p>
        </div>
        <div
          className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-white/15"
          role="progressbar"
          aria-valuenow={goalPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("goalProgress")}
        >
          <div
            className="h-full rounded-full bg-info-400 transition-[width] duration-700 ease-out motion-reduce:transition-none"
            style={{ width: `${goalPct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-brand-100">
          {goalDone
            ? t("goalDone")
            : booksThisYear === 0
              ? t("goalStart")
              : t("goalRemaining", { count: remaining })}
        </p>
      </div>
    </section>
  );
}
