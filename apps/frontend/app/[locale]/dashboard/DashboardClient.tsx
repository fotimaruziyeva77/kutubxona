"use client";

// Plan 05-02 Task 3 (STAT-02) — SSR-prefetch qilingan statistikani `useQuery`
// `initialData` sifatida iste'mol qiluvchi klient komponenti.
//
// DIZAYN QAYTA ISHLANDI (DESIGN.md): emoji + gradient + rangli soya o'rniga
// lucide ikonkalari, yumshoq kartalar va motion kirish animatsiyasi. Bu panel
// har kuni administratorlar oldida turadi — u tinch, o'qishga qulay va bir
// qarashda tushunarli bo'lishi kerak.

import { useQuery } from "@tanstack/react-query";
import { fmtNumber } from "@/lib/format";
import Link from "next/link";
import { useLocale } from "next-intl";
import { motion, useReducedMotion } from "motion/react";
import { apiClient } from "@/lib/api-client";
import { responseErrorMessage } from "@/lib/api-error";
import { useAuthStore } from "@/store/auth.store";
import { getViloyatlar, getTumanlar } from "@/lib/api/geo";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { ALERT_TYPE_LABELS } from "@/lib/alert-types.const";
import { SkeletonStatGrid } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { fadeUp, staggerContainer } from "@/lib/motion";

type NationalStats = {
  users: { total: number; active30d: number; newThisMonth: number; byGender: Record<string, number> };
  libraries: { total: number; byType: Record<string, number> };
  books: { total: number; available: number };
  transactions: { thisMonth: number; lastMonth: number; returned: number; growth: number };
  readingIndex: { national: number };
};

type Alert = {
  id: string;
  scope: string;
  issueType: string;
  severity: string;
  analysis: string;
  recommendation: string;
  createdAt: string;
};

async function fetchNationalStats(): Promise<NationalStats> {
  const res = await apiClient("/admin/stats/national");
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}

async function fetchAlerts(): Promise<Alert[]> {
  const res = await apiClient("/admin/alerts?limit=5");
  if (!res.ok) return [];
  return res.json();
}

// RBAC geo-scoping (Audit 2026-06) — /admin/stats/national SUPER_ADMIN-only.
// VILOYAT/TUMAN adminlar o'z hududini /admin/stats/viloyat|tuman/:id orqali oladi.
type ScopedStats = {
  libraries: number;
  users: number;
  transactions30d?: number;
  transactionsThisMonth?: number;
  readingIndex: number;
  activeAlerts?: number;
};

async function fetchScopedStats(url: string): Promise<ScopedStats> {
  const res = await apiClient(url);
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}

const fmt = (n: number) => fmtNumber(n);

const TYPE_LABEL: Record<string, string> = {
  GOV: "Davlat", SCH: "Maktab", UNI: "OTM", ORG: "Idora", MAH: "Mahalla",
};

const SEV_STYLE: Record<string, { wrap: string; icon: LucideIcon; tone: string }> = {
  HIGH: { wrap: "bg-red-50 border-red-200", icon: Icon.warning, tone: "text-red-600" },
  MEDIUM: { wrap: "bg-amber-50 border-amber-200", icon: Icon.warning, tone: "text-accent-600" },
  LOW: { wrap: "bg-blue-50 border-brand-200", icon: Icon.info, tone: "text-brand-600" },
};

