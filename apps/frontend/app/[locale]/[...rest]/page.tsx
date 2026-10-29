import { notFound } from "next/navigation";

/**
 * Catch-all — `[locale]` ostidagi mos kelmagan har qanday manzil.
 *
 * Nega kerak: Next.js `[locale]/not-found.tsx` ni FAQAT segment ichidan
 * `notFound()` chaqirilganda ko'rsatadi. Mavjud bo'lmagan yo'l (masalan
 * /uz-Latn/xato-manzil) hech qanday route'ga tushmaydi va Next o'zining
 * standart, tilsiz va dizaynsiz 404 sahifasini beradi.
 *
 * Bu catch-all so'rovni ushlab `notFound()` chaqiradi — natijada til
 * konteksti, layout (navigatsiya, tema) va DESIGN.md §8 ga mos 404 ishlaydi.
 *
 * Boshqa barcha route'lar bundan aniqroq (more specific) bo'lgani uchun
 * Next avval ularni tanlaydi; bu fayl faqat oxirgi chora.
 */
export default function CatchAllNotFound() {
  notFound();
}
