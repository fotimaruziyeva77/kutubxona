"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { RankMedal } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton, SkeletonCardList } from "@/components/ui/skeleton";
import { ConfirmModal } from "@/components/ui/confirm-modal";

// ── Tipler ────────────────────────────────────────────────────────────────────

type DonateStats = {
  totalCollected: number;
  totalSpent: number;
  remaining: number;
  donorCount: number;
};

type Donor = {
  id: string;
  amount: number;
  purpose: string;
  donorName: string | null;
  isPublic: boolean;
  createdAt: string;
};

type TopDonor = {
  userId: string;
  name: string;
  total: number;
  count: number;
};

type SpendingItem = {
  id: string;
  amount: number;
  description: string;
  createdAt: string;
  libraryName?: string;
};

// Maqsad kalitlari — yorliqlar tarjima faylidan (DonatePage.purpose.*)
// olinadi; ikonka bilan birga radio ro'yxatida ham, donatchilar ro'yxatidagi
// oddiy matnda ham ishlatiladi.
const PURPOSE_KEYS = ["LIBRARY_BOOKS", "SCHOOL_BOOKS", "GENERAL"] as const;

const PURPOSE_ICONS: Record<string, LucideIcon> = {
  LIBRARY_BOOKS: Icon.library,
  SCHOOL_BOOKS: Icon.school,
  GENERAL: Icon.donate,
};

// Noma'lum (eski/serverdan kelgan boshqa) purpose qiymati xom kalit bo'lib
// chiqmasin — faqat bilingan kalitlar tarjima qilinadi.
function usePurposeLabel() {
  const t = useTranslations("DonatePage");
  return (p: string) =>
    (PURPOSE_KEYS as readonly string[]).includes(p) ? t(`purpose.${p}`) : p;
}

// Yorliqlar qisqa — 375px ekranda uchta tugma bir qatorga sig'adi
// (tarjimalari DonatePage.tabs.* da).
const TABS = [
  { key: "donate", icon: Icon.payment },
  { key: "donors", icon: Icon.readers },
  { key: "spending", icon: Icon.checklist },
] as const;

// Intl.NumberFormat("uz-UZ") EMAS: Node (SSR) va brauzer ICU'lari uz-UZ
// uchun har xil ajratgich beradi ("5 000" vs "5,000") — bu hydration
// nomuvofiqligini keltirib chiqarardi (server HTML klientda almashtirilar
// edi). Qo'lda, deterministik minglik ajratish — chiziqli bo'lmaydigan
// bo'shliq (NBSP) bilan.
const fmt = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchStats(): Promise<DonateStats> {
  const res = await apiClient("/donate/stats");
  if (!res.ok) throw new Error("Statistika yuklanmadi");
  return res.json();
}

async function fetchDonors(): Promise<Donor[]> {
  const res = await apiClient("/donate/donors?limit=50");
  if (!res.ok) throw new Error("Donatchilar yuklanmadi");
  return res.json();
}

async function fetchTopDonors(): Promise<TopDonor[]> {
  const res = await apiClient("/donate/top-donors?limit=20");
  if (!res.ok) throw new Error("Top donatchilar yuklanmadi");
  return res.json();
}

async function fetchSpending(): Promise<SpendingItem[]> {
  const res = await apiClient("/donate/spending?limit=20");
  // Xato bo'sh ro'yxat sifatida yutilmasin — aks holda so'rov yiqilganda
  // "Sarflash tarixi hali yo'q" degan yolg'on bo'sh holat chiqardi.
  if (!res.ok) throw new Error("Sarflash tarixi yuklanmadi");
  return res.json();
}

async function initiateDonate(
  data: {
    amount: number;
    purpose: string;
    method: "PAYME" | "CLICK";
    donorName?: string;
    isPublic: boolean;
  },
  // Fallback xabar formada ko'rinadi — tarjima qilingan holda uzatiladi.
  fallbackMsg: string,
) {
  const res = await apiClient("/donate/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? fallbackMsg);
  }
  return res.json() as Promise<{ paymentUrl: string; paymentId: string }>;
}

// ── Asosiy komponent ──────────────────────────────────────────────────────────

