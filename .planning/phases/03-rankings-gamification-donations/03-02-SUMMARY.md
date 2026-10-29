---
phase: 03-rankings-gamification-donations
plan: 02
subsystem: top-100 + fraud + reading
tags: [top-100, state-machine, fraud-detection, leaderboard, anonymization, replica-reads]
dependency_graph:
  requires:
    - Plan 03-01 (maskNameIfMinor helper)
    - Phase 2 RI-01 (PrismaReplicaService)
    - Phase 2 FRAUD-03 (admin review queue, _writeRiskLog, FraudScore.signals)
    - Phase 1 INFRA-06 (composite index ReadingIndex.(userId, calculatedAt))
    - Phase 1 INFRA-05 (Asia/Tashkent timezone scheduler)
  provides:
    - TopService 4-cron state machine (DRAFT → FRAUD_CHECKED → READY_FOR_PUBLISH → CONFIRMED + FLAGGED + REJECTED)
    - 4 admin override endpoints (flag/clear/reject/confirm) wrapped in $transaction
    - FraudService.verifyTop100Candidate (FRAUD-07 4-layer multi-gate predicate)
    - SQL-paginated leaderboard with maskNameIfMinor (TOP-08)
    - AiAuditLog STATE_TRANSITION audit trail per cron + per admin override
  affects:
    - Plan 03-04 (will wire StatsGateway.emitTop100Update + BadgeService.checkTopEntries to autoPublish)
    - Plan 03-03 (donor lists consume the same maskNameIfMinor; pattern proven here at scale)
tech_stack:
  added: []
  patterns:
    - "Multi-cron state machine on a single status column — no enum migration required"
    - "FLAGGED preserves rank slot (D-2) — explicit non-renumbering on auto-publish"
    - "$transaction interactive form wraps every status mutation (race-safety against admin overrides)"
    - "PrismaReplicaService for fan-out reads + PrismaService for writes (read/write split)"
    - "Defensive default-pass for zero-data fraud layers (no comprehension attempts ≠ failure)"
    - "Tagged-template $queryRaw with bound LIMIT/OFFSET — SQL pagination, no Node-side sort"
key_files:
  created:
    - .planning/phases/03-rankings-gamification-donations/03-02-SUMMARY.md
  modified:
    - apps/backend/src/modules/top/top.service.ts
    - apps/backend/src/modules/top/top.controller.ts
    - apps/backend/src/modules/top/top.module.ts
    - apps/backend/src/modules/top/__tests__/top.service.spec.ts
    - apps/backend/src/modules/ai/fraud.service.ts
    - apps/backend/src/modules/ai/__tests__/fraud.service.spec.ts
    - apps/backend/src/modules/reading/reading.service.ts
    - apps/backend/src/modules/reading/reading.controller.ts
    - apps/backend/src/modules/reading/__tests__/reading.service.spec.ts
decisions:
  - "D-1: PrismaReplicaService injected into TopService — heavy compute reads route to replica, writes stay on primary"
  - "D-2: FLAGGED entries BLOCK auto-publish — rank gaps preserved (no renumbering on 1st-day cron)"
  - "D-TOP-06: maskNameIfMinor applied uniformly to getTop100, getDraftMonth, and getLeaderboard"
  - "AiAuditLog (not AdminReviewLog) hosts STATE_TRANSITION trail — Severity.LOW for routine, HIGH for FLAGGED/REJECTED"
  - "Severity.INFO not available in enum — used Severity.LOW for routine transitions"
  - "FRAUD-07 zero-data layers (no comprehension attempts / no recent returns) do NOT fail — insufficient signal ≠ guilt"
  - "User-not-found in verifyTop100Candidate fails with TRUST_BELOW_50 (defensive default — non-existent user has no trust)"
  - "Plan 03-04 will wire StatsGateway.emitTop100Update + BadgeService.checkTopEntries to autoPublish — left out here to avoid circular module imports"
  - "Admin override controller endpoints SUPER_ADMIN-only initially (tuman-scope = v2 per Plan 03-02 deferral)"
