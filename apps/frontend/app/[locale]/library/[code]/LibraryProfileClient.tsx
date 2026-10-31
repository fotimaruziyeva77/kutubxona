"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { getLibrary, getLibraryByCode, reserveBook, type Book, type Library } from "@/lib/api/libraries";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { BookCard } from "@/components/books/BookCard";
import {
  ReservationNextSteps,
  type ReservationInfo,
} from "@/components/reader/ReservationNextSteps";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

const TYPE_KEYS = ["GOV", "SCH", "UNI", "ORG", "MAH"] as const;
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

/** Xaritada ochish — OpenStreetMap (hisob/kalit talab qilmaydi). */
function mapHref(lat: number, lon: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

export default function LibraryProfileClient({ code }: { code: string }) {
  // Xato holatidagi "Bosh sahifaga qaytish" havolasi til prefiksisiz "/" ga
  // ketardi — ru/kaa foydalanuvchisi til tanlovini yo'qotardi.
  const pageLocale = useLocale();
  const t = useTranslations("LibraryPage");
  const { data: library, isLoading, isError } = useQuery({
    queryKey: ["library-code", code],
    queryFn: () => resolveLibrary(code)
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-slate-400 text-lg">{t("loading")}</div>
      </div>
    );
  }

  if (isError || !library) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <Icon.library aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-4 text-slate-300" />
          <h1 className="text-2xl font-bold text-slate-800 mb-2">{t("notFound")}</h1>
          <p className="text-slate-500">{t("code", { code })}</p>
          <Link href={`/${pageLocale}`} className="mt-4 inline-block text-brand-600 hover:underline">{t("home")}</Link>
        </div>
      </div>
    );
  }

  const availableBooks = library.books?.filter((b: Book) => b.availableCount > 0) ?? [];
  const allBooks = library.books ?? [];

  const TypeIcon = TYPE_ICONS[library.type as keyof typeof TYPE_ICONS] ?? Icon.library;
  const typeLabel = (TYPE_KEYS as readonly string[]).includes(library.type)
    ? t(`types.${library.type}` as "types.GOV")
    : library.type;
  const hasCoords =
    typeof library.latitude === "number" && typeof library.longitude === "number";

  // Manzil / ish vaqti / telefon — HAR DOIM ko'rsatiladi: kiritilmagan
  // bo'lsa "—" bilan. Avval bo'sh maydon shunchaki yashirilardi va kitobxon
  // kutubxonaning telefoni bormi-yo'qmi bilolmasdi (pilotda kutubxonachi
  // ham nimani to'ldirish kerakligini ko'rmasdi).
  const infoRows: { icon: typeof Icon.map; label: string; value: string | null; href?: string }[] = [
    { icon: Icon.map, label: t("address"), value: library.address ?? null },
    { icon: Icon.pending, label: t("workHours"), value: library.workHours ?? null },
    {
      icon: Icon.phone,
      label: t("phone"),
      value: library.phone ?? null,
      // tel: havolasida bo'shliqlar bo'lmasin ("+998 71 200 00 00" → "+99871…")
      href: library.phone ? `tel:${library.phone.split(" ").join("")}` : undefined,
    },
  ];

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
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-300">
              {typeLabel}
            </p>
            <h2 className="mt-1 text-xl font-bold sm:text-2xl">{library.name}</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm text-brand-100 sm:grid-cols-3">
              {infoRows.map(({ icon: RowIcon, label, value, href }) => (
                <div key={label} className="flex items-start gap-1.5">
                  <RowIcon aria-hidden="true" size={ICON_SIZE.xs} className="mt-1 shrink-0 text-accent-300" />
                  <div className="min-w-0">
                    <dt className="text-[11px] uppercase tracking-wide text-brand-200/80">{label}</dt>
                    <dd className={value ? "" : "text-brand-200/70"}>
                      {value ? (
                        href ? (
                          <a href={href} className="hover:text-white hover:underline">{value}</a>
                        ) : (
                          value
                        )
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
            {hasCoords && (
              <a
                href={mapHref(library.latitude as number, library.longitude as number)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
              >
                <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
                {t("directions")}
              </a>
            )}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
          <StatCard label={t("fund")} value={library.fundCount.toLocaleString()} unit={t("fundUnit")} />
          <StatCard label={t("available")} value={availableBooks.length.toLocaleString()} unit={t("availableUnit")} />
          <StatCard label={t("codeLabel")} value={library.code} unit="" mono />
        </div>
      </section>

      <div className="mt-5">
        {/* Status warning */}
        {library.status === "FROZEN" && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-yellow-800">
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} />
              {t("frozen")}
            </span>
            {library.frozenReason && <span className="ml-2 text-sm">— {library.frozenReason}</span>}
          </div>
        )}

        {/* Books section */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-900">
              {t("booksHeading", { count: allBooks.length })}
            </h2>
            {/* Til prefiksi SHART: `/search` middleware tomonidan
                `/uz-Latn/search` ga yo'naltirilardi va ru/kaa foydalanuvchisi
                tilini yo'qotardi. */}
            <Link
              href={`/${pageLocale}/search?libraryId=${library.id}`}
              className="shrink-0 text-sm font-semibold text-brand-600 hover:underline"
            >
              {t("fullCatalog")}
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
                {t("emptyFund")}
              </p>
            </div>
          ) : (
            /* Kitoblar — kitobxon sahifasidagi bilan BIR XIL kartada.
               Avval bu yerda alohida qator maketi va emoji ishlatilardi. */
            <LibraryBooks books={allBooks as Book[]} library={library} locale={pageLocale} />
          )}
        </div>
      </div>
    </ReaderShell>
  );
}

/**
 * Kutubxona katalogi + bron mantig'i. Anonim foydalanuvchi bron bosgan
 * bo'lsa avval login'ga yuboriladi (aks holda 401 va tushunarsiz xato
 * chiqardi). Bron muvaffaqiyatli bo'lsa «keyingi qadam» oynasi ochiladi.
 */
function LibraryBooks({
  books,
  library,
  locale,
}: {
  books: Book[];
  library: Library;
  locale: string;
}) {
  const queryClient = useQueryClient();
  const [reservedIds, setReservedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [nextSteps, setNextSteps] = useState<ReservationInfo | null>(null);

  const reserveMut = useMutation({
    mutationFn: (book: Book) => reserveBook(book.id).then((tx) => ({ tx, book })),
    onMutate: (book) => {
      setPendingId(book.id);
      setErrors((e) => ({ ...e, [book.id]: "" }));
    },
    onSuccess: ({ tx, book }) => {
      setReservedIds((prev) => new Set(prev).add(book.id));
      // Profil "Bronlarim" ro'yxati shu so'rovdan oziqlanadi — yangilansin.
      queryClient.invalidateQueries({ queryKey: ["user-history"] });
      setNextSteps({
        bookTitle: book.title,
        libraryName: library.name,
        libraryAddress: library.address ?? null,
        libraryWorkHours: library.workHours ?? null,
        libraryHref: `/${locale}/library/${encodeURIComponent(library.code)}`,
        expiresAt: tx.reservationExpiresAt ?? null,
      });
    },
    onError: (err, book) => {
      const msg =
        (err as { response?: { data?: { message?: string } } } | null)?.response?.data
          ?.message ?? "Bron qilib bo'lmadi";
      setErrors((e) => ({ ...e, [book.id]: msg }));
    },
    onSettled: () => setPendingId(null),
  });

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {books.map((book) => (
          <div key={book.id}>
            <BookCard
              book={book}
              reserved={reservedIds.has(book.id)}
              reserving={pendingId === book.id}
              onReserve={() => {
                if (!hasAuthHintCookie()) {
                  window.location.href = `/${locale}/login`;
                  return;
                }
                reserveMut.mutate(book);
              }}
            />
            {errors[book.id] && (
              <p className="mt-1 px-1 text-[11px] text-red-600">{errors[book.id]}</p>
            )}
          </div>
        ))}
      </div>
      <ReservationNextSteps info={nextSteps} onClose={() => setNextSteps(null)} />
    </>
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
