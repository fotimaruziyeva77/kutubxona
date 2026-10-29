"use client";

/**
 * ReaderSearchBar — kitobxon bosh sahifasidagi qidiruv.
 *
 * NEGA KERAK: kitob topishning eng tez yo'li — nomini yozish. Avval buning
 * uchun alohida sahifaga o'tish kerak edi, ya'ni "kitob izlash" fikri
 * paydo bo'lgan payt bilan qidiruv maydoni orasida bitta ortiqcha qadam
 * turardi. Endi maydon kashfiyot blokining boshida.
 *
 * Tez teglar — bo'sh maydonga qarab turgan foydalanuvchiga "nimadan
 * boshlash" ni ko'rsatadi. Ular fonddagi HAQIQIY janrlar (seed katalogi),
 * o'ylab topilgan emas.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/**
 * Tez teglar: `value` — fond katalogidagi HAQIQIY (o'zbekcha) qidiruv termini,
 * `key` — ko'rsatiladigan yorliq tarjimasi. Qidiruv bazadagi matnga boradi,
 * shu sabab value tarjima QILINMAYDI.
 */
const QUICK_TAGS = [
  { value: "Roman", key: "roman" },
  { value: "Sarguzasht", key: "adventure" },
  { value: "Tarix", key: "history" },
  { value: "Psixologiya", key: "psychology" },
  { value: "Bolalar adabiyoti", key: "kids" },
] as const;

export function ReaderSearchBar({ locale }: { locale: string }) {
  const router = useRouter();
  const t = useTranslations("ReaderBits.searchBar");
  const [q, setQ] = useState("");

  const go = (term: string) => {
    const t = term.trim();
    router.push(
      t ? `/${locale}/search?q=${encodeURIComponent(t)}` : `/${locale}/search`,
    );
  };

  return (
    <section className="card-surface rounded-2xl p-4 sm:p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        role="search"
      >
        <label htmlFor="reader-search" className="mb-2 block text-sm font-bold text-slate-900">
          {t("label")}
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted p-1.5 focus-within:border-brand-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-brand-500/10">
          <Icon.search
            aria-hidden="true"
            size={ICON_SIZE.md}
            className="ml-2 shrink-0 text-slate-400"
          />
          <input
            id="reader-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("placeholder")}
            className="h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0"
          />
          <button
            type="submit"
            className="h-10 shrink-0 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
          >
            {t("submit")}
          </button>
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {QUICK_TAGS.map((tag) => (
          <button
            key={tag.key}
            type="button"
            onClick={() => go(tag.value)}
            className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-slate-600 transition-colors hover:border-brand-300 hover:text-brand-700"
          >
            {t(`tags.${tag.key}`)}
          </button>
        ))}
      </div>
    </section>
  );
}
