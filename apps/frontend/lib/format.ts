/**
 * Deterministik raqam formatlash.
 *
 * NEGA Intl.NumberFormat("uz-UZ") EMAS: Node (SSR) va brauzer ICU
 * kutubxonalari uz-UZ uchun HAR XIL minglik ajratgich qaytaradi —
 * serverda "5 000", klientda "5,000". Natijada React hydration
 * nomuvofiqligi: server HTML tashlab yuboriladi, konsolda xato,
 * sekinroq birinchi chizish. Donat sahifasida jonli kuzatildi.
 *
 * Qoida: foydalanuvchiga ko'rinadigan HAR QANDAY raqam shu yerdan
 * formatlanadi. Sana/vaqt uchun toLocaleDateString xavfsiz qolaveradi
 * (u ham farq qilishi mumkin, lekin loyihada faqat klient-only
 * kontekstlarda ishlatiladi).
 */

/** 1234567 → "1 234 567" (NBSP bilan — satr o'rtasida uzilmaydi). */
export function fmtNumber(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 1234567 → "1 234 567 so'm". */
export function fmtSum(n: number): string {
  return fmtNumber(n) + " so'm";
}
