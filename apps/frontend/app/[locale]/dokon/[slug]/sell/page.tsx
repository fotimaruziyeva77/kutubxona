"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { fetchStoreProfile, fetchMyStore } from "@/lib/api/store";
import { Card, CardContent } from "@/components/ui/card";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import dynamic from "next/dynamic";

// Kamera skaner faqat browserda — SSR'siz dinamik import.
const CustomerQrScanner = dynamic(() => import("@/components/store/CustomerQrScanner"), { ssr: false });

// ── API ───────────────────────────────────────────────────────────────────────

// Fallback xabarlar toast'da ko'rinadi — komponentdan tarjima qilingan holda
// uzatiladi (server o'z xabarini yuborsa, o'shanisi ustun).
async function submitStoreEntry(operatorId: string, phone: string, isbn: string, fallbackMsg: string) {
  const res = await apiClient("/transactions/store-entry", {
    method: "POST",
    body: JSON.stringify({ operatorId, phone, isbn })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? fallbackMsg);
  }
  return res.json() as Promise<{ id: string; title: string; userId: string }>;
}

// Profil QR'i {"t":"<token>"} ko'rinishida — undan tokenni ajratamiz.
function parseQrToken(text: string): string {
  const t = (text ?? "").trim();
  try {
    const o = JSON.parse(t);
    if (o && typeof o.t === "string") return o.t;
  } catch {
    /* JSON emas — to'g'ridan-to'g'ri token/sifatId */
  }
  return t;
}

async function resolveCustomerQr(token: string, fallbackMsg: string): Promise<{ sifatId: string; name: string }> {
  const res = await apiClient("/users/qr/resolve", { method: "POST", body: JSON.stringify({ token }) });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? fallbackMsg);
  }
  return res.json();
}

async function storeQrEntryApi(
  sifatId: string,
  isbn: string,
  fallbackMsg: string,
): Promise<{ stock: { decremented: boolean; stockCount: number | null }; customer: { name: string } }> {
  const res = await apiClient("/transactions/store-qr-entry", { method: "POST", body: JSON.stringify({ sifatId, isbn }) });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? fallbackMsg);
  }
  return res.json();
}

// ── Sahifa ────────────────────────────────────────────────────────────────────