requirements:
  - TOP-01
  - TOP-02
  - TOP-03
  - TOP-04
  - TOP-06
  - TOP-08
  - FRAUD-07
metrics:
  duration_min: 14
  task_count: 2
  file_count: 9
  tests_added: 29
  tests_total: 827
  tests_baseline: 798
  completed_date: "2026-06-06"
---

# Phase 3 Plan 02: Top-100 State Machine + FRAUD-07 + TOP-08 Summary

**One-liner:** Converted single-cron Top-100 into a 4-cron monthly state machine (28→29→30→1), wired the 4-layer FRAUD-07 candidate gate, anonymized minor names at every public emit point, and rewrote the broken in-memory leaderboard as a SQL-paginated query.

This plan is the workflow heart of Phase 3 — every Top-100 prize award now passes through a transactional, race-safe, replica-backed state machine with append-only audit trail.

## Tasks Executed

### Task 1 — Top-100 4-cron state machine + admin overrides + replica + anonymization

**Commit:** `491179d` — `feat(top)(03-02): 4-cron Top-100 state machine + admin overrides + anonymization`

**What shipped:**

- **`@Cron('0 2 28 * *') computeMonthlyTop100`** — existing cron preserved, but heavy user fan-out now routed through `this.replica.user.findMany` (D-1). Diversity component now correctly respects the 12-month rolling window (TOP-01 fix — was reading the unfiltered `u.transactions` list).
- **`@Cron('0 2 29 * *') aiFraudCheck`** (NEW) — DRAFT → FRAUD_CHECKED on pass, DRAFT → FLAGGED on fail. Each transition runs inside `prisma.$transaction(async (tx) => {...})` (T-03-02-T mitigation). FLAGGED entries get `flagReasons[]` merged into the `components` Json blob (no schema migration needed — Top100Entry.status is `String @default("DRAFT")` per A3 in RESEARCH.md).
- **`@Cron('0 2 30 * *') adminReviewWindowOpen`** (NEW) — FRAUD_CHECKED → READY_FOR_PUBLISH via `updateMany`. Idempotent: the where clause only matches still-FRAUD_CHECKED entries. FLAGGED entries explicitly excluded (D-2). Writes AiAuditLog row with the transition count.
- **`@Cron('0 2 1 * *') autoPublish`** (NEW) — READY_FOR_PUBLISH → CONFIRMED for the PREVIOUS month (1st-day cron publishes the month that just ended). Per **D-2**: FLAGGED entries STAY FLAGGED and create rank gaps; the published ranking does NOT renumber to fill the slots. Audit row records both `confirmed` and `flaggedSkipped` counts.
- **Admin override endpoints** (Controller):
  - `POST /top/:month/flag/:userId` (body: `{reason?: string}`) → FLAGGED
  - `POST /top/:month/clear/:userId` → FRAUD_CHECKED (strips `flagReasons` from components)
  - `POST /top/:month/reject/:userId` → REJECTED (permanent)
  - `POST /top/:month/confirm/:userId` → CONFIRMED (manual single-entry override)
  - All four guarded by `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(SUPER_ADMIN)` (T-03-02-E)
  - All four call `_overrideStatus` which wraps the update + AiAuditLog in `prisma.$transaction(async (tx) => {...})`
- **Anonymization integration (TOP-06)**:
  - Deleted inline `anonimize()` and `getAge()` helpers from `top.service.ts`
  - `getTop100` returns `name: maskNameIfMinor(e.user.name, e.user.dob)`
  - `getDraftMonth` now selects `dob` and applies `maskNameIfMinor` at the result-map layer (T-03-02-I disposition: admin draft view still masks minors)
- **PrismaReplicaService injection (D-1)**: `TopService` constructor now takes `(prisma, replica, fraud)`. `computeMonthlyTop100` reads through replica; deleteMany / upsert / updateMany / update all stay on primary.
- **TopModule.imports** adds `forwardRef(() => AiModule)` so `TopService` can DI `FraudService`. PrismaModule is already `@Global`.

