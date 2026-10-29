"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuthStore } from "@/store/auth.store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

// Xodim/admin rollari dashboardga, qolganlari (KITOBXON/DOKON) profilga boradi.
const DASHBOARD_ROLES = [
  "SUPER_ADMIN",
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
  "KLUB_RAHBARI",
  "BUXGALTER",
];

/**
 * Landing sarlavha qatoridagi auth tugmasi. Avval ekran ustida suzuvchi
 * (fixed) turardi — endi header oqimida, logotip bilan bir qatorda.
 * Kirgan foydalanuvchi "Kabinet"ga (sessiya saqlanadi), aks holda "Kirish".
 */
export function LandingAuthButton({ locale }: { locale: string }) {
  const { isAuthenticated, user } = useAuthStore();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // SSR markup bilan mos kelishi uchun hidratsiyagacha o'lchami teng
  // ko'rinmas joy egallagich chizamiz (layout sakramaydi).
  if (!hydrated) {
    return <span className="inline-flex h-11 w-24" aria-hidden="true" />;
  }

  const role = user?.role ?? "";
  const home =
    role && DASHBOARD_ROLES.includes(role)
      ? `/${locale}/dashboard`
      : `/${locale}/profile`;

  return isAuthenticated ? (
    <Link
      href={home}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
    >
      <Icon.reader aria-hidden="true" size={ICON_SIZE.sm} />
      Kabinet
    </Link>
  ) : (
    <Link
      href={`/${locale}/login`}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-brand-300 hover:text-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
    >
      Kirish
    </Link>
  );
}
