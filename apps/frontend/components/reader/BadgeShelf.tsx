"use client";

/**
 * BadgeShelf — yutuqlar javoni.
 *
 * O'ZGARISH SABABI:
 *  • Avval badge'lar EMOJI bilan chizilardi (📖 🏆 🔥). Emoji har OS'da
 *    boshqacha ko'rinadi, rangini boshqarib bo'lmaydi va grayscale filtri
 *    Windows'da umuman ishlamaydi — "yopiq" badge ochiq badge'dan farq
 *    qilmasdi. Endi lucide ikonkalari: bir xil to'r, brend rangi.
 *  • Avval "Olingan / Mavjud" ikkita tab bor edi va yangi kitobxon
 *    "Olingan" tabida BO'SH ro'yxat ko'rardi — bu ruhlantirmaydi.
 *    Endi bitta javon: olingan badge'lar oldinda, keyin YAQIN kelayotgan
 *    yopiqlari. Maqsad ko'rinib turadi.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";

export type EarnedBadge = {
  id: string;
  awardedAt: string;
  badge: { code: string; name: string; description: string; icon: string };
};

export type CatalogBadge = {
  code: string;
  name: string;
  description: string;
  icon: string;
};

/**
 * Badge kodi → lucide ikonka. Backend `icon` maydonida emoji saqlaydi
 * (eski katalog), shuning uchun xaritalash FRONTENDDA qilinadi — backend
 * ma'lumotiga tegmasdan ko'rinishni yaxshilaymiz.
 */
const BADGE_ICONS: Record<string, LucideIcon> = {
  FIRST_BOOK: Icon.book,
  FIVE_BOOKS: Icon.bookClosed,
  TEN_BOOKS: Icon.library,
  TWENTY_BOOKS: Icon.star,
  FIFTY_BOOKS: Icon.trophy,
  HUNDRED_BOOKS: Icon.target,
  TOP_100: Icon.medal,
  TOP_10: Icon.award,
  STREAK_7: Icon.streak,
  STREAK_30: Icon.streak,
  DISCIPLINE: Icon.pending,
  DIVERSE_READER: Icon.sparkle,
  FAST_READER: Icon.index,
  COMPREHENSION_ACE: Icon.checklist,
  ISBN_SCANNER: Icon.qr,
  DONOR: Icon.donate,
  TRUST_MASTER: Icon.shield,
  ACTIVE_MONTH: Icon.calendar,
};

function badgeIcon(code: string): LucideIcon {
  return BADGE_ICONS[code] ?? Icon.award;
}

/** Boshlang'ich kitobxonga eng yaqin maqsadlar — shu tartibda ko'rsatiladi. */
const NEXT_UP_ORDER = [
  "FIRST_BOOK",
  "STREAK_7",
  "FIVE_BOOKS",
  "DIVERSE_READER",
  "TEN_BOOKS",
  "DISCIPLINE",
];

export function BadgeShelf({
  earned,
  catalog,
}: {
  earned: EarnedBadge[];
  catalog: CatalogBadge[];
}) {
  const t = useTranslations("ReaderBits.shelf");
  const [showAll, setShowAll] = useState(false);

  const earnedCodes = new Set(earned.map((e) => e.badge.code));
  const locked = catalog.filter((c) => !earnedCodes.has(c.code));

  // Yopiqlarni "yaqinlik" bo'yicha saralaymiz: ro'yxatdagilar oldinda.
  const sortedLocked = [...locked].sort((a, b) => {
    const ia = NEXT_UP_ORDER.indexOf(a.code);
    const ib = NEXT_UP_ORDER.indexOf(b.code);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const visibleLocked = showAll ? sortedLocked : sortedLocked.slice(0, 4);

  return (
    <section className="card-surface rounded-2xl p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">{t("title")}</h2>
        <p className="text-xs text-slate-500">
          {earned.length} / {catalog.length}
        </p>
      </div>

      {earned.length === 0 && (
        <p className="mb-4 rounded-xl bg-brand-50 px-3 py-2.5 text-xs leading-relaxed text-brand-700">
          {t("emptyHint")}
        </p>
      )}

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {/* Olinganlar — oltin, to'liq rangda */}
        {earned.map((b) => {
          const BadgeIcon = badgeIcon(b.badge.code);
          return (
            <div
              key={b.id}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-accent-200 bg-accent-50 p-3 text-center"
              title={`${b.badge.description} · ${new Date(b.awardedAt).toLocaleDateString("uz-UZ")}`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-400 text-white">
                <BadgeIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={2} />
              </span>
              <span className="line-clamp-2 text-[11px] font-semibold leading-tight text-slate-900">
                {b.badge.name}
              </span>
            </div>
          );
        })}

        {/* Yopiqlar — neytral, lekin O'QILADIGAN (kulrang emoji emas) */}
        {visibleLocked.map((b) => {
          const BadgeIcon = badgeIcon(b.code);
          return (
            <div
              key={b.code}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface-muted p-3 text-center"
              title={b.description}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-slate-400">
                <BadgeIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
              </span>
              <span className="line-clamp-2 text-[11px] font-medium leading-tight text-slate-500">
                {b.name}
              </span>
            </div>
          );
        })}
      </div>

      {sortedLocked.length > 4 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-4 w-full rounded-lg border border-line py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-surface-muted"
        >
          {showAll
            ? t("hide")
            : t("showMore", { count: sortedLocked.length - 4 })}
        </button>
      )}
    </section>
  );
}
