import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon, ICON_SIZE, type LucideIcon } from "./icon";

/**
 * EmptyState — ro'yxat bo'sh bo'lganda (DESIGN.md §7).
 *
 * Muhim: bo'sh ro'yxat "xato" emas — bu foydalanuvchini KEYINGI QADAMGA
 * undash imkoniyati. Shuning uchun har doim sabab + harakat tugmasi bo'ladi.
 * Faqat "Ma'lumot yo'q" deb yozish taqiqlanadi.
 */
export function EmptyState({
  icon: IconComponent = Icon.empty,
  title,
  description,
  action,
  className,
}: {
  /** lucide ikonka komponenti (Icon xaritasidan). Bezak — aria-hidden. */
  icon?: LucideIcon;
  title: string;
  /** Nega bo'sh va nima qilish kerakligini tushuntiradi. */
  description?: string;
  /** CTA tugma(lar)i — <Button> yoki <Link>. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-white px-6 py-12 text-center",
        className
      )}
    >
      {/* Ikonka neytral doira ichida — emoji'dagi tasodifiy rang o'rniga
          bir xil, boshqariladigan vizual og'irlik. */}
      <div
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-slate-400"
      >
        <IconComponent size={ICON_SIZE.lg} strokeWidth={1.5} />
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-slate-500">{description}</p>
      )}
      {action && <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div>}
    </div>
  );
}

/**
 * Qidiruv natijasi bo'sh — bu boshqa holat: foydalanuvchi ALLAQACHON
 * harakat qilgan, unga "qo'shish" emas, "so'rovni o'zgartirish" kerak.
 */
export function NoResultsState({
  query,
  onReset,
  className,
}: {
  query?: string;
  onReset?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      className={className}
      icon={Icon.search}
      title={query ? `"${query}" bo'yicha natija topilmadi` : "Natija topilmadi"}
      description="Boshqa kalit so'z bilan qidiring yoki filtrlarni kengaytiring. Imlo xatosi ham bo'lishi mumkin."
      action={
        onReset ? (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md border border-line-strong bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Filtrlarni tozalash
          </button>
        ) : undefined
      }
    />
  );
}
