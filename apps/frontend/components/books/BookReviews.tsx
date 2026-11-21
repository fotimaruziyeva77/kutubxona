"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { deleteReview, getBookReviews, getMyReview, saveReview } from "@/lib/api/social";

function Stars({ value, size = 16 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          size={size}
          className={i <= Math.round(value) ? "fill-amber-400 text-amber-400" : "fill-slate-200 text-slate-200"}
        />
      ))}
    </span>
  );
}

/**
 * Kitob izohlari: o'rtacha baho + taqsimot, izohlar ro'yxati, o'z izohini
 * yozish/tahrirlash/o'chirish. Mehmon ko'radi, yozish uchun kirish kerak.
 */
export function BookReviews({ locale, bookId }: { locale: string; bookId: string }) {
  const t = useTranslations("BookPage");
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  // Cookie faqat brauzerda o'qiladi — SSR bilan mos kelishi uchun effektda.
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(hasAuthHintCookie()), []);

  const list = useQuery({
    queryKey: ["book-reviews", bookId, page],
    queryFn: () => getBookReviews(bookId, page),
  });
  const mine = useQuery({
    queryKey: ["book-review-mine", bookId],
    queryFn: () => getMyReview(bookId),
    enabled: authed,
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["book-reviews", bookId] });
    qc.invalidateQueries({ queryKey: ["book-review-mine", bookId] });
  };
  const save = useMutation({
    mutationFn: () => saveReview(bookId, { rating, text: text.trim() || undefined }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteReview(id),
    onSuccess: () => {
      setRating(0);
      setText("");
      refresh();
    },
  });

  const startEdit = () => {
    setRating(mine.data?.rating ?? 0);
    setText(mine.data?.text ?? "");
    setEditing(true);
  };

  const data = list.data;
  const total = data?.total ?? 0;
  const next = encodeURIComponent(`/${locale}/book/${encodeURIComponent(bookId)}#reviews`);
  const showForm = authed && (editing || (!mine.isLoading && !mine.data));

  return (
    <section id="reviews" data-reveal="" className="mt-8 scroll-mt-24 rounded-3xl border border-brand-100 bg-white p-5 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex rounded-full bg-brand-600 px-4 py-1.5 text-xs font-bold text-white">
          {t("reviewsTab")} {total > 0 ? `(${total})` : ""}
        </span>
      </div>

      <div className="mt-5 grid gap-6 md:grid-cols-[14rem_1fr]">
        {/* ── Umumiy baho ─────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-brand-50/60 p-4">
          {data && data.average !== null ? (
            <>
              <p className="text-4xl font-bold text-slate-900">{data.average.toFixed(1)}</p>
              <Stars value={data.average} size={18} />
              <p className="mt-1 text-xs text-slate-500">{t("reviewsCount", { count: total })}</p>
              <ul className="mt-3 space-y-1">
                {[5, 4, 3, 2, 1].map((r) => {
                  const n = data.distribution[r - 1] ?? 0;
                  const pct = total ? Math.round((n / total) * 100) : 0;
                  return (
                    <li key={r} className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="w-3 text-right">{r}</span>
                      <Star aria-hidden="true" size={12} className="fill-amber-400 text-amber-400" />
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
                        <span className="block h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="w-6 text-right">{n}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="text-sm text-slate-500">{list.isLoading ? "…" : t("reviewsEmpty")}</p>
          )}
        </div>

        <div className="min-w-0">
          {/* ── Yozish / o'z izohi ───────────────────────────────────── */}
          {!authed ? (
            <div className="rounded-2xl border border-dashed border-brand-200 p-4 text-sm text-slate-600">
              {t("reviewLoginHint")}{" "}
              <Link href={`/${locale}/login?next=${next}`} className="font-semibold text-brand-700 underline">
                {t("login")}
              </Link>
            </div>
          ) : showForm ? (
            <form
              className="rounded-2xl border border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (rating >= 1) save.mutate();
              }}
            >
              <p className="text-sm font-semibold text-slate-800">{t("yourRating")}</p>
              <div className="mt-2 flex items-center gap-1" role="radiogroup" aria-label={t("yourRating")}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={rating === i}
                    aria-label={`${i}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(0)}
                    onClick={() => setRating(i)}
                    className="rounded p-0.5"
                  >
                    <Star
                      size={26}
                      className={i <= (hover || rating) ? "fill-amber-400 text-amber-400" : "fill-slate-200 text-slate-200"}
                    />
                  </button>
                ))}
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, 1000))}
                rows={3}
                placeholder={t("reviewPlaceholder")}
                aria-label={t("reviewPlaceholder")}
                className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-400">{text.length}/1000</span>
                <div className="flex gap-2">
                  {editing && (
                    <button type="button" onClick={() => setEditing(false)} className="h-10 rounded-xl border border-line px-4 text-sm font-semibold text-slate-600">
                      {t("cancel")}
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={rating < 1 || save.isPending}
                    className="h-10 rounded-xl bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {save.isPending ? "…" : t("reviewSubmit")}
                  </button>
                </div>
              </div>
              {save.isError && <p role="alert" className="mt-2 text-sm text-red-600">{t("reviewError")}</p>}
            </form>
          ) : mine.data ? (
            <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">{t("yourReview")}</p>
                <div className="flex gap-3 text-xs font-semibold">
                  <button type="button" onClick={startEdit} className="text-brand-700 hover:underline">
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => mine.data && window.confirm(t("deleteConfirm")) && del.mutate(mine.data.id)}
                    className="text-red-600 hover:underline"
                  >
                    {t("delete")}
                  </button>
                </div>
              </div>
              <div className="mt-1"><Stars value={mine.data.rating} /></div>
              {mine.data.text && <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{mine.data.text}</p>}
            </div>
          ) : null}

          {/* ── Ro'yxat ─────────────────────────────────────────────── */}
          <ul className="mt-5 divide-y divide-line">
            {data?.data.map((r) => (
              <li key={r.id} className="py-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                    {r.author.slice(0, 1)}
                  </span>
                  <span className="text-sm font-semibold text-slate-800">{r.author}</span>
                  <Stars value={r.rating} size={14} />
                  <span className="text-xs text-slate-400">
                    {new Date(r.createdAt).toLocaleDateString(locale === "ru" ? "ru-RU" : "uz-UZ")}
                    {r.edited ? ` · ${t("edited")}` : ""}
                  </span>
                </div>
                {r.text && <p className="mt-2 whitespace-pre-line break-words text-sm leading-relaxed text-slate-600">{r.text}</p>}
              </li>
            ))}
          </ul>
          {data && total > data.limit && (
            <div className="mt-2 flex items-center justify-center gap-3 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
                ←
              </button>
              <span className="text-slate-500">
                {page} / {Math.ceil(total / data.limit)}
              </span>
              <button
                type="button"
                disabled={page >= Math.ceil(total / data.limit)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
              >
                →
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
