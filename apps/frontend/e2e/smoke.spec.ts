import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke E2E — kitobxonning asosiy oqimi (TZ Sprint 4 MVP mezoni):
 *
 *   login → qidiruv (`?q=` URL'dan o'qiladi) → kutubxona sahifasi → bron →
 *   «keyingi qadam» oynasi → profil «Bronlarim» → bron bekor qilinadi.
 *
 * Oxirgi qadam — TOZALASH: test o'z izini qoldirmaydi, shuning uchun bir xil
 * seed bazasida qayta-qayta ishlaydi (lokal va CI).
 *
 * Ma'lumot: `apps/backend/prisma/seed.ts` demo akkauntlari (faqat dev/CI;
 * production'da seed ishlamaydi). Parol — seed'dagi `DEMO_PASSWORD` bilan
 * BIR manba: shu fayldan o'qiladi (`E2E_DEMO_PASSWORD` env bilan almashtirsa bo'ladi).
 */
const LOCALE = "uz-Latn";
// Sanjar Yusupov (talaba): muddati o'tgan kitobi yo'q — bron bloklanmaydi.
const READER_PHONE_DIGITS = "901234570";
const BOOK_TITLE = "Alkimyogar";

function demoPasswordFromSeed(): string {
  const seedPath = path.resolve(__dirname, "../../backend/prisma/seed.ts");
  const match = readFileSync(seedPath, "utf8").match(/const DEMO_PASSWORD = "([^"]+)"/);
  if (!match) throw new Error(`DEMO_PASSWORD topilmadi: ${seedPath}`);
  return match[1];
}
const PASSWORD = process.env.E2E_DEMO_PASSWORD ?? demoPasswordFromSeed();

async function login(page: Page) {
  await page.goto(`/${LOCALE}/login`);
  await page.locator('input[type="tel"]').fill(READER_PHONE_DIGITS);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Kirish" }).click();
  await page.waitForURL(`**/${LOCALE}/profile`);
}

/** Profil «Bronlarim» bo'limidagi barcha bronlarni bekor qiladi (idempotent). */
async function cancelAllReservations(page: Page) {
  await page.goto(`/${LOCALE}/profile`);
  // Profil ma'lumoti yuklanishini kutamiz (ism kartasi chiqadi).
  await expect(page.getByRole("heading", { name: "Qo'limdagi kitoblar" }).or(page.getByText("Yillik maqsad"))).toBeVisible();
  const cancelButtons = page
    .locator("section", { has: page.getByRole("heading", { name: "Bronlarim" }) })
    .getByRole("button", { name: "Bekor qilish" });
  for (let i = 0; i < 10 && (await cancelButtons.count()) > 0; i++) {
    await cancelButtons.first().click();
    await page.waitForTimeout(800);
  }
  await expect(page.getByRole("heading", { name: "Bronlarim" })).toHaveCount(0);
}

test.describe("Kitobxon smoke oqimi", () => {
  test("login → qidiruv → bron → keyingi qadam → bronlarim → bekor", async ({ page }) => {
    await login(page);
    await cancelAllReservations(page);

    // ── Qidiruv: `?q=` URL parametri maydonga tushadi va natija keladi ──────
    await page.goto(`/${LOCALE}/search?q=${encodeURIComponent(BOOK_TITLE)}`);
    await expect(page.getByPlaceholder(/ISBN/)).toHaveValue(BOOK_TITLE);
    // Natija kartasi — kutubxona sahifasiga havola. hasText SHART: navigatsiyada
    // ham /library/ havolasi bor (muassasa kitobxoni uchun «Kutubxonam» tabi).
    const firstLibraryLink = page
      .locator('a[href*="/library/"]', { hasText: BOOK_TITLE })
      .first();
    await expect(firstLibraryLink).toBeVisible();

    // ── Kutubxona sahifasi: shu kitob kartasida «Bron qilish» ───────────────
    await firstLibraryLink.click();
    await page.waitForURL(`**/${LOCALE}/library/**`);
    const bookCard = page.locator("article", { hasText: BOOK_TITLE }).first();
    await expect(bookCard).toBeVisible();
    await bookCard.getByRole("button", { name: "Bron qilish" }).click();

    // ── «Keyingi qadam» oynasi ──────────────────────────────────────────────
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Bron yuborildi");
    await expect(dialog).toContainText(BOOK_TITLE);
    await expect(dialog).toContainText("Kutubxonachi tasdiqlaydi");
    await expect(dialog.getByRole("link", { name: "QR kodim" })).toHaveAttribute(
      "href",
      `/${LOCALE}/profile#qr`
    );
    await dialog.getByRole("link", { name: "Bronlarim" }).click();

    // ── Profil: bron ro'yxatda, holati «Kutilmoqda», tasdiq muddati bor ─────
    await page.waitForURL(`**/${LOCALE}/profile`);
    const bronSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Bronlarim" }),
    });
    await expect(bronSection).toBeVisible();
    await expect(bronSection).toContainText(BOOK_TITLE);
    await expect(bronSection).toContainText("Kutilmoqda");
    await expect(bronSection).toContainText("gacha tasdiq kutiladi");

    // ── Tozalash: bekor qilish → bo'lim yo'qoladi ───────────────────────────
    await bronSection.getByRole("button", { name: "Bekor qilish" }).first().click();
    await expect(page.getByRole("heading", { name: "Bronlarim" })).toHaveCount(0);
  });
});
