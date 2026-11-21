"use client";

/**
 * PublicShell — ommaviy ichki sahifalar (qidiruv, kutubxona, reyting)
 * qobig'i mehmon va xodimlar uchun.
 *
 * NEGA KERAK: avval mehmon bosh sahifada kitobni bossa `/search` sahifasi
 * kitobxon ilovasi qobig'ida (ReaderShell) ochilardi: header, navigatsiya va
 * dizayn keskin o'zgarardi, "Orqaga" / "Asosiy" / "Oila" esa mehmonni login'ga
 * olib borardi. `/top` esa boshqa — o'zining minimal sarlavhasini chizardi.
 * Bitta mehmon uch xil header ko'rardi.
 *
 * Endi mehmon qayerda bo'lmasin bosh sahifadagi AYNAN o'sha panelni
 * (LandingHeader) ko'radi; ichki sahifada u `solid` (hero yo'q). Uning
 * ostida ixcham "non bo'lagi" qatori: bosh sahifaga qaytish + sahifa nomi.
 * Sarlavha kichik — sahifalarning o'zida katta kartali sarlavha bor
 * (reyting sarhisobi, kutubxona kartasi), ikkinchi katta h1 ortiqcha bo'lardi.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import "./public-shell.css";

export function PublicShell({
  title,
  subtitle,
  wide,
  children,
}: {
  title?: string;
  subtitle?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations("PublicShell");

  return (
    <div className="min-h-screen bg-surface-muted" data-public-shell="">
      <LandingHeader locale={locale} solid />
      <main className={`mx-auto ${wide ? "max-w-7xl" : "max-w-4xl"} px-4 pb-16 pt-4 sm:px-6`}>
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-2 text-sm"
        >
          <Link
            href={`/${locale}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg font-medium text-brand-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
            {t("home")}
          </Link>
          {title && (
            <>
              <span aria-hidden="true" className="text-slate-300">/</span>
              <h1 className="min-w-0 truncate font-semibold text-slate-900">{title}</h1>
            </>
          )}
        </nav>
        {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </main>
    </div>
  );
}
