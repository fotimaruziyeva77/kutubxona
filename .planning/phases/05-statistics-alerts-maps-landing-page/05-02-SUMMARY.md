---
phase: 05-statistics-alerts-maps-landing-page
plan: 02
status: completed
completed_at: 2026-06-07
commits:
  - 22dbbf6 feat(stats)(05-02): PrismaReplicaService routing + scope guards + per-viloyat RI (STAT-01)
  - cf9ca3b feat(stats)(05-02): STATS_AGGREGATION_QUEUE + 5min/15min pre-agg crons + mahalla on-demand (STAT-03)
  - 7a85d21 feat(frontend)(05-02): dashboard SSR prefetch + delete simulated RI line (STAT-02)
backend_tests: "1273 passing (baseline 1217, delta +56)"
frontend_tests: "9 passing (geojson contract spec)"
backend_tsc: clean
frontend_tsc: clean
frontend_build: succeeds (dashboard route emitted for all 4 locales)
lint_replica: "0 hits (this.prisma heavy reads in admin.service.ts)"
simulated_ri_grep: "0 hits (apps/frontend tree)"
---

# Plan 05-02 SUMMARY — Wave 2 Stats Hardening

STAT-01 (4-level hierarchy + replica routing + scope guards), STAT-02
(dashboard real numbers), and STAT-03 (Redis pre-aggregation) close
together. Three sequential commits + this summary.

## T1 — Replica routing + scope guards + per-viloyat RI fix (STAT-01)

### `apps/backend/src/common/utils/admin-scope.util.ts`

Two pure helpers that mirror Phase 4-04-fix-followup `assertLibraryInScope`:

```ts
assertViloyatInScope(user, requestedViloyatId): void
assertTumanInScope(user, requestedTumanId, { resolvedViloyatId? }): void
```

- SUPER_ADMIN + BUXGALTER bypass (global financial/monitoring scope).
- VILOYAT_ADMIN: must have non-null `address.viloyatId` matching the request.
- TUMAN_ADMIN: must have non-null `address.tumanId` matching the request.
  Cannot query viloyat-scope at all (narrower).
- Fail-CLOSED: null scope on a tier-admin → `ForbiddenException`. Mirrors
  Plan 04-04-fix-followup FIX D follow-up exactly.
- Pure: no DB calls; caller pre-resolves `resolvedViloyatId` (Tuman.viloyatId)
  before calling `assertTumanInScope` for the VILOYAT_ADMIN cross-viloyat
  check.

### `apps/backend/src/modules/admin/admin.service.ts` — diff summary

- Constructor gains two optional injected deps:
  `@Optional() PrismaReplicaService` + `@Optional() @InjectQueue(STATS_AGGREGATION_QUEUE) Queue`.
  Optional so existing unit tests instantiating the 3-arg form continue to
  work. Runtime DI always supplies them.
- New `private get replica()` accessor returns the replica client when DI
  injected one, falls back to `this.prisma` when not (single-node dev / tests).
- ALL heavy reads now route through `this.replica.*` — 16 read sites moved:
  - `getDashboardStats` (the `$transaction([...])` was dropped: read-replicas
    can't host writes, so transactions are pointless; `Promise.all` preserves
    parallelism)
  - `getPendingUsers`, `autoFallbackPendingUsers` findMany, `remindPendingUsers`
    findMany, `monthlyInventoryAudit` findMany
  - `getAuditLogs`, `getRiskLogs`
  - `_fetchNationalStats` (all 13 parallel queries)
  - `_fetchViloyatStats`, `_fetchAllViloyatStats`
  - `_fetchTumanStats`, `_fetchMahallaStats` (new)
  - `_fetchGenreStats`, `_fetchBookShortage`
  - `checkSmartAlerts` (library/bookTransaction/aiAuditLog/readingIndex reads)
  - `getSmartAlerts`
- Writes (`.create/.update/.delete`) on `approveUser`, `rejectUser`,
  `monthlyInventoryAudit` audit-log create, `checkSmartAlerts` audit-log
  create, `resolveAlert`, `createDemoRequest`, `updateDemoRequest` stay
  on `this.prisma`.

### Scope-guard wiring

- `getViloyatStats(viloyatId, user?)` — first line `if (user) assertViloyatInScope(user, viloyatId);` BEFORE `cache.remember`.
- `getTumanStats(tumanId, user?, resolvedViloyatId?)` — same shape; controller
  pre-resolves Tuman.viloyatId for the cross-viloyat check.
