"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getLibrary, getLibraryByCode, reserveBook, type Book, type Library } from "@/lib/api/libraries";
import { apiClient } from "@/lib/api/client";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { useAuthStore } from "@/store/auth.store";
import { AdaptiveShell, useIsReader } from "@/components/reader/AdaptiveShell";
import { BookCard } from "@/components/books/BookCard";
import { BookCover } from "@/components/books/BookCover";
import {
  ReservationNextSteps,
  type ReservationInfo,
} from "@/components/reader/ReservationNextSteps";
import { OverdueNotice, findOverdue } from "@/components/reader/OverdueNotice";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

const TYPE_KEYS = ["GOV", "SCH", "UNI", "ORG", "MAH"] as const;
const TYPE_ICONS = { GOV: Icon.mahalla, SCH: Icon.school, UNI: Icon.university, ORG: Icon.organization, MAH: Icon.library };

/**
 * `findByCode` javobidagi qo'shimcha maydonlar. `books` 50 ta bilan
 * cheklangan, shuning uchun "Mavjud" soni ro'yxat uzunligidan EMAS, backend
 * butun fond bo'yicha hisoblagan shu maydonlardan olinadi. Eski backend yoki
 * id bo'yicha zaxira yo'l ularni qaytarmaydi — u holda "—".
 */
type LibraryWithCounts = Library & {
  availableCopies?: number;
  availableTitles?: number;
};

/** Ochiq GET /books/:id — kitob o'z kutubxonasi bilan (code bilan). */
type BookWithLibrary = Book & {
  updatedAt?: string;
  library?: { id: string; name: string; code?: string };
};

type HistoryTx = {
  status: string;
  bookId?: string;
  dueDate?: string | null;
  book?: { id?: string; title?: string; library?: { name?: string } | null } | null;
};

