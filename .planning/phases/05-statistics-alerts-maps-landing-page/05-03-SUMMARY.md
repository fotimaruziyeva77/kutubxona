---
phase: 05-statistics-alerts-maps-landing-page
plan: 03
status: completed
completed_at: 2026-06-07
backend_tests: "1317 passing (baseline 1273, delta +44)"
backend_tsc: clean
frontend_tsc: clean
frontend_build: succeeds (dashboard/stats route emitted x4 locales at 12.6 kB)
lint_replica: "0 hits (this.prisma heavy reads in admin.service.ts)"
simulated_ri_grep: "0 hits (apps/frontend tree)"
---

# Plan 05-03 SUMMARY — Wave 3 Stats Expansion (STAT-04..07)

Closes STAT-04 (gender), STAT-05 (age), STAT-06 (genre trend), and the
ordering side of STAT-07 (book shortage `Buyurtma` button). Three feat
commits + this SUMMARY commit.

## T1 — getAgeGroup util promotion + gender/age/genre-trend services

### `apps/backend/src/common/utils/age-group.util.ts` — NEW

Pure helper promoted from the inline `getAgeGroup(dob: Date)` at
`apps/backend/src/modules/top/top.service.ts:23` (Phase 3). Single
source-of-truth so Plan 05-03 services and the Top-100 cron share the
exact boundary semantics.

```ts
export type AgeGroup = "7-14" | "15-30" | "31-60" | "60+" | "unknown";

export function getAgeGroup(
  dob: Date | string | null | undefined,
  referenceDate?: Date,
): AgeGroup;
```

- Buckets per CLAUDE.md §VI.2: `7-14`, `15-30`, `31-60`, `60+`, `unknown`.
- Boundary rule: birthday-this-year check matches calendar semantics —
  someone born 2011-06-08 is still 14 on 2026-06-07 but 15 on 2011-06-07
  birthday.
- `unknown` returned for null/invalid DOB AND for age < 7 (the smallest
  bucket starts at 7 per the TZ).
- TZ gotcha: cron schedules already use `Asia/Tashkent` (Phase 1 INFRA-05),
  so all replicas observe the same midnight boundary.

### `apps/backend/src/modules/top/top.service.ts` — refactor

```ts
import { getAgeGroup, type AgeGroup as SharedAgeGroup } from "../../common/utils/age-group.util";
// Top-100 surface accepts only the 4 named buckets — no 'unknown' for ACTIVE users.
type AgeGroup = Exclude<SharedAgeGroup, "unknown">;
```

The 8+ existing Phase 3 top.service tests continue to pass (regression
guard). Date.now()-based age math replaced by the calendar-semantic
util, which is more accurate at year boundaries.

### `apps/backend/src/modules/admin/admin.service.ts` — three new services

All three apply tier-admin scope assert via Plan 05-02 helpers
(`assertViloyatInScope`, `assertTumanInScope`) BEFORE `cache.remember` —
same T-05-02 cache-poison protection as `getViloyatStats`.

#### `getGenderBreakdown(scope, scopeId?, user?, resolvedViloyatId?)`

- Returns `{ MALE: { count, readingIndex }, FEMALE: { count, readingIndex } }`.
- Parallel: `replica.user.groupBy({ by: ['gender'], _count: { _all: true } })`
  + raw SQL `SELECT u.gender, AVG(ri.score) FROM ReadingIndex JOIN User
  JOIN Address ... GROUP BY u.gender`.
- Cache: `CacheService.keys.genderBreakdown(scope, scopeId ?? 'all')`
  TTL `stats5min`.

#### `getAgeBreakdown(scope, scopeId?, user?, resolvedViloyatId?)`

- Returns `Array<{ ageGroup: '7-14'|'15-30'|'31-60'|'60+'|'unknown',
  userCount, readingIndex }>` (≤5 buckets).
- Single replica raw SQL with `date_part('year', age(NOW(), u."dob"))`
  + CASE bucketing + LEFT JOIN ReadingIndex (30-day window).
- Cache: `CacheService.keys.ageBreakdown(scope, scopeId ?? 'all')` TTL
  `stats5min`.
- Mahalla scope supported on-demand (cache hit absorbs hot reads).

#### `getGenreTrend(months, scope, scopeId?, user?, resolvedViloyatId?)`

- Returns `Array<{ genre, monthly: Array<{ month: 'YYYY-MM', count }> }>`
  for top-15 genres over the last N months (default 12, clamped 1..36).
- Single replica raw SQL with `to_char(date_trunc('month',
  bt."createdAt"), 'YYYY-MM')` + `b.genre` join + GROUP BY (genre, month).
- Post-process pivots to per-genre series + cuts to top-15 by total.
- Cache: `CacheService.keys.genreTrend(scope, scopeId ?? 'all')` TTL 1h.

