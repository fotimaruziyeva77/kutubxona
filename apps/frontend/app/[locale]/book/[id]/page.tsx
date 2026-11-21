import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { BookCover } from "@/components/books/BookCover";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { apiBase } from "@/lib/api/base";
import { SITE_URL } from "@/lib/site";
import { BookReserveBox } from "@/components/books/BookReserveBox";
import { BookReviews } from "@/components/books/BookReviews";
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
  const url = `${SITE_URL}/${params.locale}/book/${encodeURIComponent(book.id)}`;
  const where = book.library?.name ? ` ${book.library.name}da mavjud.` : "";
  const description =
    book.description?.replace(/\s+/g, " ").slice(0, 155) ||
    `«${book.title}» — ${book.author}.${where} SIFAT LIBRARY orqali bepul bron qiling.`;
  const image = book.coverUrl
    ? `${SITE_URL}/api/books/${encodeURIComponent(book.id)}/cover`
    : `${SITE_URL}/og-image.png`;
  return {
    title: `${book.title} — ${book.author}`,
    description,
    alternates: { canonical: url },
    openGraph: { type: "book", title: `${book.title} — ${book.author}`, description, url, siteName: "SIFAT LIBRARY", images: [image] },
    twitter: { card: "summary_large_image", title: book.title, description, images: [image] },
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
    realIsbn ? { label: "ISBN", value: realIsbn } : null,
    { label: t("author"), value: book.author },
    book.pages ? { label: t("pages"), value: String(book.pages) } : null,
    book.year ? { label: t("year"), value: String(book.year) } : null,
    book.lang ? { label: t("lang"), value: book.lang.toUpperCase() } : null,
    book.genre ? { label: t("genre"), value: book.genre } : null,
  ].filter(Boolean) as { label: string; value: string }[];
  const places = [book, ...copies];
  const placesWithCopies = places.filter((b) => (b.availableCount ?? 0) > 0).length;

  // schema.org/Book — Google kitob natijalarida (muallif, ISBN) ko'rsatishi uchun.
  const realIsbnLd = book.isbn && !book.isbn.startsWith("2") ? book.isbn : undefined;
  const bookLd = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: book.title,
    author: { "@type": "Person", name: book.author },
    ...(realIsbnLd ? { isbn: realIsbnLd } : {}),
    ...(book.genre ? { genre: book.genre } : {}),
    ...(book.lang ? { inLanguage: book.lang } : {}),
    ...(book.pages ? { numberOfPages: book.pages } : {}),
    ...(book.year ? { datePublished: String(book.year) } : {}),
    ...(book.description ? { description: book.description.slice(0, 500) } : {}),
    url: `${SITE_URL}/${locale}/book/${encodeURIComponent(book.id)}`,
    ...(book.coverUrl ? { image: `${SITE_URL}/api/books/${encodeURIComponent(book.id)}/cover` } : {}),
  };

  return (
    <div className="min-h-screen bg-surface-muted" data-public-shell="">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(bookLd).replace(/</g, "\\u003c") }}
      />
      <ScrollReveal />
      <LandingHeader locale={locale} solid />

      <div className="mx-auto max-w-6xl px-4 pb-20 pt-6 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
          <Link href={`/${locale}`} className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-600 hover:underline">
            <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
            {t("home")}
          </Link>
          <span aria-hidden="true" className="text-slate-300">/</span>
          {book.genre ? (
            <Link href={`/${locale}/search?q=${encodeURIComponent(book.genre)}`} className="shrink-0 text-slate-500 hover:text-brand-700">
              {book.genre}
            </Link>
          ) : (
            <Link href={`/${locale}/search`} className="shrink-0 text-slate-500 hover:text-brand-700">
              {t("books")}
            </Link>
          )}
          <span aria-hidden="true" className="text-slate-300">/</span>
          <span className="min-w-0 truncate text-slate-700">{book.title}</span>
        </nav>

        {/* ── Asosiy karta ─────────────────────────────────────────────── */}
        <section className="mt-5 grid gap-8 rounded-3xl border border-brand-100 bg-white p-5 shadow-sm sm:p-8 md:grid-cols-[minmax(0,18rem)_1fr] lg:gap-12">
          <div className="min-w-0">
            <div className="hero-canvas relative flex justify-center overflow-hidden rounded-2xl px-6 py-8">
              <div className="w-44 sm:w-52 md:w-full">
                <div className="book-float">
                  <BookCover size="lg" title={book.title} author={book.author} genre={book.genre} coverUrl={coverSrc(book)} className="shadow-2xl" />
                </div>
              </div>
            </div>

            {/* Qayerda bor */}
            <div className="mt-5">
              <p
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                  placesWithCopies > 0 ? "bg-green-50 text-green-700 ring-1 ring-green-200" : "bg-slate-100 text-slate-600"
                }`}
              >
                {placesWithCopies > 0 ? t("inLibraries", { count: placesWithCopies }) : t("unavailable")}
              </p>
              <ul className="mt-2 space-y-2">
                {places.map((b) => {
                  const ok = (b.availableCount ?? 0) > 0;
                  return (
                    <li key={b.id}>
                      <Link
                        href={libraryHref(locale, b)}
                        className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2.5 text-sm transition hover:border-brand-300 hover:shadow-sm"
                      >
                        <Icon.library aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0 text-brand-500" />
                        <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{b.library?.name ?? "—"}</span>
                        <span className={`shrink-0 text-xs font-semibold ${ok ? "text-green-600" : "text-slate-400"}`}>
                          {ok ? t("copies", { count: b.availableCount ?? 0 }) : t("unavailableShort")}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="min-w-0">
            {book.genre && <p className="text-xs font-bold uppercase tracking-wide text-brand-600">{book.genre}</p>}
            <h1 className="mt-2 text-2xl font-bold leading-tight text-slate-900 sm:text-3xl lg:text-4xl">{book.title}</h1>
            <p className="mt-2 text-slate-500">{book.author}</p>

            <dl className="mt-6 space-y-2.5 text-sm">
              {facts.map((f) => (
                <div key={f.label} className="flex items-baseline gap-2">
                  <dt className="shrink-0 text-slate-500">{f.label}</dt>
                  <span aria-hidden="true" className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-slate-300" />
                  <dd className="min-w-0 truncate text-right font-semibold text-slate-900">{f.value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-7">
              <BookReserveBox
                locale={locale}
                bookId={book.id}
                available={available}
                availableCount={book.availableCount ?? 0}
                totalCount={book.totalCount ?? 0}
                libraryName={book.library?.name}
                libraryHref={libraryHref(locale, book)}
                authorHref={`/${locale}/search?q=${encodeURIComponent(book.author)}`}
              />
            </div>
          </div>
        </section>

        {book.description && (
          <section data-reveal="" className="mt-8 rounded-3xl border border-brand-100 bg-white p-5 shadow-sm sm:p-8">
            <span className="inline-flex rounded-full bg-brand-600 px-4 py-1.5 text-xs font-bold text-white">{t("descriptionTab")}</span>
            <h2 className="mt-5 text-lg font-bold text-slate-900">{t("about")}</h2>
            <p className="mt-3 whitespace-pre-line leading-relaxed text-slate-600">{book.description}</p>
          </section>
        )}

        <BookReviews locale={locale} bookId={book.id} />

        {/* ── O'XSHASH KITOBLAR ─────────────────────────────────────────── */}
        {similar.length > 0 && (
          <section data-reveal="" className="mt-10">
            <h2 className="text-xl font-bold text-slate-900">{t("similarTitle")}</h2>
            <div data-reveal-stagger="" className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 pt-12 sm:grid-cols-3 lg:grid-cols-4">
              {similar.slice(0, 4).map((b) => {
                const ok = (b.availableCount ?? 0) > 0;
                return (
                  <Link
                    key={b.id}
                    href={`/${locale}/book/${encodeURIComponent(b.id)}`}
                    className="group flex h-full flex-col rounded-2xl border border-line bg-white px-4 pb-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="-mt-12 mb-4 flex h-44 items-end justify-center">
                      <div className="w-28 transition-transform duration-300 group-hover:-translate-y-1.5">
                        <BookCover size="md" title={b.title} author={b.author} genre={b.genre} coverUrl={coverSrc(b)} />
                      </div>
                    </div>
                    <p className="line-clamp-2 text-[15px] font-bold leading-snug text-slate-900 group-hover:text-brand-700">{b.title}</p>
                    <p className="mt-1 truncate text-sm text-slate-500">{b.author}</p>
                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-dashed border-line pt-3">
                      <span className={`text-sm font-bold ${ok ? "text-green-700" : "text-slate-400"}`}>
                        {ok ? t("free") : t("unavailableShort")}
                      </span>
                      <span aria-hidden="true" className={`grid h-9 w-9 place-items-center rounded-full text-white ${ok ? "bg-brand-600" : "bg-slate-300"}`}>
                        <Icon.bookmark size={16} />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
