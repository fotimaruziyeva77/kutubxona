"use client";

import { useEffect, useRef, useState } from "react";

// Raqamni bo'shliq bilan minglik guruhlaymiz (45 231, 5 000 000) — `fmt` bilan
// bir xil ko'rinish.
function groupSpaces(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Ko'rinish maydoniga kirganda 0 dan maqsadli songacha animatsion sanaydigan
 * raqam. IntersectionObserver bilan faqat ekranda ko'ringanda ishga tushadi va
 * bir marta yuradi. `prefers-reduced-motion` da darhol yakuniy qiymat.
 */
export function CountUp({
  value,
  durationMs = 1600,
  className = "",
  suffix = "",
}: {
  value: number;
  durationMs?: number;
  className?: string;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const startedRef = useRef(false);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setDisplay(value);
      return;
    }

    const run = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / durationMs);
        // easeOutCubic — boshida tez, oxirida yumshoq to'xtaydi.
        const eased = 1 - Math.pow(1 - p, 3);
        setDisplay(value * eased);
        if (p < 1) requestAnimationFrame(step);
        else setDisplay(value);
      };
      requestAnimationFrame(step);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            run();
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, durationMs]);

  return (
    <span ref={ref} className={className}>
      {groupSpaces(display)}
      {suffix}
    </span>
  );
}

export default CountUp;
