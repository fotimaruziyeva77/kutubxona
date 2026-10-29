"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/**
 * Plan 05-03 T3 (STAT-07) — Shortage list with per-row "Buyurtma" button.
 *
 * Posts to POST /admin/stats/order-request { bookId, requestedQuantity }.
 * Service-layer dedupes within 24h; UI doesn't need to track its own state
 * beyond the optimistic "yuborildi" label.
 */

export type ShortageItem = {
  bookId: string;
  isbn: string;
  title: string;
  author: string;
  genre: string;
  requestCount: number;
  libraryName: string;
};

const fmt = (n: number) => new Intl.NumberFormat("uz-UZ").format(Math.round(n));

export function ShortageTab({ items }: { items: ShortageItem[] }) {
  const [modalBook, setModalBook] = useState<ShortageItem | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [requestedQuantity, setRequestedQuantity] = useState<number>(5);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ kind: "success" | "error"; msg: string } | null>(null);

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400 card-surface rounded-2xl">
        <Icon.success aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2 text-green-500" />
        <p>Hozircha kritik yetishmovchilik aniqlanmagan</p>
      </div>
    );
  }

  function openModal(item: ShortageItem) {
    setModalBook(item);
    setReasonText("");
    setRequestedQuantity(Math.max(1, Math.min(100, Math.ceil(item.requestCount / 10))));
  }

  function closeModal() {
    if (submitting) return;
    setModalBook(null);
    setReasonText("");
  }

  async function submitOrder() {
    if (!modalBook) return;
    const trimmed = reasonText.trim();
    if (trimmed.length < 3) {
      setToast({ kind: "error", msg: "Sabab kamida 3 ta belgi bo'lishi shart" });
      return;
    }
    if (
      !Number.isInteger(requestedQuantity) ||
      requestedQuantity < 1 ||
      requestedQuantity > 100
    ) {
      setToast({ kind: "error", msg: "Miqdor 1-100 oralig'ida bo'lishi shart" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiClient("/admin/stats/order-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: modalBook.bookId,
          requestedQuantity,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setToast({
          kind: "error",
          msg: data?.message ?? "Buyurtma yuborilmadi",
        });
      } else {
        setSubmitted((s) => new Set([...s, modalBook.bookId]));
        setToast({ kind: "success", msg: "Buyurtma so'rovi tasdiqlandi" });
        setModalBook(null);
        setReasonText("");
      }
    } catch {
      setToast({ kind: "error", msg: "Tarmoq xatosi" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card-surface rounded-2xl overflow-hidden">
      <div className="p-5 border-b border-line">
        <h2 className="flex items-center gap-2 font-semibold text-slate-700">
          <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0 text-accent-600" />
          Kitob yetishmovchiligi — So&apos;ralgan lekin mavjud emas
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          availableCount = 0 bo&apos;lgan va eng ko&apos;p so&apos;ralgan kitoblar
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-muted text-slate-500">
              <th className="text-left px-5 py-3 font-medium">#</th>
              <th className="text-left px-5 py-3 font-medium">Kitob</th>
              <th className="text-left px-5 py-3 font-medium">Muallif</th>
              <th className="text-left px-5 py-3 font-medium">Janr</th>
              <th className="text-right px-5 py-3 font-medium">So&apos;rovlar</th>
              <th className="text-left px-5 py-3 font-medium">Kutubxona</th>
              <th className="text-right px-5 py-3 font-medium">Amal</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const already = submitted.has(item.bookId);
              return (
                <tr key={item.isbn ?? item.bookId} className="border-t border-line hover:bg-surface-muted">
                  <td className="px-5 py-3 text-slate-400">{i + 1}</td>
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-800 truncate max-w-xs">{item.title}</p>
                    <p className="text-xs text-slate-400">{item.isbn}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{item.author}</td>
                  <td className="px-5 py-3">
                    <span className="bg-surface-sunken text-slate-600 px-2 py-0.5 rounded-lg text-xs">{item.genre}</span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <span className="font-bold text-red-600">{fmt(item.requestCount)}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-500 text-xs truncate max-w-xs">{item.libraryName}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => openModal(item)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        already
                          ? "bg-surface-sunken text-slate-400 cursor-not-allowed"
                          : "bg-brand-600 text-white hover:bg-brand-700"
                      }`}
                    >
                      {already ? "So'rov yuborildi" : "Buyurtma"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modalBook && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-slate-800 mb-1">Buyurtma so&apos;rovi</h3>
            <p className="text-xs text-slate-500 mb-4">
              {modalBook.title} — {modalBook.libraryName}
            </p>

            <label className="block text-sm font-medium text-slate-700 mb-1">
              Miqdor (nusxa)
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={requestedQuantity}
              onChange={(e) => setRequestedQuantity(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className="w-full border border-line rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-blue-400"
            />

            <label className="block text-sm font-medium text-slate-700 mb-1">
              Sabab (3+ belgi)
            </label>
            <textarea
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder="Nima uchun bu kitob zarur..."
              className="w-full border border-line rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:border-blue-400 resize-none"
            />

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-surface-sunken disabled:opacity-50"
              >
                Bekor qilish
              </button>
              <button
                type="button"
                onClick={submitOrder}
                disabled={submitting}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:bg-blue-300"
              >
                {submitting ? "Yuborilmoqda…" : "So'rovni yuborish"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${
            toast.kind === "success"
              ? "bg-green-600 text-white"
              : "bg-red-600 text-white"
          }`}
          onClick={() => setToast(null)}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default ShortageTab;
