"use client";

import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  getBooks,
  getInventoryReport,
  getMyLibraries,
  downloadBookTemplate,
  createBook,
  updateBook,
  deleteBook,
  lookupIsbn,
  importBooksExcel,
  getBookImportStatus,
  type Book,
  type Library,
  type BookImportStatusResult,
  type CreateBookInput
} from "@/lib/api/libraries";
import { getViloyatlar, getTumanlar } from "@/lib/api/geo";
import { useAuthStore } from "@/store/auth.store";
import { cn } from "@/lib/utils";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { BookCover } from "@/components/books/BookCover";
import { BookRow } from "@/components/books/BookCard";
import { Button } from "@/components/ui/button";
import { Input, FormField } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SkeletonTable } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DashboardPage, PageHeader, StatCard, StatGrid } from "@/components/dashboard/ui";

// Kutubxona turi yorlig'i — super admin kaskadida kutubxonani aniqroq ko'rsatish.
// Tarjimalar BooksPanel.libTypes da; noma'lum tur xom kod bilan qoladi.
const LIB_TYPE_KEYS = ["GOV", "SCH", "UNI", "ORG", "MAH"] as const;

// Janr taklifl/ari (datalist) — qidiruv sahifasidagi filtr lug'ati bilan bir xil
// + fondda ko'p uchraydiganlar. Erkin matn: istalgan janr yozish mumkin.
const GENRE_SUGGESTIONS = [
  "Roman", "Ilmiy", "Bolalar adabiyoti", "Tarix", "Texnika", "Falsafa", "Epik",
  "She'riyat", "Sarguzasht", "Drama", "Darslik", "Diniy", "Biografiya", "Detektiv",
  "Fantastika", "Satira"
];

const LANG_OPTIONS = [
  { code: "uz", key: "form.langUz" },
  { code: "ru", key: "form.langRu" },
  { code: "en", key: "form.langEn" },
  { code: "kaa", key: "form.langKaa" }
] as const;

/** Qatorga yetkazilgan xato (axios) ichidan status va backend xabarini oladi. */
function apiError(err: unknown): { status?: number; message?: string } {
  const e = err as { response?: { status?: number; data?: { message?: string | string[] } } };
  const raw = e?.response?.data?.message;
  return {
    status: e?.response?.status,
    message: Array.isArray(raw) ? raw.join(", ") : raw
  };
}

/**
 * ISBN-10/13 nazorat raqami. Chiziqcha/bo'shliq e'tiborga olinmaydi.
 * Noto'g'ri bo'lsa ham saqlashga YO'L QO'YILADI (eski/nostandart nashrlar) —
 * faqat ogohlantirish.
 */
function isbnChecksumOk(raw: string): boolean {
  const s = raw.replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, ch, i) => acc + (ch === "X" ? 10 : Number(ch)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  return false;
}

