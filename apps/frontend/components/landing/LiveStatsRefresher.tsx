"use client";

/**
 * Plan 05-09 Task 3 (LAND-01) — LiveStatsRefresher.
 *
 * Mounts on top of the SSR-rendered landing hero stats and polls
 * `${NEXT_PUBLIC_API_URL}/landing/stats` every 30 seconds. The SSR baseline
 * is supplied via `initialStats` so the first client paint matches the HTML
 * (no hydration mismatch). On fetch failure we keep the previous values —
 * never flash a zero or a spinner over the SSR snapshot.
 *
 * Crawlers (Googlebot, Yandex) see the SSR snapshot — SEO unaffected.
 * Users see live numbers — feel current.
 */

import { useEffect, useState } from "react";
import { apiBase } from "@/lib/api/base";

export type LandingStats = {
  libraries: number;
  users: number;
  books: number;
  transactionsThisMonth: number;
  readingIndex: number;
  lastUpdated: string | null;
};

export type LandingSlot =
  | "libraries"
  | "users"
  | "books"
  | "transactionsThisMonth"
  | "readingIndex";

// H18: apiBase() = `<origin>/api`. The old inline fallback only carried the
// /api prefix when the env var was UNSET — with NEXT_PUBLIC_API_URL set to
// the canonical bare origin, this fetch silently hit /landing/stats (404).
const API_BASE = apiBase();
const REFRESH_INTERVAL_MS = 30_000;

const formatter = new Intl.NumberFormat("uz-UZ");

function pick(stats: LandingStats, slot: LandingSlot): number {
  switch (slot) {
    case "libraries":
      return stats.libraries;
    case "users":
      return stats.users;
    case "books":
      return stats.books;
    case "transactionsThisMonth":
      return stats.transactionsThisMonth;
    case "readingIndex":
      return stats.readingIndex;
  }
}

export function LiveStatsRefresher({
  initialStats,
  slot,
  suffix = "+",
}: {
  initialStats: LandingStats;
  slot: LandingSlot;
  suffix?: string;
}) {
  const [stats, setStats] = useState<LandingStats>(initialStats);

  useEffect(() => {
    let cancelled = false;

    async function fetchOnce() {
      try {
        const res = await fetch(`${API_BASE}/landing/stats`, {
          // Public endpoint; do not send credentials.
          credentials: "omit",
          cache: "no-store",
        });
        if (!res.ok) return;
        const fresh = (await res.json()) as LandingStats;
        if (!cancelled) setStats(fresh);
      } catch {
        // Swallow — keep the last known good values rather than flashing zero.
      }
    }

    const id = setInterval(fetchOnce, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const value = pick(stats, slot);
  return <span>{formatter.format(Math.round(value))}{suffix}</span>;
}
