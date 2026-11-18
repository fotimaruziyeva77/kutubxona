"use client";

/**
 * OverdueNotice — "muddati o'tgan kitob bor, yangi bron qilib bo'lmaydi".
 *
 * NEGA KERAK: backend muddati o'tgan kitobi bor kitobxonga yangi bron
 * bermaydi (403 "Muddati o'tgan kitoblarni qaytaring"). Avval kitobxon buni
 * faqat "Bron qilish"ni BOSGANDAN keyin, kartaning ostidagi qisqa qizil
 * qatordan bilib olardi — qaysi kitob, qaysi kutubxona ekanini esa umuman
 * bilmasdi. Endi sabab oldindan, kitob nomi va kutubxonasi bilan aytiladi,
 * Bron tugmalari esa o'chiriladi.
 *
 * Qoida serverdagi bilan bir xil (transactions.service hasOverdueBooks):
 * status BORROWED va dueDate < hozir.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

export type OverdueItem = { title: string; libraryName?: string | null };

type TxLike = {
  status: string;
  dueDate?: string | null;
  book?: { title?: string; library?: { name?: string } | null } | null;
};

/** Muddati o'tgan (BORROWED, dueDate < hozir) kitoblar ro'yxati. */
export function findOverdue(transactions: TxLike[] | undefined | null): OverdueItem[] {
  const now = Date.now();
  return (transactions ?? [])
    .filter((tx) => {
      if (tx.status !== "BORROWED" || !tx.dueDate) return false;
      const due = new Date(tx.dueDate).getTime();
      return Number.isFinite(due) && due < now;
    })
    .map((tx) => ({
      title: tx.book?.title ?? "",
      libraryName: tx.book?.library?.name ?? null,
    }));
}

export function OverdueNotice({
  items,
  profileHref,
  className = "",
  id,
}: {
  items: OverdueItem[];
  /** Kitoblar ro'yxatiga havola — profil sahifasining o'zida berilmaydi. */
  profileHref?: string | null;
  className?: string;
  id?: string;
}) {
  const t = useTranslations("OverdueNotice");
  if (items.length === 0) return null;
  const first = items[0];

  return (
    <div
      id={id}
      role="alert"
      className={`flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 ${className}`}
    >
      <Icon.warning aria-hidden="true" size={ICON_SIZE.md} className="mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{t("title")}</p>
        <p className="mt-1 text-sm leading-relaxed">
          {first.libraryName
            ? t("body", { title: first.title, library: first.libraryName })
            : t("bodyNoLib", { title: first.title })}
        </p>
        {items.length > 1 && (
          <p className="mt-1 text-xs text-amber-800">{t("more", { count: items.length - 1 })}</p>
        )}
        {profileHref && (
          <Link
            href={profileHref}
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-700"
          >
            {t("link")}
            <Icon.next aria-hidden="true" size={ICON_SIZE.xs} />
          </Link>
        )}
      </div>
    </div>
  );
}
