import { UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";

/**
 * Payme Merchant API Basic-auth verifier — shared by PaymeService (subscription
 * webhooks) and DonateService (donation webhooks).
 *
 * Extracted from PaymeService._verifyAuth (Plan 04-01 audit-fix FIX 3):
 *  - constant-time compare via crypto.timingSafeEqual (no timing side channel);
 *  - empty expected-key reject BEFORE the compare, so an unset
 *    PAYME_SECRET_KEY / PAYME_TEST_KEY env var can never be matched by an
 *    empty password (fail closed);
 *  - any timingSafeEqual throw (length mismatch) is treated as auth failure
 *    without leaking length info via distinct errors.
 *
 * SEC FIX H2 — `allowTestKey` gates the sandbox branch. The "Paycom" login is
 * Payme's sandbox identity; honoring PAYME_TEST_KEY for it in PRODUCTION would
 * let anyone holding the (far less protected) test key authenticate real
 * webhooks. Callers MUST pass `allowTestKey: !isProductionEnv()` so production
 * always verifies against the production merchant key regardless of login.
 */
export interface PaymeAuthKeys {
  /** Production merchant key (PAYME_SECRET_KEY). */
  secretKey: string;
  /** Sandbox key for the "Paycom" login (PAYME_TEST_KEY); may be empty. */
  testKey: string;
  /** Honor the "Paycom" sandbox branch? MUST be false in production. */
  allowTestKey: boolean;
}

export function verifyPaymeBasicAuth(
  authHeader: string | undefined,
  keys: PaymeAuthKeys,
): void {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    throw new UnauthorizedException("Auth sarlavha yo'q");
  }
  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const [login, password] = decoded.split(":");

  // SEC FIX H2 — the test-key branch is only reachable outside production.
  const isTest = login === "Paycom" && keys.allowTestKey;
  const expectedKey = isTest ? keys.testKey : keys.secretKey;

  // Reject empty key BEFORE the compare so unset env can't auth via empty pw.
  if (!expectedKey || !password) {
    throw new UnauthorizedException("Noto'g'ri Payme kalit");
  }

  // Constant-time compare. timingSafeEqual throws on length mismatch — treat
  // any throw as auth failure (don't leak length info via different errors).
  let ok = false;
  try {
    const a = Buffer.from(password, "utf8");
    const b = Buffer.from(expectedKey, "utf8");
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }

  if (!ok) {
    throw new UnauthorizedException("Noto'g'ri Payme kalit");
  }
}
