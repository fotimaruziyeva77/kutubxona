/**
 * BookCover — 3D kitob muqovasi.
 *
 * MUAMMO: fondda 200+ kitob bor, birortasida ham `coverUrl` yo'q. Muqovasiz
 * ro'yxat "ma'lumotlar jadvali" bo'lib ko'rinadi va hech kimni kitob olishga
 * undamaydi — o'quvchi uchun esa aynan MUQOVA tanlash omili.
 *
 * NEGA TASHQI SERVIS EMAS (Open Library / Google Books):
 *  • Demo ISBN'lari haqiqiy emas — javob 404 bo'lardi va kartalar bo'sh qolardi.
 *  • Platforma PWA va 2G/oflayn rejimda ishlashi kerak — har bir kartaga
 *    tashqi so'rov qishloq maktabida sahifani o'ldiradi.
 *  • Ishlab chiqarish CSP'si tashqi rasm hostlarini bloklaydi.
 *
 * YECHIM: `coverUrl` bo'lsa — o'sha rasm. Bo'lmasa — sarlavhadan
 * DETERMINISTIK tarzda haqiqiy nashriyot muqovasiga o'xshash kompozitsiya
 * chiziladi: janrga bog'langan uch bosqichli gradient "san'at", muallif,
 * katta harfli sarlavha, janr yorlig'i va nashriyot belgisi.
 *
 * 3D: koreshka (chap yon) va sahifa qirralari (o'ng yon) haqiqiy CSS 3D
 * yuzalari sifatida chiziladi. Bu kitobni "rasm" emas, PREDMET qilib
 * ko'rsatadi — javondagi kitobni tanlagandek his. Hoverda kitob ochilib
 * ko'tariladi.
 *
 * TEJAMKORLIK: 3D faqat `md`/`lg` o'lchamlarida. Ro'yxatdagi mayda (`sm`)
 * muqovalarda perspektiva sezilmaydi, lekin har bir element uchun alohida
 * kompozitsiya qatlami past quvvatli telefonda qimmatga tushadi.
 * `prefers-reduced-motion` da harakat butunlay o'chadi.
 */

export type BookCoverSize = "sm" | "md" | "lg";

const SIZE: Record<BookCoverSize, { wrap: string; depth: number }> = {
  sm: { wrap: "w-14", depth: 0 },
  md: { wrap: "w-full", depth: 14 },
  lg: { wrap: "w-full", depth: 20 },
};

/**
 * Janr → uch bosqichli gradient. Haqiqiy nashriyot seriyalaridagidek
 * "ufq" kompozitsiyasi: tepa — osmon, o'rta — yorug'lik, past — yer.
 */
const GENRE_ART: Record<string, [string, string, string]> = {
  Roman: ["#1e3a8a", "#93bbfd", "#e8eefb"],
  "Tarixiy roman": ["#7c2d12", "#f59e0b", "#fde68a"],
  Qissa: ["#1e40af", "#6096fa", "#dbe8fe"],
  Hikoya: ["#1e40af", "#93bbfd", "#eff5ff"],
  Doston: ["#78350f", "#d97706", "#fef3c7"],
  "She'riyat": ["#831843", "#ec4899", "#fce7f3"],
  Drama: ["#4c1d95", "#a78bfa", "#ede9fe"],
  Tarix: ["#713f12", "#ca8a04", "#fef9c3"],
  Falsafa: ["#1c1917", "#78716c", "#e7e5e4"],
  Psixologiya: ["#065f46", "#34d399", "#d1fae5"],
  "Shaxsiy rivojlanish": ["#0c4a6e", "#38bdf8", "#e0f2fe"],
  Biznes: ["#0f172a", "#475569", "#e2e8f0"],
  Moliya: ["#14532d", "#4ade80", "#dcfce7"],
  Biografiya: ["#3f3f46", "#a1a1aa", "#f4f4f5"],
  "Bolalar adabiyoti": ["#c2410c", "#fb923c", "#ffedd5"],
  Sarguzasht: ["#155e75", "#22d3ee", "#cffafe"],
  Fantastika: ["#4338ca", "#818cf8", "#e0e7ff"],
  Triller: ["#450a0a", "#dc2626", "#fee2e2"],
  Distopiya: ["#1c1917", "#57534e", "#d6d3d1"],
  Satira: ["#854d0e", "#eab308", "#fef9c3"],
  Komediya: ["#a16207", "#facc15", "#fefce8"],
  Esse: ["#374151", "#9ca3af", "#f3f4f6"],
  Nasr: ["#1e3a8a", "#60a5fa", "#dbeafe"],
  default: ["#1e3a8a", "#6096fa", "#e8eefb"],
};

/**
 * Barqaror hash — bir xil matn har doim bir xil son beradi.
 * `Math.random()` ATAYLAB ishlatilmaydi: SSR va klient boshqa muqova
 * chizsa React hydration daraxti mos kelmasdi.
 */