export default function DashboardClient({ initialStats }: { initialStats: NationalStats | null }) {
  const locale = useLocale();
  const { user } = useAuthStore();
  const role = user?.role ?? "";
  const scopeKind: "national" | "viloyat" | "tuman" =
    role === "VILOYAT_ADMIN" ? "viloyat" : role === "TUMAN_ADMIN" ? "tuman" : "national";
  const myViloyatId = user?.address?.viloyatId ?? "";
  const myTumanId = user?.address?.tumanId ?? "";

  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    error: statsErr,
    refetch: refetchStats,
    isFetching: statsFetching,
  } = useQuery({
    queryKey: ["national-stats"],
    queryFn: fetchNationalStats,
    staleTime: 300_000,
    enabled: scopeKind === "national",
    initialData: initialStats ?? undefined,
  });

  const {
    data: scoped,
    isLoading: scopedLoading,
    isError: scopedError,
    error: scopedErr,
    refetch: refetchScoped,
    isFetching: scopedFetching,
  } = useQuery({
    queryKey: ["home-scoped-stats", scopeKind, myViloyatId, myTumanId],
    queryFn: () =>
      fetchScopedStats(
        scopeKind === "viloyat"
          ? `/admin/stats/viloyat/${myViloyatId}`
          : `/admin/stats/tuman/${myTumanId}`,
      ),
    enabled:
      (scopeKind === "viloyat" && !!myViloyatId) ||
      (scopeKind === "tuman" && !!myTumanId),
    staleTime: 300_000,
  });

  const { data: viloyatList = [] } = useQuery({
    queryKey: ["dash-viloyat-list"],
    queryFn: getViloyatlar,
    enabled: scopeKind !== "national",
    staleTime: 60 * 60 * 1000,
  });
  const { data: tumanList = [] } = useQuery({
    queryKey: ["dash-tuman-list", myViloyatId],
    queryFn: () => getTumanlar(myViloyatId),
    enabled: scopeKind === "tuman" && !!myViloyatId,
    staleTime: 60 * 60 * 1000,
  });

  // ── Tier admin uchun hududiy bosh panel ──
  if (scopeKind !== "national") {
    const regionName =
      scopeKind === "viloyat"
        ? viloyatList.find((v) => v.id === myViloyatId)?.name
        : tumanList.find((t) => t.id === myTumanId)?.name;
    return (
      <ScopedHome
        locale={locale}
        scopeKind={scopeKind}
        regionName={regionName}
        data={scoped}
        loading={scopedLoading}
        isError={scopedError}
        errorMessage={(scopedErr as Error)?.message}
        onRetry={() => refetchScoped()}
        isRetrying={scopedFetching}
      />
    );
  }

  const txGrowth = stats?.transactions.growth ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Bosh panel"
        subtitle="Milliy kitobxonlik ko'rsatkichlarining umumiy manzarasi"
        action={
          <Link
            href={`/${locale}/dashboard/stats`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:active:scale-100"
          >
            To'liq statistika
            <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
          </Link>
        }
      />

      {statsLoading && !initialStats ? (
        <SkeletonStatGrid count={4} />
      ) : statsError ? (
        <ErrorState
          message={(statsErr as Error)?.message ?? "Statistikani yuklab bo'lmadi"}
          onRetry={() => refetchStats()}
          isRetrying={statsFetching}
        />
      ) : (
        <>
          {/* KPI kartalar — ketma-ket (stagger) kirish */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-2 gap-4 lg:grid-cols-4"
          >
            <KpiCard
              icon={Icon.readers}
              label="Jami kitobxonlar"
              value={stats ? fmt(stats.users.total) : "—"}
              sub={stats ? `${fmt(stats.users.active30d)} faol (30 kun)` : ""}
            />
            <KpiCard
              icon={Icon.library}
              label="Jami kutubxonalar"
              value={stats ? fmt(stats.libraries.total) : "—"}
              sub={stats ? `${fmt(stats.books.available)} kitob mavjud` : ""}
            />
            <KpiCard
              icon={Icon.refresh}
              label="Bu oy tranzaksiyalar"
              value={stats ? fmt(stats.transactions.thisMonth) : "—"}
              trend={txGrowth}
              sub={txGrowth !== 0 ? "o'tgan oyga nisbatan" : ""}
            />
            <KpiCard
              icon={Icon.index}
              label="Milliy Reading Index"
              value={stats ? `${stats.readingIndex.national}` : "—"}
              sub="O'rtacha ball (30 kun)"
            />
          </motion.div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Kutubxona tiplari */}
            {stats?.libraries.byType && (
              <Panel title="Kutubxona tiplari" icon={Icon.library}>
                <div className="space-y-3">
                  {Object.entries(stats.libraries.byType).map(([type, count]) => {
                    const pct = stats.libraries.total > 0
                      ? Math.round((count / stats.libraries.total) * 100) : 0;
                    return (
                      <BarRow
                        key={type}
                        label={TYPE_LABEL[type] ?? type}
                        value={fmt(count)}
                        pct={pct}
                        color="bg-brand-500"
                      />
                    );
                  })}
                </div>
              </Panel>
            )}

            {/* Gender taqsimoti */}
            {stats?.users.byGender && (
              <Panel title="Gender taqsimoti" icon={Icon.readers}>
                <div className="space-y-4">
                  {[
                    { key: "MALE", label: "Erkaklar", color: "bg-brand-500" },
                    { key: "FEMALE", label: "Ayollar", color: "bg-pink-500" },
                  ].map(({ key, label, color }) => {
                    const count = stats.users.byGender[key] ?? 0;
                    const total = (stats.users.byGender.MALE ?? 0) + (stats.users.byGender.FEMALE ?? 0);
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                      <BarRow
                        key={key}
                        label={label}
                        value={`${pct}% · ${fmt(count)}`}
                        pct={pct}
                        color={color}
                      />
                    );
                  })}
                </div>
                <div className="mt-4 flex justify-between border-t border-line pt-4 text-sm">
                  <span className="text-slate-500">Yangi bu oy</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-green-600">
                    <Icon.trendUp aria-hidden="true" size={ICON_SIZE.xs} />
                    {fmt(stats.users.newThisMonth)}
                  </span>
                </div>
              </Panel>
            )}

            {/* Tezkor havolalar */}
            <Panel title="Tezkor havolalar" icon={Icon.sparkle}>
              <div className="space-y-1.5">
                {QUICK_LINKS.map((link) => (
                  <QuickLink key={link.href} locale={locale} {...link} />
                ))}
              </div>
            </Panel>
          </div>
        </>
      )}

      <AlertsBlock locale={locale} />
    </div>
  );
}

