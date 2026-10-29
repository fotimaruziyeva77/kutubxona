"use client";

// ============================================================================
// 2026 bold-gradient chart theme — shared Recharts styling so all charts look
// consistent and modern (gradient bars/areas, soft axes, glassy tooltip).
// ============================================================================
import type { ReactNode } from "react";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";

/** Named SVG gradients for bars/areas. Render once inside a chart's <defs>. */
export function ChartGradients() {
  return (
    <defs>
      {/* id nomlari o'zgarmaydi (chartlar shu id'larga bog'langan) —
          ranglar yangi "Kutubxona Editorial" palitrasiga o'tkazildi. */}
      <linearGradient id="grad-blue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#68a17c" />
        <stop offset="100%" stopColor="#326b48" />
      </linearGradient>
      <linearGradient id="grad-emerald" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#3bbfa9" />
        <stop offset="100%" stopColor="#0f8a7a" />
      </linearGradient>
      <linearGradient id="grad-violet" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#a78bfa" />
        <stop offset="100%" stopColor="#7c3aed" />
      </linearGradient>
      <linearGradient id="grad-amber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#d8ab45" />
        <stop offset="100%" stopColor="#a4761f" />
      </linearGradient>
      <linearGradient id="grad-pink" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f472b6" />
        <stop offset="100%" stopColor="#db2777" />
      </linearGradient>
      {/* Soft area fills (line/area charts) */}
      <linearGradient id="area-blue" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#326b48" stopOpacity={0.28} />
        <stop offset="100%" stopColor="#326b48" stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

// Soft, label-light axes (no hard axis line / tick line).
export const axisProps = {
  stroke: "#a8a29e",
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

export const gridProps = {
  vertical: false,
  stroke: "#eeece4",
  strokeDasharray: "4 4",
} as const;

// Soft rounded tooltip.
export const tooltipStyle = {
  contentStyle: {
    borderRadius: 14,
    border: "1px solid rgba(231,228,218,0.9)",
    boxShadow: "0 12px 32px -12px rgba(28,25,23,0.30)",
    padding: "8px 12px",
    fontSize: 13,
  },
  cursor: { fill: "rgba(50,107,72,0.06)" },
  itemStyle: { fontWeight: 600 },
} as const;

export const legendProps = {
  iconType: "circle" as const,
  wrapperStyle: { fontSize: 12, paddingTop: 8 },
};

/** Modern chart card shell — gradient icon badge + title, soft shadow. */
export function ChartCard({
  title,
  icon: CardIcon = Icon.stats,
  gradient = "from-blue-500 to-indigo-600",
  note,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  gradient?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card-surface rounded-2xl p-6">
      <div className="flex items-center gap-3 mb-1">
        <span
          className={`h-10 w-10 rounded-2xl bg-gradient-to-br ${gradient} text-white flex items-center justify-center shadow-lg shadow-blue-500/25 shrink-0`}
        >
          <CardIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
        </span>
        <h3 className="font-bold text-slate-900 leading-tight">{title}</h3>
      </div>
      {note}
      <div className="mt-3">{children}</div>
    </div>
  );
}
