// Import the helpers from their util files directly. main.ts re-exports the
// same symbols for back-compat, but `import ./main` would evaluate AppModule
// (which requires the real @nestjs/schedule.forRoot() at module load) — see
// jest config moduleNameMapper for the schedule mock.
import { _assertDonationStubGuard } from "./common/utils/donation-stub-guard.util";
import { _assertSubscriptionStubGuard } from "./common/utils/subscription-stub-guard.util";
import {
  _assertEnvVars,
  PRODUCTION_REQUIRED_ENV,
  isProductionEnv,
} from "./common/utils/production-env.util";

/**
 * Plan 03-01 Task 2 — DEV_DONATION_PAYMENT_STUB fail-closed guard spec.
 *
 * Mirrors the Phase 1 DEV_OTP_BYPASS allowlist pattern at
 * auth.service.ts:38-43 + main.ts:143-147. Production must fail-hard if the
 * donation payment stub is ever active — see D-DONAT-01 in 03-RESEARCH.md.
 */

describe("_assertDonationStubGuard (DEV_DONATION_PAYMENT_STUB)", () => {
  it("throws when NODE_ENV=production and DEV_DONATION_PAYMENT_STUB=true", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "production",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_DONATION_PAYMENT_STUB/);
  });

  it("does NOT throw when NODE_ENV=development and DEV_DONATION_PAYMENT_STUB=true (dev allowlist)", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "development",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=test and DEV_DONATION_PAYMENT_STUB=true", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "test",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=production and DEV_DONATION_PAYMENT_STUB is unset", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=production and DEV_DONATION_PAYMENT_STUB='false'", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "production",
        DEV_DONATION_PAYMENT_STUB: "false",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when DEV_DONATION_PAYMENT_STUB is any non-'true' string in production", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "production",
        DEV_DONATION_PAYMENT_STUB: "yes",
      }),
    ).not.toThrow();
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "production",
        DEV_DONATION_PAYMENT_STUB: "1",
      }),
    ).not.toThrow();
  });

  it("treats NODE_ENV case-insensitively: 'Production' and 'PRODUCTION' both throw", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "Production",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_DONATION_PAYMENT_STUB/);
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: "PRODUCTION",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_DONATION_PAYMENT_STUB/);
  });

  it("trims surrounding whitespace from NODE_ENV before comparison", () => {
    expect(() =>
      _assertDonationStubGuard({
        NODE_ENV: " production ",
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_DONATION_PAYMENT_STUB/);
  });

  it("does NOT throw when NODE_ENV is unset (treated as non-production)", () => {
    expect(() =>
      _assertDonationStubGuard({
        DEV_DONATION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });
});

/**
 * Plan 04-01 Task 2 — DEV_SUBSCRIPTION_PAYMENT_STUB fail-closed guard wired
 * into bootstrap() between _assertDonationStubGuard and the startup banner.
 * Smoke spec — full spec lives in subscription-stub-guard.util.spec.ts.
 */
describe("_assertSubscriptionStubGuard wired into bootstrap (smoke)", () => {
  it("throws when NODE_ENV=production and DEV_SUBSCRIPTION_PAYMENT_STUB=true", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_SUBSCRIPTION_PAYMENT_STUB/);
  });

  it("does NOT throw in dev with the flag honored", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "development",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });
});

/**
 * Plan 04-01 Task 2 — production-required env keys include the new Payme/Click
 * secrets per §VIII.3. Boot must hard-fail if any is missing.
 */
