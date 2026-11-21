import { test, expect, type Page } from "@playwright/test";
import { LOCALE, login } from "./helpers";

/**
 * Smoke E2E — kitobxonning asosiy oqimi (TZ Sprint 4 MVP mezoni):
 *
 *   login → qidiruv (`?q=` URL'dan o'qiladi) → kutubxona sahifasi → bron →
 *   «keyingi qadam» oynasi → profil «Bronlarim» → bron bekor qilinadi.
 *
 * Oxirgi qadam — TOZALASH: test o'z izini qoldirmaydi, shuning uchun bir xil
 * seed bazasida qayta-qayta ishlaydi (lokal va CI).
 *
 * Akkaunt va parol — `./helpers` (seed `DEMO_PASSWORD` bilan bir manba).
 */
const BOOK_TITLE = "Alkimyogar";

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
