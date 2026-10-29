/**
 * Plan 04-01 Task 2 — production-required env keys + pure assertion helper.
 *
 * Lives in `common/utils/` (not in main.ts) so main.spec.ts can import +
 * exercise the asserter as a pure function without triggering AppModule
 * evaluation (which requires the real @nestjs/schedule.forRoot() at module
 * load — see jest config moduleNameMapper for the schedule mock).
 *
 * PAYME and CLICK secrets are required per §VIII.3 Vault fail-hard
 * carry-over from Phase 1 INFRA-04. Without them, payme.service / click.service
 * silently use empty strings and EVERY webhook signature mismatches.
 */

export const PRODUCTION_REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "REDIS_URL",
  // Vault production da majburiy — dev-root-token fallback bekor qilingan (INFRA-04)
  "VAULT_TOKEN",
  "VAULT_ADDR",
  // Plan 04-01 PAY-01/02: Payme + Click secrets MUST be Vault-backed in prod.
  "PAYME_MERCHANT_ID",
  "PAYME_SECRET_KEY",
  // Plan 04-01 audit-fix FIX 7 — PAYME_TEST_KEY is the Payme sandbox
  // ("Paycom" login) key, useful for staging probes but NOT required for a
  // production deployment. Keeping it in PRODUCTION_REQUIRED_ENV caused
  // correctly-configured prod containers to fail boot. The FIX 3 empty-key
  // reject in payme.service ensures an unset testKey can NEVER bypass auth;
  // it just disables the sandbox-auth branch (all calls fall to the Basic
  // merchant: + secretKey path).
  "PAYME_LOGIN",
  "CLICK_MERCHANT_ID",
  "CLICK_SECRET_KEY",
  "CLICK_SERVICE_ID",
  // Plan 05-01 Task 2 — NOTIF-02/03 production hard-fail.
  // FcmClient.onModuleInit + MailClient.onModuleInit silently no-op when these
  // are unset (so dev/test boot). Production MUST fail boot when missing —
  // otherwise alerts, push pings, and monthly reports silently drop on the
  // floor. SMTP_PORT has a default of 587 so it's NOT required at boot.
  // Operator OQ-1 deferral: real values supplied post-launch via Vault.
  "FCM_SERVICE_ACCOUNT_KEY_PATH",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  // Plan 06-01-fix audit-HIGH — MinioService.onModuleInit silently no-ops
  // when MINIO_* env unset (boot succeeds + warn log). Production MUST fail
  // boot when these are missing — every Phase 6 file upload (SCH-05 debate
  // media, ORG-03 reading-hour media, ORG-04 book corner photo) would throw
  // "MinIO not configured" at call time, silently breaking the modules.
  "MINIO_ENDPOINT",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "MINIO_BUCKET_DEBATES",
  "MINIO_BUCKET_BOOKCORNERS",
  "MINIO_BUCKET_READINGHOURS",
  // AUDIT FIX H7 — OTP SMS (auth bo'sag'asi!) va Kafka event oqimi prodda
  // jim no-op bo'lib qolmasligi uchun fail-hard. EskizSmsClient.onModuleInit
  // va KafkaService/KafkaConsumerService.onModuleInit ham xuddi shu shartni
  // mustaqil tekshiradi (defense-in-depth — boshqa entrypoint orqali boot
  // bo'lsa ham yiqiladi).
  "ESKIZ_EMAIL",
  "ESKIZ_PASSWORD",
  "KAFKA_BROKERS",
];

/**
 * Throws when any of the named keys is missing from the provided env.
 * main.ts calls this with process.env during bootstrap(); main.spec drives
 * it with a synthetic env object for assertion.
 */
export function _assertEnvVars(
  keys: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[FATAL] Production da quyidagi env o'zgaruvchilar topilmadi: ${missing.join(", ")}\n` +
        "Iltimos .env.prod faylini to'ldiring.",
    );
  }
}

/**
 * Plan 04-01 audit-fix FIX 2 — case-insensitive + whitespace-tolerant
 * production check. Mirrors the normalizer used in subscription-stub-guard,
 * donation-stub-guard, and the DEV_OTP_BYPASS allowlist. Without this,
 * NODE_ENV="Production" (case mismatch) silently skipped _assertEnvVars +
 * the prod CORS/CSP/Swagger branches in main.ts, while the stub guards still
 * fired — an asymmetry an attacker could exploit to ship a "prod" deployment
 * with empty PAYME_KEY / Swagger exposed.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? "").toLowerCase().trim() === "production";
}
