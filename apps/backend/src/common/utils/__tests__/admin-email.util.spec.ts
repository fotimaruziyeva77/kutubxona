/**
 * Plan 05-08-fix FIX A — Shared admin-email helper unit test.
 *
 * Mirrors the FIX C contract that NotificationProcessor relies on:
 *   - trim + lowercase
 *   - EMAIL_REGEX validation
 *   - MAX_ADMIN_FALLBACK_RECIPIENTS cap (10)
 */
import {
  EMAIL_REGEX,
  MAX_ADMIN_FALLBACK_RECIPIENTS,
  parseAdminFallbackEmails,
} from "../admin-email.util";

describe("parseAdminFallbackEmails (Plan 05-08-fix FIX A)", () => {
  it("re-exports the constants used by both NotificationProcessor and AdminService", () => {
    expect(EMAIL_REGEX).toBeInstanceOf(RegExp);
    expect(MAX_ADMIN_FALLBACK_RECIPIENTS).toBe(10);
  });

  it("returns an empty array for undefined / empty input", () => {
    expect(parseAdminFallbackEmails(undefined)).toEqual([]);
    expect(parseAdminFallbackEmails("")).toEqual([]);
    expect(parseAdminFallbackEmails("   ,  , ")).toEqual([]);
  });

  it("trims + lowercases each entry", () => {
    expect(
      parseAdminFallbackEmails(" Ops@Sifat.UZ ,  Alerts@Sifat.UZ "),
    ).toEqual(["ops@sifat.uz", "alerts@sifat.uz"]);
  });

  it("drops malformed entries via EMAIL_REGEX and reports via the warn callback", () => {
    const warns: string[] = [];
    const out = parseAdminFallbackEmails(
      "admin@foo.uz,not-an-email,b@b.com",
      { warn: (m) => warns.push(m) },
    );
    expect(out).toEqual(["admin@foo.uz", "b@b.com"]);
    expect(warns.some((w) => w.includes("not-an-email"))).toBe(true);
  });

  it("caps at MAX_ADMIN_FALLBACK_RECIPIENTS (10) and warns on truncation", () => {
    const addrs = Array.from({ length: 11 }, (_, i) => `a${i}@sifat.uz`).join(",");
    const warns: string[] = [];
    const out = parseAdminFallbackEmails(addrs, { warn: (m) => warns.push(m) });
    expect(out).toHaveLength(10);
    expect(warns.some((w) => w.includes("truncating to 10"))).toBe(true);
  });

  it("returns [] when every entry is malformed (caller must skip dispatch)", () => {
    const warns: string[] = [];
    const out = parseAdminFallbackEmails("garbage,more-garbage", {
      warn: (m) => warns.push(m),
    });
    expect(out).toEqual([]);
    expect(warns.length).toBe(2);
  });

  it("accepts legitimate addresses with + tags", () => {
    expect(parseAdminFallbackEmails("ops+alerts@sifat.uz")).toEqual([
      "ops+alerts@sifat.uz",
    ]);
  });
});
