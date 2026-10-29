"use client";

/**
 * CrmMetricCard — endi dashboard/ui.tsx dagi StatCard'ga yupqa yo'naltirish.
 *
 * Ilgari bu yerda gradientli belgi (from-blue-500 to-indigo-600 va h.k.) va
 * qo'lda yozilgan SVG o'qlar bor edi — dizayn tili (yaxlit brand ranglar,
 * lucide ikonkalar) bilan mos emas edi. Do'kon dashboardi StatCard'ni
 * to'g'ridan-to'g'ri ishlatadi; bu o'ram eski chaqiruvlar buzilmasligi uchun
 * saqlab qolindi.
 */

import { StatCard, type StatTone } from "@/components/dashboard/ui";
import { Icon, type LucideIcon } from "@/components/ui/icon";

export default function CrmMetricCard({
  label,
  value,
  suffix = "",
  change,
  icon = Icon.stats,
  tone = "blue",
}: {
  label: string;
  value: number;
  /** Qiymat oxiridagi belgi, mas. "%". */
  suffix?: string;
  /** "+12%" ko'rinishidagi o'zgarish — StatCard trend'iga o'giriladi. */
  change?: string;
  /** lucide ikonka (Icon xaritasidan). */
  icon?: LucideIcon;
  tone?: StatTone;
}) {
  const parsed = change ? Number.parseFloat(change) : NaN;
  return (
    <StatCard
      icon={icon}
      label={label}
      value={suffix ? `${value}${suffix}` : value}
      tone={tone}
      trend={Number.isNaN(parsed) ? undefined : parsed}
    />
  );
}
