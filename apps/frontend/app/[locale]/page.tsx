import Link from "next/link";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  LiveStatsRefresher,
  type LandingStats,
} from "@/components/landing/LiveStatsRefresher";
import { JsonLdStructuredData } from "@/components/landing/JsonLdStructuredData";
import {
  RegionsMap,
  type LandingRegion,
} from "@/components/landing/RegionsMap";
import { LandingTopTabs } from "@/components/landing/LandingTopTabs";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { HeroVisual } from "@/components/landing/HeroVisual";
import {
  TelegramIcon,
  FacebookIcon,
  InstagramIcon,
  YouTubeIcon,
} from "@/components/landing/SocialIcons";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { apiBase } from "@/lib/api/base";

/**
 * Landing page — SIFAT LIBRARY.
 *
 * DIZAYN TILI — institutsional:
 * - Toza ko'k palitra, oq kartalar, ko'p bo'shliq (davlat muassasasi ovozi)
 * - Bezak effektlari yo'q (orb / glassmorphism / gradient matn)
 * - Sotuv oqimi: har bo'limdan keyin aniq keyingi qadam bor, "Demo so'rash"
 *   yuqori panelda doim ko'rinib turadi
 * - Ma'lumot halol: raqam bo'lmasa "—", soxta ko'rsatkich chizilmaydi
 */

const API_BASE = apiBase();

