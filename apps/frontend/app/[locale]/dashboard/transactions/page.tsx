"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { getLibraries, getMyLibraries, scanUserQr } from "@/lib/api/libraries";
import { getViloyatlar, getTumanlar, getMahallalar } from "@/lib/api/geo";
import { useAuthStore } from "@/store/auth.store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { BookCover } from "@/components/books/BookCover";
import { BookRow } from "@/components/books/BookCard";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { USER_STATUS_LABELS, TRANSACTION_STATUS_LABELS, label } from "@/lib/labels.const";

// ── API funksiyalar ──────────────────────────────────────────────────────────

async function getLibraryBrons(libraryId: string) {
  const res = await apiClient(`/transactions/library/${libraryId}/brons`);
  if (!res.ok) throw new Error("Bron yuklanmadi");
  return res.json();
}

async function getLibraryBorrowed(libraryId: string) {
  const res = await apiClient(`/transactions/library/${libraryId}/borrowed`);
  if (!res.ok) throw new Error("Berilganlar yuklanmadi");
  return res.json();
}

async function getLibraryOverdue(libraryId: string) {
  const res = await apiClient(`/transactions/library/${libraryId}/overdue`);
  if (!res.ok) throw new Error("Muddati o'tganlar yuklanmadi");
  return res.json();
}

// UI xato matnlari (errMsg) chaqiruvchi komponentdan t() bilan uzatiladi —
// modul darajasida hook ishlatib bo'lmaydi.
async function confirmReservation(txId: string, errMsg: string) {
  const res = await apiClient(`/transactions/${txId}/confirm-reservation`, { method: "PATCH" });
  if (!res.ok) throw new Error(errMsg);
  return res.json();
}

async function cancelReservation(txId: string, requesterId: string, errMsg: string) {
  const res = await apiClient(`/transactions/${txId}/cancel-reservation`, {
    method: "DELETE",
    body: JSON.stringify({ requesterId, isLibrarian: true })
  });
  if (!res.ok) throw new Error(errMsg);
  return res.json();
}

