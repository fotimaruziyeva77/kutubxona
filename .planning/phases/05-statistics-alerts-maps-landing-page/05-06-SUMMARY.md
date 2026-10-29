---
phase: 05-statistics-alerts-maps-landing-page
plan: 06
type: summary
status: complete
date: 2026-06-07
requirements: [MAP-01, MAP-02, MAP-03]
---

# Plan 05-06 SUMMARY — Choropleth Map (MAP-01 + MAP-02 + MAP-03)

Wave 3 frontend-only execution. Three deliverables — riColor/riLabel util,
ViloyatMap L.geoJSON choropleth rewrite, and stats/page.tsx integration —
land the most-visible PQ-9 §VI.4 surface: a green/yellow/red region map
of Reading Index across the 14 viloyats of O'zbekiston.

Zero backend changes. Builds on Plan 05-01 (committed GeoJSON asset),
Plan 05-02 (real per-viloyat RI from `/admin/stats/viloyat/all`), and
prepares the ground for Plan 05-07 (real-time WebSocket map refresh).

## What shipped

### Task 1 — riColor + riLabel util (MAP-01 foundation)

`apps/frontend/lib/map/map-color.js` (+ `.d.ts`) exports two pure helpers
consumed by the choropleth `style` callback (Task 2) and the fallback
grid view (Task 3). CommonJS `.js` mirrors the pattern already in the
repo for `apps/frontend/public/geojson/__tests__/geojson.spec.js` —
frontend jest has no TS preset, so the runtime file stays `.js` and a
sibling `.d.ts` gives `.tsx` consumers full typing.

Thresholds (CLAUDE.md §VI.4 Reading Index tiers, 5 buckets):

| Score    | Color   | Hex       | Label          |
|----------|---------|-----------|----------------|
| 80–100   | green   | `#16a34a` | A'lo           |
| 60–79    | yellow  | `#eab308` | Yaxshi         |
| 40–59    | orange  | `#f59e0b` | O'rta          |
| 0–39     | red     | `#dc2626` | Past           |
| null/NaN | gray    | `#9ca3af` | Ma'lumot yo'q  |

Spec: `apps/frontend/lib/map/__tests__/map-color.spec.js` — **17 boundary
assertions** covering each tier edge (0, 39, 40, 59, 60, 79, 80, 100) plus
the no-data fallback (null, undefined, NaN, negative).

### Task 2 — ViloyatMap choropleth rewrite (MAP-01 + MAP-03)

`apps/frontend/components/map/ViloyatMap.tsx` fully rewritten:

- **Deleted**: previous `L.circleMarker` per-province dot loop + hardcoded
  centroids. Grep gate `circleMarker` count = **0** in this file.
- **Added**: `useEffect` fetching `/geojson/uzbekistan-viloyats.geojson`
  once on mount (file committed by Plan 05-01, served as Cache-Control
  immutable). Stored in component state so subsequent prop changes don't
  re-fetch.
- **Added**: `L.geoJSON(geoData, { style, onEachFeature })` rendering all
  14 viloyat polygons. The `style` callback resolves color via
  `riColor(matched.readingIndex)`; `feature.properties.code` ("01".."14")
  is joined against the `data` row's `code` field (or `viloyatId`
  fallback) — see Task 3 wiring.
- **Added**: `onEachFeature` registers `click` + `mouseover` + `mouseout`
  + `bindTooltip` + `bindPopup`:
  - **Click** → `props.onSelect(viloyat)` opens the existing in-page
    detail panel.
  - **Mouseover** → `layer.setStyle({ weight: 3, color: "#666",
    fillOpacity: 0.9 })` + `bringToFront()` for hover highlight.
  - **Mouseout** → `geoLayer.resetStyle(layer)` restores the choropleth.
  - **Tooltip** (hover) shows viloyat name + `RI: 67.3 (Yaxshi)`.
  - **Popup** (click) shows name + RI + library count + reader count.
- **Updated legend**: 5-tier swatch (A'lo / Yaxshi / O'rta / Past /
  Ma'lumot yo'q) matching the shared `riColor` thresholds.
- **Preserved**: SSR boundary — the parent at `stats/page.tsx` still
  uses `dynamic(() => import('@/components/map/ViloyatMap'), { ssr: false })`.
- **Preserved**: lat/lon stay on the `ViloyatMapData` shape for the
  legacy fallback grid view, but are no longer used by the choropleth.

