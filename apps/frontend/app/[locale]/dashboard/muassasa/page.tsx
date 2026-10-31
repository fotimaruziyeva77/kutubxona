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
import { updateLibrary } from "@/lib/api/libraries";
import { useAuthStore } from "@/store/auth.store";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";

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
  latitude?: number;
  longitude?: number;
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
  // Kutubxona ma'lumotlarini (manzil, telefon, ish vaqti) faqat MUASSASA_ADMIN
  // (o'z kutubxonasi — backend egalikni tekshiradi) va SUPER_ADMIN tahrirlaydi.
  const { user } = useAuthStore();
  const canEdit = user?.role === "SUPER_ADMIN" || user?.role === "MUASSASA_ADMIN";
  const [editing, setEditing] = useState(false);
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
      {/* Kutubxona ma'lumotlari — manzil/telefon/ish vaqti HAR DOIM ko'rsatiladi
          (kiritilmagan bo'lsa shunday deyiladi), chunki ular ommaviy sahifada
          kitobxonga ko'rinadi va telefonga bron SMS'i boradi. */}
      <div className="card-surface rounded-2xl p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-900">{lib.name}</h2>
            <p className="text-sm text-slate-500 mt-0.5 font-mono">{lib.code}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canEdit && !editing && (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Icon.edit aria-hidden="true" size={ICON_SIZE.xs} />
                {t("editInfo.button")}
              </Button>
            )}
            <span className="px-3 py-1 bg-brand-600 text-white rounded-full text-sm font-medium">
              {typeLabel(lib.type)}
            </span>
          </div>
        </div>
        {editing ? (
          <LibraryInfoForm lib={lib} onDone={() => setEditing(false)} />
        ) : (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {(
              [
                { key: "address", icon: Icon.map, value: lib.address },
                { key: "phone", icon: Icon.phone, value: lib.phone },
                { key: "workHours", icon: Icon.pending, value: lib.workHours },
              ] as const
            ).map(({ key, icon: RowIcon, value }) => (
              <div key={key} className="flex items-start gap-2 rounded-xl bg-surface-muted px-3 py-2.5">
                <RowIcon aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0 text-slate-400" />
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {t(`editInfo.${key}`)}
                  </dt>
                  <dd className={value ? "text-sm text-slate-800" : "text-sm italic text-slate-400"}>
                    {value || t("editInfo.notSet")}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        )}
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

// ── Kutubxona ma'lumotlari formasi ───────────────────────────────────────────

type LibraryInfoValues = {
  name: string;
  address: string;
  phone: string;
  workHours: string;
  latitude: string;
  longitude: string;
};

/**
 * Manzil / telefon / ish vaqti / koordinata tahriri (PUT /libraries/:id).
 * Bo'sh qoldirilgan matn maydoni "" sifatida yuboriladi (tozalash), bo'sh
 * koordinata esa YUBORILMAYDI (avvalgi qiymat qoladi) — noto'g'ri 0,0
 * nuqta yozilib qolmasligi uchun.
 */
function LibraryInfoForm({ lib, onDone }: { lib: LibraryDetail; onDone: () => void }) {
  const t = useTranslations("MuassasaPanel");
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<LibraryInfoValues>({
    name: lib.name,
    address: lib.address ?? "",
    phone: lib.phone ?? "",
    workHours: lib.workHours ?? "",
    latitude: lib.latitude != null ? String(lib.latitude) : "",
    longitude: lib.longitude != null ? String(lib.longitude) : "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof LibraryInfoValues, string>>>({});
  const set = (k: keyof LibraryInfoValues, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // undefined — kiritilmagan, null — xato, son — yaroqli
  const parseCoord = (raw: string, max: number): number | null | undefined => {
    const s = raw.trim();
    if (s === "") return undefined;
    const n = Number(s.split(",").join("."));
    return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
  };

  const validate = (): { ok: boolean; lat?: number; lon?: number } => {
    const e: Partial<Record<keyof LibraryInfoValues, string>> = {};
    if (form.name.trim().length < 2) e.name = t("editInfo.errName");
    const phoneDigits = form.phone
      .split(" ").join("")
      .split("-").join("")
      .split("(").join("")
      .split(")").join("");
    if (phoneDigits !== "" && !/^[+]?[0-9]{9,13}$/.test(phoneDigits)) e.phone = t("editInfo.errPhone");
    const lat = parseCoord(form.latitude, 90);
    const lon = parseCoord(form.longitude, 180);
    if (lat === null) e.latitude = t("editInfo.errCoord");
    if (lon === null) e.longitude = t("editInfo.errCoord");
    if ((lat === undefined) !== (lon === undefined)) {
      e.longitude = e.longitude ?? t("editInfo.errCoordPair");
    }
    setErrors(e);
    return { ok: Object.keys(e).length === 0, lat: lat ?? undefined, lon: lon ?? undefined };
  };

  const save = useMutation({
    mutationFn: (coords: { lat?: number; lon?: number }) =>
      updateLibrary(lib.id, {
        name: form.name.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        workHours: form.workHours.trim(),
        ...(coords.lat !== undefined ? { latitude: coords.lat } : {}),
        ...(coords.lon !== undefined ? { longitude: coords.lon } : {}),
      }),
    onSuccess: () => {
      toast.success(t("editInfo.saved"));
      qc.invalidateQueries({ queryKey: ["library-detail", lib.id] });
      qc.invalidateQueries({ queryKey: ["libraries-mine"] });
      onDone();
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response
        ?.data?.message;
      toast.error(t("editInfo.saveError"), Array.isArray(msg) ? msg.join(", ") : msg);
    },
  });

  return (
    <form
      className="mt-4 space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const v = validate();
        if (v.ok) save.mutate({ lat: v.lat, lon: v.lon });
      }}
    >
      <p className="text-sm text-slate-500">{t("editInfo.hint")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="lib-name" label={t("editInfo.name")} error={errors.name} required className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
        </FormField>
        <FormField id="lib-address" label={t("editInfo.address")} className="sm:col-span-2">
          <Input
            value={form.address}
            onChange={(e) => set("address", e.target.value)}
            maxLength={255}
            placeholder={t("editInfo.addressPlaceholder")}
          />
        </FormField>
        <FormField id="lib-phone" label={t("editInfo.phone")} error={errors.phone}>
          <Input
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            maxLength={32}
            placeholder={t("editInfo.phonePlaceholder")}
          />
        </FormField>
        <FormField id="lib-hours" label={t("editInfo.workHours")}>
          <Input
            value={form.workHours}
            onChange={(e) => set("workHours", e.target.value)}
            maxLength={64}
            placeholder={t("editInfo.workHoursPlaceholder")}
          />
        </FormField>
        <FormField id="lib-lat" label={t("editInfo.latitude")} error={errors.latitude} hint={t("editInfo.coordsHint")}>
          <Input inputMode="decimal" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} />
        </FormField>
        <FormField id="lib-lon" label={t("editInfo.longitude")} error={errors.longitude}>
          <Input inputMode="decimal" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} />
        </FormField>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          {t("editInfo.cancel")}
        </Button>
        <Button type="submit" isLoading={save.isPending}>
          {t("editInfo.save")}
        </Button>
      </div>
    </form>
  );
}
