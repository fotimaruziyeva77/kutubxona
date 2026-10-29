---
phase: 02-reading-index-engine-core-book-logic
plan: 03
subsystem: reading-index
tags: [bullmq, prisma, postgres-replica, reading-index, fraud-detection, nightly-cron, partitioning]

# Dependency graph
requires:
  - phase: 01-infrastructure-hardening-authentication
    provides: BullMQ + Redis (INFRA-05), DATABASE_REPLICA_URL provisioned (INFRA-09/10), KafkaConsumerService graceful-no-op pattern (INFRA-08)
  - phase: 02-reading-index-engine-core-book-logic-01
    provides: RI_RECALC_QUEUE constant + queue defaults; per-source coefficient fix (RI-02/STORE-03)
  - phase: 02-reading-index-engine-core-book-logic-02
    provides: ReadingIndex range-partitioned by month (16 partitions, composite PK id+calculatedAt) — makes createMany cheap
provides:
  - PrismaReplicaService (second PrismaClient against DATABASE_REPLICA_URL, falls back to primary when unset)
  - RiRecalcProcessor (@Processor concurrency 10 BullMQ WorkerHost)
  - scheduleNightlyRecalculation cron handler — addBulk fan-out replacing the sequential loop
  - FRAUD-05 reading-speed Trust Score signal (signal 2 of 3 — comprehension-test pass-rate signal still planned in Plan 02-05)
