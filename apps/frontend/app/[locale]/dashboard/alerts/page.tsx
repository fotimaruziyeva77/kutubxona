"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
// Plan 05-05 T3 — single-source-of-truth vocabulary mirrors backend
// ALERT_TYPES. Replaces inline string literals like "INACTIVE_LIBRARY"
// (legacy admin.service vocab) with the consolidated audit.service vocab.
import {
  ALERT_TYPE_LABELS,
} from "@/lib/alert-types.const";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";

type Alert = {
  id: string;
  scope: string;
  scopeId: string;
  issueType: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  analysis: string;
  recommendation: string;
  resolved: boolean;
  createdAt: string;
};

async function fetchAlerts(): Promise<Alert[]> {
  const res = await apiClient("/admin/alerts?limit=100");
  // XATONI YUTMAYMIZ. Avval `return []` qilinardi va natijada backend
  // ishlamay qolganda ekranda yashil belgi bilan "Faol ogohlantirish yo'q"
  // chiqardi — admin tizim sog'lom deb o'ylab, kritik alertlarni
  // ko'rmasdan qolardi. Bu panelning butun maqsadiga zid.
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "FORBIDDEN"
        : "Ogohlantirishlarni yuklab bo'lmadi",
    );
  }
  return res.json();
}

async function resolveAlert(id: string) {
  const res = await apiClient(`/admin/alerts/${id}/resolve`, { method: "PATCH" });
  if (!res.ok) throw new Error("Yechib bo'lmadi");
  return res.json();
}

// Severity yorliqlari AlertsPanel.sev.* tarjima kalitlaridan olinadi.
// Backend Severity enumida CRITICAL ham bor — Playwright sinovi jonli
// ma'lumotda MISSING_MESSAGE ushladi: eng jiddiy daraja xaritada yo'q edi
// va KRITIK ogohlantirish LOW rangida (ko'k!) chiqardi.
const SEV_CONFIG: Record<string, { bg: string; border: string; badge: string; dot: string }> = {
  CRITICAL: { bg: "bg-red-100", border: "border-red-300", badge: "bg-red-600 text-white", dot: "bg-red-600" },
  HIGH: { bg: "bg-red-50", border: "border-red-200", badge: "bg-red-100 text-red-700", dot: "bg-red-500" },
  MEDIUM: { bg: "bg-yellow-50", border: "border-yellow-200", badge: "bg-yellow-100 text-yellow-700", dot: "bg-amber-500" },
  LOW: { bg: "bg-blue-50", border: "border-brand-200", badge: "bg-brand-100 text-brand-700", dot: "bg-brand-500" }
};
const SEV_KEYS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
// Noma'lum daraja xom t()-kalit bo'lib chiqmasin.
const sevLabel = (t: ReturnType<typeof useTranslations>, sev: string) =>
  (SEV_KEYS as readonly string[]).includes(sev) ? t(`sev.${sev}`) : sev;

