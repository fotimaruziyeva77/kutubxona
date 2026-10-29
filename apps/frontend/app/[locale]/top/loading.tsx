import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";

/** Ochiq reytinglar sahifasi skeleti (sarlavha → tab qatori → jadval). */
export default function TopLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
      <span className="sr-only">Reytinglar yuklanmoqda</span>

      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      {/* Tab qatori — haqiqiy sahifadagi reyting turlari tugmalari. */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28 rounded-full" />
        ))}
      </div>

      <SkeletonTable rows={10} columns={4} />
    </div>
  );
}
