import { Icon, ICON_SIZE } from "@/components/ui/icon";

/**
 * Hero vizuali — kutubxona javoni (SVG) + ustidagi jonli ko'rsatkich kartasi.
 *
 * Nega SVG, stok surat emas:
 *  • Tashqi rasm CSP/offline (PWA) sharoitida yuklanmasligi mumkin, LCP'ni
 *    sekinlashtiradi va 2G rejimda umuman ko'rinmaydi — TZ talabi bo'yicha
 *    platforma sekin internetda ham ishlashi kerak.
 *  • Stok surat brend palitrasiga tushmaydi; SVG esa tokenlardan bo'yaladi,
 *    shuning uchun kun/tun rejimida ham to'g'ri ko'rinadi.
 *
 * Kitob tanalari QAT'IY ro'yxat bilan beriladi (tasodifiy emas) — SSR va
 * klient bir xil markup chizadi, hydration nomuvofiqligi bo'lmaydi.
 */

/** Bir javon: [kenglik, balandlik, rang indeksi] uchliklari. */
type Spine = [number, number, number];

const SHELVES: Spine[][] = [
  [
    [14, 86, 0], [9, 78, 3], [17, 92, 1], [11, 70, 4], [8, 82, 2],
    [15, 88, 0], [10, 74, 5], [13, 94, 1], [9, 80, 3], [16, 72, 2],
    [11, 90, 4], [8, 76, 0], [14, 84, 1],
  ],
  [
    [10, 80, 1], [16, 92, 2], [12, 74, 0], [9, 86, 5], [14, 78, 3],
    [11, 94, 1], [17, 70, 4], [8, 84, 0], [13, 88, 2], [10, 76, 3],
    [15, 82, 1], [9, 90, 5],
  ],
  [
    [13, 88, 2], [9, 72, 0], [15, 84, 4], [11, 92, 1], [8, 78, 3],
    [16, 86, 0], [12, 74, 2], [10, 90, 5], [14, 80, 1], [9, 94, 3],
    [13, 76, 4], [11, 82, 0],
  ],
];

/** Kitob muqovasi ranglari — brend ko'ki, navy, oltin, slate. */
const SPINE_FILLS = [
  "#1e3a8a", // navy
  "#2563eb", // brand
  "#93bbfd", // och ko'k
  "#b45309", // to'q oltin
  "#475569", // slate
  "#f59e0b", // oltin
];

const SHELF_TOP = [48, 168, 288];
const SHELF_HEIGHT = 100;

export function HeroVisual({
  liveLabel,
  liveValue,
}: {
  liveLabel: string;
  liveValue: string | null;
}) {
  return (
    <div className="relative">
      {/* Javon ramkasi */}
      <div className="overflow-hidden rounded-3xl border border-line bg-white shadow-[0_18px_50px_-20px_rgb(23_37_84/0.35)]">
        <svg
          viewBox="0 0 480 420"
          className="h-auto w-full"
          role="img"
          aria-label="Kutubxona javoni"
        >
          {/* Fon — iliq yorug'lik */}
          <defs>
            <linearGradient id="hv-bg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f8fafc" />
              <stop offset="100%" stopColor="#eaeefa" />
            </linearGradient>
            <linearGradient id="hv-glow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect width="480" height="420" fill="url(#hv-bg)" />
          <ellipse cx="240" cy="20" rx="220" ry="90" fill="url(#hv-glow)" />

          {SHELVES.map((shelf, si) => {
            const baseY = SHELF_TOP[si] + SHELF_HEIGHT;
            let x = 42;
            return (
              <g key={si}>
                {shelf.map((spine, bi) => {
                  const [w, h, c] = spine;
                  const el = (
                    <g key={bi}>
                      <rect
                        x={x}
                        y={baseY - h}
                        width={w}
                        height={h}
                        rx={2}
                        fill={SPINE_FILLS[c]}
                      />
                      {/* Muqovadagi yorug'lik chizig'i — tekis to'rtburchak
                          "kitob" emas, "plitka" bo'lib ko'rinmasligi uchun */}
                      <rect
                        x={x + 1.5}
                        y={baseY - h + 8}
                        width={Math.max(w - 3, 1)}
                        height={2}
                        rx={1}
                        fill="#ffffff"
                        opacity={0.35}
                      />
                      <rect
                        x={x + 1.5}
                        y={baseY - h + 14}
                        width={Math.max(w - 3, 1)}
                        height={2}
                        rx={1}
                        fill="#ffffff"
                        opacity={0.22}
                      />
                    </g>
                  );
                  x += w + 3;
                  return el;
                })}
                {/* Javon taxtasi */}
                <rect x={28} y={baseY} width={424} height={7} rx={3} fill="#cbd5e1" />
                <rect x={28} y={baseY + 7} width={424} height={4} rx={2} fill="#94a3b8" opacity={0.45} />
              </g>
            );
          })}

          {/* Yon ustunlar */}
          <rect x={20} y={40} width={9} height={371} rx={4} fill="#94a3b8" opacity={0.55} />
          <rect x={451} y={40} width={9} height={371} rx={4} fill="#94a3b8" opacity={0.55} />
        </svg>
      </div>

      {/* Jonli ko'rsatkich kartasi — javon ustida "suzadi" */}
      <div className="absolute -bottom-5 left-4 flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 shadow-[0_12px_32px_-12px_rgb(23_37_84/0.35)] sm:left-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-50 text-info-600">
          <Icon.book aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
        </span>
        <div className="leading-tight">
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-slate-500">
            <span className="live-dot" aria-hidden="true" />
            {liveLabel}
          </p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-900">
            {liveValue ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}