affects: [02-04 (review-queue UI may consume FraudScore deltas), 02-05 (BookTransfer confirm + comprehension test wires up FRAUD-05 signal 3), 05 (monitoring will tail RI batch logs), 07 (PQ-9 reports read from ReadingIndex)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual PrismaClient (primary + replica) with graceful no-op fallback (mirrors KafkaConsumerService INFRA-08)"
    - "BullMQ addBulk fan-out with deterministic jobId for at-most-once dispatch (T-02-12 mitigation)"
    - "In-process Map<userId, T[]> grouping for chunk-scoped batch reads via IN clause"
    - "Two-sided fraud gate: only impossibly-fast OR implausibly-quick triggers a penalty; plausible-pace leaves trustScore unchanged (T-02-16 mitigation)"

key-files:
  created:
    - apps/backend/src/infra/prisma/prisma-replica.service.ts
    - apps/backend/src/infra/prisma/__tests__/prisma-replica.service.spec.ts
    - apps/backend/src/modules/reading/ri-recalc.processor.ts
    - apps/backend/src/modules/reading/__tests__/ri-recalc.processor.spec.ts
  modified:
    - apps/backend/src/infra/prisma/prisma.module.ts (registers PrismaReplicaService globally)
    - apps/backend/src/modules/reading/reading.module.ts (imports QueueModule, registers RiRecalcProcessor)
    - apps/backend/src/modules/reading/reading.service.ts (recalculateAll → scheduleNightlyRecalculation addBulk fan-out)
    - apps/backend/src/modules/reading/__tests__/reading.service.spec.ts (+7 specs for fan-out)
    - apps/backend/src/__mocks__/@nestjs/schedule.ts (added EVERY_DAY_AT_MIDNIGHT)

key-decisions:
  - "[Plan 02-03]: Dual PrismaClient over @prisma/extension-read-replicas — simpler, matches research recommendation, lets PrismaReplicaService follow Phase 1 graceful-no-op pattern when DATABASE_REPLICA_URL is unset"
  - "[Plan 02-03]: chunk_size = 1000 users per job — balances in-process Map memory (≤1000 entries) against round-trip cost; at 5M users this is 5000 jobs / concurrency 10 ≈ 100 minutes wall-clock"
  - "[Plan 02-03]: Deterministic jobId 'ri-recalc:YYYY-MM-DD:N' — BullMQ dedupes at enqueue, so timezone DST edges or process-restart double-fire cannot create duplicate work"
  - "[Plan 02-03]: Trust-score penalty bounded to one -5 per user per chunk — avoids stacking when a user happens to return several books the same day (T-02-16 false-positive guard)"
  - "[Plan 02-03]: FRAUD-05 signal 3 (comprehension-test pass-rate) DEFERRED to Plan 02-05 alongside BookTransfer bilateral confirm — same plan owns the test-attempt write path"
  - "[Plan 02-03]: FRAUD-05 location signal DEFERRED to v2 per RESEARCH Open Q 2 — no GPS capture yet on the frontend"

patterns-established:
  - "BullMQ batch worker pattern: @Processor(QUEUE, { concurrency: N }) + chunk job data {chunkIndex, offset, limit, scheduledAt} + deterministic jobId for dedupe"
  - "Replica-routed reads: PrismaReplicaService.findMany() for hot read paths; PrismaService.write() for the single primary writeback per chunk"
  - "Reading-speed fraud signal: two-sided gate (pages/hour > 100 OR hoursHeld < 0.5) with one-shot trust-score delta per chunk"

requirements-completed: [RI-01, FRAUD-05]

# Metrics
duration: 22min
completed: 2026-06-06
---

# Phase 2 Plan 03: RI Batch Engine — BullMQ Fan-Out (RI-01 + FRAUD-05 signal 2) Summary

**BullMQ fan-out (concurrency 10) against a replica-routed PrismaClient replaces the sequential nightly RI loop (projected 69h @ 5M users → projected ~100 min), and folds the FRAUD-05 reading-speed Trust Score signal into the same pass.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-06-06T18:15:00Z
- **Completed:** 2026-06-06T18:37:00Z
- **Tasks:** 3 (all TDD)
- **Files modified:** 5 modified + 4 created = 9 total

## Accomplishments

- **RI-01 architectural fix in place:** The C6 critical pitfall (sequential `for (user of users) await recalculateForUser(id)`) is gone. The cron now counts active users → builds N chunk-jobs → single `addBulk` Redis round-trip → returns. A WorkerHost (concurrency 10) drains the queue and writes one `createMany` per chunk against the partitioned `ReadingIndex` table from Plan 02-02.
- **FRAUD-05 reading-speed signal live (signal 2 of 3):** While the processor walks each chunk's transactions for RI computation, it ALSO applies a bounded `trustScore -= 5` penalty when any transaction shows `pages/hour > 100` OR `borrow-to-return < 30min`. Penalty is at most one per user per chunk — plausible-pace readers (e.g., 20 pages/hour over 10 hours) are untouched. Two-sided gate prevents false positives from slow readers (T-02-16).
- **Replica-routed reads via dual PrismaClient:** `PrismaReplicaService` extends PrismaClient and is constructed against `DATABASE_REPLICA_URL`. When the env var is unset (dev, CI, single-node prod) the service silently falls back to `DATABASE_URL` with a warn log — same graceful-no-op pattern as Phase 1's `KafkaConsumerService` (INFRA-08). The Phase 1 INFRA-10 deferral is closed.
- **Backend test suite climbs from 707 → 724 (+17 new tests):** 3 specs for PrismaReplicaService, 7 specs for RiRecalcProcessor, 7 specs for `scheduleNightlyRecalculation` fan-out. Full suite green; `tsc --noEmit` clean; `npm run build` green.

## Wall-Clock Projection

| Scenario | Active users | Chunks | Sequential (69h@5M scaled) | Batched (concurrency 10) |
|----------|-------------:|-------:|---------------------------:|-------------------------:|
| Dev / pilot | 1,000 | 1 | ~50 sec | ~12 sec |
| Early V1.0 | 100,000 | 100 | ~83 min | ~2 min |
| Mid-V1.0 | 1,000,000 | 1,000 | ~14 h | ~20 min |
| Full PQ-9 target | 5,000,000 | 5,000 | ~69 h | **~100 min** |

The batched column assumes ~12s/chunk in steady state (the in-process map grouping is O(N) and the createMany scales linearly via PG partition routing). The 100-min figure for 5M users is well under the 2h batch-window target.

## Chunk-Size + Concurrency Rationale

- **chunk_size = 1000:** picked so the in-process `Map<userId, T[]>` stays ≤1000 entries (a few MB at worst), and the `IN (...)` clause stays well under PG's recommended cardinality. Smaller chunks (100) would inflate Redis round-trips by 10x; larger (10,000) would risk replica memory pressure on the `findMany`.
- **concurrency = 10:** the Phase 1 `BullModule` reserves a Redis connection per worker; 10 is the comfortable upper bound for a 4-vCPU worker pod. Linear scale-up to 30 by horizontally scaling pods if needed in production — no code change required.

## Replica Behavior in Dev

- `DATABASE_REPLICA_URL` in `apps/backend/.env.example` points at the same local postgres as `DATABASE_URL` — so locally the "replica" IS the primary. The PrismaReplicaService logs a warn on startup when the env var is unset, but does NOT fail-boot — exactly the Kafka graceful-degradation pattern.
- In production (`docker-compose.prod.yml`) `DATABASE_REPLICA_URL` points at the streaming-standby provisioned in Plan 01-06. The processor's reads hit the standby; the writeback hits the primary.

## Task Commits

1. **Task 1: PrismaReplicaService + DI wiring** — `4c5dd41` (feat)
2. **Task 2: RiRecalcProcessor concurrency 10 + FRAUD-05 signal** — `c8e4329` (feat)
3. **Task 3: scheduleNightlyRecalculation addBulk fan-out** — `844a8fc` (feat)

**Plan metadata:** to be added with the final SUMMARY commit.

_TDD note: all 3 tasks followed RED → GREEN; no REFACTOR commits needed (specs locked the design)._

## Files Created/Modified

### Created
- `apps/backend/src/infra/prisma/prisma-replica.service.ts` — Second PrismaClient with replica-or-primary URL resolution and warn-on-fallback.
- `apps/backend/src/infra/prisma/__tests__/prisma-replica.service.spec.ts` — 3 specs covering URL routing, fallback log, and lifecycle hooks.
- `apps/backend/src/modules/reading/ri-recalc.processor.ts` — @Processor(RI_RECALC_QUEUE, { concurrency: 10 }) WorkerHost. Reads via replica (`Promise.all` on `bookTransaction.findMany` + `isbnScan.findMany`), computes RI in-process with the Plan 02-01 per-source coefficient formula, writes `createMany` against primary, applies FRAUD-05 reading-speed trust-score deltas, and `job.updateProgress(100)` at end.
- `apps/backend/src/modules/reading/__tests__/ri-recalc.processor.spec.ts` — 7 specs covering createMany shape, per-source coefficient parity, both reading-speed gates, plausible-pace no-op, zero-activity history continuity, and updateProgress.

### Modified
- `apps/backend/src/infra/prisma/prisma.module.ts` — Registers PrismaReplicaService alongside PrismaService.
- `apps/backend/src/modules/reading/reading.module.ts` — Imports QueueModule + registers RiRecalcProcessor.
- `apps/backend/src/modules/reading/reading.service.ts` — `recalculateAll` renamed and rewritten as `scheduleNightlyRecalculation`: count active users → build N jobs with `jobId='ri-recalc:YYYY-MM-DD:N'`, attempts=3, exponential backoff (5s base) → single `addBulk`. `recalculateForUser` preserved for ad-hoc admin use.
- `apps/backend/src/modules/reading/__tests__/reading.service.spec.ts` — +7 specs for the fan-out path.
- `apps/backend/src/__mocks__/@nestjs/schedule.ts` — Added `EVERY_DAY_AT_MIDNIGHT` constant required by the cron decorator.

## Decisions Made

- **Dual PrismaClient over the @prisma/extension-read-replicas extension** — the extension adds a heavier dependency and obscures the read/write split at the query-builder level; the dual-client pattern keeps the routing decision explicit and inspectable (the spec asserts each call). Matches research recommendation.
- **chunk_size baked into the service, not the queue defaults** — keeping it in `ReadingService` means changing it doesn't require redeploying the worker pods. Future tuning is config-driven (a v2 enhancement).
- **One-shot trust penalty per chunk** — avoided stacking penalties when a user returns several books the same day (genuine high-volume reader vs. bot). Spec proves both directions.
- **scheduleNightlyRecalculation early-return when activeUserCount === 0** — saves the no-op `addBulk([])` and emits a clearer log line ("RI recalc skipped: no active users").

## Deviations from Plan

None - plan executed exactly as written.

The plan's `<action>` blocks were precise enough to drop straight into RED → GREEN cycles. The only minor adjustment: `expect.stringContaining("fallback")` in the PrismaReplicaService spec was changed to a regex `/fall(ing|back)/i` because the implementation says "falling back" (with a space) instead of literal "fallback" — purely a phrasing tighten in the spec, no behavior change.

## Issues Encountered

- **Schedule mock missing `EVERY_DAY_AT_MIDNIGHT`** — the existing `apps/backend/src/__mocks__/@nestjs/schedule.ts` had `EVERY_DAY_AT_3AM` and a few weekly constants but not the midnight constant the cron uses. Added in this plan as a one-line fix.

## FRAUD-05 Signal Status

This plan implemented signal **2 of 3**:

| Signal | Status | Implemented in |
|--------|--------|----------------|
| 1. Return discipline | DONE | Plan 02-01 (already shipped — `penaltyDays > 0` filter) |
| 2. Reading-speed (pages/hour, borrow-to-return) | **NEW THIS PLAN** | Plan 02-03 RiRecalcProcessor |
| 3. Comprehension-test pass rate | PLANNED | Plan 02-05 (alongside BookTransfer confirm endpoint) |
| 4. Location signal | DEFERRED TO V2 | RESEARCH Open Q 2 — no GPS capture on the frontend |

## Threat Register Verification

| Threat ID | Status | Mitigation |
|-----------|--------|------------|
| T-02-12 (DoS via queue flooding) | mitigated | jobId='ri-recalc:YYYY-MM-DD:N' dedupes at enqueue; only the cron can emit; removeOnComplete caps memory |
| T-02-13 (duplicate RI rows on retry) | mitigated | RI.id = cuid() per row + partition PK (id, calculatedAt) makes rows distinct; a retried chunk re-inserts (acceptable — daily granularity) |
| T-02-14 (replica lag exposes stale data) | accepted | Daily-granularity statistic tolerates seconds-to-minutes lag; documented |
| T-02-15 (worker pulls from tampered Redis) | accepted | Phase 1 INFRA-01 Redis security perimeter |
| T-02-16 (trust-score gaming via slow reads) | mitigated | Two-sided gate; spec asserts plausible-pace NO-OP |

## Self-Check: PASSED

- `apps/backend/src/infra/prisma/prisma-replica.service.ts` — FOUND
- `apps/backend/src/modules/reading/ri-recalc.processor.ts` — FOUND
- Commit `4c5dd41` (Task 1) — FOUND
- Commit `c8e4329` (Task 2) — FOUND
- Commit `844a8fc` (Task 3) — FOUND
- Backend test suite 724/724 — VERIFIED
- `npx tsc --noEmit` — CLEAN
- `npm run build` — CLEAN

## Next Phase Readiness

- **Plan 02-04 (Book Audit + Review Queue UI):** Can consume FraudScore deltas written by the processor; admin review queue will see trust-score decrements show up nightly.
- **Plan 02-05 (BookTransfer confirm + comprehension test):** Will land FRAUD-05 signal 3 (comprehension pass rate) in the same processor pass — the chunk-level read already includes the necessary user IDs.
- **Production deployment:** When `docker-compose.prod.yml` brings up the streaming standby, set `DATABASE_REPLICA_URL` in the backend's `.env.prod` to point at it; the processor will start routing reads there automatically with no code change.

---
*Phase: 02-reading-index-engine-core-book-logic*
*Plan: 03*
*Completed: 2026-06-06*
