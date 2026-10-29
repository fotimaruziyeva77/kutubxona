"use client";

/**
 * /dashboard/donations — DONAT-03 admin breakdown UI (Plan 03-04).
 *
 * SUPER_ADMIN + BUXGALTER role-gated by the backend
 * (apps/backend/src/modules/donate/donate.controller.ts:123). The route is
 * also hidden from non-eligible roles by the dashboard sidebar filter — but
 * the backend guard is the source of truth.
 *
 * Two sections:
 *   1. Headline stats: total collected / spent / remaining (from /donate/stats)
 *   2. Admin breakdown:
 *        - By purpose (donut chart): LIBRARY_BOOKS / SCHOOL_BOOKS / GENERAL
 *        - By target (horizontal bar): top recipients of recorded spending
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { fmtNumber } from "@/lib/format";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { apiClient } from "@/lib/api-client";

// ── Types ─────────────────────────────────────────────────────────────────────

type DonateStats = {
  totalCollected: number;
  totalSpent: number;
  remaining: number;
  donorCount: number;
};

type ByTargetRow = {
  targetId: string | null;
  targetName: string | null;
  totalAmount: number;
  donationCount: number;
};
type ByPurposeRow = {
  purpose: string;
  purposeLabel?: string;
  totalAmount: number;
  donationCount: number;
};

type AdminBreakdown = {
  byTarget: ByTargetRow[];
  byPurpose: ByPurposeRow[];
  totalDonorCount?: number;
};

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchStats(): Promise<DonateStats> {
  const res = await apiClient("/donate/stats");
  if (!res.ok) {
    return { totalCollected: 0, totalSpent: 0, remaining: 0, donorCount: 0 };
  }
  return res.json();
}

async function fetchBreakdown(): Promise<AdminBreakdown> {
  const res = await apiClient("/donate/admin/breakdown");
  if (!res.ok) return { byTarget: [], byPurpose: [] };
  return res.json();
}

// ── UI ────────────────────────────────────────────────────────────────────────

const PURPOSE_COLORS: Record<string, string> = {
  LIBRARY_BOOKS: "#3b82f6", // blue
  SCHOOL_BOOKS: "#10b981",  // emerald
  GENERAL: "#f59e0b",       // amber
};

const fmt = (n: number) => fmtNumber(n);

export default function DonationsAdminPage() {
  const t = useTranslations("DonationsPanel");

  // Maqsad yorliqlari lokalga qarab moliya.*.json dan olinadi.
  const purposeLabels: Record<string, string> = {
    LIBRARY_BOOKS: t("purpose.libraryBooks"),
    SCHOOL_BOOKS: t("purpose.schoolBooks"),
    GENERAL: t("purpose.general"),
  };

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["donate-stats-admin"],
    queryFn: fetchStats,
    staleTime: 60_000,
  });

  const { data: breakdown, isLoading: breakdownLoading } = useQuery({
    queryKey: ["donate-admin-breakdown"],
    queryFn: fetchBreakdown,
    staleTime: 60_000,
  });

  const byTarget = breakdown?.byTarget ?? [];
  const byPurpose = breakdown?.byPurpose ?? [];

  // Top-10 targets only for the bar chart readability
  const topTargets = [...byTarget]
    .filter((row) => !!row.targetName)
    .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount))
    .slice(0, 10)
    .map((row) => ({
      targetName: row.targetName ?? "—",
      donationCount: row.donationCount,
      // recharts needs numeric values; defend against string sums
      totalAmount: Number(row.totalAmount),
    }));

  const purposeData = byPurpose.map((p) => ({
    name: purposeLabels[p.purpose] ?? p.purposeLabel ?? p.purpose,
    value: Number(p.totalAmount),
    count: p.donationCount,
    code: p.purpose,
  }));

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {t("title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("subtitle")}
          </p>
        </div>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card-surface rounded-2xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            {t("kpi.collected")}
          </p>
          <p className="text-2xl font-bold text-brand-700 mt-1">
            {statsLoading ? "…" : t("sum", { amount: fmt(stats?.totalCollected ?? 0) })}
          </p>
        </div>
        <div className="card-surface rounded-2xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            {t("kpi.spent")}
          </p>
          <p className="text-2xl font-bold text-emerald-700 mt-1">
            {statsLoading ? "…" : t("sum", { amount: fmt(stats?.totalSpent ?? 0) })}
          </p>
        </div>
        <div className="card-surface rounded-2xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            {t("kpi.remaining")}
          </p>
          <p className="text-2xl font-bold text-amber-700 mt-1">
            {statsLoading ? "…" : t("sum", { amount: fmt(stats?.remaining ?? 0) })}
          </p>
        </div>
        <div className="card-surface rounded-2xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            {t("kpi.donors")}
          </p>
          <p className="text-2xl font-bold text-slate-800 mt-1">
            {statsLoading ? "…" : `${fmt(stats?.donorCount ?? 0)}`}
          </p>
        </div>
      </div>

      {/* By purpose donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card-surface rounded-2xl p-5">
          <h2 className="text-lg font-semibold mb-3 text-slate-800">
            {t("charts.byPurpose")}
          </h2>
          {breakdownLoading ? (
            <div className="h-72 flex items-center justify-center text-slate-400">
              {t("loading")}
            </div>
          ) : purposeData.length === 0 ? (
            <div className="h-72 flex items-center justify-center text-slate-400">
              {t("charts.noData")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={purposeData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                >
                  {purposeData.map((entry) => (
                    <Cell
                      key={entry.code}
                      fill={PURPOSE_COLORS[entry.code] ?? "#9ca3af"}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number) => t("sum", { amount: fmt(v) })}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div className="mt-3 space-y-1.5">
            {purposeData.map((p) => (
              <div key={p.code} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-sm"
                    style={{ background: PURPOSE_COLORS[p.code] ?? "#9ca3af" }}
                  />
                  <span className="text-slate-700">{p.name}</span>
                </div>
                <span className="font-medium text-slate-900">
                  {t("charts.sumCount", { amount: fmt(p.value), count: p.count })}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* By target bar chart */}
        <div className="card-surface rounded-2xl p-5">
          <h2 className="text-lg font-semibold mb-3 text-slate-800">
            {t("charts.topTargets")}
          </h2>
          {breakdownLoading ? (
            <div className="h-72 flex items-center justify-center text-slate-400">
              {t("loading")}
            </div>
          ) : topTargets.length === 0 ? (
            <div className="h-72 flex items-center justify-center text-slate-400">
              {t("charts.noSpending")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={topTargets}
                layout="vertical"
                margin={{ top: 5, right: 20, left: 80, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis
                  type="category"
                  dataKey="targetName"
                  width={140}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip formatter={(v: number) => t("sum", { amount: fmt(v) })} />
                <Bar dataKey="totalAmount" fill="#3b82f6" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Full target table */}
      {byTarget.length > 0 && (
        <div className="card-surface rounded-2xl overflow-x-auto">
          <h2 className="text-lg font-semibold p-5 pb-3 text-slate-800">
            {t("table.title")}
          </h2>
          <table className="w-full text-sm">
            <thead className="bg-surface-muted border-b border-line">
              <tr className="text-left text-xs text-slate-500 uppercase">
                <th className="px-5 py-3 font-medium">{t("table.name")}</th>
                <th className="px-5 py-3 font-medium text-right">{t("table.total")}</th>
                <th className="px-5 py-3 font-medium text-right">{t("table.transactions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {/* Callback nomi `row` — tashqi `t` (tarjima) bilan to'qnashmasin. */}
              {byTarget.map((row) => (
                <tr key={`${row.targetId ?? "null"}-${row.targetName ?? "—"}`} className="hover:bg-surface-muted">
                  <td className="px-5 py-3 font-medium text-slate-900">
                    {row.targetName ?? <span className="text-slate-400 italic">{t("table.unassigned")}</span>}
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-brand-700">
                    {t("sum", { amount: fmt(Number(row.totalAmount)) })}
                  </td>
                  <td className="px-5 py-3 text-right text-slate-600">
                    {row.donationCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
