/**
 * Plan 05-01 Task 4 — committed viloyat GeoJSON contract.
 *
 * Production never re-fetches the source at runtime; this spec asserts
 * that the file checked into git satisfies what Plan 05-06 (choropleth
 * MAP-03) and Plan 05-07 (StatsGateway viloyat color update) expect:
 *
 *   - FeatureCollection with EXACTLY 14 features
 *   - Each feature has properties.code (matches /^[0-9]{2}$/) and
 *     properties.name (non-empty string)
 *   - Codes are unique across all 14 features
 *   - Geometry is Polygon or MultiPolygon
 *   - Raw byte size <= 200KB (gzip <100KB is enforced by the build script)
 *
 * .js (not .ts) because the frontend jest config has no TS preset; this
 * is a static-file contract assertion, no React or TS-only code.
 */

const { readFileSync, statSync } = require("fs");
const { resolve } = require("path");

const GEOJSON_PATH = resolve(
  __dirname,
  "..",
  "uzbekistan-viloyats.geojson",
);

describe("uzbekistan-viloyats.geojson (Plan 05-01 MAP-03)", () => {
  let parsed;

  beforeAll(() => {
    const raw = readFileSync(GEOJSON_PATH, "utf-8");
    parsed = JSON.parse(raw);
  });

  it("exists at apps/frontend/public/geojson/uzbekistan-viloyats.geojson", () => {
    expect(() => statSync(GEOJSON_PATH)).not.toThrow();
  });

  it("is a FeatureCollection", () => {
    expect(parsed.type).toBe("FeatureCollection");
  });

  it("has exactly 14 viloyat features", () => {
    expect(parsed.features.length).toBe(14);
  });

  it("each feature has a non-empty 2-digit numeric code matching Viloyat.code shape", () => {
    for (const f of parsed.features) {
      expect(typeof f.properties.code).toBe("string");
      expect(f.properties.code).toMatch(/^[0-9]{2}$/);
    }
  });

  it("each feature has a non-empty name property", () => {
    for (const f of parsed.features) {
      expect(typeof f.properties.name).toBe("string");
      expect(f.properties.name.length).toBeGreaterThan(0);
    }
  });

  it("codes are unique across the 14 features", () => {
    const codes = parsed.features.map((f) => f.properties.code);
    expect(new Set(codes).size).toBe(14);
  });

  it("codes cover the full 01..14 Viloyat.code range", () => {
    const codes = parsed.features.map((f) => f.properties.code).sort();
    expect(codes).toEqual([
      "01", "02", "03", "04", "05", "06", "07",
      "08", "09", "10", "11", "12", "13", "14",
    ]);
  });

  it("every feature geometry is Polygon or MultiPolygon", () => {
    for (const f of parsed.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(f.geometry.type);
    }
  });

  it("raw file size <= 200KB (gzip <100KB enforced by build script)", () => {
    const stats = statSync(GEOJSON_PATH);
    expect(stats.size).toBeLessThanOrEqual(200_000);
  });
});
