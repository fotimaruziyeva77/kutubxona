"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { AdaptiveShell } from "@/components/reader/AdaptiveShell";
import { BookCover } from "@/components/books/BookCover";
import { getFavorites, setFavorite } from "@/lib/api/social";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/** «Saralanganlar» — kitobxon saqlab qo'ygan kitoblar. */
export default function FavoritesPage() {
  const t = useTranslations("Favorites");
  const locale = useLocale();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["favorites"], queryFn: getFavorites });
  const remove = useMutation({
    mutationFn: (id: string) => setFavorite(id, false),
    onSuccess: (_d, id) => {
      qc.setQueryData(["favorites"], (old: typeof data) => old?.filter((b) => b.id !== id));
      qc.invalidateQueries({ queryKey: ["book-favorite", id] });
    },
  });

  return (
    <AdaptiveShell title={t("title")} wide>
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-rose-50 text-rose-500">
          <Heart aria-hidden="true" size={ICON_SIZE.md} className="fill-rose-500" />
        </span>
        <div>
          <h2 className="text-xl font-bold text-slate-900">{t("title")}</h2>
          <p className="text-sm text-slate-500">{data ? t("count", { count: data.length }) : t("subtitle")}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          {t("error")}{" "}
          <button type="button" onClick={() => refetch()} className="font-semibold underline">
            {t("retry")}
          </button>
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-brand-200 bg-white p-10 text-center">
          <Heart aria-hidden="true" size={40} className="mx-auto text-slate-300" />
          <p className="mt-3 font-semibold text-slate-800">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-slate-500">{t("emptyText")}</p>
          <Link
            href={`/${locale}/search`}
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700"
          >
            <Icon.search aria-hidden="true" size={ICON_SIZE.sm} />
            {t("browse")}
          </Link>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 pt-12 sm:grid-cols-3 lg:grid-cols-4">
          {data.map((b) => {
            const ok = b.availableCount > 0;
            return (
              <li key={b.id} className="relative flex flex-col rounded-2xl border border-line bg-white px-4 pb-4 shadow-sm">
                <button
                  type="button"
                  onClick={() => remove.mutate(b.id)}
                  aria-label={t("remove")}
                  title={t("remove")}
                  className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-full bg-white text-rose-500 shadow hover:bg-rose-50"
                >
                  <Heart aria-hidden="true" size={16} className="fill-rose-500" />
                </button>
                <Link href={`/${locale}/book/${encodeURIComponent(b.id)}`} className="group flex flex-1 flex-col">
                  <div className="-mt-12 mb-4 flex h-44 items-end justify-center">
                    <div className="w-28 transition-transform duration-300 group-hover:-translate-y-1.5">
                      <BookCover
                        size="md"
                        title={b.title}
                        author={b.author}
                        genre={b.genre}
                        coverUrl={b.hasCover ? `/api/books/${encodeURIComponent(b.id)}/cover` : null}
                      />
                    </div>
                  </div>
                  <p className="line-clamp-2 text-[15px] font-bold leading-snug text-slate-900 group-hover:text-brand-700">{b.title}</p>
                  <p className="mt-1 truncate text-sm text-slate-500">{b.author}</p>
                  {b.library?.name && <p className="mt-1 truncate text-xs text-slate-400">{b.library.name}</p>}
                  <p className={`mt-auto border-t border-dashed border-line pt-3 text-sm font-bold ${ok ? "text-green-700" : "text-slate-400"}`}>
                    {ok ? t("available", { count: b.availableCount }) : t("unavailable")}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AdaptiveShell>
  );
}
