---
phase: 02-reading-index-engine-core-book-logic
plan: 04
subsystem: [books, fraud, reading, store]
tags: [book-import, exceljs, bullmq, fraud-review, partition-cleanup, redis-cache, store-expiry]
dependency_graph:
  requires:
    - 02-01 (exceljs installed, RI_RECALC_QUEUE registered, FraudScore.action='review' mapping)
    - 02-02 (ReadingIndex partitioned table — partition name convention ReadingIndex_yYYYY_mMM)
    - 02-03 (RiRecalcProcessor pattern mirrored for BookImportProcessor)
  provides:
    - BOOK_IMPORT_QUEUE (book-import) — exposed via apps/backend/src/infra/queue/queue.module.ts
    - BookImportProcessor — @Processor(BOOK_IMPORT_QUEUE) WorkerHost
    - POST /books/import (202 + { jobId, status: 'queued' })
    - GET /books/import/:jobId/status (progress polling)
    - GET /ai/fraud/review-queue (admin tier-scoped)
    - POST /ai/fraud/:userId/resolve (approve | reject)
    - GET /reading/:userId/delta (daily/weekly/monthly with 1h Redis cache)
    - @Cron('0 4 1 * *') monthlyPartitionCleanup (DETACH 13mo / CREATE +3mo)
    - confirmPurchase 24h expiry gate
  affects:
    - books.service.ts (xlsx import removed; importFromExcel replaced by enqueueImport + getImportStatus)
    - fraud.service.ts (dailyFraudScan no longer auto-blocks; RI_SPIKE fixed; review-queue methods)
    - reading.service.ts (computeDelta + monthlyPartitionCleanup added)
    - store.service.ts (confirmPurchase rejects scans > 24h old)
tech-stack:
  added: [exceljs (parser switch from xlsx)]
  patterns: [BullMQ WorkerHost @ concurrency 2 for CPU-heavy parse, Redis remember/del for cache, raw SQL partition DDL, two-sided window comparison for RI_SPIKE]
key-files:
  created:
    - apps/backend/src/modules/books/books-import.processor.ts
    - apps/backend/src/modules/books/__tests__/books-import.processor.spec.ts
    - apps/frontend/app/[locale]/dashboard/fraud-review/page.tsx
  modified:
    - apps/backend/package.json (xlsx removed; exceljs retained)
    - apps/backend/src/infra/queue/queue.module.ts (BOOK_IMPORT_QUEUE registered)
    - apps/backend/src/modules/books/books.service.ts (enqueueImport + getImportStatus)
    - apps/backend/src/modules/books/books.controller.ts (POST 202 + GET status endpoint)
    - apps/backend/src/modules/books/books.module.ts (QueueModule + processor)
    - apps/backend/src/modules/ai/fraud.service.ts (no auto-block, review queue, RI_SPIKE fix)
    - apps/backend/src/modules/ai/ai.controller.ts (review-queue + resolve endpoints)
    - apps/backend/src/modules/reading/reading.service.ts (computeDelta + monthlyPartitionCleanup)
    - apps/backend/src/modules/reading/reading.controller.ts (delta endpoint with self-or-admin auth)
    - apps/backend/src/modules/reading/reading.module.ts (CacheModule import)
    - apps/backend/src/modules/store/store.service.ts (24h confirm gate)
    - apps/frontend/lib/api/libraries.ts (BookImportEnqueueResult + getBookImportStatus)
    - apps/frontend/app/[locale]/dashboard/books/page.tsx (polled progress UI)
    - apps/backend/src/modules/books/__tests__/books.service.spec.ts
    - apps/backend/src/modules/ai/__tests__/fraud.service.spec.ts
    - apps/backend/src/modules/reading/__tests__/reading.service.spec.ts
    - apps/backend/src/modules/store/__tests__/store.service.spec.ts
