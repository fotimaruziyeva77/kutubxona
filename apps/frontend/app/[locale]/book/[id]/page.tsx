import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { BookCover } from "@/components/books/BookCover";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { apiBase } from "@/lib/api/base";
import "@/components/landing/public-shell.css";

/**
 * Kitob sahifasi — bosh sahifadagi kitob kartasi shu yerga olib keladi.
 *
 * Avval karta `/search?q=...` ga yuborardi: mehmon bosh sahifa dizaynidan
 * butunlay boshqa (qidiruv ilovasi) interfeysga tushib qolardi. Endi sahifa
 * bosh sahifaning O'SHA sarlavhasi (LandingHeader) va uslubida chiziladi.
 * Bron qilish — kutubxona sahifasidagi mavjud oqim (`?book=` tanlangan karta),
 * u login va limit tekshiruvlarini o'zi bajaradi.
 *
 * Barcha raqamlar backenddan; yo'q maydon ko'rsatilmaydi (hech narsa o'ylab
 * topilmaydi).
 */

const API_BASE = apiBase();

type ApiLibrary = {
  id: string;
  code?: string | null;
  name: string;
  address?: string | null;
  phone?: string | null;
  status?: string;
};

type ApiBook = {
  id: string;
  isbn?: string | null;
  title: string;
  author: string;
  genre?: string | null;
  lang?: string | null;
  pages?: number | null;
  year?: number | null;
  coverUrl?: string | null;
  description?: string | null;
  totalCount?: number;
  availableCount?: number;
  libraryId: string;
  updatedAt?: string;
  library?: ApiLibrary | null;
};

