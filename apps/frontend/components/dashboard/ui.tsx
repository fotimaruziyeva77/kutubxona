"use client";

/**
 * dashboard/ui.tsx — dashboard sahifalari uchun UMUMIY qurilish bloklari.
 *
 * Nega bitta joyda: 20+ admin sahifasi bir xil sarlavha/panel/statistika
 * naqshini takrorlar edi — har biri o'z gradient qutisi, o'z soyasi, o'z
 * emoji'si bilan. Natijada sahifalar "har xil joydan yig'ilgan" ko'rinardi.
 * Bu modul bitta vizual til beradi: yangi sahifa import qilib ishlatadi,
 * dizayn o'zgarsa — shu yerda o'zgaradi (topshiriq: reusable komponentlar).
 *
 * Barcha ikonkalar lucide (emoji EMAS), barcha kirishlar motion bilan va
 * `prefers-reduced-motion` hurmat qilinadi.
 */

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { fadeUp, staggerContainer } from "@/lib/motion";

// ── Sahifa sarlavhasi ───────────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  icon: HeaderIcon,
  badge,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  /** Ixtiyoriy — sarlavha yonidagi ikonka (neytral doirada). */
  icon?: LucideIcon;
  /** Hudud/holat yorlig'i (masalan tuman nomi). */
  badge?: { label: string; sub?: string; icon?: LucideIcon };
  /** O'ng tomondagi asosiy amal (tugma/havola). */
  action?: ReactNode;
  className?: string;
}) {
  const BadgeIcon = badge?.icon ?? Icon.map;
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex items-start gap-3">
        {HeaderIcon && (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <HeaderIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          {badge && (
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-brand-700">
              <BadgeIcon aria-hidden="true" size={ICON_SIZE.xs} />
              {badge.label}
              {badge.sub && (
                <span className="text-xs font-normal text-brand-400">{badge.sub}</span>
              )}
            </span>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ── Panel (oq karta) ────────────────────────────────────────────────────────

export function Panel({
  title,
  icon: PanelIcon,
  badge,
  action,
  children,
  className,
  /** Scroll bilan kirish animatsiyasini o'chirish (allaqachon ko'rinadigan panel). */
  noReveal,
}: {
  title?: string;
  icon?: LucideIcon;
  badge?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  noReveal?: boolean;
}) {
  const reduce = useReducedMotion();
  const animate = !reduce && !noReveal;
  return (
    <motion.section
      variants={animate ? fadeUp : undefined}
      initial={animate ? "hidden" : undefined}
      whileInView={animate ? "visible" : undefined}
      viewport={{ once: true, margin: "-40px" }}
      className={cn("card-surface rounded-xl p-5 sm:p-6", className)}
    >
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && (
            <h2 className="flex items-center gap-2 font-semibold text-slate-900">
              {PanelIcon && (
                <PanelIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={1.75} className="text-slate-400" />
              )}
              {title}
              {badge && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                  {badge}
                </span>
              )}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </motion.section>
  );
}

// ── Statistika kartasi + to'r ───────────────────────────────────────────────

/** KPI kartalar to'ri — bolalarni ketma-ket ochadi. */
export function StatGrid({
  children,
  cols = 4,
  className,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4;
  className?: string;
}) {
  const colClass =
    cols === 2 ? "sm:grid-cols-2"
      : cols === 3 ? "sm:grid-cols-2 lg:grid-cols-3"
        : "grid-cols-2 lg:grid-cols-4";
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className={cn("grid gap-4", colClass, className)}
    >
      {children}
    </motion.div>
  );
}

const STAT_TONES = {
  blue: "bg-brand-50 text-brand-600",
  green: "bg-green-50 text-green-600",
  amber: "bg-accent-50 text-accent-600",
  violet: "bg-violet-50 text-violet-600",
  rose: "bg-rose-50 text-rose-600",
  gray: "bg-surface-sunken text-slate-500",
} as const;

export type StatTone = keyof typeof STAT_TONES;

export function StatCard({
  icon: CardIcon,
  label,
  value,
  sub,
  tone = "blue",
  trend,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  sub?: string;
  tone?: StatTone;
  /** Foizli o'zgarish — musbat yashil, manfiy qizil o'q bilan. */
  trend?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      variants={reduce ? undefined : fadeUp}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.15 }}
      className="card-surface rounded-xl p-5 transition-shadow hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <span className={cn("flex h-10 w-10 items-center justify-center rounded-lg", STAT_TONES[tone])}>
          <CardIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
        </span>
        {typeof trend === "number" && trend !== 0 && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold",
              trend >= 0 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            )}
          >
            {trend >= 0 ? (
              <Icon.trendUp aria-hidden="true" size={12} />
            ) : (
              <Icon.trendDown aria-hidden="true" size={12} />
            )}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-slate-900 sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </motion.div>
  );
}

// ── Progress qatori (bar) ───────────────────────────────────────────────────

export function BarRow({
  label,
  value,
  pct,
  color = "bg-brand-500",
}: {
  label: string;
  value: string;
  pct: number;
  color?: string;
}) {
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold text-slate-900">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <motion.div
          className={cn("h-2 rounded-full", color)}
          initial={reduce ? false : { width: 0 }}
          whileInView={{ width: `${clamped}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}

// ── Reyting o'rni belgisi ───────────────────────────────────────────────────

/**
 * RankMedal — reyting o'rnini ko'rsatadi. 1/2/3 uchun rangli Medal ikonkasi
 * (oltin/kumush/bronza), qolganlar uchun `#N` raqami.
 *
 * Nega emoji 🥇🥈🥉 EMAS: emoji medallar OS'ga qarab har xil chiziladi va
 * qatordagi raqamlar bilan bir tekis turmaydi. Lucide Medal + rang bir xil.
 */
export function RankMedal({ rank }: { rank: number }) {
  const tone =
    rank === 1 ? "bg-amber-100 text-accent-600"
      : rank === 2 ? "bg-gray-200 text-slate-600"
        : rank === 3 ? "bg-orange-100 text-orange-700"
          : "bg-surface-sunken text-slate-500";
  return (
    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums", tone)}>
      {rank <= 3 ? (
        <Icon.medal aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2} />
      ) : (
        <span aria-hidden="true">{rank}</span>
      )}
      <span className="sr-only">{rank}-o'rin</span>
    </span>
  );
}

// ── Sahifa konteyneri ───────────────────────────────────────────────────────

/** Standart dashboard sahifa o'rami — bir xil kenglik va bo'shliq. */
export function DashboardPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto max-w-6xl space-y-6 p-4 sm:p-6", className)}>
      {children}
    </div>
  );
}
