/**
 * user-select.const.ts — `User` qatorini API javobiga chiqarish uchun oq ro'yxat.
 *
 * Muammo: loyihada global `ClassSerializerInterceptor` yo'q, `User` modelida esa
 * `passwordHash` (bcrypt) va `pinfl` (davlat identifikatori) maydonlari bor.
 * `select` siz `prisma.user.findMany()` shu maydonlarni HTTP javobiga olib
 * chiqadi — ya'ni har bir MUASSASA_ADMIN / TUMAN_ADMIN o'z ko'rish doirasidagi
 * foydalanuvchilarning parol hash'larini oflayn buzish uchun yuklab olishi
 * mumkin bo'lardi.
 *
 * Shu sababli foydalanuvchi qatorini qaytaradigan HAR BIR endpoint aniq
 * `select` ishlatishi shart. Yangi maydon qo'shilganda u avtomatik oqib
 * ketmasligi uchun ro'yxat oq ro'yxat (allowlist) tarzida yozilgan — qora
 * ro'yxat emas.
 *
 * ⚠️ Bu ro'yxatga HECH QACHON qo'shmang: passwordHash, pinfl, refreshTokens.
 */

/** Admin ro'yxatlari uchun minimal xavfsiz maydonlar to'plami. */
export const USER_PUBLIC_SELECT = {
  id: true,
  sifatId: true,
  name: true,
  phone: true,
  type: true,
  status: true,
  role: true,
  gender: true,
  dob: true,
  trustScore: true,
  createdAt: true,
} as const;

/** Admin ro'yxatlari + manzil (PENDING tasdiqlash navbati uchun). */
export const USER_PUBLIC_SELECT_WITH_ADDRESS = {
  ...USER_PUBLIC_SELECT,
  address: {
    select: {
      viloyatId: true,
      tumanId: true,
      mahallaId: true,
      street: true,
      house: true,
      apartment: true,
    },
  },
} as const;

/**
 * Cron / ichki jarayonlar uchun: faqat SMS yuborish va status yangilash uchun
 * zarur maydonlar. Bu yo'llar HTTP javobiga chiqmaydi, lekin butun qatorni
 * xotiraga yuklash 5M foydalanuvchida keraksiz — shuning uchun tor select.
 */
export const USER_NOTIFY_SELECT = {
  id: true,
  phone: true,
  name: true,
} as const;
