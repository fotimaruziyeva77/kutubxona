---
phase: 07-offline-pwa-internationalization-production-launch
plan: 02
subsystem: frontend-offline, backend-privacy, backend-audit
tags: [pwa, offline-sync, conflict-resolution, privacy, audit-partition, 2g-lite-mode]
dependency_graph:
  requires: [07-01]
  provides: [offline-sync-engine, conflict-resolver, offline-ui-components, privacy-service, audit-partition-cron]
  affects: [users-module, ai-audit-module, frontend-offline-stack]
tech_stack:
  added: ["@babel/preset-typescript (frontend devDep)", "@babel/preset-env (frontend devDep)"]
  patterns: [dexie-sync-queue, background-sync-api, last-write-wins-conflict, react-context-lite-mode, nestjs-cron-partition-lifecycle]
key_files:
  created:
    - apps/frontend/lib/offline/conflict-resolver.ts
    - apps/frontend/components/offline/OfflineBanner.tsx
    - apps/frontend/components/offline/SyncStatusBadge.tsx
    - apps/frontend/components/offline/LiteModeBanner.tsx
    - apps/frontend/lib/offline/__tests__/sync.test.js
    - apps/frontend/lib/offline/__tests__/conflict-resolver.test.js
    - apps/frontend/babel.config.js
    - apps/backend/src/modules/users/privacy.service.ts
    - apps/backend/src/modules/users/__tests__/privacy.service.spec.ts
  modified:
    - apps/frontend/lib/offline/sync.ts
    - apps/backend/src/modules/users/users.controller.ts
    - apps/backend/src/modules/users/users.service.ts
    - apps/backend/src/modules/users/users.module.ts
    - apps/backend/src/modules/ai/audit.service.ts
    - apps/frontend/package.json
    - package-lock.json
decisions:
  - "Frontend test files use .js extension (not .ts) to match existing frontend test conventions"
  - "Babel preset-typescript added to enable Jest to transform TypeScript source imports from JS test files"
  - "Book transaction conflicts (409) always discard (last-write-wins) since library state is authoritative"
  - "Non-transaction conflicts compare updatedAt timestamps for retry/discard decision"
  - "Audit partition cleanup uses DETACH + DROP for safe idempotent removal"
metrics:
  duration_minutes: ~35
  completed: "2026-06-09"
  tasks_completed: 2
  tasks_total: 2
  tests_added: 14
  tests_passing: 14
---

# Phase 07 Plan 02: Offline Sync Engine + Privacy + Audit Retention Summary

Auth-aware Dexie sync queue with JWT refresh before replay, last-write-wins conflict resolution, 3 offline UI components (banner/badge/lite-mode), privacy service with hide-reading-history toggle, and monthly AiAuditLog partition cleanup cron for 24-month retention.

## Task 1: Offline sync engine + conflict resolver + UI components (PWA-03/05/06)

**Commit:** `83fe42a`

### Sync Engine (`apps/frontend/lib/offline/sync.ts`)
- Replaced stub with full implementation
- `syncPendingTransactions()`: reads Dexie syncQueue, calls `/api/auth/refresh` first for fresh JWT, replays each entry with Authorization header
- 200/201: deletes from queue. 409: calls `resolveConflict()`. 401: stops (refresh token expired). Other: increments retryCount
- `queueOfflineTransaction()`: creates SyncQueueEntry with uuid v4, stores in IndexedDB, registers Background Sync via service worker
- `getPendingSyncCount()`: returns queue count for badge UI
- `clearSyncQueue()` and `replayOfflineQueue()` aliases for sw.ts compatibility

### Conflict Resolver (`apps/frontend/lib/offline/conflict-resolver.ts`)
- Transaction URLs (`/api/transactions`, `/api/bookings`) always return `"discard"` -- library state is authoritative
- Non-transaction: compares `updatedAt` timestamps; newer server = discard, older server = retry with merged version

### UI Components
- `OfflineBanner.tsx`: amber banner when offline, green reconnection toast (3s fade)
- `SyncStatusBadge.tsx`: polls pending count (5s offline, 30s online), shows "{N} ta kutmoqda" badge
- `LiteModeBanner.tsx`: React context for LiteMode with 2G detection, shows "yengil rejim faollashtirildi" banner

### Tests
- 5 sync specs: refresh-before-replay, 200-delete, 409-resolveConflict, 401-stops, queue-creates-uuid
- 3 conflict-resolver specs: transaction-discard, newer-server-discard, older-server-retry-merge
- All 8 passing

## Task 2: Privacy service + audit partition cron (PERF-05/PERF-06)

**Commit:** `42ea54d`

### Privacy Service (`apps/backend/src/modules/users/privacy.service.ts`)
- `toggleReadingHistoryVisibility(userId, hide)`: updates `user.hideReadingHistory` via Prisma, returns `{ hideReadingHistory: boolean }`
- `getPrivacySettings(userId)`: returns current privacy settings, throws NotFoundException if user missing
- `filterReadingHistoryForPublic(hideReadingHistory, data)`: strips `bookTransactions`, `transactions`, `readingIndex` when true

### Privacy Endpoints (`users.controller.ts`)
- `GET /users/me/privacy` -- returns privacy settings
- `PATCH /users/me/privacy` -- updates `hideReadingHistory` toggle

### Server-side Filter (`users.service.ts`)
- `getProfile()` now checks `user.hideReadingHistory` and deletes transaction/reading data from response when true (PERF-06)

### Audit Partition Cron (`ai/audit.service.ts`)
- `@Cron("0 2 1 * *")` -- runs 2:00 AM on 1st of each month
- Computes 24-month cutoff, iterates from 2024-01 to cutoff
- Executes `ALTER TABLE ... DETACH PARTITION` + `DROP TABLE` via `prisma.$executeRawUnsafe`
- Wrapped in try/catch for idempotency (partition may already be removed)

### Tests
- 6 privacy service specs: toggle-true, toggle-false, getPrivacySettings-returns, getPrivacySettings-throws-404, filter-strips-when-true, filter-unchanged-when-false
- All 6 passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Frontend Jest cannot parse TypeScript source files**
- **Found during:** Task 1
- **Issue:** Frontend project had no TypeScript transform configured for Jest. Test files importing `.ts` sources failed with parse errors on type annotations.
- **Fix:** Installed `@babel/preset-typescript` and `@babel/preset-env` as devDependencies, created `apps/frontend/babel.config.js` with both presets. Converted test files to `.js` extension to match existing frontend test conventions.
- **Files modified:** `apps/frontend/babel.config.js` (created), `apps/frontend/package.json` (devDeps added)
- **Commit:** `83fe42a`

## Known Stubs

None -- all functions are fully implemented with real logic (no placeholder/TODO/hardcoded empty values).

## Self-Check: PASSED

- 15/15 files verified present on disk
- 2/2 task commits verified in git log (83fe42a, 42ea54d)
- 14/14 tests passing (8 frontend + 6 backend)
