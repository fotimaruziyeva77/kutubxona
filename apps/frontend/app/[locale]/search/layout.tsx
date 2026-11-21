import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/lib/site";

const TITLES: Record<string, string> = {
  "uz-Latn": "Kitob qidirish — barcha kutubxonalar katalogi",
  "uz-Cyrl": "Китоб қидириш — барча кутубхоналар каталоги",
  ru: "Поиск книг — каталог всех библиотек",
  kaa: "Kitap izlew — barlıq kitapxanalar katalogı",
};

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  const url = `${SITE_URL}/${params.locale}/search`;
  return {
    title: TITLES[params.locale] ?? TITLES["uz-Latn"],
    description:
      "SIFAT LIBRARY katalogi: kitobni nomi, muallifi yoki ISBN bo'yicha qidiring, qaysi kutubxonada bo'sh nusxa borligini ko'ring va onlayn bron qiling.",
    alternates: { canonical: url },
    openGraph: { url, siteName: "SIFAT LIBRARY", images: [`${SITE_URL}/og-image.png`] },
  };
}

export default function SearchLayout({ children }: { children: ReactNode }) {
  return children;
}
