"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  fetchStoreProfile,
  fetchStoreProducts,
  searchStoreProducts,
  type StoreProductItem,
  type StoreProductSearchParams,
  type StoreProductSearchResult,
} from "@/lib/api/store";
import { useAuthStore } from "@/store/auth.store";
import StoreProductCard from "@/components/store/StoreProductCard";
import StoreMap from "@/components/store/StoreMap";
import { Card, CardContent } from "@/components/ui/card";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

// Kun kalitlari — qisqa (mon) va to'liq (monday) shakllarni kanonik kalitga
// keltiradi; yorliq tarjima faylidan (DokonProfile.days.*) olinadi.
const DAY_KEYS: Record<string, string> = {
  monday: "monday",
  tuesday: "tuesday",
  wednesday: "wednesday",
  thursday: "thursday",
  friday: "friday",
  saturday: "saturday",
  sunday: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StoreProfilePage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const { locale, slug } = params;
  const t = useTranslations("DokonProfile");
  const getDayLabel = (day: string): string => {
    const key = DAY_KEYS[day.toLowerCase()];
    return key ? t(`days.${key}`) : day;
  };
  const user = useAuthStore((s) => s.user);
  const isOperator =
    user?.role === "DOKON_OPERATOR" || user?.role === "SUPER_ADMIN";
  const [searchTerm, setSearchTerm] = useState("");
  // Qidiruv server tomonda (GET /store/products/search) — 300ms debounce
  // bilan. Ilgari faqat joriy sahifa filtrlanardi: 40 sahifali do'konda
  // haqiqiy kitob "topilmadi" bo'lib chiqardi.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Qidiruv so'rovi o'zgarganda sahifa 1 ga qaytadi.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const {
    data: store,
    // isPending — oflayn-pauza holatini ham qamraydi (isLoading u paytda false
    // bo'lib, sahifa noto'g'ri "topilmadi" ko'rsatib yuborardi).
    isPending,
    isError,
  } = useQuery({
    queryKey: ["store-profile", slug],
    queryFn: () => fetchStoreProfile(slug),
  });

  const isSearching = debouncedSearch.length > 0;

  // Oddiy rejim: joriy sahifa mahsulotlari.
  const {
    data: productsData,
    isFetching: productsFetching,
    isError: productsError,
    refetch: refetchProducts,
    isRefetching: productsRetrying,
  } = useQuery({
    queryKey: ["store-products", store?.id, page, pageSize],
    queryFn: () => fetchStoreProducts(store!.id, page, pageSize),
    enabled: !!store?.id && !isSearching,
  });

  // Qidiruv rejimi: butun katalog bo'ylab server qidiruvi (shu do'kon ichida).
  const {
    data: searchData,
    isPending: searchLoading,
    isFetching: searchFetching,
    isError: searchError,
    refetch: refetchSearch,
    isRefetching: searchRetrying,
  } = useQuery({
    queryKey: ["store-products-search", store?.id, debouncedSearch, page, pageSize],
    queryFn: () => {
      const searchParams: StoreProductSearchParams & { storeId: string } = {
        q: debouncedSearch,
        storeId: store!.id,
        page,
        limit: pageSize,
      };
      return searchStoreProducts(searchParams);
    },
    enabled: !!store?.id && isSearching,
  });

  // Loading skeleton
  if (isPending) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-slate-400 text-lg">{t("loading")}</div>
      </div>
    );
  }

  // Error / not found
  if (isError || !store) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <Icon.store
            aria-hidden="true"
            size={ICON_SIZE.xl}
            className="mx-auto mb-4 text-slate-300"
          />
          <h1 className="text-2xl font-bold text-slate-800 mb-2">
            {t("notFoundTitle")}
          </h1>
          <p className="text-slate-500 mb-4">{t("notFoundMessage")}</p>
          <Link
            href={`/${locale}/dokon`}
            className="text-brand-600 hover:underline text-sm"
          >
            {t("backToList")}
          </Link>
        </div>
      </div>
    );
  }

  // Ko'rsatiladigan mahsulotlar — rejimga qarab.
  const products: (StoreProductItem | StoreProductSearchResult)[] = isSearching
    ? (searchData?.data ?? [])
    : (productsData?.items ?? store.products ?? []);
  const total = isSearching
    ? (searchData?.total ?? 0)
    : (productsData?.total ?? store.productCount ?? products.length);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const listError = isSearching ? searchError : productsError;
  const listFetching = isSearching ? searchFetching : productsFetching;
  const searchPending = isSearching && searchLoading;

  // Windowed pagination (max 5 numbers)
  const winStart = Math.max(1, Math.min(page - 2, pageCount - 4));
  const winEnd = Math.min(pageCount, winStart + 4);
  const firstOnPage = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastOnPage = Math.min(page * pageSize, total);

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* ── Hero (top bar + store identity) — yaxlit brand fon ── */}
      <div className="relative overflow-hidden bg-brand-700 text-white">
        {/* yumshoq dekorativ doiralar */}
        <div className="pointer-events-none absolute -top-20 -right-10 w-72 h-72 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-6 w-80 h-80 rounded-full bg-white/5 blur-3xl" />

        <div className="relative max-w-5xl mx-auto px-4 pt-4 pb-9">
          {/* Top bar */}
          <div className="flex items-center justify-between">
            <Link
              href={`/${locale}/dokon`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white/90 hover:text-white bg-white/10 hover:bg-white/20 rounded-full px-3.5 py-1.5 backdrop-blur-sm transition"
            >
              {t("back")}
            </Link>
            {isOperator && (
              <div className="flex items-center gap-2">
                <Link
                  href={`/${locale}/dokon/${slug}/dashboard`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-white/90 hover:text-white bg-white/10 hover:bg-white/20 rounded-full px-3.5 py-1.5 backdrop-blur-sm transition"
                >
                  <Icon.stats aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("panel")}
                </Link>
                <Link
                  href={`/${locale}/dokon/${slug}/settings`}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 bg-white hover:bg-blue-50 rounded-full px-3.5 py-1.5 shadow-sm transition"
                >
                  <Icon.settings aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("settings")}
                </Link>
              </div>
            )}
          </div>

          {/* Store identity */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-5 mt-8">
            <div className="w-20 h-20 rounded-3xl bg-white/15 ring-1 ring-white/30 backdrop-blur-sm flex items-center justify-center shrink-0 overflow-hidden shadow-lg">
              {store.logoUrl ? (
                <img src={store.logoUrl} alt={store.name} className="w-20 h-20 object-cover" />
              ) : (
                <Icon.store aria-hidden="true" size={ICON_SIZE.xl} className="text-white" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">{store.name}</h1>
                {store.premiumBadge && (
                  <span className="inline-flex items-center gap-1.5 bg-amber-300 text-amber-900 text-xs font-bold px-3 py-1 rounded-full shadow">
                    <Icon.star aria-hidden="true" size={ICON_SIZE.xs} />
                    {t("premiumPartner")}
                  </span>
                )}
              </div>

              {store.description && (
                <p className="text-white/85 mt-2 max-w-xl">{store.description}</p>
              )}

              <div className="flex flex-wrap gap-2.5 mt-4">
                {store.address && (
                  <span className="inline-flex items-center gap-1.5 text-sm bg-white/15 ring-1 ring-white/20 rounded-full px-3 py-1.5 backdrop-blur-sm">
                    <Icon.map aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                    {store.address}
                  </span>
                )}
                {store.phone && (
                  <a
                    href={`tel:${store.phone}`}
                    className="inline-flex items-center gap-1.5 text-sm bg-white/15 ring-1 ring-white/20 hover:bg-white/25 rounded-full px-3 py-1.5 backdrop-blur-sm transition"
                  >
                    <Icon.phone aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                    {store.phone}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Map + Working Hours grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Map */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">
              {t("location")}
            </h2>
            <StoreMap
              lat={store.lat ?? null}
              lon={store.lon ?? null}
              name={store.name}
              address={store.address}
            />
          </div>

          {/* Working hours */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-3">
              {t("workingHours")}
            </h2>
            <Card>
              <CardContent className="p-4">
                {store.workingHours &&
                Object.keys(store.workingHours).length > 0 ? (
                  <table className="w-full text-sm">
                    <tbody>
                      {Object.entries(store.workingHours).map(
                        ([day, hours]) => (
                          <tr
                            key={day}
                            className="border-b border-line last:border-0"
                          >
                            <td className="py-2 font-medium text-slate-700">
                              {getDayLabel(day)}
                            </td>
                            <td className="py-2 text-right text-slate-500">
                              {hours || t("dayOff")}
                            </td>
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-slate-400 text-sm py-4 text-center">
                    {t("hoursNotSet")}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ── Product catalog ── */}
        <div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-semibold text-slate-900">
              {t("books")}{" "}
              <span className="text-slate-400 font-normal">({total})</span>
            </h2>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                aria-label={t("searchBookAria")}
                placeholder={t("searchBookPlaceholder")}
                className="w-full sm:w-64 border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">{t("perPage")}</span>
                {[20, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => {
                      setPageSize(n);
                      setPage(1);
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium ${
                      pageSize === n
                        ? "bg-brand-600 text-white"
                        : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {listError ? (
            <ErrorState
              title={t("booksErrorTitle")}
              message={t("booksErrorMessage")}
              onRetry={() => (isSearching ? refetchSearch() : refetchProducts())}
              isRetrying={isSearching ? searchRetrying : productsRetrying}
            />
          ) : searchPending ? (
            // Qidiruv natijasi kelguncha karta skeletlari.
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-white rounded-xl border border-line overflow-hidden">
                  <Skeleton className="aspect-[3/4] w-full rounded-none" />
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : products.length > 0 ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {products.map((product) => (
                  <StoreProductCard
                    key={product.id}
                    isbn={product.isbn}
                    title={product.title}
                    author={product.author}
                    price={product.price}
                    stockCount={product.stockCount}
                    coverUrl={product.coverUrl}
                    premiumBadge={store.premiumBadge}
                  />
                ))}
              </div>

              {/* Pagination — qidiruvda ham ishlaydi (server tomonda sahifalanadi) */}
              {pageCount > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6">
                  <div className="text-xs text-slate-500">
                    {firstOnPage}–{lastOnPage} / {total}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1 || listFetching}
                      aria-label={t("prevPage")}
                      className="h-9 w-9 inline-flex items-center justify-center card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40"
                    >
                      <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
                    </button>
                    {Array.from(
                      { length: winEnd - winStart + 1 },
                      (_, i) => winStart + i
                    ).map((n) => (
                      <button
                        key={n}
                        onClick={() => setPage(n)}
                        className={`h-9 min-w-9 px-3 rounded-xl text-sm font-medium ${
                          n === page
                            ? "bg-brand-600 text-white"
                            : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        setPage((p) => Math.min(pageCount, p + 1))
                      }
                      disabled={page >= pageCount || listFetching}
                      aria-label={t("nextPage")}
                      className="h-9 w-9 inline-flex items-center justify-center card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40"
                    >
                      <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12 text-slate-400 text-sm">
              {isSearching ? t("noResults") : t("noBooks")}
            </div>
          )}
        </div>

        {/* ── Footer badge ── */}
        <div className="text-center py-6 border-t border-line">
          <span className="inline-flex items-center gap-2 text-xs text-slate-400">
            <Icon.book aria-hidden="true" size={ICON_SIZE.sm} />
            {t("partnerBadge")}
          </span>
          <span className="block mt-2">
            <Link
              href={`/${locale}/dokon`}
              className="text-xs text-brand-600 hover:underline"
            >
              {t("allStores")}
            </Link>
          </span>
        </div>
      </div>
    </div>
  );
}
