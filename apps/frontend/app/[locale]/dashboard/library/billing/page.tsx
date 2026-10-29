"use client";

// Plan 04-03 Task 4 — Library self-service billing page (PAY-06).
//
// The library admin sees their own subscription status (TRIAL / PENDING /
// ACTIVE / FROZEN / DELETED + days remaining) and a "Pay now" button when
// payment is due. The Pay-Now button calls the renew endpoint which either
// returns a payment URL (Payme/Click) or — in dev with
// DEV_SUBSCRIPTION_PAYMENT_STUB — short-circuits to a synthetic success
// per OQ-6.
//
// Plan 04-03 audit-fix FIX E (SEC MEDIUM) — use apiClient (Bearer + 401
// refresh) instead of raw fetch + credentials:'include'. Backend's
// JwtAuthGuard reads Bearer from the Authorization header; without it
// every request to /subscriptions/* returned 401. Also: switch to the new
// GET /subscriptions/library/me endpoint added in FIX C so we don't have
// to read libraryId from the client side.

import { useState, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { fmtNumber } from "@/lib/format";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api/client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { DashboardPage, PageHeader, Panel } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { PageSpinner } from "@/components/ui/spinner";
import {
  PLAN_LABELS,
  INVOICE_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  LIBRARY_TYPE_LABELS,
  label,
} from "@/lib/labels.const";

interface Invoice {
  id: string;
  amount: string;
  status: string;
  dueDate: string;
  paidDate?: string | null;
  paymentMethod?: string | null;
}

interface Subscription {
  id: string;
  libraryId: string;
  planType: string;
  planLabel?: string;
  planPrice?: number;
  status: "TRIAL" | "PENDING" | "ACTIVE" | "FROZEN" | "DELETED";
  startDate: string;
  endDate: string;
  trialEnd?: string | null;
  frozenReason?: string | null;
  frozenAt?: string | null;
  invoices: Invoice[];
}

function useMyLibrarySubscription(enabled: boolean) {
  return useQuery({
    queryKey: ["library-subscription-me"],
    queryFn: async () => {
      // FIX C — server resolves the caller's libraryId from the JWT subject.
      const { data } = await apiClient.get<Subscription | null>(
        "/subscriptions/library/me",
      );
      return data;
    },
    enabled,
    staleTime: 30_000,
  });
}

// SUPER_ADMIN has no library of their own, so /subscriptions/library/me 403s.
// Instead they pick a library and we read GET /subscriptions/library/:libraryId
// (admin tiers may read any library — payment.controller). Mirrors how the
// Maktab/Idora panels resolve "MY institution" via a selector for SUPER_ADMIN.
function useLibrarySubscriptionById(libraryId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["library-subscription", libraryId],
    queryFn: async () => {
      const { data } = await apiClient.get<Subscription | null>(
        `/subscriptions/library/${libraryId}`,
      );
      return data;
    },
    enabled: enabled && !!libraryId,
    staleTime: 30_000,
  });
}

interface ManageableLibrary {
  id: string;
  name: string;
  code: string;
  type: string;
}

// GET /libraries/mine returns all ACTIVE libraries for SUPER_ADMIN (scoped for
// tier admins) — auth required, no RolesGuard.
function useManageableLibraries(enabled: boolean) {
  return useQuery({
    queryKey: ["libraries-mine"],
    queryFn: async () => {
      const { data } = await apiClient.get<ManageableLibrary[]>("/libraries/mine");
      return data;
    },
    enabled,
    staleTime: 300_000,
  });
}

// Tarif katalogi (GET /subscriptions/plans) — obunasiz holatda kutubxona
// turiga mos tarifni ko'rsatish uchun.
interface PlanCatalogItem {
  planType: string;
  label: string;
  price: number;
  free: boolean;
}
function usePlans() {
  return useQuery({
    queryKey: ["subscription-plans"],
    queryFn: async () =>
      (await apiClient.get<PlanCatalogItem[]>("/subscriptions/plans")).data,
    staleTime: 60 * 60 * 1000,
  });
}

// Obunani boshlash (trial) — SUPER_ADMIN / MUASSASA_ADMIN / BUXGALTER.
function useTrialMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { libraryId: string; planType: string }) => {
      const { data } = await apiClient.post("/subscriptions/trial", args);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library-subscription-me"] });
      qc.invalidateQueries({ queryKey: ["library-subscription"] });
    },
  });
}