export default function DokonPage() {
  const locale = useLocale();
  const t = useTranslations("DokonSell");
  const { user } = useAuthStore();
  const [phone, setPhone] = useState("");
  const [isbn, setIsbn] = useState("");
  const [history, setHistory] = useState<{ phone: string; isbn: string; title: string; time: string }[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Operatorning do'koni JWT'dan aniqlanadi (Store.operatorId) — `organizationId`
  // EMAS (do'kon operatorida u bo'sh bo'ladi, shu sabab avval "ulanmagan" derdi).
  const isStoreRole = user?.role === "DOKON_OPERATOR" || user?.role === "SUPER_ADMIN";
  const {
    data: myStore,
    // isPending — oflayn-pauza holatida ham skeletonda qoladi (isLoading u
    // paytda false bo'lib, "ulanmagan" yolg'oni chiqarardi).
    isPending: myStoreLoading,
    isError: myStoreError,
    refetch: refetchMyStore,
    isRefetching: myStoreRetrying,
  } = useQuery({
    queryKey: ["my-store"],
    queryFn: fetchMyStore,
    enabled: isStoreRole,
    retry: false,
  });
  // To'liq profil (premium, kitoblar soni) — slug topilgach.
  const { data: store, isPending: profileLoading } = useQuery({
    queryKey: ["store-profile", myStore?.slug],
    queryFn: () => fetchStoreProfile(myStore!.slug),
    enabled: !!myStore?.slug,
    retry: false,
  });
  // Ko'rsatish uchun: to'liq profil bo'lsa o'sha, aks holda /store/my asoslari.
  const displayStore = store ?? myStore ?? null;
  const storeLoading = myStoreLoading || (!!myStore?.slug && profileLoading && !store);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const submit = useMutation({
    mutationFn: () => submitStoreEntry(user?.id ?? "", phone, isbn.replace(/[-\s]/g, ""), t("sendError")),
    onSuccess: (data) => {
      setHistory((prev) => [
        { phone, isbn: isbn.replace(/[-\s]/g, ""), title: data.title, time: new Date().toLocaleTimeString("uz-UZ") },
        ...prev.slice(0, 19)
      ]);
      showToast(t("smsSentToast", { title: data.title }), true);
      setPhone("");
      setIsbn("");
    },
    onError: (e: Error) => showToast(e.message, false)
  });

  // ── QR-skan oqimi ──
  const [scanOpen, setScanOpen] = useState(false);
  const [qrCustomer, setQrCustomer] = useState<{ sifatId: string; name: string } | null>(null);
  const [qrIsbn, setQrIsbn] = useState("");
  const [resolving, setResolving] = useState(false);

  const onScanResult = async (text: string) => {
    setScanOpen(false);
    setResolving(true);
    try {
      const c = await resolveCustomerQr(parseQrToken(text), t("qrCheckError"));
      setQrCustomer({ sifatId: c.sifatId, name: c.name });
    } catch (e) {
      showToast(e instanceof Error ? e.message : t("qrInvalid"), false);
    } finally {
      setResolving(false);
    }
  };

  const qrSubmit = useMutation({
    mutationFn: () => storeQrEntryApi(qrCustomer!.sifatId, qrIsbn.replace(/[-\s]/g, ""), t("recordError")),
    onSuccess: (data) => {
      const s = data.stock;
      showToast(
        s.decremented
          ? t("recordedDecrement", { count: String(s.stockCount) })
          : t("recordedNoCatalog"),
        true,
      );
      setHistory((prev) => [
        {
          phone: data.customer?.name ?? qrCustomer?.name ?? "—",
          isbn: qrIsbn.replace(/[-\s]/g, ""),
          title: t("qrPurchase"),
          time: new Date().toLocaleTimeString("uz-UZ"),
        },
        ...prev.slice(0, 19),
      ]);
      setQrCustomer(null);
      setQrIsbn("");
    },
    onError: (e: Error) => showToast(e.message, false),
  });

  const isValid = phone.replace(/\D/g, "").length >= 9 && isbn.replace(/[-\s]/g, "").length === 13;

  return (
    <div className="min-h-screen bg-surface-muted flex flex-col">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all ${
          toast.ok ? "bg-green-600" : "bg-red-600"
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-line px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t("title")}</h1>
          <p className="text-sm text-slate-500">{t("subtitle")}</p>
        </div>
        <div className="text-sm text-slate-500">
          {user?.name ?? t("operatorFallback")}
        </div>
      </header>

      <main className="flex-1 p-6 max-w-2xl mx-auto w-full">
        {/* ── Sizning do'koningiz (Your Store) card ── */}
        {(user?.role === "DOKON_OPERATOR" || user?.role === "SUPER_ADMIN") && (
          <div className="mb-6">
            {storeLoading ? (
              <Card>
                <CardContent className="p-6">
                  <Skeleton className="h-5 w-48 mb-3" />
                  <Skeleton className="h-4 w-32" />
                </CardContent>
              </Card>
            ) : myStoreError ? (
              // So'rov xatosi "ulanmagan" degani EMAS — alohida ko'rsatiladi.
              <ErrorState
                title={t("storeErrorTitle")}
                message={t("storeErrorMessage")}
                onRetry={() => refetchMyStore()}
                isRetrying={myStoreRetrying}
              />
            ) : displayStore ? (
              <Card className={store?.premiumBadge ? "border-amber-300 ring-1 ring-amber-200" : ""}>
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                        {t("yourStore")}
                        {store?.premiumBadge && (
                          <span className="inline-flex items-center gap-1 bg-amber-50 border border-amber-300 text-amber-800 text-xs font-bold px-2 py-0.5 rounded-full">
                            <Icon.star aria-hidden="true" size={ICON_SIZE.xs} className="text-accent-500" />
                            {t("premium")}
                          </span>
                        )}
                      </h2>
                      <p className="text-sm text-slate-600 mt-1">{displayStore.name}</p>
                    </div>
                    {store && (
                      <span className="text-sm text-slate-400">
                        {t("bookCount", { count: String(store.productCount) })}
                      </span>
                    )}
                  </div>

                  {/* Ilgari bular [locale] segmentisiz oddiy <a> edi: har
                      bosishda butun ilova qayta yuklanardi va til uz-Latn ga
                      qaytardi. Endi klient tomonda, joriy til bilan. */}
                  <div className="flex flex-wrap gap-3">
                    <Link
                      href={`/${locale}/dokon/${displayStore.slug}`}
                      className="px-4 py-2 bg-white border border-line-strong rounded-lg text-sm font-medium text-slate-700 hover:bg-surface-muted transition-colors"
                    >
                      {t("viewProfile")}
                    </Link>
                    <Link
                      href={`/${locale}/dokon/${displayStore.slug}/dashboard`}
                      className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
                    >
                      {t("analytics")}
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="p-6">
                  <h2 className="text-base font-semibold text-amber-900 mb-1">
                    {t("notConnectedTitle")}
                  </h2>
                  <p className="text-sm text-amber-700">
                    {t("notConnectedMessage")}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Qo'llanma */}
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 mb-6 text-sm text-brand-800">
          <p className="font-semibold mb-1">{t("howTitle")}</p>
          <ol className="space-y-1 list-decimal list-inside text-brand-700">
            <li>{t("howStep1")}</li>
            <li>{t("howStep2")}</li>
            <li>{t("howStep3")}</li>
            <li>{t("howStep4")}</li>
          </ol>
        </div>

        {/* ── QR-skan xaridi (asosiy usul) ── */}
        <div className="card-surface rounded-2xl p-6 shadow-sm mb-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 mb-1">
            <Icon.camera aria-hidden="true" size={ICON_SIZE.sm} />
            {t("qrTitle")}
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            {t("qrSubtitle")}
          </p>

          {scanOpen ? (
            <CustomerQrScanner onResult={onScanResult} onClose={() => setScanOpen(false)} />
          ) : qrCustomer ? (
            <div className="space-y-3">
              {/* Faqat ism ko'rsatiladi — xom sifatId operatorga kerak emas,
                  u payloadda (qrCustomer.sifatId) qoladi. */}
              <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
                <span className="inline-flex items-center gap-1.5 text-green-700 font-medium text-sm">
                  <Icon.check aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("customerLabel", { name: qrCustomer.name })}
                </span>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("soldIsbnLabel")}</label>
                <input
                  value={qrIsbn}
                  onChange={(e) => setQrIsbn(e.target.value)}
                  placeholder="978-9943-452-78-7"
                  className="w-full border border-line-strong rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => qrSubmit.mutate()}
                  disabled={qrIsbn.replace(/[-\s]/g, "").length !== 13 || qrSubmit.isPending}
                  className="flex-1 py-3 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
                >
                  {qrSubmit.isPending ? t("recording") : t("recordPurchase")}
                </button>
                <button
                  onClick={() => { setQrCustomer(null); setQrIsbn(""); }}
                  className="px-4 py-3 border border-line-strong rounded-xl text-sm text-slate-600 hover:bg-surface-muted"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setScanOpen(true)}
              disabled={resolving}
              className="flex w-full items-center justify-center gap-2 py-3 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
            >
              {resolving ? (
                t("checking")
              ) : (
                <>
                  <Icon.camera aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("startScan")}
                </>
              )}
            </button>
          )}
        </div>

        {/* Forma — telefon orqali (muqobil) */}
        <div className="card-surface rounded-2xl p-6 shadow-sm mb-6">
          <h2 className="text-base font-semibold text-slate-900 mb-4">{t("phoneTitle")}</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("phoneLabel")}
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+998 90 123 45 67"
                className="w-full border border-line-strong rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("isbnLabel")}
              </label>
              <input
                type="text"
                value={isbn}
                onChange={(e) => setIsbn(e.target.value)}
                placeholder="978-9943-452-78-7"
                className="w-full border border-line-strong rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {isbn.replace(/[-\s]/g, "").length > 0 && isbn.replace(/[-\s]/g, "").length !== 13 && (
                <p role="alert" className="text-xs text-red-600 mt-1">
                  {t("isbnInvalid", { count: String(isbn.replace(/[-\s]/g, "").length) })}
                </p>
              )}
            </div>

            <button
              onClick={() => submit.mutate()}
              disabled={!isValid || submit.isPending}
              className="w-full py-3 bg-brand-600 text-white rounded-xl text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {submit.isPending ? t("sending") : t("sendToReader")}
            </button>
          </div>
        </div>

        {/* Seans yozuvlari — useState'da saqlanadi, sahifa yangilansa yo'qoladi;
            sarlavha shu chegarani halol aytadi. */}
        {history.length > 0 && (
          <div className="card-surface rounded-2xl p-6 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900 mb-4">
              {t("sessionRecords", { count: String(history.length) })}
            </h2>
            <div className="space-y-2">
              {history.map((h, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-surface-muted rounded-xl text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 truncate">{h.title}</p>
                    <p className="text-xs text-slate-500">{h.phone} - ISBN: {h.isbn}</p>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0 ml-2">{h.time}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Statistika */}
        <div className="mt-6 bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
          <p className="font-semibold">{t("partnershipTitle")}</p>
          <p className="mt-1 text-green-700">
            {t("partnershipText")}
          </p>
        </div>
      </main>
    </div>
  );
}
