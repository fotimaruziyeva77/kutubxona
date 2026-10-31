"use client";

/**
 * Top-100 reyting sahifasi.
 *
 * QAYTA QURILDI. Avvalgi holat va nima uchun o'zgargani:
 *  • Medallar va jins EMOJI bilan chizilardi (🥇🥈🥉 👨👩). Emoji har OS'da
 *    boshqacha, o'lchamini boshqarib bo'lmaydi va qatorlar tekis turmasdi.
 *    Jins belgisi esa reytingda umuman keraksiz — u yerda o'rin va ball
 *    muhim, shaxsning jinsi emas.
 *  • 8 ta filtr gorizontal SILJIYDIGAN tasmada edi — mobil ekranda oxirgi
 *    filtrlar yashirin qolardi (xuddi eski navigatsiyadagi muammo).
 *  • Kirgan kitobxon o'z tab-panelini yo'qotardi: reyting butunlay boshqa
 *    sayt bo'lib ochilardi.
 *  • Eng muhimi — kitobxon O'ZINING o'rnini ko'rmasdi. Reyting motivatsiya
 *    quroli; "men qayerdaman va kirish uchun nima kerak" javobisiz u shunchaki
 *    begonalar ro'yxati.
 *
 * Yangi tuzilma: sarhisob → "siz qayerdasiz" → podium (top-3) → filtrlar →
 * ro'yxat. Kitobxonning o'z qatori ajratib ko'rsatiladi.
 *
 * HALOLLIK: "kirish uchun kerak bo'lgan ball" faqat ro'yxat TO'LGAN bo'lsa
 * ko'rsatiladi. Ro'yxatda bo'sh o'rin bor ekan, chegara yo'q — shuning uchun
 * o'ylab topilgan son yozilmaydi.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { io, Socket } from "socket.io-client";
import { apiClient } from "@/lib/api-client";
import { apiOrigin } from "@/lib/api/base";
import { useAuthStore } from "@/store/auth.store";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

// ── Tipler ────────────────────────────────────────────────────────────────────

type TopEntry = {
  rank: number;
  score: number;
  gender: "MALE" | "FEMALE";
  ageGroup: string;
  userType: string;
  user: { name: string; sifatId?: string; type: string; viloyatId?: string };
};

type TopData = { month: string; total: number; entries: TopEntry[] };
type DonateStats = { totalCollected: number; totalSpent: number; remaining: number; donorCount: number };

type FilterTab = "all" | "male" | "female" | "7-14" | "15-30" | "31-60" | "60+" | "students";

/** Tarjima fayli (`TopPage.types`) bilan qoplangan foydalanuvchi tiplari. */
const KNOWN_TYPES = new Set([
  "CITIZEN",
  "STUDENT_SCHOOL",
  "STUDENT_UNIVERSITY",
  "GOVERNMENT_EMPLOYEE",
  "TEACHER",
]);

/** Podium ranglari — oltin / kumush / bronza. Yorliq: `TopPage.place{N}`. */
const PODIUM = [
  { ring: "ring-accent-300", chip: "bg-accent-400 text-brand-950" },
  { ring: "ring-slate-300", chip: "bg-slate-300 text-slate-800" },
  { ring: "ring-orange-300", chip: "bg-orange-400 text-white" },
];

const TABS: { key: FilterTab; labelKey: string }[] = [
  { key: "all", labelKey: "all" },
  { key: "male", labelKey: "male" },
  { key: "female", labelKey: "female" },
  { key: "7-14", labelKey: "age714" },
  { key: "15-30", labelKey: "age1530" },
  { key: "31-60", labelKey: "age3160" },
  { key: "60+", labelKey: "age60plus" },
  { key: "students", labelKey: "students" },
];

const PAGE_SIZE = 50;

async function fetchTop(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await apiClient(`/top?${qs}`);
  if (!res.ok) throw new Error("Yuklanmadi");
  return res.json() as Promise<TopData>;
}

const fmt = (n: number) => new Intl.NumberFormat("uz-UZ").format(Math.round(n));

// ── Asosiy komponent ──────────────────────────────────────────────────────────

