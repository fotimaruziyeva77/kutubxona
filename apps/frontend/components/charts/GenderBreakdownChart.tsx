"use client";

import { useQuery } from "@tanstack/react-query";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import { apiClient } from "@/lib/api-client";
import {
  ChartCard,
  tooltipStyle,
  legendProps,
} from "./chart-theme";
import { Icon } from "@/components/ui/icon";

/**
 * Plan 05-03 T3 (STAT-04) — Gender donut chart with scope filter.
 *
 * Backend: GET /admin/stats/gender?scope=...&scopeId=...
 * Cookie-auth via apiClient (Phase 1 INFRA-02). Scope assert + caching
 * happen server-side; client just consumes the shape.
 */

// Plan 05-03-fix FIX B — backend now returns a k-anonymity-suppressed
// envelope. `suppressed:true` indicates the cell was redacted (< K=5).
type GenderBucket = { count: number; readingIndex: number; suppressed: boolean };
type GenderResult = {
  buckets: {
    MALE: GenderBucket;
    FEMALE: GenderBucket;
    UNKNOWN: GenderBucket;
  };
  privacyThreshold: number;
  anySuppressed: boolean;
};

type Props = {
  scope?: "national" | "viloyat" | "tuman";
  scopeId?: string;
};

// Solid fills — blue (MALE), pink (FEMALE). Solid renders reliably across all
// Recharts versions (url(#gradient) refs were silently invisible).
const COLORS = ["#3b82f6", "#ec4899"];

async function fetchGenderBreakdown(
  scope: string,
  scopeId?: string,
): Promise<GenderResult | null> {
  const qs = new URLSearchParams({ scope });
  if (scopeId) qs.set("scopeId", scopeId);
  const res = await apiClient(`/admin/stats/gender?${qs.toString()}`);
  if (!res.ok) return null;
  return res.json();
}

export function GenderBreakdownChart({ scope = "national", scopeId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["gender-breakdown", scope, scopeId ?? "all"],
    queryFn: () => fetchGenderBreakdown(scope, scopeId),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="card-surface rounded-2xl p-6">
        <div className="h-5 w-56 rounded-lg bg-surface-sunken animate-pulse" />
        <div className="mt-5 h-[260px] rounded-2xl bg-gradient-to-b from-gray-50 to-white animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <ChartCard title="Gender taqsimoti" icon={Icon.gender} gradient="from-blue-500 to-indigo-600">
        <div className="py-10 text-center text-slate-400 text-sm">
          Gender ma&apos;lumotlari mavjud emas
        </div>
      </ChartCard>
    );
  }

  const chartData = [
    {
      name: "Erkaklar",
      value: data.buckets.MALE.count,
      ri: data.buckets.MALE.readingIndex,
      suppressed: data.buckets.MALE.suppressed,
    },
    {
      name: "Ayollar",
      value: data.buckets.FEMALE.count,
      ri: data.buckets.FEMALE.readingIndex,
      suppressed: data.buckets.FEMALE.suppressed,
    },
  ];

  return (
    <ChartCard
      title="Gender taqsimoti — Reading Index bilan"
      icon={Icon.gender}
      gradient="from-blue-500 to-indigo-600"
      note={
        data.anySuppressed ? (
          <p className="text-xs text-accent-600 bg-amber-50 rounded-lg px-3 py-1.5 inline-block">
            Ba&apos;zi guruhlar maxfiylik chegarasidan past (k &lt; {data.privacyThreshold}) — yashirilgan.
          </p>
        ) : null
      }
    >
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={3}
              label={({ name, value }) => `${name}: ${value.toLocaleString()}`}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip
              {...tooltipStyle}
              formatter={(value, name, entry) => {
                const ri = ((entry as { payload?: { ri?: number } })?.payload?.ri) ?? 0;
                return [`${Number(value).toLocaleString()} (RI: ${ri})`, String(name)];
              }}
            />
            <Legend {...legendProps} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export default GenderBreakdownChart;