describe("_assertEnvVars (PRODUCTION_REQUIRED_ENV)", () => {
  const fullEnv = (overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv => ({
    DATABASE_URL: "x",
    JWT_SECRET: "x",
    JWT_REFRESH_SECRET: "x",
    REDIS_URL: "x",
    VAULT_TOKEN: "x",
    VAULT_ADDR: "x",
    PAYME_MERCHANT_ID: "x",
    PAYME_SECRET_KEY: "x",
    PAYME_TEST_KEY: "x",
    PAYME_LOGIN: "x",
    CLICK_MERCHANT_ID: "x",
    CLICK_SECRET_KEY: "x",
    CLICK_SERVICE_ID: "x",
    // Plan 05-01 Task 2 — FCM + SMTP production hard-fail keys
    FCM_SERVICE_ACCOUNT_KEY_PATH: "/run/secrets/fcm-sa.json",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "noreply@sifat.uz",
    SMTP_PASS: "x",
    SMTP_FROM: "SIFAT LIBRARY <noreply@sifat.uz>",
    // Plan 06-01-fix audit-HIGH — MinIO production hard-fail keys
    MINIO_ENDPOINT: "minio.local",
    MINIO_ACCESS_KEY: "x",
    MINIO_SECRET_KEY: "x",
    MINIO_BUCKET_DEBATES: "debates",
    MINIO_BUCKET_BOOKCORNERS: "bookcorners",
    MINIO_BUCKET_READINGHOURS: "readinghours",
    // AUDIT FIX H7 — Eskiz SMS + Kafka production hard-fail keys
    ESKIZ_EMAIL: "sms@sifat.uz",
    ESKIZ_PASSWORD: "x",
    KAFKA_BROKERS: "kafka:9092",
    ...overrides,
  });

  it("includes the production-required Payme + Click keys", () => {
    expect(PRODUCTION_REQUIRED_ENV).toEqual(
      expect.arrayContaining([
        "PAYME_MERCHANT_ID",
        "PAYME_SECRET_KEY",
        // FIX 7: PAYME_TEST_KEY is sandbox-only — NOT required at prod boot
        "PAYME_LOGIN",
        "CLICK_MERCHANT_ID",
        "CLICK_SECRET_KEY",
        "CLICK_SERVICE_ID",
      ]),
    );
  });

  // Plan 04-01 audit-fix FIX 7 — PAYME_TEST_KEY is the Payme sandbox
  // "Paycom" key. Correctly-configured prod containers don't have it; requiring
  // it at boot caused legitimate prod deployments to fail. Empty is safe because
  // FIX 3's empty-key reject in _verifyAuth closes the auth-bypass path.
  it("does NOT require PAYME_TEST_KEY in production (FIX 7)", () => {
    expect(PRODUCTION_REQUIRED_ENV).not.toContain("PAYME_TEST_KEY");
  });

  it("does NOT throw when every required key is present", () => {
    expect(() => _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv())).not.toThrow();
  });

  it("does NOT throw when PAYME_TEST_KEY is missing (sandbox-only)", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ PAYME_TEST_KEY: undefined })),
    ).not.toThrow();
  });

  it("throws when PAYME_SECRET_KEY is missing", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ PAYME_SECRET_KEY: undefined })),
    ).toThrow(/PAYME_SECRET_KEY/);
  });

  it("throws when PAYME_LOGIN is missing", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ PAYME_LOGIN: undefined })),
    ).toThrow(/PAYME_LOGIN/);
  });

  it("throws when CLICK_SECRET_KEY is missing", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ CLICK_SECRET_KEY: undefined })),
    ).toThrow(/CLICK_SECRET_KEY/);
  });

  it("throws when CLICK_SERVICE_ID is missing", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ CLICK_SERVICE_ID: undefined })),
    ).toThrow(/CLICK_SERVICE_ID/);
  });

  it("throws when CLICK_MERCHANT_ID is missing", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ CLICK_MERCHANT_ID: undefined })),
    ).toThrow(/CLICK_MERCHANT_ID/);
  });

  // ── Plan 05-01 Task 2: FCM + SMTP production hard-fail ──────────────────
  it("includes FCM_SERVICE_ACCOUNT_KEY_PATH + SMTP_* in PRODUCTION_REQUIRED_ENV (Plan 05-01)", () => {
    expect(PRODUCTION_REQUIRED_ENV).toEqual(
      expect.arrayContaining([
        "FCM_SERVICE_ACCOUNT_KEY_PATH",
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASS",
        "SMTP_FROM",
      ]),
    );
  });

  it("does NOT require SMTP_PORT (has default of 587)", () => {
    expect(PRODUCTION_REQUIRED_ENV).not.toContain("SMTP_PORT");
  });

  it("throws when FCM_SERVICE_ACCOUNT_KEY_PATH is missing in production", () => {
    expect(() =>
      _assertEnvVars(
        PRODUCTION_REQUIRED_ENV,
        fullEnv({ FCM_SERVICE_ACCOUNT_KEY_PATH: undefined }),
      ),
    ).toThrow(/FCM_SERVICE_ACCOUNT_KEY_PATH/);
  });

  it("throws when SMTP_HOST is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ SMTP_HOST: undefined })),
    ).toThrow(/SMTP_HOST/);
  });

  it("throws when SMTP_PASS is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ SMTP_PASS: undefined })),
    ).toThrow(/SMTP_PASS/);
  });

  it("throws when SMTP_FROM is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ SMTP_FROM: undefined })),
    ).toThrow(/SMTP_FROM/);
  });

  // ── AUDIT FIX H7: Eskiz SMS + Kafka production hard-fail ─────────────────
  it("includes ESKIZ_EMAIL + ESKIZ_PASSWORD + KAFKA_BROKERS (AUDIT FIX H7)", () => {
    expect(PRODUCTION_REQUIRED_ENV).toEqual(
      expect.arrayContaining(["ESKIZ_EMAIL", "ESKIZ_PASSWORD", "KAFKA_BROKERS"]),
    );
  });

  it("throws when ESKIZ_EMAIL is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ ESKIZ_EMAIL: undefined })),
    ).toThrow(/ESKIZ_EMAIL/);
  });

  it("throws when ESKIZ_PASSWORD is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ ESKIZ_PASSWORD: undefined })),
    ).toThrow(/ESKIZ_PASSWORD/);
  });

  it("throws when KAFKA_BROKERS is missing in production", () => {
    expect(() =>
      _assertEnvVars(PRODUCTION_REQUIRED_ENV, fullEnv({ KAFKA_BROKERS: undefined })),
    ).toThrow(/KAFKA_BROKERS/);
  });
});

