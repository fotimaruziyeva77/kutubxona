"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { modalBackdrop, modalPanel } from "@/lib/motion";
import { Spinner } from "./spinner";

/**
 * ConfirmModal — qaytarilmas amal oldidan tasdiqlash (DESIGN.md §7).
 *
 * Qoida: ConfirmModal'siz o'chirish/muzlatish tugmasi bo'lishi taqiqlanadi.
 *
 * Kirish nazorati (a11y):
 *  - `role="dialog" aria-modal` + sarlavhaga bog'langan `aria-labelledby`
 *  - Esc yopadi, fon (backdrop) bosilsa yopadi
 *  - Ochilganda fokus modalga ko'chadi, yopilganda chaqirgan tugmaga qaytadi
 *  - Fokus modal ichida qulflanadi (Tab tsikli) — orqadagi sahifaga o'tmaydi
 *  - Ochiq turganda sahifa scroll'i bloklanadi
 */
export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Tasdiqlash",
  cancelLabel = "Bekor qilish",
  variant = "default",
  isPending = false,
  /** Talab qilinsa, foydalanuvchi shu so'zni yozmaguncha tasdiq o'chiq turadi. */
  requireTypedConfirmation,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  isPending?: boolean;
  requireTypedConfirmation?: string;
  /**
   * Qo'shimcha maydonlar (masalan "rad etish sababi" inputi) — dialog ICHIDA
   * render qilinadi, shuning uchun fokus qulfi va Esc ular uchun ham ishlaydi.
   */
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reduce = useReducedMotion();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const confirmRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const [typed, setTyped] = React.useState("");

  // Modal har ochilganda yozilgan tasdiq matni tozalanadi — aks holda
  // oldingi marta yozilgan "ROZIMAN" keyingi o'chirishni ham ochib qo'yardi.
  React.useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  // Fokusni saqlash/tiklash + boshlang'ich fokus.
  React.useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    // Destruktiv amalda tasdiq tugmasiga avtomatik fokus BERILMAYDI —
    // tasodifiy Enter bosish o'chirib yuborishi mumkin edi.
    const target =
      variant === "destructive" || requireTypedConfirmation
        ? dialogRef.current
        : confirmRef.current;
    target?.focus();
    return () => restoreFocusRef.current?.focus?.();
  }, [open, variant, requireTypedConfirmation]);

  // Esc + fokus qulfi (focus trap).
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!isPending) onCancel();
        return;
      }
      if (e.key !== "Tab") return;

      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
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
  }, [open, isPending, onCancel]);

  // Fon scroll'ini bloklash.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // AnimatePresence yopilish animatsiyasini ko'rsatishi uchun erta
  // return QILINMAYDI — modal ichkarida shartli render bo'ladi.

  const typedOk =
    !requireTypedConfirmation ||
    typed.trim().toUpperCase() === requireTypedConfirmation.toUpperCase();
  const confirmDisabled = isPending || !typedOk;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div
            aria-hidden="true"
            onClick={() => !isPending && onCancel()}
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
        aria-labelledby="confirm-modal-title"
        aria-describedby={description ? "confirm-modal-desc" : undefined}
        tabIndex={-1}
            className="relative w-full max-w-md rounded-t-2xl bg-white p-6 shadow-lg outline-none sm:rounded-xl"
          >
        <h2
          id="confirm-modal-title"
          className="text-lg font-semibold text-slate-900"
        >
          {title}
        </h2>
        {description && (
          <p id="confirm-modal-desc" className="mt-2 text-sm text-slate-600">
            {description}
          </p>
        )}

        {children && <div className="mt-4">{children}</div>}

        {requireTypedConfirmation && (
          <div className="mt-4">
            <label
              htmlFor="confirm-typed"
              className="block text-xs font-medium text-slate-700"
            >
              Tasdiqlash uchun{" "}
              <span className="font-mono font-semibold text-slate-900">
                {requireTypedConfirmation}
              </span>{" "}
              deb yozing
            </label>
            <input
              id="confirm-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-1.5 w-full rounded-md border border-line-strong px-3 py-2 text-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
        )}

        {/* Mobilda tugmalar teskari tartibda ustma-ust (asosiy amal pastda,
            bosh barmoqqa yaqin), desktopda yonma-yon o'ngda. */}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex h-11 items-center justify-center rounded-md border border-line-strong bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 sm:h-10"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={cn(
              "inline-flex h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium text-white transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:h-10",
              variant === "destructive"
                ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
                : "bg-blue-600 hover:bg-brand-700 focus-visible:ring-brand-500"
            )}
          >
            {isPending && <Spinner size="sm" label="Bajarilmoqda" />}
            {isPending ? "Bajarilmoqda…" : confirmLabel}
          </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
