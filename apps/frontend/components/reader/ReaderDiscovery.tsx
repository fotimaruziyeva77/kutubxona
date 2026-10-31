"use client";

/**
 * ReaderDiscovery — "keyingi kitobni tanlash" bloki.
 *
 * NEGA QO'SHILDI: kitobxon sahifasida KASHFIYOT umuman yo'q edi. Foydalanuvchi
 * o'z tarixini ko'rar, lekin YANGI kitobga yo'l topolmasdi — qidiruvga o'tib,
 * nima izlashni o'zi o'ylab topishi kerak edi. Kitobxonlikni oshirish
 * maqsadi qo'yilgan mahsulotda bu eng katta bo'shliq.
 *
 * Ikki manba:
 *  1. `/ai/recommendations` — shaxsiy tavsiya (sabab bilan: "nega bu kitob").
 *  2. `/books` — fonddagi mavjud kitoblar (tavsiya bo'sh bo'lsa ham blok
 *     bo'sh qolmasin; yangi kitobxonda tarix yo'q, shuning uchun tavsiya
 *     ham bo'lmaydi).
 *
 * Bron shu yerdan qilinadi — kitobni ko'rgan joyda darhol olish mumkin,
 * boshqa sahifaga o'tish shart emas.
 */

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { reserveBook } from "@/lib/api/libraries";
import { BookCard, type BookCardData } from "@/components/books/BookCard";
import {
  ReservationNextSteps,
  type ReservationInfo,
} from "@/components/reader/ReservationNextSteps";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

type Recommendation = {
  bookId: string;
  title: string;
  author: string;
  genre: string;
  coverUrl?: string | null;
  reason: string;
  libraryName?: string;
  libraryId?: string;
  available: boolean;
};

async function fetchRecommendations(): Promise<Recommendation[]> {
  const res = await apiClient("/ai/recommendations");
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchBrowseBooks(): Promise<BookCardData[]> {
  const res = await apiClient("/books?limit=12");
  if (!res.ok) return [];
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data?.items ?? []);
  return list as BookCardData[];
}

