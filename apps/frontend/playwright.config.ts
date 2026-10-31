import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright — smoke E2E (login → qidiruv → bron).
 *
 * HAQIQIY backend + seed DB bilan ishlaydi (mock yo'q): pilot oldidan asosiy
 * oqim butun zanjir bo'ylab — brauzer → Next proxy (/api) → NestJS → Postgres —
 * tekshiriladi.
 *
 * Lokal: `npm run dev` (backend :4000) va frontend :3000 ISHLAB TURGAN bo'lishi
 *   kerak — testlar ularni qayta ishlatadi, server ko'tarmaydi.
 * CI (`CI=1`): webServer backend'ni (`apps/backend/dist`) va frontend'ni
 *   (`next start`, oldindan build qilingan) o'zi ko'taradi — .github/workflows/ci.yml `e2e`.
 */
const FRONTEND_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const BACKEND_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  // Dev rejimida birinchi ochilish (route kompilyatsiyasi) 30–60 s olishi mumkin.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: FRONTEND_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: isCI
    ? [
        {
          command: "node dist/main.js",
          cwd: "../backend",
          url: `${BACKEND_URL}/health`,
          timeout: 180_000,
          reuseExistingServer: false,
          // development: PRODUCTION_REQUIRED_ENV assert'lari va Kafka/MinIO
          // fail-closed tekshiruvlari o'tkazib yuboriladi (no-op rejim).
          env: { NODE_ENV: "development" },
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "npm run start",
          url: FRONTEND_URL,
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
        },
      ]
    : undefined,
});
