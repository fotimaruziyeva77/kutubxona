"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { PLAN_LABELS, label } from "@/lib/labels.const";
import { PageHeader, Panel, StatCard } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { BookCover } from "@/components/books/BookCover";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

// ── API funksiyalar ──────────────────────────────────────────────────────────

// RBAC FIX: scope the dropdown to the caller's manageable libraries instead
// of GET /libraries (which is @Public and returns EVERY library). A
// KUTUBXONACHI / MUASSASA_ADMIN now sees only their own library.
async function getMyLibraries() {
  const { data } = await apiClient.get("/libraries/mine");
  return data as Library[];
}

async function getLibraryDetail(id: string) {
  const { data } = await apiClient.get(`/libraries/${id}`);
  return data as LibraryDetail;
}

async function getInventoryReport(libraryId: string) {
  const { data } = await apiClient.get(`/libraries/${libraryId}/inventory`);
  return data as InventoryReport;
}

async function getLibraryBooks(libraryId: string) {
  const { data } = await apiClient.get("/books", { params: { libraryId } });
  return data as Book[];
}

async function getPendingUsers() {
  const { data } = await apiClient.get("/admin/users/pending");
  return data as PendingUser[];
}

async function approveUser(id: string) {
  const { data } = await apiClient.patch(`/admin/users/${id}/approve`);
  return data;
}

async function rejectUser(id: string) {
  const { data } = await apiClient.patch(`/admin/users/${id}/reject`);
  return data;
}

// ── Typelar ──────────────────────────────────────────────────────────────────

interface Library {
  id: string;
  code: string;
  name: string;
  type: string;
  fundCount: number;
  status: string;
  address?: string;
  phone?: string;
  workHours?: string;
  subscriptions?: Subscription[];
}

interface LibraryDetail extends Library {
  books: Book[];
  subscriptions: Subscription[];
  readerCount?: number;
}

interface Subscription {
  id: string;
  planType: string;
  status: string;
  startDate: string;
  endDate: string;
  trialEnd?: string;
}

interface Book {
  id: string;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  totalCount: number;
  availableCount: number;
}

interface InventoryReport {
  declaredFundCount: number;
  dbBookCount: number;
  availableCount: number;
  borrowedCount: number;
  discrepancy: number;
  discrepancyPct: number;
  alert: boolean;
}

interface PendingUser {
  id: string;
  name: string;
  phone: string;
  type: string;
  status: string;
  createdAt: string;
  address?: { viloyatId: string; tumanId: string; street: string; house: string };
}

// ── Konstantlar ──────────────────────────────────────────────────────────────

// Enum kalitlari tarjima faylida (MuassasaPanel.types/userTypes/subStatus) —
// noma'lum qiymat kelsa xom kod ko'rsatiladi (t() ga berilmaydi).
const TYPE_KEYS = ["GOV", "SCH", "UNI", "ORG", "MAH"] as const;

const USER_TYPE_KEYS = [
  "CITIZEN",
  "STUDENT_SCHOOL",
  "STUDENT_UNIVERSITY",
  "GOVERNMENT_EMPLOYEE",
  "TEACHER"
] as const;

const SUB_STATUS_COLORS: Record<string, string> = {
  TRIAL: "bg-brand-100 text-brand-700",
  ACTIVE: "bg-green-100 text-green-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  FROZEN: "bg-surface-sunken text-slate-700",
  DELETED: "bg-red-100 text-red-700"
};

const SUB_STATUS_KEYS = ["TRIAL", "ACTIVE", "PENDING", "FROZEN", "DELETED"] as const;

// ── Asosiy komponent ─────────────────────────────────────────────────────────

