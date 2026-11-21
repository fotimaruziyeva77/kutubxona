import { SITE_URL } from "@/lib/site";

/**
 * schema.org JSON-LD — Google "SIFAT LIBRARY" / "Sifat Library" qidiruvida
 * saytni brend sifatida tanishi (sayt nomi, logotip, sitelinks qidiruv) uchun.
 * Ma'lumot statik — XSS xavfi yo'q; `<` belgisi baribir qochiriladi.
 */
export function JsonLdStructuredData({ locale = "uz-Latn" }: { locale?: string }) {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "SIFAT LIBRARY",
        alternateName: ["Sifat Library", "SifatLibrary", "Sifat kutubxona", "sifatlibrary.uz"],
        url: SITE_URL,
        logo: {
          "@type": "ImageObject",
          url: `${SITE_URL}/brand/app-icon-512.png`,
          width: 512,
          height: 512,
        },
        image: `${SITE_URL}/og-image.png`,
        description:
          "SIFAT LIBRARY — O'zbekiston kutubxonalarini bir tizimga birlashtiruvchi milliy kitobxonlik platformasi: kitob qidirish, bron qilish, Reading Index va reytinglar.",
        address: { "@type": "PostalAddress", addressCountry: "UZ" },
        sameAs: ["https://t.me/SifatLibraryBot"],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        name: "SIFAT LIBRARY",
        alternateName: ["Sifat Library", "SifatLibrary"],
        url: `${SITE_URL}/`,
        inLanguage: ["uz-Latn", "uz-Cyrl", "ru", "kaa"],
        publisher: { "@id": `${SITE_URL}/#organization` },
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${SITE_URL}/${locale}/search?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
