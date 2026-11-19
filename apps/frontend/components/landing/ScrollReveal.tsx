"use client";

import { useEffect } from "react";

/**
 * Skroll animatsiyasi — `[data-reveal]` (blok) va `[data-reveal-stagger]`
 * (bolalari navbat bilan) elementlar ekranga kirganda `is-in` oladi.
 *
 * Progressiv: SSR/JS'siz kontent doim ko'rinadi — yashirish faqat
 * `<html class="reveal-ready">` bo'lganda ishlaydi. Mount paytida allaqachon
 * ekranda turgan elementlar oldindan `is-in` oladi, shuning uchun "ko'rindi →
 * yo'qoldi → paydo bo'ldi" miltillashi bo'lmaydi.
 */
export function ScrollReveal() {
  useEffect(() => {
    const root = document.documentElement;
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal],[data-reveal-stagger]")
    );
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("is-in"));
      return;
    }

    const vh = window.innerHeight;
    els.forEach((el) => {
      if (el.getBoundingClientRect().top < vh * 0.92) el.classList.add("is-in");
    });
    root.classList.add("reveal-ready");

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    els.forEach((el) => {
      if (!el.classList.contains("is-in")) io.observe(el);
    });

    return () => {
      io.disconnect();
      root.classList.remove("reveal-ready");
    };
  }, []);

  return null;
}