### `apps/backend/src/common/utils/__tests__/age-group.util.spec.ts` — NEW

15 tests covering bucket boundaries at 7/14/15/30/31/60/61, the
birthday-tomorrow / birthday-today / earlier-this-year edge, null /
invalid DOB → `unknown`, ISO string parsing, and default-referenceDate
safety.

### `apps/backend/src/modules/admin/__tests__/admin.service.expansion.spec.ts` — NEW

17 tests covering the new services + markBookForOrder:
- Gender: national shape, viloyat scope allow/deny, cache key shape.
- Age: 5-bucket return, tuman scope allow/deny.
- Genre trend: pivot shape, cache key + 1h TTL, SUPER_ADMIN bypass.
- markBookForOrder: quantity bounds, 404 on missing book,
  KUTUBXONACHI scope check, AiAuditLog shape, 24h dedupe path.

## T2 — STAT-07 markBookForOrder + endpoints

### `apps/backend/src/modules/admin/dto/order-request.dto.ts` — NEW

```ts
export class OrderRequestDto {
  @IsString() @IsNotEmpty() bookId!: string;
  @IsInt() @Min(1) @Max(100) requestedQuantity!: number;
}
```

`Max(100)` bounds the audit log analysis string and prevents a tampered
client from posting an absurd quantity.

### `AdminService.markBookForOrder(dto, user)` — NEW

- Look up book on replica; throw `NotFoundException` on miss.
- KUTUBXONACHI scope check: `user.libraryId === book.libraryId` or
  `ForbiddenException` (T-05-01c). Other admin tiers gated by RolesGuard
  at the controller.
- 24h dedupe: `replica.aiAuditLog.findFirst` with
  `recommendation: { contains: '"bookId":"<id>"' }` AND `resolved: false`
  AND `createdAt >= now - 24h`. Match → return existing row.
- Create on primary: `prisma.aiAuditLog.create` with
  ```
  scope:        "LIBRARY"
  scopeId:      <book.libraryId>
  issueType:    ALERT_TYPES.ORDER_REQUEST  // from Plan 05-01
  severity:     Severity.LOW
  analysis:     `${book.title} uchun ${qty} nusxa zarur`
  recommendation: JSON.stringify({ bookId, requestedQuantity, requestedBy, requestedAt })
  ```

### `apps/backend/src/modules/admin/admin.controller.ts` — 4 new routes

```
GET  /admin/stats/gender?scope=&scopeId=          @Roles(SUPER_ADMIN, VILOYAT_ADMIN, TUMAN_ADMIN)
GET  /admin/stats/age?scope=&scopeId=             @Roles(SUPER_ADMIN, VILOYAT_ADMIN, TUMAN_ADMIN)
GET  /admin/stats/genres/trend?months=&scope=&    @Roles(SUPER_ADMIN, VILOYAT_ADMIN, TUMAN_ADMIN)
POST /admin/stats/order-request                   @Roles(SUPER_ADMIN, VILOYAT_ADMIN, TUMAN_ADMIN, MUASSASA_ADMIN, KUTUBXONACHI)
```

All read endpoints pre-resolve `Tuman.viloyatId` when `scope=tuman` so
the service-level `assertTumanInScope` VILOYAT_ADMIN cross-viloyat check
has the data it needs (mirrors `getTumanStats` from Plan 05-02).

For KUTUBXONACHI on `POST /admin/stats/order-request`, the controller
resolves the caller's `libraryId` via the institution-affiliation pattern
copied from `payment.controller.getCallerLibraryId`
(`user.schoolId ?? user.universityId ?? u.organizationId` → `Library`
lookup). The service-layer check then asserts `user.libraryId ===
book.libraryId`.

`GET /admin/stats/shortage` widened to include `KUTUBXONACHI` in the
allowed roles so library staff can see the list they're authorized to
order from. Existing tier admins unchanged.

### `_fetchBookShortage` — surfaces `bookId`

The shortage rows now carry `bookId` so the frontend `Buyurtma` button
can POST the right id. No schema change.

## T3 — Frontend charts + ShortageTab Buyurtma modal

### `apps/frontend/components/charts/GenderBreakdownChart.tsx` — NEW

Recharts `PieChart` donut. Props: `{ scope?, scopeId? }`. Fetches
`/admin/stats/gender?scope=&scopeId=` via `apiClient` (Phase 1 cookie
auth). Tooltip shows count + RI per slice.

### `apps/frontend/components/charts/AgeBreakdownChart.tsx` — NEW

Recharts `BarChart` with two bars per bucket (userCount + readingIndex).
Buckets sorted into canonical order `[7-14, 15-30, 31-60, 60+, unknown]`.

