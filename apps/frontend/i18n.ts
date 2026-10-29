import { getRequestConfig } from "next-intl/server";

export const locales = ["uz-Latn", "uz-Cyrl", "ru", "kaa"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "uz-Latn";

/**
 * Panel (sahifa-darajali) tarjima modullari.
 *
 * NEGA alohida fayllar: muassasa panellari (~23 sahifa) bitta katta
 * messages/<locale>.json ga qo'shilsa, parallel ishlovchi jamoalar bitta
 * faylda to'qnashadi va har merge konflikt tarjima yo'qotish xavfi bo'ladi.
 * Har sahifa-guruh o'z faylini oladi: messages/panels/<nom>.<locale>.json —
 * bazaviy fayl esa muzlatilgan bo'lib qoladi.
 *
 * Fayl topilmasa jimgina {} — panel hali tarjima qilinmagan bosqichda
 * build sinmaydi. Har fayl FAQAT o'ziga tegishli yuqori darajali
 * namespace'larni saqlaydi, shu sabab oddiy Object.assign yetarli
 * (chuqur merge kerak emas).
 */
const PANEL_MODULES = [
  "school",
  "club",
  "debate",
  "otm",
  "idora",
  "readingHour",
  "muassasa",
  "libraries",
  "books",
  "transactions",
  "scan",
  "registerExtra",
  "moliya",
  "adminPanels",
  "dokon",
  "reader",
] as const;

async function loadPanel(name: string, locale: string): Promise<Record<string, unknown>> {
  try {
    return (await import(`./messages/panels/${name}.${locale}.json`)).default;
  } catch {
    return {};
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = (await requestLocale) ?? defaultLocale;
  const safeLocale = locales.includes(locale as Locale) ? locale : defaultLocale;

  const base = (await import(`./messages/${safeLocale}.json`)).default;
  const panels = await Promise.all(PANEL_MODULES.map((m) => loadPanel(m, safeLocale)));

  return {
    locale: safeLocale,
    messages: Object.assign({}, base, ...panels),
  };
});
