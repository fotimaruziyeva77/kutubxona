// `.env` ni SHU YERDA, import paytida yuklaymiz.
//
// Nega: quyidagi qiymatlar `@Throttle(...)` DEKORATORIGA uzatiladi, dekorator
// esa modul import qilinganda — ya'ni `AppModule` tanasi ishga tushishidan
// OLDIN — hisoblanadi. `ConfigModule.forRoot()` dotenv'ni faqat `AppModule`
// import massivi bajarilganda o'qiydi, shuning uchun kontroller dekoratorida
// `process.env.X` hali bo'sh bo'lardi va `.env` dagi sozlama e'tiborsiz
// qolardi. `dotenv/config` idempotent — ikki marta chaqirilsa zarar yo'q.
import "dotenv/config";

/**
 * Auth endpointlari uchun rate-limit sozlamalari.
 *
 * DEFAULT QIYMATLAR ISHLAB CHIQARISH UCHUN: 15 daqiqada 10 ta login urinishi —
 * parolni brute-force qilishga qarshi himoya. `.env` da o'zgaruvchi
 * berilmasa AYNAN shu qiymatlar amal qiladi, ya'ni ishlab chiqarish
 * xavfsizligi o'zgarmaydi.
 *
 * Nega sozlanadigan qilingan: lokal va demo muhitida butun trafik Next.js
 * proksisi orqali BITTA IP (127.0.0.1) dan ko'rinadi. Jonli ko'rsatuvda 5 ta
 * rolni ketma-ket almashtirish 10 ta urinishni yeb qo'yadi va namoyish
 * o'rtasida 15 daqiqa kutishga to'g'ri keladi. Bu `.env` dagi mavjud
 * THROTTLE_* override'lari bilan bir xil yondashuv.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Login oynasi (ms). Default 15 daqiqa. */
export const AUTH_LOGIN_TTL_MS = envInt("THROTTLE_LOGIN_TTL_MS", 900_000);

/** Login urinishlari soni. Default 10. */
export const AUTH_LOGIN_LIMIT = envInt("THROTTLE_LOGIN_LIMIT", 10);

/** OTP yuborish oynasi (ms). Default 1 soat. */
export const AUTH_OTP_SEND_TTL_MS = envInt("THROTTLE_OTP_SEND_TTL_MS", 3_600_000);

/** OTP yuborish soni. Default 5 — SMS xarajati bilan bog'liq. */
export const AUTH_OTP_SEND_LIMIT = envInt("THROTTLE_OTP_SEND_LIMIT", 5);

/** OTP tasdiqlash oynasi (ms). Default 15 daqiqa. */
export const AUTH_OTP_VERIFY_TTL_MS = envInt("THROTTLE_OTP_VERIFY_TTL_MS", 900_000);

/** OTP tasdiqlash urinishlari. Default 10. */
export const AUTH_OTP_VERIFY_LIMIT = envInt("THROTTLE_OTP_VERIFY_LIMIT", 10);
