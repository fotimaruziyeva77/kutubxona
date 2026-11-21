import { PageLoader } from "@/components/ui/PageLoader";

export default function Loading() {
  return (
    <div className="min-h-screen bg-surface-muted">
      <PageLoader />
    </div>
  );
}