- `getMahallaStats(mahallaId, user?)` — first looks up the mahalla via replica
  (`mahalla.findUnique` with `tumanId` + `tuman.viloyatId`), then asserts
  scope. Returns `ForbiddenException` on missing mahalla too (don't leak
  existence to unauthorized callers).

### `_fetchAllViloyatStats` per-viloyat RI fix (the headline bug)

BEFORE: `groupBy("userId").reduce(...).avg(...)` returned a SINGLE global avg.
Shape: `{ libraries, avgRI: number }`.

AFTER: single raw-SQL `GROUP BY viloyatId` via the read replica:

```sql
SELECT a."viloyatId", COUNT(DISTINCT u.id), AVG(ri.score)::float
FROM "ReadingIndex" ri
JOIN "User" u ON ri."userId" = u.id
JOIN "Address" a ON u."addressId" = a.id
WHERE ri."calculatedAt" >= NOW() - INTERVAL '30 days'
  AND a."viloyatId" IS NOT NULL
GROUP BY a."viloyatId"
```

Shape: `{ libraries: Record<id, number>, viloyats: Record<id, {readingIndex, userCount}> }`.

Spec asserts 3 viloyat fixtures return 3 distinct readingIndex values —
proves it is per-viloyat, not a global average.

### `apps/backend/src/modules/admin/admin.controller.ts` — wires `@CurrentUser` + `resolveCallerScope` through to the asserts

```ts
@Get("stats/viloyat/:id")
async getViloyatStats(@Param("id") id, @CurrentUser() user: JwtPayload) {
  const scope = await this.resolveCallerScope(user);  // looks up address.{viloyatId,tumanId}
  return this.adminService.getViloyatStats(id, scope);
}

@Get("stats/tuman/:id")
async getTumanStats(@Param("id") id, @CurrentUser() user: JwtPayload) {
  const scope = await this.resolveCallerScope(user);
  const tuman = await this.prisma.tuman.findUnique({ where: { id }, select: { viloyatId: true } });
  return this.adminService.getTumanStats(id, scope, tuman?.viloyatId ?? null);
}

@Get("stats/mahalla/:id")  // NEW
async getMahallaStats(@Param("id") id, @CurrentUser() user: JwtPayload) { ... }
```

### Lint gate

New npm script: `lint:replica` greps `admin.service.ts` for any remaining
`this.prisma.<heavy>` reads. Currently emits 0 hits.

```bash
$ cd apps/backend && npm run lint:replica
lint:replica OK (0 heavy reads on primary)
```

### Specs

- `common/utils/__tests__/admin-scope.util.spec.ts` — 17 tests covering
  SUPER_ADMIN/BUXGALTER bypass, matching/mismatched scope, fail-CLOSED on
  null scope, role guards (KITOBXON/TUMAN_ADMIN reaching viloyat).
- `modules/admin/__tests__/admin.service.scope-guard.spec.ts` — 21 tests
  covering replica-fixture-backed service-level scope assertions for the
  three endpoints + per-viloyat RI shape + replica-routing regression
  guards.
- `modules/admin/__tests__/admin.service.spec.ts` — migrated
  `getDashboardStats` from `$transaction` mock to `Promise.all` mock-once
  chain.

## T2 — STATS_AGGREGATION_QUEUE + crons + mahalla on-demand (STAT-03)

### `apps/backend/src/infra/queue/queue.module.ts`

New constant + queue registration:

```ts
export const STATS_AGGREGATION_QUEUE = "stats-aggregation";

BullModule.registerQueue({
  name: STATS_AGGREGATION_QUEUE,
  defaultJobOptions: { attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } }
})
```

`attempts: 1` because retrying a stale pre-warm wastes work — the next cron
tick will warm anyway.

### `apps/backend/src/modules/admin/stats-aggregation.processor.ts`

`@Processor(STATS_AGGREGATION_QUEUE)` worker. Three job names:

```ts
warm-national  → adminService.getNationalStats()
warm-viloyat   → adminService.getViloyatStats(data.viloyatId)   // no user — bypass scope
warm-tuman     → adminService.getTumanStats(data.tumanId)       // no user — bypass scope
```

