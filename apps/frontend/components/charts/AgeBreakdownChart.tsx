"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
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
 * Plan 05-03 T3 (STAT-05) — Age-group breakdown bar chart.
 *
 * Backend: GET /admin/stats/age?scope=...&scopeId=...
 */

// Plan 05-03-fix FIX B — backend now returns a k-anonymity-suppressed
// envelope. `suppressed:true` indicates the cell was redacted (< K=5).
type AgeBucket = {
  ageGroup: string;
  userCount: number;
  readingIndex: number;
  suppressed: boolean;
};
type AgeBreakdownResult = {
  buckets: AgeBucket[];
  privacyThreshold: number;
  anySuppressed: boolean;
};

type Props = {
  scope?: "national" | "viloyat" | "tuman" | "mahalla";
  scopeId?: string;
};

const BUCKET_ORDER = ["7-14", "15-30", "31-60", "60+", "unknown"];

async function fetchAgeBreakdown(
  scope: string,
  scopeId?: string,
): Promise<AgeBreakdownResult | null> {
  const qs = new URLSearchParams({ scope });
  if (scopeId) qs.set("scopeId", scopeId);
  const res = await apiClient(`/admin/stats/age?${qs.toString()}`);
  if (!res.ok) return null;
  return res.json();
}

export function AgeBreakdownChart({ scope = "national", scopeId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["age-breakdown", scope, scopeId ?? "all"],
    queryFn: () => fetchAgeBreakdown(scope, scopeId),
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

  if (error || !data || data.buckets.length === 0) {
    return (
      <ChartCard title="Yosh guruhi taqsimoti" icon={Icon.age} gradient="from-violet-500 to-fuchsia-600">
        <div className="py-10 text-center text-slate-400 text-sm">
          Yosh ma&apos;lumotlari mavjud emas
        </div>
      </ChartCard>
    );
  }

  // Sort by canonical bucket order
  const sorted = [...data.buckets].sort(
    (a, b) =>
      BUCKET_ORDER.indexOf(a.ageGroup) - BUCKET_ORDER.indexOf(b.ageGroup),
  );

  return (
    <ChartCard
      title="Yosh guruhi taqsimoti — Foydalanuvchilar va Reading Index"
      icon={Icon.age}
      gradient="from-violet-500 to-fuchsia-600"
      note={
        data.anySuppressed ? (
          <p className="text-xs text-accent-600 bg-amber-50 rounded-lg px-3 py-1.5 inline-block">
            Ba&apos;zi guruhlar maxfiylik chegarasidan past (k &lt; {data.privacyThreshold}) — yashirilgan.
          </p>
        ) : null
      }
    >
      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer>
          <BarChart data={sorted} margin={{ top: 10, right: 8, left: -8, bottom: 4 }} barGap={8}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="ageGroup" {...axisProps} dy={6} />
            <YAxis {...axisProps} width={40} />
            <Tooltip
              {...tooltipStyle}
              formatter={(value: number, name: string) => [
                value.toLocaleString(),
                name === "userCount" ? "Foydalanuvchilar" : "Reading Index",
              ]}
            />
            <Legend
              {...legendProps}
              formatter={(value: string) =>
                value === "userCount" ? "Foydalanuvchilar" : "Reading Index"
              }
            />
            <Bar dataKey="userCount" fill="#3b82f6" radius={[8, 8, 0, 0]} maxBarSize={54} />
            <Bar dataKey="readingIndex" fill="#10b981" radius={[8, 8, 0, 0]} maxBarSize={54} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

export default AgeBreakdownChart;
