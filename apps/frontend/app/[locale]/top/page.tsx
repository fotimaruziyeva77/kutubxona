import { Metadata } from "next";
import TopClient from "./TopClient";
import { apiBase } from "@/lib/api/base";

// ── SSR: meta teglar va boshlang'ich ma'lumot ─────────────────────────────────

export const metadata: Metadata = {
  // Qobiq `template: "%s | SIFAT LIBRARY"` ni qo'shadi — bu yerda
  // takrorlansa brauzer yorlig'ida nom ikki marta chiqadi.
  title: "Top-100 Kitobxonlar",
  description: "O'zbekiston bo'yicha eng faol kitobxonlar reytingi. Oylik Top-100, mahallalar, maktablar va oilalar reytingi.",
  openGraph: {
    title: "Top-100 Kitobxonlar | SIFAT LIBRARY",
    description: "O'zbekiston milliy kitobxonlik reytingi — real vaqt",
    type: "website",
    images: [{ url: "/icons/og-top100.png", width: 1200, height: 630 }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Top-100 Kitobxonlar",
    description: "SIFAT LIBRARY milliy reyting",
    images: ["/icons/og-top100.png"]
  }
};

// H18: apiBase() = `<origin>/api` — the old fallback lost the /api prefix
// whenever the env var was set to the canonical bare origin.
const API_BASE = apiBase();

async function fetchTop(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  try {
    // 1 soatlik kesh reyting e'lon qilingandan keyin ham sahifada
    // "hali e'lon qilinmagan" degan YOLG'ON holatni bir soatgacha ushlab
    // turardi. Bu sahifa o'zini real vaqt deb e'lon qiladi — 5 daqiqa
    // SEO/birinchi chizish uchun yetarli, qolganini klient yangilaydi.
    const res = await fetch(`${API_BASE}/top?${qs}`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function fetchStats() {
  try {
    const res = await fetch(`${API_BASE}/donate/stats`, { next: { revalidate: 300 } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export default async function TopPage() {
  const [topData, donateStats] = await Promise.all([
    fetchTop({ limit: "100" }),
    fetchStats()
  ]);

  return <TopClient initialData={topData} donateStats={donateStats} />;
}