// Muqova rasmini brauzerda kichraytirib (maks 360px), JPEG data-URL'ga
// aylantiradi. Natija ~80KB ostida bo'ladi — JSON body limitiga sig'adi va
// `coverUrl` (Postgres text) ustuniga to'g'ridan-to'g'ri saqlanadi: MinIO shart
// emas, link muddatsiz ishlaydi. Shaffof PNG'lar uchun oq fon quyiladi.
function fileToCoverDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Faylni o'qib bo'lmadi"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Rasmni yuklab bo'lmadi"));
      img.onload = () => {
        const MAX = 360;
        let width = img.width;
        let height = img.height;
        if (width > MAX || height > MAX) {
          const scale = Math.min(MAX / width, MAX / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("canvas mavjud emas"));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        let q = 0.8;
        let dataUrl = canvas.toDataURL("image/jpeg", q);
        // Body limitiga (100KB) sig'ishi uchun ~80KB gacha siqamiz.
        while (dataUrl.length > 80_000 && q > 0.35) {
          q -= 0.1;
          dataUrl = canvas.toDataURL("image/jpeg", q);
        }
        resolve(dataUrl);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export default function BooksPage() {
  const t = useTranslations("BooksPanel");
  const qc = useQueryClient();
  const toast = useToast();
  const role = useAuthStore((s) => s.user?.role);
  // DELETE /books/:id — faqat MUASSASA_ADMIN va SUPER_ADMIN (backend @Roles).
  // Kutubxonachiga tugma ko'rsatilmaydi: avval ko'rinardi va 403 bilan tugardi.
  const canDelete = role === "SUPER_ADMIN" || role === "MUASSASA_ADMIN";
  // Til kodi → yorliq. DB'da kodlar aralash ("uz", "uz-Latn", "uz-Cyrl", "ru" —
  // seed va forma turlicha yozgan); prefiks bo'yicha moslanadi, noma'lum — kodning o'zi.
  const langLabel = (code?: string | null) => {
    if (!code) return "—";
    const base = code.toLowerCase().split("-")[0];
    const opt = LANG_OPTIONS.find((l) => l.code === base);
    return opt ? t(opt.key) : code;
  };

  const [selectedLib, setSelectedLib] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editBook, setEditBook] = useState<Book | null>(null);
  // ConfirmModal uchun — qaysi kitob o'chirilayotgani nomi bilan ko'rsatiladi.
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  // alert() o'rniga sahifa ichidagi yumshoq ogohlantirish.
  const [actionNotice, setActionNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BOOK-01 (Plan 02-04): async import — jobId + polled status replace
  // the legacy synchronous { created, errors } response.
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<BookImportStatusResult | null>(null);

  // ── Fond ichida qidiruv va filtrlar ───────────────────────────────────────
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [lang, setLang] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);
  const hasFilters = Boolean(debouncedQuery || genre || lang || onlyAvailable);
  const resetFilters = () => {
    setQuery("");
    setDebouncedQuery("");
    setGenre("");
    setLang("");
    setOnlyAvailable(false);
  };

  // RBAC FIX: caller-scoped libraries (not the @Public GET /libraries which
  // returns every library). A KUTUBXONACHI now sees only their own library.
  const { data: libraries = [] } = useQuery({
    queryKey: ["libraries-mine"],
    queryFn: getMyLibraries
  });

  // When the caller manages exactly ONE library, auto-select it and scope the
  // book list to it — a librarian must NOT be able to pick "Barcha
  // kutubxonalar" and see other libraries' books.
  const singleLibrary = libraries.length === 1;
  useEffect(() => {
    if (singleLibrary && selectedLib !== libraries[0].id) {
      setSelectedLib(libraries[0].id);
    }
  }, [singleLibrary, libraries, selectedLib]);

  // For single-library users force the scope to their library even before the
  // effect settles, so the very first /books fetch is never unscoped (which
  // would briefly leak the global catalog).
  const effectiveLib = singleLibrary ? libraries[0].id : selectedLib;

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  // Kutubxona, sahifa hajmi yoki filtr o'zgarsa — 1-sahifaga qaytamiz.
  useEffect(() => { setPage(1); }, [effectiveLib, limit, debouncedQuery, genre, lang, onlyAvailable]);

  const list = useQuery({
    queryKey: ["books", effectiveLib, debouncedQuery, genre, lang, onlyAvailable, page, limit],
    queryFn: () =>
      getBooks({
        libraryId: effectiveLib || undefined,
        q: debouncedQuery,
        genre,
        lang,
        available: onlyAvailable,
        page,
        limit
      }),
    // Sahifa/filtr almashganda eski ro'yxat turadi (skelet miltillamaydi).
    placeholderData: keepPreviousData
  });
  const listData = list.data;
  const books = useMemo<Book[]>(() => listData?.data ?? [], [listData]);
  const total = listData?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  // Inventarizatsiya — HAQIQIY raqamlar (nusxalar, mavjud, kitobxonlarda,
  // xatlovdagi fond). Faqat bitta kutubxona tanlanganda; ruxsat: super/tuman/
  // muassasa admin va kutubxonachi (GET /libraries/:id/inventory).
  const inventory = useQuery({
    queryKey: ["library-inventory", effectiveLib],
    queryFn: () => getInventoryReport(effectiveLib),
    enabled: !!effectiveLib,
    staleTime: 60_000
  });

  const invalidateFund = () => {
    qc.invalidateQueries({ queryKey: ["books"] });
    qc.invalidateQueries({ queryKey: ["library-inventory"] });
  };

  const del = useMutation({
    mutationFn: (id: string) => deleteBook(id),
    onSuccess: () => {
      invalidateFund();
      setDeleteTarget(null);
      toast.success(t("deleteModal.deleted"));
    }
  });
  // 403 — rol yetarli emas; 409 — backend sababi (kitobxonlardagi nusxa yoki
  // berish/qaytarish tarixi); qolgani — umumiy xato.
  const deleteError = (() => {
    if (!del.error) return "";
    const { status, message } = apiError(del.error);
    if (status === 403) return t("deleteModal.forbidden");
    return message || t("deleteModal.failed");
  })();

  const importExcel = useMutation({
    mutationFn: (file: File) => importBooksExcel(file, effectiveLib),
    onSuccess: (data) => {
      setImportJobId(data.jobId);
      setImportStatus({ status: "queued", processed: 0, total: 0, errors: [], progress: 0 });
    }
  });

  // Poll the import status every 2s while a job is in flight. Stops on
  // terminal states (completed | failed) and invalidates the books list
  // so the table reflects the newly inserted rows.
  useEffect(() => {
    if (!importJobId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const s = await getBookImportStatus(importJobId);
        if (cancelled) return;
        setImportStatus(s);
        if (s.status === "completed" || s.status === "failed" || s.status === "unknown") {
          qc.invalidateQueries({ queryKey: ["books"] });
          qc.invalidateQueries({ queryKey: ["library-inventory"] });
          return; // stop polling
        }
        setTimeout(tick, 2000);
      } catch {
        // transient errors — keep polling
        if (!cancelled) setTimeout(tick, 2000);
      }
    };
    tick();

    return () => {
      cancelled = true;
    };
  }, [importJobId, qc]);

  // Janr datalist: lug'at + hozirgi sahifadagi janrlar (dublikatsiz).
  const genreOptions = useMemo(() => {
    const set = new Set<string>(GENRE_SUGGESTIONS);
    for (const b of books) if (b.genre) set.add(b.genre);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [books]);

  // Mavjudlik: raqam + mini shkala + holat matni. Rang: 0 → qizil,
  // qisman → sariq, hammasi joyida → yashil.
  const renderAvailability = (book: Book) => {
    const available = book.availableCount ?? 0;
    const totalCount = book.totalCount ?? 0;
    const out = Math.max(0, totalCount - available);
    const pct = totalCount > 0 ? Math.round((available / totalCount) * 100) : 0;
    const tone = available === 0 ? "red" : out > 0 ? "amber" : "green";
    return (
      <div className="min-w-[7.5rem]">
        <div className="flex items-baseline gap-1 text-sm tabular-nums">
          <span
            className={cn(
              "font-semibold",
              tone === "red" ? "text-red-600" : tone === "amber" ? "text-accent-700" : "text-green-700"
            )}
          >
            {available}
          </span>
          <span className="text-slate-400">/ {totalCount}</span>
        </div>
        <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              tone === "red" ? "bg-red-400" : tone === "amber" ? "bg-amber-400" : "bg-green-500"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {available === 0
            ? t("availability.none")
            : out > 0
              ? t("availability.out", { count: out })
              : t("availability.all")}
        </p>
      </div>
    );
  };

  // Amallar tugmalari — jadvalda ham, mobil kartada ham bir xil.
  const rowActions = (book: Book) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setEditBook(book)}
        className="gap-1.5 text-brand-700 hover:bg-brand-50"
      >
        <Icon.edit aria-hidden="true" size={ICON_SIZE.xs} />
        {t("edit")}
      </Button>
      {canDelete && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            del.reset();
            setDeleteTarget(book);
          }}
          className="gap-1.5 text-red-600 hover:bg-red-50"
        >
          <Icon.delete aria-hidden="true" size={ICON_SIZE.xs} />
          {t("delete")}
        </Button>
      )}
    </div>
  );

  const listIsEmpty = !list.isLoading && !list.isError && books.length === 0;
  const inv = inventory.data;

  return (
    <DashboardPage>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.book}
        action={
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && effectiveLib) {
                  setActionNotice("");
                  importExcel.mutate(f);
                } else if (f && !effectiveLib) {
                  setActionNotice(t("selectLibraryFirst"));
                }
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                downloadBookTemplate().catch(() => setActionNotice(t("templateError")))
              }
              className="gap-1.5"
            >
              <Icon.download aria-hidden="true" size={ICON_SIZE.sm} />
              {t("excelTemplate")}
            </Button>
            <Button
              type="button"
              variant="outline"
              isLoading={importExcel.isPending}
              onClick={() => {
                if (!effectiveLib) {
                  setActionNotice(t("selectLibraryFirst"));
                  return;
                }
                setActionNotice("");
                fileInputRef.current?.click();
              }}
              className="gap-1.5"
            >
              <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
              {t("excelImport")}
            </Button>
            <Button type="button" onClick={() => setShowAdd(true)} className="gap-1.5">
              <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
              {t("addBook")}
            </Button>
          </div>
        }
      />

      {actionNotice && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-accent-700"
        >
          <span className="flex items-center gap-2">
            <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} />
            {actionNotice}
          </span>
          <button
            type="button"
            onClick={() => setActionNotice("")}
            aria-label={t("dismissNotice")}
            className="rounded-md p-1 text-accent-600 hover:bg-amber-100"
          >
            <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
          </button>
        </div>
      )}

      {/* Inventarizatsiya — real raqamlar (bitta kutubxona tanlanganda) */}
      {effectiveLib && inv && (
        <StatGrid cols={4}>
          <StatCard icon={Icon.book} label={t("summary.copies")} value={inv.dbBookCount} tone="blue" />
          <StatCard icon={Icon.check} label={t("summary.available")} value={inv.availableCount} tone="green" />
          <StatCard icon={Icon.readers} label={t("summary.borrowed")} value={inv.borrowedCount} tone="amber" />
          <StatCard
            icon={Icon.checklist}
            label={t("summary.declared")}
            value={inv.declaredFundCount}
            tone={inv.alert ? "rose" : "gray"}
            sub={
              inv.discrepancy > 0
                ? t("summary.discrepancy", { count: inv.discrepancy, pct: inv.discrepancyPct })
                : t("summary.inSync")
            }
          />
        </StatGrid>
      )}

      {/* Qidiruv + filtrlar */}
      <div className="card-surface rounded-xl p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Icon.search
              aria-hidden="true"
              size={ICON_SIZE.sm}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <Input
              id="books-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("toolbar.searchPlaceholder")}
              aria-label={t("toolbar.searchLabel")}
              autoComplete="off"
              className="pl-9 pr-9"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("toolbar.clearSearch")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 transition-colors hover:bg-surface-muted hover:text-slate-600"
              >
                <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Kutubxona filter — bitta kutubxona bo'lsa yashiriladi (librarian
                "Barcha kutubxonalar" orqali boshqa kutubxonalarni ko'ra olmaydi) */}
            {!singleLibrary && (
              <>
                <label htmlFor="books-lib-filter" className="sr-only">
                  {t("filterLabel")}
                </label>
                <select
                  id="books-lib-filter"
                  value={selectedLib}
                  onChange={(e) => setSelectedLib(e.target.value)}
                  className="h-10 rounded-md border border-line-strong bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">{t("allLibraries")}</option>
                  {(libraries as Library[]).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </>
            )}

            <label htmlFor="books-genre" className="sr-only">{t("toolbar.genre")}</label>
            <Input
              id="books-genre"
              list="books-genre-options"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              placeholder={t("toolbar.anyGenre")}
              autoComplete="off"
              className="w-44"
            />
            <datalist id="books-genre-options">
              {genreOptions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>

            <label htmlFor="books-lang" className="sr-only">{t("toolbar.lang")}</label>
            <select
              id="books-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="h-10 rounded-md border border-line-strong bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">{t("toolbar.anyLang")}</option>
              {LANG_OPTIONS.map((l) => (
                <option key={l.code} value={l.code}>{t(l.key)}</option>
              ))}
            </select>

            <label className="inline-flex h-10 cursor-pointer select-none items-center gap-2 rounded-md border border-line-strong bg-white px-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(e) => setOnlyAvailable(e.target.checked)}
                className="h-4 w-4 rounded border-line-strong accent-brand-600"
              />
              {t("toolbar.onlyAvailable")}
            </label>

            {hasFilters && (
              <Button type="button" variant="ghost" size="sm" onClick={resetFilters} className="gap-1">
                <Icon.close aria-hidden="true" size={ICON_SIZE.xs} />
                {t("toolbar.resetFilters")}
              </Button>
            )}
          </div>
        </div>

        {list.data && (
          <p className="mt-2 text-xs text-slate-500" aria-live="polite">
            {hasFilters ? t("toolbar.found", { count: total }) : t("toolbar.totalCount", { count: total })}
            {singleLibrary && (
              <>
                {" · "}
                {t("currentLibrary")} <span className="font-medium text-slate-700">{libraries[0].name}</span>
              </>
            )}
          </p>
        )}
      </div>

      {/* Import progress — BOOK-01 (Plan 02-04): polled BullMQ job state */}
      {importStatus && importJobId && (
        <div className={`p-4 rounded-lg text-sm border ${
          importStatus.status === "failed"
            ? "bg-red-50 border-red-200"
            : importStatus.status === "completed"
              ? (importStatus.errors.length > 0 ? "bg-yellow-50 border-yellow-200" : "bg-green-50 border-green-200")
              : importStatus.status === "unknown"
                ? "bg-surface-muted border-line"
                : "bg-blue-50 border-brand-200"
        }`}>
          <div className="font-semibold mb-2">
            {importStatus.status === "completed" && t("import.completed")}
            {importStatus.status === "failed" && t("import.failed")}
            {importStatus.status === "unknown" && t("import.unknown")}
            {!["completed", "failed", "unknown"].includes(importStatus.status) && t("import.running")}
          </div>

          {(importStatus.status === "active" || importStatus.status === "queued" || importStatus.status === "waiting") && (
            <div className="mb-2">
              <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div
                  className="h-2 bg-brand-600 transition-all"
                  style={{ width: `${Math.max(2, importStatus.progress)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-slate-600">
                {t("import.progressRow", {
                  processed: importStatus.processed,
                  total: importStatus.total || "?",
                  progress: importStatus.progress
                })}
              </div>
            </div>
          )}

          {importStatus.status === "completed" && (
            <div className="flex items-center gap-1.5"><Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="text-green-600" />{t("import.added", { count: importStatus.processed })}</div>
          )}
          {importStatus.status === "completed" && (importStatus.skipped ?? 0) > 0 && (
            <div className="mt-1 flex items-center gap-1.5 text-slate-600"><Icon.info aria-hidden="true" size={ICON_SIZE.sm} />{t("import.skipped", { count: importStatus.skipped ?? 0 })}</div>
          )}

          {importStatus.errors.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center gap-1.5 font-medium text-red-700"><Icon.error aria-hidden="true" size={ICON_SIZE.sm} />{t("import.errorsCount", { count: importStatus.errors.length })}</div>
              {importStatus.errors.slice(0, 5).map((e, idx) => (
                <div key={`${e.row}-${idx}`} className="text-red-600 text-xs">{t("import.errorRow", { row: e.row, reason: e.reason })}</div>
              ))}
            </div>
          )}

          {(importStatus.status === "completed" || importStatus.status === "failed" || importStatus.status === "unknown") && (
            <button
              onClick={() => { setImportJobId(null); setImportStatus(null); }}
              className="mt-2 text-slate-500 text-xs underline"
            >
              {t("import.close")}
            </button>
          )}
        </div>
      )}

      {/* Kitoblar ro'yxati */}
      {list.isLoading ? (
        <SkeletonTable rows={6} columns={5} />
      ) : list.isError ? (
        <ErrorState
          title={t("loadError.title")}
          message={t("loadError.message")}
          onRetry={() => list.refetch()}
          isRetrying={list.isRefetching}
        />
      ) : listIsEmpty ? (
        hasFilters ? (
          <EmptyState
            icon={Icon.search}
            title={t("noResults.title")}
            description={t("noResults.description")}
            action={
              <Button type="button" variant="outline" onClick={resetFilters}>
                {t("noResults.reset")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Icon.bookClosed}
            title={t("emptyFund.title")}
            description={t("emptyFund.description")}
            action={
              <Button type="button" onClick={() => setShowAdd(true)} className="gap-1.5">
                <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
                {t("emptyFund.add")}
              </Button>
            }
          />
        )
      ) : (
        <div
          className={cn(
            "transition-opacity",
            list.isFetching && list.isPlaceholderData ? "opacity-60" : "opacity-100"
          )}
        >
          {/* Telefon (sm dan past): karta-ro'yxat — jadval siqilib o'qib bo'lmas edi. */}
          <div className="space-y-3 sm:hidden">
            {books.map((book) => (
              <BookRow
                key={book.id}
                book={book}
                meta={
                  <span className="text-xs tabular-nums">
                    <span className={book.availableCount === 0 ? "font-medium text-red-600" : "font-medium text-green-700"}>
                      {book.availableCount}
                    </span>
                    <span className="text-slate-400">/{book.totalCount}</span>
                  </span>
                }
                action={rowActions(book)}
              />
            ))}
          </div>

          {/* Jadval — sm va undan keng ekranlarda */}
          <div className="card-surface hidden overflow-hidden rounded-xl sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-muted text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">{t("table.book")}</th>
                    <th scope="col" className="hidden px-4 py-2.5 md:table-cell">{t("table.genre")}</th>
                    <th scope="col" className="hidden px-4 py-2.5 lg:table-cell">{t("table.lang")}</th>
                    <th scope="col" className="hidden px-4 py-2.5 lg:table-cell">{t("table.year")}</th>
                    <th scope="col" className="px-4 py-2.5">
                      {t("table.copies")}{" "}
                      <span className="font-normal normal-case tracking-normal text-slate-400">
                        ({t("table.copiesHint")})
                      </span>
                    </th>
                    <th scope="col" className="whitespace-nowrap px-4 py-2.5 text-right">{t("table.actions")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {books.map((book) => (
                    <tr key={book.id} className="transition-colors hover:bg-surface-muted/60">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <BookCover
                            size="xs"
                            title={book.title}
                            author={book.author}
                            genre={book.genre}
                            coverUrl={book.coverUrl}
                          />
                          <div className="min-w-0 max-w-[22rem]">
                            <p className="truncate font-medium text-slate-900" title={book.title}>{book.title}</p>
                            <p className="truncate text-xs text-slate-500" title={book.author}>{book.author}</p>
                            <p className="font-mono text-[11px] text-slate-400">{book.isbn}</p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-2.5 md:table-cell">
                        {book.genre ? (
                          <span className="inline-flex max-w-[10rem] truncate rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs font-medium text-slate-700">
                            {book.genre}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="hidden px-4 py-2.5 text-xs text-slate-600 lg:table-cell">{langLabel(book.lang)}</td>
                      <td className="hidden px-4 py-2.5 tabular-nums text-slate-600 lg:table-cell">{book.year || "—"}</td>
                      <td className="px-4 py-2.5">{renderAvailability(book)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">{rowActions(book)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Pagination + sahifa hajmi (20/50/100) — jami son backend'dan */}
      {!list.isLoading && !list.isError && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <label htmlFor="books-page-size">{t("pageSize")}</label>
            <select
              id="books-page-size"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-9 rounded-md border border-line-strong bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>{t("pageSizeUnit")}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-slate-500">
              {t("pagination.range", {
                from: (page - 1) * limit + 1,
                to: Math.min(page * limit, total),
                total
              })}
              <span className="mx-2 text-slate-300">·</span>
              {t("pagination.pageOf", { page, pages })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label={t("prevPage")}
              className="gap-1"
            >
              <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
              {t("prev")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              aria-label={t("nextPage")}
              className="gap-1"
            >
              {t("next")}
              <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
            </Button>
          </div>
        </div>
      )}

      {/* O'chirishni tasdiqlash — kitob kartasi, kitobxonlardagi nusxa ogohlantirishi, xato */}
      <ConfirmModal
        open={!!deleteTarget}
        title={deleteTarget ? t("deleteModal.titleNamed", { title: deleteTarget.title }) : t("deleteModal.title")}
        description={t("deleteModal.description")}
        confirmLabel={t("deleteModal.confirm")}
        variant="destructive"
        isPending={del.isPending}
        disabled={!!deleteTarget && deleteTarget.availableCount < deleteTarget.totalCount}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        onCancel={() => {
          setDeleteTarget(null);
          del.reset();
        }}
      >
        {deleteTarget && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted/60 p-3">
              <BookCover
                size="xs"
                title={deleteTarget.title}
                author={deleteTarget.author}
                genre={deleteTarget.genre}
                coverUrl={deleteTarget.coverUrl}
              />
              <div className="min-w-0 text-sm">
                <p className="truncate font-medium text-slate-900">{deleteTarget.title}</p>
                <p className="truncate text-xs text-slate-500">
                  {t("deleteModal.meta", { author: deleteTarget.author, isbn: deleteTarget.isbn })}
                </p>
                <p className="text-xs text-slate-500">
                  {t("deleteModal.copiesRow", {
                    available: deleteTarget.availableCount,
                    total: deleteTarget.totalCount
                  })}
                </p>
              </div>
            </div>
            {deleteTarget.availableCount < deleteTarget.totalCount && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-accent-700">
                <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
                {t("deleteModal.borrowedWarning", {
                  count: deleteTarget.totalCount - deleteTarget.availableCount
                })}
              </div>
            )}
            {deleteError && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <Icon.error aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
                {deleteError}
              </div>
            )}
          </div>
        )}
      </ConfirmModal>

      {(showAdd || editBook) && (
        <BookFormModal
          book={editBook}
          libraryId={effectiveLib || libraries[0]?.id || ""}
          libraries={libraries}
          onClose={() => { setShowAdd(false); setEditBook(null); }}
          onSaved={() => { invalidateFund(); setShowAdd(false); setEditBook(null); }}
        />
      )}
    </DashboardPage>
  );
}

/**
 * FormField ichidagi <select>: FormField bolaga `id`, `aria-describedby` va
 * (xato bo'lsa) `hasError` beradi — xom <select> `hasError` ni DOM'ga
 * uzatib React ogohlantirishi chiqarardi. Shu o'ram uni uslubga aylantiradi.
 */
function NativeSelect({
  hasError,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { hasError?: boolean }) {
  return (
    <select
      aria-invalid={hasError || undefined}
      className={cn(
        "flex h-10 w-full rounded-md border bg-white px-3 text-sm transition-colors",
        "focus:border-transparent focus:outline-none focus:ring-2",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-slate-400",
        hasError
          ? "border-red-400 focus:ring-red-500"
          : "border-line-strong hover:border-gray-400 focus:ring-brand-500",
        className
      )}
      {...props}
    />
  );
}

/** Forma bo'limi — kichik sarlavha + maydonlar. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</legend>
      {children}
    </fieldset>
  );
}

function BookFormModal({
  book,
  libraryId,
  libraries,
  onClose,
  onSaved
}: {
  book: Book | null;
  libraryId: string;
  libraries: Library[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Super admin barcha kutubxonalarni ko'radi → Viloyat→Tuman→Kutubxona
  // kaskadi orqali tanlaydi. Muassasa admin/kutubxonachi esa faqat o'z
  // (filial) kutubxonalarini ko'radi — kaskad shart emas.
  const t = useTranslations("BooksPanel");
  const toast = useToast();
  const currentUser = useAuthStore((s) => s.user);
  const isSuper = currentUser?.role === "SUPER_ADMIN";
  const libTypeLabel = (type: string) =>
    (LIB_TYPE_KEYS as readonly string[]).includes(type) ? t(`libTypes.${type}`) : type;

  // Raqamli maydonlar MATN sifatida saqlanadi: bo'sh = noma'lum (0 emas).
  // Avval "Yil: 0" / "Sahifalar: 0" default'lari ko'rinardi.
  const [form, setForm] = useState({
    isbn: book?.isbn ?? "",
    title: book?.title ?? "",
    author: book?.author ?? "",
    genre: book?.genre ?? "",
    lang: book?.lang ?? "uz",
    pages: book?.pages ? String(book.pages) : "",
    year: book?.year ? String(book.year) : "",
    coverUrl: book?.coverUrl ?? "",
    description: book?.description ?? "",
    totalCount: String(book?.totalCount ?? 1),
    // Super admin add rejimida bo'sh boshlanadi (kaskad orqali tanlanadi);
    // muassasa admin uchun o'z kutubxonasi oldindan tanlangan bo'ladi.
    libraryId: book?.libraryId ?? (isSuper ? "" : libraryId)
  });
  const [submitted, setSubmitted] = useState(false);
  const [isbnLoading, setIsbnLoading] = useState(false);
  // Yumshoq maslahat (topilmadi → qo'lda to'ldirish) — qizil xato emas.
  const [isbnHint, setIsbnHint] = useState("");
  // Topildi xabari (yashil) — lokal baza yoki Open Library.
  const [isbnOk, setIsbnOk] = useState("");
  // Muqova rasm yuklash holati.
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState("");

  // ── Super admin kaskad filtri (faqat add rejimida) ─────────────────────────
  const [filterViloyat, setFilterViloyat] = useState("");
  const [filterTuman, setFilterTuman] = useState("");

  const { data: viloyatList = [] } = useQuery({
    queryKey: ["geo-viloyatlar"],
    queryFn: getViloyatlar,
    enabled: isSuper && !book,
    staleTime: 3_600_000
  });
  const { data: tumanList = [] } = useQuery({
    queryKey: ["geo-tumanlar", filterViloyat],
    queryFn: () => getTumanlar(filterViloyat),
    enabled: isSuper && !book && !!filterViloyat && filterViloyat !== "__none__",
    staleTime: 3_600_000
  });

  // Viloyat/tuman variantlari KUTUBXONALAR ro'yxatidan olinadi (faqat
  // kutubxonasi bor hududlar ko'rinadi); nomlari geo'dan bog'lanadi.
  const viloyatNameById = new Map(viloyatList.map((v) => [v.id, v.name]));
  const tumanNameById = new Map(tumanList.map((tm) => [tm.id, tm.name]));
  const viloyatOptions = [
    ...Array.from(
      new Set(libraries.map((l) => l.viloyatId).filter(Boolean) as string[])
    )
      .map((id) => ({ id, name: viloyatNameById.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Hududsiz (viloyatId yo'q) kutubxonalar ham tanlanadigan bo'lsin —
    // shunda super admin BARCHA kutubxonalarga kitob qo'sha oladi.
    ...(libraries.some((l) => !l.viloyatId)
      ? [{ id: "__none__", name: t("form.noRegion") }]
      : [])
  ];
  const tumanOptions = Array.from(
    new Set(
      libraries
        .filter((l) => l.viloyatId === filterViloyat)
        .map((l) => l.tumanId)
        .filter(Boolean) as string[]
    )
  )
    .map((id) => ({ id, name: tumanNameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const filteredLibs = libraries.filter((l) => {
    const vMatch =
      filterViloyat === "__none__"
        ? !l.viloyatId
        : !filterViloyat || l.viloyatId === filterViloyat;
    const tMatch = !filterTuman || l.tumanId === filterTuman;
    return vMatch && tMatch;
  });
  // Qo'shishdan keyingi natija: dublikat nusxa xabari yoki saqlash xatosi.
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  // ── Validatsiya ────────────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();
  const borrowed = book ? Math.max(0, book.totalCount - book.availableCount) : 0;
  const minCopies = Math.max(1, borrowed);
  const yearNum = form.year.trim() ? Number(form.year) : undefined;
  const copiesNum = Number(form.totalCount);
  const errors = {
    isbn: submitted && !form.isbn.trim() ? t("form.isbnTooShort") : undefined,
    title: submitted && !form.title.trim() ? t("form.titleRequired") : undefined,
    author: submitted && !form.author.trim() ? t("form.authorRequired") : undefined,
    year:
      yearNum !== undefined && (!Number.isInteger(yearNum) || yearNum < 1400 || yearNum > currentYear + 1)
        ? t("form.yearInvalid", { min: 1400, max: currentYear + 1 })
        : undefined,
    copies:
      !Number.isInteger(copiesNum) || copiesNum < minCopies
        ? borrowed > 0
          ? t("form.copiesMin", { count: borrowed })
          : t("form.copiesHint")
        : undefined,
    library: submitted && !form.libraryId ? t("form.libraryRequired") : undefined
  };
  const isbnWarning = form.isbn.trim() && !isbnChecksumOk(form.isbn) ? t("form.isbnChecksum") : "";
  const requiredOk =
    !!form.isbn.trim() && !!form.title.trim() && !!form.author.trim() && !!form.libraryId;
  const canSubmit = requiredOk && !errors.year && !errors.copies;

  const save = useMutation({
    mutationFn: () => {
      const payload: CreateBookInput = {
        isbn: form.isbn.trim(),
        title: form.title.trim(),
        author: form.author.trim(),
        genre: form.genre.trim(),
        lang: form.lang,
        // 0 = noma'lum (jadvalda "—"); backend sxemasida son majburiy.
        pages: form.pages.trim() ? Number(form.pages) : 0,
        year: yearNum ?? 0,
        coverUrl: form.coverUrl,
        description: form.description,
        totalCount: Math.max(minCopies, copiesNum || 1),
        libraryId: form.libraryId
      };
      return book ? updateBook(book.id, payload) : createBook(payload);
    },
    onSuccess: (result) => {
      // Qo'shishda dublikat bo'lsa (shu kutubxonada bor edi — nusxa qo'shildi)
      // aniq xabarni ko'rsatamiz va modalni ochiq qoldiramiz; aks holda yopamiz.
      if (!book && result && (result as { duplicate?: boolean }).duplicate) {
        setSaveError("");
        setSaveMessage(
          (result as { message?: string }).message ??
            t("form.duplicateFallback")
        );
        return;
      }
      toast.success(book ? t("toast.updated") : t("toast.created"));
      onSaved();
    },
    onError: (err) => {
      setSaveMessage("");
      setSaveError(apiError(err).message || t("form.saveError"));
    }
  });

  const submit = () => {
    setSubmitted(true);
    if (!canSubmit || save.isPending) return;
    save.mutate();
  };

  const handleIsbnLookup = async () => {
    setIsbnOk("");
    // Yumshoq format tekshiruvi.
    if (form.isbn.replace(/[-\s]/g, "").length < 10) {
      setIsbnHint(t("form.isbnTooShort"));
      return;
    }
    setIsbnLoading(true);
    setIsbnHint("");
    try {
      // Backend AVVAL lokal bazani tekshiradi (avval qo'shilgan kitob), keyin
      // Open Library — shuning uchun mavjud ISBN bo'lsa ma'lumot avtomat keladi.
      const data = await lookupIsbn(form.isbn);
      if (data) {
        setForm((f) => ({
          ...f,
          title: data.title ?? f.title,
          author: data.author ?? f.author,
          pages: data.pages ? String(data.pages) : f.pages,
          year: data.year ? String(data.year) : f.year,
          genre: data.genre ?? f.genre,
          lang: data.lang ?? f.lang,
          coverUrl: data.coverUrl ?? f.coverUrl,
          description: data.description ?? f.description
        }));
        setIsbnOk(
          data.source === "local"
            ? t("form.isbnFoundLocal")
            : t("form.isbnFoundOpenLib")
        );
      } else {
        // 200 + null: ma'lumot topilmadi — yumshoq maslahat, xato emas.
        setIsbnHint(t("form.isbnNotFound"));
      }
    } catch {
      // Tarmoq/server xatosi ham bloklovchi emas — qo'lda to'ldirish mumkin.
      setIsbnHint(t("form.isbnNotFound"));
    } finally {
      setIsbnLoading(false);
    }
  };

  // Muqova rasmini tanlash → kichraytirish → data-URL'ni form.coverUrl ga.
  const handleCoverFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setCoverError(t("form.coverOnlyImage"));
      return;
    }
    setCoverError("");
    setCoverUploading(true);
    try {
      const dataUrl = await fileToCoverDataUrl(file);
      setForm((f) => ({ ...f, coverUrl: dataUrl }));
    } catch {
      setCoverError(t("form.coverProcessError"));
    } finally {
      setCoverUploading(false);
    }
  };

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal
      open
      title={book ? t("form.editTitle") : t("form.newTitle")}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <span className="self-center text-xs text-slate-500 sm:mr-auto">{t("form.requiredNote")}</span>
          <Button type="button" variant="outline" onClick={onClose}>
            {saveMessage ? t("form.close") : t("form.cancel")}
          </Button>
          {saveMessage ? (
            // Dublikat: nusxa qo'shildi — ro'yxatni yangilab modalni yopamiz.
            <Button type="button" onClick={onSaved}>{t("form.done")}</Button>
          ) : (
            <Button
              type="submit"
              form="book-form"
              isLoading={save.isPending}
              disabled={submitted && !canSubmit}
            >
              {save.isPending ? t("form.saving") : t("form.save")}
            </Button>
          )}
        </>
      }
    >
      <form
        id="book-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-6"
      >
        {/* ── ISBN + avtoto'ldirish ─────────────────────────────────────────── */}
        <Section title={t("form.sectionIsbn")}>
          <div className="flex items-start gap-2">
            <FormField
              id="book-isbn"
              label={t("form.isbnLabel")}
              className="flex-1"
              error={errors.isbn}
              hint={isbnOk || isbnWarning || isbnHint || t("form.isbnHint")}
            >
              <Input
                value={form.isbn}
                onChange={(e) => set("isbn", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleIsbnLookup();
                  }
                }}
                placeholder={t("form.isbnPlaceholder")}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
              />
            </FormField>
            <Button
              type="button"
              variant="secondary"
              onClick={handleIsbnLookup}
              isLoading={isbnLoading}
              className="mt-6 shrink-0 gap-1.5"
            >
              <Icon.search aria-hidden="true" size={ICON_SIZE.sm} />
              {t("form.isbnSearch")}
            </Button>
          </div>
          {isbnOk && (
            <p className="-mt-1 flex items-center gap-1.5 text-xs text-green-700">
              <Icon.check aria-hidden="true" size={ICON_SIZE.xs} />
              {isbnOk}
            </p>
          )}
        </Section>

        {/* ── Asosiy ma'lumot ───────────────────────────────────────────────── */}
        <Section title={t("form.sectionMain")}>
          <FormField id="book-title" label={t("form.nameLabel")} error={errors.title}>
            <Input value={form.title} onChange={(e) => set("title", e.target.value)} autoComplete="off" />
          </FormField>
          <FormField id="book-author" label={t("form.authorLabel")} error={errors.author}>
            <Input value={form.author} onChange={(e) => set("author", e.target.value)} autoComplete="off" />
          </FormField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField id="book-genre" label={t("form.genreLabel")}>
              <Input
                list="book-genre-options"
                value={form.genre}
                onChange={(e) => set("genre", e.target.value)}
                placeholder={t("form.genrePlaceholder")}
                autoComplete="off"
              />
            </FormField>
            <datalist id="book-genre-options">
              {GENRE_SUGGESTIONS.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <FormField id="book-lang" label={t("form.langLabel")}>
              <NativeSelect value={form.lang} onChange={(e) => set("lang", e.target.value)}>
                {LANG_OPTIONS.map((l) => (
                  <option key={l.code} value={l.code}>{t(l.key)}</option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
        </Section>

        {/* ── Nashr va nusxalar ─────────────────────────────────────────────── */}
        <Section title={t("form.sectionPublish")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField id="book-year" label={t("form.yearLabel")} error={errors.year}>
              <Input
                type="number"
                inputMode="numeric"
                min={1400}
                max={currentYear + 1}
                value={form.year}
                onChange={(e) => set("year", e.target.value)}
                placeholder={t("form.yearPlaceholder")}
              />
            </FormField>
            <FormField id="book-pages" label={t("form.pagesLabel")}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.pages}
                onChange={(e) => set("pages", e.target.value)}
                placeholder={t("form.pagesPlaceholder")}
              />
            </FormField>
            <FormField
              id="book-copies"
              label={t("form.copiesLabel")}
              error={errors.copies}
              hint={borrowed > 0 ? t("form.copiesMin", { count: borrowed }) : t("form.copiesHint")}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={minCopies}
                value={form.totalCount}
                onChange={(e) => set("totalCount", e.target.value)}
              />
            </FormField>
          </div>
        </Section>

        {/* ── Muqova va tavsif ──────────────────────────────────────────────── */}
        <Section title={t("form.sectionCover")}>
          <div>
            <p className="mb-1 block text-sm font-medium text-slate-700">{t("form.coverLabel")}</p>
            <div className="flex items-center gap-4 rounded-xl border border-dashed border-line-strong bg-surface-muted/50 p-3">
              {/* Rasm bo'lmasa BookCover deterministik gradient muqova chizadi. */}
              <BookCover
                size="sm"
                title={form.title || t("form.newTitle")}
                author={form.author}
                genre={form.genre}
                coverUrl={form.coverUrl || null}
              />
              <div className="flex min-w-0 flex-col items-start gap-1.5">
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    void handleCoverFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => coverInputRef.current?.click()}
                    isLoading={coverUploading}
                    className="gap-1.5"
                  >
                    <Icon.upload aria-hidden="true" size={ICON_SIZE.xs} />
                    {coverUploading ? t("form.coverUploading") : form.coverUrl ? t("form.coverReplace") : t("form.coverUpload")}
                  </Button>
                  {form.coverUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => set("coverUrl", "")}
                      className="text-red-600 hover:bg-red-50"
                    >
                      {t("form.coverRemove")}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-slate-500">{t("form.coverHint")}</p>
                {coverError && <p className="text-xs text-red-600">{coverError}</p>}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="book-description" className="mb-1 block text-sm font-medium text-slate-700">
              {t("form.descriptionLabel")}
            </label>
            <textarea
              id="book-description"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={t("form.descriptionPlaceholder")}
              className="w-full resize-none rounded-md border border-line-strong px-3 py-2 text-sm transition-colors placeholder:text-slate-400 hover:border-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="mt-0.5 text-right text-xs tabular-nums text-slate-400">{form.description.length}/1000</div>
          </div>
        </Section>

        {/* ── Kutubxona ─────────────────────────────────────────────────────── */}
        {!book && isSuper && (
          // Super admin: Viloyat → Tuman → Kutubxona kaskadi (minglab
          // kutubxona ichidan hududiy tanlash uchun).
          <Section title={t("form.sectionLibrary")}>
            <div className="space-y-3 rounded-xl border border-line bg-surface-muted/60 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField id="book-viloyat" label={t("form.viloyatLabel")}>
                  <NativeSelect
                    value={filterViloyat}
                    onChange={(e) => { setFilterViloyat(e.target.value); setFilterTuman(""); set("libraryId", ""); }}
                  >
                    <option value="">{t("form.select")}</option>
                    {viloyatOptions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </NativeSelect>
                </FormField>
                <FormField id="book-tuman" label={t("form.tumanLabel")}>
                  <NativeSelect
                    value={filterTuman}
                    onChange={(e) => { setFilterTuman(e.target.value); set("libraryId", ""); }}
                    disabled={!filterViloyat}
                  >
                    <option value="">{t("form.allOption")}</option>
                    {tumanOptions.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                  </NativeSelect>
                </FormField>
              </div>
              <FormField
                id="book-library"
                label={t("form.libraryLabel")}
                error={errors.library}
                hint={filterViloyat && filteredLibs.length === 0 ? t("form.noLibsInRegion") : undefined}
              >
                <NativeSelect
                  value={form.libraryId}
                  onChange={(e) => set("libraryId", e.target.value)}
                  disabled={!filterViloyat}
                >
                  <option value="">{filterViloyat ? t("form.selectLibrary") : t("form.selectViloyatFirst")}</option>
                  {filteredLibs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} — {libTypeLabel(l.type)}</option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          </Section>
        )}

        {!book && !isSuper && (
          // Muassasa admin/kutubxonachi: viloyat/tuman avtomat (o'z muassasasi),
          // faqat filial (kutubxona) tanlanadi.
          <Section title={t("form.sectionLibrary")}>
            <FormField id="book-branch" label={t("form.branchLabel")} error={errors.library}>
              <NativeSelect value={form.libraryId} onChange={(e) => set("libraryId", e.target.value)}>
                <option value="">{t("form.select")}</option>
                {libraries.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}{l.type ? ` — ${libTypeLabel(l.type)}` : ""}</option>
                ))}
              </NativeSelect>
            </FormField>
          </Section>
        )}

        {/* Saqlash natijasi: dublikat nusxa (yashil-axborot) yoki xato (qizil) */}
        {saveMessage && (
          <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            <Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
            {saveMessage}
          </div>
        )}
        {saveError && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <Icon.error aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
            {saveError}
          </div>
        )}
      </form>
    </Modal>
  );
}