export async function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Promise<Metadata> {
  const t = await getTranslations({
    locale: params.locale,
    namespace: "landing.meta",
  });
  const title = t("title");
  const description = t("description");
  return {
    title,
    description,
    keywords: [
      "SIFAT LIBRARY",
      "kitobxonlik",
      "O'zbekiston",
      "PQ-9",
      "kutubxona",
      "Reading Index",
      "milliy reyting",
    ],
    openGraph: {
      title: "SIFAT LIBRARY",
      description,
      type: "website",
      url: "https://sifat.uz",
      images: [{ url: "/icons/og-main.png", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "SIFAT LIBRARY",
      description,
      images: ["/icons/og-main.png"],
    },
  };
}

// ============================================================================
// MA'LUMOT QATLAMI
// ============================================================================

async function fetchLandingStats(): Promise<LandingStats | null> {
  try {
    const res = await fetch(`${API_BASE}/landing/stats`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchLandingRegions(): Promise<LandingRegion[] | null> {
  try {
    const res = await fetch(`${API_BASE}/landing/regions`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as LandingRegion[];
    return Array.isArray(data) && data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

async function fetchTopForLanding() {
  try {
    const res = await fetch(`${API_BASE}/top?limit=5`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchDonateStats() {
  try {
    const res = await fetch(`${API_BASE}/donate/stats`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ============================================================================
// QAYTA ISHLATILADIGAN BO'LAKLAR
// ============================================================================

function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "center",
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align?: "center" | "left";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <span className={`eyebrow ${align === "center" ? "justify-center" : ""}`}>
          {eyebrow}
        </span>
      )}
      <h2 className="mt-3 text-3xl font-bold text-brand-900 sm:text-4xl">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-base leading-relaxed text-slate-500">{subtitle}</p>
      )}
    </div>
  );
}

/** Xususiyat ro'yxati elementi — belgi + matn. */
function FeatureItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-slate-600">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50">
        <Icon.check
          aria-hidden="true"
          size={12}
          strokeWidth={2.5}
          className="text-brand-600"
        />
      </span>
      <span>{children}</span>
    </li>
  );
}

// ============================================================================
// STATIK TUZILMA
// ============================================================================

const ROLE_DEFS = [
  { key: "citizen", icon: Icon.readers },
  { key: "student", icon: Icon.school },
  { key: "teacher", icon: Icon.teacher },
  { key: "employee", icon: Icon.organization },
] as const;

const HOW_STEP_DEFS = [
  { key: "s1", icon: Icon.phone },
  { key: "s2", icon: Icon.library },
  { key: "s3", icon: Icon.stats },
] as const;

const B2B_DEFS = [
  { key: "schools", icon: Icon.school },
  { key: "universities", icon: Icon.university },
  { key: "orgs", icon: Icon.organization },
] as const;

const STORE_FEATURE_DEFS = [
  { key: "f1", icon: Icon.store },
  { key: "f2", icon: Icon.qr },
  { key: "f3", icon: Icon.star },
] as const;

const STORY_DEFS = [
  { key: "s1", icon: Icon.reader },
  { key: "s2", icon: Icon.school },
  { key: "s3", icon: Icon.family },
] as const;

const BADGE_DEFS = [
  { key: "b1", icon: Icon.book },
  { key: "b2", icon: Icon.streak },
  { key: "b3", icon: Icon.library },
  { key: "b4", icon: Icon.trophy },
  { key: "b5", icon: Icon.family },
  { key: "b6", icon: Icon.target },
  { key: "b7", icon: Icon.star },
  { key: "b8", icon: Icon.medal },
] as const;

const TELEGRAM_FEATURE_DEFS = [
  { key: "f1", icon: Icon.bell },
  { key: "f2", icon: Icon.bookClosed },
  { key: "f3", icon: Icon.award },
  { key: "f4", icon: Icon.stats },
  { key: "f5", icon: Icon.readers },
] as const;

// ============================================================================
// ASOSIY SERVER KOMPONENTI
// ============================================================================

export default async function HomePage({
  params,
}: {
  params: { locale: string };
}) {
  const locale = params.locale ?? "uz-Latn";
  const t = await getTranslations({ locale, namespace: "landing" });
  const format = await getFormatter({ locale });
  const fmt = (n: number) => format.number(Math.round(n));

  const [stats, regions, topData, donateStats] = await Promise.all([
    fetchLandingStats(),
    fetchLandingRegions(),
    fetchTopForLanding(),
    fetchDonateStats(),
  ]);

  const isLive = stats !== null;

  const stat = (v: number | undefined | null) =>
    typeof v === "number" ? fmt(v) : null;

  const heroStats = [
    { value: stat(stats?.users), label: t("hero.statReaders"), icon: Icon.readers },
    { value: stat(stats?.libraries), label: t("hero.statLibraries"), icon: Icon.library },
    { value: stat(stats?.books), label: t("hero.statBooks"), icon: Icon.bookClosed },
    {
      value:
        typeof stats?.readingIndex === "number"
          ? stats.readingIndex.toFixed(1)
          : null,
      label: t("hero.statRI"),
      icon: Icon.index,
    },
  ] as const;

  return (
    <main className="min-h-screen bg-surface-muted">
      <JsonLdStructuredData />
      <LandingHeader locale={locale} />

      {/* ================================================================== */}
      {/* 1. HERO — ikki ustun: matn + qidiruv | kutubxona vizuali           */}
      {/* ================================================================== */}
      <section className="hero-canvas relative overflow-hidden">
        <div className="relative mx-auto max-w-7xl px-4 pb-24 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-28">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            {/* Chap: matn + qidiruv */}
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-brand-700 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                {t("hero.badge")}
              </span>

              <h1 className="mt-6 text-4xl font-bold leading-[1.1] text-slate-900 sm:text-5xl lg:text-[3.5rem]">
                {t("hero.titleTop")}
                <br />
                <span className="text-brand-800">{t("hero.titleAccent")}</span>
              </h1>

              <p className="mt-5 max-w-lg text-base leading-relaxed text-slate-600">
                {t("hero.type1")}. {t("footer.about")}
              </p>

              {/* Qidiruv */}
              <form
                action={`/${locale}/search`}
                method="GET"
                className="mt-8 max-w-xl"
              >
                <div className="flex items-center gap-2 rounded-2xl border border-line bg-white p-2 shadow-[0_8px_28px_-14px_rgb(23_37_84/0.35)] focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10">
                  <Icon.search
                    aria-hidden="true"
                    size={ICON_SIZE.md}
                    className="ml-2.5 shrink-0 text-slate-400"
                  />
                  <input
                    type="search"
                    name="q"
                    placeholder={t("hero.searchPlaceholder")}
                    aria-label={t("hero.searchPlaceholder")}
                    className="h-11 min-w-0 flex-1 border-0 bg-transparent text-base text-slate-900 outline-none placeholder:text-slate-400 focus:outline-none focus:ring-0"
                  />
                  <button
                    type="submit"
                    className="h-11 shrink-0 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                  >
                    {t("hero.searchButton")}
                  </button>
                </div>
              </form>

              {/* Ishonch qatori */}
              <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
                {[
                  { icon: Icon.shield, label: t("hero.badge") },
                  { icon: Icon.locked, label: "Ma'lumotlar O'zbekistonda" },
                  { icon: Icon.offline, label: "Offline 12 soat" },
                ].map(({ icon: TrustIcon, label }) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-2 text-sm text-slate-500"
                  >
                    <TrustIcon aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {/* O'ng: kutubxona vizuali */}
            <div className="mx-auto w-full max-w-lg lg:max-w-none">
              <HeroVisual
                liveLabel={t("live.titleLive")}
                liveValue={stat(stats?.books)}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 2. KPI QATORI — hero ustiga chiqib turadigan kartalar              */}
      {/* ================================================================== */}
      <section className="relative z-10 -mt-14">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {heroStats.map(({ value, label, icon: StatIcon }) => (
              <div key={label} className="card-surface rounded-2xl p-5">
                <div className="flex items-center justify-between">
                  <p className="text-[0.6875rem] font-bold uppercase tracking-[0.1em] text-slate-400">
                    {label}
                  </p>
                  <StatIcon
                    aria-hidden="true"
                    size={ICON_SIZE.sm}
                    strokeWidth={1.75}
                    className="text-brand-400"
                  />
                </div>
                <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-slate-900 sm:text-3xl">
                  {value ?? "—"}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 3. XARITA + REYTING — referens maketdagi ikki ustunli blok         */}
      {/* ================================================================== */}
      <section id="xarita" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="card-surface rounded-3xl p-6 sm:p-8">
            <RegionsMap locale={locale} regions={regions} />
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 4. JONLI KO'RSATKICHLAR                                            */}
      {/* ================================================================== */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="mb-8 flex items-center gap-3">
            {isLive && <span className="live-dot" aria-hidden="true" />}
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
              {isLive ? t("live.titleLive") : t("live.titleStatic")}
            </span>
          </div>

          {stats ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {(
                [
                  { slot: "transactionsThisMonth", label: t("live.cardTransactions"), icon: Icon.book },
                  { slot: "libraries", label: t("live.cardLibraries"), icon: Icon.library },
                  { slot: "users", label: t("live.cardReaders"), icon: Icon.readers },
                  { slot: "books", label: t("live.cardBooks"), icon: Icon.bookClosed },
                ] as const
              ).map(({ slot, label, icon: CardIcon }) => (
                <div key={slot} className="rounded-2xl border border-line bg-surface-muted p-5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                    <CardIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.5} />
                  </span>
                  <p className="mt-4 text-2xl font-bold tabular-nums text-slate-900 sm:text-3xl">
                    <LiveStatsRefresher initialStats={stats} slot={slot} suffix="" />
                  </p>
                  <p className="mt-1.5 text-sm text-slate-500">{label}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-line p-10 text-center">
              <Icon.pending aria-hidden="true" size={32} className="mx-auto text-slate-300" />
              <p className="mt-3 text-sm text-slate-400">{t("map.legendPending")}</p>
            </div>
          )}
        </div>
      </section>

      {/* ================================================================== */}
      {/* 5. REYTINGLAR                                                      */}
      {/* ================================================================== */}
      <section id="reytinglar" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow={t("top.tabReaders")}
            title={t("top.title")}
            subtitle={t("top.subtitle")}
          />
          <div className="mt-10">
            <LandingTopTabs
              tabs={[
                t("top.tabReaders"),
                t("top.tabSchools"),
                t("top.tabRegions"),
                t("top.tabFamilies"),
              ]}
              entries={Array.isArray(topData) ? topData : (topData?.entries ?? [])}
              emptyTitle={t("top.emptyTitle")}
              emptyDesc={t("top.emptyDesc")}
              scoreLabel={t("top.score")}
              viewAllLabel={t("top.viewAll")}
              youTooLabel={t("top.youToo")}
              topHref={`/${locale}/top`}
            />
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 6. ROLLAR — referensdagi "Siz uchun maxsus imkoniyatlar"           */}
      {/* ================================================================== */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={t("roles.title")} subtitle={t("roles.subtitle")} />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ROLE_DEFS.map(({ key, icon: RoleIcon }) => (
              <div
                key={key}
                className="group flex flex-col rounded-2xl border border-line bg-surface-muted p-6 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-brand-600 shadow-sm">
                  <RoleIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                </span>
                <h3 className="mt-5 text-lg font-bold text-slate-900">
                  {t(`roles.${key}.label` as "roles.citizen.label")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  {t(`roles.${key}.desc` as "roles.citizen.desc")}
                </p>
                <ul className="mt-4 flex-1 space-y-2">
                  <FeatureItem>{t(`roles.${key}.f1` as "roles.citizen.f1")}</FeatureItem>
                  <FeatureItem>{t(`roles.${key}.f2` as "roles.citizen.f2")}</FeatureItem>
                  <FeatureItem>{t(`roles.${key}.f3` as "roles.citizen.f3")}</FeatureItem>
                </ul>
                <Link
                  href={`/${locale}/register`}
                  className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 transition-colors group-hover:text-brand-700"
                >
                  {t("roles.registerCta")}
                  <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 7. QANDAY ISHLAYDI                                                 */}
      {/* ================================================================== */}
      <section>
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={t("how.title")} subtitle={t("how.subtitle")} />
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {HOW_STEP_DEFS.map(({ key, icon: StepIcon }, i) => (
              <li key={key} className="card-surface rounded-2xl p-6">
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-900 text-base font-bold text-white">
                    {i + 1}
                  </span>
                  <StepIcon
                    aria-hidden="true"
                    size={ICON_SIZE.lg}
                    strokeWidth={1.5}
                    className="text-brand-200"
                  />
                </div>
                <h3 className="mt-5 text-base font-bold text-slate-900">
                  {t(`how.${key}Title` as "how.s1Title")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  {t(`how.${key}Desc` as "how.s1Desc")}
                </p>
                <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1 text-xs font-medium text-slate-500">
                  <Icon.pending aria-hidden="true" size={12} />
                  {t(`how.${key}Time` as "how.s1Time")}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 8. MUASSASALAR UCHUN (B2B) — asosiy sotuv bloki                    */}
      {/* ================================================================== */}
      <section id="muassasalar" className="scroll-mt-20 border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow={t("b2b.eyebrow")}
            title={`${t("b2b.titleTop")} ${t("b2b.titleAccent")}`}
            subtitle={t("b2b.subtitle")}
          />

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {B2B_DEFS.map(({ key, icon: B2bIcon }) => (
              <div
                key={key}
                className="flex flex-col rounded-2xl border border-line bg-surface-muted p-6"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
                    <B2bIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                  </span>
                  <h3 className="text-lg font-bold text-slate-900">
                    {t(`b2b.${key}.title` as "b2b.schools.title")}
                  </h3>
                </div>
                <ul className="mt-5 flex-1 space-y-2.5">
                  {(["f1", "f2", "f3", "f4", "f5"] as const).map((f) => (
                    <FeatureItem key={f}>
                      {t(`b2b.${key}.${f}` as "b2b.schools.f1")}
                    </FeatureItem>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Demo so'rovi — chuqur ko'k banner (referensdagi CTA bloki) */}
          <div className="ink-surface mt-10 overflow-hidden rounded-3xl p-8 sm:p-10">
            <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
              <div className="max-w-xl">
                <h3 className="text-2xl font-bold text-white">{t("b2b.demoTitle")}</h3>
                <p className="mt-3 text-sm leading-relaxed text-brand-100">
                  {t("b2b.demoDesc")}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {[
                    t("b2b.demoSchool"),
                    t("b2b.demoUniversity"),
                    t("b2b.demoOrg"),
                    t("b2b.demoMahalla"),
                  ].map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                <Link
                  href={`/${locale}/demo-request`}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-bold text-brand-900 transition-colors hover:bg-brand-50 active:scale-[0.98]"
                >
                  {t("b2b.demoCta")}
                  <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
                </Link>
                <a
                  href="mailto:hamkorlik@sifat.uz"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-white/25 px-6 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  <Icon.mail aria-hidden="true" size={ICON_SIZE.sm} />
                  hamkorlik@sifat.uz
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 9. NAMUNAVIY SSENARIYLAR                                           */}
      {/* ================================================================== */}
      <section>
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={t("stories.title")} subtitle={t("stories.subtitle")} />
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STORY_DEFS.map(({ key, icon: StoryIcon }) => (
              <figure key={key} className="card-surface flex flex-col rounded-2xl p-6">
                <figcaption className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-accent-700">
                  {t("stories.sampleBadge")}
                </figcaption>
                <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-slate-600">
                  {t(`stories.${key}Quote` as "stories.s1Quote")}
                </blockquote>
                <div className="mt-6 flex items-center gap-3 border-t border-line pt-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                    <StoryIcon aria-hidden="true" size={ICON_SIZE.sm} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {t(`stories.${key}Name` as "stories.s1Name")}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {t(`stories.${key}Meta` as "stories.s1Meta")}
                    </p>
                  </div>
                </div>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 10. BADGELAR                                                       */}
      {/* ================================================================== */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={t("badges.title")} subtitle={t("badges.subtitle")} />
          <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {BADGE_DEFS.map(({ key, icon: BadgeIcon }) => (
              <div
                key={key}
                className="flex flex-col items-center rounded-2xl border border-line bg-surface-muted p-5 text-center"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-50 text-accent-600">
                  <BadgeIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                </span>
                <p className="mt-3 text-sm font-semibold text-slate-900">
                  {t(`badges.${key}Name` as "badges.b1Name")}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  {t(`badges.${key}Desc` as "badges.b1Desc")}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 11. HAMKOR DO'KONLAR                                               */}
      {/* ================================================================== */}
      <section>
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={t("stores.title")} subtitle={t("stores.subtitle")} />
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STORE_FEATURE_DEFS.map(({ key, icon: StoreIcon }) => (
              <div key={key} className="card-surface flex flex-col rounded-2xl p-6">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-600">
                  <StoreIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                </span>
                <h3 className="mt-4 text-base font-bold text-slate-900">
                  {t(`stores.${key}Title` as "stores.f1Title")}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  {t(`stores.${key}Desc` as "stores.f1Desc")}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href={`/${locale}/dokon`}
              className="inline-flex h-12 items-center justify-center rounded-xl bg-brand-600 px-7 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 active:scale-[0.98]"
            >
              {t("stores.browse")}
            </Link>
            <Link
              href={`/${locale}/demo-request`}
              className="inline-flex h-12 items-center justify-center rounded-xl border border-line-strong bg-white px-7 text-base font-medium text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98]"
            >
              {t("stores.connect")}
            </Link>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 12. TELEGRAM BOT                                                   */}
      {/* ================================================================== */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
                <TelegramIcon size={24} />
              </span>
              <h2 className="mt-5 text-2xl font-bold text-brand-900 sm:text-3xl">
                {t("telegram.title")}
              </h2>
              <ul className="mt-6 space-y-3">
                {TELEGRAM_FEATURE_DEFS.map(({ key, icon: TgIcon }) => (
                  <li
                    key={key}
                    className="flex items-start gap-3 rounded-xl border border-line bg-surface-muted px-4 py-3 text-sm text-slate-600"
                  >
                    <TgIcon
                      aria-hidden="true"
                      size={ICON_SIZE.sm}
                      className="mt-0.5 shrink-0 text-sky-600"
                    />
                    <span>{t(`telegram.${key}` as "telegram.f1")}</span>
                  </li>
                ))}
              </ul>
              <a
                href="https://t.me/SifatLibraryBot"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-8 inline-flex h-12 items-center gap-2 rounded-xl bg-sky-500 px-6 text-sm font-bold text-white shadow-sm transition-colors hover:bg-sky-600 active:scale-[0.98]"
              >
                <TelegramIcon size={18} />
                @SifatLibraryBot
              </a>
            </div>

            <div className="card-surface flex flex-col items-center justify-center rounded-2xl p-10 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
                <TelegramIcon size={32} />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-700">
                {t("telegram.qrLabel")}
              </p>
              <div className="mx-auto mt-5 flex h-40 w-40 items-center justify-center rounded-2xl border-2 border-dashed border-line-strong bg-surface-muted text-slate-300">
                <Icon.qr aria-hidden="true" size={56} strokeWidth={1} />
              </div>
              <p className="mt-4 text-xs text-slate-400">{t("telegram.qrCaption")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 13. DONAT                                                          */}
      {/* ================================================================== */}
      <section id="donat" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="ink-surface overflow-hidden rounded-3xl px-6 py-14 sm:px-12">
            <div className="mx-auto max-w-3xl text-center">
              <span className="eyebrow justify-center !text-accent-300">
                {t("donate.transparent")}
              </span>
              <h2 className="mt-3 text-3xl font-bold text-white sm:text-4xl">
                {t("donate.title")}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-brand-100">
                {t("donate.subtitle")}
              </p>
            </div>

            {donateStats ? (
              <div className="mx-auto mt-10 grid max-w-3xl gap-6 border-t border-white/10 pt-8 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-white/10">
                {(
                  [
                    { v: stat(donateStats.totalCollected), l: t("donate.collected") },
                    { v: stat(donateStats.totalSpent), l: t("donate.spent") },
                    { v: stat(donateStats.donorCount), l: t("donate.donors") },
                  ] as const
                ).map((s) => (
                  <div key={s.l} className="px-6 text-center">
                    <p className="text-2xl font-bold tabular-nums leading-none text-accent-300 sm:text-3xl">
                      {s.v ?? "—"}
                    </p>
                    <p className="mt-2 text-sm text-brand-100">{s.l}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mx-auto mt-10 max-w-md text-center text-sm text-brand-100/70">
                {t("donate.statsPending")}
              </p>
            )}

            <div className="mt-10 text-center">
              <Link
                href={`/${locale}/donate`}
                className="inline-flex items-center gap-2 rounded-xl bg-accent-400 px-7 py-3.5 text-base font-bold text-brand-950 transition-colors hover:bg-accent-300 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-300 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-900"
              >
                <Icon.donate aria-hidden="true" size={ICON_SIZE.sm} />
                {t("donate.cta")}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 14. MOBIL ILOVA                                                    */}
      {/* ================================================================== */}
      <section className="border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="eyebrow">{t("app.title")}</span>
              <h2 className="mt-3 text-3xl font-bold text-brand-900 sm:text-4xl">
                {t.rich("app.desc", {
                  b: (chunks) => <b className="text-brand-600">{chunks}</b>,
                })}
              </h2>
              <ul className="mt-6 space-y-2.5">
                {(["f1", "f2", "f3", "f4"] as const).map((f) => (
                  <FeatureItem key={f}>{t(`app.${f}` as "app.f1")}</FeatureItem>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-slate-300"><path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.78 22.05 6.8 20.68 5.96 19.47C4.25 17 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5M13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z"/></svg>
                  {t("app.iosSub")}
                </span>
                <span className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-slate-300"><path d="M3 20.5V3.5C3 2.91 3.34 2.39 3.84 2.15L13.69 12L3.84 21.85C3.34 21.6 3 21.09 3 20.5M16.81 15.12L6.05 21.34L14.54 12.85L16.81 15.12M20.16 10.81C20.5 11.08 20.75 11.5 20.75 12C20.75 12.5 20.53 12.9 20.18 13.18L17.89 14.5L15.39 12L17.89 9.5L20.16 10.81M6.05 2.66L16.81 8.88L14.54 11.15L6.05 2.66Z"/></svg>
                  {t("app.androidSub")}
                </span>
              </div>
            </div>

            {/* Telefon maketi */}
            <div className="relative mx-auto w-full max-w-xs">
              <div className="relative rounded-[2rem] border-[6px] border-line-strong bg-white shadow-2xl shadow-brand-950/10">
                <div className="flex items-center justify-between rounded-t-[1.5rem] bg-brand-900 px-5 py-2.5">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-white/80"><LogoMark size={14} tone="white" />SIFAT</span>
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-white/60" />
                    <span className="h-1.5 w-1.5 rounded-full bg-white/60" />
                    <span className="h-1.5 w-1.5 rounded-full bg-white/60" />
                  </div>
                </div>
                <div className="space-y-3 p-4">
                  <div className="rounded-xl bg-brand-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-brand-500">
                      Reading Index
                    </p>
                    <p className="mt-1 text-3xl font-bold text-brand-800">—</p>
                    <p className="mt-1 text-xs text-slate-400">{t("app.mockRI")}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-line bg-surface-muted p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        {t("app.mockToday")}
                      </p>
                      <p className="mt-1 text-lg font-bold text-slate-700">—</p>
                    </div>
                    <div className="rounded-xl border border-line bg-surface-muted p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        {t("app.mockStreak")}
                      </p>
                      <p className="mt-1 text-lg font-bold text-slate-700">—</p>
                    </div>
                  </div>
                  <div className="rounded-xl bg-accent-50 p-3">
                    <div className="flex items-center gap-2">
                      <Icon.trophy aria-hidden="true" size={16} className="text-accent-600" />
                      <p className="text-xs font-semibold text-accent-700">Top o&apos;quvchi</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 15. FOOTER                                                         */}
      {/* ================================================================== */}
      <footer className="border-t border-line bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {/* Brend */}
            <div className="lg:col-span-1">
              <div className="flex items-center gap-2.5">
                <LogoMark size={34} className="shrink-0" />
                <Wordmark className="text-[1.0625rem]" />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-slate-500">
                {t("footer.about")}
              </p>
              <div className="mt-5 flex gap-2">
                {[
                  { href: "https://t.me/sifat_uz", label: "Telegram", Ic: TelegramIcon },
                  { href: "#", label: "Facebook", Ic: FacebookIcon },
                  { href: "#", label: "Instagram", Ic: InstagramIcon },
                  { href: "#", label: "YouTube", Ic: YouTubeIcon },
                ].map(({ href, label, Ic }) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-white text-slate-500 transition-colors hover:border-brand-300 hover:text-brand-600"
                  >
                    <Ic />
                  </a>
                ))}
              </div>
            </div>

            {/* Sahifalar */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-900">
                {t("footer.pagesTitle")}
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                {[
                  { href: `/${locale}/top`, label: t("footer.linkTop") },
                  { href: `/${locale}/donate`, label: t("footer.linkDonate") },
                  { href: `/${locale}/search`, label: t("footer.linkSearch") },
                  { href: `/${locale}/register`, label: t("footer.linkRegister") },
                  { href: `/${locale}/demo-request`, label: t("footer.linkDemo") },
                ].map(({ href, label }) => (
                  <li key={href}>
                    <Link href={href} className="text-slate-500 transition-colors hover:text-brand-600">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Bog'lanish */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-900">
                {t("footer.contactTitle")}
              </h3>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li>
                  <a href="mailto:info@sifat.uz" className="text-slate-500 transition-colors hover:text-brand-600">
                    info@sifat.uz
                  </a>
                </li>
                <li>
                  <a href="mailto:hamkorlik@sifat.uz" className="text-slate-500 transition-colors hover:text-brand-600">
                    hamkorlik@sifat.uz
                  </a>
                </li>
                <li>
                  <a
                    href="https://t.me/SifatLibraryBot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-500 transition-colors hover:text-brand-600"
                  >
                    @SifatLibraryBot
                  </a>
                </li>
                <li>
                  <Link href={`/${locale}/privacy`} className="text-slate-500 transition-colors hover:text-brand-600">
                    {t("footer.privacy")}
                  </Link>
                </li>
              </ul>
            </div>

            {/* Muassasalar uchun CTA */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-900">
                {t("b2b.eyebrow")}
              </h3>
              <p className="mt-4 text-sm leading-relaxed text-slate-500">
                {t("b2b.demoDesc")}
              </p>
              <Link
                href={`/${locale}/demo-request`}
                className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
              >
                {t("b2b.demoCta")}
                <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
              </Link>
            </div>
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-line pt-6 sm:flex-row">
            <p className="text-xs text-slate-400">{t("footer.copyright")}</p>
            <p className="text-xs text-slate-400">{t("footer.since")}</p>
          </div>
        </div>
      </footer>
    </main>
  );
}
