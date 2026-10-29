"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { fmtNumber } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { apiClient } from "@/lib/api-client";
import { apiClient as axiosClient } from "@/lib/api/client";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import {
  DashboardPage,
  PageHeader,
  Panel,
  StatGrid,
  StatCard,
  BarRow,
} from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import {
  SkeletonStatGrid,
  SkeletonChart,
  SkeletonTable,
  SkeletonText,
} from "@/components/ui/skeleton";
import {
  LIBRARY_TYPE_LABELS,
  PLAN_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  label,
} from "@/lib/labels.const";

// FIX (buxgalter auth) — every call now goes through the token-attaching
// clients. The previous `fetch(`${API}/...`, { credentials: "include" })` only
// sent the HttpOnly *refresh* cookie (scoped to /api/auth) — NOT the in-memory
// Bearer access token (H16) — so every JSON call 401/403'd and the panels were
// empty. JSON GET/POST/PATCH use the fetch-wrapper `apiClient` (axios request
// interceptor adds `Authorization: Bearer <token>` + 401→refresh→retry). Blob
// downloads (CSV / XLSX / 1C / PDF) use the raw axios instance `axiosClient`
// with `responseType: "blob"` so the same token rides the request. All paths
// are BARE — the axios baseURL is already `<origin>/api`.

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentStats {
  totalInvoices: number;
  paidInvoices: number;
  pendingInvoices: number;
  totalRevenue: number;
  byMethod: Array<{ method: string; amount: number; count: number }>;
  monthlyTrend: Array<{ month: string; amount: number; count: number }>;
}

interface Invoice {
  id: string;
  amount: string;
  status: string;
  dueDate: string;
  paidDate?: string;
  paymentMethod?: string;
  createdAt: string;
  subscription: {
    planType: string;
    library: { name: string; type: string };
  };
}

interface SubscriptionStats {
  byStatus: Array<{ status: string; count: number }>;
  byPlan: Array<{ plan: string; count: number }>;
  totalRevenue: number;
}

interface SubscriptionRow {
  id: string;
  planType: string;
  status: string;
  startDate: string;
  endDate: string;
  library: { name: string; type: string };
  invoices?: Array<{ amount: string; status: string }>;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function usePaymentStats(from: string, to: string) {
  return useQuery<PaymentStats>({
    queryKey: ["payment-stats", from, to],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const r = await apiClient(`/invoices/stats?${params}`);
      if (!r.ok) throw new Error("Statistika yuklanmadi");
      return r.json();
    },
    staleTime: 120_000,
  });
}

function useInvoices(status: string, page: number) {
  return useQuery({
    queryKey: ["invoices", status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) params.set("status", status);
      const r = await apiClient(`/invoices?${params}`);
      if (!r.ok) throw new Error("Fakturalar yuklanmadi");
      return r.json() as Promise<{ invoices: Invoice[]; total: number }>;
    },
    staleTime: 60_000,
  });
}

