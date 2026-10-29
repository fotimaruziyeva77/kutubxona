"use client";

import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { Icon, ICON_SIZE } from "./icon";

/**
 * ErrorState — so'rov yiqilganda ko'rsatiladigan blok (DESIGN.md §7).
 *
 * Uchta majburiy element: nima bo'ldi (inson tilida), nima qilish kerak,
 * va bitta "Qayta urinish" tugmasi. Texnik tafsilot faqat dev rejimida.
 */
export function ErrorState({
  title = "Ma'lumotni yuklab bo'lmadi",
  message,
  onRetry,
  isRetrying = false,
  /** Faqat NODE_ENV=development da ko'rsatiladi. */
  technicalDetail,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  technicalDetail?: string;
  className?: string;
}) {
  const isDev = process.env.NODE_ENV === "development";

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center",
        className
      )}
    >
      <div
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 text-red-600"
      >
        <Icon.warning size={ICON_SIZE.md} strokeWidth={1.75} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-slate-600">{message}</p>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
        >
          {isRetrying && <Spinner size="sm" label="Qayta urinilmoqda" />}
          {isRetrying ? "Urinilmoqda…" : "Qayta urinish"}
        </button>
      )}

      {isDev && technicalDetail && (
        <details className="mt-6 w-full max-w-md text-left">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
            Texnik tafsilot (faqat dev)
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-100">
            {technicalDetail}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * 403 — ruxsat yo'q. Alohida komponent, chunki bu XATO emas: tizim to'g'ri
 * ishlayapti, foydalanuvchida shunchaki huquq yo'q. "Qayta urinish" tugmasi
 * bu yerda ma'nosiz — shuning uchun berilmaydi.
 */
export function ForbiddenState({
  message = "Bu bo'limni ko'rish uchun sizning rolingizda ruxsat yo'q.",
  className,
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-amber-200 bg-amber-50 px-6 py-10 text-center",
        className
      )}
    >
      <div
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-100 text-accent-700"
      >
        <Icon.locked size={ICON_SIZE.md} strokeWidth={1.75} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">
        Ruxsat yo'q
      </h3>
      <p className="mt-1.5 max-w-md text-sm text-slate-600">{message}</p>
      <p className="mt-3 text-xs text-slate-500">
        Kerak bo'lsa tizim administratoriga murojaat qiling.
      </p>
    </div>
  );
}

/**
 * Tarmoq uzilgan — offline holati uchun maxsus blok. OfflineBanner global
 * ogohlantirish beradi, bu esa aniq bir blok o'rnini egallaydi.
 */
export function OfflineState({
  onRetry,
  className,
}: {
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <ErrorState
      className={className}
      title="Internet aloqasi yo'q"
      message="Ulanish tiklangach ma'lumotlar avtomatik yangilanadi. Kutubxona katalogi oflayn rejimda ham ochiq."
      onRetry={onRetry}
    />
  );
}
