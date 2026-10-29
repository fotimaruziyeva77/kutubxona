"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import { getViloyatlar, getTumanlar } from "@/lib/api/geo";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { PageHeader, StatCard, RankMedal, StatGrid } from "@/components/dashboard/ui";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";
import type { StatTone } from "@/components/dashboard/ui";

// FIX (family auth) — calls go through the fetch-wrapper apiClient, whose axios
// interceptor attaches the in-memory Bearer token AND, on a hard reload where
// the token is still null, performs the single-flight boot refresh from the
// HttpOnly cookie before the request leaves (+ 401→refresh→retry). The previous
// manual `headers: { Authorization: Bearer ${token} }` read the store token
// directly — null right after a reload (H16) — so the first calls 401'd. Paths
// are BARE (axios baseURL = `<origin>/api`).

interface TopFamily {
  id: string;
  name: string;
  avgScore: number;
  totalBooks: number;
  memberCount: number;
  rank: number;
  viloyatRank?: number;
  tumanRank?: number;
}

interface FamilyStats {
  totalFamilies: number;
  totalMembers: number;
  avgFamilySize: number;
  avgRating: number;
}

export default function DashboardFamilyPage() {
  const t = useTranslations("FamilyPanel");
  const { user } = useAuthStore();
  const qc = useQueryClient();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [viloyatFilter, setViloyatFilter] = useState("");
  const [tumanFilter, setTumanFilter] = useState("");

  // Filtr uchun hudud ro'yxatlari (nomma-nom tanlash).
  const { data: viloyatlar = [] } = useQuery({
    queryKey: ["geo-viloyatlar"],
    queryFn: getViloyatlar,
    staleTime: 3_600_000,
  });
  const { data: tumanlar = [] } = useQuery({
    queryKey: ["geo-tumanlar", viloyatFilter],
    queryFn: () => getTumanlar(viloyatFilter),
    enabled: !!viloyatFilter,
    staleTime: 3_600_000,
  });

  const buildQuery = () => {
    const params = new URLSearchParams({ month, limit: "100" });
    if (viloyatFilter) params.set("viloyatId", viloyatFilter);
    if (tumanFilter) params.set("tumanId", tumanFilter);
    return params.toString();
  };

  // RBAC geographic scoping (Audit 2026-06) — the dashboard uses the
  // auth+region-scoped admin endpoint, NOT the public `ratings/top`. The server
  // clamps a VILOYAT/TUMAN admin's filters to their own region so they cannot
  // browse other viloyats; SUPER_ADMIN keeps full national access + free filters.
  const {
    data: topFamilies,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<TopFamily[]>({
    queryKey: ["dashboard-top-families", month, viloyatFilter, tumanFilter],
    queryFn: async () => {
      const res = await apiClient(`/family/ratings/admin?${buildQuery()}`);
      // Xatoni bo'sh ro'yxatga aylantirmaymiz — "ma'lumot yo'q" bilan
      // "server javob bermadi" adminга bir xil ko'rinib qolardi.
      if (!res.ok) {
        throw new Error(res.status === 403 ? "FORBIDDEN" : "Reytingni yuklab bo'lmadi");
      }
      const data = await res.json();
      return data.items ?? data;
    },
    retry: false,
  });
  const isForbidden = isError && (error as Error)?.message === "FORBIDDEN";

  const computeRatings = useMutation({
    mutationFn: async () => {
      const res = await apiClient(`/family/ratings/compute`, {
        method: "POST",
        body: JSON.stringify({ month }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Xato");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard-top-families"] }),
  });

  const stats: FamilyStats = {
    totalFamilies: topFamilies?.length ?? 0,
    totalMembers: topFamilies?.reduce((a, f) => a + f.memberCount, 0) ?? 0,
    avgFamilySize:
      topFamilies && topFamilies.length > 0
        ? topFamilies.reduce((a, f) => a + f.memberCount, 0) / topFamilies.length
        : 0,
    avgRating:
      topFamilies && topFamilies.length > 0
        ? topFamilies.reduce((a, f) => a + f.avgScore, 0) / topFamilies.length
        : 0,
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.family}
        action={
          isSuperAdmin ? (
            <button
              onClick={() => computeRatings.mutate()}
              disabled={computeRatings.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98] disabled:opacity-50"
            >
              <Icon.refresh aria-hidden="true" size={ICON_SIZE.sm} className={computeRatings.isPending ? "animate-spin" : ""} />
              {computeRatings.isPending ? t("computing") : t("computeBtn")}
            </button>
          ) : undefined
        }
      />

      {computeRatings.isSuccess && (
        <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <Icon.success aria-hidden="true" size={ICON_SIZE.sm} />
          {t("computeSuccess")}
        </div>
      )}

      {/* Stats cards */}
      <StatGrid cols={4}>
        {([
          { label: t("statFamilies"), value: stats.totalFamilies, icon: Icon.family, tone: "blue" as StatTone },
          { label: t("statMembers"), value: stats.totalMembers, icon: Icon.reader, tone: "green" as StatTone },
          { label: t("statAvgSize"), value: stats.avgFamilySize.toFixed(1), icon: Icon.stats, tone: "violet" as StatTone },
          { label: t("statAvgRating"), value: stats.avgRating.toFixed(1), icon: Icon.star, tone: "amber" as StatTone },
        ]).map((c) => (
          <StatCard key={c.label} icon={c.icon} label={c.label} value={c.value} tone={c.tone} />
        ))}
      </StatGrid>

      {/* Filters */}
      <div className="bg-white rounded-2xl p-4 border border-line">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">{t("month")}</label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          {/* Ilgari bu ikkalasi erkin matnli "Viloyat ID"/"Tuman ID" edi —
              admin "08" kabi ichki kodni yoddan yozishi kutilardi. Endi
              nomma-nom kaskad tanlash. */}
          <div>
            <label htmlFor="family-viloyat" className="text-xs font-medium text-slate-600 block mb-1">{t("viloyat")}</label>
            <select
              id="family-viloyat"
              value={viloyatFilter}
              onChange={(e) => { setViloyatFilter(e.target.value); setTumanFilter(""); }}
              className="px-3 py-2 border border-line-strong rounded-lg text-sm min-w-40 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">{t("all")}</option>
              {viloyatlar.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="family-tuman" className="text-xs font-medium text-slate-600 block mb-1">{t("tuman")}</label>
            <select
              id="family-tuman"
              value={tumanFilter}
              onChange={(e) => setTumanFilter(e.target.value)}
              disabled={!viloyatFilter}
              className="px-3 py-2 border border-line-strong rounded-lg text-sm min-w-40 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            >
              <option value="">{t("all")}</option>
              {tumanlar.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => {
              setViloyatFilter("");
              setTumanFilter("");
            }}
            className="px-3 py-2 text-sm text-slate-500 hover:text-slate-700 border border-line-strong rounded-lg"
          >
            {t("clearFilters")}
          </button>
        </div>
      </div>

      {/* Top families table */}
      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Icon.trophy aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-500" />{t("topFamilies", { month })}</h3>
          <span className="text-xs text-slate-500">{t("familyCount", { count: topFamilies?.length ?? 0 })}</span>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-slate-400">{t("loading")}</div>
        ) : isForbidden ? (
          <div className="p-5">
            <ForbiddenState message={t("forbidden")} />
          </div>
        ) : isError ? (
          <div className="p-5">
            <ErrorState
              title={t("errTitle")}
              message={t("errMsg")}
              onRetry={() => refetch()}
              isRetrying={isFetching}
            />
          </div>
        ) : !topFamilies || topFamilies.length === 0 ? (
          <div className="p-8 text-center text-slate-400">
            {t("empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-muted text-left">
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 w-16">#</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500">{t("thFamilyName")}</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 text-center">{t("thMembers")}</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 text-center">{t("thBooks")}</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 text-right">{t("thScore")}</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 text-right">{t("thViloyatRank")}</th>
                  <th className="px-5 py-3 text-xs font-semibold text-slate-500 text-right">{t("thTumanRank")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {topFamilies.map((fam) => {
                  return (
                    <tr key={fam.id} className="hover:bg-surface-muted transition-colors">
                      <td className="px-5 py-3.5">
                        <RankMedal rank={fam.rank} />
                      </td>
                      <td className="px-5 py-3.5 font-medium text-slate-900">{fam.name}</td>
                      <td className="px-5 py-3.5 text-center text-slate-600">{fam.memberCount}</td>
                      <td className="px-5 py-3.5 text-center text-slate-600">{fam.totalBooks}</td>
                      <td className="px-5 py-3.5 text-right font-bold text-brand-700">
                        {fam.avgScore.toFixed(1)}
                      </td>
                      <td className="px-5 py-3.5 text-right text-slate-500">
                        {fam.viloyatRank ? `#${fam.viloyatRank}` : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-right text-slate-500">
                        {fam.tumanRank ? `#${fam.tumanRank}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Info note */}
      <div className="text-xs text-slate-400 bg-surface-muted rounded-xl p-3 border border-line">
        <strong>{t("noteLabel")}</strong> {t("noteText")}
      </div>
    </div>
  );
}
