"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookCover } from "@/components/books/BookCover";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

export type LandingBookItem = {
  id: string;
  title: string;
  author: string;
  genre?: string | null;
  hasCover: boolean;
  updatedAt?: string;
  availableCount: number;
  library?: { name: string; code?: string | null } | null;
};

export type LandingBooksLabels = {
  available: string; // "{count}" o'rnida son qo'yiladi
  unavailable: string;
  close: string;
  reserve: string;
  details: string;
  library: string;
  genre: string;
  hint: string;
};

const coverUrl = (b: LandingBookItem) =>
  b.hasCover ? `/api/books/${b.id}/cover${b.updatedAt ? `?v=${encodeURIComponent(b.updatedAt)}` : ""}` : null;

/**
 * Landing kitob kartalari + "quick view" oynasi. Karta bosilganda sahifadan
 * chiqilmaydi — kitob ma'lumoti va "Bron qilish" shu yerning o'zida ochiladi.
 * To'liq kitob sahifasi faqat "Batafsil" orqali (ulashish/SEO uchun).
 */
export function LandingBooks({
  books,
  locale,
  labels,
}: {
  books: LandingBookItem[];
  locale: string;
  labels: LandingBooksLabels;
}) {
  const [open, setOpen] = useState<LandingBookItem | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      lastFocus.current?.focus();
    };
  }, [open]);

  const availableText = (n: number) => labels.available.replace("{count}", String(n));
  const reserveHref = (b: LandingBookItem) =>
    b.library?.code
      ? `/${locale}/library/${encodeURIComponent(b.library.code)}?book=${encodeURIComponent(b.id)}`
      : `/${locale}/book/${encodeURIComponent(b.id)}`;

  return (
    <>
      <div
        data-reveal-stagger=""
        className="-mx-4 mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 pt-2 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0 lg:grid-cols-6"
      >
        {books.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={(e) => {
              lastFocus.current = e.currentTarget;
              setOpen(b);
            }}
            aria-haspopup="dialog"
            className="book-card group flex w-[44%] shrink-0 snap-start flex-col rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:w-auto"
          >
            <div className="book-card-stage relative w-full rounded-2xl px-5 pb-5 pt-7">
              <span
                className={`absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm ${
                  b.availableCount > 0 ? "bg-white text-green-700" : "bg-white/80 text-slate-500"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${b.availableCount > 0 ? "live-dot bg-green-500" : "bg-slate-400"}`}
                />
                {b.availableCount > 0 ? availableText(b.availableCount) : labels.unavailable}
              </span>
              <div className="book-card-cover mx-auto w-full max-w-[8.5rem]">
                <BookCover size="md" title={b.title} author={b.author} genre={b.genre} coverUrl={coverUrl(b)} />
              </div>
            </div>
            <span className="mt-3 line-clamp-2 px-1 text-sm font-semibold leading-snug text-slate-900 group-hover:text-brand-700">
              {b.title}
            </span>
            <span className="mt-0.5 block w-full truncate px-1 text-xs text-slate-500">{b.author}</span>
            {b.library?.name && (
              <span className="mt-1.5 flex w-full items-center gap-1 truncate px-1 text-xs text-slate-400">
                <Icon.library aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0 text-brand-400" />
                <span className="truncate">{b.library.name}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          onClick={() => setOpen(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-view-title"
            onClick={(e) => e.stopPropagation()}
            className="quick-view relative w-full max-w-2xl overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
          >
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(null)}
              aria-label={labels.close}
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-slate-500 shadow-sm hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
            </button>
            <div className="grid sm:grid-cols-[13rem_1fr]">
              <div className="book-card-stage flex items-center justify-center px-8 py-8 sm:rounded-none">
                <div className="book-float w-32 sm:w-40">
                  <BookCover size="lg" title={open.title} author={open.author} genre={open.genre} coverUrl={coverUrl(open)} />
                </div>
              </div>
              <div className="flex flex-col p-6 sm:p-8">
                <h3 id="quick-view-title" className="pr-8 text-xl font-bold leading-snug text-slate-900">
                  {open.title}
                </h3>
                <p className="mt-1 text-sm text-slate-500">{open.author}</p>

                <dl className="mt-5 space-y-2.5 text-sm">
                  {open.library?.name && (
                    <div className="flex items-start gap-2">
                      <Icon.library aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-brand-500" />
                      <dt className="sr-only">{labels.library}</dt>
                      <dd className="text-slate-700">{open.library.name}</dd>
                    </div>
                  )}
                  {open.genre && (
                    <div className="flex items-start gap-2">
                      <Icon.book aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-brand-500" />
                      <dt className="sr-only">{labels.genre}</dt>
                      <dd className="text-slate-700">{open.genre}</dd>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`ml-1 mr-1 h-2 w-2 rounded-full ${open.availableCount > 0 ? "live-dot bg-green-500" : "bg-slate-400"}`}
                    />
                    <dd className={open.availableCount > 0 ? "font-semibold text-green-700" : "text-slate-500"}>
                      {open.availableCount > 0 ? availableText(open.availableCount) : labels.unavailable}
                    </dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-wrap gap-2.5 pt-7">
                  <Link
                    href={reserveHref(open)}
                    className="btn-shine inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700"
                  >
                    <Icon.bookmark aria-hidden="true" size={ICON_SIZE.sm} />
                    {labels.reserve}
                  </Link>
                  <Link
                    href={`/${locale}/book/${encodeURIComponent(open.id)}`}
                    className="inline-flex h-11 items-center justify-center rounded-xl border border-line px-5 text-sm font-semibold text-slate-700 hover:bg-surface-muted"
                  >
                    {labels.details}
                  </Link>
                </div>
                <p className="mt-3 text-xs text-slate-400">{labels.hint}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
