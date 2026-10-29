"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { fmtNumber } from "@/lib/format";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/ui/error-state";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { getTumanlar } from "@/lib/api/geo";
import type { ViloyatMapData } from "@/components/map/ViloyatMap";
// Plan 05-03 T3 (STAT-04..07) — new chart components + extracted ShortageTab.
import { GenderBreakdownChart } from "@/components/charts/GenderBreakdownChart";
import { AgeBreakdownChart } from "@/components/charts/AgeBreakdownChart";
import { GenreTrendChart } from "@/components/charts/GenreTrendChart";
import { ShortageTab as ShortageTabComponent, type ShortageItem as NewShortageItem } from "@/components/stats/ShortageTab";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { PageHeader } from "@/components/dashboard/ui";
import { motion, useReducedMotion } from "motion/react";
import { fadeUp } from "@/lib/motion";

// Leaflet SSR muammosi — faqat browserda yuklanadi
function MapLoadingState() {
  const t = useTranslations("StatsPanel");
  return (
    <div className="rounded-2xl bg-surface-sunken border border-line flex items-center justify-center" style={{ height: "480px" }}>
      <div className="flex flex-col items-center gap-2 text-slate-400">
        <Icon.map aria-hidden="true" size={32} strokeWidth={1.25} />
        <p className="text-sm">{t("mapLoading")}</p>
      </div>
    </div>
  );
}

const ViloyatMap = dynamic(() => import("@/components/map/ViloyatMap"), {
  ssr: false,
  loading: () => <MapLoadingState />
});

// ── Tipler ────────────────────────────────────────────────────────────────────

type NationalStats = {
  users: { total: number; active30d: number; newThisMonth: number; byGender: Record<string, number> };
  libraries: { total: number; byType: Record<string, number> };
  books: { total: number; available: number };
  transactions: { thisMonth: number; lastMonth: number; returned: number; growth: number };
  readingIndex: { national: number };
};

type GenreStat = { genre: string; count: number };
// Plan 05-03 T3 — ShortageItem now includes bookId for the Buyurtma button.
type ShortageItem = NewShortageItem;

type LevelType = "national" | "viloyat" | "tuman";

// Plan 05-02-fix FIX B — Viloyat row shape served by GET /geo/viloyatlar.
// `id` is the real Prisma cuid that the backend keys all stats objects on.
// `slug` and `code` are kept for URL-friendly display + future deep-linking
// but are NOT used to look up backend stats (slug ≠ id).
type ViloyatRow = {
  id: string;
  code: string;
  name: string;
  slug: string;
};

// ── API ───────────────────────────────────────────────────────────────────────

// Plan 05-02-fix FIX B — fetch the real viloyat list from /geo/viloyatlar.
// Replaces the previous hardcoded const whose synthetic ids did NOT match
// the cuid `Viloyat.id` that the backend keys all stats objects on, so
// /admin/stats/viloyat/all values rendered as zeros on the map. Slug stays
// available for the coordinate lookup.
async function fetchViloyatList(): Promise<ViloyatRow[]> {
  const res = await apiClient("/geo/viloyatlar");
  if (!res.ok) return [];
  return res.json();
}

async function fetchNationalStats(): Promise<NationalStats> {
  const res = await apiClient("/admin/stats/national");
  if (!res.ok) throw new Error();
  return res.json();
}

async function fetchViloyatStats(id: string) {
  const res = await apiClient(`/admin/stats/viloyat/${id}`);
  if (!res.ok) throw new Error();
  return res.json();
}

async function fetchTumanStats(id: string) {
  const res = await apiClient(`/admin/stats/tuman/${id}`);
  if (!res.ok) throw new Error();
  return res.json();
}

async function fetchGenreStats(): Promise<GenreStat[]> {
  const res = await apiClient("/admin/stats/genres");
  if (!res.ok) return [];
  return res.json();
}