function useSubscriptionStats() {
  return useQuery<SubscriptionStats>({
    queryKey: ["subscription-stats"],
    queryFn: async () => {
      const r = await apiClient(`/subscriptions/stats`);
      if (!r.ok) throw new Error("Obuna statistikasi yuklanmadi");
      return r.json();
    },
    staleTime: 120_000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Faktura holatlari backend'da PAID/PENDING/FAILED/REFUNDED — labels.const
// dagi INVOICE_STATUS_LABELS dan farq qiladi (u OVERDUE/CANCELLED biladi),
// shu sabab lokal xarita saqlanadi.
function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("BuxgalterPanel");
  const map: Record<string, string> = {
    PAID: "bg-green-100 text-green-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    FAILED: "bg-red-100 text-red-700",
    REFUNDED: "bg-surface-sunken text-slate-600",
  };
  const labels: Record<string, string> = {
    PAID: t("invoiceStatus.paid"),
    PENDING: t("invoiceStatus.pending"),
    FAILED: t("invoiceStatus.failed"),
    REFUNDED: t("invoiceStatus.refunded"),
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${map[status] ?? "bg-surface-sunken"}`}>
      {labels[status] ?? status}
    </span>
  );
}

const SUB_STATUS_BAR_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-500",
  TRIAL: "bg-brand-500",
  PENDING: "bg-yellow-500",
  FROZEN: "bg-gray-400",
  DELETED: "bg-red-400",
};

// ── Main Component ─────────────────────────────────────────────────────────────

// Yorliqlar moliya.*.json dagi BuxgalterPanel.tabs.<id> kalitidan olinadi.
const TABS: { id: "overview" | "invoices" | "subscriptions"; icon: LucideIcon }[] = [
  { id: "overview", icon: Icon.stats },
  { id: "invoices", icon: Icon.document },
  { id: "subscriptions", icon: Icon.checklist },
];

export default function BuxgalterPage() {
  const t = useTranslations("BuxgalterPanel");
  const [tab, setTab] = useState("overview");

  // Valyuta HAR UCH tarmoqda ko'rsatiladi. Ilgari faqat oxirgisida "so'm"
  // bor edi, shu sabab "Jami tushum" KPI si "12.4 mlrd" deb — birligsiz —
  // chiqardi. Buxgalter panelida raqamning nima ekani noaniq qolmasin.
  const formatSum = (amount: number) => {
    if (amount >= 1_000_000_000)
      return t("sum.billion", { value: (amount / 1_000_000_000).toFixed(1) });
    if (amount >= 1_000_000)
      return t("sum.million", { value: (amount / 1_000_000).toFixed(1) });
    return t("sum.plain", { value: fmtNumber(amount) });
  };

  const methodLabels: Record<string, string> = {
    PAYME: t("method.payme"),
    CLICK: t("method.click"),
    BANK_TRANSFER: t("method.bank"),
    CASH: t("method.cash"),
  };
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoiceStatus, setInvoiceStatus] = useState("");
  const [invoicePage, setInvoicePage] = useState(1);

  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    refetch: refetchStats,
    isRefetching: statsRefetching,
  } = usePaymentStats(dateFrom, dateTo);
  const {
    data: invoicesData,
    isLoading: invoicesLoading,
    isError: invoicesError,
    refetch: refetchInvoices,
    isRefetching: invoicesRefetching,
  } = useInvoices(invoiceStatus, invoicePage);
  const {
    data: subStats,
    isLoading: subStatsLoading,
    isError: subStatsError,
    refetch: refetchSubStats,
  } = useSubscriptionStats();

  // ── Plan 04-04 RPT-03 — three export formats: CSV (oddiy), XLSX (real
  // Excel via exceljs), 1C-Bukhgalteriya CSV with bank-export shape. All
  // three use credentials:include per Phase 1 cookie auth, role-gated
  // server-side to SUPER_ADMIN / BUXGALTER (RolesGuard).

  // Blob downloads — the raw axios instance carries the Bearer token via its
  // request interceptor (and gets 401→refresh→retry). `path` is BARE; the
  // axios baseURL already includes `<origin>/api`.
  const downloadBlob = async (path: string, filename: string) => {
    try {
      const r = await axiosClient.get(path, { responseType: "blob" });
      const objUrl = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(objUrl);
    } catch (err: unknown) {
      console.error("Export muvaffaqiyatsiz:", err);
    }
  };

  const exportCsv = async () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    await downloadBlob(
      `/invoices/export/csv?${params}`,
      `toluvlar-${dateFrom}-${dateTo}.csv`,
    );
  };

  const exportXlsx = async () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    await downloadBlob(
      `/invoices/export/xlsx?${params}`,
      `payments-${dateFrom}-${dateTo}.xlsx`,
    );
  };

  const export1c = async () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    await downloadBlob(
      `/invoices/export/1c?${params}`,
      `payments-1c-${dateFrom}-${dateTo}.csv`,
    );
  };

  const downloadInvoicePdf = async (id: string) => {
    await downloadBlob(`/invoices/${id}/pdf`, `faktura-${id.slice(-8)}.pdf`);
  };

  return (
    <DashboardPage className="max-w-7xl">
      {/* Header — PageHeader o'zi flex-wrap: 375px da sana va eksport
          tugmalari sarlavha ostiga tushadi, yon scroll chiqmaydi. */}
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.payment}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label={t("dateFrom")}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2 border border-line rounded-lg text-sm"
            />
            <span className="text-slate-400" aria-hidden="true">—</span>
            <input
              type="date"
              aria-label={t("dateTo")}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2 border border-line rounded-lg text-sm"
            />
            <button
              onClick={exportXlsx}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700"
              title={t("export.xlsxTitle")}
            >
              <Icon.download aria-hidden="true" size={ICON_SIZE.sm} />
              {t("export.xlsx")}
            </button>
            <button
              onClick={exportCsv}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700"
              title={t("export.csvTitle")}
            >
              <Icon.download aria-hidden="true" size={ICON_SIZE.sm} />
              {t("export.csv")}
            </button>
            <button
              onClick={export1c}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium hover:bg-amber-700"
              title={t("export.oneCTitle")}
            >
              <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
              {t("export.oneC")}
            </button>
          </div>
        }
      />

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto bg-surface-sunken p-1 rounded-xl max-w-full">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === tb.id ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {(() => { const TabIcon = tb.icon; return <TabIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={tab === tb.id ? 2.2 : 1.75} />; })()}
            {t(`tabs.${tb.id}`)}
          </button>
        ))}
      </div>

      {/* ── Tab: Overview ── */}
      {tab === "overview" && (
        statsLoading ? (
          <div className="space-y-6">
            <SkeletonStatGrid />
            <SkeletonChart />
          </div>
        ) : statsError ? (
          <ErrorState
            title={t("errors.statsTitle")}
            message={t("errors.statsMsg")}
            onRetry={() => refetchStats()}
            isRetrying={statsRefetching}
          />
        ) : (
          <div className="space-y-6">
            {/* KPI Cards */}
            <StatGrid cols={4}>
              <StatCard
                icon={Icon.payment}
                label={t("kpi.totalRevenue")}
                value={formatSum(stats?.totalRevenue ?? 0)}
                tone="blue"
              />
              <StatCard
                icon={Icon.document}
                label={t("kpi.totalInvoices")}
                value={stats?.totalInvoices ?? 0}
                tone="gray"
              />
              <StatCard
                icon={Icon.success}
                label={t("kpi.paidInvoices")}
                value={stats?.paidInvoices ?? 0}
                tone="green"
              />
              <StatCard
                icon={Icon.pending}
                label={t("kpi.pendingInvoices")}
                value={stats?.pendingInvoices ?? 0}
                tone="amber"
              />
            </StatGrid>

            {/* Oylik trend */}
            <Panel title={t("charts.monthlyTrend")} icon={Icon.trendUp} noReveal>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={stats?.monthlyTrend ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => t("sum.mlnShort", { value: (v / 1_000_000).toFixed(0) })} />
                  <Tooltip
                    formatter={(v: number) => [formatSum(v), t("charts.revenue")]}
                    labelFormatter={(l) => t("charts.monthLabel", { month: String(l) })}
                  />
                  <Line
                    type="monotone"
                    dataKey="amount"
                    stroke="var(--color-brand-600)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            {/* To'lov usuli bo'yicha */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title={t("charts.byMethod")} icon={Icon.payment} noReveal>
                {(stats?.byMethod ?? []).length === 0 ? (
                  <div className="h-[200px] flex flex-col items-center justify-center text-center text-slate-400 text-sm">
                    <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon.payment aria-hidden="true" size={ICON_SIZE.md} /></span>
                    {t("charts.noPayments")}
                    <span className="text-xs mt-1">{t("charts.noPaymentsHint")}</span>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats?.byMethod ?? []} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                      <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={(v) => t("sum.mlnShort", { value: (v / 1_000_000).toFixed(0) })} />
                      <YAxis type="category" dataKey="method" tick={{ fontSize: 12 }}
                        tickFormatter={(v) => methodLabels[v] ?? v} />
                      <Tooltip formatter={(v: number) => formatSum(v)} />
                      <Bar dataKey="amount" fill="var(--color-brand-500)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel title={t("charts.subStatus")} icon={Icon.checklist} noReveal>
                {subStatsLoading ? (
                  <SkeletonText lines={5} />
                ) : subStatsError ? (
                  <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-center text-sm text-slate-400">
                    {t("charts.subStatsError")}
                    <button
                      type="button"
                      onClick={() => refetchSubStats()}
                      className="rounded-md border border-line-strong bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-surface-muted"
                    >
                      {t("retry")}
                    </button>
                  </div>
                ) : (subStats?.byStatus ?? []).length === 0 ? (
                  <div className="flex h-[200px] flex-col items-center justify-center text-center text-sm text-slate-400">
                    {t("charts.noSubs")}
                    <span className="text-xs mt-1">{t("charts.noSubsHint")}</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {(subStats?.byStatus ?? []).map((s) => {
                      const total = (subStats?.byStatus ?? []).reduce((acc, x) => acc + x.count, 0);
                      const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
                      return (
                        <BarRow
                          key={s.status}
                          label={label(SUBSCRIPTION_STATUS_LABELS, s.status)}
                          value={t("charts.countPct", { count: s.count, pct })}
                          pct={pct}
                          color={SUB_STATUS_BAR_COLORS[s.status] ?? "bg-gray-400"}
                        />
                      );
                    })}
                  </div>
                )}
              </Panel>
            </div>
          </div>
        )
      )}

      {/* ── Tab: Fakturalar ── */}
      {tab === "invoices" && (
        <div>
          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={invoiceStatus}
              onChange={(e) => { setInvoiceStatus(e.target.value); setInvoicePage(1); }}
              aria-label={t("invoicesTab.filterAria")}
              className="px-3 py-2 border border-line rounded-lg text-sm"
            >
              <option value="">{t("invoicesTab.allStatuses")}</option>
              <option value="PENDING">{t("invoiceStatus.pending")}</option>
              <option value="PAID">{t("invoiceStatus.paid")}</option>
              <option value="FAILED">{t("invoiceStatus.failed")}</option>
              <option value="REFUNDED">{t("invoiceStatus.refunded")}</option>
            </select>
            <span className="text-sm text-slate-400 self-center">
              {t("invoicesTab.totalCount", { count: invoicesData?.total ?? 0 })}
            </span>
          </div>

          {invoicesLoading ? (
            <SkeletonTable rows={5} columns={8} />
          ) : invoicesError ? (
            <ErrorState
              title={t("errors.invoicesTitle")}
              message={t("errors.invoicesMsg")}
              onRetry={() => refetchInvoices()}
              isRetrying={invoicesRefetching}
            />
          ) : (
            <>
              <div className="card-surface rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.code")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.library")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.plan")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.amount")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.due")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.method")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("invoicesTab.status")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">
                        <span className="sr-only">{t("invoicesTab.actions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoicesData?.invoices ?? []).map((inv) => (
                      <tr key={inv.id} className="border-t border-line hover:bg-surface-muted">
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">
                          #{inv.id.slice(-8).toUpperCase()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{inv.subscription.library.name}</div>
                          <div className="text-xs text-slate-400">
                            {label(LIBRARY_TYPE_LABELS, inv.subscription.library.type)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs">
                          {label(PLAN_LABELS, inv.subscription.planType)}
                        </td>
                        <td className="px-4 py-3 font-semibold">
                          {t("sum.plain", { value: fmtNumber(Number(inv.amount)) })}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          <div>{new Date(inv.dueDate).toLocaleDateString("uz-UZ")}</div>
                          {inv.paidDate && (
                            <div className="text-xs text-green-600">
                              {t("invoicesTab.paidOn", { date: new Date(inv.paidDate).toLocaleDateString("uz-UZ") })}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-sm">
                          {inv.paymentMethod ? methodLabels[inv.paymentMethod] ?? inv.paymentMethod : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={inv.status} />
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => downloadInvoicePdf(inv.id)}
                            className="text-brand-600 hover:text-blue-800 text-xs"
                            title={t("invoicesTab.pdfTitle")}
                          >
                            <span className="inline-flex items-center gap-1"><Icon.document aria-hidden="true" size={ICON_SIZE.xs} />PDF</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                    {(invoicesData?.invoices ?? []).length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                          {t("invoicesTab.empty")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination — oxirgi sahifa aniqligi total bo'yicha: 20 talik
                  to'liq sahifadan keyin bo'sh sahifa ochilmaydi. */}
              <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
                <span>{t("totalLabel", { count: invoicesData?.total ?? 0 })}</span>
                <div className="flex gap-2">
                  <button
                    disabled={invoicePage === 1}
                    onClick={() => setInvoicePage((p) => p - 1)}
                    className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  >
                    {t("pagination.prev")}
                  </button>
                  <span className="px-3 py-1.5">{invoicePage}</span>
                  <button
                    disabled={invoicePage * 20 >= (invoicesData?.total ?? 0)}
                    onClick={() => setInvoicePage((p) => p + 1)}
                    className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  >
                    {t("pagination.next")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Obunalar ── */}
      {tab === "subscriptions" && (
        <SubscriptionsTab />
      )}
    </DashboardPage>
  );
}

// ── SubscriptionsTab ───────────────────────────────────────────────────────────

function SubscriptionsTab() {
  const t = useTranslations("BuxgalterPanel");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["subscriptions-list", status, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) params.set("status", status);
      const r = await apiClient(`/subscriptions?${params}`);
      if (!r.ok) throw new Error("Obunalar yuklanmadi");
      return r.json() as Promise<{ subscriptions: SubscriptionRow[]; total: number }>;
    },
    staleTime: 60_000,
  });

  const STATUS_COLORS: Record<string, string> = {
    TRIAL: "bg-brand-100 text-brand-700",
    ACTIVE: "bg-green-100 text-green-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    FROZEN: "bg-surface-sunken text-slate-600",
    DELETED: "bg-red-100 text-red-700",
  };

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          aria-label={t("subsTab.filterAria")}
          className="px-3 py-2 border border-line rounded-lg text-sm"
        >
          <option value="">{t("subsTab.all")}</option>
          <option value="TRIAL">{t("subsTab.trial")}</option>
          <option value="ACTIVE">{t("subsTab.active")}</option>
          <option value="PENDING">{t("subsTab.pending")}</option>
          <option value="FROZEN">{t("subsTab.frozen")}</option>
        </select>
        <span className="text-sm text-slate-400 self-center">{t("subsTab.countShort", { count: data?.total ?? 0 })}</span>
      </div>

      {isLoading ? (
        <SkeletonTable rows={5} columns={7} />
      ) : isError ? (
        <ErrorState
          title={t("errors.subsTitle")}
          message={t("errors.subsMsg")}
          onRetry={() => refetch()}
          isRetrying={isRefetching}
        />
      ) : (
        <>
          <div className="card-surface rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.library")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.type")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.plan")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.start")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.end")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.lastInvoice")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("subsTab.status")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.subscriptions ?? []).map((sub) => (
                  <tr key={sub.id} className="border-t border-line hover:bg-surface-muted">
                    <td className="px-4 py-3">
                      <div className="font-medium">{sub.library.name}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {label(LIBRARY_TYPE_LABELS, sub.library.type)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {label(PLAN_LABELS, sub.planType)}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(sub.startDate).toLocaleDateString("uz-UZ")}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(sub.endDate).toLocaleDateString("uz-UZ")}
                    </td>
                    <td className="px-4 py-3">
                      {sub.invoices?.[0] ? (
                        <div>
                          <div className="text-xs">
                            {t("sum.plain", { value: fmtNumber(Number(sub.invoices[0].amount)) })}
                          </div>
                          <div className={`text-xs mt-0.5 ${
                            sub.invoices[0].status === "PAID" ? "text-green-600" : "text-yellow-600"
                          }`}>
                            {sub.invoices[0].status === "PAID" ? t("invoiceStatus.paid") : t("invoiceStatus.pending")}
                          </div>
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        STATUS_COLORS[sub.status] ?? "bg-surface-sunken text-slate-600"
                      }`}>
                        {label(SUBSCRIPTION_STATUS_LABELS, sub.status)}
                      </span>
                    </td>
                  </tr>
                ))}
                {(data?.subscriptions ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                      {t("subsTab.empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
            <span>{t("totalLabel", { count: data?.total ?? 0 })}</span>
            <div className="flex gap-2">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
              >{t("pagination.prev")}</button>
              <span className="px-3 py-1.5">{page}</span>
              <button
                disabled={page * 20 >= (data?.total ?? 0)}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
              >{t("pagination.next")}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
