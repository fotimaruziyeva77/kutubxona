"use client";

/**
 * AdaptiveShell — ochiq sahifalar (qidiruv, kutubxona profili, reyting) uchun
 * YAGONA qobiq qoidasi:
 *
 *   • kirgan KITOBXON  → ReaderShell (pastki tab-panel, "Orqaga" → /profile);
 *   • qolganlar (mehmon yoki xodim) → PublicShell (bosh sahifa dizayni).
 *
 * Avval har sahifa o'zicha qaror qilardi: qidiruv va kutubxona ReaderShell'ni
 * SHARTSIZ chizardi (mehmon "Orqaga"ni bossa login'ga tushardi), reyting esa
 * faqat kitobxonga ReaderShell berib, mehmonga uchinchi xil sarlavha
 * ko'rsatardi.
 *
 * Qaror MOUNTDAN keyin qabul qilinadi: sessiya localStorage'dan (zustand
 * persist) tiklanadi, SSR esa doim "mehmon" holatida chiziladi — shunda
 * hydration mos keladi va mehmon uchun sahifa serverda to'liq render bo'ladi.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { useAuthStore } from "@/store/auth.store";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { PublicShell } from "@/components/landing/PublicShell";

export function useIsReader(): boolean {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const role = useAuthStore((s) => s.user?.role);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && isAuthenticated && role === "KITOBXON";
}

export function AdaptiveShell({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  const isReader = useIsReader();

  if (isReader) {
    return (
      <ReaderShell title={title} subtitle={subtitle} backHref={`/${locale}/profile`}>
        {children}
      </ReaderShell>
    );
  }
  return (
    <PublicShell title={title} subtitle={subtitle}>
      {children}
    </PublicShell>
  );
}
