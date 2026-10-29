import type { SVGProps } from "react";

/**
 * Brend belgisi — ochiq kitob + uchqun. Geometriya `public/brand/logo-mark.svg`
 * bilan bir xil; bu yerda inline SVG, chunki ranglar CSS orqali boshqariladi:
 * `.sl-logo-*` qoidalari (globals.css) tun rejimida belgini bir pog'ona
 * yorug'roq qiladi.
 *
 * Gradient id'lari qasddan o'zgarmas: bir sahifada bir nechta belgi (header +
 * footer) bo'lsa ham ta'riflar bir xil, brauzer birinchisini oladi — to'qnashuv
 * zarar qilmaydi va `useId` kerak emas (server va client komponentda ishlaydi).
 */
type LogoMarkProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Kvadrat o'lcham, px. */
  size?: number;
  /** `brand` — ko'k gradient (och va to'q sirt uchun), `white` — oq belgi (ko'k fon uchun). */
  tone?: "brand" | "white";
};

const COVER_ID = "sl-logo-cover";
const PAGE_ID = "sl-logo-page";

export function LogoMark({ size = 36, tone = "brand", ...props }: LogoMarkProps) {
  const white = tone === "white";
  const coverFill = white ? "#ffffff" : `url(#${COVER_ID})`;
  const pageFill = white ? "#bfdbfe" : `url(#${PAGE_ID})`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {!white && (
        <defs>
          <linearGradient id={COVER_ID} x1="7" y1="16" x2="57" y2="50" gradientUnits="userSpaceOnUse">
            <stop offset="0" className="sl-logo-c1" />
            <stop offset="0.45" className="sl-logo-c2" />
            <stop offset="1" className="sl-logo-c3" />
          </linearGradient>
          <linearGradient id={PAGE_ID} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="sl-logo-p1" />
            <stop offset="1" className="sl-logo-p2" />
          </linearGradient>
        </defs>
      )}
      {/* Muqova */}
      <g fill={coverFill} stroke={coverFill} strokeWidth="2" strokeLinejoin="round">
        <path d="M7 15.5 C14.5 12.5 23 13.5 29.5 19.5 L29.5 53 C23 47.5 14.5 46.5 7 49.5 Z" />
        <path d="M57 15.5 C49.5 12.5 41 13.5 34.5 19.5 L34.5 53 C41 47.5 49.5 46.5 57 49.5 Z" />
      </g>
      {/* Sahifa */}
      <g fill={pageFill}>
        <path d="M13 20 C18.5 18.3 23.5 19.2 27.5 22.6 L27.5 48.6 C23.5 45.2 18.5 44.4 13 45.6 Z" />
        <path d="M51 20 C45.5 18.3 40.5 19.2 36.5 22.6 L36.5 48.6 C40.5 45.2 45.5 44.4 51 45.6 Z" />
      </g>
      {/* Uchqun */}
      <g className={white ? undefined : "sl-logo-spark"} fill={white ? "#ffffff" : undefined}>
        <path d="M32 2.5 C32.9 7.2 34.8 9.1 39.5 10 C34.8 10.9 32.9 12.8 32 17.5 C31.1 12.8 29.2 10.9 24.5 10 C29.2 9.1 31.1 7.2 32 2.5 Z" />
        <path d="M44.5 3.6 C44.8 5.2 45.3 5.7 46.9 6 C45.3 6.3 44.8 6.8 44.5 8.4 C44.2 6.8 43.7 6.3 42.1 6 C43.7 5.7 44.2 5.2 44.5 3.6 Z" />
      </g>
    </svg>
  );
}

/**
 * So'z belgisi — "Sifat Library": `Sifat` matn rangida, `Library` brend
 * ko'kida (brend varag'i bo'yicha). Shrift `font-display` = Plus Jakarta Sans.
 * Tun rejimi: `.dark .text-slate-900` / `.dark .text-brand-600` retrofit
 * qoidalari o'zi moslaydi. O'lcham tashqaridan (`text-base`, `text-3xl`).
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display font-extrabold tracking-tight text-slate-900 ${className}`}>
      Sifat <span className="text-brand-600">Library</span>
    </span>
  );
}
