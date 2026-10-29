"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getBooks,
  downloadBookTemplate,
  createBook,
  updateBook,
  deleteBook,
  lookupIsbn,
  importBooksExcel,
  getBookImportStatus,
  type Book,
  type Library,
  type BookImportStatusResult
} from "@/lib/api/libraries";
import { getMyLibraries } from "@/lib/api/libraries";
import { getViloyatlar, getTumanlar } from "@/lib/api/geo";
import { useAuthStore } from "@/store/auth.store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { BookCover } from "@/components/books/BookCover";
import { BookRow } from "@/components/books/BookCard";
import { ErrorState } from "@/components/ui/error-state";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { DashboardPage, PageHeader } from "@/components/dashboard/ui";

// Kutubxona turi yorlig'i — super admin kaskadida kutubxonani aniqroq ko'rsatish.
// Tarjimalar BooksPanel.libTypes da; noma'lum tur xom kod bilan qoladi.
const LIB_TYPE_KEYS = ["GOV", "SCH", "UNI", "ORG", "MAH"] as const;

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
  // Kutubxona yoki sahifa hajmi o'zgarsa — 1-sahifaga qaytamiz.
  useEffect(() => { setPage(1); }, [effectiveLib, limit]);

  const { data: books = [], isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["books", effectiveLib, page, limit],
    queryFn: () => getBooks(effectiveLib || undefined, page, limit),
    enabled: true
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteBook(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["books"] });
      setDeleteTarget(null);
    }
  });

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

  // Amallar tugmalari — jadvalda ham, mobil kartada ham bir xil.
  const rowActions = (book: Book) => (
    <div className="flex gap-2">
      <button
        onClick={() => setEditBook(book)}
        className="inline-flex min-h-9 items-center rounded-md bg-blue-50 px-3 py-2 text-xs font-medium text-brand-700 hover:bg-blue-100"
      >
        {t("edit")}
      </button>
      <button
        onClick={() => setDeleteTarget(book)}
        className="inline-flex min-h-9 items-center rounded-md bg-red-50 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-100"
      >
        {t("delete")}
      </button>
    </div>
  );

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
              }}
            />
            <button
              onClick={() =>
                downloadBookTemplate().catch(() =>
                  setActionNotice(t("templateError"))
                )
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98]"
            >
              <Icon.download aria-hidden="true" size={ICON_SIZE.sm} />
              {t("excelTemplate")}
            </button>
            <button
              onClick={() => {
                if (!effectiveLib) {
                  setActionNotice(t("selectLibraryFirst"));
                  return;
                }
                setActionNotice("");
                fileInputRef.current?.click();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98]"
            >
              <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
              {t("excelImport")}
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
            >
              <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
              {t("addBook")}
            </button>
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

      {/* Kutubxona filter — bitta kutubxona bo'lsa yashiriladi (librarian
          "Barcha kutubxonalar" orqali boshqa kutubxonalarni ko'ra olmaydi) */}
      {singleLibrary ? (
        <div className="text-sm text-slate-600">
          {t("currentLibrary")} <span className="font-medium text-slate-900">{libraries[0].name}</span>
        </div>
      ) : (
        <div>
          <label htmlFor="books-lib-filter" className="sr-only">
            {t("filterLabel")}
          </label>
          <select
            id="books-lib-filter"
            value={selectedLib}
            onChange={(e) => setSelectedLib(e.target.value)}
            className="border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">{t("allLibraries")}</option>
            {(libraries as Library[]).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      )}

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
      {isLoading ? (
        <div className="text-center py-12 text-slate-500">{t("loading")}</div>
      ) : isError ? (
        <ErrorState
          title={t("loadError.title")}
          message={t("loadError.message")}
          onRetry={() => refetch()}
          isRetrying={isRefetching}
        />
      ) : (
        <>
          {/* Telefon (sm dan past): karta-ro'yxat — 8 ustunli jadval siqilib
              o'qib bo'lmas edi. */}
          <div className="space-y-3 sm:hidden">
            {(books as Book[]).map((book) => (
              <BookRow
                key={book.id}
                book={book}
                meta={
                  <span className="text-xs">
                    <span className={book.availableCount === 0 ? "font-medium text-red-600" : "font-medium text-green-700"}>
                      {book.availableCount}
                    </span>
                    <span className="text-slate-400">/{book.totalCount}</span>
                  </span>
                }
                action={rowActions(book)}
              />
            ))}
            {books.length === 0 && (
              <div className="rounded-xl border border-dashed border-line-strong bg-white px-4 py-8 text-center text-sm text-slate-400">
                {t("emptyList")}
              </div>
            )}
          </div>

          {/* Jadval — sm va undan keng ekranlarda */}
          <div className="hidden overflow-x-auto rounded-xl border border-line sm:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-slate-600 text-left">
                <tr>
                  {[t("table.cover"), t("table.isbn"), t("table.name"), t("table.author"), t("table.genre"), t("table.year"), t("table.totalAvailable"), t("table.actions")].map((h) => (
                    <th key={h} className="px-4 py-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(books as Book[]).map((book) => (
                  <tr key={book.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-3">
                      <BookCover
                        size="sm"
                        title={book.title}
                        author={book.author}
                        genre={book.genre}
                        coverUrl={book.coverUrl}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{book.isbn}</td>
                    <td className="px-4 py-3 font-medium text-slate-900 max-w-[200px] truncate">{book.title}</td>
                    <td className="px-4 py-3 text-slate-700">{book.author}</td>
                    <td className="px-4 py-3 text-slate-600">{book.genre}</td>
                    <td className="px-4 py-3 text-slate-600">{book.year || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={book.availableCount === 0 ? "text-red-600 font-medium" : "text-green-700 font-medium"}>
                        {book.availableCount}
                      </span>
                      <span className="text-slate-400">/{book.totalCount}</span>
                    </td>
                    <td className="px-4 py-3">{rowActions(book)}</td>
                  </tr>
                ))}
                {books.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                      {t("emptyList")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Pagination + sahifa hajmi (20/50/100) */}
      {!isLoading && !isError && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <label htmlFor="books-page-size">{t("pageSize")}</label>
            <select
              id="books-page-size"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="border border-line-strong rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>{t("pageSizeUnit")}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label={t("prevPage")}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line px-3 text-sm text-slate-600 hover:bg-surface-muted disabled:opacity-40"
            >
              <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
              {t("prev")}
            </button>
            <span className="text-sm text-slate-500">{t("pageN", { page })}</span>
            {/* GET /books hozircha jami sonni (total) qaytarmaydi — faqat
                Book[] keladi, shuning uchun oxirgi sahifani aniq bilib
                bo'lmaydi. `books.length < limit` evristikasi: to'liq sahifa
                kelsa "Keyingi" ochiq qoladi (oxirgi sahifa aynan limit ta
                bo'lsa bitta bo'sh sahifa ko'rinishi mumkin). API total
                qaytarganda `page * limit < total` sharti va "N-sahifa / M"
                ko'rinishiga o'tkaziladi. */}
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={books.length < limit}
              aria-label={t("nextPage")}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-line px-3 text-sm text-slate-600 hover:bg-surface-muted disabled:opacity-40"
            >
              {t("next")}
              <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
            </button>
          </div>
        </div>
      )}

      {/* O'chirishni tasdiqlash — kitob nomi sarlavhada */}
      <ConfirmModal
        open={!!deleteTarget}
        title={deleteTarget ? t("deleteModal.titleNamed", { title: deleteTarget.title }) : t("deleteModal.title")}
        description={t("deleteModal.description")}
        confirmLabel={t("deleteModal.confirm")}
        variant="destructive"
        isPending={del.isPending}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {(showAdd || editBook) && (
        <BookFormModal
          book={editBook}
          libraryId={effectiveLib || libraries[0]?.id || ""}
          libraries={libraries}
          onClose={() => { setShowAdd(false); setEditBook(null); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["books"] }); setShowAdd(false); setEditBook(null); }}
        />
      )}
    </DashboardPage>
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
  const currentUser = useAuthStore((s) => s.user);
  const isSuper = currentUser?.role === "SUPER_ADMIN";
  const libTypeLabel = (type: string) =>
    (LIB_TYPE_KEYS as readonly string[]).includes(type) ? t(`libTypes.${type}`) : type;

  const [form, setForm] = useState({
    isbn: book?.isbn ?? "",
    title: book?.title ?? "",
    author: book?.author ?? "",
    genre: book?.genre ?? "",
    lang: book?.lang ?? "uz",
    pages: book?.pages ?? 0,
    year: book?.year ?? 0,
    coverUrl: book?.coverUrl ?? "",
    description: book?.description ?? "",
    totalCount: book?.totalCount ?? 1,
    // Super admin add rejimida bo'sh boshlanadi (kaskad orqali tanlanadi);
    // muassasa admin uchun o'z kutubxonasi oldindan tanlangan bo'ladi.
    libraryId: book?.libraryId ?? (isSuper ? "" : libraryId)
  });
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
  const tumanNameById = new Map(tumanList.map((t) => [t.id, t.name]));
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

  const save = useMutation({
    mutationFn: () =>
      book
        ? updateBook(book.id, form)
        : createBook(form as any),
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
      onSaved();
    },
    onError: () => {
      setSaveMessage("");
      setSaveError(t("form.saveError"));
    }
  });

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
          pages: data.pages ?? f.pages,
          year: data.year ?? f.year,
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

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">{book ? t("form.editTitle") : t("form.newTitle")}</h2>

        <div className="space-y-3">
          {/* ISBN + auto-fill */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.isbnLabel")}</label>
            <div className="flex gap-2">
              <input
                value={form.isbn}
                onChange={(e) => set("isbn", e.target.value)}
                placeholder={t("form.isbnPlaceholder")}
                className="flex-1 border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                type="button"
                onClick={handleIsbnLookup}
                disabled={isbnLoading}
                className="px-3 py-2 bg-surface-sunken hover:bg-line rounded-lg text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                {isbnLoading ? "…" : t("form.isbnSearch")}
              </button>
            </div>
            {isbnHint && <p className="text-accent-600 text-xs mt-1">{isbnHint}</p>}
            {isbnOk && <p className="text-emerald-600 text-xs mt-1">{isbnOk}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.nameLabel")}</label>
            <input value={form.title} onChange={(e) => set("title", e.target.value)}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.authorLabel")}</label>
            <input value={form.author} onChange={(e) => set("author", e.target.value)}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.genreLabel")}</label>
              <input value={form.genre} onChange={(e) => set("genre", e.target.value)}
                placeholder={t("form.genrePlaceholder")}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.langLabel")}</label>
              <select value={form.lang} onChange={(e) => set("lang", e.target.value)}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="uz">{t("form.langUz")}</option>
                <option value="ru">{t("form.langRu")}</option>
                <option value="en">{t("form.langEn")}</option>
                <option value="kaa">{t("form.langKaa")}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.yearLabel")}</label>
              <input type="number" value={form.year} onChange={(e) => set("year", parseInt(e.target.value) || 0)}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.pagesLabel")}</label>
              <input type="number" value={form.pages} onChange={(e) => set("pages", parseInt(e.target.value) || 0)}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.copiesLabel")}</label>
              <input type="number" min={1} value={form.totalCount} onChange={(e) => set("totalCount", Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>

          {/* Muqova rasmi — yuklash + preview. Rasm bo'lmasa BookCover
              deterministik gradient muqova chizadi (aynan shu holat uchun). */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.coverLabel")}</label>
            <div className="flex items-center gap-3">
              <BookCover
                size="sm"
                title={form.title || t("form.newTitle")}
                author={form.author}
                genre={form.genre}
                coverUrl={form.coverUrl || null}
              />
              <div className="flex flex-col gap-1.5 items-start">
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleCoverFile(e.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  disabled={coverUploading}
                  className="px-3 py-1.5 bg-surface-sunken hover:bg-line rounded-lg text-sm font-medium text-slate-700 disabled:opacity-50"
                >
                  {coverUploading ? t("form.coverUploading") : form.coverUrl ? t("form.coverReplace") : t("form.coverUpload")}
                </button>
                {form.coverUrl && (
                  <button
                    type="button"
                    onClick={() => set("coverUrl", "")}
                    className="text-xs text-red-500 hover:underline"
                  >
                    {t("form.coverRemove")}
                  </button>
                )}
              </div>
            </div>
            {coverError && <p className="text-red-500 text-xs mt-1">{coverError}</p>}
          </div>

          {/* Qisqacha tavsif */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.descriptionLabel")}</label>
            <textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={t("form.descriptionPlaceholder")}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
            />
            <div className="text-xs text-slate-400 text-right mt-0.5">{form.description.length}/1000</div>
          </div>

          {!book && isSuper && (
            // Super admin: Viloyat → Tuman → Kutubxona kaskadi (minglab
            // kutubxona ichidan hududiy tanlash uchun).
            <div className="space-y-3 rounded-xl border border-line bg-surface-muted/60 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.viloyatLabel")}</label>
                  <select
                    value={filterViloyat}
                    onChange={(e) => { setFilterViloyat(e.target.value); setFilterTuman(""); set("libraryId", ""); }}
                    className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                  >
                    <option value="">{t("form.select")}</option>
                    {viloyatOptions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.tumanLabel")}</label>
                  <select
                    value={filterTuman}
                    onChange={(e) => { setFilterTuman(e.target.value); set("libraryId", ""); }}
                    disabled={!filterViloyat}
                    className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white disabled:bg-surface-sunken disabled:text-slate-400"
                  >
                    <option value="">{t("form.allOption")}</option>
                    {tumanOptions.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.libraryLabel")}</label>
                <select
                  value={form.libraryId}
                  onChange={(e) => set("libraryId", e.target.value)}
                  disabled={!filterViloyat}
                  className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white disabled:bg-surface-sunken disabled:text-slate-400"
                >
                  <option value="">{filterViloyat ? t("form.selectLibrary") : t("form.selectViloyatFirst")}</option>
                  {filteredLibs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} — {libTypeLabel(l.type)}</option>
                  ))}
                </select>
                {filterViloyat && filteredLibs.length === 0 && (
                  <p className="text-accent-600 text-xs mt-1">{t("form.noLibsInRegion")}</p>
                )}
              </div>
            </div>
          )}

          {!book && !isSuper && (
            // Muassasa admin/kutubxonachi: viloyat/tuman avtomat (o'z muassasasi),
            // faqat filial (kutubxona) tanlanadi.
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("form.branchLabel")}</label>
              <select value={form.libraryId} onChange={(e) => set("libraryId", e.target.value)}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">{t("form.select")}</option>
                {libraries.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}{l.type ? ` — ${libTypeLabel(l.type)}` : ""}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Saqlash natijasi: dublikat nusxa (yashil-axborot) yoki xato (qizil) */}
        {saveMessage && (
          <div className="mt-4 p-3 rounded-lg bg-green-50 border border-green-200 text-green-800 text-sm">
            {saveMessage}
          </div>
        )}
        {saveError && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {saveError}
          </div>
        )}

        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900">
            {saveMessage ? t("form.close") : t("form.cancel")}
          </button>
          {saveMessage ? (
            // Dublikat: nusxa qo'shildi — ro'yxatni yangilab modalni yopamiz.
            <button
              onClick={onSaved}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
            >
              {t("form.done")}
            </button>
          ) : (
            <button
              disabled={!form.isbn || !form.title || !form.author || !form.libraryId || save.isPending}
              onClick={() => save.mutate()}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {save.isPending ? t("form.saving") : t("form.save")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