Data updates re-render: a second `useEffect` keyed on `[geoData, data]`
removes the previous `L.geoJSON` layer and rebuilds it, so when Plan
05-02 stats refresh the polygon colors re-paint without a full remount.

Spec: `apps/frontend/components/map/__tests__/ViloyatMap.spec.js` —
**12 contract assertions** covering style color resolution, hover/click
handlers, tooltip + popup wiring, GeoJSON URL, riColor/riLabel import,
and the `circleMarker = 0` regression guard.

### Task 3 — stats/page.tsx MapTab integration (MAP-02)

`apps/frontend/app/[locale]/dashboard/stats/page.tsx` `mapData` now
includes the viloyat `code` field on each row:

```ts
return {
  viloyatId: v.id,    // Prisma cuid — joins to /admin/stats/viloyat/all
  code: v.code,       // "01".."14"  — joins to GeoJSON properties.code
  name: v.name,
  lat: coords.lat,    // kept for legacy grid view + future tuman zoom
  lon: coords.lon,
  readingIndex: vRi?.readingIndex ?? 0,
  libraries: libCount,
  users: vRi?.userCount ?? 0,
};
```

This is the join key the choropleth needs: GeoJSON features carry only
`properties.code` (2-digit string), but Plan 05-02's stats objects are
keyed on the Prisma cuid. The `code` field on `mapData` rows lets
`ViloyatMap.lookupViloyat(code)` join polygon → stats row in O(n).

Click handler unchanged — `setSelectedViloyat` drives the existing
detail panel at lines 506–532. The grid-list fallback at lines 534+ is
**preserved** (mobile screen-reader users + small-tap-target fallback
per RESEARCH §MAP-01..03 mobile usability gotcha).

## Verification

| Gate                                                           | Result        |
|----------------------------------------------------------------|---------------|
| Frontend `npm test` (all)                                      | 38 passed / 38 |
| `map-color` spec — boundary cases                              | 17 passed     |
| `ViloyatMap` spec — choropleth contract                        | 12 passed     |
| `geojson.spec.js` — Plan 05-01 baseline                        | 9 passed      |
| Frontend `tsc --noEmit`                                        | clean         |
| `grep circleMarker apps/frontend/components/map/ViloyatMap.tsx`| 0             |
| `grep circleMarker app/[locale]/dashboard/stats/page.tsx`      | 0             |
| `grep riColor apps/frontend/lib/map/map-color.js`              | 3             |

Note on build smoke: `next build` is gated by an unrelated project-wide
env guard (`NEXT_PUBLIC_DISABLE_OTP=true` blocks production builds).
TypeScript compilation is verified clean via `tsc --noEmit`, which is
the relevant gate for the choropleth rewrite (no new runtime
dependencies, only Leaflet API changes).

## Files touched

- `apps/frontend/lib/map/map-color.js` — new (riColor + riLabel)
- `apps/frontend/lib/map/map-color.d.ts` — new (TS declaration)
- `apps/frontend/lib/map/__tests__/map-color.spec.js` — new (17 tests)
- `apps/frontend/components/map/ViloyatMap.tsx` — rewritten (L.geoJSON)
- `apps/frontend/components/map/__tests__/ViloyatMap.spec.js` — new (12 tests)
- `apps/frontend/app/[locale]/dashboard/stats/page.tsx` — `code` field added to `mapData` rows

Zero backend file overlap with Plan 05-05 (orchestrator constraint).

## Follow-ups (deferred, per plan scope)

- **Tuman-level GeoJSON** — V2, not shipped here (Q4 user decision).
  Researched in RESEARCH §MAP-01..03; map exposes no zoom listener for
  tuman drill-down yet.
- **Plan 05-07 real-time refresh** — the `style + onEachFeature` callbacks
  are pure on `data`; the existing `[geoData, data]` useEffect will re-paint
  polygons when a WebSocket push updates `data`, so 05-07 needs no
  ViloyatMap changes — only a `setData(...)` from the WebSocket hook.
- **Viloyat detail navigation** — current click opens the in-page panel
  (UX baseline preserved). Optional `router.push(/${locale}/${slug})`
  navigation can be wired when public viloyat pages exist for all 14
  slugs (currently only some are present).

---

*Plan 05-06 closes MAP-01, MAP-02, and MAP-03 for Phase 5.*
