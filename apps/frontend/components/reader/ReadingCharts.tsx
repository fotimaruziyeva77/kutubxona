"use client";

/**
 * ReadingCharts — kitobxonning shaxsiy o'qish tahlili.
 *
 * NEGA: raqam ("5 kitob") faktni aytadi, grafik esa YO'NALISHNI ko'rsatadi —
 * "o'sib boryapmanmi?". Aynan shu qaytib kelishga undaydi. Maktab paneli
 * direktorga diagramma beradi, kitobxonning o'zi esa hech narsa ko'rmasdi.
 *
 * HALOLLIK QOIDASI: barcha ustunlar HAQIQIY tranzaksiyalardan hisoblanadi.
 * Ma'lumot yetarli bo'lmasa (hali birorta kitob tugatilmagan) grafik
 * O'RNIGA nima qilish kerakligi yoziladi — bo'sh o'q va nol ustunlar
 * ko'rsatilmaydi, chunki bo'sh grafik "mahsulot buzuq" degan taassurot
 * beradi.
 *
 * Recharts allaqachon bog'liqliklarda (admin diagrammalari) — yangi
 * kutubxona qo'shilmaydi.
 */

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

export type FinishedBook = {
  /** Tugatilgan sana (ISO). */
  at: string;
  genre?: string | null;
};

/** Janr ustunlari uchun brend palitrasi — tasodifiy rang ishlatilmaydi. */
const GENRE_COLORS = [
  "#2563eb", "#1e3a8a", "#6096fa", "#f59e0b",
  "#10b981", "#8b5cf6", "#0891b2", "#d97706",
];

export function ReadingCharts({ finished }: { finished: FinishedBook[] }) {
  const t = useTranslations("ReaderBits.charts");
  const { monthly, byGenre, total } = useMemo(() => {
    const now = new Date();
    // Oxirgi 6 oy — 12 oy mobil ekranda o'qib bo'lmaydigan darajada siqiladi.
    const buckets: { oy: string; kitob: number; key: string }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        oy: t(`months.m${d.getMonth()}`),
        kitob: 0,
        key: `${d.getFullYear()}-${d.getMonth()}`,
      });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));

    const genreCount = new Map<string, number>();
    for (const f of finished) {
      const d = new Date(f.at);
      const bucket = byKey.get(`${d.getFullYear()}-${d.getMonth()}`);
      if (bucket) bucket.kitob += 1;
      const g = f.genre?.trim();
      if (g) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
    }

    const genres = [...genreCount.entries()]
      .map(([janr, kitob]) => ({ janr, kitob }))
      .sort((a, b) => b.kitob - a.kitob)
      .slice(0, 6);

    return { monthly: buckets, byGenre: genres, total: finished.length };
  }, [finished, t]);

  // Hali birorta kitob tugatilmagan — grafik o'rniga aniq keyingi qadam.
  if (total === 0) {
    return (
      <section className="card-surface rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
          <Icon.stats aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
          {t("title")}
        </h2>
        <div className="mt-4 rounded-xl border border-dashed border-line-strong bg-surface-muted p-6 text-center">
          <Icon.book
            aria-hidden="true"
            size={28}
            strokeWidth={1.25}
            className="mx-auto text-slate-300"
          />
          <p className="mt-3 text-sm font-medium text-slate-700">
            {t("emptyTitle")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {t("emptyHint")}
          </p>
        </div>
      </section>
    );
  }

  const maxMonthly = Math.max(...monthly.map((m) => m.kitob), 1);

  return (
    <section className="card-surface rounded-2xl p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
          <Icon.stats aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
          {t("title")}
        </h2>
        <p className="text-xs text-slate-500">{t("finishedCount", { count: total })}</p>
      </div>

      {/* Oylik faollik */}
      <p className="mb-2 text-xs font-medium text-slate-500">{t("last6")}</p>
      <div className="h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={monthly} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
            <XAxis
              dataKey="oy"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
            />
            <YAxis
              allowDecimals={false}
              domain={[0, maxMonthly]}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              width={32}
            />
            <Tooltip
              cursor={{ fill: "rgba(37,99,235,0.06)" }}
              contentStyle={{
                borderRadius: 12,
                border: "1px solid #e3e8f2",
                fontSize: 12,
                padding: "6px 10px",
              }}
              formatter={(v: number) => [t("tooltipBooks", { count: v }), ""]}
              labelFormatter={(l) => t("tooltipMonth", { month: String(l) })}
            />
            <Bar dataKey="kitob" radius={[6, 6, 0, 0]} maxBarSize={38}>
              {monthly.map((m, i) => (
                <Cell
                  key={i}
                  // Joriy oy ajratib ko'rsatiladi — "hozir qanday ketyapman".
                  fill={i === monthly.length - 1 ? "#2563eb" : "#bfd7fe"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Janr taqsimoti — gorizontal ustun: janr nomlari uzun bo'ladi */}
      {byGenre.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-3 text-xs font-medium text-slate-500">
            {t("genresTitle")}
          </p>
          <div className="space-y-2">
            {byGenre.map((g, i) => {
              const pct = Math.round((g.kitob / total) * 100);
              return (
                <div key={g.janr} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-xs text-slate-600">
                    {g.janr}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: GENRE_COLORS[i % GENRE_COLORS.length],
                      }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-500">
                    {g.kitob}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