// ── Tier admin (VILOYAT/TUMAN) hududiy bosh panel ──
function ScopedHome({
  locale,
  scopeKind,
  regionName,
  data,
  loading,
  isError,
  errorMessage,
  onRetry,
  isRetrying,
}: {
  locale: string;
  scopeKind: "viloyat" | "tuman";
  regionName?: string;
  data: ScopedStats | undefined;
  loading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const tx = data?.transactions30d ?? data?.transactionsThisMonth ?? 0;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Bosh panel"
        subtitle="Sizning hududingizdagi kitobxonlik ko'rsatkichlari"
        badge={
          regionName
            ? { label: regionName, sub: scopeKind === "tuman" ? "tuman" : "viloyat" }
            : undefined
        }
        action={
          <Link
            href={`/${locale}/dashboard/stats`}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-reduce:active:scale-100"
          >
            To'liq statistika
            <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
          </Link>
        }
      />

      {loading && !data ? (
        <SkeletonStatGrid count={4} />
      ) : isError ? (
        <ErrorState
          message={errorMessage ?? "Statistikani yuklab bo'lmadi"}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      ) : (
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-2 gap-4 lg:grid-cols-4"
        >
          <KpiCard icon={Icon.readers} label="Kitobxonlar" value={data ? fmt(data.users) : "—"} sub="hududingiz bo'yicha" />
          <KpiCard icon={Icon.library} label="Kutubxonalar" value={data ? fmt(data.libraries) : "—"} sub="faol" />
          <KpiCard icon={Icon.refresh} label="Tranzaksiyalar" value={data ? fmt(tx) : "—"} sub={scopeKind === "tuman" ? "bu oy" : "30 kun"} />
          <KpiCard icon={Icon.index} label="Reading Index" value={data ? `${data.readingIndex}` : "—"} sub="o'rtacha ball (30 kun)" />
        </motion.div>
      )}

      <Panel title="Tezkor havolalar" icon={Icon.sparkle}>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {SCOPED_QUICK_LINKS.map((link) => (
            <QuickLink key={link.href} locale={locale} {...link} />
          ))}
        </div>
      </Panel>

      <AlertsBlock locale={locale} />
    </div>
  );
}

