"use client";

/**
 * ReaderShell — BARCHA kitobxon sahifalarining yagona qobig'i.
 *
 * NIMA UCHUN KERAK EDI:
 *  • Har sahifa o'z navigatsiyasini o'zi chizardi. Natijada `/search`,
 *    `/top`, `/family` va `/profile` turlicha ko'rinardi va foydalanuvchi
 *    "qayerdaman?" degan savolga javob topolmasdi.
 *  • Eski `ReaderNav` — gorizontal siljiydigan tasma edi: 6 ta element
 *    ekranga sig'masdi, "Profil" yarmi kesilib qolardi va foydalanuvchi
 *    yashirin elementlarni ko'rish uchun tasmani surishi kerak edi.
 *  • Ichki sahifalarga (masalan qidiruv natijalari) kirgandan keyin
 *    ORQAGA QAYTISH yo'li yo'q edi — brauzer tugmasidan boshqa.
 *
 * YECHIM — mobil ilovalarning standart naqshи:
 *  • Pastki tab-panel (mobil): barmoq yetadigan joyda, MAX 5 element,
 *    siljish yo'q, faol tab aniq ko'rinadi.
 *  • Yuqori tab (desktop): kengligi yetarli, hammasi bir qatorda.
 *  • Yuqorida sahifa sarlavhasi va — ichki sahifa bo'lsa — orqaga tugmasi.
 *
 * `backHref` berilgan sahifa "ichki" hisoblanadi: pastki tab-panel baribir
 * qoladi (foydalanuvchi istalgan bo'limga bir bosishda o'ta oladi), lekin
 * yuqorida aniq "orqaga" yo'li paydo bo'ladi.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getMyInstitutionLibrary } from "@/lib/api/libraries";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { LogoMark } from "@/components/brand/Logo";

type NavItem = {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** Faollikni aniqlash: yo'l shu prefiks bilan boshlansa faol. */
  match: string;
};

export function ReaderShell({
  title,
  subtitle,
  backHref,
  action,
  children,
}: {
  /** Sahifa sarlavhasi. Berilmasa yuqori qator faqat orqaga/amal ko'rsatadi. */
  title?: string;
  subtitle?: string;
  /** Ichki sahifada — qayerga qaytish. */
  backHref?: string;
  /** O'ng tomondagi qo'shimcha amal (masalan "Chiqish"). */
  action?: ReactNode;
  children: ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations("ReaderShell");
  const pathname = usePathname();
  const router = useRouter();

  // Muassasa kutubxonasi bor kitobxonda "Kutubxonam" tab'i chiqadi.
  // Xato bo'lsa (401, tarmoq) — tab shunchaki ko'rsatilmaydi, qobiq ishlaydi.
  const { data: myLib } = useQuery({
    queryKey: ["my-institution-library"],
    queryFn: getMyInstitutionLibrary,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const items: NavItem[] = [
    { key: "home", href: `/${locale}/profile`, label: t("tabHome"), icon: Icon.mahalla, match: "/profile" },
    { key: "search", href: `/${locale}/search`, label: t("tabSearch"), icon: Icon.search, match: "/search" },
    ...(myLib?.code
      ? [
          {
            key: "lib",
            href: `/${locale}/library/${encodeURIComponent(myLib.code)}`,
            label: t("tabLibrary"),
            icon: Icon.library,
            match: "/library",
          },
        ]
      : []),
    { key: "top", href: `/${locale}/top`, label: t("tabTop"), icon: Icon.trophy, match: "/top" },
    { key: "family", href: `/${locale}/family`, label: t("tabFamily"), icon: Icon.family, match: "/family" },
  ];

  const stripped = pathname.replace(`/${locale}`, "") || "/";
  const isActive = (m: string) => stripped === m || stripped.startsWith(`${m}/`);

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* ── Yuqori qator ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          {backHref ? (
            <Link
              href={backHref}
              aria-label={t("back")}
              className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-surface-muted"
            >
              <Icon.next
                aria-hidden="true"
                size={ICON_SIZE.md}
                className="rotate-180"
              />
            </Link>
          ) : (
            <Link
              href={`/${locale}`}
              aria-label="SIFAT LIBRARY"
              className="-ml-1 flex shrink-0 items-center gap-2"
            >
              <LogoMark size={30} className="shrink-0" />
            </Link>
          )}

          <div className="min-w-0 flex-1">
            {title && (
              <h1 className="truncate text-base font-bold text-slate-900">{title}</h1>
            )}
            {subtitle && (
              <p className="truncate text-xs text-slate-500">{subtitle}</p>
            )}
          </div>

          {/* Desktop tab — kenglik yetadi, hammasi bir qatorda */}
          <nav className="hidden items-center gap-1 md:flex" aria-label={t("sections")}>
            {items.map((it) => {
              const active = isActive(it.match);
              const ItemIcon = it.icon;
              return (
                <Link
                  key={it.key}
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-brand-50 text-brand-700"
                      : "text-slate-600 hover:bg-surface-muted"
                  }`}
                >
                  <ItemIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={active ? 2.2 : 1.75} />
                  {it.label}
                </Link>
              );
            })}
          </nav>

          {action && <div className="shrink-0">{action}</div>}
        </div>
      </header>

      {/* ── Kontent ──────────────────────────────────────────────────── */}
      {/* Pastdagi bo'shliq mobil tab-panel balandligi uchun — oxirgi karta
          panel ostida qolib ketmasin. */}
      <main className="mx-auto max-w-3xl px-4 pb-28 pt-5 md:pb-10">{children}</main>

      {/* ── Pastki tab-panel (faqat mobil) ───────────────────────────── */}
      <nav
        aria-label={t("mainSections")}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-3xl">
          {items.map((it) => {
            const active = isActive(it.match);
            const ItemIcon = it.icon;
            return (
              <Link
                key={it.key}
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors ${
                  active ? "text-brand-700" : "text-slate-500"
                }`}
              >
                <ItemIcon
                  aria-hidden="true"
                  size={ICON_SIZE.md}
                  strokeWidth={active ? 2.2 : 1.75}
                />
                {it.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Brauzer orqaga tugmasi bo'lmagan holat (PWA standalone) uchun —
          ichki sahifada dasturiy orqaga. Faqat `backHref` yo'q, lekin
          sahifa ildiz emas bo'lganda ko'rsatiladi. */}
      {!backHref && stripped !== "/profile" && !items.some((i) => isActive(i.match)) && (
        <button
          type="button"
          onClick={() => router.back()}
          className="fixed bottom-20 left-4 z-40 flex h-11 items-center gap-1.5 rounded-full border border-line bg-white px-4 text-sm font-medium text-slate-700 shadow-lg md:bottom-6"
        >
          <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
          {t("back")}
        </button>
      )}
    </div>
  );
}