export default function TopClient({
  initialData,
  donateStats,
}: {
  initialData: TopData | null;
  donateStats: DonateStats | null;
}) {
  const locale = useLocale();
  const t = useTranslations("TopPage");
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useAuthStore();
  const [tab, setTab] = useState<FilterTab>("all");
  const [page, setPage] = useState(0);
  // Kirgan kitobxon uchun sahifa ilova qobig'ida ochiladi; mehmon uchun
  // ommaviy sarlavha bilan. Qaror MOUNTDAN keyin qabul qilinadi — SSR
  // markup har doim "mehmon" holatida chiziladi va hydration mos keladi.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const queryParams: Record<string, string> = {
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  };
  if (tab === "male") queryParams.gender = "MALE";
  if (tab === "female") queryParams.gender = "FEMALE";
  if (["7-14", "15-30", "31-60", "60+"].includes(tab)) queryParams.ageGroup = tab;
  if (tab === "students") queryParams.userType = "STUDENT_UNIVERSITY";

  const { data, isLoading } = useQuery<TopData>({
    queryKey: ["top100", tab, page],
    queryFn: () => fetchTop(queryParams),
    initialData: tab === "all" && page === 0 ? (initialData ?? undefined) : undefined,
    // SSR ma'lumoti DARHOL eskirgan deb belgilanadi: u Next tomonidan
    // keshlangan bo'lishi mumkin, ya'ni bir necha daqiqa oldingi holat.
    // Shu bayroqsiz React Query uni `staleTime` davomida yangi deb bilib
    // umuman qayta so'ramasdi va admin reytingni tasdiqlagandan keyin ham
    // sahifa "hali e'lon qilinmagan" deb turardi.
    // Foydalanuvchi SSR kontentini darhol ko'radi, yangisi fonda keladi.
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
  });

  // `?? []` har renderda YANGI massiv yaratadi, shuning uchun uni to'g'ridan
  // to'g'ri useMemo bog'liqligiga qo'yish memo'ni har safar qayta hisoblab
  // yuborardi. Barqaror havola beramiz.
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const total = data?.total ?? 0;
  const month = data?.month ?? "";
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Real vaqt: admin reytingni tasdiqlaganda ro'yxat yangilanadi.
  useEffect(() => {
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    const apiUrl = apiOrigin();
    let socket: Socket | null = null;
    try {
      socket = io(`${apiUrl}/stats`, {
        path: "/ws",
        withCredentials: true,
        transports: ["websocket", "polling"],
      });
      socket.on("connect", () => {
        socket?.emit("subscribe", { room: `top100:${targetMonth}` });
      });
      const invalidate = () => queryClient.invalidateQueries({ queryKey: ["top100"] });
      socket.on("top100:update", invalidate);
      socket.on("top100:flag", invalidate);
    } catch {
      // Soket bo'lmasa sahifa baribir ishlaydi — staleTime zaxira yangilash.
    }
    return () => {
      try {
        socket?.disconnect();
      } catch {
        /* noop */
      }
    };
  }, [month, queryClient]);

  /**
   * Kitobxonning o'z holati. `sifatId` — reytingdagi yagona barqaror
   * identifikator (ism takrorlanishi mumkin).
   */
  const me = useMemo(() => {
    if (!mounted || !isAuthenticated || !user?.sifatId) return null;
    const mine = entries.find((e) => e.user.sifatId === user.sifatId) ?? null;
    // Ro'yxat TO'LGAN bo'lsagina oxirgi ball haqiqiy chegara hisoblanadi.
    const listFull = entries.length >= PAGE_SIZE || total >= 100;
    const cutoff = listFull ? entries[entries.length - 1]?.score ?? null : null;
    return { entry: mine, cutoff, myScore: user.readingScore ?? null };
  }, [mounted, isAuthenticated, user, entries, total]);

  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  // ── Sahifa tanasi ──────────────────────────────────────────────────────
  const body = (
    <div className="space-y-5">
      {/* Sarhisob */}
      <section className="ink-surface overflow-hidden rounded-2xl p-5 text-white sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="eyebrow !text-accent-300">{t("eyebrow")}</span>
            <h2 className="mt-2 text-2xl font-bold sm:text-3xl">{t("heading")}</h2>
            <p className="mt-1 text-sm text-brand-100">
              {month ? t("monthOf", { month }) : t("monthlyRating")} · {t("pq9")}
            </p>
          </div>
          <div className="rounded-xl bg-white/10 px-4 py-3 text-center">
            <p className="text-2xl font-bold tabular-nums">{fmt(total)}</p>
            <p className="text-[11px] text-brand-100">{t("participants")}</p>
          </div>
        </div>

        {donateStats && (
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
            <div className="text-center">
              <p className="text-sm font-bold tabular-nums sm:text-lg">
                {fmt(donateStats.totalCollected)}
              </p>
              <p className="text-[11px] text-brand-100">{t("collected")}</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-bold tabular-nums sm:text-lg">
                {fmt(donateStats.totalSpent)}
              </p>
              <p className="text-[11px] text-brand-100">{t("spent")}</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-bold tabular-nums sm:text-lg">
                {fmt(donateStats.donorCount)}
              </p>
              <p className="text-[11px] text-brand-100">{t("donors")}</p>
            </div>
          </div>
        )}
      </section>

      {/* Siz qayerdasiz — reytingning motivatsion yadrosi */}
      {me && <MyStanding me={me} locale={locale} />}

      {/* Podium */}
      {!isLoading && podium.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.12em] text-slate-500">
            {t("leaders")}
          </h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {podium.map((e, i) => (
              <PodiumCard
                key={e.rank}
                entry={e}
                place={i}
                isMe={me?.entry?.rank === e.rank}
              />
            ))}
          </div>
        </section>
      )}

      {/* Filtrlar — o'ralib tushadi, siljimaydi */}
      <section>
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => {
                setTab(tabItem.key);
                setPage(0);
              }}
              aria-pressed={tab === tabItem.key}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === tabItem.key
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-line bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700"
              }`}
            >
              {t(`tabs.${tabItem.labelKey}`)}
            </button>
          ))}
        </div>
      </section>

      {/* Ro'yxat */}
      {isLoading ? (
        <div className="py-16 text-center text-sm text-slate-400">{t("loading")}</div>
      ) : entries.length === 0 ? (
        <div className="card-surface rounded-2xl py-16 text-center">
          <Icon.trophy
            aria-hidden="true"
            size={32}
            strokeWidth={1.25}
            className="mx-auto text-slate-300"
          />
          <p className="mt-3 font-semibold text-slate-900">
            {t("notPublished")}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            {t("notPublishedHint")}
          </p>
        </div>
      ) : (
        rest.length > 0 && (
          <section className="card-surface overflow-hidden rounded-2xl">
            {rest.map((e, i) => (
              <TopRow
                key={e.rank}
                entry={e}
                first={i === 0}
                isMe={me?.entry?.rank === e.rank}
              />
            ))}
          </section>
        )
      )}

      {/* Sahifalash */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="card-surface rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {t("prev")}
          </button>
          <span className="text-sm tabular-nums text-slate-600">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="card-surface rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            {t("next")}
          </button>
        </div>
      )}

      {/* Donat — o'z joyida, filtrlar orasida emas */}
      <section className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-surface-muted p-5 text-center sm:flex-row sm:text-left">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-info-50 text-info-600">
          <Icon.donate aria-hidden="true" size={ICON_SIZE.md} />
        </span>
        <p className="flex-1 text-sm text-slate-600">
          {t("donateHint")}
        </p>
        <Link
          href={`/${locale}/donate`}
          className="inline-flex h-10 shrink-0 items-center rounded-xl bg-info-700 px-5 text-sm font-semibold text-white transition-colors hover:bg-info-900"
        >
          {t("donate")}
        </Link>
      </section>

      <p className="pb-2 text-center text-xs text-slate-400">
        {t("footnote")}
      </p>
    </div>
  );

  // Kirgan kitobxon — ilova qobig'ida (pastki tab-panel saqlanadi).
  if (mounted && isAuthenticated && user?.role === "KITOBXON") {
    return (
      <ReaderShell title={t("title")} backHref={`/${locale}/profile`}>
        {body}
      </ReaderShell>
    );
  }

  // Mehmon — ommaviy ko'rinish.
  return (
    <main className="min-h-screen bg-surface-muted">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link
            href={`/${locale}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"
          >
            <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
            {t("home")}
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-5">{body}</div>
    </main>
  );
}