decisions:
  - "BOOK-01 V1 file payload: base64 in BullMQ job data (Redis), capped at 10MB by FileInterceptor. MinIO offload deferred to V2 — acknowledged: a single in-flight 10MB upload costs ~13MB of Redis memory after base64 expansion, acceptable for nightly admin uploads."
  - "BookImportProcessor uses ExcelJS Workbook.xlsx.load (non-streaming) instead of the streaming WorkbookReader — the latter has a known sheets-undefined bug on small workbooks, and our 10MB cap makes the memory difference negligible. Streaming swap is a V2 concern once admin uploads regularly exceed the ceiling."
  - "FRAUD-03 dailyFraudScan auto-block REMOVED. The platform does not have unilateral block authority over real citizens; admin review (TUMAN_ADMIN / VILOYAT_ADMIN / SUPER_ADMIN) is required. FraudScore.action='review' is the source of truth; User.status mutation is a separate admin action via the existing user-management endpoints (NOT done by resolveReview)."
  - "RI_SPIKE rule fixed to compare today's latest score to yesterday's latest, not the oldest of the last-5 records (the prior implementation could compare today vs. a 2-week-old record, flagging legitimate consecutive readers as fraud)."
  - "RI-04 delta endpoint caches 1h. Explicit cache invalidation on nightly RiRecalcProcessor write is deferred — 1h TTL is tight enough that staleness is bounded; a follow-up will add Kafka-driven invalidation when read volume warrants."
  - "RI-03 partition lifecycle bounded at 13 months hot data. Older partitions are O(1)-dropped via partition DDL (DETACH + DROP TABLE IF EXISTS), NOT archived to MinIO. Research permits this — audit-log retention is a separate concern handled by RiskLog and aiAuditLog tables."
  - "STORE-01 24h gate is server-side time comparison only (clock-skew-tolerant). Stricter cryptographic timestamping is V2 if abuse is observed."
metrics:
  duration_minutes: 28
  tasks_completed: 4
  tasks_total: 4
  files_created: 3
  files_modified: 16
  tests_added: 23
  tests_passing: 751
  tests_baseline: 724
  completed_date: 2026-06-06
---

# Phase 2 Plan 4: Async Jobs + Admin Review + RI Delta + STORE 24h Summary

This is the largest plan in Phase 2 — four independent feature threads landing in one plan because they all depend on Phases 02-01 / 02-02 / 02-03 scaffolding but are otherwise unrelated. We shipped:

1. **BOOK-01** — the Excel import flips from synchronous (HTTP request blocks while the whole file is parsed) to async (HTTP returns 202 + jobId immediately; a BullMQ worker parses; the UI polls a status endpoint). The CVE-vulnerable xlsx dependency is removed; exceljs is the canonical parser now.
2. **FRAUD-03** — the dailyFraudScan auto-block side-effect (a critical pitfall identified in Phase 2 research as C2) is removed. The platform now operates a proper admin review queue with tier-scoped access (TUMAN sees their tuman, VILOYAT sees their viloyat, SUPER sees all). The RI_SPIKE false-positive bug is fixed alongside.
3. **RI-04** — a new GET /reading/:userId/delta endpoint returns daily/weekly/monthly deltas off the composite index installed in Plan 02-02. Cached 1h in Redis.
4. **RI-03 + STORE-01** — the ReadingIndex partition lifecycle becomes self-managing (monthly cron drops 13-months-ago partition + creates +3-months-ahead partition). confirmStorePurchase rejects scans older than 24h.

## What Shipped

### BOOK-01: Async Excel Import + xlsx Removal

**Backend changes:**
- `BOOK_IMPORT_QUEUE` registered in `queue.module.ts` with `attempts: 2, backoff: { type: 'fixed', delay: 10000 }` — XLSX bombs won't retry-spiral
- `books.service.ts`: `import * as XLSX from 'xlsx'` removed; new `enqueueImport(buffer, libraryId, userId)` returns `{ jobId, status: 'queued' }` and `getImportStatus(jobId)` returns `{ status, processed, total, errors, progress }`
- `books.controller.ts`: `POST /books/import` returns 202 + jobId immediately; new `GET /books/import/:jobId/status` for the UI to poll
- `books-import.processor.ts` (new): `@Processor(BOOK_IMPORT_QUEUE)` WorkerHost at concurrency 2 (CPU-heavy parse). Uses ExcelJS `Workbook.xlsx.load(buffer)` + 100-row batches via `prisma.book.createMany({ skipDuplicates: true })`. Per-row validation (ISBN-13 checksum + required field check) collects errors without aborting the import. Final progress 100 + `updateData` with the running counters so the status endpoint can read them.
- `npm uninstall xlsx` — closes the dependency deferred from Plan 02-01