### `apps/frontend/components/charts/GenreTrendChart.tsx` — NEW

Recharts stacked `AreaChart`. Pivots backend's per-genre series to
per-month rows with one stacked area per top-15 genre. Palette of 15
distinct fills.

### `apps/frontend/components/stats/ShortageTab.tsx` — NEW (extracted)

Same table as before plus:
- Per-row `Buyurtma` button.
- Modal with `requestedQuantity` (1..100, defaulted to
  `ceil(requestCount / 10)`) + `reason` textarea (3+ char min after
  trim — mirrors Phase 4 PAY-08 validation rule).
- Submit fires `POST /admin/stats/order-request` via `apiClient`.
- Success → toast + button disables to "So'rov yuborildi".
- Failure → toast with backend error message.
- Optimistic dedupe in `Set<string>` keyed by `bookId` so the user
  doesn't double-submit even if the backend's 24h dedupe would also
  catch it.

### `apps/frontend/app/[locale]/dashboard/stats/page.tsx` — wiring

- 3 new TAB entries: `gender`, `age`, `genres-trend`.
- New tab content delegates to the chart components with `scope` +
  `scopeId` derived from the existing `level`/`selectedViloyat` state.
- Inline `ShortageTab` removed; the imported `ShortageTabComponent`
  replaces it.
- Local `ShortageItem` type re-exported from the new component (now
  includes `bookId`).

## Verification matrix

| Surface                                  | Result                                    |
|------------------------------------------|-------------------------------------------|
| Backend full suite (`npm test`)          | 1317 passing (baseline 1273, +44)         |
| Backend `tsc --noEmit`                   | clean                                     |
| Backend `npm run lint:replica`           | 0 hits (this.prisma heavy reads)          |
| Frontend `tsc --noEmit`                  | clean                                     |
| Frontend `npm run build`                 | succeeds; dashboard/stats x4 locales      |
| Grep `Math.round(42 +` in frontend       | 0 hits (regression guard)                 |
| age-group.util spec                      | 15 passing                                |
| admin.service.expansion spec             | 17 passing                                |

## Commit sequence

1. `feat(common)(05-03)`: getAgeGroup util + scope-aware gender/age/genre-trend services (STAT-04/05/06)
2. `feat(admin)(05-03)`: book shortage endpoint widened + markBookForOrder with 24h dedupe (STAT-07)
3. `feat(frontend)(05-03)`: charts + ShortageTab Buyurtma modal wire-up
4. SUMMARY commit (this file)

## Deviations

- The plan's `(scope, scopeId?, user?)` service signatures gained an
  extra `resolvedViloyatId?: string | null` parameter to match the
  existing `getTumanStats` contract from Plan 05-02. Without this,
  VILOYAT_ADMIN cross-viloyat assertion would fail-CLOSED on every
  tuman-scope read because `assertTumanInScope` requires the resolved
  parent viloyatId. The controller pre-resolves
  `Tuman.viloyatId` via `prisma.tuman.findUnique` and forwards it.

- The plan's `ShortageTab` modal asks for a `reason` textarea; the
  backend `OrderRequestDto` does not currently carry a `reason` field
  because the `recommendation` JSON already serializes
  `{ bookId, requestedQuantity, requestedBy, requestedAt }`. Future
  iteration can extend the DTO + `recommendation` JSON to include
  `reason` without a schema migration. The UX validation (3+ char)
  still gates submission as a defensive UX guard.

- `recommendation` is stored as a JSON string in the existing
  `AiAuditLog.recommendation` `String` column; the dedupe query uses
  Prisma's `String.contains` filter (substring match on
  `"bookId":"<id>"`). Avoids a `jsonb` migration on a low-write table.

- Frontend Recharts `Tooltip` formatter has a stricter typing in 2.12
  than expected; the `entry` parameter is typed as `Payload<...>` and
  payload is optional. The formatter signature uses a defensive
  `(entry as { payload?: { ri?: number } })?.payload?.ri ?? 0` so the
  type stays clean without `any`.

## Downstream consumers unblocked

- **Plan 05-04 (notification fan-out)** — the new `ALERT_TYPES.ORDER_REQUEST`
  rows written by `markBookForOrder` are now generated by user action
  (not just cron alerts), so Plan 05-04's notification template needs to
  handle `ORDER_REQUEST` issueType the same as the cron-triggered alerts.
- **Plan 05-05 (alert consolidation)** — the dedupe pattern (substring
  match on JSON recommendation within 24h) is a useful reference for
  the consolidated alert engine's cross-source dedupe.
- **Plan 05-06 (landing page)** — `getGenderBreakdown` / `getAgeBreakdown`
  are the data sources the public landing page's "Bizning kitobxonlar"
  block consumes.
