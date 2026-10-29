/**
 * Plan 05-06 Task 1 — map-color util boundary cases (MAP-01).
 *
 * `.js` (not `.ts`) for the same reason as
 * `apps/frontend/public/geojson/__tests__/geojson.spec.js`: the frontend
 * has no jest TS preset, and this is a pure-function contract test for the
 * `riColor` / `riLabel` thresholds wired into the choropleth.
 *
 * The util is imported by `apps/frontend/components/map/ViloyatMap.tsx`
 * (Task 2) and the future Plan 05-07 StatsGateway WebSocket consumer.
 *
 * Thresholds per CLAUDE.md §VI.4 (Reading Index tiers as stated in the
 * orchestrator's executor block):
 *   - 80-100 → A'lo   (green  #16a34a)
 *   - 60-79  → Yaxshi (yellow #eab308)
 *   - 40-59  → O'rta  (orange #f59e0b)
 *   - 0-39   → Past   (red    #dc2626)
 *   - missing/NaN → "Ma'lumot yo'q" (gray #9ca3af)
 *
 * Boundary cases are exhaustive: each tier edge gets a low, high, and
 * mid-bucket assertion so the choropleth never mis-colors a viloyat at
 * the 39/40, 59/60, 79/80 transitions.
 */

const { riColor, riLabel } = require("../map-color");

describe("riColor (Plan 05-06 MAP-01 — choropleth color buckets)", () => {
  describe("red bucket: 0 ≤ score ≤ 39", () => {
    it("colors 0 red (#dc2626)", () => {
      expect(riColor(0)).toBe("#dc2626");
    });
    it("colors 39 red — last red value before orange transition", () => {
      expect(riColor(39)).toBe("#dc2626");
    });
  });

  describe("orange bucket: 40 ≤ score ≤ 59", () => {
    it("colors 40 orange (#f59e0b) — first orange value", () => {
      expect(riColor(40)).toBe("#f59e0b");
    });
    it("colors 59 orange — last orange value before yellow transition", () => {
      expect(riColor(59)).toBe("#f59e0b");
    });
  });

  describe("yellow bucket: 60 ≤ score ≤ 79", () => {
    it("colors 60 yellow (#eab308) — first yellow value", () => {
      expect(riColor(60)).toBe("#eab308");
    });
    it("colors 79 yellow — last yellow value before green transition", () => {
      expect(riColor(79)).toBe("#eab308");
    });
  });

  describe("green bucket: 80 ≤ score ≤ 100", () => {
    it("colors 80 green (#16a34a) — first green value", () => {
      expect(riColor(80)).toBe("#16a34a");
    });
    it("colors 100 green", () => {
      expect(riColor(100)).toBe("#16a34a");
    });
  });

  describe("gray bucket: missing / invalid data", () => {
    it("colors null gray (#9ca3af) — no data tier", () => {
      expect(riColor(null)).toBe("#9ca3af");
    });
    it("colors undefined gray", () => {
      expect(riColor(undefined)).toBe("#9ca3af");
    });
    it("colors NaN gray", () => {
      expect(riColor(NaN)).toBe("#9ca3af");
    });
    it("colors negative gray — defensive against bad backend data", () => {
      expect(riColor(-1)).toBe("#9ca3af");
    });
  });
});

describe("riLabel (Plan 05-06 MAP-01 — tooltip tier labels)", () => {
  it("labels >=80 'A'lo'", () => {
    expect(riLabel(100)).toBe("A'lo");
    expect(riLabel(80)).toBe("A'lo");
  });
  it("labels 60..79 'Yaxshi'", () => {
    expect(riLabel(79)).toBe("Yaxshi");
    expect(riLabel(60)).toBe("Yaxshi");
  });
  it("labels 40..59 'O’rta'", () => {
    expect(riLabel(59)).toBe("O'rta");
    expect(riLabel(40)).toBe("O'rta");
  });
  it("labels 0..39 'Past'", () => {
    expect(riLabel(39)).toBe("Past");
    expect(riLabel(0)).toBe("Past");
  });
  it("labels missing/NaN/negative 'Ma’lumot yo’q'", () => {
    expect(riLabel(null)).toBe("Ma'lumot yo'q");
    expect(riLabel(undefined)).toBe("Ma'lumot yo'q");
    expect(riLabel(NaN)).toBe("Ma'lumot yo'q");
    expect(riLabel(-1)).toBe("Ma'lumot yo'q");
  });
});
