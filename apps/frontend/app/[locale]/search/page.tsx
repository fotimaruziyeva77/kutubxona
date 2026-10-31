"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  searchBooks,
  getNearbyLibraries,
  getLibrary,
  type Book,
  type NearbyLibrary,
} from "@/lib/api/libraries";
import SearchLoading from "./loading";
import { searchStoreProducts, type StoreProductSearchResult } from "@/lib/api/store";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";

// A library book result carries a libraryId on every search path (Elasticsearch
// and the Prisma fallback). The `library` object — and its human code — only
// rides along on the Prisma-fallback path, so treat `code` as optional and
// always fall back to libraryId when building the detail-page link. The library
// detail route (/[locale]/library/[code]) resolves either a code or a raw id.
function libraryHref(locale: string, book: Book): string | null {
  // `library` is typed as { id; name } but the Prisma-fallback payload also
  // includes `code` at runtime; read it defensively without widening the shared
  // type, then fall back to the always-present libraryId.
  const code = (book.library as { code?: string } | undefined)?.code;
  const codeOrId = code ?? book.libraryId;
  return codeOrId ? `/${locale}/library/${encodeURIComponent(codeOrId)}` : null;
}

/**
 * Janr chiplari: `value` — bazadagi (o'zbekcha) filtr qiymati, backendga
 * AYNAN shu ketadi; `key` — ko'rsatiladigan yorliq tarjima kaliti.
 */
const GENRES: { value: string; key: string }[] = [
  { value: "", key: "all" },
  { value: "Roman", key: "roman" },
  { value: "Ilmiy", key: "ilmiy" },
  { value: "Bolalar", key: "bolalar" },
  { value: "Tarix", key: "tarix" },
  { value: "Texnika", key: "texnika" },
  { value: "Falsafa", key: "falsafa" },
  { value: "Epik", key: "epik" },
  { value: "She'riyat", key: "sheriyat" },
];
const LANGS = [
  { code: "", key: "all" },
  { code: "uz", key: "uz" },
  { code: "ru", key: "ru" },
  { code: "en", key: "en" },
] as const;

type ViewTab = "all" | "libraries" | "stores";

const PRICE_PRESETS = [
  { key: "all", min: undefined, max: undefined },
  { key: "under30", min: undefined, max: 30000 },
  { key: "mid", min: 30000, max: 60000 },
  { key: "over60", min: 60000, max: undefined },
] as const;

