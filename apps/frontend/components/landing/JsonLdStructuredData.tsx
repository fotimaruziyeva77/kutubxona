import Script from "next/script";
import { SITE_URL } from "@/lib/site";

/**
 * Plan 05-09 Task 3 (LAND-03) — schema.org JSON-LD for the landing page.
 *
 * Renders a GovernmentOrganization shape so Google / Yandex / Bing show a
 * rich knowledge-panel card for "SIFAT LIBRARY". `JSON.stringify` escapes the
 * embedded content automatically; data is static (not DB-sourced) so there is
 * no T-05-JSONLD-XSS risk surface (see threat_model in 05-09-PLAN.md).
 *
 * This is a server component (no "use client") — the <script> ships in the
 * SSR HTML and is visible to crawlers on first byte.
 */
export function JsonLdStructuredData() {
  const data = {
    "@context": "https://schema.org",
    "@type": "GovernmentOrganization",
    name: "SIFAT LIBRARY",
    alternateName: "Milliy Kitobxonlik Indeksi Platformasi",
    url: SITE_URL,
    description:
      "O'zbekiston Respublikasining milliy kutubxonlik monitoring va reyting platformasi. PQ-9 qarori asosida ishlab chiqilgan.",
    logo: `${SITE_URL}/brand/app-icon-512.png`,
    image: `${SITE_URL}/icons/og-main.png`,
    address: {
      "@type": "PostalAddress",
      addressCountry: "UZ",
      addressLocality: "Toshkent",
    },
    sameAs: [
      "https://t.me/sifat_uz",
    ],
    parentOrganization: {
      "@type": "GovernmentOrganization",
      name: "O'zbekiston Respublikasi Yoshlar Ishlari Agentligi",
    },
  };
  return (
    <Script
      id="ld-organization"
      type="application/ld+json"
      strategy="beforeInteractive"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