export default function DonatePage() {
  const locale = useLocale();
  const t = useTranslations("DonatePage");
  const [tab, setTab] = useState<"donate" | "donors" | "spending">("donate");

  const statsQ = useQuery({
    queryKey: ["donate-stats"],
    queryFn: fetchStats,
    staleTime: 60_000,
  });
  const stats = statsQ.data;

  const donorsQ = useQuery({
    queryKey: ["donate-donors"],
    queryFn: fetchDonors,
    enabled: tab === "donors",
    staleTime: 120_000,
  });

  const topDonorsQ = useQuery({
    queryKey: ["donate-top"],
    queryFn: fetchTopDonors,
    enabled: tab === "donors",
    staleTime: 120_000,
  });

  const spendingQ = useQuery({
    queryKey: ["donate-spending"],
    queryFn: fetchSpending,
    enabled: tab === "spending",
    staleTime: 120_000,
  });

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Header — brend siyoh sirt (butun mahsulot ko'k; yashil gradient
          dizayn tilidan tashqarida edi). */}
      <div className="ink-surface text-white py-10 px-4">
        <div className="max-w-3xl mx-auto">
          <Link href={`/${locale}`} className="text-brand-100 hover:text-white text-sm">
            {t("backHome")}
          </Link>
          <h1 className="flex items-center gap-2 text-3xl font-bold mt-3 mb-1">
            <Icon.donate aria-hidden="true" size={ICON_SIZE.lg} />
            {t("title")}
          </h1>
          <p className="text-brand-100 text-sm">
            {t("subtitle")}
          </p>

          {statsQ.isLoading && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[74px] rounded-xl bg-white/10" />
              ))}
            </div>
          )}

          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
              <DonateStat label={t("statCollected")} value={t("sumAmount", { amount: fmt(stats.totalCollected) })} />
              <DonateStat label={t("statSpent")} value={t("sumAmount", { amount: fmt(stats.totalSpent) })} />
              <DonateStat label={t("statRemaining")} value={t("sumAmount", { amount: fmt(stats.remaining) })} />
              <DonateStat label={t("statDonors")} value={t("donorCountValue", { count: String(stats.donorCount) })} />
            </div>
          )}

          {stats && stats.totalCollected > 0 && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-brand-100 mb-1">
                <span>{t("statSpent")}</span>
                <span>{((stats.totalSpent / stats.totalCollected) * 100).toFixed(0)}%</span>
              </div>
              <div className="w-full bg-white/15 rounded-full h-2">
                <div
                  className="bg-white rounded-full h-2 transition-all"
                  style={{ width: `${Math.min((stats.totalSpent / stats.totalCollected) * 100, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6">
        {statsQ.isError && (
          <div className="mb-6">
            <ErrorState
              title={t("statsErrorTitle")}
              message={t("statsErrorMessage")}
              onRetry={() => statsQ.refetch()}
              isRetrying={statsQ.isRefetching}
            />
          </div>
        )}

        {/* Tabs — flex-wrap: kichik ekranda toshib ketmaydi. */}
        <div className="flex flex-wrap gap-1.5 mb-6">
          {TABS.map(({ key, icon: TabIcon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                tab === key
                  ? "bg-brand-600 text-white shadow-sm"
                  : "bg-white text-slate-600 hover:bg-surface-sunken border border-line"
              }`}
            >
              <TabIcon aria-hidden="true" size={ICON_SIZE.sm} />
              {t(`tabs.${key}`)}
            </button>
          ))}
        </div>

        {tab === "donate" && <DonateForm />}

        {tab === "donors" && (
          donorsQ.isLoading || topDonorsQ.isLoading ? (
            <SkeletonCardList count={5} />
          ) : donorsQ.isError || topDonorsQ.isError ? (
            <ErrorState
              title={t("donorsErrorTitle")}
              message={t("donorsErrorMessage")}
              onRetry={() => {
                if (donorsQ.isError) donorsQ.refetch();
                if (topDonorsQ.isError) topDonorsQ.refetch();
              }}
              isRetrying={donorsQ.isRefetching || topDonorsQ.isRefetching}
            />
          ) : (
            <DonorsList donors={donorsQ.data ?? []} topDonors={topDonorsQ.data ?? []} />
          )
        )}

        {tab === "spending" && (
          spendingQ.isLoading ? (
            <SkeletonCardList count={5} />
          ) : spendingQ.isError ? (
            <ErrorState
              title={t("spendingErrorTitle")}
              message={t("spendingErrorMessage")}
              onRetry={() => spendingQ.refetch()}
              isRetrying={spendingQ.isRefetching}
            />
          ) : (
            <SpendingList items={spendingQ.data ?? []} />
          )
        )}
      </div>
    </div>
  );
}

// ── Donat formasi ─────────────────────────────────────────────────────────────

