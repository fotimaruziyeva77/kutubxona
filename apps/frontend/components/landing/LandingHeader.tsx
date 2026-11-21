"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { LandingAuthButton } from "@/components/landing/LandingAuthButton";
import { LocaleThemeControl } from "@/components/LocaleThemeControl";

/**
 * Landing yuqori paneli — logotip | bo'lim havolalari | kirish + demo CTA.
 *
 * Nega kerak: avval landing'da navigatsiya umuman yo'q edi — mehmon sahifani
 * pastgacha aylantirmasa Top-100, donat yoki B2B bo'limini topolmasdi va
 * "Demo so'rash" faqat sahifaning o'rtasida bir marta uchrardi. Sotuv
 * sahifasida asosiy amal (demo) HAR DOIM ko'rinib turishi kerak, shuning
 * uchun panel `sticky` va o'ngida doimiy CTA turadi.
 *
 * Scroll holati: sahifa tepasida panel shaffof (hero bilan qo'shilib ketadi),
 * pastga tushilganda oq fon + chegara paydo bo'ladi — kontent panel ostidan
 * "kesilib" o'tayotgani ko'rinmasligi uchun.
 *
 * Ichki ommaviy sahifalar (qidiruv, kutubxona, reyting — PublicShell) ham
 * AYNAN shu panelni ishlatadi, shunda mehmon bosh sahifadan kitobni bosganda
 * dizayn keskin o'zgarmaydi. U yerda hero yo'q, shuning uchun `solid` —
 * panel doim oq fon va chegara bilan chiziladi. Bo'lim havolalari `/{locale}#…`
 * ko'rinishida: bosh sahifada xuddi shu hash'ga scroll bo'ladi, ichki
 * sahifadan esa bosh sahifaning tegishli bo'limiga olib boradi.
 */

const SECTIONS = [
  { hash: "reytinglar", key: "Reytinglar" },
  { hash: "xarita", key: "Hududlar" },
  { hash: "muassasalar", key: "Muassasalar uchun" },
  { hash: "donat", key: "Donat" },
] as const;

export function LandingHeader({
  locale,
  solid = false,
}: {
  locale: string;
  /** Ichki sahifalar uchun: shaffof holat yo'q, doim oq fon + chegara. */
  solid?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 transition-colors duration-200 ${
        solid || scrolled
          ? "border-b border-line bg-white/90 backdrop-blur-md"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Logotip */}
        <Link
          href={`/${locale}`}
          className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          <LogoMark size={34} className="shrink-0" />
          <Wordmark className="text-[1.0625rem]" />
        </Link>

        {/* Bo'lim havolalari — desktop */}
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Bo'limlar">
          {SECTIONS.map((s) => (
            <a
              key={s.hash}
              href={`/${locale}#${s.hash}`}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-surface-sunken hover:text-brand-700"
            >
              {s.key}
            </a>
          ))}
        </nav>

        {/* O'ng tomon */}
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <LocaleThemeControl inline />
          </div>
          <div className="hidden sm:block">
            <LandingAuthButton locale={locale} />
          </div>
          <Link
            href={`/${locale}/demo-request`}
            className="hidden h-11 items-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 md:inline-flex"
          >
            Demo so&apos;rash
          </Link>

          {/* Mobil menyu tugmasi */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label="Menyu"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-white text-slate-700 transition-colors hover:bg-surface-muted lg:hidden"
          >
            <Icon.menu aria-hidden="true" size={ICON_SIZE.md} />
          </button>
        </div>
      </div>

      {/* Mobil menyu */}
      {menuOpen && (
        <div className="border-t border-line bg-white lg:hidden">
          <nav className="mx-auto max-w-7xl space-y-1 px-4 py-3 sm:px-6" aria-label="Bo'limlar">
            {SECTIONS.map((s) => (
              <a
                key={s.hash}
                href={`/${locale}#${s.hash}`}
                onClick={() => setMenuOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-sunken"
              >
                {s.key}
              </a>
            ))}
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <LocaleThemeControl inline />
              <LandingAuthButton locale={locale} />
              <Link
                href={`/${locale}/demo-request`}
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white"
              >
                Demo so&apos;rash
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