async function fetchBook(id: string): Promise<ApiBook | null> {
  try {
    const res = await fetch(`${API_BASE}/books/${encodeURIComponent(id)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as ApiBook;
  } catch {
    return null;
  }
}

async function fetchList(query: string): Promise<ApiBook[]> {
  try {
    const res = await fetch(`${API_BASE}/books?activeLibraries=true&${query}`, {
      next: { revalidate: 120 },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : (json?.data ?? []);
  } catch {
    return [];
  }
}

const key = (b: ApiBook) => `${b.title.trim()}|${b.author.trim()}`.toLowerCase();

function coverSrc(b: ApiBook): string | null {
  if (!b.coverUrl) return null;
  return `/api/books/${encodeURIComponent(b.id)}/cover${b.updatedAt ? `?v=${encodeURIComponent(b.updatedAt)}` : ""}`;
}

function libraryHref(locale: string, b: ApiBook): string {
  const codeOrId = b.library?.code ?? b.libraryId;
  return `/${locale}/library/${encodeURIComponent(codeOrId)}?book=${encodeURIComponent(b.id)}`;
}

export async function generateMetadata({
  params,
}: {
  params: { locale: string; id: string };
}): Promise<Metadata> {
  const book = await fetchBook(params.id);
  if (!book) return {};
  return {
    title: `${book.title} — ${book.author}`,
    description: book.description?.slice(0, 160) || `${book.title} — ${book.author}`,
  };
}

export default async function BookPage({
  params: { locale, id },
}: {
  params: { locale: string; id: string };
}) {
  const book = await fetchBook(id);
  if (!book) notFound();
  const t = await getTranslations({ locale, namespace: "BookPage" });

  // Ichki kod (ISBN'siz kitob, "2..." bilan) boshqa kutubxonada boshqa kitob
  // bo'lishi mumkin — u holda nom+muallif bo'yicha solishtiramiz.
  const realIsbn = book.isbn && !book.isbn.startsWith("2") ? book.isbn : null;
  const [sameList, genreList] = await Promise.all([
    fetchList(`limit=30&q=${encodeURIComponent(realIsbn ?? book.title)}`),
    book.genre ? fetchList(`limit=24&genre=${encodeURIComponent(book.genre)}`) : Promise.resolve([]),
  ]);

  const copies = sameList.filter(
    (b) =>
      b.id !== book.id &&
      (realIsbn ? b.isbn === realIsbn : key(b) === key(book))
  );

  const seen = new Set([key(book)]);
  const similar = genreList
    .filter((b) => {
      if (seen.has(key(b))) return false;
      seen.add(key(b));
      return true;
    })
    .slice(0, 6);

  const available = (book.availableCount ?? 0) > 0;
  const facts = [
    book.genre ? { label: t("genre"), value: book.genre } : null,
    book.year ? { label: t("year"), value: String(book.year) } : null,
    book.pages ? { label: t("pages"), value: String(book.pages) } : null,
    book.lang ? { label: t("lang"), value: book.lang.toUpperCase() } : null,
    realIsbn ? { label: "ISBN", value: realIsbn } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <div className="min-h-screen bg-surface-muted" data-public-shell="">
      <ScrollReveal />
      <LandingHeader locale={locale} solid />

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="hero-canvas relative overflow-hidden">
        <div aria-hidden="true" className="hero-orb hero-orb-a" />
        <div aria-hidden="true" className="hero-orb hero-orb-b" />
        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-6 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            <Link
              href={`/${locale}`}
              className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-600 hover:underline"
            >
              <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
              {t("home")}
            </Link>
            <span aria-hidden="true" className="text-slate-300">/</span>
            <Link href={`/${locale}/search`} className="shrink-0 text-slate-500 hover:text-brand-700">
              {t("books")}
            </Link>
            <span aria-hidden="true" className="text-slate-300">/</span>
            <span className="min-w-0 truncate text-slate-700">{book.title}</span>
          </nav>

          <div className="mt-8 grid items-center gap-10 md:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
            <div className="hero-enter mx-auto w-52 sm:w-60 md:w-full">
              <div className="book-float">
                <BookCover
                  size="lg"
                  title={book.title}
                  author={book.author}
                  genre={book.genre}
                  coverUrl={coverSrc(book)}
                  className="shadow-2xl"
                />
              </div>
            </div>

            <div className="hero-enter min-w-0">
              {book.genre && (
                <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white px-3 py-1 text-xs font-semibold text-brand-700 shadow-sm">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                  {book.genre}
                </span>
              )}
              <h1 className="mt-4 text-3xl font-bold leading-tight text-slate-900 sm:text-4xl lg:text-5xl">
                {book.title}
              </h1>
              <p className="mt-3 text-lg text-slate-600">{book.author}</p>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold ${
                    available ? "bg-green-50 text-green-700 ring-1 ring-green-200" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${available ? "live-dot bg-green-500" : "bg-slate-400"}`}
                  />
                  {available
                    ? t("available", { count: book.availableCount ?? 0, total: book.totalCount ?? 0 })
                    : t("unavailable")}
                </span>
                {book.library?.name && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-slate-500">
                    <Icon.library aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0 text-brand-500" />
                    <span className="truncate">{book.library.name}</span>
                  </span>
                )}
              </div>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href={libraryHref(locale, book)}
                  className="btn-shine inline-flex h-12 items-center gap-2 rounded-xl bg-brand-600 px-6 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:-translate-y-0.5 hover:bg-brand-700"
                >
                  <Icon.bookClosed aria-hidden="true" size={ICON_SIZE.sm} />
                  {available ? t("reserve") : t("openLibrary")}
                </Link>
                <Link
                  href={`/${locale}/search?q=${encodeURIComponent(book.author)}`}
                  className="inline-flex h-12 items-center gap-2 rounded-xl border border-line bg-white px-5 text-sm font-semibold text-slate-700 transition hover:-translate-y-0.5 hover:border-brand-300 hover:text-brand-700"
                >
                  <Icon.search aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("moreByAuthor")}
                </Link>
              </div>

              {facts.length > 0 && (
                <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {facts.map((f) => (
                    <div key={f.label} className="rounded-xl border border-line bg-white/80 px-4 py-3 backdrop-blur">
                      <dt className="text-xs text-slate-500">{f.label}</dt>
                      <dd className="mt-0.5 truncate text-sm font-semibold text-slate-900">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-12 px-4 pb-20 pt-10 sm:px-6 lg:px-8">
        {book.description && (
          <section data-reveal="" className="card-surface rounded-2xl p-6 sm:p-8">
            <h2 className="text-lg font-bold text-slate-900">{t("about")}</h2>
            <p className="mt-3 whitespace-pre-line leading-relaxed text-slate-600">{book.description}</p>
          </section>
        )}

        {/* ── QAYERDAN OLISH MUMKIN ───────────────────────────────────── */}
        <section data-reveal="">
          <h2 className="text-xl font-bold text-slate-900">{t("whereTitle")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("whereSubtitle")}</p>
          <ul data-reveal-stagger="" className="mt-5 grid gap-3 sm:grid-cols-2">
            {[book, ...copies].map((b) => {
              const ok = (b.availableCount ?? 0) > 0;
              return (
                <li key={b.id}>
                  <Link
                    href={libraryHref(locale, b)}
                    className="group flex items-center gap-4 rounded-2xl border border-line bg-white p-4 transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                      <Icon.library aria-hidden="true" size={ICON_SIZE.md} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-900 group-hover:text-brand-700">
                        {b.library?.name ?? "—"}
                      </span>
                      {b.library?.address && (
                        <span className="block truncate text-xs text-slate-500">{b.library.address}</span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        ok ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {ok ? t("copies", { count: b.availableCount ?? 0 }) : t("unavailableShort")}
                    </span>
                    <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── O'XSHASH KITOBLAR ─────────────────────────────────────────── */}
        {similar.length > 0 && (
          <section data-reveal="">
            <h2 className="text-xl font-bold text-slate-900">{t("similarTitle")}</h2>
            <div data-reveal-stagger="" className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
              {similar.map((b) => (
                <Link key={b.id} href={`/${locale}/book/${encodeURIComponent(b.id)}`} className="book-card group block">
                  <div className="book-card-stage rounded-2xl p-4">
                    <div className="book-card-cover mx-auto w-[80%]">
                      <BookCover size="md" title={b.title} author={b.author} genre={b.genre} coverUrl={coverSrc(b)} />
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm font-semibold text-slate-900 group-hover:text-brand-700">{b.title}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{b.author}</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
