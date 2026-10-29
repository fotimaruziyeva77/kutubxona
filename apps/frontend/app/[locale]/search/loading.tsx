import { Skeleton, SkeletonCardList } from "@/components/ui/skeleton";

/** Kitob qidiruv sahifasi skeleti (qidiruv maydoni → natija kartalari). */
export default function SearchLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6" aria-busy="true">
      <span className="sr-only">Qidiruv natijalari yuklanmoqda</span>
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-4 w-40" />
      <SkeletonCardList count={5} />
    </div>
  );
}
