import { cn } from "@/lib/utils";

/**
 * Skeleton — birinchi yuklanishda kontent SHAKLINI oldindan ko'rsatadi
 * (DESIGN.md §7). Maqsad: layout shift'ni yo'qotish va sahifa "o'lik"
 * ko'rinmasligi.
 *
 * Fon `bg-gray-200` — globals.css dark retrofiti buni avtomatik moslaydi,
 * shuning uchun `dark:` prefiksi yozilmaydi (DESIGN.md §2).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-gray-200 motion-reduce:animate-none",
        className
      )}
    />
  );
}

/**
 * Matn bloki skeleti. Oxirgi qator qisqaroq — haqiqiy paragraf shu ko'rinishda
 * tugaydi, shuning uchun ko'z uni tabiiy qabul qiladi.
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/** Statistika kartasi skeleti (dashboard KPI qatorlari uchun). */
export function SkeletonStatCard() {
  return (
    <div className="card-surface rounded-xl p-6">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-32" />
      <Skeleton className="mt-2 h-3 w-16" />
    </div>
  );
}

/** KPI kartalar to'ri (grid) skeleti. */
export function SkeletonStatGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStatCard key={i} />
      ))}
    </div>
  );
}

/**
 * Jadval skeleti. `columns` haqiqiy jadval ustunlari soniga teng bo'lishi
 * kerak — aks holda yuklangach qator kengliklari sakraydi.
 */
export function SkeletonTable({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="overflow-hidden card-surface rounded-xl">
      <div className="border-b border-line bg-surface-muted px-4 py-3">
        <div className="flex gap-4">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-4 px-4 py-4">
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ro'yxat kartalari skeleti (kutubxonalar, kitoblar, klublar). */
export function SkeletonCardList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="card-surface rounded-xl p-4 sm:p-6"
        >
          <div className="flex items-start gap-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Grafik/diagramma skeleti. */
export function SkeletonChart({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "card-surface rounded-xl p-6",
        className
      )}
    >
      <Skeleton className="h-4 w-40" />
      {/* Turli balandliklar — bir tekis bloklar grafikka o'xshamaydi.
          Qiymatlar qat'iy (random emas): SSR va klient render mos kelishi
          shart, aks holda hydration mismatch chiqadi. */}
      <div className="mt-6 flex h-48 items-end gap-2">
        {[45, 70, 35, 85, 60, 95, 50, 75].map((h, i) => (
          <div key={i} className="flex-1" style={{ height: `${h}%` }}>
            <Skeleton className="h-full w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