// Obuna yo'q holatda — kutubxona turiga mos tarif + (vakolatli rol uchun)
// obunani boshlash. Endi sahifa "Obuna topilmadi" deb bo'sh qolmaydi.
function NoSubscriptionTariff({
  library,
  canManage,
  onStarted,
}: {
  library?: ManageableLibrary;
  canManage: boolean;
  onStarted: () => void;
}) {
  const t = useTranslations("BillingPanel");
  const { data: plans = [] } = usePlans();
  const trial = useTrialMutation();
  const libType = library?.type ?? "";
  const applicable = plans.filter(
    (p) => p.planType === libType || p.planType.startsWith(`${libType}_`),
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <p className="font-semibold text-amber-900">{t("noSub.title")}</p>
        <p className="text-sm text-amber-700 mt-1">
          {library
            ? `${t("noSub.libraryLine", { name: library.name, type: label(LIBRARY_TYPE_LABELS, libType) })} `
            : ""}
          {canManage ? t("noSub.chooseCta") : t("noSub.adminOnly")}
        </p>
      </div>

      {applicable.length === 0 ? (
        <p className="text-slate-500">{t("noSub.noPlans")}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {applicable.map((p) => (
            <div key={p.planType} className="rounded-2xl border border-line bg-white p-5">
              <div className="font-semibold text-slate-900">{p.label}</div>
              <div className="text-2xl font-bold mt-1">
                {p.free ? t("noSub.free") : t("noSub.price", { price: fmtNumber(p.price) })}
                {!p.free && <span className="text-sm font-normal text-slate-500">{t("noSub.perYear")}</span>}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {p.free ? t("noSub.freeNote") : t("noSub.paidNote")}
              </p>
              {canManage && library && (
                <button
                  onClick={() =>
                    trial.mutate({ libraryId: library.id, planType: p.planType }, { onSuccess: onStarted })
                  }
                  disabled={trial.isPending}
                  className="mt-3 w-full px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                >
                  {trial.isPending ? "..." : p.free ? t("noSub.activate") : t("noSub.startTrial")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!canManage && (
        <p className="text-sm text-slate-500">
          {t("noSub.manageNote")}
        </p>
      )}
    </div>
  );
}

function useRenewMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { subscriptionId: string; provider?: string }) => {
      const qs = args.provider ? `?provider=${args.provider}` : "";
      const { data } = await apiClient.post(
        `/subscriptions/${args.subscriptionId}/renew${qs}`,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library-subscription-me"] }),
  });
}

// Authed PDF download (Bearer) — faktura yoki shartnoma.
async function downloadPdf(url: string, filename: string) {
  const res = await apiClient.get(url, { responseType: "blob" });
  const objUrl = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objUrl);
}

function StatusBadge({ status }: { status: Subscription["status"] }) {
  const colors: Record<Subscription["status"], string> = {
    TRIAL: "bg-brand-100 text-brand-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    ACTIVE: "bg-green-100 text-green-700",
    FROZEN: "bg-orange-100 text-orange-700",
    DELETED: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-block px-3 py-1 rounded text-sm font-semibold ${colors[status]}`}>
      {label(SUBSCRIPTION_STATUS_LABELS, status)}
    </span>
  );
}

// Faktura holati — xom enum o'rniga o'zbekcha yorliq + rang.
const INVOICE_BADGE_COLORS: Record<string, string> = {
  PAID: "bg-green-100 text-green-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  OVERDUE: "bg-red-100 text-red-700",
  CANCELLED: "bg-surface-sunken text-slate-600",
};

function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold ${
        INVOICE_BADGE_COLORS[status] ?? "bg-surface-sunken text-slate-600"
      }`}
    >
      {label(INVOICE_STATUS_LABELS, status)}
    </span>
  );
}

function daysBetween(a: Date, b: Date) {
  return Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

export default function LibraryBillingPage() {
  const t = useTranslations("BillingPanel");
  const { user, isAuthenticated } = useAuthStore();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const canManage = ["SUPER_ADMIN", "MUASSASA_ADMIN", "BUXGALTER"].includes(user?.role ?? "");
  const renew = useRenewMutation();

  // SUPER_ADMIN: pick a library, read its subscription by id. Boshqa rollar uchun
  // /libraries/mine o'z kutubxonasini qaytaradi (obunasiz holatda tarif uchun).
  const [selectedLibraryId, setSelectedLibraryId] = useState("");
  const { data: libraries, isLoading: librariesLoading } =
    useManageableLibraries(!!isAuthenticated);
  const libraryList = useMemo(() => libraries ?? [], [libraries]);
  const currentLibrary = isSuperAdmin
    ? libraryList.find((l) => l.id === selectedLibraryId)
    : libraryList[0];

  // Bitta kutubxona bo'lsa avtomatik tanlanadi. Bu ilgari to'g'ridan-to'g'ri
  // render ichida setState chaqirardi — React ogohlantirish beradi va
  // qayta-qayta render aylanishiga olib kelishi mumkin edi.
  useEffect(() => {
    if (isSuperAdmin && !selectedLibraryId && libraryList.length === 1) {
      setSelectedLibraryId(libraryList[0].id);
    }
  }, [isSuperAdmin, selectedLibraryId, libraryList]);

  // Plan 04-03 audit-fix FIX C — for normal library admins the server resolves
  // the caller's library from the JWT (/me 403s if no affiliation). SUPER_ADMIN
  // has no library, so we read the chosen one by id instead.
  const meQ = useMyLibrarySubscription(!!isAuthenticated && !isSuperAdmin);
  const byIdQ = useLibrarySubscriptionById(selectedLibraryId, !!isAuthenticated && isSuperAdmin);

  const subQ = isSuperAdmin ? byIdQ : meQ;
  const sub = subQ.data;
  const isLoading = subQ.isLoading;
  const error = subQ.error as { response?: { status?: number } } | null;
  const refetch = subQ.refetch;

  if (!user) {
    return (
      <DashboardPage className="max-w-3xl">
        <h1 className="text-2xl font-bold">{t("authRequired.title")}</h1>
        <p className="text-slate-600">{t("authRequired.desc")}</p>
      </DashboardPage>
    );
  }

  // SUPER_ADMIN selector shell — render the dropdown plus the appropriate body
  // (empty-state until a library is chosen, then loading/error/subscription).
  if (isSuperAdmin) {
    return (
      <DashboardPage className="max-w-3xl">
        <PageHeader title={t("titleSuper")} icon={Icon.payment} />

        <Panel noReveal>
          <label
            htmlFor="billing-library"
            className="text-sm font-medium text-slate-700 block mb-2"
          >
            {t("selectLibrary")}
          </label>
          <select
            id="billing-library"
            className="h-10 w-full max-w-md rounded-lg border border-line-strong bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            value={selectedLibraryId}
            onChange={(e) => setSelectedLibraryId(e.target.value)}
          >
            <option value="">{t("selectLibraryOption")}</option>
            {libraryList.map((lib) => (
              <option key={lib.id} value={lib.id}>
                {lib.name} ({lib.code})
              </option>
            ))}
          </select>
          {/* Yuklanish paytida "topilmadi" deb yolg'on xabar chiqmasin. */}
          {!librariesLoading && libraryList.length === 0 && (
            <p className="text-xs text-slate-400 mt-2">{t("noActiveLibraries")}</p>
          )}
        </Panel>

        {!selectedLibraryId ? (
          <div className="flex flex-col items-center py-16 text-slate-400">
            <Icon.library aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} className="text-slate-300" />
            <p className="mt-4">{t("selectPrompt")}</p>
          </div>
        ) : isLoading ? (
          <PageSpinner />
        ) : error ? (
          <ErrorState
            title={t("loadErrorTitle")}
            message={t("loadErrorMsg")}
            onRetry={() => refetch()}
          />
        ) : !sub ? (
          <NoSubscriptionTariff library={currentLibrary} canManage={canManage} onStarted={() => refetch()} />
        ) : (
          <SubscriptionDetails sub={sub} renew={renew} refetch={refetch} />
        )}
      </DashboardPage>
    );
  }

  if (isLoading) {
    return (
      <DashboardPage className="max-w-3xl">
        <PageSpinner />
      </DashboardPage>
    );
  }
  // Non-super users: a 403 means the account has no library affiliation. Show a
  // friendly message instead of a raw AxiosError toast/string.
  if (error) {
    if (error?.response?.status === 403) {
      return (
        <DashboardPage className="max-w-3xl">
          <div className="p-8 text-center">
            <div className="mb-4 flex justify-center text-slate-300">
              <Icon.library aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} />
            </div>
            <p className="text-slate-500">
              {t("noAffiliation")}
            </p>
          </div>
        </DashboardPage>
      );
    }
    return (
      <DashboardPage className="max-w-3xl">
        <ErrorState
          title={t("loadErrorTitle")}
          message={t("loadErrorMsg")}
          onRetry={() => refetch()}
        />
      </DashboardPage>
    );
  }
  if (!sub) {
    return (
      <DashboardPage className="max-w-3xl">
        <PageHeader title={t("titleMine")} icon={Icon.payment} />
        <NoSubscriptionTariff library={currentLibrary} canManage={canManage} onStarted={() => refetch()} />
      </DashboardPage>
    );
  }

  return (
    <DashboardPage className="max-w-3xl">
      <PageHeader title={t("titleMine")} icon={Icon.payment} />
      <SubscriptionDetails sub={sub} renew={renew} refetch={refetch} />
    </DashboardPage>
  );
}

// Extracted so both the SUPER_ADMIN (selector) path and the normal library-admin
// path render the same subscription card + invoice history.
function SubscriptionDetails({
  sub,
  renew,
  refetch,
}: {
  sub: Subscription;
  renew: ReturnType<typeof useRenewMutation>;
  refetch: () => void;
}) {
  const t = useTranslations("BillingPanel");
  const now = new Date();
  const trialEnd = sub.trialEnd ? new Date(sub.trialEnd) : null;
  const endDate = new Date(sub.endDate);
  const trialDaysLeft = trialEnd ? daysBetween(now, trialEnd) : null;
  const lastInvoice = sub.invoices?.[0];

  const isPaid = (sub.planPrice ?? 0) > 0;

  // Pul oqimida native alert() taqiqlangan — natija sahifaning o'zida
  // ko'rsatiladi (muvaffaqiyat role="status", xato role="alert").
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const handlePay = async (provider: "PAYME" | "CLICK" | "BANK_TRANSFER") => {
    setNotice(null);
    try {
      const result = await renew.mutateAsync({ subscriptionId: sub.id, provider });
      if (result?.paymentUrl) {
        window.location.href = result.paymentUrl;
        return;
      }
      if (result?.invoice) {
        setNotice({
          kind: "success",
          text: t("notice.invoiceCreated"),
        });
        refetch();
        return;
      }
      setNotice({ kind: "success", text: t("notice.renewed") });
      refetch();
    } catch {
      setNotice({
        kind: "error",
        text: t("notice.payFailed"),
      });
    }
  };

  const getContract = () =>
    downloadPdf(`/subscriptions/${sub.id}/contract`, `shartnoma-${sub.id.slice(-8)}.pdf`)
      .catch(() => setNotice({ kind: "error", text: t("notice.contractFailed") }));
  const getInvoice = (invId: string) =>
    downloadPdf(`/invoices/${invId}/pdf`, `faktura-${invId.slice(-8)}.pdf`)
      .catch(() => setNotice({ kind: "error", text: t("notice.invoiceFailed") }));

  // To'lov tugmalari — uchchalasi bir xil neytral oq uslub (provayder nomi
  // qalin). Ilgari har biri o'z gradientida edi (cyan/indigo/gray) — bitta
  // provayder vizual "asosiy" ko'rinib qolar edi va gradientlar dizayn
  // tilidan tashqarida.
  const PAY_BTN =
    "px-5 py-2.5 rounded-lg border border-line-strong bg-white text-sm font-semibold " +
    "text-slate-800 hover:border-brand-400 hover:bg-surface-muted disabled:opacity-50";

  return (
    <>
      <Panel noReveal>
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="text-sm text-slate-500">{t("details.plan")}</div>
            <div className="text-2xl font-semibold">
              {sub.planLabel ?? label(PLAN_LABELS, sub.planType)}
            </div>
            <div className="text-sm text-slate-600 mt-0.5">
              {sub.planPrice && sub.planPrice > 0
                ? t("details.pricePerYear", { price: fmtNumber(sub.planPrice) })
                : t("details.freeBudget")}
            </div>
          </div>
          <StatusBadge status={sub.status} />
        </div>

        <hr className="my-4 border-line" />

        {sub.status === "TRIAL" && trialEnd && (
          <div className="mb-4">
            <div className="text-sm text-slate-500">{t("details.trialEnds")}</div>
            <div className="text-lg font-medium">
              {trialEnd.toLocaleDateString("uz-UZ")}
              {trialDaysLeft !== null && (
                <span className="text-sm text-slate-600 ml-2">
                  {t("details.daysLeft", { count: trialDaysLeft })}
                </span>
              )}
            </div>
          </div>
        )}

        {sub.status === "PENDING" && lastInvoice && (
          <div className="mb-4 p-3 bg-yellow-50 rounded">
            <div className="text-sm text-slate-700">
              {t("details.dueLabel")}{" "}
              <strong>
                {new Date(lastInvoice.dueDate).toLocaleDateString("uz-UZ")}
              </strong>
            </div>
            <div className="text-sm text-slate-700">
              {t("details.amountLabel")} <strong>{t("sum", { amount: fmtNumber(Number(lastInvoice.amount)) })}</strong>
            </div>
          </div>
        )}

        {sub.status === "ACTIVE" && (
          <div className="mb-4">
            <div className="text-sm text-slate-500">{t("details.nextDue")}</div>
            <div className="text-lg font-medium">
              {endDate.toLocaleDateString("uz-UZ")}
            </div>
          </div>
        )}

        {sub.status === "FROZEN" && (
          <div className="mb-4 p-3 bg-orange-50 rounded">
            <div className="text-sm font-medium text-orange-900">
              {t("details.frozen")}
            </div>
            {sub.frozenReason && (
              <div className="text-sm text-orange-800 mt-1">
                {t("details.frozenReason", { reason: sub.frozenReason })}
              </div>
            )}
            {sub.frozenAt && (
              <div className="text-xs text-orange-700 mt-1">
                {new Date(sub.frozenAt).toLocaleDateString("uz-UZ")}
              </div>
            )}
          </div>
        )}

        {sub.status === "DELETED" && (
          <div className="mb-4 p-3 bg-red-50 rounded text-red-900">
            <div className="text-sm font-medium">{t("details.deleted")}</div>
          </div>
        )}

        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
              notice.kind === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-green-200 bg-green-50 text-green-700"
            }`}
          >
            {notice.text}
          </div>
        )}

        {isPaid ? (
          <div className="mt-4 border-t border-line pt-4">
            <div className="text-sm font-medium text-slate-700 mb-2">{t("pay.method")}</div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handlePay("PAYME")}
                disabled={renew.isPending}
                className={PAY_BTN}
              >
                {t("pay.viaPayme")}
              </button>
              <button
                type="button"
                onClick={() => handlePay("CLICK")}
                disabled={renew.isPending}
                className={PAY_BTN}
              >
                {t("pay.viaClick")}
              </button>
              <button
                type="button"
                onClick={() => handlePay("BANK_TRANSFER")}
                disabled={renew.isPending}
                className={PAY_BTN}
              >
                {t("pay.bankTransfer")}
              </button>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                onClick={getContract}
                className="px-4 py-2 border border-line-strong rounded-lg text-sm font-medium text-slate-700 hover:bg-surface-muted"
              >
                <Icon.document aria-hidden="true" size={ICON_SIZE.sm} className="mr-1.5 inline" />{t("pay.downloadContract")}
              </button>
              {lastInvoice && (
                <button
                  type="button"
                  onClick={() => getInvoice(lastInvoice.id)}
                  className="px-4 py-2 border border-line-strong rounded-lg text-sm font-medium text-slate-700 hover:bg-surface-muted"
                >
                  <Icon.document aria-hidden="true" size={ICON_SIZE.sm} className="mr-1.5 inline" />{t("pay.downloadInvoice")}
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-2">
              {t("pay.hint")}
            </p>
          </div>
        ) : (
          <div className="mt-4 border-t border-line pt-4 text-sm text-slate-600">
            <Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="mr-1.5 inline text-green-600" />{t("pay.freeNoPay")}
          </div>
        )}
      </Panel>

      {sub.invoices && sub.invoices.length > 0 && (
        <Panel title={t("invoices.title")} icon={Icon.document} noReveal>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <th className="text-left p-3">{t("invoices.invoice")}</th>
                  <th className="text-left p-3">{t("invoices.amount")}</th>
                  <th className="text-left p-3">{t("invoices.due")}</th>
                  <th className="text-left p-3">{t("invoices.status")}</th>
                </tr>
              </thead>
              <tbody>
                {sub.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-line">
                    <td className="p-3 font-mono text-xs">
                      {inv.id.slice(-8).toUpperCase()}
                    </td>
                    <td className="p-3">
                      {t("sum", { amount: fmtNumber(Number(inv.amount)) })}
                    </td>
                    <td className="p-3">
                      {new Date(inv.dueDate).toLocaleDateString("uz-UZ")}
                    </td>
                    <td className="p-3">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
