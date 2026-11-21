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
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { LandingBooks } from "@/components/landing/LandingBooks";
import QRCode from "qrcode";
import { TelegramIcon } from "@/components/landing/SocialIcons";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { BookCover } from "@/components/books/BookCover";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { apiBase } from "@/lib/api/base";
import { SITE_URL } from "@/lib/site";

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
  const url = `${SITE_URL}/${params.locale}`;
  return {
    // absolute — layout shabloni ("%s | SIFAT LIBRARY") brendni takrorlamasin.
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    keywords: [
      "SIFAT LIBRARY",
      "Sifat Library",
      "sifatlibrary",
      "sifatlibrary.uz",
      "Sifat kutubxona",
      "elektron kutubxona",
      "kitob bron qilish",
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
      url,
      siteName: "SIFAT LIBRARY",
      images: [{ url: `${SITE_URL}/og-image.png`, width: 1200, height: 630, alt: "SIFAT LIBRARY" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "SIFAT LIBRARY",
      description,
      images: [`${SITE_URL}/og-image.png`],
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

type LandingBook = {
  id: string;
  title: string;
  author: string;
  genre?: string | null;
  hasCover: boolean;
  updatedAt?: string;
  availableCount: number;
  library?: { name: string; code?: string | null } | null;
};

/**
 * Fondga yangi qo'shilgan kitoblar — faqat FAOL kutubxonalardan (bron qilib
 * bo'ladigan). Muqova data-URL'i HTML'ga qo'yilmaydi: faqat bor-yo'qligi
 * olinadi, rasm /api/books/:id/cover orqali alohida keshlanib yuklanadi.
 */
async function fetchNewBooks(): Promise<LandingBook[]> {
  try {
    const res = await fetch(`${API_BASE}/books?limit=24&activeLibraries=true`, {
      next: { revalidate: 120 },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list: Array<Record<string, unknown>> = Array.isArray(json) ? json : (json?.data ?? []);
    // Bir xil kitob bir necha kutubxonada bo'lsa — bir marta ko'rsatamiz.
    const seen = new Set<string>();
    const unique = list.filter((b) => {
      const key = `${String(b.title ?? "").trim()}|${String(b.author ?? "").trim()}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, 6).map((b) => ({
      id: String(b.id),
      title: String(b.title ?? ""),
      author: String(b.author ?? ""),
      genre: (b.genre as string) ?? null,
      hasCover: typeof b.coverUrl === "string" && b.coverUrl.length > 0,
      updatedAt: (b.updatedAt as string) ?? undefined,
      availableCount: Number(b.availableCount ?? 0),
      library: (b.library as LandingBook["library"]) ?? null,
    }));
  } catch {
    return [];
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

const AUDIENCE_DEFS = [
  { key: "reader", icon: Icon.readers, href: "/register", primary: true },
  { key: "library", icon: Icon.school, href: "#muassasalar", primary: false },
  { key: "org", icon: Icon.organization, href: "#muassasalar", primary: false },
  { key: "gov", icon: Icon.stats, href: "#muassasalar", primary: false },
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
  const tv = await getTranslations({ locale, namespace: "LandingV2" });
  const telegramQr = await QRCode.toString("https://t.me/SifatLibraryBot", {
    type: "svg",
    margin: 1,
    color: { dark: "#0c4a6e", light: "#ffffff" },
  }).catch(() => null);
  const format = await getFormatter({ locale });
  const fmt = (n: number) => format.number(Math.round(n));

  const [stats, regions, topData, donateStats, newBooks] = await Promise.all([
    fetchLandingStats(),
    fetchLandingRegions(),
    fetchTopForLanding(),
    fetchDonateStats(),
    fetchNewBooks(),
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
      <JsonLdStructuredData locale={params.locale} />
      <LandingHeader locale={locale} />

      {/* ================================================================== */}
      {/* 1. HERO — ikki ustun: matn + qidiruv | kutubxona vizuali           */}
      {/* ================================================================== */}
      <section className="hero-canvas relative overflow-hidden">
        <ScrollReveal />
        <div aria-hidden="true" className="hero-orb hero-orb-a" />
        <div aria-hidden="true" className="hero-orb hero-orb-b" />
        <div className="relative mx-auto max-w-7xl px-4 pb-24 pt-12 sm:px-6 sm:pt-16 lg:px-8 lg:pb-28">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            {/* Chap: matn + qidiruv */}
            <div className="hero-enter">
              <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-brand-700 shadow-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                {t("hero.badge")}
              </span>

              <h1 className="mt-6 text-4xl font-bold leading-[1.1] text-slate-900 sm:text-5xl lg:text-[3.5rem]">
                <span className="sr-only">SIFAT LIBRARY — </span>
                {tv("heroTop")}
                <br />
                <span className="text-shimmer">{tv("heroAccent")}</span>
              </h1>

              <p className="mt-5 max-w-lg text-base leading-relaxed text-slate-600">
                {tv("heroLead")}
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
                  { icon: Icon.locked, label: t("hero.trustData") },
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
            <div className="hero-enter mx-auto w-full max-w-lg lg:max-w-none">
              {newBooks.length >= 3 ? (
                <a href="#kitoblar" aria-label={tv("heroBrowse")} className="hero-books block">
                  <div className="hero-books-stage">
                    {newBooks.slice(0, 5).map((b, i) => (
                      <div key={b.id} className={`hero-book hero-book-${i}`}>
                        <BookCover
                          size="lg"
                          title={b.title}
                          author={b.author}
                          genre={b.genre}
                          coverUrl={
                            b.hasCover
                              ? `/api/books/${b.id}/cover${b.updatedAt ? `?v=${encodeURIComponent(b.updatedAt)}` : ""}`
                              : null
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {stat(stats?.books) && (
                    <div className="hero-books-badge card-surface flex items-center gap-3 rounded-2xl px-4 py-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-50 text-green-600">
                        <Icon.book aria-hidden="true" size={ICON_SIZE.sm} />
                      </span>
                      <span>
                        <span className="block text-xl font-bold leading-none text-slate-900">{stat(stats?.books)}</span>
                        <span className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                          <span aria-hidden="true" className="live-dot h-1.5 w-1.5 rounded-full bg-green-500" />
                          {tv("heroFund")}
                        </span>
                      </span>
                    </div>
                  )}
                </a>
              ) : (
                <HeroVisual liveLabel={t("live.titleLive")} liveValue={stat(stats?.books)} />
              )}

            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 2. KPI QATORI — hero ustiga chiqib turadigan kartalar              */}
      {/* ================================================================== */}
      <section className="relative z-10 -mt-14">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div data-reveal-stagger="" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {heroStats.map(({ value, label, icon: StatIcon }) => (
              <div key={label} className="lift card-surface rounded-2xl p-5">
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

      {/* FONDDAGI KITOBLAR — haqiqiy kitoblar (faqat faol kutubxonalardan).  */}
      {/* Bo'sh bo'lsa bo'lim ko'rsatilmaydi — hech narsa o'ylab topilmaydi. */}
      {newBooks.length > 0 && (
        <section data-reveal="" id="kitoblar" className="scroll-mt-20 pt-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <SectionHeading
                align="left"
                eyebrow={t("newBooks.eyebrow")}
                title={t("newBooks.title")}
                subtitle={t("newBooks.subtitle")}
              />
              <Link
                href={`/${locale}/search`}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-white px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50"
              >
                {t("newBooks.all")}
                <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
              </Link>
            </div>
            <LandingBooks
              books={newBooks}
              locale={locale}
              labels={{
                available: t("newBooks.available", { count: "{count}" }),
                unavailable: t("newBooks.unavailable"),
                close: tv("qClose"),
                reserve: tv("qReserve"),
                details: tv("qDetails"),
                library: tv("qLibrary"),
                genre: tv("qGenre"),
                hint: tv("qHint"),
              }}
            />
          </div>
        </section>
      )}

      {/* ================================================================== */}
      {/* 3. XARITA + REYTING — referens maketdagi ikki ustunli blok         */}
      {/* ================================================================== */}
      <section data-reveal="" id="xarita" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="card-surface rounded-3xl p-6 sm:p-8">
            <RegionsMap locale={locale} regions={regions} />
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 4. JONLI KO'RSATKICHLAR                                            */}
      {/* ================================================================== */}
      <section data-reveal="" className="border-y border-line bg-white">
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
      <section data-reveal="" id="reytinglar" className="scroll-mt-20">
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
      {/* 6. AUDITORIYALAR — har kim uchun: muammo → yechim → bitta harakat   */}
      {/* ================================================================== */}
      <section data-reveal="" id="kimlar-uchun" className="scroll-mt-20 border-y border-line bg-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <SectionHeading title={tv("audTitle")} subtitle={tv("audSub")} />
          <div data-reveal-stagger="" className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCE_DEFS.map(({ key, icon: AudIcon, href, primary }) => (
              <div
                key={key}
                className={`lift flex flex-col rounded-2xl border p-6 ${
                  primary ? "border-brand-300 bg-brand-50/60" : "border-line bg-surface-muted"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-white text-brand-600 shadow-sm">
                    <AudIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                  </span>
                  {primary && (
                    <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-bold text-green-700">
                      {tv("audFree")}
                    </span>
                  )}
                </div>
                <h3 className="mt-5 text-lg font-bold text-slate-900">{tv(`${key}.label`)}</h3>
                <p className="mt-3 rounded-xl border border-red-100 bg-red-50/70 px-3 py-2 text-sm leading-snug text-red-800">
                  <span className="font-semibold">{tv("audPain")}:</span> {tv(`${key}.pain`)}
                </p>
                <ul className="mt-4 flex-1 space-y-2">
                  <FeatureItem>{tv(`${key}.g1`)}</FeatureItem>
                  <FeatureItem>{tv(`${key}.g2`)}</FeatureItem>
                  <FeatureItem>{tv(`${key}.g3`)}</FeatureItem>
                </ul>
                <Link
                  href={href.startsWith("#") ? href : `/${locale}${href}`}
                  className={`mt-6 inline-flex h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-bold transition-colors ${
                    primary
                      ? "btn-shine bg-brand-600 text-white hover:bg-brand-700"
                      : "border border-line bg-white text-brand-700 hover:bg-brand-50"
                  }`}
                >
                  {tv(`${key}.cta`)}
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
      <section data-reveal="">
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
      <section data-reveal="" id="muassasalar" className="scroll-mt-20 border-y border-line bg-white">
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
      <section data-reveal="">
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
      <section data-reveal="" className="border-y border-line bg-white">
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
      <section data-reveal="">
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
      <section data-reveal="" className="border-y border-line bg-white">
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
                className="mt-8 inline-flex h-12 items-center gap-2 rounded-xl bg-sky-700 px-6 text-sm font-bold text-white shadow-sm transition-colors hover:bg-sky-800 active:scale-[0.98]"
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
              {telegramQr ? (
                <a
                  href="https://t.me/SifatLibraryBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="@SifatLibraryBot"
                  className="mx-auto mt-5 block h-44 w-44 rounded-2xl border border-line bg-white p-2 shadow-sm [&>svg]:h-full [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: telegramQr }}
                />
              ) : (
                <div className="mx-auto mt-5 flex h-40 w-40 items-center justify-center rounded-2xl border-2 border-dashed border-line-strong bg-surface-muted text-slate-300">
                  <Icon.qr aria-hidden="true" size={56} strokeWidth={1} />
                </div>
              )}

              <p className="mt-4 text-xs text-slate-400">{t("telegram.qrCaption")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================== */}
      {/* 13. DONAT                                                          */}
      {/* ================================================================== */}
      <section data-reveal="" id="donat" className="scroll-mt-20">
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

            {donateStats && Number(donateStats.totalCollected ?? 0) > 0 ? (
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
                {/* Faqat haqiqiy manzili bor tarmoq ko'rsatiladi. Facebook /
                    Instagram / YouTube sahifalari hali yo'q — href="#" havola
                    hech qayerga olib bormasdi. Rasmiy manzil kelganda shu
                    ro'yxatga qo'shiladi. */}
                {[
                  { href: "https://t.me/sifat_uz", label: "Telegram", Ic: TelegramIcon },
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
                {/* "Ma'lumotlar himoyasi" havolasi vaqtincha olib tashlandi:
                    /privacy sahifasi yo'q (404). Maxfiylik siyosati — buyurtmachi
                    beradigan huquqiy hujjat, matnini o'ylab topib bo'lmaydi. */}
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
