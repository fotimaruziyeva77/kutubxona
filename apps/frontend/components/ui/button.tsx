import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * Button — DESIGN.md §6 bo'yicha to'rtta majburiy holat:
 * hover / active / focus-visible / disabled.
 *
 * Qo'shildi:
 *  - `active:scale-[0.98]` — bosilganini his qildiradi (planshetda muhim)
 *  - `focus-visible:ring-*` har variant uchun o'z rangida
 *  - `isLoading` — spinner + avtomatik disable; matn saqlanadi, shuning uchun
 *    tugma kengligi sakramaydi (layout shift yo'q)
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium",
    "transition-[color,background-color,border-color,transform] duration-150",
    "active:scale-[0.98] motion-reduce:active:scale-100",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-brand-600 text-white shadow-sm shadow-brand-600/20 hover:bg-brand-700 hover:shadow-brand-600/30 focus-visible:ring-brand-500",
        outline:
          "border border-line-strong bg-surface text-slate-700 hover:bg-surface-muted hover:border-slate-400 focus-visible:ring-brand-500",
        ghost: "text-slate-700 hover:bg-surface-sunken focus-visible:ring-brand-500",
        destructive:
          "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500",
        secondary:
          "bg-slate-900 text-white hover:bg-slate-800 focus-visible:ring-slate-900",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
        // DESIGN.md §9 — skan oqimi planshet/telefonda ishlaydi; barmoq uchun
        // minimal nishon ~44px, shuning uchun alohida "touch" o'lchami.
        touch: "h-12 w-full px-6 text-base sm:w-auto",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Yuklanish holati — spinner ko'rsatadi va tugmani bloklaydi. */
  isLoading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, isLoading, disabled, children, ...props },
    ref
  ) => (
    <button
      ref={ref}
      // Yuklanayotganda takroriy bosish bloklanadi (ikki marta yuborish
      // muammosi) va yordamchi texnologiyaga band ekani bildiriladi.
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {isLoading && <Spinner size="sm" label="Bajarilmoqda" />}
      {children}
    </button>
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