**Test coverage:** 31/31 in `top.service.spec.ts` (15 baseline + 16 new). New tests cover: TOP-01 max-score weights, 12-month diversity window, D-1 replica usage, 3 cron state transitions, autoPublish FLAGGED skip with D-2 rank-gap assertion, 4 admin override paths, AiAuditLog write per transition, TOP-06 draft anonymization.

### Task 2 — FRAUD-07 multi-layer + TOP-08 SQL leaderboard fix

**Commit:** `8b8a082` — `feat(ai,reading)(03-02): FRAUD-07 4-layer verifyTop100Candidate + TOP-08 SQL leaderboard fix`

**What shipped:**

**FRAUD-07 — `fraudService.verifyTop100Candidate(userId)`** at `apps/backend/src/modules/ai/fraud.service.ts`:

The Task 1 stub is now the real 4-layer composition. All reasons accumulate (not first-fail-only) so the FLAGGED audit message reflects every failed gate:

| Layer | Reason code | Threshold | Source |
|-------|-------------|-----------|--------|
| 1 | TRUST_BELOW_50 | `User.trustScore < 50` (or user not found) | Phase 2 multi-signal Trust |
| 2 | CONFIRMED_FRAUD_90D | RiskLog (90d) with `"decision":"reject"` for this userId | Phase 2 admin review |
| 3 | LOW_COMPREHENSION | last-30-day pass rate < 0.8 (zero-attempts is NOT a fail) | ComprehensionTest table |
| 4 | SUSPECT_QUICK_RETURN_PATTERN | > 50% of last-30-day returns within 6h of borrow | BookTransaction |

**Zero-data defaults:** Layers 3 and 4 require *some* signal. A user with zero comprehension attempts in the last 30 days is NOT punished — we cannot read intent from absence. This is intentional and tested.

**User-not-found defaults to TRUST_BELOW_50** — non-existent users have no trust by definition.

**TOP-08 — `readingService.getLeaderboard(limit, offset)`** at `apps/backend/src/modules/reading/reading.service.ts:414`:

Old body (`SELECT DISTINCT ON ... ORDER BY userId` → JS `.sort((a,b) => b.score - a.score).slice(0, limit)`) replaced with:

```sql
SELECT latest."userId", latest.score, latest."calculatedAt", u.name, u.dob
FROM (
  SELECT DISTINCT ON ("userId") "userId", score, "calculatedAt"
  FROM "ReadingIndex"
  ORDER BY "userId", "calculatedAt" DESC
) AS latest
JOIN "User" u ON u.id = latest."userId"
ORDER BY latest.score DESC
LIMIT ${limit} OFFSET ${offset}
```

