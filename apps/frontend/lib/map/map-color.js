/**
 * Plan 05-06 Task 1 — riColor + riLabel choropleth helpers (MAP-01).
 *
 * Used by:
 *   - apps/frontend/components/map/ViloyatMap.tsx (Plan 05-06 Task 2)
 *     style callback for L.geoJSON polygon fill.
 *   - apps/frontend/app/[locale]/dashboard/stats/page.tsx (Plan 05-06 Task 3)
 *     fallback grid-list tier coloring.
 *   - Future Plan 05-07 StatsGateway WebSocket consumer (real-time
 *     viloyat color update on stats refresh).
 *
 * Thresholds per CLAUDE.md §VI.4 Reading Index tiers as defined in the
 * Plan 05-06 executor block (5 buckets including "no data"):
 *
 *   score >= 80           → "A'lo"          (green  #16a34a)
 *   60 <= score <= 79     → "Yaxshi"        (yellow #eab308)
 *   40 <= score <= 59     → "O'rta"         (orange #f59e0b)
 *   0  <= score <= 39     → "Past"          (red    #dc2626)
 *   null|undefined|NaN|<0 → "Ma'lumot yo'q" (gray   #9ca3af)
 *
 * `.js` (not `.ts`) to match the frontend jest config which has no TS
 * preset; consumed by .tsx components via plain `import` (Next.js
 * resolves both .ts and .js in the same path).
 */

function riColor(score) {
  if (score == null || Number.isNaN(score) || score < 0) return "#9ca3af";
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#eab308";
  if (score >= 40) return "#f59e0b";
  return "#dc2626";
}

function riLabel(score) {
  if (score == null || Number.isNaN(score) || score < 0) return "Ma'lumot yo'q";
  if (score >= 80) return "A'lo";
  if (score >= 60) return "Yaxshi";
  if (score >= 40) return "O'rta";
  return "Past";
}

module.exports = { riColor, riLabel };
