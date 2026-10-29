"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { apiClient } from "@/lib/api-client";
import {
  ChartCard,
  axisProps,
  gridProps,
  tooltipStyle,
  legendProps,
} from "./chart-theme";
import { Icon } from "@/components/ui/icon";

/**
 * Plan 05-03 T3 (STAT-06) — Genre × month stacked area chart.
 *
 * Backend: GET /admin/stats/genres/trend?months=12&scope=...&scopeId=...
 * Top-15 genres returned by backend; chart shows stacked monthly counts.
 */

type GenreTrendRow = {
  genre: string;
  monthly: Array<{ month: string; count: number }>;
};

type Props = {
  months?: number;
  scope?: "national" | "viloyat" | "tuman" | "mahalla";
  scopeId?: string;
};

const PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16",
  "#06b6d4", "#a855f7", "#22c55e", "#eab308", "#64748b",
];

async function fetchGenreTrend(
  months: number,
  scope: string,
  scopeId?: string,
): Promise<GenreTrendRow[]> {
  const qs = new URLSearchParams({ months: String(months), scope });
  if (scopeId) qs.set("scopeId", scopeId);
  const res = await apiClient(`/admin/stats/genres/trend?${qs.toString()}`);
  if (!res.ok) return [];
  return res.json();
}

export function GenreTrendChart({
  months = 12,
  scope = "national",
  scopeId,
}: Props) {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["genre-trend", months, scope, scopeId ?? "all"],
    queryFn: () => fetchGenreTrend(months, scope, scopeId),
    staleTime: 60 * 60 * 1000,
  });

  // Reshape: pivot to per-month rows with one column per genre.
  const { rows, genres } = useMemo(() => {
    if (data.length === 0) return { rows: [], genres: [] as string[] };
    const monthSet = new Set<string>();
    for (const g of data) for (const m of g.monthly) monthSet.add(m.month);
    const sortedMonths = Array.from(monthSet).sort();
    const genreList = data.map((g) => g.genre);
    const rows = sortedMonths.map((month) => {
      const row: Record<string, string | number> = { month };
      for (const g of data) {
        const found = g.monthly.find((m) => m.month === month);
        row[g.genre] = found?.count ?? 0;
      }
      return row;
    });
    return { rows, genres: genreList };
  }, [data]);

  if (isLoading) {
    return (
      <div className="card-surface rounded-2xl p-6">
        <div className="h-5 w-64 rounded-lg bg-surface-sunken animate-pulse" />
        <div className="mt-5 h-[360px] rounded-2xl bg-gradient-to-b from-gray-50 to-white animate-pulse" />
      </div>
    );
  }

  if (error || rows.length === 0) {
    return (
      <ChartCard title="Janr × oy trend" icon={Icon.library} gradient="from-emerald-500 to-teal-600">
        <div className="py-10 text-center text-slate-400 text-sm">
          Janr trend ma&apos;lumotlari mavjud emas
        </div>
      </ChartCard>
    );
  }

  // Single month of data — an Area over one x-point is a degenerate vertical
  // strip that reads as "nothing". Show that month's genre counts as
  // horizontal bars instead, which is immediately legible.
  if (rows.length < 2) {
    const latest = rows[rows.length - 1];
    const single = genres
      .map((g) => ({ genre: g, count: Number(latest[g]) || 0 }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);
    const barH = Math.max(220, single.length * 42 + 40);
    return (
      <ChartCard
        title={`Janr taqsimoti — ${latest.month}`}
        icon={Icon.library}
        gradient="from-emerald-500 to-teal-600"
        note={
          <p className="text-xs text-slate-400">
            Trend grafigi uchun kamida 2 oy ma&apos;lumot kerak — hozircha 1 oy mavjud.
          </p>
        }
      >
        <div style={{ width: "100%", height: barH }}>
          <ResponsiveContainer>
            <BarChart data={single} layout="vertical" margin={{ top: 4, right: 28, left: 8, bottom: 4 }}>
              <XAxis type="number" {...axisProps} allowDecimals={false} />
              <YAxis type="category" dataKey="genre" width={120} {...axisProps} />
              <Tooltip {...tooltipStyle} formatter={(v: number) => [v.toLocaleString(), "Kitoblar"]} />
              <Bar dataKey="count" fill="#10b981" radius={[0, 8, 8, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title={`Janr × oy trend — so'nggi ${months} oy (top-15 janr)`}
      icon={Icon.library}
      gradient="from-emerald-500 to-teal-600"
    >
      <div style={{ width: "100%", height: 360 }}>
        <ResponsiveContainer>
          <AreaChart data={rows} margin={{ top: 10, right: 12, left: -8, bottom: 4 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" {...axisProps} dy={6} />
            <YAxis {...axisProps} width={40} />
            <Tooltip {...tooltipStyle} />
            <Legend {...legendProps} />
            {genres.map((g, i) => (
              <Area
                key={g}
                type="monotone"
                dataKey={g}
                stackId="1"
                // Hero series rides the shared blue stroke + soft area gradient;
                // the rest keep the multi-hue palette so 15 stacked bands stay legible.
                stroke={i === 0 ? "#2563eb" : PALETTE[i % PALETTE.length]}
                strokeWidth={i === 0 ? 3 : 2}
                fill={i === 0 ? "#2563eb" : PALETTE[i % PALETTE.length]}
                fillOpacity={i === 0 ? 0.25 : 0.65}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export default GenreTrendChart;
