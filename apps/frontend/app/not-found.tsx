import Link from "next/link";
import { defaultLocale } from "@/i18n";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import "@/app/globals.css";

/**
 * Root 404 — til prefiksisiz, hech qaysi route'ga tushmagan manzillar uchun
 * oxirgi zaxira (masalan middleware matcher'idan chetda qolgan yo'llar).
 *
 * `app/layout.tsx` faqat `children` qaytaradi (html/body `[locale]/layout`
 * ichida), shuning uchun bu fayl o'z `<html>`/`<body>` ini render qiladi.
 * i18n konteksti yo'q — matn standart tilda, foydalanuvchi esa bir bosishda
 * to'liq lokalizatsiyalangan bosh sahifaga o'tadi.
 */
export default function RootNotFound() {
  return (
    <html lang="uz">
      <body className="bg-surface-muted">
        <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
          <Icon.search aria-hidden="true" size={ICON_SIZE.xl} className="text-slate-300" />
          <p className="mt-6 font-mono text-xs uppercase tracking-widest text-slate-400">
            404
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">
            Sahifa topilmadi
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-500">
            Manzil noto&apos;g&apos;ri yozilgan yoki sahifa ko&apos;chirilgan
            bo&apos;lishi mumkin.
          </p>
          <Link
            href={`/${defaultLocale}`}
            className="mt-8 inline-flex h-12 items-center justify-center rounded-md bg-blue-600 px-6 text-base font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Bosh sahifaga
          </Link>
        </main>
      </body>
    </html>
  );
}
