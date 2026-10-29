/**
 * motion.ts — loyiha bo'ylab YAGONA animatsiya tili (DESIGN.md §10).
 *
 * Nega markazlashtirilgan: har sahifa o'z `duration`/`ease` qiymatini
 * tanlasa, interfeys "har xil joydan yig'ilgan" bo'lib ko'rinadi. Bu yerdagi
 * variantlar bir xil ritm beradi — foydalanuvchi harakatni o'rganib oladi va
 * u ko'zga tashlanmay qoladi (yaxshi animatsiya sezilmaydi, faqat "silliq"
 * hissi qoladi).
 *
 * TEZLIK BYUDJETI:
 *   - mikro (hover, bosish):     0.12–0.15s
 *   - element kirishi:           0.25s
 *   - modal / panel:             0.2s
 *   - ro'yxat kaskadi (stagger): element boshiga 0.04s, jami ≤ 0.4s
 * 0.4s dan uzun har qanday animatsiya kutish hissini beradi — taqiqlanadi.
 *
 * ⚠️ MAXSUS EHTIYOT — `prefers-reduced-motion`:
 * Vestibulyar buzilishi bor foydalanuvchilar uchun siljish/masshtab
 * animatsiyalari bosh aylanishiga sabab bo'ladi. Har bir variant
 * `useReducedMotion()` bilan juftlashtirilgan `reduced` shakliga ega —
 * unda faqat opacity o'zgaradi. Bu WCAG 2.1 (2.3.3) talabi va TZ §X
 * accessibility 90+ maqsadining bir qismi.
 */

import type { Transition, Variants } from "motion/react";

// ── Asosiy o'tishlar ────────────────────────────────────────────────────────

/** Standart element kirishi — tabiiy sekinlashuv. */
export const EASE_OUT: Transition = {
  duration: 0.25,
  ease: [0.16, 1, 0.3, 1], // ~easeOutExpo: tez boshlanadi, yumshoq to'xtaydi
};

/** Modal / panel — biroz tezroq, chunki foydalanuvchi javob kutmoqda. */
export const EASE_MODAL: Transition = {
  duration: 0.2,
  ease: [0.16, 1, 0.3, 1],
};

/** Bosish/hover mikro-javobi. */
export const EASE_MICRO: Transition = {
  duration: 0.14,
  ease: [0.4, 0, 0.2, 1],
};

/**
 * Prujina — faqat "muvaffaqiyat" belgilarida. Boshqa joyda ishlatilmaydi:
 * prujina uzunligi oldindan bilinmaydi va ro'yxatlarda betartib ko'rinadi.
 */
export const SPRING_POP: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.8,
};

// ── Variantlar ──────────────────────────────────────────────────────────────

/** Pastdan silliq chiqish — kartalar, bo'lim bloklari. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: EASE_OUT },
};

/** Faqat xiralik — reduced-motion holati va matn bloklari uchun. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: EASE_OUT },
};

/**
 * Ro'yxat konteyneri — bolalarni ketma-ket ishga tushiradi.
 * `staggerChildren` kichik (0.04s): 10 ta karta 0.4s da tugaydi.
 */
export const staggerContainer: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.04, delayChildren: 0.02 },
  },
};

/** Modal oynasi. */
export const modalPanel: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0, transition: EASE_MODAL },
  exit: { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.15 } },
};

/** Modal orqa fon qoraytmasi. */
export const modalBackdrop: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

/**
 * Toast — mobilda pastdan, desktopda o'ngdan kiradi. Yo'nalish `fromRight`
 * bilan boshqariladi (chaqiruvchi media-so'rovni biladi).
 */
export function toastVariants(fromRight: boolean): Variants {
  return {
    hidden: { opacity: 0, y: fromRight ? 0 : 16, x: fromRight ? 24 : 0, scale: 0.98 },
    visible: { opacity: 1, y: 0, x: 0, scale: 1, transition: EASE_OUT },
    exit: {
      opacity: 0,
      x: fromRight ? 24 : 0,
      y: fromRight ? 0 : 16,
      scale: 0.98,
      transition: { duration: 0.15 },
    },
  };
}

// ── Reduced-motion yordamchilari ────────────────────────────────────────────

/**
 * Variantni harakatsiz (faqat opacity) shaklga aylantiradi.
 *
 * Ishlatilishi:
 *   const reduce = useReducedMotion();
 *   <motion.div variants={respectMotion(fadeUp, reduce)} … />
 */
export function respectMotion(variants: Variants, reduce: boolean | null): Variants {
  if (!reduce) return variants;
  return fadeIn;
}

/** Bosish mikro-effekti — reduced-motion'da o'chadi. */
export function tapScale(reduce: boolean | null) {
  return reduce ? undefined : { scale: 0.98 };
}

/** Hover ko'tarilishi — reduced-motion'da o'chadi. */
export function hoverLift(reduce: boolean | null) {
  return reduce ? undefined : { y: -2 };
}