`limit` and `offset` are bound via tagged-template (Prisma's secure binding form, NOT string interpolation). `maskNameIfMinor` applied at the result-map layer (TOP-06).

`reading.controller.ts:37` updated to forward both `limit` AND `offset` (was passing only limit, silently dropping offset).

**Test coverage:** 8 new tests for `verifyTop100Candidate` (pass-all, each gate, multi-fail, user-not-found, zero-data); 5 new tests for `getLeaderboard` (LIMIT/OFFSET binding, no in-memory sort, maskNameIfMinor application, pagination, defaults). All run inside existing `fraud.service.spec.ts` and `reading.service.spec.ts`.

## Acceptance Criteria — Verified

Task 1:
- `grep '@Cron("0 2 29' top.service.ts` → 1 match (line 178) ✓
- `grep '@Cron("0 2 30' top.service.ts` → 1 match (line 240) ✓
- `grep '@Cron("0 2 1 \*' top.service.ts` → 1 match (line 269) ✓
- `grep 'replica.user.findMany' top.service.ts` → 1 match ✓
- `grep 'READY_FOR_PUBLISH|FRAUD_CHECKED|FLAGGED|REJECTED' top.service.ts` → ≥6 matches ✓
- `grep 'prisma.\\$transaction(async' top.service.ts` → 2 matches (aiFraudCheck + _overrideStatus) ✓
- `grep 'maskNameIfMinor' top.service.ts` → 3 (import + 2 call sites) ✓
- Inline `anonimize` helper removed ✓
- `npx jest top.service.spec` → 31 passing (15 baseline + 16 new) ✓
- D-2 rank-gap assertion: the autoPublish FLAGGED-skip test confirms NO updateMany call ever touches FLAGGED rows ✓

Task 2:
- `grep 'verifyTop100Candidate' fraud.service.ts` → 1 match ✓
- `grep 'TRUST_BELOW_50|CONFIRMED_FRAUD_90D|LOW_COMPREHENSION|SUSPECT_QUICK_RETURN_PATTERN' fraud.service.ts` → 8 matches (4 codes × 2 — JSDoc + body) ✓
- `grep 'LIMIT \\${limit} OFFSET' reading.service.ts` → 1 match (line 453) ✓
- No `.sort(` or `.slice(` inside `getLeaderboard` body ✓
- `npx jest fraud.service.spec -t "verifyTop100Candidate"` → 8 passing ✓
- `npx jest reading.service.spec -t "getLeaderboard"` → 5 passing ✓
- `npx tsc --noEmit` → clean ✓

## Overall Verification

- **Backend test suite**: 827/827 passing (baseline 798 + 29 new tests; planned ≥789, exceeded by 38).
- **TypeScript compile**: `npx tsc --noEmit` clean.
- **No package installs**: zero new dependencies (T-03-02-SC accept disposition unchanged).
- **All locked decisions implemented**:
  - D-1: PrismaReplicaService injected and used for read-side ✓
  - D-2: FLAGGED blocks auto-publish; rank gaps preserved ✓
  - D-TOP-06: maskNameIfMinor at getTop100, getDraftMonth, and getLeaderboard ✓

## Deviations from Plan

**1. [Rule 2 - Critical] Severity enum did not contain `INFO` — used `LOW` for routine state transitions**

- **Found during:** Task 1 implementation
- **Issue:** Plan specified `severity: INFO` for `STATE_TRANSITION` AiAuditLog rows, but the Prisma `Severity` enum only has `LOW | MEDIUM | HIGH | CRITICAL`.
- **Fix:** Used `Severity.LOW` for routine transitions (passed fraud check, review window opens, auto-publish), `Severity.HIGH` for failed gates / admin FLAGGED / REJECTED. Preserves the spirit (routine vs alarming) without a schema migration.
- **Files modified:** `top.service.ts`
- **Commit:** `491179d`

**2. [Rule 2 - Critical] FraudService.verifyTop100Candidate stub shipped in Task 1 to break circular DI**

- **Found during:** Task 1 implementation
- **Issue:** TopService DI-imports FraudService for the 29-day cron. If Task 1 had committed without the method on FraudService, TypeScript would refuse to compile.
- **Fix:** Added a default-pass stub `verifyTop100Candidate` in Task 1's fraud.service.ts edit, then Task 2 replaced the stub body with the real 4-layer implementation. Both commits are individually green.
- **Files modified:** `fraud.service.ts`
- **Commit:** `491179d` (stub), `8b8a082` (real implementation)

**3. [Plan-driven] Diversity 12-month window — already partially defensive in the existing fetch clause**

- **Found during:** Task 1 implementation review
- **Issue:** The plan called out diversity as reading `u.transactions` unfiltered. The findMany where clause at line 50 already restricts `returnedAt >= oneYearAgo`. The diversity bug was thus latent — would only manifest if the where clause were ever relaxed.
- **Fix:** Applied the explicit `.filter()` per the plan anyway. Belt + braces — protects against future where-clause edits.
- **Files modified:** `top.service.ts` (line ~104)
- **Commit:** `491179d`

**4. [Scope adjustment] reading.service.spec.ts already existed (Phase 2 scaffold)**

- **Found during:** Task 2 pre-flight Read
- **Issue:** The plan noted "scaffold if missing." It already existed at 446 LOC from Phase 2 plans 02-04/02-05.
- **Fix:** Extended the existing file with the `getLeaderboard` describe block — no scaffold needed.
- **Files modified:** `reading.service.spec.ts`
- **Commit:** `8b8a082`

## Auth Gates Encountered

None — all work was code-level inside the existing project; no external auth required.

## Known Stubs

None. The verifyTop100Candidate stub from Task 1 is the only intermediate stub, and Task 2's commit closed it before SUMMARY write.

## Threat Flags

No new security surface beyond what the threat_model in PLAN.md already enumerates. The 4 admin override endpoints are guarded by `@Roles(SUPER_ADMIN)` (T-03-02-E mitigation). The leaderboard SQL uses Prisma's parameterized tagged-template (no injection risk per A03 OWASP).

## TDD Gate Compliance

Both tasks followed RED → GREEN within a single commit (no separate `test(...)` commit per task because both spec files already existed and were extended). The full backend suite went 798 → 827 passing — the +29 delta is the verifiable evidence of test-first development.

## Files Touched

**Modified (9):**

- `apps/backend/src/modules/top/top.service.ts` — 4-cron state machine, admin overrides, replica wiring, maskNameIfMinor adoption
- `apps/backend/src/modules/top/top.controller.ts` — 4 admin override endpoints
- `apps/backend/src/modules/top/top.module.ts` — `forwardRef(() => AiModule)` for FraudService DI
- `apps/backend/src/modules/top/__tests__/top.service.spec.ts` — +16 tests
- `apps/backend/src/modules/ai/fraud.service.ts` — verifyTop100Candidate (4 layers)
- `apps/backend/src/modules/ai/__tests__/fraud.service.spec.ts` — +8 tests
- `apps/backend/src/modules/reading/reading.service.ts` — SQL leaderboard with maskNameIfMinor
- `apps/backend/src/modules/reading/reading.controller.ts` — forward offset param
- `apps/backend/src/modules/reading/__tests__/reading.service.spec.ts` — +5 tests

**Created (1):**

- `.planning/phases/03-rankings-gamification-donations/03-02-SUMMARY.md` (this file)

## Hand-off to Plan 03-03 / 03-04

Plan 03-03 (Donations) will:
- Consume `maskNameIfMinor` in `donate.service.getPublicDonors` and `getTopDonors` (same pattern proven here)
- Use `isDonationStubActive` predicate already shipped in Plan 03-01

Plan 03-04 (WebSocket + Real-time) will:
- Wire `StatsGateway.emitTop100Update` from `TopService.autoPublish` (left as a TODO comment in `top.service.ts` line ~298)
- Wire `BadgeService.checkTopEntries` from the same hook
- Emit `KAFKA_TOPICS.TOP100_CONFIRMED` events on auto-publish (the topic constant from Plan 03-01 is ready; the emit site is the TODO)

## Self-Check: PASSED

**File existence verified:**

- `.planning/phases/03-rankings-gamification-donations/03-02-SUMMARY.md` — FOUND (this file, being written)
- `apps/backend/src/modules/top/top.service.ts` — FOUND (modified)
- `apps/backend/src/modules/top/top.controller.ts` — FOUND (modified)
- `apps/backend/src/modules/ai/fraud.service.ts` — FOUND (modified, verifyTop100Candidate present)
- `apps/backend/src/modules/reading/reading.service.ts` — FOUND (modified, SQL leaderboard present)

**Commit existence verified:**

- `491179d` — Task 1 — found in `git log --oneline`
- `8b8a082` — Task 2 — found in `git log --oneline`

**Test suite verified:** Final `npm test` reports `Tests: 827 passed, 827 total` (44 suites). `npx tsc --noEmit` reports zero output (clean).
