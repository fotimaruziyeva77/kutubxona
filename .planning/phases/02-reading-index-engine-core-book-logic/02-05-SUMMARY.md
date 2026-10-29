---
phase: 02-reading-index-engine-core-book-logic
plan: 05
subsystem: [libraries, transactions, reading, store]
tags: [book-transfer, roaming-confirm, overdue-cron, trust-score, comprehension-passrate, cascade-verification, phase2-close]

# Dependency graph
requires:
  - phase: 02-reading-index-engine-core-book-logic-02
    provides: BookTransfer schema (PENDING/CONFIRMED/REJECTED), returnRoaming PENDING-row creation, interactive $transaction with BOOK-05 CHECK constraint
  - phase: 02-reading-index-engine-core-book-logic-03
    provides: RiRecalcProcessor with reading-speed Trust Score signal (signal 2/3), trustDeltas map per-chunk pattern
  - phase: 02-reading-index-engine-core-book-logic-04
    provides: notification-queue infra (NOTIFICATION_QUEUE → EskizSmsClient), STORE-01 24h gate
  - phase: 02-reading-index-engine-core-book-logic-01
    provides: FRAUD-01 randomized answerIdx + FRAUD-02 min-time gate (STORE-02 cascade upstream)
provides:
  - POST /libraries/:libraryId/transfers/:transferId/confirm (BOOK-02 bilateral confirm)
  - LibrariesService.confirmTransfer interactive $transaction (atomic BookTransfer CONFIRMED + Book.availableCount + 1)
  - returnRoaming SMS enqueue verified end-to-end (existing path; +2 specs cover phone present / phone null)
  - recomputeOverdueDays (renamed from blockOverdueUsers — naming honesty; updates penaltyDays only, never user.status)
  - FRAUD-05 comprehension pass-rate Trust Score signal (signal 3 of 3 — last 30d pass rate > 0.8 = +5, < 0.4 = -5)
  - Combined Trust Score delta bounded to [-10, +10] per chunk per user (T-02-25)
  - STORE-02 end-to-end cascade verification specs (scan → comprehension → 24h gate → RI credit)
