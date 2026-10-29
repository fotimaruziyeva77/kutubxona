/**
 * Enum → o'zbekcha yorliq.
 *
 * Nima uchun bitta joyda: audit paytida beshta sahifa deyarli bir xil
 * xaritani o'zida nusxalagani, YANA to'rttasi esa xom enum ni to'g'ridan-
 * to'g'ri ekranga chiqarayotgani aniqlandi. Natijada bitta jadvalda filtr
 * "Faol" deb yozilgan, ustundagi katak esa "ACTIVE" deb turardi.
 *
 * Qoida: foydalanuvchi ko'radigan hech bir joyda xom enum bo'lmasin.
 * Yangi status qo'shilsa — SHU YERGA qo'shiladi.
 */

/** Foydalanuvchi / xodim / talaba holati. */
export const USER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Faol",
  PENDING: "Kutilmoqda",
  BLOCKED: "Bloklangan",
  DELETED: "O'chirilgan",
  REJECTED: "Rad etilgan",
};

/** Obuna holati (subscriptions, buxgalter, muassasa). */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  TRIAL: "Sinov muddati",
  ACTIVE: "Faol",
  PENDING: "To'lov kutilmoqda",
  FROZEN: "Muzlatilgan",
  DELETED: "O'chirilgan",
  EXPIRED: "Muddati tugagan",
};

/** Kutubxona holati. */
export const LIBRARY_STATUS_LABELS: Record<string, string> = {
  PENDING: "Kutilmoqda",
  ACTIVE: "Faol",
  FROZEN: "Muzlatilgan",
  DELETED: "O'chirilgan",
};

/** Kutubxona tipi (TZ III.3). */
export const LIBRARY_TYPE_LABELS: Record<string, string> = {
  GOV: "Davlat",
  SCH: "Maktab",
  UNI: "OTM",
  ORG: "Idora",
  MAH: "Mahalla",
};

/** Faktura / to'lov holati. */
export const INVOICE_STATUS_LABELS: Record<string, string> = {
  PENDING: "To'lanmagan",
  PAID: "To'langan",
  OVERDUE: "Muddati o'tgan",
  CANCELLED: "Bekor qilingan",
};

/** Bron / kitob berish holati. */
export const TRANSACTION_STATUS_LABELS: Record<string, string> = {
  PENDING: "Kutilmoqda",
  RESERVED: "Rezerv qilingan",
  BORROWED: "Olingan",
  RETURNED: "Qaytarilgan",
  COMPLETED: "Yakunlangan",
  CANCELLED: "Bekor qilingan",
  EXPIRED: "Muddati o'tgan",
};

/** Tarif rejasi (TZ XIII.1). */
export const PLAN_LABELS: Record<string, string> = {
  GOV: "Davlat byudjeti",
  MAH: "Mahalla — davlat byudjeti",
  EDU_SCH: "Maktab tarifi",
  "EDU-SCH": "Maktab tarifi",
  SCH_STANDARD: "Maktab — standart",
  EDU_UNI: "OTM tarifi",
  "EDU-UNI": "OTM tarifi",
  UNI_STANDARD: "OTM — standart",
  ORG: "Idora tarifi",
  ORG_STANDARD: "Idora — standart",
  BASIC: "Boshlang'ich",
  STANDARD: "Standart",
  PRO: "Kengaytirilgan",
  PRO_YEARLY: "Kengaytirilgan — yillik",
};

/** Ogohlantirish darajasi. */
export const SEVERITY_LABELS: Record<string, string> = {
  CRITICAL: "Kritik",
  HIGH: "Yuqori",
  MEDIUM: "O'rta",
  LOW: "Past",
  INFO: "Axborot",
};

/** Tadbir / debat holati. */
export const EVENT_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Qoralama",
  PUBLISHED: "E'lon qilingan",
  CANCELLED: "Bekor qilingan",
};

/**
 * Yorliqni xavfsiz olish: xarita topilmasa xom enum EMAS, o'qilishi mumkin
 * bo'lgan matn qaytadi ("PRO_YEARLY" → "Pro yearly"). Shunda yangi enum
 * qo'shilib, bu yerga yozish unutilsa ham ekranda SCREAMING_CASE chiqmaydi.
 */
export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  const hit = map[value];
  if (hit) return hit;
  const soft = value.replace(/[_-]+/g, " ").toLowerCase();
  return soft.charAt(0).toUpperCase() + soft.slice(1);
}
