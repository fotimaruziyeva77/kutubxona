"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { modalBackdrop, modalPanel } from "@/lib/motion";
import { Icon, ICON_SIZE } from "./icon";

/**
 * Modal — forma va kontent dialoglar uchun umumiy qobiq.
 *
 * Nega kerak: audit paytida 8 ta sahifada qo'lda yozilgan modal topildi —
 * hech birida role="dialog", Esc, fokus qulfi va fokus qaytarish yo'q edi;
 * ikkitasida backdrop onClick oddiy div ustida edi (klaviaturadan yopib
 * bo'lmasdi). ConfirmModal faqat tasdiqlash uchun; bu esa ixtiyoriy forma
 * kontenti uchun o'sha a11y kafolatlarini beradi:
 *
 *  - role="dialog" aria-modal + sarlavhaga aria-labelledby
 *  - Esc yopadi, backdrop bosilsa yopadi, burchakda yopish tugmasi
 *  - Ochilganda fokus dialogga, yopilganda chaqirgan elementga qaytadi
 *  - Tab fokusi dialog ichida qulflanadi
 *  - max-h-[90dvh] + overflow-y-auto — telefonda klaviatura ochiq bo'lsa ham
 *    "Saqlash" tugmasiga yetib boriladi
 *  - Ochiq turganda fon scroll'i bloklanadi
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Tugmalar qatori — pastda yopishqoq (sticky) turadi. */
  footer?: React.ReactNode;
  maxWidth?: string;
}) {
  const reduce = useReducedMotion();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  // Fokus: ochilganda dialogga, yopilganda chaqirgan elementga.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, [open]);

  // Esc + Tab qulfi.
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Fon scroll'ini bloklash.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div
            aria-hidden="true"
            onClick={onClose}
            variants={modalBackdrop}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute inset-0 bg-black/40"
          />
          <motion.div
            ref={dialogRef}
            variants={reduce ? modalBackdrop : modalPanel}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={`relative flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white shadow-lg outline-none sm:rounded-xl ${maxWidth}`}
          >
            <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
              <h2 id={titleId} className="text-lg font-semibold text-slate-900">
                {title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Yopish"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-surface-muted hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Icon.close aria-hidden="true" size={ICON_SIZE.md} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>

            {footer && (
              <div className="flex flex-col-reverse gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-end">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
