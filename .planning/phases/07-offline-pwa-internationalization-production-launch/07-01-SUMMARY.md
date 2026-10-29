---
phase: 07-offline-pwa-internationalization-production-launch
plan: 01
subsystem: infra, pwa, database
tags: [serwist, dexie, service-worker, pwa, prisma, partitioning, elasticsearch, icu, offline]

# Dependency graph
requires:
  - phase: 01-infrastructure-hardening-authentication
    provides: Next.js app with next-intl, Prisma schema, docker-compose
  - phase: 02-core-library-operations-reading-engine
    provides: ReadingIndex partitioning pattern, Prisma migration conventions
provides:
  - "@serwist/next integrated into next.config.js for production-grade SW"
  - "Dexie.js schema with syncQueue, cachedBooks, cachedLibraries tables"
  - "2G detection utility (detect2G, isOnline, useNetworkStatus)"
  - "User.hideReadingHistory column in database"
  - "AiAuditLog range-partitioned by month (60 partitions, 2024-01..2028-12)"
  - "Elasticsearch ICU plugin configured in docker-compose"
  - "replayOfflineQueue stub for Plan 07-02"
affects: [07-02, 07-03, 07-04, 07-05, 07-06]

# Tech tracking
tech-stack:
  added: ["@serwist/next ^9.5.11", "serwist ^9.5.11 (dev)", "dexie ^4.4.3", "uuid ^11.0.3", "axe-core ^4.12.0 (dev)", "@lhci/cli ^0.15.1 (dev)"]
  patterns: ["Serwist SW source at app/sw.ts with build-time precache manifest", "Dexie typed schema for offline IndexedDB", "PG range partitioning for audit logs (mirrors ReadingIndex pattern)"]

key-files:
  created:
    - apps/frontend/app/sw.ts
    - apps/frontend/lib/offline/db.ts
    - apps/frontend/lib/offline/network-status.ts
    - apps/frontend/lib/offline/sync.ts
    - apps/backend/prisma/migrations/20260609000000_phase7_privacy_audit/migration.sql
  modified:
    - apps/frontend/package.json
    - apps/frontend/next.config.js
    - apps/backend/prisma/schema.prisma
    - docker-compose.yml
    - package-lock.json

key-decisions:
  - "Serwist SW disabled in development mode to avoid cache interference during dev"
  - "sync.ts stub created for tsc pass -- Plan 07-02 replaces with full Background Sync replay"
  - "AiAuditLog 60 fixed partitions (2024-01..2028-12) vs dynamic -- simpler, covers 5-year window"
  - "SyncEvent interface declared locally in sw.ts -- WebWorker lib does not include BackgroundSync types"

patterns-established:
  - "Serwist wraps outermost in next.config.js: withSerwist(withNextIntl(config))"
  - "Offline utilities under lib/offline/ directory convention"
  - "PG partition migrations use @prisma-skip-generate and follow Phase 2 rename+create+copy+drop pattern"

requirements-completed: [PWA-01, PWA-02, PWA-04, PERF-06]

# Metrics
duration: 12min
completed: 2026-06-09
---

# Phase 7 Plan 01: Wave 0 Foundations Summary

**Serwist PWA service worker + Dexie offline DB + 2G detector + User privacy column + AiAuditLog monthly partitioning + ES ICU plugin**

## Performance

- **Duration:** 12 min
- **Started:** 2026-06-09T00:23:18Z
- **Completed:** 2026-06-09T00:35:55Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- Replaced hand-written sw.js with Serwist-managed service worker (build-time precache manifest, skipWaiting, clientsClaim, navigationPreload, defaultCache runtime strategies)
- Created Dexie.js typed offline database schema with syncQueue, cachedBooks, and cachedLibraries tables for 12-hour offline operation
- Added 2G detection utility and useNetworkStatus React hook for lite mode toggling
- Added User.hideReadingHistory Boolean for PERF-06 privacy (server-side filter in public endpoints)
- Converted AiAuditLog to range-partitioned table with 60 monthly partitions (2024-01 through 2028-12) for PERF-05 2-year retention
- Configured Elasticsearch ICU analysis plugin in docker-compose for I18N-03 multi-script search

## Task Commits

Each task was committed atomically:

1. **Task 1: PWA deps + Serwist SW + Dexie DB + 2G detector** - `d602bbe` (feat)
2. **Task 2: Prisma migration + ES ICU plugin** - `e212ed6` (feat)

## Files Created/Modified
- `apps/frontend/app/sw.ts` - Serwist service worker source with precache + runtime caching + Background Sync
- `apps/frontend/lib/offline/db.ts` - Dexie.js typed database (syncQueue, cachedBooks, cachedLibraries)
- `apps/frontend/lib/offline/network-status.ts` - detect2G(), isOnline(), useNetworkStatus() hook
- `apps/frontend/lib/offline/sync.ts` - replayOfflineQueue() stub (Plan 07-02 ships full impl)
- `apps/frontend/next.config.js` - withSerwist wraps withNextIntl
- `apps/frontend/package.json` - 6 new dependencies added
- `apps/backend/prisma/schema.prisma` - User.hideReadingHistory Boolean @default(false)
- `apps/backend/prisma/migrations/20260609000000_phase7_privacy_audit/migration.sql` - User column + AiAuditLog partitioning
- `docker-compose.yml` - ES analysis-icu plugin install command
- `package-lock.json` - lockfile updated with new deps

## Decisions Made
- **Serwist disabled in dev:** `disable: process.env.NODE_ENV === "development"` prevents cache interference during development
- **sync.ts stub:** Created minimal stub exporting `replayOfflineQueue()` so sw.ts compiles; Plan 07-02 replaces with full Background Sync replay including auth token refresh and conflict resolution
- **60 fixed partitions:** AiAuditLog uses 60 pre-created monthly partitions (Jan 2024 to Dec 2028) rather than dynamic generation -- simpler, covers the entire project lifecycle window
- **SyncEvent local interface:** WebWorker lib does not include BackgroundSync API types; declared locally in sw.ts with EventListener cast for type safety
- **Old sw.js deleted:** Removed hand-written service worker; Serwist generates public/sw.js at build time with content-hashed cache keys

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created sync.ts stub for TypeScript compilation**
- **Found during:** Task 1 (sw.ts references ../lib/offline/sync which doesn't exist yet)
- **Issue:** sw.ts imports replayOfflineQueue from sync.ts, but Plan 07-02 creates that file
- **Fix:** Created minimal stub with empty async function body and a catch() in sw.ts for graceful no-op
- **Files modified:** apps/frontend/lib/offline/sync.ts, apps/frontend/app/sw.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** d602bbe (Task 1 commit)

**2. [Rule 3 - Blocking] Added `/// <reference lib="webworker" />` to sw.ts**
- **Found during:** Task 1 (ServiceWorkerGlobalScope not found by tsc)
- **Issue:** tsconfig.json includes "dom" lib but not "webworker"; SW types unavailable
- **Fix:** Added triple-slash reference directive and local SyncEvent interface
- **Files modified:** apps/frontend/app/sw.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** d602bbe (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary for TypeScript compilation to pass. No scope creep. sync.ts stub is explicitly placeholder for Plan 07-02.

## Issues Encountered
- Pre-existing test failures (4 suites, 3 tests) in alert-types.const.spec.ts from Phase 6 additions (BOOK_CORNER_REMINDER, ORDER_REQUEST added to constant but test not updated). Not caused by this plan's changes. 1726/1729 tests pass.

## Known Stubs
- `apps/frontend/lib/offline/sync.ts` - replayOfflineQueue() is a no-op stub; Plan 07-02 ships full implementation with auth token refresh, Dexie queue replay, and conflict resolution

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Serwist SW foundation ready for Plan 07-02 (offline sync, offline banner, lite mode components)
- Dexie schema ready for Plan 07-02 (sync queue population, cached catalog)
- 2G detector ready for Plan 07-02 (LiteModeBanner component)
- User.hideReadingHistory ready for Plan 07-04 (privacy endpoint + public query filters)
- AiAuditLog partitions ready for Plan 07-02 (PERF-05 retention cron)
- ES ICU plugin ready for Plan 07-03 (multi-script analyzer configuration)

---
*Phase: 07-offline-pwa-internationalization-production-launch*
*Completed: 2026-06-09*