// The route param is named [code], but search-result links may pass a raw
// library id instead — the books/search payload reliably carries libraryId,
// while the human `code` is only present on the Prisma-fallback path (the
// Elasticsearch path omits the library object). So resolve by code first and
// fall back to id. Library codes ("LIB-…") and CUIDs never collide.
async function resolveLibrary(codeOrId: string): Promise<LibraryWithCounts> {
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

/** Muqova — bosh sahifa va qidiruvdagi bilan bir xil manba qoidasi. */
function coverSrc(book: { id: string; coverUrl?: string | null; updatedAt?: string }): string | null {
  if (!book.coverUrl) return null;
  return `/api/books/${encodeURIComponent(book.id)}/cover${
    book.updatedAt ? `?v=${encodeURIComponent(book.updatedAt)}` : ""
  }`;
}

export default function LibraryProfileClient({ code }: { code: string }) {
  // useSearchParams — Suspense chegarasi ichida (Next 14 talabi).
  return (
    <Suspense fallback={null}>
      <LibraryProfileInner code={code} />
    </Suspense>
  );
}

function LibraryProfileInner({ code }: { code: string }) {
  // Xato holatidagi "Bosh sahifaga qaytish" havolasi til prefiksisiz "/" ga
  // ketardi — ru/kaa foydalanuvchisi til tanlovini yo'qotardi.
  const pageLocale = useLocale();
  const t = useTranslations("LibraryPage");
  const tOverdue = useTranslations("OverdueNotice");
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedBookId = searchParams.get("book");
  const queryClient = useQueryClient();
  const isReader = useIsReader();
  const userId = useAuthStore((s) => s.user?.id);

  // Mehmonmi — faqat mountdan keyin aniqlanadi (cookie SSR'da o'qilmaydi).
  const [isGuest, setIsGuest] = useState(false);
  useEffect(() => setIsGuest(!hasAuthHintCookie()), []);

  const { data: library, isLoading, isError } = useQuery({
    queryKey: ["library-code", code],
    queryFn: () => resolveLibrary(code)
  });

  // Qidiruvdan tanlangan kitob (?book=<id>). Kutubxona katalogi faqat 50 ta
  // mavjud kitobni qaytaradi — tanlangan kitob unda bo'lmasligi mumkin, shu
  // sabab u alohida ochiq endpoint orqali olinadi.
  const { data: selectedBook } = useQuery({
    queryKey: ["book", selectedBookId],
    queryFn: () =>
      apiClient.get<BookWithLibrary>(`/books/${encodeURIComponent(selectedBookId!)}`).then((r) => r.data),
    enabled: !!selectedBookId,
    retry: false,
    staleTime: 60_000,
  });

  // Kitobxonning bronlari va qo'lidagi kitoblari — profil bilan bir xil
  // kesh kaliti (["user-history", id]), shuning uchun bron qilingach profil
  // ham, bu sahifa ham bir so'rovdan yangilanadi.
  const { data: history } = useQuery({
    queryKey: ["user-history", userId],
    queryFn: () =>
      apiClient
        .get<{ transactions: HistoryTx[] }>(`/transactions/user/${userId}/history`)
        .then((r) => r.data),
    enabled: isReader && !!userId,
    retry: false,
  });

  const serverReservedIds = useMemo(
    () =>
      new Set(
        (history?.transactions ?? [])
          .filter((tx) => tx.status === "PENDING" || tx.status === "RESERVED")
          .map((tx) => tx.bookId ?? tx.book?.id)
          .filter((id): id is string => !!id),
      ),
    [history],
  );
  const overdue = useMemo(() => findOverdue(history?.transactions), [history]);
  const blocked = overdue.length > 0;

  // ── Bron holati — tanlangan karta va katalog uchun umumiy ────────────────
  const [localReservedIds, setLocalReservedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, { msg: string; blocked?: boolean }>>({});
  const [nextSteps, setNextSteps] = useState<ReservationInfo | null>(null);

  const isReserved = (id: string) => localReservedIds.has(id) || serverReservedIds.has(id);

  const reserveMut = useMutation({
    mutationFn: (book: Book) => reserveBook(book.id).then((tx) => ({ tx, book })),
    onMutate: (book) => {
      setPendingId(book.id);
      setErrors((e) => ({ ...e, [book.id]: { msg: "" } }));
    },
    onSuccess: ({ tx, book }) => {
      setLocalReservedIds((prev) => new Set(prev).add(book.id));
      // Profil "Bronlarim" ro'yxati shu so'rovdan oziqlanadi — yangilansin.
      queryClient.invalidateQueries({ queryKey: ["user-history"] });
      if (!library) return;
      setNextSteps({
        bookTitle: book.title,
        libraryName: library.name,
        libraryAddress: library.address ?? null,
        libraryWorkHours: library.workHours ?? null,
        libraryHref: `/${pageLocale}/library/${encodeURIComponent(library.code)}`,
        expiresAt: tx.reservationExpiresAt ?? null,
      });
    },
    onError: (err, book) => {
      const res = (err as { response?: { status?: number; data?: { message?: string } } } | null)
        ?.response;
      // 403 — muddati o'tgan kitob bloki: umumiy server matni o'rniga qaysi
      // kitob ekanini va profilga yo'lni ko'rsatamiz.
      if (res?.status === 403 && overdue.length > 0) {
        setErrors((e) => ({
          ...e,
          [book.id]: { msg: tOverdue("blockedError", { title: overdue[0].title }), blocked: true },
        }));
        return;
      }
      if (res?.status === 403) {
        queryClient.invalidateQueries({ queryKey: ["user-history"] });
      }
      setErrors((e) => ({
        ...e,
        [book.id]: { msg: res?.data?.message ?? t("reserveError"), blocked: res?.status === 403 },
      }));
    },
    onSettled: () => setPendingId(null),
  });

  const onReserve = (book: Book) => {
    if (!hasAuthHintCookie()) {
      // Kirgandan keyin AYNAN shu sahifaga va shu kitobga qaytsin. Login
      // sahifasi `next` ni faqat ichki yo'l sifatida qabul qiladi.
      const back = `/${pageLocale}/library/${encodeURIComponent(code)}?book=${encodeURIComponent(book.id)}`;
      router.push(`/${pageLocale}/login?next=${encodeURIComponent(back)}`);
      return;
    }
    if (blocked) return;
    reserveMut.mutate(book);
  };

  const shellTitle = library?.name ?? t("loading");

  if (isLoading) {
    return (
      <AdaptiveShell title={shellTitle}>
        <div className="flex min-h-[40vh] items-center justify-center text-lg text-slate-400">
          {t("loading")}
        </div>
      </AdaptiveShell>
    );
  }

  if (isError || !library) {
    return (
      <AdaptiveShell title={t("notFound")}>
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="text-center">
            <Icon.library aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-4 text-slate-300" />
            <p className="mb-2 text-2xl font-bold text-slate-800">{t("notFound")}</p>
            <p className="text-slate-500">{t("code", { code })}</p>
            <Link href={`/${pageLocale}`} className="mt-4 inline-block text-brand-600 hover:underline">{t("home")}</Link>
          </div>
        </div>
      </AdaptiveShell>
    );
  }

  // Tanlangan kitob faqat SHU kutubxonaga tegishli bo'lsa ko'rsatiladi.
  const selected =
    selectedBook && selectedBook.libraryId === library.id ? selectedBook : null;
  const allBooks = (library.books ?? []).filter((b) => b.id !== selected?.id);

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

  const availableCopies =
    typeof library.availableCopies === "number" ? library.availableCopies : null;
  const shownCount = (library.books ?? []).length;
  const totalTitles =
    typeof library.availableTitles === "number" ? library.availableTitles : null;

  return (
    <AdaptiveShell title={library.name}>
      {blocked && (
        <OverdueNotice
          items={overdue}
          profileHref={`/${pageLocale}/profile`}
          className="mb-4"
        />
      )}

      {selected && (
        <SelectedBookCard
          book={selected}
          libraryName={library.name}
          reserved={isReserved(selected.id)}
          reserving={pendingId === selected.id}
          blocked={blocked}
          isGuest={isGuest}
          error={errors[selected.id]}
          locale={pageLocale}
          onReserve={() => onReserve(selected)}
        />
      )}

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
          {/* "Mavjud" — butun fonddagi mavjud NUSXALAR soni (backend). Avval
              bu yerda 50 talik ro'yxat uzunligi chiqardi — na nom, na nusxa
              soni edi. Raqam kelmasa o'ylab topilmaydi: "—". */}
          <StatCard
            label={t("available")}
            value={availableCopies !== null ? availableCopies.toLocaleString() : "—"}
            unit={availableCopies !== null ? t("availableUnit") : ""}
          />
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
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-xl font-bold text-slate-900">
              {totalTitles !== null && totalTitles > shownCount
                ? t("booksHeadingOf", { shown: shownCount, total: totalTitles })
                : t("booksHeading", { count: shownCount })}
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
          {isGuest && (allBooks.length > 0 || selected) && (
            <p className="-mt-2 mb-4 text-xs text-slate-500">{t("loginToReserve")}</p>
          )}

          {allBooks.length === 0 && !selected ? (
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {allBooks.map((book) => (
                <div key={book.id}>
                  <fieldset disabled={blocked} className="m-0 min-w-0 border-0 p-0">
                    <BookCard
                      book={{ ...book, coverUrl: coverSrc(book as BookWithLibrary) }}
                      reserved={isReserved(book.id)}
                      reserving={pendingId === book.id}
                      onReserve={() => onReserve(book)}
                    />
                  </fieldset>
                  {errors[book.id]?.msg && (
                    <ReserveError error={errors[book.id]} locale={pageLocale} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ReservationNextSteps info={nextSteps} onClose={() => setNextSteps(null)} />
    </AdaptiveShell>
  );
}

function ReserveError({
  error,
  locale,
}: {
  error: { msg: string; blocked?: boolean };
  locale: string;
}) {
  const t = useTranslations("OverdueNotice");
  return (
    <p className="mt-1 px-1 text-[11px] text-red-600">
      {error.msg}
      {error.blocked && (
        <>
          {" "}
          <Link href={`/${locale}/profile`} className="font-semibold underline">
            {t("link")}
          </Link>
        </>
      )}
    </p>
  );
}

/**
 * Qidiruvdan tanlangan kitob — sahifaning eng tepasida, Bron tugmasi bilan.
 * Telefonda birinchi ekranda ko'rinishi uchun ixcham gorizontal karta va
 * ochilganda unga scroll qilinadi.
 */
function SelectedBookCard({
  book,
  libraryName,
  reserved,
  reserving,
  blocked,
  isGuest,
  error,
  locale,
  onReserve,
}: {
  book: BookWithLibrary;
  libraryName: string;
  reserved: boolean;
  reserving: boolean;
  blocked: boolean;
  isGuest: boolean;
  error?: { msg: string; blocked?: boolean };
  locale: string;
  onReserve: () => void;
}) {
  const t = useTranslations("LibraryPage");
  const tc = useTranslations("BookCard");
  const ts = useTranslations("ReaderSearch");
  const ref = useRef<HTMLElement>(null);
  const inStock = (book.availableCount ?? 0) > 0;

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [book.id]);

  return (
    <section
      ref={ref}
      id="tanlangan-kitob"
      aria-labelledby="selected-book-title"
      className="mb-4 scroll-mt-24 rounded-2xl border-2 border-brand-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-600">
        {t("selectedBook")}
      </p>
      <div className="mt-3 flex gap-4">
        <div className="w-20 shrink-0 sm:w-24">
          <BookCover
            size="md"
            title={book.title}
            author={book.author}
            genre={book.genre}
            coverUrl={coverSrc(book)}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="selected-book-title" className="line-clamp-2 text-base font-bold leading-snug text-slate-900 sm:text-lg">
            {book.title}
          </h2>
          <p className="mt-0.5 truncate text-sm text-slate-500">{book.author}</p>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500">
            <Icon.library aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0" />
            <span className="truncate">{libraryName}</span>
          </p>
          <p className={`mt-1.5 text-sm font-medium ${inStock ? "text-green-700" : "text-red-500"}`}>
            {inStock
              ? ts("freeAvailable", { count: book.availableCount })
              : ts("notAvailable")}
          </p>
          <div className="mt-auto pt-3">
            <button
              type="button"
              onClick={onReserve}
              disabled={!inStock || reserving || reserved || blocked}
              className={`inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl px-5 text-sm font-semibold transition-colors sm:w-auto ${
                reserved
                  ? "bg-info-50 text-info-700"
                  : inStock && !blocked
                    ? "bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-60"
                    : "cursor-not-allowed bg-surface-sunken text-slate-400"
              }`}
            >
              {reserved ? (
                <>
                  <Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />
                  {tc("reserved")}
                </>
              ) : reserving ? (
                tc("sending")
              ) : inStock ? (
                tc("reserve")
              ) : (
                tc("unavailable")
              )}
            </button>
            {isGuest && inStock && !reserved && (
              <p className="mt-1.5 text-xs text-slate-500">{t("loginToReserve")}</p>
            )}
          </div>
        </div>
      </div>
      {error?.msg && <ReserveError error={error} locale={locale} />}
    </section>
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
