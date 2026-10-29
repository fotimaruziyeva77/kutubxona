import { cn } from "@/lib/utils";

/**
 * Spinner — qisqa muddatli amal indikatori (DESIGN.md §7).
 *
 * Skeleton BIRINCHI yuklanish uchun; Spinner esa allaqachon ko'rinib turgan
 * UI ustida ishlayotgan amal uchun (forma yuborish, refetch, tugma ichi).
 *
 * `prefers-reduced-motion` da aylanish sekinlashadi (to'liq to'xtatish
 * indikatorni ma'nosiz qilardi — DESIGN.md §10).
 */
export function Spinner({
  className,
  size = "md",
  label = "Yuklanmoqda",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  /** Skrinrider uchun matn; vizual ko'rinmaydi. */
  label?: string;
}) {
  const sizes = {
    sm: "h-3.5 w-3.5 border-[1.5px]",
    md: "h-5 w-5 border-2",
    lg: "h-8 w-8 border-[3px]",
  };

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "animate-spin rounded-full border-current border-t-transparent opacity-70 motion-reduce:[animation-duration:1.8s]",
          sizes[size]
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Sahifa markazida to'liq balandlikdagi spinner (route-level fallback). */
export function PageSpinner({ label = "Yuklanmoqda" }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-slate-400">
      <Spinner size="lg" label={label} />
      <p className="text-sm text-slate-500">{label}…</p>
    </div>
  );
}
