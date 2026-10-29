"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { toastVariants } from "@/lib/motion";
import { Icon, ICON_SIZE, type LucideIcon } from "./icon";

/**
 * Toast — CRUD natijalari uchun vaqtinchalik bildirishnoma (DESIGN.md §7).
 *
 * Nega o'z implementatsiyamiz: loyihada allaqachon 40+ ishlab chiqarish
 * bog'liqligi bor va bitta toast uchun yana bir kutubxona qo'shish bundle
 * byudjetini (DESIGN.md §12 / TZ §IX.3 — gzip < 200KB) qimmatga tushiradi.
 * Bu versiya ~2KB va boshqa bog'liqliksiz.
 *
 * Ishlatilishi:
 *   const toast = useToast();
 *   toast.success("Kutubxona qo'shildi");
 *   toast.error(await responseErrorMessage(res));
 */

export type ToastVariant = "success" | "error" | "info";

export type ToastItem = {
  id: number;
  variant: ToastVariant;
  title: string;
  /** Ixtiyoriy ikkinchi qator — "nima qilish kerak" ko'rsatmasi. */
  description?: string;
};

type ToastContextValue = {
  show: (variant: ToastVariant, title: string, description?: string) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

/** Bir vaqtda ko'rinadigan maksimal toast soni (DESIGN.md §7). */
const MAX_VISIBLE = 3;
const DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  // Xato uzoqroq turadi — foydalanuvchi o'qib ulgurishi kerak.
  error: 6000,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  // Taymerlarni unmount'da tozalash uchun saqlaymiz — aks holda
  // yopilgan sahifadan setState chaqirilib React ogohlantirish beradi.
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = React.useCallback(
    (variant: ToastVariant, title: string, description?: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, variant, title, description }].slice(-MAX_VISIBLE));
      const timer = setTimeout(() => dismiss(id), DURATION[variant]);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (t, d) => show("success", t, d),
      error: (t, d) => show("error", t, d),
      info: (t, d) => show("info", t, d),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * Provider o'rnatilmagan bo'lsa ham ilova YIQILMASLIGI kerak — toast
 * ikkilamchi qulaylik, asosiy oqim emas. Shu sababli no-op fallback
 * qaytariladi va dev rejimida ogohlantirish yoziladi.
 */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  const warned = React.useRef(false);
  if (ctx) return ctx;

  if (process.env.NODE_ENV !== "production" && !warned.current) {
    warned.current = true;
    console.warn(
      "[useToast] ToastProvider topilmadi — bildirishnomalar ko'rsatilmaydi. " +
        "app/[locale]/layout.tsx da <ToastProvider> o'rnatilganini tekshiring."
    );
  }
  const noop = () => undefined;
  return { show: noop, success: noop, error: noop, info: noop, dismiss: noop };
}

// ── Ko'rinish qismi ────────────────────────────────────────────────────────

const VARIANT_STYLES: Record<
  ToastVariant,
  { wrap: string; tone: string; glyph: LucideIcon }
> = {
  success: {
    wrap: "border-green-200 bg-green-50",
    tone: "text-green-600",
    glyph: Icon.success,
  },
  error: {
    wrap: "border-red-200 bg-red-50",
    tone: "text-red-600",
    glyph: Icon.error,
  },
  info: {
    wrap: "border-brand-200 bg-blue-50",
    tone: "text-brand-600",
    glyph: Icon.info,
  },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const reduce = useReducedMotion();
  // Desktopda toast o'ngdan, mobilda pastdan kiradi (joylashuviga mos
  // yo'nalish). `matchMedia` faqat klientda mavjud — SSR da false.
  const [fromRight, setFromRight] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const sync = () => setFromRight(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const variants = toastVariants(fromRight);

  return (
    <div
      // Mobilda pastda va butun kenglikda (bosh barmoqqa yaqin), desktopda
      // yuqori-o'ngda — DESIGN.md §9 responsive qoidasi.
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col gap-2 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-4 sm:w-96"
      role="region"
      aria-label="Bildirishnomalar"
    >
      {/* AnimatePresence toast YO'QOLISHINI ham animatsiya qiladi — busiz
          u birdan g'oyib bo'lardi. `popLayout` qolgan toastlar bo'sh joyni
          silliq egallashini ta'minlaydi. */}
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((t) => {
          const s = VARIANT_STYLES[t.variant];
          return (
            <motion.div
              key={t.id}
              layout={!reduce}
              variants={variants}
              initial={reduce ? { opacity: 0 } : "hidden"}
              animate={reduce ? { opacity: 1 } : "visible"}
              exit={reduce ? { opacity: 0 } : "exit"}
              // Xato = assertive (skrinriderni uzadi), qolgani = polite.
              role={t.variant === "error" ? "alert" : "status"}
              aria-live={t.variant === "error" ? "assertive" : "polite"}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-xl border p-4 shadow-lg",
                s.wrap
              )}
            >
              <span
                aria-hidden="true"
                className={cn("mt-0.5 shrink-0", s.tone)}
              >
                <s.glyph size={ICON_SIZE.md} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{t.title}</p>
                {t.description && (
                  <p className="mt-1 text-xs text-slate-600">{t.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                aria-label="Bildirishnomani yopish"
                className="-m-1 shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-black/5 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
