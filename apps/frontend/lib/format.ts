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

/**
 * "KK.OO, SS:DD" — Toshkent vaqti bo'yicha kun.oy va soat:daqiqa.
 *
 * Nega `Intl` oy nomlari emas: ba'zi brauzer ICU to'plamlarida `uz-Latn` /
 * `kaa` uchun oy nomlari yo'q — `month: "long"` "M11" bo'lib chiqadi, root
 * fallback esa "11-01" tartibini beradi. Raqamli, qat'iy tartibli format har
 * tilda bir xil o'qiladi. Yaroqsiz sana → "—".
 */
export function fmtDayMonthTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}, ${get("hour")}:${get("minute")}`;
}