function formatPrice(price: number, unit: string): string {
  return new Intl.NumberFormat("uz-UZ").format(price) + " " + unit;
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

/**
 * useSearchParams() Next 14 da statik sahifada Suspense chegarasini talab
 * qiladi — aks holda build "Missing Suspense boundary with useSearchParams"
 * bilan yiqiladi. Fallback — mavjud skelet (loading.tsx).
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<SearchLoading />}>
      <SearchPageInner />
    </Suspense>
  );
}

function SearchPageInner() {
  const locale = useLocale();
  const t = useTranslations("ReaderSearch");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Landing, kitobxon bosh sahifasi va tavsiyalar `?q=` bilan, kutubxona
  // sahifasining "To'liq katalog" havolasi `?libraryId=` bilan yuboradi.
  // Avval ikkalasi ham o'qilmasdi — foydalanuvchi bo'sh qidiruvga tushardi.
  const qParam = searchParams.get("q") ?? "";
  const libraryIdParam = searchParams.get("libraryId") ?? "";
  const [query, setQuery] = useState(qParam);
  const [genre, setGenre] = useState("");
  const [lang, setLang] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [page, setPage] = useState(1);
  const [storePage, setStorePage] = useState(1);
  const [nearbyMode, setNearbyMode] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locError, setLocError] = useState("");
  const [viewTab, setViewTab] = useState<ViewTab>("all");

  // Price filter state
  const [minPrice, setMinPrice] = useState<number | undefined>(undefined);
  const [maxPrice, setMaxPrice] = useState<number | undefined>(undefined);
  const [pricePreset, setPricePreset] = useState(0);


  // URL o'zgarsa (yangi `?q=` bilan qayta kelish) maydon va sahifalash
  // yangilanadi; foydalanuvchi yozganda esa URL tegilmaydi.
  useEffect(() => {
    setQuery(qParam);
    setPage(1);
    setStorePage(1);
  }, [qParam]);

  // Kutubxona bo'yicha cheklov chipi uchun nom.
  const { data: scopedLibrary } = useQuery({
    queryKey: ["library", libraryIdParam],
    queryFn: () => getLibrary(libraryIdParam),
    enabled: Boolean(libraryIdParam),
    staleTime: 300_000,
  });
  const clearLibraryFilter = () => {
    const q = query.trim();
    router.replace(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname);
  };

  const debouncedQuery = useDebounce(query, 400);
  const debouncedMin = useDebounce(minPrice, 300);
  const debouncedMax = useDebounce(maxPrice, 300);

  // ---- Library search ----
  // staleTime: 0 overrides the global 5-minute default (lib/query-client.ts).
  // Without it, revisiting a previously-typed term (which happens constantly
  // while deleting/retyping the box) served a STALE cached result instead of
  // refetching — old book names appeared "stuck" even after changing the query.
  const { data: searchResult, isLoading: searchLoading } = useQuery({
    queryKey: ["books-search", debouncedQuery, genre, lang, onlyAvailable, page, libraryIdParam],
    queryFn: () =>
      searchBooks({
        q: debouncedQuery || undefined,
        genre: genre || undefined,
        lang: lang || undefined,
        libraryId: libraryIdParam || undefined,
        available: onlyAvailable || undefined,
        page,
        limit: 20,
      }),
    enabled: !nearbyMode,
    staleTime: 0,
  });

  // ---- Store product search ----
  const { data: storeResult, isLoading: storeLoading } = useQuery({
    queryKey: [
      "store-search",
      debouncedQuery,
      genre,
      debouncedMin,
      debouncedMax,
      onlyAvailable,
      storePage,
      userLocation,
    ],
    queryFn: () =>
      searchStoreProducts({
        q: debouncedQuery || undefined,
        genre: genre || undefined,
        minPrice: debouncedMin,
        maxPrice: debouncedMax,
        inStock: onlyAvailable || undefined,
        lat: userLocation?.lat,
        lon: userLocation?.lon,
        page: storePage,
        limit: 20,
      }),
    enabled: !nearbyMode,
    staleTime: 0,
  });

  // ---- Nearby libraries ----
  const { data: nearbyLibs = [], isLoading: nearbyLoading } = useQuery({
    queryKey: ["nearby", userLocation, debouncedQuery],
    queryFn: () =>
      getNearbyLibraries(userLocation!.lat, userLocation!.lon, 15, debouncedQuery || undefined),
    enabled: nearbyMode && !!userLocation,
    staleTime: 0,
  });

  // ---- Nearby stores ----
  const { data: nearbyStores, isLoading: nearbyStoresLoading } = useQuery({
    queryKey: ["nearby-stores", userLocation, debouncedQuery],
    queryFn: () =>
      searchStoreProducts({
        q: debouncedQuery || undefined,
        lat: userLocation!.lat,
        lon: userLocation!.lon,
        inStock: true,
        limit: 20,
      }),
    enabled: nearbyMode && !!userLocation,
    staleTime: 0,
  });

  // ---- ISBN comparison map ----
  const isbnMap = useMemo(() => {
    const map = new Map<
      string,
      { library?: Book; store?: StoreProductSearchResult }
    >();
    if (searchResult?.data) {
      for (const b of searchResult.data) {
        if (!b.isbn) continue;
        const entry = map.get(b.isbn) ?? {};
        entry.library = b;
        map.set(b.isbn, entry);
      }
    }
    if (storeResult?.data) {
      for (const s of storeResult.data) {
        if (!s.isbn) continue;
        const entry = map.get(s.isbn) ?? {};
        entry.store = s;
        map.set(s.isbn, entry);
      }
    }
    return map;
  }, [searchResult, storeResult]);

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocError(t("gpsUnsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocError("");
      },
      () => setLocError(t("gpsDenied"))
    );
  };

  useEffect(() => {
    setPage(1);
    setStorePage(1);
  }, [debouncedQuery, genre, lang, onlyAvailable]);

  const handlePricePreset = (idx: number) => {
    setPricePreset(idx);
    setMinPrice(PRICE_PRESETS[idx].min);
    setMaxPrice(PRICE_PRESETS[idx].max);
    setStorePage(1);
  };

  const libraryCount = searchResult?.total ?? 0;
  const storeCount = storeResult?.total ?? 0;

  // Qidiruv — kitobxon qobig'ining bir qismi: pastki tab-panel va
  // "Asosiy"ga qaytish yo'li shu yerda ham bo'ladi. Avval sahifa o'z
  // qobig'ini chizardi va bu yerga kirgan foydalanuvchi orqaga qaytish
  // yo'lini topolmasdi.
  return (
    <ReaderShell title={t("title")} backHref={`/${locale}/profile`}>
      <div>
        <p className="text-slate-500 mb-6">
          {t("subtitle")}
        </p>

        {/* ── Search bar ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-line p-4 mb-4">
          <div className="relative mb-4">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Icon.search aria-hidden="true" size={ICON_SIZE.md} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-full pl-10 pr-4 py-3 border border-line-strong rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* Kutubxona bo'yicha cheklov — kutubxona sahifasidan kelganda */}
          {libraryIdParam && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
                <Icon.library aria-hidden="true" size={ICON_SIZE.xs} />
                {t("libraryFilter", { name: scopedLibrary?.name ?? "…" })}
              </span>
              <button
                type="button"
                onClick={clearLibraryFilter}
                className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-brand-700"
              >
                <Icon.close aria-hidden="true" size={ICON_SIZE.xs} />
                {t("clearLibraryFilter")}
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-3 items-center">
            {/* Genre chips */}
            <div className="flex gap-1.5 flex-wrap">
              {GENRES.map((g) => (
                <button
                  key={g.key}
                  onClick={() => setGenre(g.value)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    g.value === genre
                      ? "bg-brand-600 text-white border-blue-600"
                      : "border-line-strong text-slate-600 hover:border-blue-400"
                  }`}
                >
                  {t(`genres.${g.key}`)}
                </button>
              ))}
            </div>

            {/* Language — ko'rinadigan label yo'q, shuning uchun aria-label
                (axe select-name, WCAG 4.1.2) */}
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-label={t("langFilter")}
              className="border border-line-strong rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {t(`langs.${l.key}`)}
                </option>
              ))}
            </select>

            {/* Only available */}
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(e) => setOnlyAvailable(e.target.checked)}
                className="rounded"
              />
              {t("onlyAvailable")}
            </label>

            {/* Nearby toggle */}
            <button
              onClick={() => {
                setNearbyMode(!nearbyMode);
                if (!nearbyMode && !userLocation) requestLocation();
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                nearbyMode
                  ? "bg-green-600 text-white border-green-600"
                  : "border-line-strong text-slate-600 hover:border-green-500"
              }`}
            >
              <Icon.map aria-hidden="true" size={ICON_SIZE.sm} />
              {nearbyMode ? t("nearbyOn") : t("nearby")}
            </button>
          </div>
          {locError && <p className="text-red-500 text-xs mt-2">{locError}</p>}
        </div>

        {/* ── Price filter (visible when stores tab or all) ── */}
        {!nearbyMode && viewTab !== "libraries" && (
          <div className="bg-white rounded-2xl shadow-sm border border-line p-4 mb-4">
            <p className="text-sm font-medium text-slate-700 mb-3">{t("priceFilter")}</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {PRICE_PRESETS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => handlePricePreset(i)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    pricePreset === i
                      ? "bg-orange-700 text-white border-orange-700"
                      : "border-line-strong text-slate-600 hover:border-orange-400"
                  }`}
                >
                  {t(`presets.${p.key}`)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder={t("minPrice")}
                value={minPrice ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? Number(e.target.value) : undefined;
                  setMinPrice(v);
                  setPricePreset(-1);
                  setStorePage(1);
                }}
                className="w-32 border border-line-strong rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <span className="text-slate-400 text-sm">-</span>
              <input
                type="number"
                placeholder={t("maxPrice")}
                value={maxPrice ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? Number(e.target.value) : undefined;
                  setMaxPrice(v);
                  setPricePreset(-1);
                  setStorePage(1);
                }}
                className="w-32 border border-line-strong rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <span className="text-slate-400 text-xs">{t("som")}</span>
            </div>
          </div>
        )}

        {/* ── Tabs (non-nearby) ── */}
        {!nearbyMode && (
          <div className="flex gap-1 card-surface rounded-xl p-1 mb-4">
            {([
              { key: "all", label: t("tabAll"), count: libraryCount + storeCount },
              { key: "libraries", label: t("tabLibraries"), count: libraryCount, icon: Icon.library },
              { key: "stores", label: t("tabStores"), count: storeCount, icon: Icon.store },
            ] as const).map((tabItem) => (
              <button
                key={tabItem.key}
                onClick={() => setViewTab(tabItem.key)}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  viewTab === tabItem.key
                    ? "bg-brand-600 text-white shadow-sm"
                    : "text-slate-600 hover:bg-surface-muted"
                }`}
              >
                {"icon" in tabItem && <tabItem.icon aria-hidden="true" size={ICON_SIZE.sm} />}
                {tabItem.label}
                {debouncedQuery && (
                  <span
                    className={`ml-1.5 text-xs ${
                      viewTab === tabItem.key ? "text-white" : "text-slate-400"
                    }`}
                  >
                    ({tabItem.count})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Results ── */}
        {nearbyMode ? (
          <NearbyMixedResults
            libs={nearbyLibs}
            stores={nearbyStores?.data ?? []}
            libsLoading={nearbyLoading}
            storesLoading={nearbyStoresLoading}
            query={debouncedQuery}
          />
        ) : viewTab === "libraries" ? (
          <LibraryResults
            result={searchResult}
            loading={searchLoading}
            page={page}
            onPage={setPage}
            isbnMap={isbnMap}
          />
        ) : viewTab === "stores" ? (
          <StoreResults
            result={storeResult}
            loading={storeLoading}
            page={storePage}
            onPage={setStorePage}
            isbnMap={isbnMap}
          />
        ) : (
          <AllResults
            libResult={searchResult}
            storeResult={storeResult}
            libLoading={searchLoading}
            storeLoading={storeLoading}
            libPage={page}
            storePage={storePage}
            onLibPage={setPage}
            onStorePage={setStorePage}
            isbnMap={isbnMap}
          />
        )}
      </div>
    </ReaderShell>
  );
}

// ---------------------------------------------------------------------------
// ISBN Comparison Banner
// ---------------------------------------------------------------------------

function IsbnComparisonBanner({
  isbn,
  isbnMap,
}: {
  isbn: string;
  isbnMap: Map<string, { library?: Book; store?: StoreProductSearchResult }>;
}) {
  const t = useTranslations("ReaderSearch");
  const entry = isbnMap.get(isbn);
  if (!entry || !entry.library || !entry.store) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs bg-blue-50 border border-brand-100 rounded-lg px-3 py-1.5">
      <span className="text-brand-700 font-medium">{t("compare")}</span>
      <span className="text-green-700">
        {t("inLibrary")}{" "}
        {entry.library.availableCount > 0
          ? t("availableCopies", { count: entry.library.availableCount })
          : t("notAvailable")}
      </span>
      <span className="text-slate-400">|</span>
      <span className="text-orange-700">
        {t("inStore")} {formatPrice(entry.store.price, t("som"))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ALL results (libraries first, then stores)
// ---------------------------------------------------------------------------

function AllResults({
  libResult,
  storeResult,
  libLoading,
  storeLoading,
  libPage,
  storePage,
  onLibPage,
  onStorePage,
  isbnMap,
}: {
  libResult?: { total: number; page: number; limit: number; data: Book[] };
  storeResult?: { total: number; data: StoreProductSearchResult[] };
  libLoading: boolean;
  storeLoading: boolean;
  libPage: number;
  storePage: number;
  onLibPage: (p: number) => void;
  onStorePage: (p: number) => void;
  isbnMap: Map<string, { library?: Book; store?: StoreProductSearchResult }>;
}) {
  const t = useTranslations("ReaderSearch");
  const noLib = !libLoading && (!libResult || libResult.data.length === 0);
  const noStore = !storeLoading && (!storeResult || storeResult.data.length === 0);

  if (noLib && noStore) return <EmptyState />;

  return (
    <div className="space-y-8">
      {/* Library section */}
      <div>
        <SectionHeader icon={Icon.library} title={t("sectionLibraries")} badge={t("free")} badgeColor="green" />
        <LibraryResults
          result={libResult}
          loading={libLoading}
          page={libPage}
          onPage={onLibPage}
          isbnMap={isbnMap}
          embedded
        />
      </div>

      {/* Store section */}
      <div>
        <SectionHeader icon={Icon.store} title={t("sectionStores")} />
        <StoreResults
          result={storeResult}
          loading={storeLoading}
          page={storePage}
          onPage={onStorePage}
          isbnMap={isbnMap}
          embedded
        />
      </div>
    </div>
  );
}

function SectionHeader({
  icon: HeaderIcon,
  title,
  badge,
  badgeColor,
}: {
  icon: LucideIcon;
  title: string;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <HeaderIcon aria-hidden="true" size={ICON_SIZE.md} className="text-slate-400" />
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {badge && (
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            badgeColor === "green"
              ? "bg-green-100 text-green-700"
              : "bg-surface-sunken text-slate-700"
          }`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library Results
// ---------------------------------------------------------------------------

function LibraryResults({
  result,
  loading,
  page,
  onPage,
  isbnMap,
  embedded,
}: {
  result?: { total: number; page: number; limit: number; data: Book[] };
  loading: boolean;
  page: number;
  onPage: (p: number) => void;
  isbnMap: Map<string, { library?: Book; store?: StoreProductSearchResult }>;
  embedded?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("ReaderSearch");
  if (loading) return <Skeleton label={t("searchingLibraries")} />;
  if (!result || result.data.length === 0) {
    if (embedded)
      return (
        <p className="text-sm text-slate-400 py-4">{t("noLibraryResults")}</p>
      );
    return <EmptyState />;
  }

  const totalPages = Math.ceil(result.total / result.limit);

  return (
    <>
      {!embedded && (
        <p className="text-sm text-slate-500 mb-4">
          {t("resultsFound", { count: result.total })}
        </p>
      )}
      <div className="grid gap-3">
        {result.data.map((book) => (
          <div key={book.id}>
            <BookCard book={book} href={libraryHref(locale, book)} />
            <IsbnComparisonBanner isbn={book.isbn} isbnMap={isbnMap} />
          </div>
        ))}
      </div>
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPage={onPage} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Store Results
// ---------------------------------------------------------------------------

function StoreResults({
  result,
  loading,
  page,
  onPage,
  isbnMap,
  embedded,
}: {
  result?: { total: number; data: StoreProductSearchResult[] };
  loading: boolean;
  page: number;
  onPage: (p: number) => void;
  isbnMap: Map<string, { library?: Book; store?: StoreProductSearchResult }>;
  embedded?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("ReaderSearch");
  if (loading) return <Skeleton label={t("searchingStores")} />;
  if (!result || result.data.length === 0) {
    if (embedded)
      return <p className="text-sm text-slate-400 py-4">{t("noStoreResults")}</p>;
    return <EmptyState />;
  }

  const totalPages = Math.ceil(result.total / 20);

  return (
    <>
      {!embedded && (
        <p className="text-sm text-slate-500 mb-4">
          {t("productsFound", { count: result.total })}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {result.data.map((product) => (
          <div key={product.id}>
            <StoreProductCard
              product={product}
              href={product.slug ? `/${locale}/dokon/${product.slug}` : null}
            />
            <IsbnComparisonBanner isbn={product.isbn} isbnMap={isbnMap} />
          </div>
        ))}
      </div>
      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPage={onPage} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Nearby Mixed Results (libraries + stores by distance)
// ---------------------------------------------------------------------------

function NearbyMixedResults({
  libs,
  stores,
  libsLoading,
  storesLoading,
  query,
}: {
  libs: NearbyLibrary[];
  stores: StoreProductSearchResult[];
  libsLoading: boolean;
  storesLoading: boolean;
  query: string;
}) {
  const t = useTranslations("ReaderSearch");
  const loading = libsLoading || storesLoading;
  if (loading) return <Skeleton label={t("searchingNearby")} />;

  type NearbyItem =
    | { kind: "library"; data: NearbyLibrary; distance: number }
    | { kind: "store"; data: StoreProductSearchResult; distance: number };

  const items: NearbyItem[] = [
    ...libs.map(
      (l): NearbyItem => ({ kind: "library", data: l, distance: l.distanceKm })
    ),
    ...stores
      .filter((s) => s.distance != null)
      .map(
        (s): NearbyItem => ({
          kind: "store",
          data: s,
          distance: s.distance!,
        })
      ),
  ].sort((a, b) => a.distance - b.distance);

  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon.map aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-3 text-slate-300" />
        <p className="text-slate-500">{t("noNearby")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {items.map((item, i) =>
        item.kind === "library" ? (
          <NearbyLibraryCard key={`lib-${item.data.id}`} lib={item.data} query={query} />
        ) : (
          <NearbyStoreProductCard key={`store-${item.data.id}-${i}`} product={item.data} />
        )
      )}
    </div>
  );
}

function NearbyLibraryCard({ lib, query }: { lib: NearbyLibrary; query: string }) {
  const locale = useLocale();
  const t = useTranslations("ReaderSearch");
  // NearbyLibrary extends Library so `code` is always present here; fall back to
  // id defensively. The detail route resolves either.
  const href = `/${locale}/library/${encodeURIComponent(lib.code ?? lib.id)}`;
  return (
    <div className="card-surface rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Icon.library aria-hidden="true" size={ICON_SIZE.md} className="shrink-0 text-slate-400" />
            <h3 className="font-semibold text-slate-900 truncate">{lib.name}</h3>
            <span className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
              {t("free")}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">{lib.address}</p>
          {lib.workHours && (
            <p className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
              <Icon.pending aria-hidden="true" size={ICON_SIZE.xs} />
              {lib.workHours}
            </p>
          )}
          {lib.phone && (
            <p className="flex items-center gap-1 text-xs text-slate-400">
              <Icon.phone aria-hidden="true" size={ICON_SIZE.xs} />
              {lib.phone}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <span className="inline-flex items-center gap-1 text-brand-600 font-semibold text-sm">
            <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
            {lib.distanceKm.toFixed(1)} km
          </span>
          <p className="text-xs text-slate-400 mt-0.5">
            {t("booksCount", { count: lib.fundCount.toLocaleString() })}
          </p>
        </div>
      </div>
      {query && lib.books && lib.books.length > 0 && (
        <div className="mt-3 pt-3 border-t border-line">
          <p className="text-xs font-medium text-slate-600 mb-2">
            {t("copiesWithQuery", { query })}
          </p>
          {lib.books.map((b: Book) => (
            <BookCard key={b.id} book={b} compact href={href} />
          ))}
        </div>
      )}
      <Link
        href={href}
        className="mt-3 inline-block text-sm text-brand-600 hover:underline"
      >
        {t("libraryPage")}
      </Link>
    </div>
  );
}

function NearbyStoreProductCard({ product }: { product: StoreProductSearchResult }) {
  const locale = useLocale();
  const t = useTranslations("ReaderSearch");
  const inner = (
    <div className="bg-white rounded-2xl border border-orange-100 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start gap-4">
        {product.coverUrl ? (
          <img
            src={product.coverUrl}
            alt={product.title}
            className="w-14 h-20 object-cover rounded"
          />
        ) : (
          <div className="w-14 h-20 bg-gradient-to-br from-orange-100 to-orange-200 rounded flex items-center justify-center text-orange-600">
            <Icon.store aria-hidden="true" size={ICON_SIZE.md} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-semibold text-slate-900 truncate">{product.title}</h3>
            {product.premiumBadge && (
              <span className="shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">
                {t("premium")}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500">{product.author}</p>
          <p className="text-lg font-bold text-orange-600 mt-1">
            {formatPrice(product.price, t("som"))}
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
              {product.distance != null ? `${product.distance.toFixed(1)} km` : ""} —{" "}
              {product.storeName}
            </span>
            {product.stockCount > 0 ? (
              <span className="text-green-700 font-medium">{t("inStock")}</span>
            ) : (
              <span className="text-red-500 font-medium">{t("outOfStock")}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (!product.slug) return inner;
  return (
    <Link
      href={`/${locale}/dokon/${product.slug}`}
      className="block focus:outline-none focus:ring-2 focus:ring-orange-500 rounded-2xl"
    >
      {inner}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Book Card (library books)
// ---------------------------------------------------------------------------

function BookCard({
  book,
  compact,
  href,
}: {
  book: Book;
  compact?: boolean;
  href?: string | null;
}) {
  const t = useTranslations("ReaderSearch");
  const inner = (
    <div
      className={`card-surface rounded-xl ${
        compact ? "p-3" : "p-4"
      } flex gap-3 hover:shadow-sm transition-shadow`}
    >
      {book.coverUrl ? (
        <img
          src={book.coverUrl}
          alt={book.title}
          className={`object-cover rounded ${compact ? "w-8 h-12" : "w-14 h-20"}`}
        />
      ) : (
        <div
          className={`bg-gradient-to-br from-blue-100 to-blue-200 rounded flex items-center justify-center text-brand-600 ${
            compact ? "w-8 h-12" : "w-14 h-20"
          }`}
        >
          <Icon.book aria-hidden="true" size={compact ? ICON_SIZE.xs : ICON_SIZE.md} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <h3
          className={`font-semibold text-slate-900 truncate ${
            compact ? "text-sm" : "text-base"
          }`}
        >
          {book.title}
        </h3>
        <p className={`text-slate-500 ${compact ? "text-xs" : "text-sm"}`}>
          {book.author}
        </p>
        {!compact && (
          <div className="flex gap-3 mt-1.5 text-xs text-slate-400">
            <span>{book.genre}</span>
            {book.year > 0 && <span>{book.year}</span>}
            {book.pages > 0 && <span>{t("pagesCount", { count: book.pages })}</span>}
          </div>
        )}
        <div className={`mt-1 flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
          {book.availableCount > 0 ? (
            <span className="text-green-700 font-medium">
              {t("freeAvailable", { count: book.availableCount })}
            </span>
          ) : (
            <span className="text-red-500 font-medium">{t("notAvailable")}</span>
          )}
          {book.library && (
            <span className="text-slate-400">· {book.library.name}</span>
          )}
        </div>
      </div>
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="block focus:outline-none focus:ring-2 focus:ring-brand-500 rounded-xl">
      {inner}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Store Product Card
// ---------------------------------------------------------------------------

function StoreProductCard({
  product,
  href,
}: {
  product: StoreProductSearchResult;
  href?: string | null;
}) {
  const t = useTranslations("ReaderSearch");
  const inner = (
    <div className="card-surface rounded-xl p-4 flex gap-3 hover:shadow-sm transition-shadow">
      {product.coverUrl ? (
        <img
          src={product.coverUrl}
          alt={product.title}
          className="w-14 h-20 object-cover rounded"
        />
      ) : (
        <div className="w-14 h-20 bg-gradient-to-br from-orange-100 to-orange-200 rounded flex items-center justify-center text-orange-600">
          <Icon.store aria-hidden="true" size={ICON_SIZE.md} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="font-semibold text-slate-900 truncate">{product.title}</h3>
              {product.premiumBadge && (
                <span className="shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">
                  {t("premium")}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500">{product.author}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-base font-bold text-orange-600">
              {formatPrice(product.price, t("som"))}
            </p>
          </div>
        </div>

        {product.genre && (
          <span className="text-xs text-slate-400">{product.genre}</span>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs">
          {product.stockCount > 0 ? (
            <span className="text-green-700 font-medium">
              {t("inStockCount", { count: product.stockCount })}
            </span>
          ) : (
            <span className="text-red-500 font-medium">{t("outOfStock")}</span>
          )}
          <span className="inline-flex items-center gap-1 text-slate-400">
            {product.distance != null && (
              <>
                <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
                {`${product.distance.toFixed(1)} km — `}
              </>
            )}
            {product.storeName}
          </span>
          {product.storeAddress && (
            <span className="text-slate-400 truncate max-w-[200px]">
              {product.storeAddress}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  if (!href) return inner;
  return (
    <Link href={href} className="block focus:outline-none focus:ring-2 focus:ring-orange-500 rounded-xl">
      {inner}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------

function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  const t = useTranslations("ReaderSearch");
  return (
    <div className="flex justify-center gap-2 mt-6">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="px-3 py-1.5 border rounded-lg text-sm disabled:opacity-40 hover:bg-surface-muted"
      >
        {t("prev")}
      </button>
      <span className="px-3 py-1.5 text-sm text-slate-600">
        {page} / {totalPages}
      </span>
      <button
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="px-3 py-1.5 border rounded-lg text-sm disabled:opacity-40 hover:bg-surface-muted"
      >
        {t("next")}
      </button>
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return <div className="text-center py-12 text-slate-400">{label}</div>;
}

function EmptyState() {
  const t = useTranslations("ReaderSearch");
  return (
    <div className="text-center py-12">
      <Icon.library aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-3 text-slate-300" />
      <p className="text-slate-500 mb-1">{t("notFoundTitle")}</p>
      <p className="text-slate-400 text-sm">
        {t("notFoundHint")}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useDebounce hook
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
