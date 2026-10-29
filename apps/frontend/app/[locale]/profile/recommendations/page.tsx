"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import Link from "next/link";

// ── Types ────────────────────────────────────────────────────────────────────

interface BookRecommendation {
  bookId: string;
  title: string;
  author: string;
  genre: string;
  coverUrl?: string;
  reason: string;
  score: number;
  libraryName?: string;
  libraryId?: string;
  available: boolean;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function fetchRecommendations(): Promise<BookRecommendation[]> {
  const res = await apiClient("/ai/recommendations");
  if (!res.ok) return [];
  return res.json();
}

// ── Genre color mapping ──────────────────────────────────────────────────────

const GENRE_COLORS: Record<string, string> = {
  Tarix: "bg-accent-100 text-accent-700",
  Falsafa: "bg-purple-100 text-purple-700",
  Fan: "bg-brand-100 text-brand-700",
  Adabiyot: "bg-green-100 text-green-700",
  Iqtisodiyot: "bg-emerald-100 text-emerald-700",
  Psixologiya: "bg-pink-100 text-pink-700",
};

function genreColor(genre: string): string {
  return GENRE_COLORS[genre] ?? "bg-surface-sunken text-slate-700";
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RecommendationsPage() {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("recommendations");
  const { isAuthenticated } = useAuthStore();

  const [recommendations, setRecommendations] = useState<BookRecommendation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push(`/${locale}/login`);
      return;
    }

    fetchRecommendations()
      .then(setRecommendations)
      .finally(() => setLoading(false));
  }, [isAuthenticated, locale, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-slate-500">{t("loading")}</div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-surface-muted py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Nav */}
        <div className="flex items-center justify-between">
          <Link
            href={`/${locale}/profile`}
            className="text-brand-600 hover:underline text-sm"
          >
            &larr; {t("backToProfile")}
          </Link>
        </div>

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
          <p className="text-sm text-slate-500 mt-1">{t("subtitle")}</p>
        </div>

        {/* Recommendations list */}
        {recommendations.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-slate-400">{t("empty")}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {recommendations.map((rec) => (
              <Card key={rec.bookId}>
                <CardContent className="p-4">
                  <div className="flex gap-4">
                    {/* Book info */}
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">
                            {rec.title}
                          </h3>
                          <p className="text-sm text-slate-500">{rec.author}</p>
                        </div>

                        {/* Availability badge */}
                        <span
                          className={`shrink-0 text-xs px-2 py-1 rounded-full font-medium ${
                            rec.available
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {rec.available ? t("available") : t("unavailable")}
                        </span>
                      </div>

                      {/* Genre badge */}
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${genreColor(rec.genre)}`}
                        >
                          {rec.genre}
                        </span>
                        {rec.libraryName && (
                          <span className="text-xs text-slate-400">
                            {rec.libraryName}
                          </span>
                        )}
                      </div>

                      {/* Reason */}
                      <p className="text-sm text-brand-600">
                        {t("reason")}: {rec.reason}
                      </p>

                      {/* Search link */}
                      <Link
                        href={`/${locale}/search?q=${encodeURIComponent(rec.title)}`}
                        className="inline-block text-xs text-blue-500 hover:underline mt-1"
                      >
                        {t("findNearby")} &rarr;
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