affects: [03 (Top-100 will read FraudScore.action='review' as the FLAGGED source-of-truth), 05 (monitoring may surface the new POST /transfers/:id/confirm endpoint metrics), 07 (PQ-9 institution rankings depend on TrustScore from FRAUD-05's three signals)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bilateral confirm endpoint: interactive $transaction + atomic Prisma { increment: 1 } for race-safe inventory move (T-02-24)"
    - "Tiered authorization: SUPER_ADMIN bypass + Institution.directorId match + tier-admin (TUMAN/VILOYAT) allowance at controller layer"
    - "Trust Score delta map: multiple FRAUD-05 signals (reading-speed + comprehension) sum into one bounded update per chunk per user"
    - "Comprehension pass-rate gate: high/low thresholds (>0.8, <0.4) with mid-range null zone — only strong signals nudge trust"
    - "Cron rename verification: grep gate (blockOverdueUsers → 0 occurrences) ensures the misleading name is purged everywhere"

key-files:
  created:
    - .planning/phases/02-reading-index-engine-core-book-logic/02-05-SUMMARY.md
  modified:
    - apps/backend/src/modules/libraries/libraries.service.ts (confirmTransfer added)
    - apps/backend/src/modules/libraries/libraries.controller.ts (POST /:libraryId/transfers/:transferId/confirm added)
    - apps/backend/src/modules/libraries/__tests__/libraries.service.spec.ts (+7 confirmTransfer cases)
    - apps/backend/src/modules/transactions/transactions.service.ts (blockOverdueUsers → recomputeOverdueDays rename; Eskiz dev-no-op comment added)
    - apps/backend/src/modules/transactions/__tests__/transactions.service.spec.ts (+8 specs: 2 returnRoaming SMS + 4 BOOK-04 overdue + 2 STORE-02 cascade)
    - apps/backend/src/modules/reading/ri-recalc.processor.ts (comprehension pass-rate signal + bounded delta combiner)
    - apps/backend/src/modules/reading/__tests__/ri-recalc.processor.spec.ts (+5 FRAUD-05 comprehension specs)
    - apps/backend/src/modules/store/__tests__/store.service.spec.ts (+2 STORE-02 cascade specs)

key-decisions:
  - "[Plan 02-05]: confirmTransfer increments Book.availableCount via Prisma's atomic { increment: 1 } — no findUnique-then-arithmetic-then-update sequence. Race-safe by construction; double-confirm rejected at the status check inside the interactive $transaction (T-02-24)"
  - "[Plan 02-05]: confirmTransfer authorization tier — SUPER_ADMIN bypass OR Institution.directorId match OR TUMAN_ADMIN/VILOYAT_ADMIN allowance at the controller's RolesGuard. Tier-admin tuman-scope assertion at confirm time is a v2 hardening (the RolesGuard already gates the role list; future work narrows further by tuman join)"
  - "[Plan 02-05]: blockOverdueUsers → recomputeOverdueDays rename is naming honesty, not behavioral change. The cron has NEVER called prisma.user.update; it only updates BookTransaction.penaltyDays. The actual borrow-time block lives in hasOverdueBooks() (entry-point ForbiddenException)"
  - "[Plan 02-05]: BOOK-04 SMS delivery depends on Eskiz creds; in dev the EskizSmsClient no-ops cleanly (warn log). This is the documented Phase 1 carry-over from AUTH-01 — closed by env vars, not code"
  - "[Plan 02-05]: FRAUD-05 comprehension pass-rate uses high/low gates (>0.8 / <0.4) with mid-range null zone. Combined cumulative delta with reading-speed (Plan 02-03) bounded to [-10, +10] per chunk per user to cap gameability upside (T-02-25)"
  - "[Plan 02-05]: FRAUD-05 location signal (signal 4) explicitly deferred to v2 per research Open Q 2 — no GPS column in V1 schema; would require a new migration and frontend capture work"
  - "[Plan 02-05]: STORE-02 is verification-only — no STORE-02-specific code needed. The behavior cascades from Plan 02-01 (FRAUD-01 random answerIdx + FRAUD-02 min-time gate) and Plan 02-04 (STORE-01 24h gate). Audit-trail specs added across transactions.service.spec + store.service.spec"

patterns-established:
  - "Roaming bilateral confirm: PENDING → CONFIRMED via tiered-auth interactive $transaction + atomic-increment book update + status check inside the same transaction for double-confirm rejection"
  - "Per-chunk bounded Trust Score delta: multiple FRAUD-05 signals (reading-speed, comprehension) sum into a single Map<userId, delta> entry; one prisma.user.update per user per chunk; cumulative bounded to [-10, +10]"
  - "Cascade verification pattern: spec-only audit trail proving upstream-fix integration without owning the production code path"

requirements-completed: [BOOK-02, BOOK-04, FRAUD-05, STORE-02]

# Metrics
duration: ~30min
completed: 2026-06-06
---

# Phase 2 Plan 05: Roaming Finalize + Overdue Verify + FRAUD-05 Signal 3 + STORE-02 Cascade Summary

**Wave 5 closes Phase 2. The bilateral roaming confirm endpoint ships (BOOK-02), the overdue cron is verified and honestly renamed (BOOK-04), FRAUD-05's third Trust Score signal lands in the nightly batch (comprehension pass-rate), and STORE-02 cascade is verified end-to-end by spec. All 19 Phase 2 requirements (RI-01..05, FRAUD-01..06, BOOK-01..05, STORE-01..03) now have passing specs. Backend test suite: 773/773 green (+22 from the 751 baseline).**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-06-06T20:17:00Z
- **Completed:** 2026-06-06T20:30:00Z
- **Tasks:** 4 (all TDD)
- **Files modified:** 9 (no new production files — all changes layer onto Plan 02-02/03/04 scaffolding)

## Accomplishments

### Task 1 — BOOK-02 bilateral confirm endpoint

The PENDING BookTransfer rows that Plan 02-02 started writing on every `returnRoaming` call now have a finalisation path. `POST /libraries/:libraryId/transfers/:transferId/confirm` lives in `LibrariesController`, RolesGuard-protected for KUTUBXONACHI / SUPER_ADMIN / TUMAN_ADMIN / VILOYAT_ADMIN. Inside `LibrariesService.confirmTransfer`:

```
prisma.$transaction(async (p) => {
  1. bookTransfer.findUnique({ include: fromLibrary.institution + transaction.book })
  2. NotFound / BadRequest (status !== PENDING) / BadRequest (libraryId mismatch)
  3. Authorization gate:
       SUPER_ADMIN  bypass
       OR Institution.directorId === authUser.id
       OR TUMAN_ADMIN / VILOYAT_ADMIN (RolesGuard-checked)
       else ForbiddenException
  4. bookTransfer.update(status='CONFIRMED' + confirmedAt + confirmedById)
  5. book.update(availableCount { increment: 1 })   ← atomic, race-safe
})
```

The increment is Prisma's atomic `{ increment: 1 }` form — no findUnique-then-arithmetic-then-update sequence that could lose a concurrent write. Double-confirm is rejected at the status check inside the same `$transaction`, so two concurrent confirm calls cannot both succeed. P2010 / P2002 / P2003 are surfaced as 400 BadRequestException matching the BOOK-05 pattern from Plan 02-02.

`returnRoaming` SMS enqueue was already wired by Plan 02-02 (line 470 of `transactions.service.ts`); Plan 02-05 verifies it with two new specs — phone present → `sms.sendNotification` invoked with the source library phone + return library name + transfer-confirmation hint; phone null → silently skipped. In dev (no Eskiz creds) the queue accepts the job and the `EskizSmsClient` no-ops cleanly with a warn log — documented Phase 1 carry-over from AUTH-01.

**Threat coverage:** T-02-23 (spoofing) mitigated by the auth gate; T-02-24 (double-confirm) mitigated by the in-transaction status check + atomic increment.

### Task 2 — BOOK-04 verify + cron rename

The `checkOverdueAlerts` cron (`@Cron('0 10 * * *')`) survived Plan 02-03's reading-service refactor untouched. New specs assert:

- 3-day reminder: `BORROWED` with `dueDate ∈ [now+3d-1h, now+3d+1h]` → `sms.sendNotification` invoked with the user's phone + "3 kun" message
- 1-day reminder: same window 1 day out → "ERTAGA" message
- `hasOverdueBooks` blocks `borrow()` with `ForbiddenException` ("muddati o'tgan kitoblar bor")

The `blockOverdueUsers` cron was renamed to `recomputeOverdueDays` — the legacy name was misleading because the cron has never called `prisma.user.update` or changed `user.status`. It only updates `BookTransaction.penaltyDays` for `BORROWED` rows whose `dueDate` has passed. Grep gate verifies `blockOverdueUsers` appears 0 times in `transactions.service.ts`. A clarifying header comment now explains that the actual borrow-time block lives in `hasOverdueBooks()` (entry-point `ForbiddenException` from `reserve()` and `borrow()`).

SMS delivery on `checkOverdueAlerts` depends on Eskiz credentials. In dev (no `ESKIZ_EMAIL`/`ESKIZ_PASSWORD`) the `EskizSmsClient` no-ops cleanly — closed by env vars, not code. This is the documented Phase 1 carry-over from AUTH-01.

### Task 3 — FRAUD-05 comprehension pass-rate signal (signal 3 of 3)

The `RiRecalcProcessor` now reads the user's `ComprehensionTest` records over the last 30 days in the same `Promise.all` batched read as transactions and isbnScans. Grouping by `isbnScan.userId` is O(N) per chunk.

Per-user logic:
- `passRate = passedCount / totalCount`
- `passRate > 0.8` → `compDelta = +5`
- `passRate < 0.4` → `compDelta = -5`
- mid-range (0.4..0.8) → no contribution (intentional null zone — only strong signals nudge trust)
- zero tests → no contribution (no implicit penalty for non-store-purchasers)

The combined cumulative delta (`speedDelta + compDelta`) is bounded to `[-TRUST_DELTA_BOUND, +TRUST_DELTA_BOUND]` = `[-10, +10]` before the `trustDeltas.set(user.id, bounded)` call. One `prisma.user.update` per user per chunk — both signals collapse into a single bounded update.

**T-02-25 mitigation:** a `+5` step requires passing both FRAUD-01 randomization (forces real reading) and FRAUD-02 min-time gates; a `-5` step requires sustained failure across 30 days. The `[-10, +10]` cap means a perfect-bot farmer caps their gain at `+10/chunk`, not enough upside to be worth coordinating multi-day fake-reading patterns.

**FRAUD-05 signals now complete (V1 scope):**
1. ✅ Return discipline (Plan 02-01 — `RiskLevel.FLAGGED` + admin review queue)
2. ✅ Reading speed (Plan 02-03 — pages/hour > 100 OR hoursHeld < 0.5 → -5)
3. ✅ Comprehension pass-rate (Plan 02-05 — last-30d > 0.8 / < 0.4 gates → ±5)
4. ❌ Location proximity — explicitly deferred to v2 per research Open Q 2 (no GPS column in V1 schema)

### Task 4 — STORE-02 cascade verification

Verification-only, no production code. STORE-02 ("kitobxon sotib olgan kitobni hisoblash") cascades cleanly from upstream plans:

```
Reader scans ISBN (or store webhook records purchase)
  → Plan 02-01 FRAUD-01: every 5th confirmed scan creates ComprehensionTest with randomized answerIdx
  → Plan 02-01 FRAUD-02: min-time gate (5s/question whole-test + 3s/question per-question)
  → Plan 02-04 STORE-01: confirmPurchase rejects scans > 24h old
  → Confirmed scan reaches RiRecalcProcessor at STORE_COEF = 0.9x (Plan 02-03 parity)
```

Four new specs across `transactions.service.spec` + `store.service.spec`:
- "scanIsbn triggers comprehension test on every 5th confirmed scan" — asserts `comprehensionTest.create` with `options[answerIdx]` populated across all questions (FRAUD-01 invariant)
- "scanIsbn auto-confirms scans 1-4 in the cycle" — iterates positions 0..3 prior-confirmed-count, asserts `requiresTest=false` and no `comprehensionTest.create`
- "scan + confirm flow respects the 24h gate end-to-end" — store webhook → IsbnScan → confirmPurchase within 24h → update applied (RI credit handoff)
- "scan + confirm flow rejects stale (>24h) confirmation" — cascade halts at the gate, no `isbnScan.update` invoked

This is the audit trail proving the cascade integrates correctly; no STORE-02-specific code path is needed in this plan.

## Bilateral Roaming Smoke Test (Manual / Optional)

Per the plan's `<verification>` step 4:

```
1. Create a BORROWED tx in Navoiy library (LIB-GOV-08012-001), book = "Alpomish"
2. POST /api/v1/transactions/<txId>/return-roaming { returnLibraryId: "LIB-GOV-10001-001" (Toshkent) }
   → BookTransfer{PENDING, fromLibraryId=Navoiy, toLibraryId=Toshkent} created
   → SMS log line emitted (dev no-op): "[eskiz dev no-op] ... would have sent SMS to +99861234..."
3. POST /api/v1/libraries/<LIB-GOV-08012-001>/transfers/<transferId>/confirm
   (as the Navoiy librarian — Institution.directorId === authUser.sub)
   → BookTransfer status = CONFIRMED, confirmedAt = now, confirmedById = librarianId
   → Book.availableCount on the Navoiy book bumps by +1
4. Double-confirm: POST same endpoint again
   → 400 BadRequestException("Transfer allaqachon tasdiqlangan yoki bekor qilingan")
```

Not executed automatically (no live Eskiz creds + no live frontend test session for librarian role); the spec layer covers the invariants.

## All 19 Phase 2 Requirements Spec Coverage

| Req     | Spec source                                                                | Plan |
| ------- | -------------------------------------------------------------------------- | ---- |
| RI-01   | ri-recalc.processor.spec — batched RI rows + addBulk fan-out               | 02-03 |
| RI-02   | reading.service.spec — per-source coefficient                              | 02-01 |
| RI-03   | reading.service.spec — monthlyPartitionCleanup DDL                         | 02-04 |
| RI-04   | reading.service.spec — computeDelta + 1h cache                             | 02-04 |
| RI-05   | reading.service.spec / ri-recalc.processor.spec — partition writes         | 02-02 |
| FRAUD-01 | transactions.service.spec — randomized answerIdx + invariant assertion    | 02-01 |
| FRAUD-02 | transactions.service.spec — whole-test + per-question min-time gates      | 02-01 |
| FRAUD-03 | fraud.service.spec — admin review queue + no auto-block                   | 02-04 |
| FRAUD-04 | transactions.service.spec — storeManualEntry auth-from-user                | 02-01 |
| FRAUD-05 | ri-recalc.processor.spec — three signals (discipline + speed + comp)      | 02-03 + 02-05 |
| FRAUD-06 | fraud.service.spec — RiskLevel.FLAGGED + RI_SPIKE fix                     | 02-01 + 02-04 |
| BOOK-01  | books-import.processor.spec — async Excel import                          | 02-04 |
| BOOK-02  | libraries.service.spec / transactions.service.spec — confirmTransfer + SMS | 02-05 |
| BOOK-03  | transactions.service.spec — reserve-time borrow limit                     | 02-01 |
| BOOK-04  | transactions.service.spec — overdue cron + hasOverdueBooks block          | 02-05 |
| BOOK-05  | transactions.service.spec — CHECK constraint surface as 400               | 02-02 |
| STORE-01 | store.service.spec — 24h expiry gate                                      | 02-04 |
| STORE-02 | transactions.service.spec + store.service.spec — scan → comp → 24h chain  | 02-05 |
| STORE-03 | reading.service.spec — STORE_COEF = 0.9x in per-source coefficient        | 02-01 |

**19 / 19 requirements covered.**

## Phase 2 → Phase 3 Handoff

- **FLAGGED source of truth:** Phase 3 (Top-100 workflow) MUST read `FraudScore.action` for the candidate-filtering step. Values:
  - `'review'` — flagged by the daily fraud scan or by a signal accumulator; admin review pending; **exclude from Top-100**
  - `'cleared'` — admin reviewed and cleared; **include**
  - `'confirmed'` — admin reviewed and confirmed fraud; **exclude permanently**
  - `null` / unset — no signal; **include** (default)
- **Trust Score is canonical for ranking weight:** Phase 3 may use `User.trustScore` in the Top-100 Final Score formula (T-02-11). The three FRAUD-05 signals all converge into `trustScore` via the nightly batch; Top-100 does not need to re-aggregate signal sources.
- **Reading Index lives in partitioned table:** Phase 3 reading queries should respect the partition layout — `WHERE calculatedAt >= <start>` is the partition-pruning predicate. The composite PK `(id, calculatedAt)` is auto-propagated to every partition.
- **BookTransfer state machine is now complete:** PENDING → CONFIRMED (via this plan's endpoint) or PENDING → REJECTED (no endpoint shipped; rejection requires another plan and is not a Phase 2 requirement). Phase 3 monitoring may surface PENDING-aged metrics as a follow-up.

## Deferrals (carried out of Phase 2)

| Item                                                            | Deferred to | Reason                                                                                         |
| --------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| FRAUD-05 location proximity signal (signal 4)                   | v2          | No GPS column in V1 schema; frontend capture and schema migration both required (Open Q 2)     |
| MinIO archive of RI partitions on monthly drop                  | v2          | Plan 02-04 dropped partitions O(1) via DETACH+DROP per research permission; audit lives elsewhere |
| AI-generated comprehension questions (currently template-based) | Phase 7     | AI-01..05 are Phase 7 scope; current 3-question template is sufficient for FRAUD-01/02 gates   |
| TUMAN_ADMIN tuman-scope assertion at confirm time               | v2          | RolesGuard already gates by role; tuman scope narrows further (User→Address join not yet wired) |
| BookTransfer rejection endpoint (PENDING → REJECTED)            | v2          | Not a Phase 2 requirement; happy-path confirm covers the immediate need                        |
| Eskiz SMS live-delivery verification (AUTH-01 carry-over)       | env vars    | Code paths complete; closed by ESKIZ_EMAIL/ESKIZ_PASSWORD, not code                            |
| OneID live handshake (Phase 1 01-06)                            | env vars    | Code paths complete; closed by IDUZ_CLIENT_ID/SECRET, not code                                 |

## Deviations

None — plan executed as written. The single nuance: the `returnRoaming` SMS enqueue was already shipped in Plan 02-02 (line 470), so Task 1's spec layer just verifies the existing behavior; no production change to `transactions.service.ts` was needed for that part. The plan's `<must_haves>.truths` line ("returnRoaming enqueues SMS to source library via NOTIFICATION_QUEUE → EskizSmsClient path") was satisfied by `sms.sendNotification` which routes through that path.

## Test Suite Status

```
Test Suites: 41 passed, 41 total
Tests:       773 passed, 773 total
Time:        ~36s
```

Up from 751 baseline (+22 net). Breakdown by task:
- Task 1 (BOOK-02): +7 cases (6 confirmTransfer + 1 net for returnRoaming SMS — 2 new minus 1 existing-spec-superset)
- Task 2 (BOOK-04 verify + rename): +4 cases
- Task 3 (FRAUD-05 comprehension): +5 cases
- Task 4 (STORE-02 cascade): +4 cases

Backend tsc clean.

## Commits

- `5618ce3` — feat(transactions,libraries)(02-05): confirmTransfer endpoint + SMS enqueue on returnRoaming (BOOK-02)
- `3f73548` — verify(transactions)(02-05): overdue cron + hasOverdueBooks block + rename to recomputeOverdueDays (BOOK-04)
- `d077eed` — feat(reading)(02-05): comprehension pass-rate Trust Score signal (FRAUD-05 signal 3/3)
- `a03d59c` — test(store,transactions)(02-05): ISBN scan → comprehension → RI cascade verification (STORE-02)

## Phase 2 Wrap-up

This is the final plan of Phase 2. After this commit Phase 2 is code-complete and ready for `gsd-verifier`.

**What shipped end-to-end across the 5 plans:**

- **Plan 02-01** (Wave 1) — Surgical fixes: exceljs install (xlsx removal deferred to 02-04), FRAUD-01 randomized answerIdx, FRAUD-02 min-time gates, FRAUD-04 store auth from authenticated user, FLAGGED rename, per-source RI coefficient, reserve-time borrow limit.
- **Plan 02-02** (Wave 2) — Schema work: ReadingIndex range-partitioned by month (16 monthly partitions, composite PK), BookTransaction.extended (penaltyDays=-1 sentinel retired), BookTransfer model + indexes, Book CHECK constraint (availableCount ≥ 0), 7 sites converted from array-form to interactive `$transaction` callback.
- **Plan 02-03** (Wave 3) — RI batch engine: PrismaReplicaService (graceful no-op when DATABASE_REPLICA_URL unset), RiRecalcProcessor (BullMQ concurrency 10), addBulk fan-out cron replacing the sequential nightly loop (C6 closed), FRAUD-05 reading-speed Trust Score signal (signal 2/3).
- **Plan 02-04** (Wave 4) — Async + review queue: BookImportProcessor (Excel via BullMQ; xlsx removed), FRAUD-03 admin review queue with tier-scoped access (no auto-block), RI-04 delta endpoint (1h cache), RI-03 monthly partition cleanup cron, STORE-01 24h confirm gate.
- **Plan 02-05** (Wave 5 — this plan) — Roaming finalize + signal 3 + verification: BOOK-02 confirmTransfer endpoint, BOOK-04 verify + rename, FRAUD-05 comprehension pass-rate signal (signal 3/3), STORE-02 cascade verification.

**Critical pitfalls closed:**
- C2 (FRAUD-03 silent auto-block) — replaced with admin review queue (Plan 02-04)
- C6 (sequential nightly RI loop at 5M users projected 69h) — replaced with BullMQ fan-out projected ~100 min (Plan 02-03)
- BOOK-05 (availableCount race) — Book CHECK + interactive `$transaction` surface as 400 (Plan 02-02)

**Aggregate test growth:** Phase 2 entered at 668 (Phase 1 baseline), exits at 773 (+105 net).

## Self-Check: PASSED

Files verified:
- `apps/backend/src/modules/libraries/libraries.service.ts` — confirmTransfer present
- `apps/backend/src/modules/libraries/libraries.controller.ts` — `@Post(':libraryId/transfers/:transferId/confirm')` present
- `apps/backend/src/modules/transactions/transactions.service.ts` — `recomputeOverdueDays` present, `blockOverdueUsers` returns 0 grep hits
- `apps/backend/src/modules/reading/ri-recalc.processor.ts` — `comprehensionTest.findMany` + `COMPREHENSION_HIGH_RATE`/`COMPREHENSION_LOW_RATE` + bounded delta combiner present
- Commits 5618ce3, 3f73548, d077eed, a03d59c — all present in git log
