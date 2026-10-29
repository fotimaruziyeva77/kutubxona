import { getAgeGroup, AgeGroup } from "../age-group.util";

/**
 * Plan 05-03 Task 1 — age-group util boundary spec.
 *
 * Comprehensive boundaries so any future bucket drift surfaces immediately.
 * The reference date is fixed at 2026-06-07 (Plan 05-03 execution day) so
 * the assertions are deterministic across runs.
 */

const REF = new Date(2026, 5, 7); // 2026-06-07 local time

function dobForAge(age: number, refMonth = 5, refDay = 7): Date {
  return new Date(2026 - age, refMonth, refDay);
}

describe("getAgeGroup util (Plan 05-03 T1)", () => {
  describe("bucket boundaries", () => {
    it.each([
      [7, "7-14" as AgeGroup],
      [10, "7-14" as AgeGroup],
      [14, "7-14" as AgeGroup],
      [15, "15-30" as AgeGroup],
      [22, "15-30" as AgeGroup],
      [30, "15-30" as AgeGroup],
      [31, "31-60" as AgeGroup],
      [45, "31-60" as AgeGroup],
      [60, "31-60" as AgeGroup],
      [61, "60+" as AgeGroup],
      [85, "60+" as AgeGroup],
    ])("age %i → bucket %s", (age, bucket) => {
      expect(getAgeGroup(dobForAge(age), REF)).toBe(bucket);
    });

    it("age < 7 returns 'unknown'", () => {
      expect(getAgeGroup(dobForAge(6), REF)).toBe("unknown");
      expect(getAgeGroup(dobForAge(0), REF)).toBe("unknown");
    });
  });

  describe("birthday-not-yet-this-year edge", () => {
    it("birthday tomorrow — still counted as previous age", () => {
      // DOB 2011-06-08 → on REF 2026-06-07 user is still 14 (turns 15 tomorrow)
      const dob = new Date(2011, 5, 8);
      expect(getAgeGroup(dob, REF)).toBe("7-14");
    });

    it("birthday today — counted as new age", () => {
      // DOB 2011-06-07 → on REF 2026-06-07 user turns exactly 15
      const dob = new Date(2011, 5, 7);
      expect(getAgeGroup(dob, REF)).toBe("15-30");
    });

    it("birthday earlier this year — counted at new age", () => {
      // DOB 2011-01-15 → on REF 2026-06-07 user is 15
      const dob = new Date(2011, 0, 15);
      expect(getAgeGroup(dob, REF)).toBe("15-30");
    });
  });

  describe("invalid / null DOB", () => {
    it("null returns 'unknown'", () => {
      expect(getAgeGroup(null, REF)).toBe("unknown");
    });
    it("undefined returns 'unknown'", () => {
      expect(getAgeGroup(undefined, REF)).toBe("unknown");
    });
    it("invalid string returns 'unknown'", () => {
      expect(getAgeGroup("not-a-date", REF)).toBe("unknown");
    });
    it("NaN-equivalent Date returns 'unknown'", () => {
      expect(getAgeGroup(new Date("garbage"), REF)).toBe("unknown");
    });
  });

  describe("ISO string DOB", () => {
    it("ISO string for age-22 user → '15-30'", () => {
      expect(getAgeGroup("2004-01-15T00:00:00.000Z", REF)).toBe("15-30");
    });
  });

  describe("default referenceDate (no injection)", () => {
    it("returns a defined bucket when no referenceDate is provided", () => {
      const result = getAgeGroup(new Date(2000, 0, 1));
      expect(["7-14", "15-30", "31-60", "60+", "unknown"]).toContain(result);
    });
  });
});