`forwardRef(() => AdminService)` avoids the circular dep (Admin depends on
the queue, processor depends on Admin). `@OnWorkerEvent("failed")` logs;
BullMQ has `attempts: 1` so failures don't retry — the next cron warms.

### `apps/backend/src/modules/admin/admin.service.ts` — two new `@Cron` crons

```ts
@Cron("*/5 * * * *",  { name: "stats-preagg-national-viloyat", timeZone: "Asia/Tashkent" })
async preaggregateNationalAndViloyat()

@Cron("*/15 * * * *", { name: "stats-preagg-tuman",            timeZone: "Asia/Tashkent" })
async preaggregateTumans()
```

Each cron:

1. Acquires a Redis SETNX leader-lock on `cron:stats-aggregation:<scope>:<bucket>`
   with TTL 4 min / 14 min (~80% of cycle so a delayed worker doesn't
   double-fire). If the lock is taken (other replica won), the cron exits
   silently — multi-replica safe.
2. Enqueues via `queue.add` + `queue.addBulk` with deterministic dedupe
   jobIds: `warm-national:<bucket>`, `warm-viloyat:<id>:<bucket>`,
   `warm-tuman:<id>:<bucket>` where `<bucket>` = `new Date().toISOString().slice(0,16)`
   (minute resolution). BullMQ silently rejects duplicate jobIds.

Mahalla scope is intentionally **NOT** warmed — Q3 user decision per
05-RESEARCH §STAT-03 §Gotcha. The cron only warms 1 + ~14 + ~200 keys.
Mahalla is on-demand with a 30-min cache TTL via `getMahallaStats →
CacheService.keys.mahallaStats(id) + CacheService.ttl.stats30min`.

### `invalidateStatsCache` helper

```ts
async invalidateStatsCache(): Promise<void> {
  await this.cache.delPattern("stats:*");
}
```

Entry point for Plan 05-05 Kafka consumer wiring (e.g., on `ri.recalc.completed`
or `alert.resolved`).

### `apps/backend/src/modules/admin/admin.module.ts`

`BullModule.registerQueue({ name: STATS_AGGREGATION_QUEUE })` + `StatsAggregationProcessor`
in providers.

### Specs

- `modules/admin/__tests__/stats-aggregation.processor.spec.ts` — 7 tests
  covering all 3 job names + missing-data throws + unknown-name throws +
  regression guard that the cron path never passes a user arg.
- `modules/admin/__tests__/admin.service.preaggregation.spec.ts` — 11
  tests covering:
  - 5-min cron enqueues 1 warm-national + N warm-viloyat in one addBulk
  - 15-min cron enqueues N warm-tuman
  - Leader-lock key shape `cron:stats-aggregation:<scope>:<bucket>` with
    correct TTLs (240s, 840s)
  - SETNX returning false → no enqueue (multi-replica regression guard)
  - jobId dedupe shape regex `warm-<scope>:<id>:<YYYY-MM-DDTHH:MM>`
  - Mahalla NOT in cron path (regression guard)
  - `invalidateStatsCache` calls `cache.delPattern("stats:*")`
  - `getMahallaStats` wraps with `cache.remember(stats:mahalla:<id>, 1800, fn)`

## T3 — Dashboard SSR prefetch + remove simulated RI (STAT-02)

### `apps/frontend/app/[locale]/dashboard/page.tsx` — now a Server Component

```tsx
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

async function fetchInitialStats() {
  try {
    const cookie = (await headers()).get("cookie") ?? "";
    const res = await fetch(`${API_BASE}/admin/stats/national`, {
      headers: { cookie },
      next: { revalidate: 300 },  // aligns with 5-min stats TTL
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export default async function DashboardPage() {
  const initialStats = await fetchInitialStats();
  return <DashboardClient initialStats={initialStats as never} />;
}
```

When SSR fetch fails (auth or backend down), `initialStats` is `null` and
the client falls back to its existing `—` placeholder defensively (no
SSR-time throw). Eliminates the dash on auth-success paths.

### `apps/frontend/app/[locale]/dashboard/DashboardClient.tsx` — NEW

Houses the existing client subtree. Receives `initialStats` prop and
forwards it as `initialData` to the existing `useQuery({ queryKey:
["national-stats"], queryFn: fetchNationalStats, staleTime: 300_000,
initialData: initialStats ?? undefined })`. The loading screen only shows
when `initialStats === null` AND the client query is still in-flight —
successful SSR prefetch renders real numbers immediately.

