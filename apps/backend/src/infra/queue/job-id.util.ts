/**
 * BullMQ custom `jobId` quruvchisi.
 *
 * MUAMMO: BullMQ (v5) `jobId` ni quyidagi qoida bilan tekshiradi
 * (node_modules/bullmq/dist/cjs/classes/job.js):
 *
 *   if (jobId.includes(':') && jobId.split(':').length !== 3) {
 *     throw new Error('Custom Id cannot contain :');
 *   }
 *
 * Ya'ni ikki nuqtali ID (`a:b:c`) eski takrorlanuvchi joblar bilan
 * moslik uchun O'TADI, lekin bitta yoki uchtadan ko'p nuqtali ID
 * ISTISNO tashlaydi. Kod bazasida ikkala shakl ham ishlatilgan edi,
 * shuning uchun bir qismi jimgina ishlamay qolgan:
 *
 *   `demo-request-notify:<id>`        → 2 qism → ISTISNO
 *   `warm-national:<bucket>`          → 2 qism → ISTISNO
 *   `monthly-report:national:UZ:<oy>` → 4 qism → ISTISNO
 *   `payment-timeout:<id>`            → 2 qism → ISTISNO
 *
 * Istisno chaqiruvchi tomonda `try/catch` bilan yutilgani uchun xato
 * faqat `warn` logida qolgan va vazifa umuman bajarilmagan.
 *
 * Ikkinchi qoida: butunlay raqamli ID ham rad etiladi ("Custom Id cannot
 * be integers"), shuning uchun prefiks har doim harfdan boshlanadi.
 *
 * YECHIM: ajratgich sifatida `:` o'rniga `-` ishlatiladi. Qismlar ichidagi
 * `:` ham tozalanadi, shuning uchun qiymat qayerdan kelishidan qat'i
 * nazar ID yaroqli bo'ladi. Noyoblik saqlanadi — qismlar tartibi va
 * to'plami o'zgarmaydi, faqat ajratgich almashadi.
 */
export function buildJobId(...parts: (string | number | null | undefined)[]): string {
  const cleaned = parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).replace(/:/g, "-"));

  if (cleaned.length === 0) {
    throw new Error("buildJobId: kamida bitta bo'sh bo'lmagan qism kerak");
  }

  return cleaned.join("-");
}