async function borrowBook(userId: string, bookId: string, errMsg: string, reservationId?: string, dueDate?: string) {
  const res = await apiClient("/transactions/borrow", {
    method: "POST",
    body: JSON.stringify({ userId, bookId, reservationId, dueDate })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json();
}

async function returnBook(txId: string, errMsg: string, returnLibraryId?: string) {
  const res = await apiClient(`/transactions/${txId}/return`, {
    method: "PATCH",
    body: JSON.stringify({ returnLibraryId })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json();
}

// Yangi kitobxon/xodim qo'shish (kutubxonachi/muassasa admini).
type RegisterReaderInput = {
  name: string; phone: string; gender?: string; mahallaId?: string;
  schoolClass?: string; department?: string;
};
async function registerReaderApi(dto: RegisterReaderInput, errMsg: string) {
  const res = await apiClient("/desk/readers", {
    method: "POST",
    body: JSON.stringify(dto)
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json() as Promise<{
    id: string; name: string; phone: string; sifatId: string | null; tempPassword: string;
  }>;
}

type AvailBook = { id: string; title: string; author: string; isbn: string; availableCount: number };
async function getLibraryBooksApi(libraryId: string): Promise<AvailBook[]> {
  const res = await apiClient(`/books?libraryId=${libraryId}&limit=200`);
  if (!res.ok) return [];
  const d = await res.json();
  const items: AvailBook[] = Array.isArray(d) ? d : d.items ?? d.data ?? [];
  return items.filter((b) => (b.availableCount ?? 0) > 0);
}

// ── Tipler ───────────────────────────────────────────────────────────────────

type Tx = {
  id: string;
  status: string;
  createdAt: string;
  dueDate?: string;
  penaltyDays: number;
  reservationExpiresAt?: string;
  book: { id: string; title: string; author: string; isbn: string };
  user: { id: string; name: string; phone: string; sifatId?: string };
};

// ── Asosiy sahifa ─────────────────────────────────────────────────────────────

type Tab = "issue" | "brons" | "borrowed" | "overdue";

export default function TransactionsPage() {
  const t = useTranslations("TxPanel");
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const searchParams = useSearchParams();
  // /scan sahifasi kutubxonachini shu sahifaga "?sifatId=SL-UZ-..." bilan
  // yo'naltiradi — "Kitob berish" tabi ochilib, ID maydoni to'ldirib qo'yiladi.
  const prefillSifatId = searchParams?.get("sifatId") ?? "";
  const [selectedLib, setSelectedLib] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const [credModal, setCredModal] = useState<{ phone: string; sifatId: string | null; password: string } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("brons");
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [returnModal, setReturnModal] = useState<Tx | null>(null);
  const [returnLibId, setReturnLibId] = useState("");
  // Bronlar tab'idagi "Berish" uchun qaytarish muddati (standart +14 kun).
  const [bronDueDate, setBronDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });

  useEffect(() => {
    if (prefillSifatId) setActiveTab("issue");
  }, [prefillSifatId]);

  const showToast = (msg: string, type: "ok" | "err") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // RBAC geographic scoping (Audit 2026-06) — the public GET /libraries returns
  // EVERY library in the country. Only SUPER_ADMIN should see all libraries in
  // the picker; KUTUBXONACHI/MUASSASA admins see only their own library and
  // VILOYAT/TUMAN admins only their region/district, all via the auth+region
  // scoped GET /libraries/mine (getManageableLibraries).
  const { data: libraries = [] } = useQuery({
    queryKey: ["tx-libraries", isSuperAdmin],
    queryFn: () =>
      isSuperAdmin ? getLibraries({ status: "ACTIVE" }) : getMyLibraries()
  });

  // Bitta kutubxonaga biriktirilgan rol (KUTUBXONACHI/MUASSASA_ADMIN) uchun
  // dropdown'dan tanlash shart emas — yagona kutubxona avtomatik tanlanadi va
  // kitob berish/qaytarish jarayoni darhol ko'rinadi.
  useEffect(() => {
    if (!selectedLib && libraries.length === 1) {
      setSelectedLib(libraries[0].id);
    }
  }, [libraries, selectedLib]);

  const {
    data: brons = [],
    isLoading: bronsLoading,
    isError: bronsError,
    refetch: refetchBrons,
    isRefetching: bronsRefetching
  } = useQuery<Tx[]>({
    queryKey: ["brons", selectedLib],
    queryFn: () => getLibraryBrons(selectedLib),
    enabled: !!selectedLib
  });

  const {
    data: borrowed = [],
    isLoading: borrowedLoading,
    isError: borrowedError,
    refetch: refetchBorrowed,
    isRefetching: borrowedRefetching
  } = useQuery<Tx[]>({
    queryKey: ["borrowed", selectedLib],
    queryFn: () => getLibraryBorrowed(selectedLib),
    enabled: !!selectedLib
  });

  const {
    data: overdue = [],
    isLoading: overdueLoading,
    isError: overdueError,
    refetch: refetchOverdue,
    isRefetching: overdueRefetching
  } = useQuery<Tx[]>({
    queryKey: ["overdue", selectedLib],
    queryFn: () => getLibraryOverdue(selectedLib),
    enabled: !!selectedLib
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["brons", selectedLib] });
    qc.invalidateQueries({ queryKey: ["borrowed", selectedLib] });
    qc.invalidateQueries({ queryKey: ["overdue", selectedLib] });
  };

  const confirmMut = useMutation({
    mutationFn: (txId: string) => confirmReservation(txId, t("errors.confirmFailed")),
    onSuccess: () => { showToast(t("toasts.bronConfirmed"), "ok"); invalidate(); },
    onError: (e: Error) => showToast(e.message, "err")
  });

  const cancelMut = useMutation({
    mutationFn: ({ txId, reqId }: { txId: string; reqId: string }) =>
      cancelReservation(txId, reqId, t("errors.cancelFailed")),
    onSuccess: () => { showToast(t("toasts.bronCancelled"), "ok"); invalidate(); },
    onError: (e: Error) => showToast(e.message, "err")
  });

  const borrowMut = useMutation({
    mutationFn: ({ tx }: { tx: Tx }) =>
      borrowBook(tx.user.id, tx.book.id, t("errors.borrowFailed"), tx.id, bronDueDate),
    onSuccess: () => { showToast(t("toasts.bookIssued"), "ok"); invalidate(); },
    onError: (e: Error) => showToast(e.message, "err")
  });

  const returnMut = useMutation({
    mutationFn: ({ txId, libId }: { txId: string; libId: string }) =>
      returnBook(txId, t("errors.returnFailed"), libId || undefined),
    onSuccess: (data) => {
      const msg = data.penaltyDays > 0
        ? t("toasts.bookReturnedLate", { days: data.penaltyDays })
        : t("toasts.bookReturned");
      showToast(msg, data.penaltyDays > 0 ? "err" : "ok");
      setReturnModal(null);
      invalidate();
    },
    onError: (e: Error) => showToast(e.message, "err")
  });

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "issue", label: t("tabs.issue") },
    { key: "brons", label: t("tabs.brons"), count: brons.length },
    { key: "borrowed", label: t("tabs.borrowed"), count: borrowed.length },
    { key: "overdue", label: t("tabs.overdue"), count: overdue.length }
  ];

  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString("uz-UZ") : "—";

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ${
            toast.type === "ok" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {toast.type === "ok"
            ? <Icon.success aria-hidden="true" size={ICON_SIZE.sm} />
            : <Icon.error aria-hidden="true" size={ICON_SIZE.sm} />}
          {toast.msg}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label={t("closeNotification")}
            className="-mr-1 ml-1 rounded-md p-1 transition-colors hover:bg-white/20"
          >
            <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
          </button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Icon.refresh aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowRegister(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
            {t("newReader")}
          </button>
          <label htmlFor="tx-lib-select" className="sr-only">{t("selectLibraryLabel")}</label>
          <select
            id="tx-lib-select"
            value={selectedLib}
            onChange={(e) => setSelectedLib(e.target.value)}
            className="border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[220px]"
          >
            <option value="">{t("selectLibraryPlaceholder")}</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      </div>

      {!selectedLib ? (
        <div className="bg-blue-50 border border-brand-200 rounded-xl p-8 text-center text-brand-700 text-sm">
          {t("selectLibraryPrompt")}
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-6 overflow-x-auto bg-surface-sunken rounded-xl p-1 w-fit max-w-full">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === t.key
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span className={`ml-2 px-1.5 py-0.5 rounded-full text-xs font-semibold ${
                    t.key === "overdue"
                      ? "bg-red-100 text-red-700"
                      : "bg-brand-100 text-brand-700"
                  }`}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* KITOB BERISH (to'g'ridan-to'g'ri) */}
          {activeTab === "issue" && (
            <IssueTab
              libraryId={selectedLib}
              initialSifatId={prefillSifatId}
              onToast={showToast}
              onDone={invalidate}
            />
          )}

          {/* BRONLAR — o'z yuklanish/xato holati bilan (boshqa tablarga bog'lanmagan) */}
          {activeTab === "brons" && (
            bronsLoading ? (
              <TabLoading />
            ) : bronsError ? (
              <ErrorState
                title={t("errors.bronsLoadTitle")}
                message={t("errors.bronsLoadMsg")}
                onRetry={() => refetchBrons()}
                isRetrying={bronsRefetching}
              />
            ) : (
              <div className="space-y-3">
                {brons.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap rounded-lg bg-amber-50 border border-amber-100 px-3 py-2">
                    <label htmlFor="bron-due-date" className="flex items-center gap-1 whitespace-nowrap text-sm font-medium text-amber-800"><Icon.calendar aria-hidden="true" size={ICON_SIZE.xs} />{t("brons.dueDateLabel")}</label>
                    <input
                      id="bron-due-date"
                      type="date"
                      value={bronDueDate}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setBronDueDate(e.target.value)}
                      className="border border-amber-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                    />
                    <span className="text-xs text-accent-600">{t("brons.dueDateHint")}</span>
                  </div>
                )}
                {brons.length === 0 ? (
                  <EmptyState
                    icon={Icon.bookmark}
                    title={t("brons.emptyTitle")}
                    description={t("brons.emptyDesc")}
                    action={
                      <button
                        type="button"
                        onClick={() => setActiveTab("issue")}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                      >
                        <Icon.book aria-hidden="true" size={ICON_SIZE.sm} />
                        {t("brons.issue")}
                      </button>
                    }
                  />
                ) : (
                  brons.map((tx) => (
                    <BookRow
                      key={tx.id}
                      book={tx.book}
                      action={
                        <div className="text-sm text-slate-700">
                          {t("brons.reader")} <span className="font-medium">{tx.user.name}</span>
                          {tx.user.sifatId && (
                            <span className="ml-2 font-mono text-xs text-slate-400">{tx.user.sifatId}</span>
                          )}
                          <span className="block text-xs text-slate-400">{tx.user.phone}</span>
                        </div>
                      }
                      meta={
                        <div className="flex flex-col items-end gap-2">
                          <div className="flex flex-col items-end gap-1">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              tx.status === "PENDING"
                                ? "bg-accent-100 text-accent-700"
                                : "bg-brand-100 text-brand-700"
                            }`}>
                              {label(TRANSACTION_STATUS_LABELS, tx.status)}
                            </span>
                            {tx.reservationExpiresAt && (
                              <span className="text-xs text-slate-400">
                                {t("brons.deadline", { date: formatDate(tx.reservationExpiresAt) })}
                              </span>
                            )}
                          </div>
                          {tx.status === "PENDING" && (
                            <button
                              onClick={() => confirmMut.mutate(tx.id)}
                              disabled={confirmMut.isPending}
                              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-green-600 px-3 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                            >
                              {t("brons.confirm")}
                            </button>
                          )}
                          {tx.status === "RESERVED" && (
                            <button
                              onClick={() => borrowMut.mutate({ tx })}
                              disabled={borrowMut.isPending}
                              className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                            >
                              {t("brons.issue")}
                            </button>
                          )}
                          <button
                            onClick={() => cancelMut.mutate({ txId: tx.id, reqId: tx.user.sifatId ?? "" })}
                            disabled={cancelMut.isPending}
                            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-red-50 px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                          >
                            {t("brons.cancel")}
                          </button>
                        </div>
                      }
                    />
                  ))
                )}
              </div>
            )
          )}

          {/* BERILGAN */}
          {activeTab === "borrowed" && (
            borrowedLoading ? (
              <TabLoading />
            ) : borrowedError ? (
              <ErrorState
                title={t("errors.borrowedLoadTitle")}
                message={t("errors.borrowedLoadMsg")}
                onRetry={() => refetchBorrowed()}
                isRetrying={borrowedRefetching}
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted text-slate-600 text-left">
                    <tr>
                      {[t("borrowed.colBook"), t("borrowed.colReader"), t("borrowed.colIssued"), t("borrowed.colDue")].map((h) => (
                        <th key={h} className="px-4 py-3 font-medium">{h}</th>
                      ))}
                      <th className="px-4 py-3 font-medium">
                        <span className="sr-only">{t("borrowed.colActions")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {borrowed.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                          {t("borrowed.empty")}
                        </td>
                      </tr>
                    ) : (
                      borrowed.map((tx) => {
                        const isLate = tx.dueDate && new Date(tx.dueDate) < new Date();
                        return (
                          <tr key={tx.id} className={`hover:bg-surface-muted ${isLate ? "bg-red-50" : ""}`}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <BookCover size="sm" title={tx.book.title} author={tx.book.author} />
                                <div className="min-w-0">
                                  <p className="font-medium text-slate-900">{tx.book.title}</p>
                                  <p className="text-xs text-slate-500">{tx.book.author}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <p>{tx.user.name}</p>
                              <p className="text-xs text-slate-400 font-mono">{tx.user.sifatId ?? tx.user.phone}</p>
                            </td>
                            <td className="px-4 py-3 text-slate-600">{formatDate(tx.createdAt)}</td>
                            <td className="px-4 py-3">
                              <span className={isLate ? "text-red-600 font-semibold" : "text-slate-700"}>
                                {formatDate(tx.dueDate)}
                                {isLate && <Icon.warning aria-hidden="true" size={ICON_SIZE.xs} className="ml-1 inline text-accent-500" />}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => { setReturnModal(tx); setReturnLibId(selectedLib); }}
                                className="inline-flex min-h-11 items-center rounded-lg bg-blue-50 px-3 text-xs font-medium text-brand-700 transition-colors hover:bg-blue-100"
                              >
                                {t("borrowed.return")}
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* MUDDATI O'TGAN */}
          {activeTab === "overdue" && (
            overdueLoading ? (
              <TabLoading />
            ) : overdueError ? (
              <ErrorState
                title={t("errors.overdueLoadTitle")}
                message={t("errors.overdueLoadMsg")}
                onRetry={() => refetchOverdue()}
                isRetrying={overdueRefetching}
              />
            ) : (
              <div className="space-y-3">
                {overdue.length === 0 ? (
                  // Ijobiy holat — bu "bo'sh ro'yxat" emas, yaxshi natija.
                  <div className="flex flex-col items-center justify-center rounded-xl border border-info-100 bg-info-50 px-6 py-12 text-center">
                    <div
                      aria-hidden="true"
                      className="flex h-12 w-12 items-center justify-center rounded-full bg-info-100 text-info-600"
                    >
                      <Icon.success size={ICON_SIZE.lg} strokeWidth={1.75} />
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-info-700">{t("overdue.emptyTitle")}</h3>
                    <p className="mt-1.5 text-sm text-info-600">{t("overdue.emptyDesc")}</p>
                  </div>
                ) : (
                  overdue.map((tx) => {
                    const days = tx.dueDate
                      ? Math.ceil((Date.now() - new Date(tx.dueDate).getTime()) / 86400000)
                      : 0;
                    return (
                      <BookRow
                        key={tx.id}
                        book={tx.book}
                        tone="danger"
                        action={
                          <div className="text-sm text-slate-700">
                            {tx.user.name}
                            <span className="ml-2 text-xs text-slate-400">{tx.user.phone}</span>
                            <span className="mt-1 block text-xs font-medium text-red-600">
                              {t("overdue.lateInfo", { days, date: formatDate(tx.dueDate) })}
                            </span>
                          </div>
                        }
                        meta={
                          <button
                            onClick={() => { setReturnModal(tx); setReturnLibId(selectedLib); }}
                            className="inline-flex min-h-11 items-center rounded-lg bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700"
                          >
                            {t("overdue.return")}
                          </button>
                        }
                      />
                    );
                  })
                )}
              </div>
            )
          )}
        </>
      )}

      {/* Qaytarish modali */}
      {returnModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-bold mb-2">{t("returnModal.title")}</h2>
            <p className="text-sm text-slate-600 mb-1">
              <span className="font-medium">{returnModal.book.title}</span>
            </p>
            <p className="text-sm text-slate-500 mb-4">{t("returnModal.reader", { name: returnModal.user.name })}</p>

            <div className="mb-4">
              <label htmlFor="return-lib-select" className="block text-sm font-medium text-slate-700 mb-1">
                {t("returnModal.libraryLabel")}
              </label>
              <select
                id="return-lib-select"
                value={returnLibId}
                onChange={(e) => setReturnLibId(e.target.value)}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm"
              >
                {libraries.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} {l.id === selectedLib ? t("returnModal.current") : ""}
                  </option>
                ))}
              </select>
              {returnLibId !== selectedLib && (
                <p className="text-xs text-accent-600 mt-1">
                  {t("returnModal.otherLibHint")}
                </p>
              )}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setReturnModal(null)}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
              >
                {t("returnModal.cancel")}
              </button>
              <button
                onClick={() => returnMut.mutate({ txId: returnModal.id, libId: returnLibId })}
                disabled={returnMut.isPending}
                className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {returnMut.isPending ? t("returnModal.returning") : t("returnModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Yangi kitobxon modali */}
      {showRegister && (
        <RegisterReaderModal
          onClose={() => setShowRegister(false)}
          onCreated={(res) => {
            setShowRegister(false);
            setCredModal({ phone: res.phone, sifatId: res.sifatId, password: res.tempPassword });
            showToast(t("toasts.readerAdded"), "ok");
          }}
        />
      )}

      {credModal && <ReaderCredModal {...credModal} onClose={() => setCredModal(null)} />}
    </div>
  );
}

// Har tab o'z yuklanish holatini ko'rsatadi — bitta umumiy isLoading barcha
// tablarni birdek to'sib qo'yar edi.
function TabLoading() {
  const t = useTranslations("TxPanel");
  return (
    <div className="flex justify-center py-12 text-slate-400">
      <Spinner size="lg" label={t("loading")} />
    </div>
  );
}

// ── Kitob berish (to'g'ridan-to'g'ri, walk-in) ────────────────────────────────

function IssueTab({
  libraryId,
  initialSifatId = "",
  onToast,
  onDone,
}: {
  libraryId: string;
  /** /scan sahifasidan ?sifatId= bilan kelganda oldindan to'ldiriladi. */
  initialSifatId?: string;
  onToast: (msg: string, type: "ok" | "err") => void;
  onDone: () => void;
}) {
  const t = useTranslations("TxPanel");
  const locale = useLocale();
  const [sifatId, setSifatId] = useState(initialSifatId);
  const [reader, setReader] = useState<{
    id: string; name: string; sifatId: string; type: string; status: string; trustScore: number;
  } | null>(null);
  const [lookupErr, setLookupErr] = useState("");
  const [looking, setLooking] = useState(false);
  const [bookSearch, setBookSearch] = useState("");
  // Qaytarish muddati — kutubxonachi o'zi belgilaydi (standart +14 kun).
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });

  const { data: books = [], isLoading: booksLoading } = useQuery({
    queryKey: ["issue-books", libraryId],
    queryFn: () => getLibraryBooksApi(libraryId),
    enabled: !!libraryId,
  });

  const lookup = async () => {
    const id = sifatId.trim();
    if (!id) return;
    setLooking(true); setLookupErr(""); setReader(null);
    try {
      const u = await scanUserQr(id);
      setReader(u);
      if (u.status !== "ACTIVE") setLookupErr(t("issue.notActive"));
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setLookupErr(msg ?? t("issue.notFound"));
    } finally { setLooking(false); }
  };

  const issueMut = useMutation({
    mutationFn: ({ bookId }: { bookId: string }) =>
      borrowBook(reader!.id, bookId, t("errors.borrowFailed"), undefined, dueDate),
    onSuccess: () => { onToast(t("toasts.bookIssued"), "ok"); onDone(); },
    onError: (e: Error) => onToast(e.message, "err"),
  });

  const filtered = bookSearch
    ? books.filter((b) => `${b.title} ${b.author} ${b.isbn}`.toLowerCase().includes(bookSearch.toLowerCase()))
    : books;

  return (
    <div className="space-y-4">
      <div className="card-surface rounded-xl p-4">
        {/* Havola label ICHIDA bo'lsa labelni bosish inputga emas, havolaga
            olib ketardi — shuning uchun ular ajratilgan. */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="issue-sifat-id" className="text-sm font-medium text-slate-700">
            {t("issue.findLabel")}
          </label>
          <Link
            href={`/${locale}/scan`}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
          >
            <Icon.qr aria-hidden="true" size={ICON_SIZE.sm} />
            {t("issue.qrScanner")}
          </Link>
        </div>
        <div className="flex gap-2">
          <input
            id="issue-sifat-id"
            value={sifatId}
            onChange={(e) => setSifatId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookup()}
            placeholder="SL-UZ-..."
            className="flex-1 border border-line-strong rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button onClick={lookup} disabled={looking || !sifatId.trim()}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
            {looking ? "…" : t("issue.search")}
          </button>
        </div>
        {lookupErr && <p className="text-sm text-red-600 mt-2">{lookupErr}</p>}
        {reader && (
          <div className="mt-3 flex items-center gap-3 rounded-lg bg-blue-50 border border-brand-100 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Icon.reader aria-hidden="true" size={ICON_SIZE.sm} /></span>
            <div className="min-w-0">
              <p className="font-semibold text-slate-900 truncate">{reader.name}</p>
              <p className="text-xs text-slate-500 font-mono">{reader.sifatId} · {t("issue.trust", { score: reader.trustScore })}</p>
            </div>
            <span className={`ml-auto shrink-0 text-xs px-2 py-0.5 rounded-full ${reader.status === "ACTIVE" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
              {label(USER_STATUS_LABELS, reader.status)}
            </span>
          </div>
        )}
      </div>

      {reader && reader.status === "ACTIVE" && (
        <div className="card-surface rounded-xl p-4">
          <div className="mb-3 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="font-semibold text-slate-900">{t("issue.chooseTitle")}</h3>
              <div>
                <label htmlFor="issue-book-search" className="sr-only">{t("issue.bookSearchLabel")}</label>
                <input id="issue-book-search" value={bookSearch} onChange={(e) => setBookSearch(e.target.value)} placeholder={t("issue.bookSearchPlaceholder")}
                  className="border border-line-strong rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap rounded-lg bg-amber-50 border border-amber-100 px-3 py-2">
              <label htmlFor="issue-due-date" className="flex items-center gap-1 whitespace-nowrap text-sm font-medium text-amber-800"><Icon.calendar aria-hidden="true" size={ICON_SIZE.xs} />{t("issue.dueDateLabel")}</label>
              <input
                id="issue-due-date"
                type="date"
                value={dueDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDueDate(e.target.value)}
                className="border border-amber-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <span className="text-xs text-accent-600">{t("issue.dueDateHint")}</span>
            </div>
          </div>
          {booksLoading ? (
            <p className="text-sm text-slate-400 text-center py-6">{t("issue.loadingBooks")}</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">{t("issue.noBooks")}</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-auto">
              {filtered.map((b) => (
                <BookRow
                  key={b.id}
                  book={b}
                  action={<span className="text-xs text-slate-500">{t("issue.available", { count: b.availableCount })}</span>}
                  meta={
                    <button
                      onClick={() => issueMut.mutate({ bookId: b.id })}
                      disabled={issueMut.isPending}
                      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-green-600 px-3 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                    >
                      {t("issue.give")}
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Yangi kitobxon/xodim qo'shish modali ──────────────────────────────────────

function RegisterReaderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (res: { phone: string; sifatId: string | null; tempPassword: string }) => void;
}) {
  const t = useTranslations("TxPanel");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+998");
  const [gender, setGender] = useState<"MALE" | "FEMALE">("MALE");
  const [viloyatId, setViloyatId] = useState("");
  const [tumanId, setTumanId] = useState("");
  const [mahallaId, setMahallaId] = useState("");
  const [error, setError] = useState("");

  const { data: viloyatlar = [] } = useQuery({ queryKey: ["geo-vil"], queryFn: getViloyatlar, staleTime: 3600_000 });
  const { data: tumanlar = [] } = useQuery({ queryKey: ["geo-tum", viloyatId], queryFn: () => getTumanlar(viloyatId), enabled: !!viloyatId, staleTime: 3600_000 });
  const { data: mahallalar = [] } = useQuery({ queryKey: ["geo-mah", tumanId], queryFn: () => getMahallalar(tumanId), enabled: !!tumanId, staleTime: 3600_000 });

  const createMut = useMutation({
    mutationFn: () =>
      registerReaderApi(
        { name: name.trim(), phone: phone.replace(/\s/g, ""), gender, mahallaId },
        t("errors.readerAddFailed")
      ),
    onSuccess: (res) => onCreated({ phone: res.phone, sifatId: res.sifatId, tempPassword: res.tempPassword }),
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    setError("");
    if (!name.trim()) { setError(t("register.errName")); return; }
    if (!/^\+\d{9,15}$/.test(phone.replace(/\s/g, ""))) { setError(t("register.errPhone")); return; }
    if (!mahallaId) { setError(t("register.errRegion")); return; }
    createMut.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-lg w-full my-8" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-900 text-lg mb-4">{t("register.title")}</h3>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="reg-name" className="block text-xs font-medium text-slate-500 mb-1">{t("register.name")}</label>
              <input id="reg-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="reg-phone" className="block text-xs font-medium text-slate-500 mb-1">{t("register.phone")}</label>
              <input id="reg-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>
          <fieldset>
            <legend className="block text-xs font-medium text-slate-500 mb-1">{t("register.gender")}</legend>
            <div className="flex gap-2">
              {(["MALE", "FEMALE"] as const).map((g) => (
                <button key={g} type="button" aria-pressed={gender === g} onClick={() => setGender(g)}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium border ${gender === g ? "bg-brand-600 text-white border-brand-600" : "border-line text-slate-600 hover:bg-surface-muted"}`}>
                  {g === "MALE" ? t("register.male") : t("register.female")}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 rounded-2xl bg-blue-50/50 border border-brand-100 p-3">
            <p className="text-xs text-brand-700 font-medium">{t("register.region")}</p>
            <label htmlFor="reg-viloyat" className="sr-only">{t("register.viloyat")}</label>
            <select id="reg-viloyat" value={viloyatId} onChange={(e) => { setViloyatId(e.target.value); setTumanId(""); setMahallaId(""); }} className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">{t("register.viloyatPh")}</option>
              {viloyatlar.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <label htmlFor="reg-tuman" className="sr-only">{t("register.tuman")}</label>
            <select id="reg-tuman" value={tumanId} onChange={(e) => { setTumanId(e.target.value); setMahallaId(""); }} disabled={!viloyatId} className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-muted">
              <option value="">{t("register.tumanPh")}</option>
              {tumanlar.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
            <label htmlFor="reg-mahalla" className="sr-only">{t("register.mahalla")}</label>
            <select id="reg-mahalla" value={mahallaId} onChange={(e) => setMahallaId(e.target.value)} disabled={!tumanId} className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-muted">
              <option value="">{t("register.mahallaPh")}</option>
              {mahallalar.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-xl border border-line text-sm font-medium hover:bg-surface-muted">{t("register.cancel")}</button>
          <button onClick={submit} disabled={createMut.isPending} className="flex-1 px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 disabled:opacity-50">
            {createMut.isPending ? t("register.adding") : t("register.add")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReaderCredModal({
  phone,
  sifatId,
  password,
  onClose,
}: {
  phone: string;
  sifatId: string | null;
  password: string;
  onClose: () => void;
}) {
  const t = useTranslations("TxPanel");
  const [copied, setCopied] = useState(false);
  // Parol sukut bo'yicha yashirin — yonidan o'tayotgan kishi o'qib qolmasin.
  const [showPassword, setShowPassword] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`SifatID: ${sifatId ?? "-"}\n${t("cred.phone")}: ${phone}\n${t("cred.password")}: ${password}`);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard yo'q */ }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-50 text-green-600"><Icon.success aria-hidden="true" size={ICON_SIZE.md} /></span>
          <h3 className="font-bold text-slate-900 text-lg">{t("cred.title")}</h3>
        </div>
        <p className="text-sm text-slate-600 mb-4">{t("cred.info")}</p>
        <div className="rounded-xl bg-surface-muted border border-line p-3 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-slate-400">SifatID</span><span className="font-mono font-semibold text-slate-900">{sifatId ?? "—"}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">{t("cred.phone")}</span><span className="font-mono text-slate-900">{phone}</span></div>
          <div className="flex justify-between items-center gap-2">
            <span className="text-slate-400">{t("cred.password")}</span>
            <span className="flex items-center gap-2">
              <span className="font-mono font-bold text-brand-700">
                {showPassword ? password : "••••••••"}
              </span>
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                {showPassword ? t("cred.hide") : t("cred.show")}
              </button>
            </span>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-accent-700">
          <Icon.warning aria-hidden="true" size={ICON_SIZE.xs} className="mt-0.5 shrink-0" />
          {t("cred.onceWarning")}
        </p>
        <div className="flex gap-2 mt-4">
          <button onClick={copy} className="flex-1 px-4 py-2 rounded-xl border border-brand-200 text-brand-700 text-sm font-medium hover:bg-blue-50">{copied
              ? <span className="inline-flex items-center gap-1"><Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />{t("cred.copied")}</span>
              : <span className="inline-flex items-center gap-1"><Icon.document aria-hidden="true" size={ICON_SIZE.xs} />{t("cred.copy")}</span>}</button>
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800">{t("cred.close")}</button>
        </div>
      </div>
    </div>
  );
}
