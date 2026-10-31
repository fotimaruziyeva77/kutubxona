"use client";

/**
 * Kitobxon sahifasi.
 *
 * QAYTA QURILDI (sabab): avvalgi versiya 1000 qatorlik "admin paneli" edi —
 * eng tepada parol o'zgartirish, keyin "Rol: KITOBXON", "Ishonch reytingi",
 * maxfiylik sozlamalari va xom `Address ID` maydoni. Maktab o'quvchisi bu
 * sahifadan hech qanday sabab topolmasdi qaytib kelishga, kitob esa oddiy
 * matn qatorlari sifatida ko'rsatilardi.
 *
 * Yangi tartib — foydalanuvchi savoliga qarab:
 *   1. "Men qanday ketyapman?"  → daraja, streak, yillik maqsad (hero)
 *   2. "Nima qilishim kerak?"   → tasdiqlash kutayotgan xaridlar, muddati
 *                                 yaqin kitoblar
 *   3. "Nima o'qiy?"            → tavsiyalar + fond (muqovali kartalar)
 *   4. "Nima yutdim?"           → nishonlar
 *   5. "Sozlash"                → yig'ilgan bo'lim (yiliga bir marta kerak)
 *
 * DOKON_OPERATOR va xodim rollari ham shu sahifaga tushadi (ular uchun
 * yagona "profil" shu) — ularga kitobxon bloklari ko'rsatilmaydi.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { usersApi } from "@/lib/api/users";
import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import { refreshAccessToken } from "@/lib/api/client";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { RotatingUserQr } from "@/components/qr/rotating-user-qr";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { ReaderHero } from "@/components/reader/ReaderHero";
import { ReaderSearchBar } from "@/components/reader/ReaderSearchBar";
import { ReadingCharts, type FinishedBook } from "@/components/reader/ReadingCharts";
import { ReaderDiscovery } from "@/components/reader/ReaderDiscovery";
import { BadgeShelf, type CatalogBadge, type EarnedBadge } from "@/components/reader/BadgeShelf";
import { ReaderSettings } from "@/components/reader/ReaderSettings";
import { BookRow } from "@/components/books/BookCard";
import { fetchMyStore } from "@/lib/api/store";
import { fetchMyXp } from "@/lib/api/xp";
import { apiOrigin } from "@/lib/api/base";
import { fmtDayMonthTime } from "@/lib/format";

// ── API ─────────────────────────────────────────────────────────────────────

type HistoryTx = {
  id: string;
  status: string;
  type: string;
  borrowedAt?: string;
  dueDate?: string;
  returnedAt?: string;
  penaltyDays: number;
  reservationExpiresAt?: string;
  book: {
    id?: string;
    title: string;
    author: string;
    isbn: string;
    genre?: string;
    coverUrl?: string | null;
    library?: { name: string };
  };
};

type HistoryResponse = {
  transactions: HistoryTx[];
  isbnScans: Array<{
    id: string;
    isbn: string;
    title: string;
    author: string;
    confirmedAt?: string;
    source: string;
  }>;
  pendingPurchases: Array<{
    id: string;
    isbn: string;
    title: string;
    author: string;
    source: string;
    createdAt: string;
  }>;
  activeBorrows: number;
  pendingBrons: number;
};

async function getUserHistory(userId: string): Promise<HistoryResponse> {
  const res = await apiClient(`/transactions/user/${userId}/history`);
  if (!res.ok) throw new Error("Yuklanmadi");
  return res.json();
}

async function confirmStorePurchase(isbnScanId: string, errorMsg: string) {
  const res = await apiClient(`/transactions/isbn-scan/${isbnScanId}/confirm`, {
    method: "PATCH",
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errorMsg);
  }
  return res.json();
}

async function cancelBron(txId: string, userId: string) {
  const res = await apiClient(`/transactions/${txId}/cancel-reservation`, {
    method: "DELETE",
    body: JSON.stringify({ requesterId: userId, isLibrarian: false }),
  });
  if (!res.ok) throw new Error("Bekor qilib bo'lmadi");
  return res.json();
}

async function extendDueDate(txId: string, userId: string, errorMsg: string) {
  const res = await apiClient(`/transactions/${txId}/extend`, {
    method: "PATCH",
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errorMsg);
  }
  return res.json();
}

/**
 * Nishon katalogi kodlari — backend `available` bermasa shu ro'yxat
 * ishlatiladi. Nom/tavsif tarjima faylidan (`ReaderHome.badges`) olinadi.
 */