async function fetchShortage(): Promise<ShortageItem[]> {
  const res = await apiClient("/admin/stats/shortage?limit=20");
  if (!res.ok) return [];
  return res.json();
}

const fmt = (n: number) => fmtNumber(n);

// ── Asosiy komponent ──────────────────────────────────────────────────────────

type TabKey =
  | "overview"
  | "genres"
  | "shortage"
  | "map"
  | "gender"
  | "age"
  | "genres-trend";

export default function StatsPage() {
  const t = useTranslations("StatsPanel");
  const { user } = useAuthStore();
  const role = user?.role ?? "";
  const isSuper = role === "SUPER_ADMIN";
  const myViloyatId = user?.address?.viloyatId ?? "";
  const myTumanId = user?.address?.tumanId ?? "";

  // RBAC geo-scoping (Audit 2026-06) — VILOYAT_ADMIN faqat o'z viloyatini,
  // TUMAN_ADMIN faqat o'z tumanini ko'radi. Backend buni allaqachon majburlaydi
  // (assertViloyatInScope/assertTumanInScope → 403); bu yerda UI ham qulflanadi
  // — tier admin boshqa hududni tanlay olmaydi. SUPER_ADMIN erkin ko'radi.
  const lockedScope: "viloyat" | "tuman" | null =
    role === "VILOYAT_ADMIN" ? "viloyat" : role === "TUMAN_ADMIN" ? "tuman" : null;

  const [level, setLevel] = useState<LevelType>("national");
  const [selectedViloyat, setSelectedViloyat] = useState<string>("");
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  // Plan 05-02-fix FIX B — viloyat list driven by backend (cuids), not slugs.
  const { data: viloyatList = [] } = useQuery({
    queryKey: ["viloyat-list"],
    queryFn: fetchViloyatList,
    staleTime: 60 * 60 * 1000  // 1h — viloyat rows change ~never
  });

  // Tuman nomini badge uchun olish (faqat tuman admin uchun).
  const { data: tumanList = [] } = useQuery({
    queryKey: ["tuman-list", myViloyatId],
    queryFn: () => getTumanlar(myViloyatId),
    enabled: lockedScope === "tuman" && !!myViloyatId,
    staleTime: 60 * 60 * 1000
  });

  // Effektiv ko'rinish doirasi: SUPER_ADMIN toggle/dropdown bilan boshqaradi,
  // tier adminlar o'z hududiga qulflangan.
  const eff: { kind: LevelType; id: string } =
    lockedScope === "viloyat"
      ? { kind: "viloyat", id: myViloyatId }
      : lockedScope === "tuman"
      ? { kind: "tuman", id: myTumanId }
      : level === "viloyat"
      ? { kind: "viloyat", id: selectedViloyat }
      : { kind: "national", id: "" };

  const { data: national, isError: nationalError, refetch: refetchNational } = useQuery({
    queryKey: ["national-stats"],
    queryFn: fetchNationalStats,
    enabled: isSuper,
    staleTime: 300_000
  });

  const { data: viloyatData, isError: viloyatError, refetch: refetchViloyat } = useQuery({
    queryKey: ["viloyat-stats", eff.id],
    queryFn: () => fetchViloyatStats(eff.id),
    enabled: eff.kind === "viloyat" && !!eff.id,
    staleTime: 300_000
  });

  const { data: tumanData, isError: tumanError, refetch: refetchTuman } = useQuery({
    queryKey: ["tuman-stats", eff.id],
    queryFn: () => fetchTumanStats(eff.id),
    enabled: eff.kind === "tuman" && !!eff.id,
    staleTime: 300_000
  });

  const { data: genres = [], isError: genresError, refetch: refetchGenres } = useQuery({
    queryKey: ["genre-stats"],
    queryFn: fetchGenreStats,
    enabled: activeTab === "genres",
    staleTime: 600_000
  });

  const { data: shortage = [], isError: shortageError, refetch: refetchShortage } = useQuery({
    queryKey: ["book-shortage"],
    queryFn: fetchShortage,
    enabled: activeTab === "shortage",
    staleTime: 300_000
  });

  // Tier adminlar uchun faqat hududiy-scope qo'llab-quvvatlaydigan tablar
  // (milliy janr ro'yxati, yetishmovchilik va xarita SUPER_ADMIN uchun).
  const visibleTabs = isSuper
    ? TABS
    : TABS.filter((t) => ["overview", "gender", "age", "genres-trend"].includes(t.key));

  // Qulflangan hudud nomi (badge).
  const lockedName =
    lockedScope === "viloyat"
      ? viloyatList.find((v) => v.id === myViloyatId)?.name
      : lockedScope === "tuman"
      ? tumanList.find((t) => t.id === myTumanId)?.name
      : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.stats}
        badge={
          !isSuper && lockedName
            ? { label: lockedName, sub: lockedScope === "tuman" ? t("scopeTuman") : t("scopeViloyat") }
            : undefined
        }
        action={
          isSuper ? (
          <div className="flex gap-2">
            {(["national", "viloyat"] as const).map((l) => (
              <button
                key={l}
                onClick={() => { setLevel(l); }}
                className={`rounded-md px-3.5 py-2 text-sm font-medium transition-colors ${
                  level === l
                    ? "bg-brand-600 text-white"
                    : "border border-line bg-white text-slate-600 hover:bg-surface-muted"
                }`}
              >
                {l === "national" ? t("levelNational") : t("levelViloyat")}
              </button>
            ))}
            {level === "viloyat" && (
              <select
                value={selectedViloyat}
                onChange={(e) => setSelectedViloyat(e.target.value)}
                className="rounded-md border border-line bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">{t("selectViloyat")}</option>
                {viloyatList.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
          </div>
          ) : undefined
        }
      />

      {/* Tab tanlash — faol tab ostidagi indikator `layoutId` bilan siljiydi */}
      <div className="flex gap-1 overflow-x-auto border-b border-line pb-px">
        {visibleTabs.map((tab) => {
          const TabIcon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as TabKey)}
              className={`relative flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm font-medium transition-colors ${
                active ? "text-brand-700" : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <TabIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={active ? 2.2 : 1.75} />
              {t(tab.labelKey)}
              {active && (
                <motion.span
                  layoutId="stats-tab"
                  className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-blue-600"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Ko'rinish 1: Umumiy ko'rsatkichlar ─────────────────────────── */}
      {/* Xato "abadiy Yuklanmoqda…" bo'lib qolmasin: doiraga mos so'rov
          yiqilsa retry tugmali panel chiqadi. */}
      {activeTab === "overview" && (
        (eff.kind === "national" && nationalError) ? (
          <ErrorState title={t("errNationalTitle")} message={t("retryMsg")} onRetry={() => refetchNational()} />
        ) : (eff.kind === "viloyat" && viloyatError) ? (
          <ErrorState title={t("errViloyatTitle")} message={t("retryMsg")} onRetry={() => refetchViloyat()} />
        ) : (eff.kind === "tuman" && tumanError) ? (
          <ErrorState title={t("errTumanTitle")} message={t("retryMsg")} onRetry={() => refetchTuman()} />
        ) : (
          <OverviewTab
            national={national}
            viloyatStats={viloyatData}
            tumanStats={tumanData}
            scopeKind={eff.kind}
          />
        )
      )}

      {/* ── Ko'rinish 2: Janr tahlili ───────────────────────────────── */}
      {activeTab === "genres" && (genresError
        ? <ErrorState title={t("errGenresTitle")} message={t("errGenresMsg")} onRetry={() => refetchGenres()} />
        : <GenreTab genres={genres} />)}

      {/* ── Ko'rinish 3: Kitob yetishmovchiligi ──────────────────────── */}
      {activeTab === "shortage" && (shortageError
        ? <ErrorState title={t("errShortageTitle")} message={t("errShortageMsg")} onRetry={() => refetchShortage()} />
        : <ShortageTabComponent items={shortage} />)}

      {/* ── Ko'rinish 4: Viloyatlar xaritasi ─────────────────────────── */}
      {activeTab === "map" && <MapTab national={national} viloyatList={viloyatList} />}

      {/* ── Plan 05-03 STAT-04: Gender ──────────────────────────────── */}
      {activeTab === "gender" && (
        <GenderBreakdownChart
          scope={eff.kind}
          scopeId={eff.kind === "national" ? undefined : eff.id || undefined}
        />
      )}

      {/* ── Plan 05-03 STAT-05: Age ─────────────────────────────────── */}
      {activeTab === "age" && (
        <AgeBreakdownChart
          scope={eff.kind}
          scopeId={eff.kind === "national" ? undefined : eff.id || undefined}
        />
      )}

      {/* ── Plan 05-03 STAT-06: Genre trend ─────────────────────────── */}
      {activeTab === "genres-trend" && (
        <GenreTrendChart
          months={12}
          scope={eff.kind}
          scopeId={eff.kind === "national" ? undefined : eff.id || undefined}
        />
      )}
    </div>
  );
}

// ── Tab: Umumiy ko'rsatkichlar ────────────────────────────────────────────────

function OverviewTab({
  national,
  viloyatStats,
  tumanStats,
  scopeKind
}: {
  national: NationalStats | undefined;
  viloyatStats: any;
  tumanStats: any;
  scopeKind: LevelType;
}) {
  const t = useTranslations("StatsPanel");
  // ── Tuman doirasi (TUMAN_ADMIN) ──
  if (scopeKind === "tuman") {
    if (!tumanStats) {
      return (
        <div className="text-center py-12 text-slate-400 card-surface rounded-2xl">
          {t("loading")}
        </div>
      );
    }
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={Icon.library} label={t("libraries")} value={fmt(tumanStats.libraries)} />
        <StatCard icon={Icon.readers} label={t("usersLabel")} value={fmt(tumanStats.users)} tone="green" />
        <StatCard icon={Icon.refresh} label={t("txThisMonth")} value={fmt(tumanStats.transactionsThisMonth)} tone="violet" />
        <StatCard icon={Icon.index} label={t("avgReadingIndex")} value={t("scoreBall", { score: tumanStats.readingIndex })} tone="amber" />
      </div>
    );
  }

  // ── Viloyat doirasi ──
  if (scopeKind === "viloyat") {
    if (!viloyatStats) {
      return (
        <div className="text-center py-12 text-slate-400 card-surface rounded-2xl">
          {t("selectViloyatHint")}
        </div>
      );
    }
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={Icon.library} label={t("libraries")} value={fmt(viloyatStats.libraries)} />
        <StatCard icon={Icon.readers} label={t("usersLabel")} value={fmt(viloyatStats.users)} tone="green" />
        <StatCard icon={Icon.refresh} label={t("tx30d")} value={fmt(viloyatStats.transactions30d)} tone="violet" />
        <StatCard icon={Icon.index} label={t("avgReadingIndex")} value={t("scoreBall", { score: viloyatStats.readingIndex })} tone="amber" />
      </div>
    );
  }

  // ── Milliy doira (SUPER_ADMIN) ──
  if (!national) {
    return <div className="text-center py-12 text-slate-400">{t("loading")}</div>;
  }

  const stats = national;
  const total = stats.users.total;
  const male = stats.users.byGender.MALE ?? 0;
  const female = stats.users.byGender.FEMALE ?? 0;
  const genderTotal = male + female || 1;

  return (
    <div className="space-y-6">
      {/* KPI qatorlar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={Icon.readers} label={t("totalUsers")} value={fmt(total)} sub={t("activeSub", { count: fmt(stats.users.active30d) })} />
        <StatCard icon={Icon.library} label={t("libraries")} value={fmt(stats.libraries.total)} sub={t("booksAvailableSub", { count: fmt(stats.books.available) })} tone="green" />
        <StatCard icon={Icon.refresh} label={t("txThisMonth")} value={fmt(stats.transactions.thisMonth)}
          sub={stats.transactions.growth !== 0 ? `${stats.transactions.growth >= 0 ? "↑" : "↓"} ${Math.abs(stats.transactions.growth)}%` : ""} tone="violet" />
        <StatCard icon={Icon.index} label={t("nationalRI")} value={`${stats.readingIndex.national}`} sub={t("riSub")} tone="amber" />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Kutubxona turlari bar chart */}
        <div className="card-surface rounded-2xl p-6">
          <h3 className="font-bold text-slate-900 mb-5">{t("libTypesTitle")}</h3>
          <div className="space-y-3">
            {Object.entries(stats.libraries.byType).map(([type, count]) => {
              const pct = Math.round((count / stats.libraries.total) * 100);
              const color = LIB_COLORS[type] ?? "bg-gray-400";
              return (
                <div key={type}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-slate-700 font-medium">{LIB_TYPE_KEYS.includes(type) ? t(`libTypes.${type}`) : type}</span>
                    <span className="text-slate-500">{fmt(count)} ({pct}%)</span>
                  </div>
                  <div className="w-full bg-surface-sunken rounded-full h-2.5">
                    <div className={`${color} h-2.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Gender + oy statistikasi */}
        <div className="space-y-4">
          <div className="card-surface rounded-2xl p-6">
            <h3 className="font-bold text-slate-900 mb-4">{t("genderTitle")}</h3>
            <div className="flex gap-4 items-center">
              <GenderDonut male={male} female={female} total={genderTotal} />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-brand-500" />
                  <span className="text-sm text-slate-600">{t("male")}</span>
                  <span className="ml-auto font-bold text-sm">{Math.round((male / genderTotal) * 100)}%</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-pink-500" />
                  <span className="text-sm text-slate-600">{t("female")}</span>
                  <span className="ml-auto font-bold text-sm">{Math.round((female / genderTotal) * 100)}%</span>
                </div>
              </div>
            </div>
          </div>

          <div className="card-surface rounded-2xl p-6">
            <h3 className="font-bold text-slate-900 mb-3">{t("txCompareTitle")}</h3>
            <div className="flex gap-4">
              <TxBar
                label={t("txBarThisMonth")}
                count={stats.transactions.thisMonth}
                max={Math.max(stats.transactions.thisMonth, stats.transactions.lastMonth)}
                color="bg-brand-500"
              />
              <TxBar
                label={t("txBarLastMonth")}
                count={stats.transactions.lastMonth}
                max={Math.max(stats.transactions.thisMonth, stats.transactions.lastMonth)}
                color="bg-gray-300"
              />
              <TxBar
                label={t("txBarReturned")}
                count={stats.transactions.returned}
                max={stats.transactions.returned}
                color="bg-green-500"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tab: Janr tahlili ─────────────────────────────────────────────────────────

function GenreTab({ genres }: { genres: GenreStat[] }) {
  const t = useTranslations("StatsPanel");
  if (genres.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400 card-surface rounded-2xl">
        <Icon.book aria-hidden="true" size={28} strokeWidth={1.25} className="mx-auto text-slate-300" />
        <p className="mt-2">{t("genreEmpty")}</p>
      </div>
    );
  }

  const maxCount = genres[0]?.count ?? 1;

  return (
    <div className="card-surface rounded-2xl p-6">
      <h2 className="flex items-center gap-2.5 font-bold text-slate-900 mb-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-50 text-green-600"><Icon.book aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={1.75} /></span>
        {t("genreTitle")}
      </h2>
      <div className="space-y-3">
        {genres.map((g, i) => {
          const pct = Math.round((g.count / maxCount) * 100);
          const colors = ["bg-brand-500", "bg-purple-500", "bg-green-500", "bg-orange-500", "bg-pink-500"];
          const color = colors[i % colors.length];
          return (
            <div key={g.genre} className="flex items-center gap-4">
              <span className="text-sm text-slate-500 w-4 text-right">{i + 1}</span>
              <span className="text-sm font-medium text-slate-800 w-36 truncate">{g.genre}</span>
              <div className="flex-1 bg-surface-sunken rounded-full h-6 relative">
                <div className={`${color} h-6 rounded-full`} style={{ width: `${pct}%` }} />
                <span className="absolute right-2 top-0.5 text-xs font-semibold text-slate-700">
                  {fmt(g.count)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Plan 05-03 T3 (STAT-07) — ShortageTab moved to
// `components/stats/ShortageTab.tsx` so the inline definition was deleted.
// The imported component now adds a "Buyurtma" button per row.

// ── Tab: Viloyatlar xaritasi (Leaflet.js) ────────────────────────────────────

// Plan 05-02-fix FIX B — Viloyat lat/lon keyed by `slug` (stable DB column,
// matches seed.ts GEO_DATA exactly), NOT by previous synthetic ids. We look
// up coords by the slug the backend reports for each viloyat row, falling
// back to a country centroid on miss.
const VILOYAT_COORDS: Record<string, { lat: number; lon: number }> = {
  "toshkent":           { lat: 41.299, lon: 69.240 },
  "toshkent-viloyati":  { lat: 41.100, lon: 69.800 },
  "andijon":            { lat: 40.782, lon: 72.344 },
  "fargona":            { lat: 40.384, lon: 71.787 },
  "namangan":           { lat: 41.000, lon: 71.667 },
  "samarqand":          { lat: 39.654, lon: 66.975 },
  "buxoro":             { lat: 39.767, lon: 64.421 },
  "navoiy":             { lat: 40.084, lon: 65.380 },
  "qashqadaryo":        { lat: 38.860, lon: 65.793 },
  "surxondaryo":        { lat: 37.935, lon: 67.568 },
  "jizzax":             { lat: 40.108, lon: 67.840 },
  "sirdaryo":           { lat: 40.839, lon: 68.664 },
  "xorazm":             { lat: 41.552, lon: 60.628 },
  "qoraqalpogiston":    { lat: 43.801, lon: 59.016 }
};

function MapTab({
  national,
  viloyatList
}: {
  national: NationalStats | undefined;
  viloyatList: ViloyatRow[];
}) {
  const t = useTranslations("StatsPanel");
  const [selectedViloyat, setSelectedViloyat] = useState<ViloyatMapData | null>(null);

  const { data: allViloyatStats } = useQuery({
    queryKey: ["all-viloyat-stats"],
    queryFn: async () => {
      const res = await apiClient("/admin/stats/viloyat/all");
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 300_000
  });

  // Plan 05-02 T3 (STAT-02) — real per-viloyat RI from backend.
  //
  // Backend now returns the shape `{ libraries: Record<id, number>, viloyats:
  // Record<id, { readingIndex, userCount }> }` via /admin/stats/viloyat/all
  // (Plan 05-02 T1 _fetchAllViloyatStats GROUP BY raw-SQL fix). Frontend reads
  // the real number — the previous synthetic per-viloyat simulation is gone.
  const viloyatRiMap: Record<string, { readingIndex: number; userCount: number }> =
    allViloyatStats?.viloyats ?? {};

  // Plan 05-02-fix FIX B + Plan 05-06 MAP-02 — iterate the backend-driven
  // viloyat list. The `v.id` here is the real Prisma cuid that matches
  // the keys in /admin/stats/viloyat/all. The 2-digit `v.code` ("01".."14")
  // is what L.geoJSON features carry in `properties.code` — passing it on
  // the data row lets ViloyatMap.lookupViloyat() join polygon → stats row
  // without a separate name match. Coords (lat/lon) are kept on the shape
  // for the legacy grid view + future tuman zoom (V2).
  // Plan 05-06-fix audit-MEDIUM — memoize so the array reference is stable
  // across unrelated re-renders. ViloyatMap's effect is keyed on [geoData,
  // data]; without useMemo, inline construction here would rebuild the L.geoJSON
  // layer (14 polygons + tooltips + popups + handlers) on every parent render —
  // causing flicker, lost hover state, and GC churn once Plan 05-07 streams
  // WebSocket updates into the stats query subscriptions.
  const mapData: ViloyatMapData[] = useMemo(
    () =>
      viloyatList.map((v) => {
        const coords = VILOYAT_COORDS[v.slug] ?? { lat: 41.3, lon: 63.5 };
        const libCount = allViloyatStats?.libraries?.[v.id] ?? 0;
        const vRi = viloyatRiMap[v.id];
        return {
          viloyatId: v.id,
          code: v.code,
          name: v.name,
          lat: coords.lat,
          lon: coords.lon,
          readingIndex: vRi?.readingIndex ?? 0,
          libraries: libCount,
          users: vRi?.userCount ?? 0
        };
      }),
    [viloyatList, allViloyatStats, viloyatRiMap]
  );

  return (
    <div className="space-y-4">
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="flex items-center gap-2.5 font-bold text-slate-900">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon.map aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={1.75} /></span>
              {t("mapTitle")}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {t("mapHint")}
            </p>
          </div>
          {national && (
            <div className="text-right">
              <p className="text-xs text-slate-400">{t("nationalRIShort")}</p>
              <p className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">{national.readingIndex.national}</p>
            </div>
          )}
        </div>

        <ViloyatMap
          data={mapData}
          onSelect={setSelectedViloyat}
          height="480px"
        />
      </div>

      {/* Tanlangan viloyat paneli */}
      {selectedViloyat && (
        <div className="rounded-3xl border border-brand-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-6 shadow-[0_10px_40px_-18px_rgba(37,99,235,0.30)]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-blue-900">{t("viloyatSuffix", { name: selectedViloyat.name })}</h3>
            <button
              onClick={() => setSelectedViloyat(null)}
              aria-label={t("close")}
              className="rounded-md p-1 text-brand-400 transition-colors hover:bg-blue-100 hover:text-brand-600"
            >
              <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl p-3 text-center shadow-sm">
              <p className="text-2xl font-extrabold tracking-tight text-brand-600">{selectedViloyat.readingIndex}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("readingIndexLabel")}</p>
            </div>
            <div className="bg-white rounded-2xl p-3 text-center shadow-sm">
              <p className="text-2xl font-extrabold tracking-tight text-emerald-600">{selectedViloyat.libraries}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("libraries")}</p>
            </div>
            <div className="bg-white rounded-2xl p-3 text-center shadow-sm">
              <p className="text-2xl font-extrabold tracking-tight text-violet-600">{selectedViloyat.users.toLocaleString()}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("readersLabel")}</p>
            </div>
          </div>
        </div>
      )}

      {/* Grid jadval — qo'shimcha ko'rinish */}
      <div className="card-surface rounded-2xl p-6">
        <h3 className="font-bold text-slate-900 mb-3">{t("viloyatTable")}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {mapData
            .sort((a, b) => b.readingIndex - a.readingIndex)
            .map((v, i) => {
              const color =
                v.readingIndex >= 70 ? "bg-green-50 border-green-200 text-green-700" :
                v.readingIndex >= 50 ? "bg-yellow-50 border-yellow-200 text-yellow-700" :
                                       "bg-red-50 border-red-200 text-red-700";
              return (
                <button
                  key={v.viloyatId}
                  onClick={() => setSelectedViloyat(v)}
                  className={`rounded-xl border p-3 text-left hover:shadow-sm transition-shadow ${color}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-current/60">#{i + 1}</span>
                    <span className="font-black">{v.readingIndex}</span>
                  </div>
                  <p className="font-semibold text-sm">{v.name}</p>
                  <div className="w-full bg-white/50 rounded-full h-1.5 mt-2">
                    <div className="bg-current h-1.5 rounded-full opacity-60" style={{ width: `${v.readingIndex}%` }} />
                  </div>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ── Kichik komponentlar ──────────────────────────────────────────────────────

function StatCard({
  icon: CardIcon, label, value, sub, tone = "blue"
}: {
  icon: LucideIcon; label: string; value: string; sub?: string;
  tone?: "blue" | "green" | "amber" | "violet";
}) {
  const reduce = useReducedMotion();
  const tones: Record<string, string> = {
    blue: "bg-brand-50 text-brand-600",
    green: "bg-green-50 text-green-600",
    amber: "bg-accent-50 text-accent-600",
    violet: "bg-violet-50 text-violet-600",
  };
  return (
    <motion.div
      variants={reduce ? undefined : fadeUp}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.15 }}
      className="card-surface rounded-xl p-5 transition-shadow hover:shadow-md"
    >
      <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${tones[tone] ?? tones.blue}`}>
        <CardIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
      </span>
      <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-slate-900 sm:text-3xl">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </motion.div>
  );
}

function GenderDonut({ male, total }: { male: number; female: number; total: number }) {
  // total = 0 (ma'lumot hali yig'ilmagan tuman) da male/total NaN beradi va
  // strokeDasharray="NaN NaN" bo'lib SVG umuman chizilmaydi.
  const malePct = total > 0 ? Math.round((male / total) * 100) : 0;
  const femalePct = 100 - malePct;

  return (
    <div className="relative w-20 h-20 shrink-0">
      <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#f0abfc" strokeWidth="3.5" />
        <circle
          cx="18" cy="18" r="15.9" fill="none" stroke="#3b82f6" strokeWidth="3.5"
          strokeDasharray={`${malePct} ${femalePct}`}
          strokeDashoffset="0"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-bold text-slate-700">{malePct}%</span>
      </div>
    </div>
  );
}

function TxBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex-1 flex flex-col items-center gap-2">
      <div className="relative w-full bg-surface-sunken rounded-lg" style={{ height: "80px" }}>
        <div
          className={`${color} rounded-lg absolute bottom-0 w-full transition-all`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-slate-500 text-center">{label}</p>
      <p className="text-xs font-bold text-slate-700">{fmt(count)}</p>
    </div>
  );
}

// ── Ma'lumotlar ──────────────────────────────────────────────────────────────

const TABS: { key: string; labelKey: string; icon: LucideIcon }[] = [
  { key: "overview", labelKey: "tabs.overview", icon: Icon.trendUp },
  { key: "genres",   labelKey: "tabs.genres", icon: Icon.book },
  { key: "shortage", labelKey: "tabs.shortage", icon: Icon.warning },
  { key: "map",      labelKey: "tabs.map", icon: Icon.map },
  // Plan 05-03 T3 — STAT-04/05/06 tabs.
  { key: "gender",       labelKey: "tabs.gender", icon: Icon.readers },
  { key: "age",          labelKey: "tabs.age", icon: Icon.calendar },
  { key: "genres-trend", labelKey: "tabs.genresTrend", icon: Icon.trendUp },
];

// Tarjima kaliti mavjud kutubxona tiplari (libTypes.* ns bilan mos).
const LIB_TYPE_KEYS: string[] = ["GOV", "SCH", "UNI", "ORG", "MAH"];

const LIB_COLORS: Record<string, string> = {
  GOV: "bg-brand-500", SCH: "bg-green-500",
  UNI: "bg-purple-500", ORG: "bg-orange-500", MAH: "bg-pink-500"
};
