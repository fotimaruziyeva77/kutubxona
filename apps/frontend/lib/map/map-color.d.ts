/**
 * Plan 05-06 Task 1 — type declaration for the CommonJS map-color util.
 *
 * The runtime file is `.js` (frontend has no jest TS preset, see
 * apps/frontend/public/geojson/__tests__/geojson.spec.js for the same
 * pattern). This `.d.ts` lets TSX consumers like ViloyatMap.tsx and
 * stats/page.tsx import the helpers with full type safety.
 */
export function riColor(score: number | null | undefined): string;
export function riLabel(score: number | null | undefined): string;
