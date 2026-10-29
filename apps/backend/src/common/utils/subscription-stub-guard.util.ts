/**
 * Plan 04-01 Task 2 — DEV_SUBSCRIPTION_PAYMENT_STUB fail-CLOSED guard.
 *
 * Mirrors Phase 1 DEV_OTP_BYPASS (auth.service.ts:38-43) + Plan 03-01
 * DEV_DONATION_PAYMENT_STUB (donation-stub-guard.util.ts) semantics exactly.
 * Production must throw at boot if the subscription payment stub is active,
 * since the stub auto-completes Payme/Click webhook calls without real HMAC
 * verification and would let any caller mark subscription invoices PAID.
 *
 * Lives in `common/utils/` rather than inline in `main.ts` so the spec
 * (`main.spec.ts`) can import + exercise the helper as a pure function
 * without triggering full AppModule evaluation in the test environment.
 * `main.ts` calls this guard during `bootstrap()`.
 *
 * Per OQ-6 (user-approved) in 04-RESEARCH.md.
 */

export function _assertSubscriptionStubGuard(
  env: { NODE_ENV?: string; DEV_SUBSCRIPTION_PAYMENT_STUB?: string } = {},
): void {
  const nodeEnv = (env.NODE_ENV || "").toLowerCase().trim();
  if (
    nodeEnv === "production" &&
    env.DEV_SUBSCRIPTION_PAYMENT_STUB === "true"
  ) {
    throw new Error(
      "[FATAL] DEV_SUBSCRIPTION_PAYMENT_STUB MUST NOT be 'true' in production. " +
        "This flag bypasses real Payme/Click verification and would let any " +
        "caller mark subscription payments PAID. Unset it in .env.prod or use 'false'.",
    );
  }
}

/**
 * Returns true when the subscription stub flag is honored: flag === "true" AND
 * NODE_ENV is in the dev/test allowlist. Mirrors AuthService.isOtpBypassed()
 * and isDonationStubActive(). Used by Plan 04-02 subscription webhook handlers
 * to short-circuit the real Payme/Click integration in dev.
 */
export function isSubscriptionStubActive(
  env: { NODE_ENV?: string; DEV_SUBSCRIPTION_PAYMENT_STUB?: string } = {},
): boolean {
  if (env.DEV_SUBSCRIPTION_PAYMENT_STUB !== "true") return false;
  const nodeEnv = (env.NODE_ENV || "").toLowerCase().trim();
  return nodeEnv === "development" || nodeEnv === "test" || nodeEnv === "dev";
}
