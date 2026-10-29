"use client";

import { useQuery } from "@tanstack/react-query";
import { fmtNumber } from "@/lib/format";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/store/auth.store";
import { authApi } from "@/lib/api/auth";
import {
  fetchStoreProfile,
  fetchStoreCrm,
} from "@/lib/api/store";
import MonthlySalesChart from "@/components/store/MonthlySalesChart";
import { CountUp } from "@/components/landing/CountUp";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { StatGrid, StatCard } from "@/components/dashboard/ui";
import { EmptyState } from "@/components/ui/empty-state";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StoreDashboardPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const { locale, slug } = params;
  const t = useTranslations("DokonDash");
  const router = useRouter();
  const { user, isAuthenticated, logout } = useAuthStore();

  // Yorliqlar lokalga bog'liq ("so'm"/"soat" va h.k.) — tarjimadan olinadi.
  const formatPrice = (price: number | null): string =>
    price == null ? "—" : t("priceSum", { price: fmtNumber(price) });

  const formatDuration = (hours: number): string => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h === 0) return t("durationMinutes", { m: String(m) });
    if (m === 0) return t("durationHours", { h: String(h) });
    return t("durationBoth", { h: String(h), m: String(m) });
  };

  const handleLogout = async () => {
    await authApi.logout().catch(() => {});
    logout();
    router.replace(`/${locale}/login`);
  };

  // Fetch store profile first to get storeId
  const {
    data: store,
    // isPending — oflayn-pauza holatini ham qamraydi (isLoading u paytda false).
    isPending: storeLoading,
    isError: storeError,
  } = useQuery({
    queryKey: ["store-profile", slug],
    queryFn: () => fetchStoreProfile(slug),
  });

  // Fetch CRM data using storeId
  const {
    data: crm,
    isPending: crmPending,
    isError: crmError,
  } = useQuery({
    queryKey: ["store-crm", store?.id],
    queryFn: () => fetchStoreCrm(store!.id),
    enabled: !!store?.id,
  });
  // O'chiq (enabled=false) so'rov ham isPending=true bo'ladi — store xatosida
  // abadiy "yuklanmoqda"da qolmaslik uchun faqat yoqilganda hisoblaymiz.
  const crmLoading = !!store?.id && crmPending;

  // ── Auth guard ──
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-800 mb-2">
            {t("loginRequired")}
          </h1>
          <p className="text-slate-500 mb-4">
            {t("loginMessage")}
          </p>
          <Link
            href={`/${locale}/login`}
            className="px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
          >
            {t("login")}
          </Link>
        </div>
      </div>
    );
  }

  const isAuthorized =
    user?.role === "DOKON_OPERATOR" || user?.role === "SUPER_ADMIN";

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-red-700 mb-2">{t("noAccess")}</h1>
          <p className="text-slate-500">
            {t("operatorsOnly")}
          </p>
        </div>
      </div>
    );
  }

  // Loading
  if (storeLoading || crmLoading) {
    return (
      <div className="min-h-screen bg-surface-muted">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="animate-pulse space-y-6">
            <div className="h-8 bg-surface-sunken rounded w-64" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-28 bg-surface-sunken rounded-lg" />
              ))}
            </div>
            <div className="h-[400px] bg-surface-sunken rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  // Error
  if (storeError || crmError || !store || !crm) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-800 mb-2">
            {t("loadErrorTitle")}
          </h1>
          <p className="text-slate-500">{t("loadErrorMessage")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-muted">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-3">
              {t("title")}
              {store.premiumBadge && (
                <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-300 text-amber-800 text-xs font-bold px-2 py-0.5 rounded-full">
                  <Icon.star aria-hidden="true" size={ICON_SIZE.xs} className="text-accent-500" />
                  {t("premium")}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500 mt-1">{store.name}</p>
          </div>
          {/* Bitta asosiy amal (Sotuv) brand rangda, qolganlari outline —
              uch xil gradient o'rniga aniq ierarxiya. */}
          <div className="flex items-center gap-3 flex-wrap">
            <Link
              href={`/${locale}/dokon/${slug}/sell`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-brand-600 text-white hover:bg-brand-700"
            >
              <Icon.payment aria-hidden="true" size={ICON_SIZE.sm} />
              {t("sell")}
            </Link>
            <Link
              href={`/${locale}/dokon/${slug}/products`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-line bg-white text-slate-700 hover:bg-surface-muted"
            >
              <Icon.library aria-hidden="true" size={ICON_SIZE.sm} />
              {t("catalog")}
            </Link>
            <Link
              href={`/${locale}/dokon/${slug}/settings`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-line bg-white text-slate-700 hover:bg-surface-muted"
            >
              <Icon.settings aria-hidden="true" size={ICON_SIZE.sm} />
              {t("settings")}
            </Link>
            <Link
              href={`/${locale}/dokon/${slug}`}
              className="text-sm text-brand-600 hover:underline"
            >
              {t("backToProfile")}
            </Link>
            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-red-200 bg-white text-red-600 hover:bg-red-50"
            >
              <Icon.logout aria-hidden="true" size={ICON_SIZE.sm} />
              {t("logout")}
            </button>
          </div>
        </div>

        {/* ── 4 metric cards ── */}
        <StatGrid>
          <StatCard
            icon={Icon.readers}
            label={t("totalCustomers")}
            value={crm.totalCustomers}
            tone="blue"
          />
          <StatCard
            icon={Icon.trendUp}
            label={t("newThisMonth")}
            value={crm.newThisMonth}
            tone="green"
          />
          <StatCard
            icon={Icon.refresh}
            label={t("returning")}
            value={crm.returningCustomers}
            tone="violet"
          />
          <StatCard
            icon={Icon.stats}
            label={t("conversion")}
            value={`${crm.conversionRate}%`}
            tone="amber"
          />
        </StatGrid>

        {/* ── Obuna / Tarif (partnership — free) ── */}
        <div className="rounded-2xl border border-line bg-white p-6 shadow-[0_10px_40px_-18px_rgba(37,99,235,0.30)]">
          <div className="flex items-center gap-3 mb-5">
            <span className="h-10 w-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
              <Icon.partnership aria-hidden="true" size={ICON_SIZE.md} />
            </span>
            <h2 className="text-lg font-bold text-slate-900">{t("subscription")}</h2>
          </div>

          <p className="text-xl font-bold text-slate-900 flex flex-wrap items-center gap-2">
            {t("partnershipFree")}
            <span className="bg-green-100 text-green-700 px-2.5 py-0.5 rounded-full text-xs font-bold">
              {t("noPayment")}
            </span>
          </p>

          <p className="text-sm text-slate-600 mt-3 leading-relaxed">
            {t("partnershipText")}
          </p>
        </div>

        {/* ── Monthly sales chart ── */}
        <Card>
          <CardHeader>
            <CardTitle>{t("monthlyTrend")}</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlySalesChart data={crm.monthlyTrend} />
          </CardContent>
        </Card>

        {/* ── Top-selling books table ── */}
        <Card>
          <CardHeader>
            <CardTitle>{t("topBooks")}</CardTitle>
          </CardHeader>
          <CardContent>
            {crm.topBooks.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th className="py-3 pr-4 font-medium text-slate-500 w-12">
                        #
                      </th>
                      <th className="py-3 pr-4 font-medium text-slate-500">
                        {t("thTitle")}
                      </th>
                      <th className="py-3 pr-4 font-medium text-slate-500">
                        {t("thAuthor")}
                      </th>
                      <th className="py-3 pr-4 font-medium text-slate-500 text-right">
                        {t("thSold")}
                      </th>
                      <th className="py-3 font-medium text-slate-500 text-right">
                        {t("thPrice")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {crm.topBooks.map((book, idx) => (
                      <tr
                        key={book.isbn ?? idx}
                        className="border-b border-line last:border-0"
                      >
                        <td className="py-3 pr-4 text-slate-400 font-mono">
                          {idx + 1}
                        </td>
                        <td className="py-3 pr-4 font-medium text-slate-900">
                          {book.title}
                        </td>
                        <td className="py-3 pr-4 text-slate-500">
                          {book.author}
                        </td>
                        <td className="py-3 pr-4 text-right font-semibold text-slate-900">
                          {book.salesCount}
                        </td>
                        <td className="py-3 text-right text-slate-600">
                          {formatPrice(book.price)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={Icon.package}
                title={t("noSalesTitle")}
                description={t("noSalesDescription")}
                action={
                  <Link
                    href={`/${locale}/dokon/${slug}/sell`}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    <Icon.payment aria-hidden="true" size={ICON_SIZE.sm} />
                    {t("recordSale")}
                  </Link>
                }
              />
            )}
          </CardContent>
        </Card>

        {/* ── Conversion details ── */}
        <Card>
          <CardHeader>
            <CardTitle>{t("conversionDetails")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <p className="text-sm text-slate-500 mb-1">
                  {t("avgConfirmTime")}
                </p>
                <p className="text-xl font-bold text-slate-900">
                  {formatDuration(crm.avgConfirmationTimeHours)}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-500 mb-1">
                  {t("expiredScans")}
                </p>
                <p className="text-xl font-bold text-slate-900 flex items-center gap-2">
                  <CountUp value={crm.expiredScans} className="tabular-nums" />
                  {crm.expiredScans > 0 && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                      {t("attention")}
                    </span>
                  )}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
