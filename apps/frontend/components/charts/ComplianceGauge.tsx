"use client";

// ============================================================================
// PQ-9 compliance gauge — custom SVG donut with a gradient stroke and centered
// "met/total" + percent. Color shifts by score:
//   <50%  → rose/amber   |  50–99% → amber/blue   |  100% → emerald/teal
// Used on the Maktab paneli (school dashboard) PQ-9 compliance section.
// ============================================================================

export function ComplianceGauge({
  met,
  total,
  size = 168,
  stroke = 16,
}: {
  met: number;
  total: number;
  /** Diameter in px. */
  size?: number;
  /** Ring thickness in px. */
  stroke?: number;
}) {
  const pct = total > 0 ? Math.round((met / total) * 100) : 0;
  const clamped = Math.max(0, Math.min(100, pct));

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;

  // Unique id so multiple gauges on a page don't share a gradient def.
  const gradId = `gauge-grad-${met}-${total}-${size}`;

  // Score-based gradient stops.
  const [from, to] =
    clamped >= 100
      ? ["#34d399", "#0d9488"] // emerald → teal
      : clamped >= 50
        ? ["#fbbf24", "#2563eb"] // amber → blue
        : ["#fb7185", "#dc2626"]; // rose → red

  const label =
    clamped >= 100 ? "To'liq mos" : clamped >= 50 ? "Qisman mos" : "Mos emas";

  return (
    <div className="relative inline-flex items-center justify-center" data-testid="pq9-gauge">
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={`${met}/${total} mezon, ${clamped}%`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#eef2f7"
          strokeWidth={stroke}
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      {/* Centered readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-3xl font-extrabold text-slate-900 leading-none tabular-nums">
          {met}
          <span className="text-slate-400">/{total}</span>
        </div>
        <div className="mt-1 text-sm font-bold text-slate-500 tabular-nums">{clamped}%</div>
        <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {label}
        </div>
      </div>
    </div>
  );
}