// ── "Siz qayerdasiz" kartasi ─────────────────────────────────────────────────

function MyStanding({
  me,
  locale,
}: {
  me: { entry: TopEntry | null; cutoff: number | null; myScore: number | null };
  locale: string;
}) {
  const t = useTranslations("TopPage");

  // Reytingda bor — o'rnini bayram qilamiz.
  if (me.entry) {
    return (
      <section className="flex items-center gap-4 rounded-2xl border border-accent-300 bg-accent-50 p-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-400 text-lg font-bold text-brand-950 tabular-nums">
          {me.entry.rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900">
            {t("myRank", { rank: me.entry.rank })}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {t("myRankHint", { score: me.entry.score.toFixed(1) })}
          </p>
        </div>
      </section>
    );
  }

  // Reytingda yo'q. Chegara MA'LUM bo'lsagina aniq son aytamiz.
  const gap =
    me.cutoff !== null && me.myScore !== null
      ? Math.max(0, me.cutoff - me.myScore)
      : null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-4 sm:flex-row sm:items-center">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <Icon.target aria-hidden="true" size={ICON_SIZE.md} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-slate-900">
          {t("notInList")}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
          {me.myScore !== null ? (
            <>
              {t.rich("currentScore", {
                score: me.myScore.toFixed(1),
                strong: (chunks) => (
                  <strong className="text-slate-700">{chunks}</strong>
                ),
              })}
              {gap !== null && gap > 0 && (
                <> {t("gapHint", { gap: gap.toFixed(1) })}</>
              )}
            </>
          ) : (
            t("noScoreHint")
          )}
        </p>
      </div>
      <Link
        href={`/${locale}/search`}
        className="inline-flex h-10 shrink-0 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      >
        {t("chooseBook")}
      </Link>
    </section>
  );
}

