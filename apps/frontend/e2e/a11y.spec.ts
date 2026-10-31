import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { ACCOUNTS, LOCALE, login, settle } from "./helpers";

/**
 * axe-core WCAG 2.1 A/AA audit — HAQIQIY render qilingan sahifalar
 * (TZ Sprint 10 #9: WCAG 2.1, Accessibility 90+).
 *
 * `tests/accessibility/axe-audit.spec.ts` JSDOM'da statik fixture'larni
 * tekshiradi (layout/rang yo'q). Bu spec esa brauzerda, ishlab turgan ilovaga
 * qarshi: rang kontrasti, label, landmark, lang, nom-rol-qiymat va h.k.
 *
 * Qoida: `critical` va `serious` = qizil. `moderate`/`minor` — Playwright
 * hisobotiga ilova (attachments) qilinadi va konsolga yoziladi, yiqitmaydi.
 * Har sahifa uchun to'liq axe JSON ham ilova qilinadi.
 *
 * axe-core — frontend devDependency; brauzerga `addScriptTag` bilan kiritiladi
 * (qo'shimcha paket kerak emas).
 */
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type AxeNode = { html: string; target: string[]; failureSummary?: string };
type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
};
type AxeRunResult = {
  violations: AxeViolation[];
  passes: { id: string }[];
  incomplete: { id: string }[];
};

async function runAxe(page: Page): Promise<AxeRunResult> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate((tags) => {
    const axe = (window as unknown as {
      axe: { run: (ctx: Document, opts: unknown) => Promise<AxeRunResult> };
    }).axe;
    return axe.run(document, {
      runOnly: { type: "tag", values: tags },
      resultTypes: ["violations", "incomplete", "passes"],
    });
  }, WCAG_TAGS);
}

function describeViolation(v: AxeViolation): string {
  const nodes = v.nodes
    .slice(0, 5)
    .map((n) => `    - ${n.target.join(" ")}\n      ${n.html.replace(/\s+/g, " ").slice(0, 160)}`)
    .join("\n");
  const more = v.nodes.length > 5 ? `\n    … yana ${v.nodes.length - 5} ta element` : "";
  return `[${(v.impact ?? "?").toUpperCase()}] ${v.id}: ${v.help}\n  ${v.helpUrl}\n${nodes}${more}`;
}

async function expectNoSeriousViolations(page: Page, name: string) {
  const { violations, passes, incomplete } = await runAxe(page);
  const blocking = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  const advisory = violations.filter((v) => !blocking.includes(v));

  await test.info().attach(`axe-${name}.json`, {
    body: JSON.stringify(
      { url: page.url(), violations, incomplete: incomplete.map((i) => i.id), passes: passes.length },
      null,
      2
    ),
    contentType: "application/json",
  });
  if (advisory.length > 0) {
    console.log(
      `[axe] ${name}: ${advisory.length} ta moderate/minor (yiqitmaydi):\n` +
        advisory.map(describeViolation).join("\n")
    );
  }

  const report = blocking.map(describeViolation).join("\n\n");
  expect(report, `${name}: ${blocking.length} ta critical/serious WCAG buzilish`).toBe("");
}

/** Ochiq sahifalar — login talab qilmaydi. */
const PUBLIC_PAGES: { name: string; path: string }[] = [
  { name: "landing", path: `/${LOCALE}` },
  { name: "top", path: `/${LOCALE}/top` },
  { name: "login", path: `/${LOCALE}/login` },
  { name: "register", path: `/${LOCALE}/register` },
  { name: "donate", path: `/${LOCALE}/donate` },
];

test.describe("WCAG 2.1 AA — axe, haqiqiy sahifalar", () => {
  for (const { name, path } of PUBLIC_PAGES) {
    test(`${name} (${path})`, async ({ page }) => {
      await page.goto(path);
      await settle(page);
      await expectNoSeriousViolations(page, name);
    });
  }

  test("profile — kitobxon (login)", async ({ page }) => {
    await login(page);
    await settle(page);
    await expectNoSeriousViolations(page, "profile");
  });

  // Qidiruv login'dan keyin: anonim foydalanuvchi /search ga kirsa ilova
  // uni /login ga yo'naltiradi (2026-10-31 da kuzatildi) — auditda login
  // sahifasi ikki marta tekshirilib, qidiruv natijalari umuman tekshirilmasdi.
  test("search — kitobxon (login, ?q=)", async ({ page }) => {
    await login(page);
    await page.goto(`/${LOCALE}/search?q=Alkimyogar`);
    await settle(page);
    await expect(page.locator('a[href*="/library/"]', { hasText: "Alkimyogar" }).first()).toBeVisible();
    await expectNoSeriousViolations(page, "search");
  });

  test("dashboard — kutubxonachi (login)", async ({ page }) => {
    await login(page, ACCOUNTS.librarian, `**/${LOCALE}/dashboard**`);
    await settle(page);
    await expectNoSeriousViolations(page, "dashboard-kutubxonachi");
  });

  test("dashboard — muassasa admin (login)", async ({ page }) => {
    await login(page, ACCOUNTS.institutionAdmin, `**/${LOCALE}/dashboard**`);
    await settle(page);
    await expectNoSeriousViolations(page, "dashboard-muassasa");
  });
});