### `apps/frontend/app/[locale]/dashboard/stats/page.tsx` — delete simulated RI line

Before:

```ts
const ri = Math.round(42 + (v.id.charCodeAt(3) % 10) * 4.5);  // line 453
return { ..., readingIndex: ri, users: Math.round(libCount * 120) };
```

After:

```ts
const viloyatRiMap = allViloyatStats?.viloyats ?? {};
const vRi = viloyatRiMap[v.id];
return { ..., readingIndex: vRi?.readingIndex ?? 0, users: vRi?.userCount ?? 0 };
```

Reads real per-viloyat RI from the backend shape fixed in T1. Grep gate:

```bash
$ grep -r 'Math\.round(42 \+' apps/frontend
(no matches)
```

## Verification matrix

| Surface                                | Result                              |
|----------------------------------------|-------------------------------------|
| Backend full suite (`npm test`)        | 1273 passing (baseline 1217, +56)   |
| Backend `tsc --noEmit`                 | clean                               |
| Backend `npm run lint:replica`         | 0 hits (this.prisma heavy reads)    |
| Frontend `tsc --noEmit`                | clean                               |
| Frontend jest (geojson contract)       | 9 passing                           |
| Frontend `npm run build`               | succeeds, dashboard emitted x4 locales |
| Grep `Math.round(42 +` in frontend     | 0 hits                              |
| admin-scope.util spec                  | 17 passing                          |
| admin.service.scope-guard spec         | 21 passing                          |
| stats-aggregation.processor spec       | 7 passing                           |
| admin.service.preaggregation spec      | 11 passing                          |

## Commit sequence

1. `22dbbf6 feat(stats)(05-02): PrismaReplicaService routing + scope guards + per-viloyat RI (STAT-01)`
2. `cf9ca3b feat(stats)(05-02): STATS_AGGREGATION_QUEUE + 5min/15min pre-agg crons + mahalla on-demand (STAT-03)`
3. `7a85d21 feat(frontend)(05-02): dashboard SSR prefetch + delete simulated RI line (STAT-02)`

## Deviations

- The plan listed `getDashboardStats` writes still on `$transaction`, but
  read-replicas cannot host write-transactions and a `$transaction` over
  pure reads provides snapshot isolation we don't need at 5-min cache
  granularity. Replaced with `Promise.all` for parallelism. Existing spec
  migrated from `$transaction` mock to per-call mock chain.
- Mahalla scope endpoint at `getMahallaStats` does not have a `libraries`
  count — `Library` has no `mahallaId` FK in the schema; the closest
  proxy is `Library` count within the parent `Tuman`, which the service
  uses. Documented inline.
- `lint:replica` grep regex uses Node `String.match` (cross-platform
  Windows/Linux) rather than POSIX grep — avoids a CI portability gotcha
  while still failing fast on a non-zero match count.
- The dashboard SSR refactor split out a `DashboardClient.tsx` rather
  than rewriting the existing page in place. This is a pure mechanical
  lift (line-by-line identical client subtree) so the existing diff is
  reviewable; the only semantic change is the `initialData` hookup.
- `NEXT_PUBLIC_DISABLE_OTP` blocked `npm run build` until cleared (pre-
  existing dev-flag fail-CLOSED guard unrelated to this plan). Build
  smoke ran with the env unset and succeeded — documented for the
  Plan 05-09 closeout to capture in `.env.example`.

## Downstream consumers unblocked

- **Plan 05-05 (alert engine)** — consumes the replica-routing pattern
  + new `invalidateStatsCache` helper hook + the consolidated audit-log
  scope assertions.
- **Plan 05-06 (choropleth)** — consumes the new `{ libraries, viloyats:
  Record<id, {readingIndex, userCount}> }` backend shape directly; the
  `Math.round(42 + ...)` simulation is GONE so the choropleth will paint
  real data on first render.
- **Plan 05-07 (WebSocket real-time)** — consumes the pre-agg crons firing
  reliably (multi-replica safe via SETNX + jobId dedupe); the emit hook
  can attach in StatsAggregationProcessor's success handler.
- **Plan 05-09 (closeout)** — needs `.env.example` to note the
  `NEXT_PUBLIC_DISABLE_OTP=` build-time clear requirement.
