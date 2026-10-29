import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { notFound } from "next/navigation";
import { locales, type Locale } from "@/i18n";
import { Providers } from "@/components/providers";
import { SkipNavLink } from "@/components/accessibility/SkipNavLink";
import { LocaleThemeControl } from "@/components/LocaleThemeControl";
import { OfflineBanner } from "@/components/offline/OfflineBanner";
import {
  LiteModeBanner,
  LiteModeProvider,
} from "@/components/offline/LiteModeBanner";
import "@/app/globals.css";

/**
 * Inter — loyihaning asosiy matn shrifti.
 *
 * Nega Inter: ekran uchun mo'ljallangan, lotin + KIRILL (uz-Cyrl, ru) va
 * qoraqalpoq diakritikalarini to'liq qoplaydi — to'rt tilimiz uchun bitta
 * shrift yetadi. Tizim shrifti (avvalgi holat) har OSda boshqacha ko'rinardi:
 * Windows'da Segoe, macOS'da SF — natijada mahsulot har kompyuterda boshqa
 * mahsulotdek tuyulardi. `display: swap` matnni bloklamaydi (LCP himoyasi),
 * `variable` esa CSS o'zgaruvchisi orqali butun daraxtga tarqaladi.
 */
const inter = Inter({
  subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext"],
  display: "swap",
  variable: "--font-sans",
});

/**
 * Plus Jakarta Sans — faqat brend so'z belgisi ("Sifat Library") va
 * `font-display` sarlavhalar uchun (globals.css → --font-display); asosiy
 * matn Inter'da qoladi. Variable shrift — bitta fayl, barcha og'irliklar.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-jakarta",
});

const BASE_URL = "https://sifat.uz";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;

  const titles: Record<string, string> = {
    "uz-Latn": "SIFAT LIBRARY — Milliy Kitobxonlik Platformasi",
    "uz-Cyrl": "SIFAT LIBRARY — Миллий Китобхонлик Платформаси",
    "ru": "SIFAT LIBRARY — Национальная библиотечная платформа",
    "kaa": "SIFAT LIBRARY — Milliy Kitapxana Platforması",
  };

  const descriptions: Record<string, string> = {
    "uz-Latn":
      "O'zbekistondagi barcha kutubxonalar bir tizimda. Reading Index, Top-100 kitobxonlar, real vaqt statistika.",
    "uz-Cyrl":
      "Ўзбекистондаги барча кутубхоналар бир тизимда. Ўқиш индекси, Топ-100 китобхонлар.",
    "ru":
      "Все библиотеки Узбекистана в единой системе. Индекс чтения, Топ-100 читателей, статистика в реальном времени.",
    "kaa":
      "Ózbekistandaǵı barlıq kitapxanalar bir sistemada. Oqıw indeksi, Top-100 oqıwshılar.",
  };

  const title = titles[locale] ?? titles["uz-Latn"];
  const description = descriptions[locale] ?? descriptions["uz-Latn"];

  return {
    title: {
      default: title,
      template: `%s | SIFAT LIBRARY`,
    },
    description,
    metadataBase: new URL(BASE_URL),
    openGraph: {
      type: "website",
      locale,
      url: `${BASE_URL}/${locale}`,
      siteName: "SIFAT LIBRARY",
      title,
      description,
      images: [
        {
          url: `${BASE_URL}/og-image.png`,
          width: 1200,
          height: 630,
          alt: "SIFAT LIBRARY",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${BASE_URL}/og-image.png`],
    },
    alternates: {
      canonical: `${BASE_URL}/${locale}`,
      languages: Object.fromEntries(
        locales.map((l) => [l, `${BASE_URL}/${l}`])
      ),
    },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true },
    },
    icons: {
      // ICO — Safari va eski brauzerlar; SVG — Chrome/Firefox (har DPI da
      // keskin); 180px PNG — iOS "Bosh ekranga qo'shish" ikonkasi.
      icon: [
        { url: "/favicon.ico", sizes: "48x48 32x32 16x16" },
        { url: "/brand/app-icon.svg", type: "image/svg+xml" },
      ],
      apple: [{ url: "/brand/app-icon-180.png", sizes: "180x180", type: "image/png" }],
    },
    manifest: "/manifest.json",
  };
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  const messages = await getMessages();

  return (
    <html lang={locale} className={`${inter.variable} ${jakarta.variable}`} suppressHydrationWarning>
      <head>
        {/* manifest havolasi `generateMetadata().manifest` dan keladi — bu
            yerda takrorlanmaydi (avval ikki marta chiqardi). */}
        <meta name="theme-color" content="#2563eb" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        {/* No-flash tema: paint'dan oldin .dark ni o'rnatadi (saqlangan tanlov
            yoki tizim sozlamasi bo'yicha) — sahifa miltillamaydi. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();",
          }}
        />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <SkipNavLink />
          <LocaleThemeControl />
          <LiteModeProvider>
            <LiteModeBanner />
            <OfflineBanner />
            <Providers>
              <main id="main-content">
                {children}
              </main>
            </Providers>
          </LiteModeProvider>
        </NextIntlClientProvider>
        {/* SW demo'da o'chirilgan: avval ro'yxatdan o'tgan service worker'ni
            unregister qilib, eski keshni tozalaymiz — aks holda eski manifest
            (/icons/icon-192.png 404), eski sahifa/API javoblari va soxta
            "offline" holat keshdan berilaverardi. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})}).catch(function(){});}if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})}).catch(function(){});}`
          }}
        />
      </body>
    </html>
  );
}