/**
 * Plan 04-01 audit-fix FIX 2 — isProductionEnv normalizes case + whitespace.
 * Without this, NODE_ENV="Production" (case mismatch) would silently skip
 * _assertEnvVars and the prod CORS/CSP branches in main.ts, leaving the system
 * running with empty PAYME_KEY / open Swagger while the stub guards still fired.
 */
describe("isProductionEnv (FIX 2 — NODE_ENV normalization)", () => {
  it("is true for exact 'production'", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
  });

  it("is true for case variants: 'Production', 'PRODUCTION'", () => {
    expect(isProductionEnv({ NODE_ENV: "Production" })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: "PRODUCTION" })).toBe(true);
  });

  it("is true after stripping surrounding whitespace", () => {
    expect(isProductionEnv({ NODE_ENV: " production " })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: "\tproduction\n" })).toBe(true);
  });

  it("is false for 'development', 'test', '', undefined", () => {
    expect(isProductionEnv({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "" })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });

  it("bridges to _assertEnvVars: NODE_ENV='Production' + missing PAYME_SECRET_KEY now fails (would have silently passed before)", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "Production",
      DATABASE_URL: "x",
      JWT_SECRET: "x",
      JWT_REFRESH_SECRET: "x",
      REDIS_URL: "x",
      VAULT_TOKEN: "x",
      VAULT_ADDR: "x",
      // PAYME_SECRET_KEY intentionally missing
      PAYME_MERCHANT_ID: "x",
      PAYME_TEST_KEY: "x",
      PAYME_LOGIN: "x",
      CLICK_MERCHANT_ID: "x",
      CLICK_SECRET_KEY: "x",
      CLICK_SERVICE_ID: "x",
      // Phase 5 keys present so the failing env var is unambiguously PAYME_SECRET_KEY
      FCM_SERVICE_ACCOUNT_KEY_PATH: "/run/secrets/fcm-sa.json",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "noreply@sifat.uz",
      SMTP_PASS: "x",
      SMTP_FROM: "SIFAT LIBRARY <noreply@sifat.uz>",
    };
    // isProd is true (case-normalized) so bootstrap would call _assertEnvVars
    expect(isProductionEnv(env)).toBe(true);
    expect(() => _assertEnvVars(PRODUCTION_REQUIRED_ENV, env)).toThrow(
      /PAYME_SECRET_KEY/,
    );
  });
});
