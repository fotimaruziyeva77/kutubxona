import { maskNameIfMinor } from "../privacy-mask.util";

/**
 * Plan 03-01 Task 1 — privacy-mask.util.spec.ts
 *
 * Single source of truth for underage-name anonymization (TOP-06).
 * Per CLAUDE.md §V.4: "14 yoshgacha bolalar ismlari (faqat `A.K.`, ...)".
 *
 * The util is consumed by 03-02 (top.service), 03-03 (donate.service),
 * 03-04 (WebSocket emit). Defense-in-depth at JSON serialization time.
 */

// Construct a DOB whose age, computed via the production formula
// `(now - dob) / (365.25 * 24 * 60 * 60 * 1000)`, equals `years` (truncated).
function dobAged(years: number): Date {
  const ms = years * 365.25 * 24 * 60 * 60 * 1000;
  // Add 1 day of slack so floor(now - dob) doesn't tip just under the target
  // due to leap-day arithmetic.
  return new Date(Date.now() - ms - 86_400_000);
}

describe("maskNameIfMinor", () => {
  it("masks two-part name for a 12-year-old child as initials", () => {
    expect(maskNameIfMinor("Aziz Karimov", dobAged(12))).toBe("A.K.");
  });

  it("returns full name unchanged for a 15-year-old (over the under-14 cutoff)", () => {
    expect(maskNameIfMinor("Aziz Karimov", dobAged(15))).toBe("Aziz Karimov");
  });

  it("masks exactly at the boundary: age 14 is considered minor (≤14)", () => {
    expect(maskNameIfMinor("Aziz Karimov", dobAged(14))).toBe("A.K.");
  });

  it("returns dash placeholder when name is null", () => {
    expect(maskNameIfMinor(null, dobAged(12))).toBe("—");
  });

  it("returns name unchanged when dob is null (no minor signal)", () => {
    expect(maskNameIfMinor("Aziz", null)).toBe("Aziz");
  });

  it("masks single-part name for a 10-year-old as initial only", () => {
    expect(maskNameIfMinor("Aziz", dobAged(10))).toBe("A.");
  });

  it("trims surrounding whitespace before initialing", () => {
    expect(maskNameIfMinor("  Aziz   Karimov  ", dobAged(10))).toBe("A.K.");
  });

  it("initials all parts when there are three+ space-separated tokens", () => {
    expect(maskNameIfMinor("Aziz Bahodir Karimov", dobAged(10))).toBe("A.B.K.");
  });

  it("returns dash placeholder when both name and dob are null", () => {
    expect(maskNameIfMinor(null, null)).toBe("—");
  });
});
