/** Sahifa yuklanayotganda — varaqlanayotgan kitob animatsiyasi. */
export function PageLoader({ label = "Yuklanmoqda…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="grid min-h-[60vh] place-items-center px-4">
      <div className="flex flex-col items-center gap-5">
        <div className="book-loader" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="text-sm font-medium text-slate-500">{label}</p>
      </div>
    </div>
  );
}
