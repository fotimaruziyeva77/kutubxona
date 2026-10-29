"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import Link from "next/link";
import { getLibrary, getLibraryByCode, reserveBook, type Book, type Library } from "@/lib/api/libraries";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { BookCard } from "@/components/books/BookCard";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

const TYPE_LABELS = { GOV: "Davlat kutubxonasi", SCH: "Maktab kutubxonasi", UNI: "OTM kutubxonasi", ORG: "Idora kutubxonasi", MAH: "Mahalla kutubxonasi" };
const TYPE_ICONS = { GOV: Icon.mahalla, SCH: Icon.school, UNI: Icon.university, ORG: Icon.organization, MAH: Icon.library };

// The route param is named [code], but search-result links may pass a raw
// library id instead — the books/search payload reliably carries libraryId,
// while the human `code` is only present on the Prisma-fallback path (the
// Elasticsearch path omits the library object). So resolve by code first and
// fall back to id. Library codes ("LIB-…") and CUIDs never collide.
async function resolveLibrary(codeOrId: string): Promise<Library> {
  try {
    return await getLibraryByCode(codeOrId);
  } catch {
    return await getLibrary(codeOrId);
  }
}

export default function LibraryProfileClient({ code }: { code: string }) {
  // Xato holatidagi "Bosh sahifaga qaytish" havolasi til prefiksisiz "/" ga
  // ketardi — ru/kaa foydalanuvchisi til tanlovini yo'qotardi.
  const pageLocale = useLocale();
  const { data: library, isLoading, isError } = useQuery({
    queryKey: ["library-code", code],
    queryFn: () => resolveLibrary(code)
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-slate-400 text-lg">Yuklanmoqda…</div>
      </div>
    );
  }

  if (isError || !library) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <Icon.library aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-4 text-slate-300" />
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Kutubxona topilmadi</h1>
          <p className="text-slate-500">Kod: {code}</p>
          <Link href={`/${pageLocale}`} className="mt-4 inline-block text-brand-600 hover:underline">Bosh sahifaga qaytish</Link>
        </div>
      </div>
    );
  }

  const availableBooks = library.books?.filter((b: Book) => b.availableCount > 0) ?? [];
  const allBooks = library.books ?? [];

  const TypeIcon = TYPE_ICONS[library.type as keyof typeof TYPE_ICONS] ?? Icon.library;

  // Kitobxon qobig'i: pastki tab-panel va "Asosiy"ga qaytish yo'li shu
  // yerda ham bo'ladi. Avval kutubxona sahifasi butunlay boshqa maketda
  // ochilardi va foydalanuvchi "boshqa saytga tushib qoldim" degan
  // taassurotda qolardi.
  return (
    <ReaderShell title={library.name} backHref={`/${pageLocale}/profile`}>
      {/* Kutubxona sarlavhasi */}
      <section className="ink-surface overflow-hidden rounded-2xl p-5 text-white sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/10">
            <TypeIcon aria-hidden="true" size={ICON_SIZE.lg} strokeWidth={1.75} className="text-accent-300" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-300">
              {TYPE_LABELS[library.type as keyof typeof TYPE_LABELS]}
            </p>
            <h2 className="mt-1 text-xl font-bold sm:text-2xl">{library.name}</h2>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-brand-100">
              {library.address && (
                <span className="inline-flex items-center gap-1.5">
                  <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
                  {library.address}
                </span>
              )}
              {library.workHours && (
                <span className="inline-flex items-center gap-1.5">
                  <Icon.pending aria-hidden="true" size={ICON_SIZE.xs} />
                  {library.workHours}
                </span>
              )}
              {library.phone && (
                <a href={`tel:${library.phone}`} className="inline-flex items-center gap-1.5 hover:text-white">
                  <Icon.phone aria-hidden="true" size={ICON_SIZE.xs} />
                  {library.phone}
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
          <StatCard label="Jami fond" value={library.fundCount.toLocaleString()} unit="kitob" />
          <StatCard label="Mavjud" value={availableBooks.length.toLocaleString()} unit="nusxa" />
          <StatCard label="Kodi" value={library.code} unit="" mono />
        </div>
      </section>

      <div className="mt-5">
        {/* Status warning */}
        {library.status === "FROZEN" && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-yellow-800">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} />
              Kutubxona vaqtincha yopiq
            </span>
            {library.frozenReason && <span className="ml-2 text-sm">— {library.frozenReason}</span>}
          </div>
        )}

        {/* Books section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-900">
              Kitob fondidan ({allBooks.length} ta ko'rsatilmoqda)
            </h2>
            {/* Til prefiksi SHART: `/search` middleware tomonidan
                `/uz-Latn/search` ga yo'naltirilardi va ru/kaa foydalanuvchisi
                tilini yo'qotardi. */}
            <Link
              href={`/${pageLocale}/search?libraryId=${library.id}`}
              className="shrink-0 text-sm font-semibold text-brand-600 hover:underline"
            >
              To&apos;liq katalog →
            </Link>
          </div>

          {allBooks.length === 0 ? (
            <div className="card-surface rounded-2xl py-12 text-center">
              <Icon.empty
                aria-hidden="true"
                size={32}
                strokeWidth={1.25}
                className="mx-auto text-slate-300"
              />
              <p className="mt-3 text-sm text-slate-400">
                Fond ma&apos;lumotlari mavjud emas
              </p>
            </div>
          ) : (
            /* Kitoblar — kitobxon sahifasidagi bilan BIR XIL kartada.
               Avval bu yerda alohida qator maketi va emoji ishlatilardi. */
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {(allBooks as Book[]).map((book) => (
                <LibraryBookCard key={book.id} book={book} locale={pageLocale} />
              ))}
            </div>
          )}
        </div>

        {library.latitude && library.longitude && (
          <div className="mt-8">
            <h2 className="mb-3 text-base font-bold text-slate-900">Joylashuv</h2>
            <p className="card-surface flex items-center gap-2 rounded-2xl p-4 text-sm text-slate-500">
              <Icon.map aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
              {library.latitude.toFixed(4)}, {library.longitude.toFixed(4)}
            </p>
          </div>
        )}
      </div>
    </ReaderShell>
  );
}

/**
 * Kutubxona katalogidagi kitob — umumiy `BookCard` ustiga bron mantig'i.
 * Anonim foydalanuvchi bron bosgan bo'lsa avval login'ga yuboriladi
 * (aks holda 401 va tushunarsiz xato chiqardi).
 */
function LibraryBookCard({ book, locale }: { book: Book; locale: string }) {
  const [done, setDone] = useState(false);
  const reserveMut = useMutation({
    mutationFn: () => reserveBook(book.id),
    onSuccess: () => setDone(true),
  });

  const errMsg =
    (reserveMut.error as { response?: { data?: { message?: string } } } | null)
      ?.response?.data?.message ?? null;

  return (
    <div>
      <BookCard
        book={book}
        reserved={done}
        reserving={reserveMut.isPending}
        onReserve={() => {
          if (!hasAuthHintCookie()) {
            window.location.href = `/${locale}/login`;
            return;
          }
          reserveMut.mutate();
        }}
      />
      {errMsg && <p className="mt-1 px-1 text-[11px] text-red-600">{errMsg}</p>}
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  mono
}: {
  label: string;
  value: string;
  unit: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl bg-white/10 p-3 text-center">
      <p className={`font-bold ${mono ? "font-mono text-sm" : "text-xl"}`}>{value}</p>
      {unit && <p className="text-[11px] text-brand-100">{unit}</p>}
      <p className="mt-0.5 text-[11px] text-accent-300">{label}</p>
    </div>
  );
}

