import { MetadataRoute } from "next";
import { locales, defaultLocale } from "../i18n";
import { SITE_URL } from "@/lib/site";
import { apiBase } from "@/lib/api/base";

const BASE_URL = SITE_URL;
const API = apiBase();

// Sitemap har soatda qayta quriladi — yangi kitob/kutubxonalar Google'ga tushadi.
export const revalidate = 3600;

// Ommaviy statik sahifalar (mavjud bo'lmagan manzil sitemap'ga qo'yilmaydi —
// 404 URL'lar Google'da sayt bahosini tushiradi).
const STATIC_PAGES: { path: string; priority: number; freq: "daily" | "weekly" }[] = [
  { path: "", priority: 1.0, freq: "daily" },
  { path: "/search", priority: 0.9, freq: "daily" },
  { path: "/top", priority: 0.8, freq: "daily" },
  { path: "/donate", priority: 0.5, freq: "weekly" },
  { path: "/demo-request", priority: 0.5, freq: "weekly" },
];

const langAlternates = (path: string) => ({
  languages: Object.fromEntries(locales.map((l) => [l, `${BASE_URL}/${l}${path}`])),
});

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type LibRow = { code?: string | null; status?: string; updatedAt?: string; createdAt?: string };
type BookRow = { id: string; updatedAt?: string };

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of locales) {
    for (const p of STATIC_PAGES) {
      entries.push({
        url: `${BASE_URL}/${locale}${p.path}`,
        lastModified: now,
        changeFrequency: p.freq,
        priority: locale === defaultLocale ? p.priority : Math.max(0.3, p.priority - 0.2),
        alternates: langAlternates(p.path),
      });
    }
  }

  // Faol kutubxonalar
  const libs = (await getJson<LibRow[]>(`${API}/libraries?status=ACTIVE`)) ?? [];
  for (const l of Array.isArray(libs) ? libs : []) {
    if (!l.code) continue;
    const path = `/library/${encodeURIComponent(l.code)}`;
    entries.push({
      url: `${BASE_URL}/${defaultLocale}${path}`,
      lastModified: l.updatedAt ? new Date(l.updatedAt) : now,
      changeFrequency: "weekly",
      priority: 0.7,
      alternates: langAlternates(path),
    });
  }

  // Faol kutubxonalardagi kitoblar (har sahifa 200 ta, ko'pi bilan 25 000)
  for (let page = 1; page <= 125; page++) {
    const res = await getJson<{ total: number; data: BookRow[] }>(
      `${API}/books?activeLibraries=true&limit=200&page=${page}`
    );
    const rows = res?.data ?? [];
    for (const b of rows) {
      const path = `/book/${encodeURIComponent(b.id)}`;
      entries.push({
        url: `${BASE_URL}/${defaultLocale}${path}`,
        lastModified: b.updatedAt ? new Date(b.updatedAt) : now,
        changeFrequency: "weekly",
        priority: 0.6,
        alternates: langAlternates(path),
      });
    }
    if (!res || rows.length < 200 || page * 200 >= res.total) break;
  }

  return entries;
}