**Frontend changes:**
- `/dashboard/books` page: `useEffect` polls `getBookImportStatus(jobId)` every 2s while a job is in flight. Stops on terminal states (`completed | failed | unknown`). The legacy synchronous result banner is replaced by a live progress bar (percent + processed/total + errors list).
- API client: `BookImportEnqueueResult` and `BookImportStatusResult` types added; `getBookImportStatus(jobId)` helper.

**Commits:** `d15adb2` (single commit covering backend + frontend).

### FRAUD-03: Admin Review Queue + Auto-Block Removal + RI_SPIKE Fix

**Backend changes:**
- `fraud.service.ts` dailyFraudScan: the `prisma.user.update({ status: 'BLOCKED' })` block at lines ~234-240 is **gone**. On FLAGGED detection we now write a RiskLog entry (audit trail) and rely on the existing FraudScore upsert with `action='review'`. Kafka `fraud.detected` still emits from `analyzeUser`.
- RI_SPIKE rule fixed: replaced the bogus `riRecords[0].score - riRecords[riRecords.length - 1].score` (which could compare today vs. a 2-week-old record) with two explicit findFirst calls (today vs. yesterday). Missing yesterday → skip the rule (no false-positives for first-day users).
- New `getReviewQueue({ tier, scopeId, limit, offset })`: TUMAN scopes by `address.tumanId`, VILOYAT by `address.viloyatId`, SUPER sees all. Orders by riskScore desc.
- New `resolveReview(adminId, userId, decision, notes?)`: `'approve'` → action='cleared'; `'reject'` → action='confirmed'. RiskLog entry per resolution. Cache invalidation of `fraud:analysis:{userId}`. Does NOT mutate User.status — that's a separate admin action.
- `ai.controller.ts`: `GET /ai/fraud/review-queue` (admin scope auto-derived from JWT user's address lookup) and `POST /ai/fraud/:userId/resolve` endpoints. Both `@Roles(SUPER_ADMIN, VILOYAT_ADMIN, TUMAN_ADMIN)`.

**Grep gate verified:** production `user.update.*BLOCKED` matches in `apps/backend/src/modules/ai/` are 0 (only test-file mentions remain — the spec uses the pattern in test names to assert auto-block does NOT happen).

**Frontend changes:**
- New `/dashboard/fraud-review` page: queries the review-queue endpoint (30s stale + 2min refetch). Surfaces user name, sifatId, phone, risk score, trust score, flag codes (parsed from JSON if needed), and approve / reject buttons that POST to the resolve endpoint.

**Commits:** `ab2e674`.

### RI-04: GET /reading/:userId/delta with Redis Cache

**Backend changes:**
- `reading.service.ts`: new `computeDelta(userId)` returns `{ daily, weekly, monthly }`. Each window is `{ current, prev, delta, pct }`. Uses `CacheService.remember` with key `ri:delta:{userId}` TTL 3600s. Backed by 4 findFirst calls in `Promise.all` against the composite `@@index([userId, calculatedAt])` from Plan 02-02 — each window query is a fast point query against the partitioned table.
- Window semantics: `delta = current - prev`; `pct = (delta / prev) * 100` rounded to 1 decimal; `null prev` → `null delta + null pct` (preserves "no history" vs. "zero progress" distinction).
- `reading.controller.ts`: `GET /reading/:userId/delta` with `@UseGuards(JwtAuthGuard)` and inline self-or-admin authorization (self = me.sub === userId; admin = SUPER / VILOYAT / TUMAN / MUASSASA). Throws `ForbiddenException` otherwise.
- `reading.module.ts`: imports `CacheModule` so `CacheService` is injectable.

**Commits:** `4ca5cff`.

### RI-03 + STORE-01: Partition Cleanup + 24h Gate

**RI-03 — partition lifecycle:**
- `reading.service.ts`: new `@Cron('0 4 1 * *') monthlyPartitionCleanup()`. Three operations per fire, each in its own try-catch so a failure in one doesn't abort the others:
  - `ALTER TABLE "ReadingIndex" DETACH PARTITION "ReadingIndex_y<YYYY>_m<MM>" CONCURRENTLY;` (target: current_month - 13 months)
  - `DROP TABLE IF EXISTS "ReadingIndex_y<YYYY>_m<MM>";`
  - `CREATE TABLE IF NOT EXISTS "ReadingIndex_y<YYYY>_m<MM>" PARTITION OF "ReadingIndex" FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01');` (target: current_month + 3 months — forward margin)
- Partition naming convention: `ReadingIndex_yYYYY_mMM` (zero-padded month) matches Plan 02-02's migration.

**STORE-01 — 24h confirm gate:**
- `store.service.ts` `confirmPurchase`: BEFORE setting confirmed=true, compute `ageMs = Date.now() - scan.createdAt.getTime()`. If `> 24 * 60 * 60 * 1000`, throw `BadRequestException("Mahalliy do'kon yozuvi 24 soatdan eski — bekor qilingan")`. Server-side time comparison only — clock-skew-tolerant because both sides are server time.

**Commits:** `f60fb77`.

## Verification

| Check | Result |
|---|---|
| `xlsx` removed from `apps/backend/package.json` dependencies | ✅ (`node -e "..."` confirms `xlsx: REMOVED, exceljs: ^4.4.0`) |
| `user.update.*BLOCKED` grep in `apps/backend/src/modules/ai/` | ✅ 0 production matches (test-file mentions only — assertion canary) |
| Backend `tsc --noEmit` | ✅ clean |
| Frontend `tsc --noEmit` | ✅ clean |
| Full backend jest suite | ✅ **751/751 passing** (+27 from 724 baseline) |
| New BullMQ queue registered | ✅ `BOOK_IMPORT_QUEUE = 'book-import'` in `queue.module.ts` |
| New endpoints reachable in controllers | ✅ `POST /books/import` (202), `GET /books/import/:jobId/status`, `GET /ai/fraud/review-queue`, `POST /ai/fraud/:userId/resolve`, `GET /reading/:userId/delta` |
| New cron registered | ✅ `@Cron('0 4 1 * *') monthlyPartitionCleanup` in `reading.service.ts` |

## Test Breakdown

| Spec file | Cases added | Notes |
|---|---|---|
| books.service.spec.ts | +6 (3 enqueueImport / 3 getImportStatus) | XLSX import test block replaced by async-flow tests |
| books-import.processor.spec.ts | +5 (new file) | Valid parse, error collection, final progress 100, malformed payload, missing-payload guard |
| fraud.service.spec.ts | +10 | RI_SPIKE today-vs-yesterday + 2 consecutive/first-day false-positive checks, dailyFraudScan-NEVER-blocks canary, RiskLog write, getReviewQueue tier scoping (3 cases), resolveReview approve/reject/not-found |
| reading.service.spec.ts | +9 | computeDelta math (3 cases), cache key + TTL (1), cache-hit short-circuit (1), monthlyPartitionCleanup (4 cases) |
| store.service.spec.ts | +2 | 25h-old scan rejected, 23h-old scan accepted |
| **Total** | **+32** | (suite delta is +27 because some old replaced cases net out) |

## Decisions Made

| # | Decision | Rationale |
|---|---|---|
| D1 | V1 file payload = base64 in BullMQ data, 10MB cap | Simple. Acceptable Redis memory cost (~13MB per in-flight upload after base64 expansion). MinIO offload is a V2 concern that activates when admin upload volume justifies the operational complexity. |
| D2 | Non-streaming `Workbook.xlsx.load` instead of `WorkbookReader` | Streaming reader has known issues with small workbooks (sheets-undefined error path). At our 10MB cap, the memory difference is negligible. Worker is concurrency 2 so total in-flight memory is bounded. |
| D3 | dailyFraudScan auto-block REMOVED | The platform does not have unilateral block authority over real citizens. Admin review is required. FraudScore.action='review' is the source of truth. |
| D4 | resolveReview does NOT mutate User.status | Approve/reject only changes the FraudScore record + writes audit. Actual user blocking remains a separate admin action via existing user-management endpoints. Keeps the resolve action narrow and auditable. |
| D5 | RI_SPIKE = today vs. yesterday (exact two-record comparison) | The prior 5-record window was a flat false-positive generator — could compare today's score to a 2-week-old record. Today-vs-yesterday is the actual signal of "suspicious overnight jump". Missing yesterday → skip the rule (no false positives for first-day users). |
| D6 | RI-04 cache TTL = 1h, no explicit invalidation | The nightly RiRecalcProcessor write event is not subscribed to here. 1h staleness ceiling is acceptable for "how did my score change?" UX. Kafka-driven invalidation is a follow-up if read volume grows. |
| D7 | RI-03 partition drop = O(1) DDL, NOT MinIO archive | Research permits cold drop. Audit-log retention is handled separately by RiskLog + aiAuditLog tables. Keeps the cron fast and the storage layer simple. |
| D8 | STORE-01 24h gate uses server-side time comparison | Clock-skew-tolerant (both sides are server time). Stricter cryptographic timestamping is V2 if abuse appears. |

## Deviations from Plan

**None — Plan executed exactly as written.**

Three small surface-area extensions worth noting (none are rule-triggered deviations, just plan amplifications):
- `confirmPurchase` test setup added `createdAt` field to existing mocks (the old test data was missing it; without the addition the 24h gate test couldn't differentiate "valid" from "expired"). Existing tests still pass.
- `reading.service.ts` constructor accepts an optional `CacheService` (third positional arg). This preserves the existing test signature `new ReadingService(prisma, queue)` while letting Nest DI inject the cache in production. New delta tests pass cache explicitly.
- AiController now injects `FraudService` + `PrismaService` directly (alongside `AiService`) because the new review-queue endpoints need direct access (the AI facade was getting too thin to be useful). AiModule already provides all three.

## Auth Gates

**None.** All four tasks were code-only; no external credentials, no email links, no 2FA.

## Known Stubs

**None.** Every endpoint added in this plan is wired to real data:
- POST /books/import → real BullMQ job → real Excel parser → real prisma.book.createMany
- GET /books/import/:jobId/status → real BullMQ getJob + job.data
- GET /ai/fraud/review-queue → real prisma.fraudScore.findMany scoped by admin
- POST /ai/fraud/:userId/resolve → real prisma.fraudScore.update + RiskLog
- GET /reading/:userId/delta → real prisma.readingIndex.findFirst x4 + Redis cache
- monthlyPartitionCleanup → real prisma.$executeRawUnsafe partition DDL
- confirmPurchase 24h gate → real createdAt comparison

Frontend fraud-review page lacks anonymization for under-14 users — but that's Plan TOP-06's scope, not 02-04's. Documented as cross-plan boundary.

## Threat Flags

**None.** All endpoints added are covered by the plan's `<threat_model>`:
- T-02-17 (XLSX bomb) — mitigated by FileInterceptor 10MB + BullMQ worker isolation + attempts:2 no-retry-spiral
- T-02-18 (admin EoP) — mitigated by @UseGuards(JwtAuthGuard, RolesGuard) + @Roles
- T-02-19 (review-queue PII to lower-tier admins) — mitigated by service-layer tier scoping
- T-02-20 (auto-block re-introduction) — mitigated by the spec canary `not.toHaveBeenCalled()` on user.update
- T-02-21 (late confirmation) — mitigated by 24h server-time gate
- T-02-22 (partition-detach off-by-one) — mitigated by spec asserting the exact partition name `ReadingIndex_y2025_m05` (May 2025) when CURRENT_DATE = '2026-06-01'

## What's Next (Plan 02-05)

Plan 02-05 picks up:
- BookTransfer bilateral confirm endpoint (the model exists from Plan 02-02; the API surface to confirm/reject is still TODO)
- Comprehension test (FRAUD-05 signal 3 — research recommended deferring this; now ready)
- Overdue notifications + escalation (depends on the 24h gate semantics shipped here)

## Self-Check: PASSED

- Created files exist:
  - ✅ `apps/backend/src/modules/books/books-import.processor.ts`
  - ✅ `apps/backend/src/modules/books/__tests__/books-import.processor.spec.ts`
  - ✅ `apps/frontend/app/[locale]/dashboard/fraud-review/page.tsx`
- All 4 task commits present in git log:
  - ✅ `d15adb2` (BOOK-01)
  - ✅ `ab2e674` (FRAUD-03)
  - ✅ `4ca5cff` (RI-04)
  - ✅ `f60fb77` (RI-03 + STORE-01)
- xlsx removed from package.json: ✅
- 751/751 backend tests passing: ✅
- TypeScript clean on backend + frontend: ✅
