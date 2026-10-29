import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ICON_SIZE, type LucideIcon } from "./icon";

/**
 * StatusPage — 404 / 500 / 403 sahifalarining umumiy karkasi (DESIGN.md §8).
 *
 * Uchala sahifa bir xil tuzilishga ega: belgi + kod + sarlavha + qisqa
 * tushuntirish + bitta asosiy CTA. Takrorlanmasligi uchun bitta komponent.
 */
export function StatusPage({
  code,
  icon: IconComponent,
  tone = "neutral",
  title,
  description,
  actions,
  footer,
  className,
}: {
  /** HTTP kodi — vizual jihatdan xira, chunki foydalanuvchiga ikkilamchi. */
  code?: string;
  icon: LucideIcon;
  /** Ikonka doirasining rang ohangi — holat og'irligini bildiradi. */
  tone?: "neutral" | "warning" | "danger";
  title: string;
  description: string;
  actions?: ReactNode;
  /** Qo'shimcha texnik ma'lumot (dev) yoki yordam havolasi. */
  footer?: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-sunken text-slate-500",
    warning: "bg-accent-100 text-accent-700",
    danger: "bg-red-100 text-red-600",
  } as const;

  return (
    <main
      className={cn(
        "flex min-h-[70vh] flex-col items-center justify-center px-4 py-16 text-center sm:px-6",
        className
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "flex h-16 w-16 items-center justify-center rounded-2xl",
          tones[tone]
        )}
      >
        <IconComponent size={ICON_SIZE.xl} strokeWidth={1.5} />
      </div>

      {code && (
        <p className="mt-6 font-mono text-xs uppercase tracking-widest text-slate-400">
          {code}
        </p>
      )}

      <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
        {title}
      </h1>

      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-500">
        {description}
      </p>

      {actions && (
        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          {actions}
        </div>
      )}

      {footer && <div className="mt-10 w-full max-w-lg">{footer}</div>}
    </main>
  );
}
