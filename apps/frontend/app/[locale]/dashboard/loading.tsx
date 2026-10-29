import {
  Skeleton,
  SkeletonStatGrid,
  SkeletonChart,
  SkeletonTable,
} from "@/components/ui/skeleton";

/**
 * Dashboard route-level loading (DESIGN.md §7).
 *
 * Next.js buni Suspense fallback sifatida ishlatadi — server komponenti
 * ma'lumot kutayotganda sahifa oq qolmaydi. Skelet haqiqiy dashboard
 * tuzilishini takrorlaydi (sarlavha → KPI qatori → grafik → jadval),
 * shuning uchun kontent kelganda layout sakramaydi.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Boshqaruv paneli yuklanmoqda</span>

      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>

      <SkeletonStatGrid count={4} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SkeletonChart />
        <SkeletonChart />
      </div>

      <SkeletonTable rows={6} columns={5} />
    </div>
  );
}