export default function MuassasaPage() {
  const t = useTranslations("MuassasaPanel");
  const [selectedLibId, setSelectedLibId] = useState<string>("");
  const typeLabel = (type: string) =>
    (TYPE_KEYS as readonly string[]).includes(type) ? t(`types.${type}`) : type;

  const {
    data: libraries = [],
    isLoading: libsLoading,
    isError: libsError,
    refetch: refetchLibs,
  } = useQuery({
    queryKey: ["libraries-mine"],
    queryFn: getMyLibraries
  });

  // RBAC FIX: when the caller manages exactly ONE library (KUTUBXONACHI /
  // single-institution MUASSASA_ADMIN), auto-select it and hide the picker —
  // a librarian shouldn't choose between libraries.
  const singleLibrary = libraries.length === 1;
  useEffect(() => {
    if (singleLibrary && selectedLibId !== libraries[0].id) {
      setSelectedLibId(libraries[0].id);
    }
  }, [singleLibrary, libraries, selectedLibId]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.organization}
      />

      {/* Kutubxona tanlash — bitta kutubxona bo'lsa yashiriladi.
          Xato "biriktirilmagan" bilan ADASHTIRILMAYDI: so'rov yiqilsa
          retry tugmali xato paneli chiqadi. */}
      {libsError ? (
        <ErrorState
          title={t("libsError.title")}
          message={t("libsError.message")}
          onRetry={() => refetchLibs()}
        />
      ) : !singleLibrary && (
        <Panel noReveal>
          <label htmlFor="muassasa-lib" className="block text-sm font-semibold text-slate-700 mb-2">
            {t("selectLibrary")}
          </label>
          {libsLoading ? (
            <div className="text-slate-400 text-sm">{t("loading")}</div>
          ) : libraries.length === 0 ? (
            <div className="text-slate-400 text-sm">
              {t("noAssignedLibrary")}
            </div>
          ) : (
            <select
              id="muassasa-lib"
              value={selectedLibId}
              onChange={(e) => setSelectedLibId(e.target.value)}
              className="w-full max-w-md border border-line-strong rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">{t("selectPlaceholder")}</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name} ({typeLabel(lib.type)}) · {lib.code}
                </option>
              ))}
            </select>
          )}
        </Panel>
      )}

      {selectedLibId ? (
        <LibraryDashboard libraryId={selectedLibId} />
      ) : (
        // Tanlanmagan holat blank EMAS — nima qilish kerakligi aytiladi.
        !libsError && !singleLibrary && !libsLoading && libraries.length > 0 && (
          <div className="card-surface flex flex-col items-center rounded-xl py-14 text-center">
            <Icon.library aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} className="text-slate-300" />
            <p className="mt-3 font-medium text-slate-600">{t("emptyPrompt.title")}</p>
            <p className="mt-1 text-sm text-slate-400">{t("emptyPrompt.subtitle")}</p>
          </div>
        )
      )}
    </div>
  );
}

// ── Kutubxona paneli ─────────────────────────────────────────────────────────

