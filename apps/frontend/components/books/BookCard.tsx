"use client";

/**
 * BookCard — kitobxon ko'radigan kitob kartasi.
 *
 * NEGA KARTA, JADVAL EMAS: avval kitoblar matn qatorlari sifatida
 * chiqarilardi — bu katalog xodimi uchun qulay, LEKIN o'quvchini kitob
 * olishga undamaydi. Kitob tanlash vizual jarayon: avval muqova ko'zga
 * tashlanadi, keyin nom o'qiladi. Shuning uchun muqova kartaning eng
 * katta elementi.
 *
 * Mavjudlik HALOL ko'rsatiladi: nusxa qolmagan bo'lsa tugma o'chadi va
 * sababi yoziladi — "bron qilish" tugmasini bosib, keyin xato olish
 * ishonchni yo'qotadi.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { BookCover } from "./BookCover";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

export type BookCardData = {
  id: string;
  title: string;
  author: string;
  genre?: string | null;
  lang?: string | null;
  year?: number | null;
  pages?: number | null;
  coverUrl?: string | null;
  availableCount?: number | null;
  library?: { id?: string; name?: string; code?: string } | null;
};

export function BookCard({
  book,
  href,
  onReserve,
  reserving = false,
  reserved = false,
}: {
  book: BookCardData;
  /** Kutubxona sahifasiga havola — berilmasa karta bosilmaydi. */
  href?: string | null;
  /** Bron amali — berilmasa tugma umuman chizilmaydi (mas. tavsiyalar ro'yxati). */
  onReserve?: (bookId: string) => void;
  reserving?: boolean;
  reserved?: boolean;
}) {
  const t = useTranslations("BookCard");
  const available = book.availableCount ?? 0;
  const inStock = available > 0;

  return (
    <article className="group card-surface flex flex-col rounded-2xl transition-shadow hover:shadow-[var(--shadow-card-hover)]">
      {/* Muqova — kartaning asosiy vizual og'irligi.
          Atrofidagi bo'shliq 3D aylanish uchun: kitob burilganda koreshka
          va soya quti chegarasidan chiqadi, `overflow-hidden` bo'lsa
          kesilib qolardi. */}
      <div className="relative px-4 pb-1 pt-5">
        <BookCover
          title={book.title}
          author={book.author}
          genre={book.genre}
          coverUrl={book.coverUrl}
          size="md"
        />
        {!inStock && (
          <span className="absolute right-3 top-3 z-10 rounded-full bg-slate-900/85 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            {t("band")}
          </span>
        )}
        {inStock && available <= 2 && (
          <span className="absolute right-3 top-3 z-10 rounded-full bg-accent-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
            {t("lastCount", { count: available })}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3 pt-2">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900">
          {book.title}
        </h3>
        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{book.author}</p>

        {book.genre && (
          <span className="mt-2 inline-flex w-fit rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">
            {book.genre}
          </span>
        )}

        {book.library?.name && (
          <p className="mt-2 line-clamp-1 text-[11px] text-slate-400">
            {book.library.name}
          </p>
        )}

        {/* Amal maydoni — pastga yopishadi, shuning uchun turli balandlikdagi
            kartalarda tugmalar bir chiziqda turadi */}
        <div className="mt-auto pt-3">
          {onReserve ? (
            <button
              type="button"
              onClick={() => onReserve(book.id)}
              disabled={!inStock || reserving || reserved}
              className={`flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors ${
                reserved
                  ? "bg-info-50 text-info-700"
                  : inStock
                    ? "bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60"
                    : "cursor-not-allowed bg-surface-sunken text-slate-400"
              }`}
            >
              {reserved ? (
                <>
                  <Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />
                  {t("reserved")}
                </>
              ) : reserving ? (
                t("sending")
              ) : inStock ? (
                t("reserve")
              ) : (
                t("unavailable")
              )}
            </button>
          ) : href ? (
            <Link
              href={href}
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-line text-xs font-semibold text-slate-700 transition-colors hover:border-brand-300 hover:text-brand-700"
            >
              {t("details")}
              <Icon.next aria-hidden="true" size={ICON_SIZE.xs} />
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/**
 * BookRow — ixcham gorizontal variant. "Qo'limdagi kitoblar" kabi
 * ro'yxatlarda ishlatiladi: muqova kichik, lekin kitob baribir taniladi.
 */
export function BookRow({
  book,
  meta,
  tone = "default",
  action,
}: {
  book: BookCardData;
  /** O'ng tomondagi holat matni (mas. "5 kun qoldi"). */
  meta?: React.ReactNode;
  tone?: "default" | "warning" | "danger";
  action?: React.ReactNode;
}) {
  const toneCls =
    tone === "danger"
      ? "border-red-200 bg-red-50"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50"
        : "border-line bg-white";

  return (
    <div className={`flex gap-3 rounded-xl border p-3 ${toneCls}`}>
      <BookCover
        title={book.title}
        author={book.author}
        genre={book.genre}
        coverUrl={book.coverUrl}
        size="sm"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-slate-900">
          {book.title}
        </p>
        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{book.author}</p>
        {book.library?.name && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">
            {book.library.name}
          </p>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
      {meta && <div className="shrink-0 text-right">{meta}</div>}
    </div>
  );
}
