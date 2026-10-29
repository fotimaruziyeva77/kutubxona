"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { listStores } from "@/lib/api/store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState, NoResultsState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

// Ommaviy "Kitob do'konlari" katalogi — har kim ko'ra oladi. Kartani bossa
// do'kon profiliga (/dokon/[slug]) o'tadi. (Operator sotuv kabineti endi
// /dokon/[slug]/sell da — bu sahifa endi sotuv jarayoni EMAS, ro'yxat.)
export default function StoresDirectoryPage({
  params,
}: {
  params: { locale: string };
}) {
  const { locale } = params;
  const t = useTranslations("DokonDir");
  const [q, setQ] = useState("");

  const {
    data: stores = [],
    // isLoading EMAS: oflayn-pauza holatida isLoading=false bo'lib, xato ham,
    // ma'lumot ham yo'g'ida "do'konlar yo'q" yolg'oni chiqardi. isPending
    // ma'lumot kelmaguncha (pauza bilan birga) skeletonni ushlab turadi.
    isPending,
    isError,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ["stores-directory"],
    queryFn: listStores,
    staleTime: 60_000,
  });

  const filtered = q
    ? stores.filter(
        (s) =>
          s.name.toLowerCase().includes(q.toLowerCase()) ||
          (s.address ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : stores;

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Hero — yaxlit brand fon (dizayn tili: gradient EMAS) */}
      <div className="relative overflow-hidden bg-brand-700 text-white">
        <div className="pointer-events-none absolute -top-20 -right-10 w-72 h-72 rounded-full bg-white/10 blur-3xl" />
        <div className="relative max-w-5xl mx-auto px-4 py-10">
          <Link href={`/${locale}`} className="text-sm text-white/80 hover:text-white">{t("backHome")}</Link>
          <h1 className="flex items-center gap-2.5 text-3xl sm:text-4xl font-extrabold tracking-tight mt-3">
            <Icon.store aria-hidden="true" size={ICON_SIZE.xl} />
            {t("title")}
          </h1>
          <p className="text-white/85 mt-2">
            {t("subtitle")}
          </p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            type="search"
            aria-label={t("searchAria")}
            placeholder={t("searchPlaceholder")}
            className="mt-5 w-full max-w-md bg-white/95 text-slate-900 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-500 placeholder:text-slate-400"
          />
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8">
        {isPending ? (
          // Skeleton — karta shakli oldindan ko'rinadi, layout sakramaydi.
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-line p-5">
                <div className="flex items-center gap-3">
                  <Skeleton className="w-12 h-12 rounded-xl shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-14" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title={t("errorTitle")}
            message={t("errorMessage")}
            onRetry={() => refetch()}
            isRetrying={isRefetching}
          />
        ) : filtered.length === 0 ? (
          q ? (
            <NoResultsState query={q} onReset={() => setQ("")} />
          ) : (
            <EmptyState
              icon={Icon.store}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
            />
          )
        ) : (
          <>
            <p className="text-sm text-slate-500 mb-4">{t("storeCount", { count: String(filtered.length) })}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((s) => (
                <Link
                  key={s.id}
                  href={`/${locale}/dokon/${s.slug}`}
                  className={`group bg-white rounded-2xl border p-5 hover:shadow-lg hover:-translate-y-0.5 transition-all ${
                    s.premiumBadge ? "border-amber-300 ring-1 ring-amber-200" : "border-line"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {s.logoUrl ? (
                      <img src={s.logoUrl} alt="" className="w-12 h-12 rounded-xl object-cover border border-line" />
                    ) : (
                      <span className="w-12 h-12 rounded-xl bg-brand-600 text-white flex items-center justify-center shrink-0">
                        <Icon.store aria-hidden="true" size={ICON_SIZE.md} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-bold text-slate-900 truncate">{s.name}</h3>
                        {s.premiumBadge && (
                          <Icon.star aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0 text-accent-500" />
                        )}
                      </div>
                      {s.address && <p className="text-xs text-slate-500 truncate">{s.address}</p>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-4 text-sm">
                    <span className="text-slate-500">{t("bookCount", { count: String(s.productCount) })}</span>
                    <span className="text-brand-600 font-medium group-hover:underline">{t("view")}</span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