const BADGE_FALLBACK_CODES = [
  "FIRST_BOOK",
  "FIVE_BOOKS",
  "TEN_BOOKS",
  "TWENTY_BOOKS",
  "FIFTY_BOOKS",
  "HUNDRED_BOOKS",
  "TOP_100",
  "TOP_10",
  "STREAK_7",
  "STREAK_30",
  "DISCIPLINE",
  "DIVERSE_READER",
  "FAST_READER",
  "COMPREHENSION_ACE",
  "ISBN_SCANNER",
  "DONOR",
  "TRUST_MASTER",
  "ACTIVE_MONTH",
] as const;

async function fetchMyBadges(): Promise<{
  earned: EarnedBadge[];
  available: CatalogBadge[];
}> {
  const res = await apiClient("/users/me/badges");
  if (!res.ok) return { earned: [], available: [] };
  return res.json();
}

interface ProfileData {
  id: string;
  name: string;
  phone: string;
  sifatId?: string;
  status: string;
  type: string;
  role: string;
  trustScore: number;
  readingScore?: number;
  familyDetectionEnabled?: boolean;
}

// ── Sahifa ──────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const locale = useLocale();
  const t = useTranslations("ReaderHome");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, accessToken, user: authUser, logout } = useAuthStore();
  const role = authUser?.role ?? "";
  const isKitobxon = role === "KITOBXON";
  const isDokon = role === "DOKON_OPERATOR";

  const [profile, setProfile] = useState<ProfileData | null>(null);
  useEffect(() => {
    const openFromHash = () => {
      if (typeof window === "undefined" || window.location.hash !== "#qr") return;
      setShowQr(true);
      window.setTimeout(() => {
        document.getElementById("qr")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [profile?.sifatId]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  // Soat MOUNTDAN keyin o'qiladi: server va klient turli soatni ko'rsatib
  // hydration nomuvofiqligi bermasin.
  const [hour, setHour] = useState<number | null>(null);
  // Zustand/persist localStorage'dan qayta tiklanadi, LEKIN SSR markup har
  // doim boshlang'ich ("kirilmagan") holat bilan chiziladi. Shu sabab
  // redirect qarori faqat mountdan keyin qabul qilinadi — aks holda yaroqli
  // sessiyasi bor kitobxon sahifani qayta yuklaganda login'ga uloqtirilardi.
  // (Xuddi shu himoya dashboard layout'ida allaqachon bor edi.)
  const [hydrated, setHydrated] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    setHour(new Date().getHours());
    setHydrated(true);
  }, []);

  const { data: myStore } = useQuery({
    queryKey: ["profile-my-store"],
    queryFn: fetchMyStore,
    enabled: isDokon,
    staleTime: 300_000,
  });

  useEffect(() => {
    if (!hydrated) return;

    // Access token HECH QAYERDA saqlanmaydi (XSS himoyasi), shuning uchun
    // qattiq qayta yuklashdan keyin u xotirada bo'lmaydi. `sl_auth` cookie
    // tirik sessiyaga ishora qilsa — login'ga uloqtirmasdan bitta jimgina
    // refresh qilamiz; muvaffaqiyatda store yangilanadi va effekt qayta
    // ishlaydi.
    if (!accessToken && hasAuthHintCookie()) {
      refreshAccessToken().catch(() => {
        /* markaziy yo'l logout + redirect'ni bir marta bajaradi */
      });
      return;
    }

    if (!isAuthenticated) {
      router.replace(`/${locale}/login`);
      return;
    }

    usersApi
      .getMe()
      .then((r) => setProfile(r.data))
      .catch((e: unknown) => {
        // FAQAT autentifikatsiya xatosida login'ga yuboramiz. Avval har
        // qanday xato (tarmoq uzilishi, backend qayta ishga tushishi, 500)
        // foydalanuvchini tizimdan chiqarib yuborardi — qishloqdagi zaif
        // internetda bu "har safar chiqib ketaman" degan taassurot berardi.
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403) {
          router.replace(`/${locale}/login`);
        } else {
          setLoadError(t("loadError"));
        }
      })
      .finally(() => setLoading(false));
  }, [hydrated, isAuthenticated, accessToken, locale, router, t]);

  const { data: hist, refetch: refetchHist } = useQuery({
    queryKey: ["user-history", profile?.id],
    queryFn: () => getUserHistory(profile!.id),
    enabled: !!profile?.id,
  });

  const { data: badgesData } = useQuery({
    queryKey: ["my-badges", profile?.id],
    queryFn: fetchMyBadges,
    enabled: !!profile?.id && !isDokon,
    staleTime: 30_000,
  });

  const { data: xp } = useQuery({
    queryKey: ["my-xp"],
    queryFn: fetchMyXp,
    enabled: !!profile?.id && !isDokon,
    staleTime: 30_000,
  });

  // Real vaqt: yangi nishon / daraja ko'tarilishi.
  useEffect(() => {
    if (!profile?.id) return;
    const apiUrl =
      apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
    let socket: Socket | null = null;
    try {
      socket = io(`${apiUrl}/stats`, {
        path: "/ws",
        withCredentials: true,
        transports: ["websocket", "polling"],
      });
      socket.on("connect", () => {
        socket?.emit("subscribe", { room: `user:${profile.id}` });
      });
      socket.on("badge:earned", () => {
        showToast(t("newBadge"));
        queryClient.invalidateQueries({ queryKey: ["my-badges"] });
      });
      socket.on("xp:levelup", (payload: { level?: number }) => {
        showToast(
          typeof payload?.level === "number"
            ? t("levelUpNamed", { level: payload.level })
            : t("levelUp"),
        );
        queryClient.invalidateQueries({ queryKey: ["my-xp"] });
      });
    } catch {
      /* soket bo'lmasa sahifa baribir ishlaydi */
    }
    return () => {
      try {
        socket?.disconnect();
      } catch {
        /* noop */
      }
    };
  }, [profile?.id, queryClient, t]);

  const confirmPurchaseMut = useMutation({
    mutationFn: (isbnScanId: string) =>
      confirmStorePurchase(isbnScanId, t("confirmError")),
    onSuccess: () => {
      showToast(t("purchaseConfirmed"));
      refetchHist();
    },
    onError: (e: Error) => showToast(e.message),
  });

  const cancelMut = useMutation({
    mutationFn: (txId: string) => cancelBron(txId, profile?.id ?? ""),
    onSuccess: () => {
      showToast(t("bronCancelled"));
      refetchHist();
    },
  });

  const extendMut = useMutation({
    mutationFn: (txId: string) =>
      extendDueDate(txId, profile?.id ?? "", t("extendError")),
    onSuccess: () => {
      showToast(t("extendSuccess"));
      refetchHist();
    },
    onError: (e: Error) => showToast(e.message),
  });

  const handleLogout = async () => {
    await authApi.logout().catch(() => {});
    logout();
    router.push(`/${locale}/login`);
  };

  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString("uz-UZ") : "—";

  const daysLeft = (iso?: string) => {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  };

  const activeBorrows = useMemo(
    () => hist?.transactions.filter((t) => t.status === "BORROWED") ?? [],
    [hist],
  );
  const activeReservations = useMemo(
    () =>
      hist?.transactions.filter((t) => ["PENDING", "RESERVED"].includes(t.status)) ??
      [],
    [hist],
  );

  /**
   * Tugatilgan kitoblar — kutubxonadan qaytarilganlar + tasdiqlangan ISBN
   * skanlar. Ikkalasi ham HAQIQIY hodisa; taxmin qilinmaydi. Grafik ham,
   * yillik maqsad hisoblagichi ham shu bitta manbadan oziqlanadi, shuning
   * uchun ular hech qachon bir-biriga zid son ko'rsatmaydi.
   */
  const finishedBooks = useMemo<FinishedBook[]>(() => {
    const fromLibrary = (hist?.transactions ?? [])
      .filter((t) => ["RETURNED", "COMPLETED"].includes(t.status) && t.returnedAt)
      .map((t) => ({ at: t.returnedAt as string, genre: t.book.genre }));
    const fromScans = (hist?.isbnScans ?? [])
      .filter((s) => s.confirmedAt)
      .map((s) => ({ at: s.confirmedAt as string, genre: null }));
    return [...fromLibrary, ...fromScans];
  }, [hist]);

  const booksThisYear = useMemo(() => {
    const year = new Date().getFullYear();
    return finishedBooks.filter((f) => new Date(f.at).getFullYear() === year).length;
  }, [finishedBooks]);

  // Nishon katalogi zaxirasi — nom/tavsif joriy til faylidan olinadi.
  const badgeCatalogFallback = useMemo<CatalogBadge[]>(
    () =>
      BADGE_FALLBACK_CODES.map((code) => ({
        code,
        name: t(`badges.${code}.name`),
        description: t(`badges.${code}.desc`),
        icon: "",
      })),
    [t],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted">
        <p className="text-sm text-slate-400">{t("loading")}</p>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
        <div className="card-surface w-full max-w-sm rounded-2xl p-8 text-center">
          <Icon.warning
            aria-hidden="true"
            size={32}
            strokeWidth={1.25}
            className="mx-auto text-amber-500"
          />
          <p className="mt-3 text-sm text-slate-600">
            {loadError ?? t("notFound")}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 h-10 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  const pendingPurchases = hist?.pendingPurchases ?? [];

  // Kitobxon yagona qobiqda (pastki tab-panel bilan) ishlaydi. Xodim va
  // do'kon rollari uchun profil — ikkinchi darajali sahifa, ular o'z
  // paneliga qaytadi, shuning uchun ularga tab-panel ko'rsatilmaydi.
  const body = (
    <>
      {toast && (
        <div
          role="status"
          className="fixed bottom-24 right-4 z-50 flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg md:bottom-4"
        >
          <Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="text-info-400" />
          {toast}
        </div>
      )}

      <div className="space-y-5">
        {!isKitobxon && (
          <div className="flex items-center justify-between">
            <Link
              href={
                isDokon
                  ? myStore?.slug
                    ? `/${locale}/dokon/${myStore.slug}/dashboard`
                    : `/${locale}/dokon`
                  : `/${locale}/dashboard`
              }
              className="text-sm text-brand-600 hover:underline"
            >
              ← {isDokon ? t("storeCabinet") : t("backToPanel")}
            </Link>
            <Button variant="outline" onClick={handleLogout}>
              {t("logout")}
            </Button>
          </div>
        )}

        {/* 1. Men qanday ketyapman? */}
        {!isDokon ? (
          <ReaderHero
            name={profile.name}
            xp={xp ?? null}
            booksThisYear={booksThisYear}
            hour={hour}
          />
        ) : (
          <section className="card-surface rounded-2xl p-5">
            <h1 className="text-xl font-bold text-slate-900">{profile.name}</h1>
            <p className="mt-1 text-sm text-slate-500">{profile.phone}</p>
          </section>
        )}

        {profile.status === "PENDING" && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Icon.pending aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
            <span>{t("pendingNotice")}</span>
          </div>
        )}

        {/* 2. Nima qilishim kerak? — tasdiqlash kutayotgan xaridlar */}
        {pendingPurchases.length > 0 && (
          <section className="rounded-2xl border border-accent-300 bg-accent-50 p-5">
            <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
              <Icon.store aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-600" />
              {t("confirmPurchaseTitle")}
              <span className="rounded-full bg-accent-500 px-2 py-0.5 text-xs font-bold text-white">
                {pendingPurchases.length}
              </span>
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              {t("confirmPurchaseHint")}
            </p>
            <div className="mt-4 space-y-2">
              {pendingPurchases.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col gap-2 rounded-xl border border-accent-200 bg-white p-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{p.title}</p>
                    <p className="truncate text-xs text-slate-500">{p.author}</p>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0 bg-accent-600 hover:bg-accent-700"
                    disabled={confirmPurchaseMut.isPending}
                    onClick={() => confirmPurchaseMut.mutate(p.id)}
                  >
                    {t("confirm")}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Qo'limdagi kitoblar — muqova bilan */}
        {activeBorrows.length > 0 && (
          <section className="card-surface rounded-2xl p-5">
            <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-slate-900">
              <Icon.book aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
              {t("myBooks")}
            </h2>
            <div className="space-y-3">
              {activeBorrows.map((tx) => {
                const days = daysLeft(tx.dueDate);
                const isLate = days !== null && days < 0;
                const isSoon = days !== null && days >= 0 && days <= 3;
                return (
                  <BookRow
                    key={tx.id}
                    book={{
                      id: tx.book.id ?? tx.id,
                      title: tx.book.title,
                      author: tx.book.author,
                      genre: tx.book.genre,
                      coverUrl: tx.book.coverUrl,
                      library: tx.book.library,
                    }}
                    tone={isLate ? "danger" : isSoon ? "warning" : "default"}
                    meta={
                      days !== null && (
                        <>
                          <p
                            className={`text-sm font-bold ${
                              isLate
                                ? "text-red-600"
                                : isSoon
                                  ? "text-accent-700"
                                  : "text-slate-700"
                            }`}
                          >
                            {isLate
                              ? t("daysLate", { count: Math.abs(days) })
                              : t("daysLeft", { count: days })}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {formatDate(tx.dueDate)}
                          </p>
                        </>
                      )
                    }
                    action={
                      !isLate && tx.penaltyDays !== -1 ? (
                        <button
                          type="button"
                          onClick={() => extendMut.mutate(tx.id)}
                          disabled={extendMut.isPending}
                          className="text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50"
                        >
                          {t("extend7")}
                        </button>
                      ) : tx.penaltyDays === -1 ? (
                        <span className="text-xs text-slate-400">{t("extended")}</span>
                      ) : null
                    }
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Bronlar */}
        {activeReservations.length > 0 && (
          <section className="card-surface rounded-2xl p-5">
            <h2 className="mb-4 flex items-center gap-2 text-base font-bold text-slate-900">
              <Icon.pending aria-hidden="true" size={ICON_SIZE.sm} className="text-brand-500" />
              {t("myBrons")}
            </h2>
            <div className="space-y-3">
              {activeReservations.map((tx) => (
                <BookRow
                  key={tx.id}
                  book={{
                    id: tx.book.id ?? tx.id,
                    title: tx.book.title,
                    author: tx.book.author,
                    genre: tx.book.genre,
                    coverUrl: tx.book.coverUrl,
                    library: tx.book.library,
                  }}
                  meta={
                    <div className="flex flex-col items-end gap-1">
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                        {tx.status === "RESERVED" ? t("bronReady") : t("bronPending")}
                      </span>
                      {/* Keyingi qadam: PENDING — qachongacha tasdiq kutiladi
                          (server sanasi), RESERVED — kutubxonaga borish. */}
                      {tx.status === "PENDING" && tx.reservationExpiresAt && (
                        <span className="text-[11px] text-slate-500">
                          {t("bronUntil", { date: fmtDayMonthTime(tx.reservationExpiresAt) })}
                        </span>
                      )}
                      {tx.status === "RESERVED" && (
                        <span className="max-w-[9rem] text-right text-[11px] text-slate-500">
                          {t("bronConfirmedHint")}
                        </span>
                      )}
                    </div>
                  }
                  action={
                    <div className="flex items-center gap-3">
                      {tx.status === "RESERVED" && (
                        <a
                          href="#qr"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
                        >
                          <Icon.qr aria-hidden="true" size={ICON_SIZE.xs} />
                          {t("showQr")}
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => cancelMut.mutate(tx.id)}
                        disabled={cancelMut.isPending}
                        className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                      >
                        {t("cancel")}
                      </button>
                    </div>
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* 3. Nima o'qiy? — qidiruv birinchi, keyin tavsiya va fond */}
        {!isDokon && (
          <>
            <ReaderSearchBar locale={locale} />
            <ReaderDiscovery locale={locale} onToast={showToast} />
            <ReadingCharts finished={finishedBooks} />
          </>
        )}

        {/* 4. Nima yutdim? */}
        {!isDokon && (
          <BadgeShelf
            earned={badgesData?.earned ?? []}
            catalog={
              badgesData?.available && badgesData.available.length > 0
                ? badgesData.available
                : badgeCatalogFallback
            }
          />
        )}

        {/* Kutubxona pasporti — yig'ilgan, kerak bo'lganda ochiladi */}
        {profile.sifatId && (
          <section id="qr" className="card-surface overflow-hidden rounded-2xl scroll-mt-20">
            <button
              type="button"
              onClick={() => setShowQr((v) => !v)}
              aria-expanded={showQr}
              className="flex w-full items-center justify-between gap-3 p-5 text-left"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Icon.qr aria-hidden="true" size={ICON_SIZE.sm} />
                </span>
                <span className="min-w-0">
                  <span className="block text-base font-bold text-slate-900">
                    {t("passport")}
                  </span>
                  <span className="block truncate font-mono text-xs text-slate-500">
                    {profile.sifatId}
                  </span>
                </span>
              </span>
              <Icon.next
                aria-hidden="true"
                size={ICON_SIZE.sm}
                className={`shrink-0 text-slate-400 transition-transform ${showQr ? "rotate-90" : ""}`}
              />
            </button>
            {showQr && (
              <div className="flex flex-col items-center gap-4 border-t border-line p-5 pt-4">
                <RotatingUserQr sifatId={profile.sifatId} />
                <p className="max-w-xs text-center text-xs leading-relaxed text-slate-500">
                  {t("qrHint")}
                </p>
              </div>
            )}
          </section>
        )}

        {/* 5. Sozlash */}
        <ReaderSettings
          name={profile.name}
          familyDetectionEnabled={Boolean(profile.familyDetectionEnabled)}
          onNameSaved={(n) => setProfile((p) => (p ? { ...p, name: n } : p))}
          onToast={showToast}
        />
      </div>
    </>
  );

  if (!isKitobxon) {
    return (
      <main className="min-h-screen bg-surface-muted px-4 py-6">
        <div className="mx-auto max-w-3xl">{body}</div>
      </main>
    );
  }

  return (
    <ReaderShell
      action={
        <Button variant="outline" size="sm" onClick={handleLogout}>
          {t("logout")}
        </Button>
      }
    >
      {body}
    </ReaderShell>
  );
}
