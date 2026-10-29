"use client";

import { useState, useRef, useEffect } from "react";
import { fmtNumber } from "@/lib/format";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import {
  fetchStoreProfile,
  fetchStoreProducts,
  createStoreProduct,
  updateStoreProduct,
  deleteStoreProduct,
  importStoreProducts,
  getStoreImportStatus,
  downloadStoreTemplate,
  type StoreImportStatus,
  type StoreProductItem,
} from "@/lib/api/store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { FormField, Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { BookCover } from "@/components/books/BookCover";

const PAGE_SIZE = 20;

// Import holatlari: shu ro'yxatdan tashqarisi (unknown, paused, ...) alohida
// fallback tarmoqda ko'rsatiladi — sarlavha bo'sh qolib ketmasin.
const IMPORT_RUNNING = ["queued", "active", "waiting", "delayed"];

// Rasmni kichik data-URL'ga aylantirish (maks ~400px, JPEG) — DB/javob bo'kib
// ketmasligi uchun (cover satr sifatida saqlanadi).
function fileToCoverDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 400;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(reader.result as string); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function StoreProductsPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const { locale, slug } = params;
  const t = useTranslations("DokonProducts");
  // Narx yorlig'i lokalga bog'liq ("so'm" / "сум" / "sum") — tarjimadan olinadi.
  const fmtPrice = (p: number) => t("priceSum", { price: fmtNumber(p) });
  const { user, isAuthenticated } = useAuthStore();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [editProduct, setEditProduct] = useState<StoreProductItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoreProductItem | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<StoreImportStatus | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const {
    data: store,
    // isPending — oflayn-pauza holatida ham yuklanish ko'rinishida qoladi
    // (isLoading u paytda false bo'lib, bo'sh holat yolg'onini chiqarardi).
    isPending: storeLoading,
    isError: storeError,
    refetch: refetchStore,
    isRefetching: storeRetrying,
  } = useQuery({
    queryKey: ["store-profile", slug],
    queryFn: () => fetchStoreProfile(slug),
  });
  const storeId = store?.id;

  const {
    data: productsData,
    isPending: isLoading,
    isError: productsError,
    refetch: refetchProducts,
    isRefetching: productsRetrying,
  } = useQuery({
    queryKey: ["store-products", storeId, page],
    queryFn: () => fetchStoreProducts(storeId!, page, PAGE_SIZE),
    enabled: !!storeId,
  });

  const products = productsData?.items ?? [];
  const total = productsData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const listLoading = storeLoading || (!!storeId && isLoading);
  const listError = storeError || productsError;

  // ── Import: fayl → base64 → enqueue → poll ──
  const importMut = useMutation({
    mutationFn: (fileBase64: string) => importStoreProducts(storeId!, fileBase64),
    onSuccess: (res) => {
      setImportJobId(res.jobId);
      setImportStatus({ status: "queued", processed: 0, total: 0, errors: [], progress: 0 });
    },
    onError: () => showToast(t("importStartError"), false),
  });

  useEffect(() => {
    if (!importJobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getStoreImportStatus(importJobId);
        if (cancelled) return;
        setImportStatus(s);
        if (s.status === "completed" || s.status === "failed" || s.status === "unknown") {
          qc.invalidateQueries({ queryKey: ["store-products"] });
          return;
        }
        setTimeout(tick, 2000);
      } catch {
        if (!cancelled) setTimeout(tick, 2000);
      }
    };
    tick();
    return () => { cancelled = true; };
  }, [importJobId, qc]);

  const onFile = (file: File | undefined) => {
    if (!file || !storeId) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      importMut.mutate(base64);
    };
    reader.readAsDataURL(file);
  };

  const del = useMutation({
    mutationFn: (id: string) => deleteStoreProduct(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-products"] });
      setDeleteTarget(null);
      showToast(t("deletedToast"), true);
    },
    onError: () => showToast(t("deleteError"), false),
  });

  // ── Guards ──
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-800 mb-2">{t("loginRequired")}</h1>
          <Link href={`/${locale}/login`} className="text-brand-600 hover:underline">{t("login")}</Link>
        </div>
      </div>
    );
  }
  if (user?.role !== "DOKON_OPERATOR" && user?.role !== "SUPER_ADMIN") {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <p className="text-red-700 font-bold">{t("operatorsOnly")}</p>
      </div>
    );
  }

  const productActions = (p: StoreProductItem) => (
    <div className="inline-flex gap-1.5 whitespace-nowrap">
      <button
        onClick={() => setEditProduct(p)}
        className="px-2 py-1 bg-blue-50 text-brand-700 hover:bg-blue-100 rounded text-xs font-medium"
      >
        {t("edit")}
      </button>
      <button
        onClick={() => setDeleteTarget(p)}
        className="px-2 py-1 bg-red-50 text-red-700 hover:bg-red-100 rounded text-xs font-medium"
      >
        {t("delete")}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface-muted">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
            <div className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
              {store ? (
                <span>{store.name}</span>
              ) : storeError ? (
                <span>—</span>
              ) : (
                <Skeleton className="h-4 w-28" />
              )}
              {productsData && <span>· {t("bookCount", { count: String(total) })}</span>}
            </div>
          </div>
          <Link href={`/${locale}/dokon/${slug}/dashboard`} className="text-sm text-brand-600 hover:underline">
            {t("backToDashboard")}
          </Link>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadStoreTemplate().catch(() => showToast(t("templateError"), false))}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border border-line bg-white text-slate-700 hover:bg-surface-muted"
          >
            <Icon.download aria-hidden="true" size={ICON_SIZE.sm} />
            {t("downloadTemplate")}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importMut.isPending || (!!importJobId && importStatus?.status !== "completed" && importStatus?.status !== "failed")}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border border-line bg-white text-slate-700 hover:bg-surface-muted disabled:opacity-50"
          >
            <Icon.upload aria-hidden="true" size={ICON_SIZE.sm} />
            {t("importExcel")}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-brand-600 text-white hover:bg-brand-700"
          >
            <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
            {t("addManual")}
          </button>
        </div>

        {/* How-to hint */}
        <div className="text-xs text-slate-500 bg-brand-50 border border-brand-100 rounded-xl px-4 py-3">
          <b>{t("howtoTitle")}</b> {t("howtoBody")}
        </div>

        {/* Import progress */}
        {importStatus && importJobId && (
          <div className={`rounded-xl p-4 text-sm border ${
            importStatus.status === "failed" ? "bg-red-50 border-red-200"
            : importStatus.status === "completed" ? (importStatus.errors.length ? "bg-yellow-50 border-yellow-200" : "bg-green-50 border-green-200")
            : "bg-brand-50 border-brand-200"
          }`}>
            <div className="flex items-center gap-1.5 font-semibold mb-1">
              {importStatus.status === "completed" && (
                <>
                  <Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                  {t("importDone", { count: String(importStatus.processed) })}
                </>
              )}
              {importStatus.status === "failed" && (
                <>
                  <Icon.error aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                  {t("importFailed")}
                </>
              )}
              {IMPORT_RUNNING.includes(importStatus.status) && (
                <>
                  <Icon.pending aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                  {t("importRunning")}
                </>
              )}
              {/* Fallback: unknown/paused va boshqa kutilmagan holatlar */}
              {importStatus.status !== "completed" &&
                importStatus.status !== "failed" &&
                !IMPORT_RUNNING.includes(importStatus.status) && (
                  <>
                    <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
                    {t("importUnknown")}
                  </>
                )}
            </div>
            {["queued", "active", "waiting"].includes(importStatus.status) && (
              <div className="h-2 bg-surface-sunken rounded-full overflow-hidden">
                <div className="h-2 bg-brand-600 transition-all" style={{ width: `${Math.max(3, importStatus.progress)}%` }} />
              </div>
            )}
            {importStatus.errors.length > 0 && (
              <div className="mt-2 text-red-700">
                <span className="inline-flex items-center gap-1.5">
                  <Icon.error aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("importRowErrors", { count: String(importStatus.errors.length) })}
                </span>
                {importStatus.errors.slice(0, 5).map((e, i) => (
                  <div key={i} className="text-xs">{t("importRowLine", { row: String(e.row), reason: e.reason })}</div>
                ))}
              </div>
            )}
            {!IMPORT_RUNNING.includes(importStatus.status) && (
              <button onClick={() => { setImportJobId(null); setImportStatus(null); }} className="mt-2 text-slate-500 text-xs underline">{t("close")}</button>
            )}
          </div>
        )}

        {/* Products list */}
        <div className="rounded-2xl border border-line bg-white overflow-hidden shadow-[0_10px_40px_-18px_rgba(37,99,235,0.30)]">
          {listLoading ? (
            <div className="py-12 text-center text-slate-400">{t("loading")}</div>
          ) : listError ? (
            <ErrorState
              className="border-0 rounded-none"
              title={t("catalogErrorTitle")}
              message={t("catalogErrorMessage")}
              onRetry={() => (storeError ? refetchStore() : refetchProducts())}
              isRetrying={storeError ? storeRetrying : productsRetrying}
            />
          ) : products.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <Icon.library aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2 text-slate-300" />
              <p>{t("emptyCatalog")}</p>
            </div>
          ) : (
            <>
              {/* Telefon (sm dan past): karta ko'rinishi — amallar ekrandan chiqib ketmaydi */}
              <ul className="sm:hidden divide-y divide-line">
                {products.map((p) => (
                  <li key={p.id} className="flex items-start gap-3 p-4">
                    <BookCover
                      title={p.title}
                      author={p.author}
                      genre={p.genre}
                      coverUrl={p.coverUrl}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900 truncate">{p.title}</p>
                      <p className="text-xs text-slate-500 truncate">{p.author}</p>
                      <p className="text-sm text-slate-800 mt-1">{fmtPrice(p.price)}</p>
                      <p className={`text-xs mt-0.5 font-medium ${p.stockCount === 0 ? "text-red-600" : "text-green-700"}`}>
                        {t("stockLabel", { count: String(p.stockCount) })}
                      </p>
                      <div className="mt-2">{productActions(p)}</div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* sm va undan keng: jadval */}
              <div className="hidden sm:block overflow-x-auto"><table className="w-full text-sm">
                <thead className="bg-surface-muted text-slate-600 text-left">
                  <tr>
                    {[t("thIsbn"), t("thTitle"), t("thAuthor"), t("thGenre"), t("thPrice"), t("thStock"), ""].map((h, i) => (
                      <th key={h || `th-${i}`} className="px-4 py-3 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {products.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-muted">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{p.isbn}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 max-w-[260px]">
                          {p.coverUrl ? (
                            <img src={p.coverUrl} alt="" className="w-8 h-11 object-cover rounded border border-line shrink-0" />
                          ) : (
                            <span className="w-8 h-11 rounded bg-surface-sunken flex items-center justify-center text-slate-300 shrink-0">
                              <Icon.bookClosed aria-hidden="true" size={ICON_SIZE.sm} />
                            </span>
                          )}
                          <span className="font-medium text-slate-900 truncate" title={p.description || undefined}>{p.title}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{p.author}</td>
                      <td className="px-4 py-3 text-slate-600">{p.genre || "—"}</td>
                      <td className="px-4 py-3 text-slate-800 whitespace-nowrap">{fmtPrice(p.price)}</td>
                      <td className="px-4 py-3">
                        <span className={p.stockCount === 0 ? "text-red-600 font-medium" : "text-green-700 font-medium"}>{p.stockCount}</span>
                      </td>
                      <td className="px-4 py-3 text-right">{productActions(p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </>
          )}
        </div>

        {/* Pagination */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}</span>
            <div className="flex gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label={t("prevPage")}
                className="h-9 w-9 inline-flex items-center justify-center card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40"
              >
                <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
              </button>
              <span className="h-9 px-3 inline-flex items-center text-sm text-slate-600">{page} / {pageCount}</span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
                aria-label={t("nextPage")}
                className="h-9 w-9 inline-flex items-center justify-center card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40"
              >
                <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
              </button>
            </div>
          </div>
        )}
      </div>

      {storeId && (showAdd || editProduct) && (
        <ProductModal
          storeId={storeId}
          product={editProduct}
          onClose={() => { setShowAdd(false); setEditProduct(null); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["store-products"] });
            showToast(editProduct ? t("updatedToast") : t("addedToast"), true);
            setShowAdd(false);
            setEditProduct(null);
          }}
        />
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title={t("deleteTitle")}
        description={
          deleteTarget
            ? t("deleteDescription", { title: deleteTarget.title })
            : undefined
        }
        confirmLabel={t("delete")}
        variant="destructive"
        isPending={del.isPending}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {toast && (
        <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ${toast.ok ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// Qo'shish/tahrirlash bitta forma — Modal (Esc, fokus qulfi, max-h-[90dvh],
// sticky footer) ichida. `product` bo'lsa tahrirlash rejimi.
function ProductModal({
  storeId,
  product,
  onClose,
  onSaved,
}: {
  storeId: string;
  product: StoreProductItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("DokonProducts");
  const fmtPrice = (p: number) => t("priceSum", { price: fmtNumber(p) });
  const isEdit = !!product;
  const [form, setForm] = useState({
    isbn: product?.isbn ?? "",
    title: product?.title ?? "",
    author: product?.author ?? "",
    genre: product?.genre ?? "",
    price: product ? String(product.price) : "",
    stockCount: product ? String(product.stockCount) : "1",
    description: product?.description ?? "",
    coverUrl: product?.coverUrl ?? "",
  });
  const [error, setError] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);

  const priceNum = parseInt(form.price, 10);
  const priceValid = Number.isFinite(priceNum) && priceNum > 0;
  const priceError =
    form.price !== "" && !priceValid
      ? t("priceInvalid")
      : undefined;

  const save = useMutation({
    mutationFn: () => {
      const base = {
        isbn: form.isbn.replace(/[-\s]/g, ""),
        title: form.title.trim(),
        author: form.author.trim(),
        genre: form.genre.trim() || undefined,
        price: priceNum,
        stockCount: Math.max(0, parseInt(form.stockCount) || 0),
      };
      return isEdit
        ? updateStoreProduct(product!.id, {
            ...base,
            // Tahrirlashda bo'sh qiymat ham yuboriladi — tavsif/rasmni
            // o'chirish mumkin bo'lsin.
            description: form.description.trim(),
            coverUrl: form.coverUrl,
          })
        : createStoreProduct(storeId, {
            ...base,
            description: form.description.trim() || undefined,
            coverUrl: form.coverUrl || undefined,
          });
    },
    onSuccess: onSaved,
    onError: () => setError(t("saveError")),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = !!(form.isbn && form.title && form.author) && priceValid;
  const idp = isEdit ? "edit-product" : "add-product";

  return (
    <Modal
      open
      title={isEdit ? t("editTitle") : t("addTitle")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg border border-line-strong bg-white text-sm font-medium text-slate-700 hover:bg-surface-muted"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
            className="px-4 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {save.isPending ? t("saving") : t("save")}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField id={`${idp}-isbn`} label={t("fieldIsbn")} required>
          <Input value={form.isbn} onChange={(e) => set("isbn", e.target.value)} placeholder="9789943..." />
        </FormField>
        <FormField id={`${idp}-title`} label={t("fieldTitle")} required>
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} />
        </FormField>
        <FormField id={`${idp}-author`} label={t("fieldAuthor")} required>
          <Input value={form.author} onChange={(e) => set("author", e.target.value)} />
        </FormField>
        <FormField id={`${idp}-genre`} label={t("fieldGenre")}>
          <Input value={form.genre} onChange={(e) => set("genre", e.target.value)} placeholder={t("genrePlaceholder")} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            id={`${idp}-price`}
            label={t("fieldPrice")}
            required
            error={priceError}
            // Blur'dan keyin minglik ajratilgan ko'rinish — operator nol
            // sonini adashtirmasligi uchun.
            hint={priceTouched && priceValid ? fmtPrice(priceNum) : undefined}
          >
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              onBlur={() => setPriceTouched(true)}
            />
          </FormField>
          <FormField id={`${idp}-stock`} label={t("fieldStock")}>
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={form.stockCount}
              onChange={(e) => set("stockCount", e.target.value)}
            />
          </FormField>
        </div>
        <CoverAndDescription
          idPrefix={idp}
          coverUrl={form.coverUrl}
          description={form.description}
          onCover={(v) => set("coverUrl", v)}
          onDescription={(v) => set("description", v)}
        />
        {error && (
          <p role="alert" className="text-red-600 text-sm">{error}</p>
        )}
      </div>
    </Modal>
  );
}

// Kitob rasmi (cover) + tavsif (kitob haqida) — forma modalining pastki qismi.
function CoverAndDescription({
  idPrefix,
  coverUrl,
  description,
  onCover,
  onDescription,
}: {
  idPrefix: string;
  coverUrl: string;
  description: string;
  onCover: (dataUrl: string) => void;
  onDescription: (v: string) => void;
}) {
  const t = useTranslations("DokonProducts");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { onCover(await fileToCoverDataUrl(file)); } catch { /* skip */ } finally { setBusy(false); }
  };
  return (
    <>
      <div>
        <span className="block text-sm font-medium text-slate-700 mb-1">{t("fieldCover")}</span>
        <div className="flex items-center gap-3">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="w-14 h-20 object-cover rounded-lg border border-line" />
          ) : (
            <div className="w-14 h-20 rounded-lg border border-dashed border-line-strong flex items-center justify-center text-slate-300">
              <Icon.bookClosed aria-hidden="true" size={ICON_SIZE.md} />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            <button type="button" onClick={() => ref.current?.click()} disabled={busy}
              className="px-3 py-1.5 rounded-lg border border-line text-sm text-slate-700 hover:bg-surface-muted disabled:opacity-50">
              {busy ? t("loading") : coverUrl ? t("coverReplace") : t("coverUpload")}
            </button>
            {coverUrl && (
              <button type="button" onClick={() => onCover("")} className="text-xs text-red-600 hover:underline text-left">{t("coverRemove")}</button>
            )}
          </div>
        </div>
      </div>
      <FormField id={`${idPrefix}-description`} label={t("fieldDescription")}>
        <textarea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          rows={3}
          placeholder={t("descriptionPlaceholder")}
          className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />
      </FormField>
    </>
  );
}
