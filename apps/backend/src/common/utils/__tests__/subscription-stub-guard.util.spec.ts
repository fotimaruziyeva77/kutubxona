import {
  _assertSubscriptionStubGuard,
  isSubscriptionStubActive,
} from "../subscription-stub-guard.util";

/**
 * Plan 04-01 Task 2 — DEV_SUBSCRIPTION_PAYMENT_STUB guard spec.
 *
 * Mirrors the Plan 03-01 DEV_DONATION_PAYMENT_STUB spec
 * (donation-stub-guard.util.spec.ts) exactly. Production must fail-hard if
 * the subscription payment stub is ever active — see OQ-6 in 04-RESEARCH.md.
 */

describe("_assertSubscriptionStubGuard (DEV_SUBSCRIPTION_PAYMENT_STUB)", () => {
  it("throws when NODE_ENV=production and DEV_SUBSCRIPTION_PAYMENT_STUB=true", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_SUBSCRIPTION_PAYMENT_STUB/);
  });

  it("does NOT throw when NODE_ENV=development and DEV_SUBSCRIPTION_PAYMENT_STUB=true (dev allowlist)", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "development",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=test and DEV_SUBSCRIPTION_PAYMENT_STUB=true", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "test",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=production and DEV_SUBSCRIPTION_PAYMENT_STUB is unset", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when NODE_ENV=production and DEV_SUBSCRIPTION_PAYMENT_STUB='false'", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "false",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when DEV_SUBSCRIPTION_PAYMENT_STUB is any non-'true' string in production", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "yes",
      }),
    ).not.toThrow();
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "1",
      }),
    ).not.toThrow();
  });

  it("treats NODE_ENV case-insensitively: 'Production' and 'PRODUCTION' both throw", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "Production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_SUBSCRIPTION_PAYMENT_STUB/);
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: "PRODUCTION",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_SUBSCRIPTION_PAYMENT_STUB/);
  });

  it("trims surrounding whitespace from NODE_ENV before comparison", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        NODE_ENV: " production ",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toThrow(/DEV_SUBSCRIPTION_PAYMENT_STUB/);
  });

  it("does NOT throw when NODE_ENV is unset (treated as non-production)", () => {
    expect(() =>
      _assertSubscriptionStubGuard({
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).not.toThrow();
  });
});

describe("isSubscriptionStubActive (DEV_SUBSCRIPTION_PAYMENT_STUB allowlist)", () => {
  it("returns true when flag=true AND NODE_ENV=development", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "development",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toBe(true);
  });

  it("returns true when flag=true AND NODE_ENV=test", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "test",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toBe(true);
  });

  it("returns true when flag=true AND NODE_ENV=dev (alias)", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "dev",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toBe(true);
  });

  it("returns false when flag is missing (regardless of NODE_ENV)", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "development",
      }),
    ).toBe(false);
  });

  it("returns false when flag !== 'true' (any other value)", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "development",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "yes",
      }),
    ).toBe(false);
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "development",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "1",
      }),
    ).toBe(false);
  });

  it("returns false when NODE_ENV=production even if flag=true (allowlist excludes prod)", () => {
    expect(
      isSubscriptionStubActive({
        NODE_ENV: "production",
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toBe(false);
  });

  it("returns false when NODE_ENV is unset", () => {
    expect(
      isSubscriptionStubActive({
        DEV_SUBSCRIPTION_PAYMENT_STUB: "true",
      }),
    ).toBe(false);
  });
});