function LibraryDashboard({ libraryId }: { libraryId: string }) {
  const qc = useQueryClient();
  const locale = useLocale();
  const t = useTranslations("MuassasaPanel");
  const typeLabel = (type: string) =>
    (TYPE_KEYS as readonly string[]).includes(type) ? t(`types.${type}`) : type;
  const userTypeLabel = (type: string) =>
    (USER_TYPE_KEYS as readonly string[]).includes(type) ? t(`userTypes.${type}`) : type;
  const subStatusLabel = (status: string) =>
    (SUB_STATUS_KEYS as readonly string[]).includes(status) ? t(`subStatus.${status}`) : status;

  const {
    data: lib,
    isLoading: libLoading,
    isError: libError,
    refetch: refetchLib,
  } = useQuery({
    queryKey: ["library-detail", libraryId],
    queryFn: () => getLibraryDetail(libraryId)
  });

  const { data: inventory, isError: inventoryError } = useQuery({
    queryKey: ["inventory", libraryId],
    queryFn: () => getInventoryReport(libraryId)
  });

  const {
    data: books = [],
    isLoading: booksLoading,
    isError: booksError,
    refetch: refetchBooks,
  } = useQuery({
    queryKey: ["books", libraryId],
    queryFn: () => getLibraryBooks(libraryId)
  });

  const { data: pendingUsers = [], isError: pendingError } = useQuery({
    queryKey: ["pending-users"],
    queryFn: getPendingUsers
  });

  const approve = useMutation({
    mutationFn: approveUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pending-users"] })
  });

  const reject = useMutation({
    mutationFn: rejectUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pending-users"] })
  });

  if (libLoading) {
    return <div className="text-center py-12 text-slate-400">{t("loading")}</div>;
  }
  // Xato blank ekran EMAS — sabab va qayta urinish ko'rsatiladi.
  if (libError || !lib) {
    return (
      <ErrorState
        title={t("libError.title")}
        message={t("libError.message")}
        onRetry={() => refetchLib()}
      />
    );
  }

  const subscription = lib.subscriptions?.[0];
  const availableBooks = books.filter((b) => b.availableCount > 0).length;
  // Manfiy bo'lib qolmasligi uchun clamp (ombor sonlari mos kelmasa).
  const borrowedBooks = Math.max(
    0,
    books.reduce((s, b) => s + (b.totalCount - b.availableCount), 0)
  );

  return (
    <div className="space-y-6">
      {/* Kutubxona ma'lumotlari */}
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">{lib.name}</h2>
            <p className="text-sm text-slate-500 mt-0.5 font-mono">{lib.code}</p>
            {lib.address && <p className="text-sm text-slate-600 mt-1">{lib.address}</p>}
            {lib.phone && <p className="text-sm text-slate-600">{lib.phone}</p>}
            {lib.workHours && <p className="text-sm text-slate-600">{lib.workHours}</p>}
          </div>
          <span className="px-3 py-1 bg-brand-600 text-white rounded-full text-sm font-medium">
            {typeLabel(lib.type)}
          </span>
        </div>
      </div>

      {/* Statistika kartalar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          label={t("stats.readers")}
          value={(lib.readerCount ?? 0).toLocaleString()}
          icon={Icon.readers}
          tone="blue"
        />
        <StatCard
          label={t("stats.totalBooks")}
          value={lib.fundCount.toLocaleString()}
          icon={Icon.book}
          tone="blue"
        />
        <StatCard
          label={t("stats.available")}
          value={availableBooks.toLocaleString()}
          icon={Icon.success}
          tone="green"
        />
        <StatCard
          label={t("stats.borrowed")}
          value={borrowedBooks.toLocaleString()}
          icon={Icon.refresh}
          tone="amber"
        />
        <StatCard
          label={t("stats.genres")}
          value={new Set(books.map((b) => b.genre)).size.toString()}
          icon={Icon.checklist}
          tone="violet"
        />
      </div>

      {/* Subscription holati */}
      <div className="card-surface rounded-2xl p-6">
        <h3 className="text-base font-bold text-slate-900 mb-4">{t("subscription.title")}</h3>
        {subscription ? (
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <div>
              <span
                className={`inline-block px-3 py-1.5 rounded-full text-sm font-semibold ${SUB_STATUS_COLORS[subscription.status] ?? "bg-surface-sunken text-slate-600"}`}
              >
                {subStatusLabel(subscription.status)}
              </span>
              <p className="text-sm text-slate-500 mt-2">
                {t("subscription.plan")} <span className="font-medium text-slate-700">{label(PLAN_LABELS, subscription.planType)}</span>
              </p>
            </div>
            <div className="text-sm text-slate-600 space-y-1 sm:ml-8">
              <p>{t("subscription.start")} <span className="font-medium">{new Date(subscription.startDate).toLocaleDateString("uz-UZ")}</span></p>
              <p>{t("subscription.end")} <span className="font-medium">{new Date(subscription.endDate).toLocaleDateString("uz-UZ")}</span></p>
              {subscription.trialEnd && (
                <p className="text-brand-600">
                  {t("subscription.trialEnds")} {new Date(subscription.trialEnd).toLocaleDateString("uz-UZ")}
                </p>
              )}
            </div>
            {subscription.status === "PENDING" && (
              <div className="flex items-start gap-2 sm:ml-auto max-w-xs rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
                <span>{t("subscription.pendingNote")}</span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">{t("subscription.notFound")}</p>
        )}
      </div>

      {/* Inventarizatsiya hisoboti — gradient/qattiq soya o'rniga tokenli
          holat ranglari. Xato ham ko'rsatiladi (ilgari jimgina yashirinardi). */}
      {inventoryError ? (
        <div className="rounded-xl border border-line bg-surface-muted px-5 py-4 text-sm text-slate-500">
          {t("inventory.loadError")}
        </div>
      ) : inventory && (
        <div className={`rounded-xl border p-6 ${inventory.alert ? "border-red-200 bg-red-50/60" : "border-green-200 bg-green-50/50"}`}>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={inventory.alert ? "text-red-600" : "text-green-600"}>
              {inventory.alert
                ? <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} />
                : <Icon.success aria-hidden="true" size={ICON_SIZE.sm} />}
            </span>
            <h3 className="text-base font-bold text-slate-900">{t("inventory.title")}</h3>
            {inventory.alert && (
              <span className="ml-auto px-2.5 py-0.5 bg-red-600 text-white rounded-full text-xs font-semibold">
                {t("inventory.alertBadge", { pct: inventory.discrepancyPct })}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: t("inventory.declared"),    value: inventory.declaredFundCount },
              { label: t("inventory.inSystem"),    value: inventory.dbBookCount },
              { label: t("inventory.available"),   value: inventory.availableCount },
              { label: t("inventory.borrowed"),    value: inventory.borrowedCount },
              { label: t("inventory.discrepancy"), value: `${inventory.discrepancy} (${inventory.discrepancyPct}%)`, alert: inventory.alert }
            ].map((row) => (
              <div key={row.label} className="bg-surface rounded-xl p-3 text-center shadow-sm">
                <p className="text-xs text-slate-500 mb-1">{row.label}</p>
                <p className={`font-extrabold tracking-tight text-lg ${row.alert ? "text-red-600" : "text-slate-900"}`}>
                  {row.value}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kitob fondi jadvali */}
      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-line">
          <h3 className="text-base font-bold text-slate-900">{t("fund.title")}</h3>
          <p className="text-sm text-slate-400 mt-0.5">{t("fund.summary", { titles: books.length, copies: lib.fundCount })}</p>
        </div>
        {booksLoading ? (
          <div className="text-center py-8 text-slate-400">{t("loading")}</div>
        ) : booksError ? (
          <div className="p-5">
            <ErrorState
              title={t("fund.errorTitle")}
              message={t("fund.errorMessage")}
              onRetry={() => refetchBooks()}
            />
          </div>
        ) : books.length === 0 ? (
          <div className="text-center py-8 text-slate-400">{t("fund.empty")}</div>
        ) : (
          <>
            {/* Matn jadvali o'rniga muqovali ro'yxat: BookCover muqovasiz
                kitobni ham tanib olinadigan qiladi — kutubxonachi o'z
                katalogini "ma'lumotlar bazasi" emas, kitob sifatida ko'radi. */}
            <div className="divide-y divide-line">
              {books.slice(0, 30).map((book) => (
                <div key={book.id} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-muted">
                  <BookCover size="sm" title={book.title} author={book.author} genre={book.genre} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-900">{book.title}</p>
                    <p className="truncate text-sm text-slate-500">{book.author} · {book.genre}</p>
                  </div>
                  <div className="hidden shrink-0 text-right text-sm sm:block">
                    <p className="text-slate-700">{t("fund.total", { count: book.totalCount })}</p>
                    <p className={book.availableCount === 0 ? "font-semibold text-red-600" : "font-semibold text-green-700"}>
                      {t("fund.available", { count: book.availableCount })}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    book.availableCount === 0
                      ? "bg-red-50 text-red-600"
                      : book.availableCount < 3
                      ? "bg-accent-50 text-accent-700"
                      : "bg-green-50 text-green-700"
                  }`}>
                    {book.availableCount === 0 ? t("fund.badgeNone") : book.availableCount < 3 ? t("fund.badgeLow") : t("fund.badgeAvailable")}
                  </span>
                </div>
              ))}
            </div>
            {books.length > 30 && (
              <p className="py-3 text-center text-xs text-slate-400">
                {t("fund.moreHidden", { count: books.length - 30 })}{" "}
                <Link href={`/${locale}/dashboard/books`} className="font-medium text-brand-600 hover:underline">
                  {t("fund.goToBooks")}
                </Link>
              </p>
            )}
          </>
        )}
      </div>

      {/* PENDING foydalanuvchilar. Panel DOIM ko'rinadi: ilgari bo'sh bo'lsa
          butunlay yashirinardi va admin "ariza yo'q"mi yoki "yuklanmadi"mi —
          farqlay olmasdi. */}
      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-line flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-900">{t("pending.title")}</h3>
          {pendingUsers.length > 0 && (
            <span className="bg-accent-100 text-accent-700 text-xs font-semibold px-2.5 py-1 rounded-full">
              {t("pending.countBadge", { count: pendingUsers.length })}
            </span>
          )}
        </div>
        {pendingError ? (
          <div className="px-6 py-5 text-sm text-slate-500">
            {t("pending.loadError")}
          </div>
        ) : pendingUsers.length === 0 ? (
          <div className="flex items-center gap-2 px-6 py-5 text-sm text-slate-500">
            <Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="text-green-500" />
            {t("pending.empty")}
          </div>
        ) : (
          <div className="divide-y divide-line">
            {pendingUsers.map((user) => (
              <div key={user.id} className="px-5 py-4 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-900">{user.name || t("pending.unknownName")}</p>
                    <span className="text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full">
                      {userTypeLabel(user.type)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500 mt-0.5">{user.phone}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {t("pending.appliedAt", { date: new Date(user.createdAt).toLocaleDateString("uz-UZ") })}
                  </p>
                </div>
                {/* min-h-11: 28px li tugmalar orasida noto'g'ri bosish arizani
                    rad etish o'rniga tasdiqlab yuborishi mumkin edi. */}
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={() => approve.mutate(user.id)}
                    disabled={approve.isPending}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-green-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-green-700 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Icon.check aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} />
                    {t("pending.approve")}
                  </button>
                  <button
                    onClick={() => reject.mutate(user.id)}
                    disabled={reject.isPending}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Icon.close aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} />
                    {t("pending.reject")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
