import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Xato holati — chegara qizaradi va aria-invalid o'rnatiladi. */
  hasError?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, hasError, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      // Vizual qizil chegara yetarli emas — rang ko'ra olmaydigan va
      // skrinrider foydalanuvchilari uchun aria-invalid majburiy.
      aria-invalid={hasError || undefined}
      className={cn(
        "flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm transition-colors",
        "placeholder:text-slate-400",
        "focus:outline-none focus:ring-2 focus:border-transparent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        hasError
          ? "border-red-400 focus:ring-red-500"
          : "border-line-strong hover:border-gray-400 focus:ring-brand-500",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

/**
 * FormField — yorliq + input + xato/izoh matnini bitta joyda bog'laydi
 * (DESIGN.md §7: forma xatosi aniq va maydonga bog'langan bo'lishi kerak).
 *
 * `htmlFor`/`id` va `aria-describedby` avtomatik ulanadi — har sahifada
 * qo'lda yozilganda bu bog'lanishlar tez-tez unutilardi.
 */
export function FormField({
  id,
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  id: string;
  label: string;
  /** Bo'lsa — xato matni ko'rsatiladi va hint yashiriladi. */
  error?: string;
  hint?: string;
  required?: boolean;
  /**
   * Bitta input/select/textarea elementi. `id`, `aria-describedby` va
   * `hasError` avtomatik biriktiriladi — chaqiruvchi ularni yozmaydi.
   */
  children: React.ReactElement;
  className?: string;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  // a11y bog'lanishlarini bola elementga o'zimiz ulaymiz: har sahifada
  // qo'lda yozilganda id/aria-describedby juftligi muntazam unutilardi.
  const field = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id,
        "aria-describedby": describedBy,
        ...(error ? { hasError: true } : {}),
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-red-500">
            *
          </span>
        )}
      </label>
      {field}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="flex items-start gap-1 text-xs text-red-600"
        >
          <Icon.warning aria-hidden="true" size={ICON_SIZE.xs} className="mt-px shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export { Input };