// ── Podium kartasi ───────────────────────────────────────────────────────────

function PodiumCard({
  entry,
  place,
  isMe,
}: {
  entry: TopEntry;
  place: number;
  isMe: boolean;
}) {
  const t = useTranslations("TopPage");
  const p = PODIUM[place];
  return (
    <article
      className={`card-surface flex flex-col items-center rounded-2xl p-5 text-center ring-1 ${p.ring} ${
        isMe ? "border-accent-400" : ""
      }`}
    >
      <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${p.chip}`}>
        <Icon.medal aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />
        {t(`place${place + 1}`)}
      </span>

      {/* Bosh harf — avatar o'rnida. Rasm yo'q, shuning uchun ism harfi. */}
      <span className="mt-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-xl font-bold text-white">
        {entry.user.name?.[0] ?? "?"}
      </span>

      <p className="mt-3 line-clamp-2 text-sm font-bold text-slate-900">
        {entry.user.name}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        {KNOWN_TYPES.has(entry.userType)
          ? t(`types.${entry.userType}`)
          : entry.userType}
      </p>

      <p className="mt-3 text-2xl font-bold tabular-nums text-brand-700">
        {entry.score.toFixed(1)}
      </p>
      <p className="text-[11px] text-slate-400">{t("ball")}</p>

      {isMe && (
        <span className="mt-3 rounded-full bg-accent-100 px-2.5 py-0.5 text-[11px] font-bold text-accent-700">
          {t("itsYou")}
        </span>
      )}
    </article>
  );
}

// ── Ro'yxat qatori ───────────────────────────────────────────────────────────

function TopRow({
  entry,
  first,
  isMe,
}: {
  entry: TopEntry;
  first: boolean;
  isMe: boolean;
}) {
  const t = useTranslations("TopPage");
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-colors ${
        first ? "" : "border-t border-line"
      } ${isMe ? "bg-accent-50" : "hover:bg-surface-muted"}`}
    >
      <span className="w-8 shrink-0 text-center text-sm font-bold tabular-nums text-slate-400">
        {entry.rank}
      </span>

      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700">
        {entry.user.name?.[0] ?? "?"}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">
          {entry.user.name}
          {isMe && (
            <span className="ml-2 rounded-full bg-accent-400 px-1.5 py-0.5 text-[10px] font-bold text-brand-950">
              {t("you")}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-slate-500">
          {KNOWN_TYPES.has(entry.userType)
            ? t(`types.${entry.userType}`)
            : entry.userType}
          {entry.ageGroup && ` · ${t("ageSuffix", { age: entry.ageGroup })}`}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums text-brand-700">
          {entry.score.toFixed(1)}
        </p>
        <p className="text-[11px] text-slate-400">{t("ball")}</p>
      </div>
    </div>
  );
}