export function ReaderDiscovery({
  locale,
  onToast,
}: {
  locale: string;
  onToast: (msg: string) => void;
}) {
  const t = useTranslations("ReaderBits.discovery");
  const [reservedIds, setReservedIds] = useState<Set<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Bron yuborilgach ochiladigan «keyingi qadam» oynasi (tasdiq muddati,
  // qaysi kutubxona, QR). Avval faqat toast chiqardi — kitobxon keyin nima
  // qilishni bilmay qolardi.
  const [nextSteps, setNextSteps] = useState<ReservationInfo | null>(null);

  const { data: recs = [] } = useQuery({
    queryKey: ["reader-recommendations"],
    queryFn: fetchRecommendations,
    staleTime: 300_000,
  });

  const { data: browse = [], isLoading } = useQuery({
    queryKey: ["reader-browse-books"],
    queryFn: fetchBrowseBooks,
    staleTime: 300_000,
  });

  const handleReserve = async (bookId: string, card?: BookCardData) => {
    setPendingId(bookId);
    try {
      const tx = await reserveBook(bookId);
      setReservedIds((prev) => new Set(prev).add(bookId));
      setNextSteps({
        bookTitle: card?.title ?? "",
        libraryName: card?.library?.name ?? null,
        libraryHref: card?.library?.code
          ? `/${locale}/library/${encodeURIComponent(card.library.code)}`
          : card?.library?.id
            ? `/${locale}/library/${encodeURIComponent(card.library.id)}`
            : null,
        expiresAt: tx.reservationExpiresAt ?? null,
      });
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response
        ?.data?.message;
      onToast(msg ?? t("reserveError"));
    } finally {
      setPendingId(null);
    }
  };

  // Tavsiyani karta shakliga keltiramiz. `availableCount` tavsiya javobida
  // yo'q — faqat `available` bayrog'i bor, shuning uchun 1/0 ga aylantiramiz
  // (karta "Oxirgi 1 ta" yozmasligi uchun mavjudni 3 deb emas, aniq
  // ko'rsatiladigan minimal qiymat sifatida beramiz).
  const recCards: BookCardData[] = recs.map((r) => ({
    id: r.bookId,
    title: r.title,
    author: r.author,
    genre: r.genre,
    coverUrl: r.coverUrl,
    availableCount: r.available ? 3 : 0,
    library: r.libraryName ? { name: r.libraryName, id: r.libraryId } : null,
  }));

  // Bir xil sarlavha bir necha kutubxonada alohida `Book` qatori sifatida
  // saqlanadi (nusxa modeli yo'q). Kashfiyot to'rida ularni takrorlash
  // — "Meditations" ketma-ket ikki marta — tanlovni qiyinlashtiradi.
  // Sarlavha+muallif bo'yicha bittasini qoldiramiz: nusxasi ko'progini,
  // chunki uni olish ehtimoli yuqori.
  const recKeys = new Set(
    recCards.map((r) => `${r.title}|${r.author}`.toLowerCase()),
  );
  const bestByTitle = new Map<string, BookCardData>();
  for (const b of browse) {
    const key = `${b.title}|${b.author}`.toLowerCase();
    if (recKeys.has(key)) continue; // tavsiyada allaqachon bor
    const prev = bestByTitle.get(key);
    if (!prev || (b.availableCount ?? 0) > (prev.availableCount ?? 0)) {
      bestByTitle.set(key, b);
    }
  }
  const browseCards = [...bestByTitle.values()].slice(0, 8);

  const nothingToShow =
    !isLoading && recCards.length === 0 && browseCards.length === 0;

  return (
    <section className="space-y-6">
      <ReservationNextSteps info={nextSteps} onClose={() => setNextSteps(null)} />
      {/* Shaxsiy tavsiyalar */}
      {recCards.length > 0 && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Icon.sparkle
              aria-hidden="true"
              size={ICON_SIZE.sm}
              className="text-accent-500"
            />
            <h2 className="text-base font-bold text-slate-900">{t("forYou")}</h2>
          </div>
          {/* Sabab FAQAT bitta tavsiya bo'lganda ko'rsatiladi — bir nechta
              kitobning sababi har xil bo'ladi va bittasini umumiy sarlavha
              qilib qo'yish qolganlari haqida yolg'on ma'lumot berardi. */}
          <p className="mb-4 text-xs text-slate-500">
            {recs.length === 1 ? recs[0].reason : t("forYouHint")}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {recCards.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onReserve={(id) => handleReserve(id, book)}
                reserving={pendingId === book.id}
                reserved={reservedIds.has(book.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Fonddan tanlash */}
      {(browseCards.length > 0 || isLoading) && (
        <div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Icon.library
                aria-hidden="true"
                size={ICON_SIZE.sm}
                className="text-brand-500"
              />
              <h2 className="text-base font-bold text-slate-900">
                {t("fromFund")}
              </h2>
            </div>
            <Link
              href={`/${locale}/search`}
              className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
            >
              {t("all")}
              <Icon.next aria-hidden="true" size={ICON_SIZE.xs} />
            </Link>
          </div>

          {isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-[2/3] animate-pulse rounded-2xl bg-surface-sunken"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {browseCards.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onReserve={(id) => handleReserve(id, book)}
                  reserving={pendingId === book.id}
                  reserved={reservedIds.has(book.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {nothingToShow && (
        <div className="card-surface rounded-2xl p-8 text-center">
          <Icon.empty
            aria-hidden="true"
            size={32}
            strokeWidth={1.25}
            className="mx-auto text-slate-300"
          />
          <p className="mt-3 text-sm text-slate-500">
            {t("emptyFund")}
          </p>
          <Link
            href={`/${locale}/search`}
            className="mt-4 inline-flex h-10 items-center rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t("goSearch")}
          </Link>
        </div>
      )}
    </section>
  );
}