function DonateForm() {
  const t = useTranslations("DonatePage");
  const purposeLabel = usePurposeLabel();
  const [amount, setAmount] = useState("");
  const [amountFocused, setAmountFocused] = useState(false);
  const [purpose, setPurpose] = useState("GENERAL");
  const [method, setMethod] = useState<"PAYME" | "CLICK">("PAYME");
  const [donorName, setDonorName] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const PRESETS = [5000, 10000, 25000, 50000, 100000];

  const mutation = useMutation({
    mutationFn: (data: Parameters<typeof initiateDonate>[0]) =>
      initiateDonate(data, t("genericError")),
    onSuccess: (data) => {
      window.location.href = data.paymentUrl;
    },
    onError: (err: Error) => {
      setConfirmOpen(false);
      setError(err.message);
    },
  });

  // Submit avval tasdiq modalini ochadi — to'lov sahifasiga yo'naltirish
  // qaytarilmas qadam, shuning uchun miqdor + maqsad ko'rsatilib
  // tasdiqlangachgina amalga oshadi.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const amt = Number(amount);
    if (!amt || amt < 1000) { setError(t("minAmount", { amount: fmt(1000) })); return; }
    if (amt > 100_000_000) { setError(t("maxAmount", { amount: fmt(100_000_000) })); return; }
    setConfirmOpen(true);
  }

  const confirmDonate = () => {
    mutation.mutate({
      amount: Number(amount),
      purpose,
      method,
      donorName: donorName || undefined,
      isPublic,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Summa */}
      <div className="card-surface rounded-2xl p-5">
        <h3 className="block text-sm font-semibold text-slate-700 mb-3">{t("amountTitle")}</h3>
        <div className="flex flex-wrap gap-2 mb-3">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setAmount(String(p))}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                amount === String(p)
                  ? "bg-brand-600 text-white border-brand-600"
                  : "bg-white text-slate-700 border-line hover:border-brand-400"
              }`}
            >
              {fmt(p)}
            </button>
          ))}
        </div>
        <label htmlFor="donate-amount" className="sr-only">{t("amountOtherLabel")}</label>
        {/* Yozayotganda xom raqam, blur'da fmt() bilan formatlangan ko'rinish. */}
        <input
          id="donate-amount"
          type="text"
          inputMode="numeric"
          placeholder={t("amountPlaceholder")}
          value={amountFocused ? amount : amount ? fmt(Number(amount)) : ""}
          onFocus={() => setAmountFocused(true)}
          onBlur={() => setAmountFocused(false)}
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 9))}
          className="w-full border border-line rounded-xl px-4 py-2.5 text-lg font-bold focus:outline-none focus:border-brand-500"
        />
      </div>

      {/* Maqsad */}
      <div className="card-surface rounded-2xl p-5">
        <h3 className="block text-sm font-semibold text-slate-700 mb-3">{t("purposeTitle")}</h3>
        <div className="space-y-2">
          {PURPOSE_KEYS.map((key) => {
            const PurposeIcon = PURPOSE_ICONS[key] ?? Icon.donate;
            return (
              <label key={key} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="purpose"
                  value={key}
                  checked={purpose === key}
                  onChange={() => setPurpose(key)}
                  className="accent-brand-600"
                />
                <PurposeIcon aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />
                <span className="text-slate-700">{purposeLabel(key)}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* To'lov usuli */}
      <div className="card-surface rounded-2xl p-5">
        <h3 className="block text-sm font-semibold text-slate-700 mb-3">{t("methodTitle")}</h3>
        <div className="grid grid-cols-2 gap-3">
          {(["PAYME", "CLICK"] as const).map((m) => {
            const MethodIcon = m === "PAYME" ? Icon.payment : Icon.instantPayment;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`inline-flex items-center justify-center gap-2 py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${
                  method === m
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-line text-slate-600 hover:border-line-strong"
                }`}
              >
                <MethodIcon aria-hidden="true" size={ICON_SIZE.md} />
                {m === "PAYME" ? "Payme" : "Click"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Donatchi nomi */}
      <div className="card-surface rounded-2xl p-5">
        <h3 className="block text-sm font-semibold text-slate-700 mb-3">{t("donorInfoTitle")}</h3>
        <label htmlFor="donate-name" className="sr-only">{t("nameLabel")}</label>
        <input
          id="donate-name"
          type="text"
          placeholder={t("namePlaceholder")}
          value={donorName}
          onChange={(e) => setDonorName(e.target.value)}
          maxLength={100}
          className="w-full border border-line rounded-xl px-4 py-2.5 focus:outline-none focus:border-brand-500 mb-3"
        />
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="accent-brand-600 w-4 h-4"
          />
          <span className="text-sm text-slate-600">{t("showPublic")}</span>
        </label>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={mutation.isPending || !amount}
        className="flex w-full items-center justify-center gap-2 py-3.5 bg-brand-600 text-white font-bold rounded-2xl hover:bg-brand-700 disabled:opacity-50 transition-colors text-lg"
      >
        {mutation.isPending ? (
          t("redirecting")
        ) : (
          <>
            <Icon.donate aria-hidden="true" size={ICON_SIZE.md} />
            {amount ? t("donateAmountButton", { amount: fmt(Number(amount)) }) : t("donateButton")}
          </>
        )}
      </button>

      <p className="text-xs text-center text-slate-400">
        {t("securityNote")}
      </p>

      <ConfirmModal
        open={confirmOpen}
        title={t("confirmTitle")}
        description={t("confirmDescription", {
          amount: fmt(Number(amount) || 0),
          purpose: purposeLabel(purpose),
          method: method === "PAYME" ? "Payme" : "Click",
        })}
        confirmLabel={t("confirmButton")}
        isPending={mutation.isPending}
        onConfirm={confirmDonate}
        onCancel={() => { if (!mutation.isPending) setConfirmOpen(false); }}
      />
    </form>
  );
}

// ── Donatchilar ro'yxati ───────────────────────────────────────────────────────

function DonorsList({ donors, topDonors }: { donors: Donor[]; topDonors: TopDonor[] }) {
  const t = useTranslations("DonatePage");
  const purposeLabel = usePurposeLabel();
  const [view, setView] = useState<"recent" | "top">("recent");

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setView("recent")}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === "recent" ? "bg-brand-100 text-brand-700" : "text-slate-500 hover:bg-surface-sunken"
          }`}
        >
          {t("recentDonations")}
        </button>
        <button
          onClick={() => setView("top")}
          className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === "top" ? "bg-brand-100 text-brand-700" : "text-slate-500 hover:bg-surface-sunken"
          }`}
        >
          <Icon.trophy aria-hidden="true" size={ICON_SIZE.sm} />
          {t("topDonors")}
        </button>
      </div>

      {view === "recent" ? (
        <div className="space-y-2">
          {donors.length === 0 ? (
            <EmptyState icon={Icon.donate} text={t("noDonations")} />
          ) : (
            donors.map((d) => (
              <div key={d.id} className="bg-white rounded-2xl border border-line p-4 flex items-center gap-4">
                {/* Ochiq donat — yurak; anonim donat — qalqon (shaxsi yashirilgan). */}
                <div className="w-10 h-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
                  {d.isPublic ? (
                    <Icon.donate aria-hidden="true" size={ICON_SIZE.md} />
                  ) : (
                    <Icon.shield aria-hidden="true" size={ICON_SIZE.md} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900">
                    {d.isPublic && d.donorName ? d.donorName : t("anonymousDonor")}
                  </p>
                  <p className="text-xs text-slate-500">{purposeLabel(d.purpose)}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-brand-700">{t("sumAmount", { amount: fmt(d.amount) })}</p>
                  <p className="text-xs text-slate-400">{new Date(d.createdAt).toLocaleDateString("uz-UZ")}</p>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {topDonors.length === 0 ? (
            <EmptyState icon={Icon.trophy} text={t("noTopDonors")} />
          ) : (
            topDonors.map((d, i) => (
              <div key={d.userId} className="bg-white rounded-2xl border border-line p-4 flex items-center gap-4">
                <RankMedal rank={i + 1} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-900">{d.name}</p>
                  <p className="text-xs text-slate-500">{t("donationTimes", { count: String(d.count) })}</p>
                </div>
                <p className="font-bold text-brand-700 shrink-0">{t("sumAmount", { amount: fmt(d.total) })}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Sarflash tarixi ───────────────────────────────────────────────────────────

function SpendingList({ items }: { items: SpendingItem[] }) {
  const t = useTranslations("DonatePage");
  if (items.length === 0) {
    return <EmptyState icon={Icon.checklist} text={t("noSpending")} />;
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="bg-white rounded-2xl border border-line p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-100 text-brand-700 flex items-center justify-center shrink-0">
            <Icon.package aria-hidden="true" size={ICON_SIZE.md} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-900">{item.description}</p>
            {item.libraryName && (
              <p className="flex items-center gap-1 text-xs text-slate-500">
                <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />
                {item.libraryName}
              </p>
            )}
            <p className="text-xs text-slate-400">{new Date(item.createdAt).toLocaleDateString("uz-UZ")}</p>
          </div>
          <p className="font-bold text-brand-700 shrink-0">−{t("sumAmount", { amount: fmt(item.amount) })}</p>
        </div>
      ))}
    </div>
  );
}

// ── Yordamchi komponentlar ────────────────────────────────────────────────────

/** Siyoh hero ichidagi statistika kartasi. Nomi ataylab DonateStat —
 *  dashboard/ui dagi umumiy StatCard bilan to'qnashmasin. */
function DonateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/10 rounded-xl px-4 py-3">
      <p className="text-brand-100 text-xs">{label}</p>
      <p className="font-bold text-base leading-tight mt-0.5">{value}</p>
    </div>
  );
}

function EmptyState({ icon: EmptyIcon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="text-center py-16 card-surface rounded-2xl">
      <EmptyIcon aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2 text-slate-300" />
      <p className="text-slate-400">{text}</p>
    </div>
  );
}
