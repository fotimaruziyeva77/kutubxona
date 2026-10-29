/**
 * api-error.ts — HTTP/tarmoq xatolarini INSON TILIDAGI xabarga aylantirish.
 *
 * DESIGN.md §7: foydalanuvchiga hech qachon "500 Internal Server Error" yoki
 * `err.message` xom ko'rinishda ko'rsatilmaydi — u nima bo'lgani va NIMA
 * QILISHI kerakligini tushunishi shart.
 *
 * Backend `AllExceptionsFilter` (apps/backend) xatolarni
 * `{ message: string | string[] }` shaklida qaytaradi — class-validator
 * massiv beradi. Shu ikkala shakl ham qo'llab-quvvatlanadi.
 */

export type ApiErrorLike = {
  status?: number;
  message?: string | string[];
  /** apiClient() javobidan olingan xom body */
  body?: unknown;
};

/** Status kodlar uchun zaxira (fallback) xabarlar. */
const STATUS_MESSAGES: Record<number, string> = {
  400: "So'rovda xatolik bor. Kiritilgan ma'lumotlarni tekshirib, qayta yuboring.",
  401: "Sessiya muddati tugagan. Iltimos, qaytadan tizimga kiring.",
  403: "Bu amalni bajarish uchun ruxsatingiz yo'q.",
  404: "So'ralgan ma'lumot topilmadi. U o'chirilgan bo'lishi mumkin.",
  409: "Bu ma'lumot allaqachon mavjud yoki holati o'zgargan. Sahifani yangilang.",
  410: "Muddat tugagan. Yangi kod yoki havolani so'rang.",
  413: "Fayl hajmi juda katta. Kichikroq fayl tanlang.",
  422: "Kiritilgan ma'lumotlar to'g'ri emas. Maydonlarni tekshiring.",
  429: "Juda ko'p urinish. Bir necha daqiqadan so'ng qayta urinib ko'ring.",
  500: "Serverda kutilmagan xatolik. Birozdan so'ng qayta urinib ko'ring.",
  502: "Server vaqtincha javob bermayapti. Birozdan so'ng qayta urinib ko'ring.",
  503: "Xizmat vaqtincha ishlamayapti (texnik ishlar). Keyinroq urinib ko'ring.",
  504: "Server javobi kechikdi. Internet aloqangizni tekshirib, qayta urining.",
};

const NETWORK_MESSAGE =
  "Internet aloqasi yo'q. Ulanishni tekshirib, qayta urinib ko'ring.";

/**
 * Backend qaytargan xabar foydalanuvchiga ko'rsatishga yaroqlimi?
 *
 * NestJS 500 xatolarda generic "Internal server error" beradi va
 * class-validator xabarlari o'zbekcha yozilgan — ularni ko'rsatamiz.
 * Lekin stack trace / ichki texnik matnlarni yashiramiz.
 */
function isPresentable(msg: string): boolean {
  if (!msg) return false;
  if (msg.length > 200) return false;
  const technical = [
    "Internal server error",
    "Request failed with status",
    "Network Error",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "prisma",
    "PrismaClient",
    "at ", // stack trace qoldig'i
  ];
  return !technical.some((t) => msg.toLowerCase().includes(t.toLowerCase()));
}

/**
 * Har qanday xato obyektidan ko'rsatiladigan bitta jumla qaytaradi.
 *
 * @example
 *   const res = await apiClient("/libraries", { method: "POST", ... });
 *   if (!res.ok) toast.error(await toUserMessage(res));
 */
export function apiErrorMessage(err: ApiErrorLike | null | undefined): string {
  if (!err) return STATUS_MESSAGES[500];

  // 1) Backend bergan aniq xabar — eng foydali variant.
  const raw = Array.isArray(err.message) ? err.message[0] : err.message;
  if (typeof raw === "string" && isPresentable(raw)) return raw;

  // 2) Tarmoq uzilgan (status yo'q yoki 0).
  if (!err.status || err.status === 0) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return NETWORK_MESSAGE;
    }
    return STATUS_MESSAGES[500];
  }

  // 3) Status bo'yicha zaxira.
  return STATUS_MESSAGES[err.status] ?? STATUS_MESSAGES[500];
}

/**
 * `apiClient()` javobidan (ok=false) xabar chiqaradi — body'ni o'qiydi.
 */
export async function responseErrorMessage(res: {
  status: number;
  json: () => Promise<unknown>;
}): Promise<string> {
  let body: { message?: string | string[] } = {};
  try {
    body = ((await res.json()) as typeof body) ?? {};
  } catch {
    // JSON emas (HTML xato sahifasi / bo'sh javob) — statusga tayanamiz.
  }
  return apiErrorMessage({ status: res.status, message: body.message });
}

/** Axios/fetch istisnosidan xabar — try/catch bloklari uchun. */
export function thrownErrorMessage(e: unknown): string {
  const anyErr = e as {
    response?: { status?: number; data?: { message?: string | string[] } };
    message?: string;
  };
  if (anyErr?.response) {
    return apiErrorMessage({
      status: anyErr.response.status,
      message: anyErr.response.data?.message,
    });
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return NETWORK_MESSAGE;
  }
  return apiErrorMessage({ message: anyErr?.message });
}
