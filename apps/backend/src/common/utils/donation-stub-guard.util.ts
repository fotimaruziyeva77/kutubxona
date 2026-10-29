/**
 * Plan 03-01 Task 2 — DEV_DONATION_PAYMENT_STUB fail-CLOSED guard.
 *
 * Mirrors DEV_OTP_BYPASS semantics from auth.service.ts:38-43 + the
 * main.ts startup banner (lines 143-155). Production must throw at boot
 * if the donation payment stub is active, since the stub auto-completes
 * webhook calls without real Payme/Click HMAC verification.
 *
 * Lives in `common/utils/` rather than inline in `main.ts` so the spec
 * (`main.spec.ts`) can import + exercise the helper as a pure function
 * without triggering full AppModule evaluation in the test environment.
 * `main.ts` calls this guard during `bootstrap()`.
 *
 * Per D-DONAT-01 in 03-RESEARCH.md.
 */

export function _assertDonationStubGuard(
  env: { NODE_ENV?: string; DEV_DONATION_PAYMENT_STUB?: string } = {},
): void {
  const nodeEnv = (env.NODE_ENV || "").toLowerCase().trim();
  if (
    nodeEnv === "production" &&
    env.DEV_DONATION_PAYMENT_STUB === "true"
  ) {
    throw new Error(
      "[FATAL] DEV_DONATION_PAYMENT_STUB MUST NOT be 'true' in production. " +
        "This flag bypasses real Payme/Click verification and would let any " +
        "caller mark donations PAID. Unset it in .env.prod or use 'false'.",
    );
  }
}

/**
 * Returns true when the donation stub flag is honored: flag === "true" AND
 * NODE_ENV is in the dev/test allowlist. Mirrors AuthService.isOtpBypassed().
 * Used by donate.service to short-circuit the real Payme/Click integration
 * (consumed by Plan 03-03).
 */
export function isDonationStubActive(
  env: { NODE_ENV?: string; DEV_DONATION_PAYMENT_STUB?: string } = {},
): boolean {
  if (env.DEV_DONATION_PAYMENT_STUB !== "true") return false;
  const nodeEnv = (env.NODE_ENV || "").toLowerCase().trim();
  return nodeEnv === "development" || nodeEnv === "test" || nodeEnv === "dev";
}