function AlertsBlock({ locale }: { locale: string }) {
  const { data: alerts = [] } = useQuery({
    queryKey: ["smart-alerts"],
    queryFn: fetchAlerts,
    staleTime: 60_000,
  });
  if (alerts.length === 0) return null;
  return (
    <Panel
      title="Faol ogohlantirishlar"
      icon={Icon.bell}
      badge={String(alerts.length)}
      action={
        <Link
          href={`/${locale}/dashboard/alerts`}
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          Barchasi
        </Link>
      }
    >
      <div className="space-y-2">
        {alerts.slice(0, 3).map((alert) => {
          const sv = SEV_STYLE[alert.severity] ?? SEV_STYLE.LOW;
          const SvIcon = sv.icon;
          return (
            <div
              key={alert.id}
              className={`flex items-start gap-3 rounded-lg border p-3 ${sv.wrap}`}
            >
              <SvIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2} className={`mt-0.5 shrink-0 ${sv.tone}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-900">
                  {/* Xom enum ("RI_DROPPED") o'rniga tayyor o'zbekcha yorliq;
                      xaritada bo'lmagan yangi tur o'qilishi mumkin matnga
                      yumshatiladi. */}
                  {ALERT_TYPE_LABELS[alert.issueType]?.uz
                    ?? alert.issueType.replace(/_/g, " ").toLowerCase().replace(/^./, (c: string) => c.toUpperCase())}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">{alert.analysis}</p>
              </div>
              <span className="ml-auto shrink-0 text-xs text-slate-400">
                {new Date(alert.createdAt).toLocaleDateString("uz-UZ")}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── Qayta ishlatiladigan kichik komponentlar ────────────────────────────────

function PageHeader({
  title,
  subtitle,
  action,
  badge,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  badge?: { label: string; sub: string };
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        {badge && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-brand-700">
            <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
            {badge.label}
            <span className="text-xs font-normal text-brand-400">{badge.sub}</span>
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

function Panel({
  title,
  icon: PanelIcon,
  badge,
  action,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  badge?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      variants={reduce ? undefined : fadeUp}
      initial={reduce ? undefined : "hidden"}
      whileInView={reduce ? undefined : "visible"}
      viewport={{ once: true, margin: "-40px" }}
      className="card-surface rounded-xl p-6"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          {PanelIcon && (
            <PanelIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={1.75} className="text-slate-400" />
          )}
          {title}
          {badge && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
              {badge}
            </span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </motion.section>
  );
}

function BarRow({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: string;
  pct: number;
  color: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold text-slate-900">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        {/* Chiziq kenglikning 0 dan pct gacha o'sishi — ma'lumot "to'lyapti"
            hissini beradi (DESIGN.md §10). Reduced-motion'da darhol to'liq. */}
        <motion.div
          className={`h-2 rounded-full ${color}`}
          initial={reduce ? false : { width: 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
    </div>
  );
}

function KpiCard({
  icon: CardIcon,
  label,
  value,
  sub,
  trend,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  /** Foizli o'zgarish — musbat yashil, manfiy qizil o'q bilan. */
  trend?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      variants={reduce ? undefined : fadeUp}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ duration: 0.15 }}
      className="card-surface rounded-xl p-5 transition-shadow hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <CardIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
        </span>
        {typeof trend === "number" && trend !== 0 && (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
              trend >= 0 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}
          >
            {trend >= 0 ? (
              <Icon.trendUp aria-hidden="true" size={12} />
            ) : (
              <Icon.trendDown aria-hidden="true" size={12} />
            )}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-slate-900 sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </motion.div>
  );
}

function QuickLink({
  locale,
  href,
  icon: LinkIcon,
  label,
}: {
  locale: string;
  href: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      href={`/${locale}/${href}`}
      className="group flex items-center gap-3 rounded-lg border border-line bg-white p-3 transition-colors hover:border-line-strong hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
        <LinkIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={1.75} />
      </span>
      <span className="text-sm font-medium text-slate-700 group-hover:text-brand-600">
        {label}
      </span>
      <Icon.next
        aria-hidden="true"
        size={ICON_SIZE.sm}
        className="ml-auto text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-600"
      />
    </Link>
  );
}

const QUICK_LINKS: { href: string; icon: LucideIcon; label: string }[] = [
  { href: "dashboard/stats", icon: Icon.stats, label: "To'liq statistika paneli" },
  { href: "dashboard/alerts", icon: Icon.bell, label: "Smart alertlar" },
  { href: "dashboard/transactions", icon: Icon.refresh, label: "Kitob jarayonlari" },
  { href: "dashboard/libraries", icon: Icon.library, label: "Kutubxonalar" },
  { href: "top", icon: Icon.trophy, label: "Top-100 reyting" },
  { href: "dashboard/users/pending", icon: Icon.pending, label: "Tasdiqlash kutmoqda" },
];

const SCOPED_QUICK_LINKS: { href: string; icon: LucideIcon; label: string }[] = [
  { href: "dashboard/stats", icon: Icon.stats, label: "To'liq statistika paneli" },
  { href: "dashboard/alerts", icon: Icon.bell, label: "Smart alertlar" },
  { href: "dashboard/libraries", icon: Icon.library, label: "Kutubxonalar" },
  { href: "dashboard/users/pending", icon: Icon.pending, label: "Tasdiqlash kutmoqda" },
  { href: "dashboard/family", icon: Icon.family, label: "Oila reytingi" },
  { href: "top", icon: Icon.trophy, label: "Top-100 reyting" },
];
