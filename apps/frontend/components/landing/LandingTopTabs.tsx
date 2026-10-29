"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

type TopEntry = {
  rank: number;
  score: number;
  user?: { name?: string };
};

/** 1/2/3-o'rin — rangli medal (lucide), qolganlar raqam. Emoji ishlatilmaydi:
 *  har OS'da boshqacha chiziladi va qatorda tekis turmaydi. */
function RankBadge({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "bg-accent-100 text-accent-600"
      : rank === 2
        ? "bg-surface-sunken text-slate-500"
        : rank === 3
          ? "bg-orange-100 text-orange-700"
          : "bg-surface-muted text-slate-500";
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums ${tone}`}
    >
      {rank <= 3 ? (
        <Icon.medal aria-hidden="true" size={ICON_SIZE.md} strokeWidth={2} />
      ) : (
        rank
      )}
      <span className="sr-only">#{rank}</span>
    </span>
  );
}

/**
 * Landing "Oylik Top" bo'limi tablari. Faqat "Kitobxonlar" (0-tab) uchun real
 * reyting bor; qolganlari hali e'lon qilinmagan — "tez orada" holati
 * ko'rsatiladi (soxta ma'lumot ishlatilmaydi).
 */
export function LandingTopTabs({
  tabs,
  entries,
  emptyTitle,
  emptyDesc,
  scoreLabel,
  viewAllLabel,
  youTooLabel,
  topHref,
}: {
  tabs: string[];
  entries: TopEntry[];
  emptyTitle: string;
  emptyDesc: string;
  scoreLabel: string;
  viewAllLabel: string;
  youTooLabel: string;
  topHref: string;
}) {
  const [active, setActive] = useState(0);
  // Reyting faqat 0-tab (Kitobxonlar) uchun va ma'lumot bo'lsagina ko'rsatiladi.
  const showLeaderboard = active === 0 && entries.length > 0;

  return (
    <>
      {/* Tabs */}
      <div className="mb-8 flex flex-wrap justify-center gap-2">
        {tabs.map((tab, i) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={active === i}
            className={`min-h-11 cursor-pointer rounded-full border px-5 py-2 text-sm font-medium transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${
              active === i
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-line bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {showLeaderboard ? (
        <div className="mx-auto mb-8 max-w-3xl overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
          {entries.slice(0, 5).map((entry, i) => (
            <div
              key={entry.rank}
              className={`flex items-center gap-4 p-4 transition-colors hover:bg-surface-muted ${
                i > 0 ? "border-t border-line" : ""
              } ${entry.rank === 1 ? "bg-accent-50/60" : ""}`}
            >
              <RankBadge rank={entry.rank} />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                {entry.user?.name?.[0] ?? "?"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-900">
                  {entry.user?.name ?? "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-display text-lg font-semibold tabular-nums text-brand-700">
                  {entry.score.toFixed(1)}
                </p>
                <p className="text-xs text-slate-400">{scoreLabel}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mx-auto mb-8 max-w-3xl rounded-2xl border border-dashed border-line-strong bg-white p-10 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-50 text-accent-600">
            <Icon.trophy aria-hidden="true" size={ICON_SIZE.lg} strokeWidth={1.5} />
          </div>
          <p className="mb-1 text-lg font-semibold text-slate-900">{emptyTitle}</p>
          <p className="mx-auto max-w-md text-sm text-slate-500">{emptyDesc}</p>
        </div>
      )}

      <div className="space-y-3 text-center">
        <Link
          href={topHref}
          className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand-600 px-8 text-base font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          {viewAllLabel}
          <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
        </Link>
        <p className="text-sm text-slate-400">{youTooLabel}</p>
      </div>
    </>
  );
}

export default LandingTopTabs;
