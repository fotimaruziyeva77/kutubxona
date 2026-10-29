"use client";

import { cn } from "@/lib/utils";

/**
 * SuccessCheck — muhim amal tasdiqlangandagi bir martalik mikro-animatsiya
 * (DESIGN.md §10): kitob berildi/qaytarildi, davomat qayd etildi, to'lov o'tdi.
 *
 * Nega SVG stroke animatsiyasi: kutubxonachi planshetda kuniga yuzlab amal
 * bajaradi — belgi "chizilishi" amal HAQIQATAN yakunlanganini bir qarashda
 * bildiradi va tasodifiy ikki marta bosishning oldini oladi.
 *
 * `prefers-reduced-motion` da belgi darhol to'liq holatda ko'rinadi.
 */
export function SuccessCheck({
  size = 64,
  className,
  label = "Muvaffaqiyatli",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-flex", className)}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 52 52"
        aria-hidden="true"
        className="sl-success"
      >
        <circle
          className="sl-success__circle"
          cx="26"
          cy="26"
          r="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path
          className="sl-success__check"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14 27 l8 8 l16 -16"
        />
      </svg>
    </span>
  );
}
