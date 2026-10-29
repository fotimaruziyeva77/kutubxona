import { MetadataRoute } from "next";
import { locales } from "../i18n";

const BASE_URL = "https://sifat.uz";

// Statik sahifalar
const STATIC_PAGES = [
  "",         // Bosh sahifa
  "/top",     // Reytinglar
  "/donate",  // Donat
];

// Viloyat sluglar (14 ta)
const VILOYAT_SLUGS = [
  "toshkent", "samarqand", "fargona", "andijon", "namangan",
  "qashqadaryo", "surxondaryo", "jizzax", "sirdaryo", "navoiy",
  "buxoro", "xorazm", "qoraqalpogiston", "toshkent-shahri",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  // Statik sahifalar — barcha lokaller uchun
  for (const locale of locales) {
    for (const page of STATIC_PAGES) {
      entries.push({
        url: `${BASE_URL}/${locale}${page}`,
        lastModified: now,
        changeFrequency: page === "" ? "daily" : "weekly",
        priority: page === "" ? 1.0 : 0.8,
        alternates: {
          languages: Object.fromEntries(
            locales.map((l) => [l, `${BASE_URL}/${l}${page}`])
          ),
        },
      });
    }
  }

  // Viloyat sahifalari — asosiy lokall uchun (bosh sahifa)
  for (const viloyat of VILOYAT_SLUGS) {
    entries.push({
      url: `${BASE_URL}/uz-Latn/${viloyat}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    });
  }

  return entries;
}