export default function AlertsPage() {
  const t = useTranslations("AlertsPanel");
  const [filterSev, setFilterSev] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  // Per-row in-flight id. Previously the button keyed its disabled/greyed
  // state on the SHARED `resolveMut.isPending`, so resolving ONE alert greyed
  // out (and appeared to "resolve") EVERY row at once. Tracking the specific
  // id — same pattern as fraud-review/top-review — scopes the pending UI to
  // the clicked row only.
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Client-side pagination — 100 alerts in one scroll is unusable. Page through
  // the filtered list instead. Filters reset to page 1 (see button handlers);
  // resolving the last row on a page is handled by clamping `safePage` below.
  const [page, setPage] = useState(1);
  // Sahifa hajmi — foydalanuvchi 20 / 50 / 100 ni tanlaydi.
  const [pageSize, setPageSize] = useState(20);
  const qc = useQueryClient();

  const ALERTS_KEY = ["smart-alerts-full"] as const;

  const {
    data: alerts = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ALERTS_KEY,
    queryFn: fetchAlerts,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });
  const isForbidden = isError && (error as Error)?.message === "FORBIDDEN";

  const resolveMut = useMutation({
    mutationFn: resolveAlert,
    // Optimistically drop ONLY the resolved row so the clicked alert leaves the
    // active list and the KRITIK/OGOHLANTIRISH/AXBOROT counters update at once,
    // while every other alert stays untouched. Snapshot enables rollback if the
    // PATCH fails.
    onMutate: async (id: string) => {
      setResolvingId(id);
      await qc.cancelQueries({ queryKey: ALERTS_KEY });
      const previous = qc.getQueryData<Alert[]>(ALERTS_KEY);
      qc.setQueryData<Alert[]>(ALERTS_KEY, (old) =>
        (old ?? []).filter((a) => a.id !== id)
      );
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(ALERTS_KEY, ctx.previous);
    },
    onSettled: () => {
      setResolvingId(null);
      qc.invalidateQueries({ queryKey: ALERTS_KEY });
    }
  });

  const filtered = alerts.filter((a) => {
    if (filterSev !== "all" && a.severity !== filterSev) return false;
    if (filterType !== "all" && a.issueType !== filterType) return false;
    return true;
  });

  const byCount: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const a of alerts) byCount[a.severity] = (byCount[a.severity] ?? 0) + 1;

  // Pagination — clamp the page so removing rows (resolve) or switching filters
  // never lands on an out-of-range page.
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const firstOnPage = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastOnPage = Math.min(safePage * pageSize, filtered.length);
  // Windowed page numbers (max 5) so 13 pages don't sprawl across the row.
  const winStart = Math.max(1, Math.min(safePage - 2, pageCount - 4));
  const winEnd = Math.min(pageCount, winStart + 4);
  const pageNums: number[] = [];
  for (let p = winStart; p <= winEnd; p++) pageNums.push(p);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon.bell aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} /></span>{t("title")}</h1>
        <div className="text-sm text-slate-500">
          {t("activeCount", { count: alerts.length })}
        </div>
      </div>

      {/* Statistika */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {SEV_KEYS.map((sev) => {
          const cfg = SEV_CONFIG[sev];
          return (
            <div key={sev} className={`rounded-2xl border p-4 ${cfg.bg} ${cfg.border}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`h-2 w-2 rounded-full ${cfg.dot}`} aria-hidden="true" />
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.badge}`}>{sevLabel(t, sev)}</span>
              </div>
              <p className="text-3xl font-black text-slate-800">{byCount[sev]}</p>
            </div>
          );
        })}
      </div>

      {/* Filtr — Severity */}
      <div className="flex gap-2 flex-wrap">
        {["all", ...SEV_KEYS].map((sev) => (
          <button
            key={sev}
            onClick={() => { setFilterSev(sev); setPage(1); }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              filterSev === sev
                ? "bg-brand-600 text-white"
                : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
            }`}
          >
            {sev === "all" ? t("all") : sevLabel(t, sev)}
          </button>
        ))}
      </div>

      {/* Filtr — Alert Type (Plan 05-05 T3 ALERT_TYPE_LABELS) */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-xs text-slate-500 mr-1">{t("typeLabel")}</span>
        <button
          key="all-types"
          onClick={() => { setFilterType("all"); setPage(1); }}
          className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
            filterType === "all"
              ? "bg-brand-600 text-white"
              : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
          }`}
        >
          {t("all")}
        </button>
        {Object.entries(ALERT_TYPE_LABELS).map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setFilterType(key); setPage(1); }}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              filterType === key
                ? "bg-brand-600 text-white"
                : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
            }`}
          >
            {label.uz}
          </button>
        ))}
      </div>

      {/* Sahifa hajmi tanlash — 20 / 50 / 100 */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-slate-500">{t("pageSizeLabel")}</span>
        {[20, 50, 100].map((size) => (
          <button
            key={size}
            onClick={() => { setPageSize(size); setPage(1); }}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              pageSize === size
                ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25"
                : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
            }`}
          >
            {size}
          </button>
        ))}
      </div>

      {/* Alertlar ro'yhati */}
      {isLoading ? (
        <div className="text-center py-12 text-slate-400">{t("loading")}</div>
      ) : isForbidden ? (
        <ForbiddenState message={t("forbidden")} />
      ) : isError ? (
        <ErrorState
          title={t("errTitle")}
          message={t("errMsg")}
          onRetry={() => refetch()}
          isRetrying={isFetching}
        />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center card-surface rounded-xl py-16 text-center">
          <Icon.success aria-hidden="true" size={32} strokeWidth={1.5} className="text-green-500" />
          <p className="mt-2 text-slate-500">{t("empty")}</p>
        </div>
      ) : (
        <>
        <div className="space-y-3">
          {paged.map((alert) => {
            const cfg = SEV_CONFIG[alert.severity] ?? SEV_CONFIG.LOW;
            return (
              <div
                key={alert.id}
                className={`rounded-2xl border p-5 ${cfg.bg} ${cfg.border}`}
              >
                <div className="flex items-start gap-4">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${cfg.dot}`} aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cfg.badge}`}>
                        {sevLabel(t, alert.severity)}
                      </span>
                      <span className="text-xs bg-surface-sunken text-slate-600 px-2 py-0.5 rounded-full">
                        {ALERT_TYPE_LABELS[alert.issueType]?.uz ?? alert.issueType}
                      </span>
                      <span className="text-xs text-slate-400">
                        {alert.scope} · {alert.scopeId.slice(0, 12)}…
                      </span>
                      <span className="ml-auto text-xs text-slate-400">
                        {new Date(alert.createdAt).toLocaleString("uz-UZ")}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-800 mb-1">{alert.analysis}</p>
                    <p className="text-xs text-slate-600 bg-white/60 rounded-lg px-3 py-2">
                      <Icon.sparkle aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline text-blue-500" />{alert.recommendation}
                    </p>
                  </div>
                  <button
                    onClick={() => resolveMut.mutate(alert.id)}
                    disabled={resolvingId === alert.id}
                    className="shrink-0 px-3 py-1.5 card-surface rounded-xl text-xs font-medium text-slate-600 hover:bg-surface-muted disabled:opacity-40 transition-colors"
                  >
                    {resolvingId === alert.id ? t("resolving") : <span className="inline-flex items-center gap-1"><Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />{t("resolved")}</span>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination — sahifalarga bo'lish (cheksiz scroll o'rniga) */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <span className="text-xs text-slate-500">
              {t("pageInfo", { first: firstOnPage, last: lastOnPage, total: filtered.length })}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage(Math.max(1, safePage - 1))}
                disabled={safePage <= 1}
                className="h-9 w-9 card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label={t("prevPage")}
              >
                ‹
              </button>
              {winStart > 1 && (
                <span className="px-1 text-slate-400 text-sm">…</span>
              )}
              {pageNums.map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`h-9 min-w-9 px-3 rounded-xl text-sm font-medium transition-colors ${
                    p === safePage
                      ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25"
                      : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
                  }`}
                >
                  {p}
                </button>
              ))}
              {winEnd < pageCount && (
                <span className="px-1 text-slate-400 text-sm">…</span>
              )}
              <button
                onClick={() => setPage(Math.min(pageCount, safePage + 1))}
                disabled={safePage >= pageCount}
                className="h-9 w-9 card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label={t("nextPage")}
              >
                ›
              </button>
            </div>
          </div>
        )}
        </>
      )}

      <p className="text-xs text-slate-400 text-center">
        {t("footer")}
      </p>
    </div>
  );
}
