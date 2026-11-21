import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * E2E uchun umumiy yordamchilar (smoke.spec.ts, a11y.spec.ts).
 *
 * Ma'lumot: `apps/backend/prisma/seed.ts` demo akkauntlari (faqat dev/CI;
 * production'da seed ishlamaydi). Parol — seed'dagi `DEMO_PASSWORD` bilan
 * BIR manba: shu fayldan o'qiladi (`E2E_DEMO_PASSWORD` env bilan almashtirsa bo'ladi).
 */
export const LOCALE = "uz-Latn";

/** Seed demo akkauntlari — telefon raqamining +998 dan keyingi 9 raqami. */
export const ACCOUNTS = {
  /** Sanjar Yusupov (talaba): muddati o'tgan kitobi yo'q — bron bloklanmaydi. */
  reader: "901234570",
  /** Nodira Aliyeva — KUTUBXONACHI (seed ro'yxati #6). */
  librarian: "900000006",
  /** Ravshan Sobirov — MUASSASA_ADMIN (seed ro'yxati #5). */
  institutionAdmin: "900000005",
} as const;

export function demoPasswordFromSeed(): string {
  const seedPath = path.resolve(__dirname, "../../backend/prisma/seed.ts");
  const match = readFileSync(seedPath, "utf8").match(/const DEMO_PASSWORD = "([^"]+)"/);
  if (!match) throw new Error(`DEMO_PASSWORD topilmadi: ${seedPath}`);
  return match[1];
}
export const PASSWORD = process.env.E2E_DEMO_PASSWORD ?? demoPasswordFromSeed();

/**
 * Telefon + parol bilan kiradi va kirishdan keyingi sahifani kutadi.
 * Kitobxon → `/profile`; rollar → `/dashboard[/...]` (login/page.tsx yo'naltirishi).
 */
export async function login(
  page: Page,
  phoneDigits: string = ACCOUNTS.reader,
  expectUrl: string = `**/${LOCALE}/profile`
) {
  await page.goto(`/${LOCALE}/login`);
  await page.locator('input[type="tel"]').fill(phoneDigits);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Kirish" }).click();
  await page.waitForURL(expectUrl);
}

/**
 * Sahifa «tinchiguncha» kutadi: `load` + tarmoq bo'shashi (React Query
 * so'rovlari tugashi). Dev rejimida HMR tufayli networkidle kelmasa ham
 * 15 s dan keyin davom etadi — audit baribir o'tkaziladi.
 */
export async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}