function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function BookCover({
  title,
  author,
  genre,
  coverUrl,
  size = "md",
  className = "",
}: {
  title: string;
  author?: string | null;
  genre?: string | null;
  coverUrl?: string | null;
  size?: BookCoverSize;
  className?: string;
}) {
  const cfg = SIZE[size];

  // Haqiqiy muqova bor — o'shani ko'rsatamiz.
  // `next/image` EMAS: `coverUrl` ixtiyoriy tashqi/MinIO manzil bo'lishi
  // mumkin va uni `next.config` domenlar ro'yxatiga oldindan yozib bo'lmaydi.
  if (coverUrl) {
    return (
      <div
        className={`${cfg.wrap} aspect-[2/3] shrink-0 overflow-hidden rounded-r-md rounded-l-sm bg-surface-sunken shadow-md ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      </div>
    );
  }

  const art = GENRE_ART[genre ?? ""] ?? GENRE_ART.default;
  const seed = hashString(`${title}|${author ?? ""}`);
  // Ufq balandligi va yorug'lik markazi sarlavhadan — bir janrdagi
  // kitoblar bir xil ko'rinmasligi uchun.
  const horizon = 38 + (seed % 26); // 38–63%
  const glow = 20 + ((seed >> 3) % 60); // 20–80%
  const spineTone = art[0];

  // ── Mayda o'lcham: 3D siz, faqat kompozitsiya ────────────────────────
  if (cfg.depth === 0) {
    return (
      <div
        className={`${cfg.wrap} relative aspect-[2/3] shrink-0 overflow-hidden rounded-r-md rounded-l-sm shadow-md ${className}`}
        style={{
          backgroundImage: `linear-gradient(175deg, ${art[0]} 0%, ${art[1]} ${horizon}%, ${art[2]} 100%)`,
        }}
        aria-hidden="true"
      >
        <span className="absolute inset-y-0 left-0 w-[7%] bg-black/25" />
        <span className="absolute inset-y-0 left-[7%] w-px bg-white/25" />
      </div>
    );
  }

  // ── 3D kitob ─────────────────────────────────────────────────────────
  const d = cfg.depth;

  return (
    <div
      className={`${cfg.wrap} book3d-scene ${className}`}
      aria-hidden="true"
      style={{ perspective: "1100px" }}
    >
      <div className="book3d relative aspect-[2/3]" style={{ transformStyle: "preserve-3d" }}>
        {/* Koreshka — chap yon yuza */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-sm"
          style={{
            width: `${d}px`,
            transform: `rotateY(-90deg) translateZ(${d / 2}px)`,
            transformOrigin: "left center",
            backgroundImage: `linear-gradient(90deg, ${spineTone} 0%, rgba(0,0,0,0.55) 100%)`,
          }}
        />

        {/* Sahifa qirralari — o'ng yon yuza */}
        <div
          className="absolute inset-y-0 right-0"
          style={{
            width: `${d}px`,
            transform: `rotateY(90deg) translateZ(${d / 2}px)`,
            transformOrigin: "right center",
            backgroundImage:
              "repeating-linear-gradient(90deg, #f8f7f2 0px, #f8f7f2 1px, #ddd8c9 1px, #ddd8c9 2px)",
          }}
        />

        {/* Old muqova */}
        <div
          className="absolute inset-0 flex flex-col overflow-hidden rounded-r-md rounded-l-sm"
          style={{
            transform: `translateZ(${d / 2}px)`,
            backgroundImage: `linear-gradient(175deg, ${art[0]} 0%, ${art[1]} ${horizon}%, ${art[2]} 100%)`,
          }}
        >
          {/* Yorug'lik markazi — tekis gradientni "bo'yalgan" qiladi */}
          <span
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `radial-gradient(ellipse 65% 40% at ${glow}% ${horizon}%, rgba(255,255,255,0.32), transparent 70%)`,
            }}
          />
          {/* Koreshka soyasi old muqovada */}
          <span className="pointer-events-none absolute inset-y-0 left-0 w-[9%] bg-gradient-to-r from-black/28 to-transparent" />
          {/* Muqova yaltirashi */}
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/18 via-transparent to-black/10" />

          {/* Tipografika — nashriyot muqovasi tartibida */}
          <div className="relative flex flex-1 flex-col justify-center px-[12%] text-center">
            {author && (
              <p className="mb-1 truncate text-[8px] font-medium text-slate-800/80 sm:text-[10px]">
                {author}
              </p>
            )}
            <p className="line-clamp-3 text-[11px] font-bold uppercase leading-tight tracking-[0.06em] text-slate-900 sm:text-sm">
              {title}
            </p>
            {genre && (
              <span className="mx-auto mt-2 max-w-full truncate rounded-sm border border-slate-900/25 px-1.5 py-[1px] text-[6px] font-medium text-slate-800/80 sm:text-[8px]">
                {genre}
              </span>
            )}
          </div>

          {/* Nashriyot belgisi */}
          <p className="relative pb-[7%] text-center text-[6px] font-bold uppercase tracking-[0.22em] text-slate-900/45 sm:text-[7px]">
            Sifat
          </p>
        </div>
      </div>
    </div>
  );
}
