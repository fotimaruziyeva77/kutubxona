---
phase: 02-reading-index-engine-core-book-logic
plan: 01
subsystem: transactions + reading + fraud + queue
tags: [fraud-detection, comprehension-test, reading-index, borrow-limit, exceljs, bullmq, supply-chain]
status: complete
checkpoint_pending: false
requires:
  - "@.planning/phases/02-reading-index-engine-core-book-logic/02-RESEARCH.md (FRAUD-01/02/04/06, BOOK-03, STORE-03, RI-02)"
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-01-SUMMARY.md (BullMQ NOTIFICATION_QUEUE pattern)"
provides:
  - "Comprehension test answer-position randomization + server-side min-time gates"
  - "reserve()-time borrow limit enforcement (BORROWED + RESERVED + PENDING counted)"
  - "Per-source coefficient sum in Reading Index books-count component (MUTOLAA 0.85x and EBOOK 0.8x restored)"
  - "Store endpoint authorization via @CurrentUser('id') — body.operatorId no longer trusted"
  - "RiskLevel union renamed BLOCKED -> FLAGGED; action='review' for the highest-risk band"
  - "exceljs dependency installed (xlsx CVE replacement; uninstall deferred to Plan 02-04)"
  - "RI_RECALC_QUEUE BullMQ constant registered (worker attached in Plan 02-03)"
  - "@CurrentUser decorator now honors property selectors ('id' -> payload.sub, etc.) — fixes pre-existing latent bug"
affects:
  - "apps/backend/package.json"
  - "apps/backend/src/infra/queue/queue.module.ts"
  - "apps/backend/src/infra/queue/queue.module.spec.ts"
  - "apps/backend/src/modules/transactions/transactions.service.ts"
  - "apps/backend/src/modules/transactions/transactions.controller.ts"
  - "apps/backend/src/modules/transactions/__tests__/transactions.service.spec.ts"
  - "apps/backend/src/modules/reading/reading.service.ts"
  - "apps/backend/src/modules/reading/__tests__/reading.service.spec.ts"
  - "apps/backend/src/modules/ai/fraud.service.ts"
  - "apps/backend/src/modules/ai/__tests__/fraud.service.spec.ts"
  - "apps/backend/src/common/decorators/current-user.decorator.ts"
tech-stack:
  added: ["exceljs@^4.4.0"]
  patterns: ["Fisher-Yates shuffle for question randomization", "per-source coefficient branching", "@CurrentUser(key) property selector", "BullMQ defaultJobOptions with exponential backoff"]
key-files:
  created:
    - "apps/backend/src/infra/queue/queue.module.spec.ts"
  modified:
    - "apps/backend/src/modules/transactions/transactions.service.ts (FRAUD-01 shuffle helper, FRAUD-02 min-time gates, BOOK-03 reserve-time limit, FRAUD-04 storeManualEntry auth)"
    - "apps/backend/src/modules/transactions/transactions.controller.ts (store-entry uses @CurrentUser('id'); operatorId removed from DTO)"
    - "apps/backend/src/modules/reading/reading.service.ts (per-source coefficient sum; components JSON exposes totalScan/totalStore/totalMutolaa/totalEbook)"
    - "apps/backend/src/modules/ai/fraud.service.ts (RiskLevel/RISK_THRESHOLDS BLOCKED->FLAGGED; _getAction(FLAGGED)='review')"
    - "apps/backend/src/common/decorators/current-user.decorator.ts (data parameter now honored; 'id' maps to payload.sub)"
    - "apps/backend/src/infra/queue/queue.module.ts (RI_RECALC_QUEUE registered)"
    - "apps/backend/package.json (exceljs added; xlsx retained pending Plan 02-04)"
decisions:
  - "exceljs@^4.4.0 installed; xlsx@0.18.5 NOT removed yet because books.service.ts still imports it. Plan 02-04 will swap the import and run `npm uninstall xlsx` atomically with the code change. Per the plan's acceptance criterion this is the documented choice (avoids a temporary build-tolerant state with a TODO marker)."
  - "RiskLevel FLAGGED maps to action='review' (not 'block'). The User.status='BLOCKED' auto-block side-effect in dailyFraudScan is preserved per plan — Plan 02-04 removes it together with the FRAUD-03 review-queue endpoint. The remaining 'BLOCKED' literal in fraud.service.ts is the UserStatus enum value, semantically distinct from the renamed RiskLevel."
  - "Fixed latent bug in @CurrentUser decorator (Rule 1 deviation — needed for Task 4): the data parameter was previously ignored, so the existing `@CurrentUser('id')` calls in store / otm controllers returned the full JwtPayload object instead of the id string. Now 'id' maps to payload.sub (JWT puts the user id in sub) and other keys forward verbatim. This silently fixes three pre-existing latent bugs."
  - "Pre-approved package legitimacy checkpoint for exceljs (Task 1) was resolved without interactive prompt per orchestrator instructions — exceljs is the canonical Node.js Excel library (>5M weekly downloads, MIT, no open CVEs on Snyk advisory DB) and replaces xlsx@0.18.5 (CVE-2024-22363 ReDoS + CVE-2023-30533 prototype pollution, both unfixed)."
metrics:
  duration_minutes: 15
  completed_date: "2026-06-06"
  tasks_complete: 4
  tasks_skipped: 1
  tests_added: 19
  test_suite: "699/699 green (+19 net over 680 baseline)"
---

# Phase 2 Plan 1: Wave 0/1 surgical fixes Summary

Five non-schema fraud / limit / coefficient bugs fixed atomically alongside the Wave 0 dep prep — `exceljs` installed, `RI_RECALC_QUEUE` registered, comprehension test randomized + min-time-gated, reserve()-time borrow limit enforced, Reading Index books-count component now applies the per-source coefficient sum (MUTOLAA 0.85x and EBOOK 0.8x restored), store-entry endpoint trusts only `@CurrentUser('id')`, and the misleading `BLOCKED` RiskLevel label is renamed `FLAGGED` with `action='review'` mapping. Backend suite goes from 680 → 699 green (+19 net).

## Checkpoint resolutions

### Task 1 — Package legitimacy (`exceljs`) — PRE-APPROVED

The user pre-approved the swap to `exceljs@^4.4.0` before agent spawn (orchestrator `<pre_approved_checkpoint>` directive). Rationale recorded:

- ExcelJS is the canonical Node.js Excel library; >5M weekly downloads, MIT, repository at https://github.com/exceljs/exceljs, actively maintained.
- Verified against npm registry and Snyk advisory DB at Phase 2 research time; no open CVEs.
- Replaces the deprecated `xlsx@0.18.5` which carries two unfixed high-severity advisories (CVE-2024-22363 ReDoS, CVE-2023-30533 prototype pollution).

Resume signal treated as `"approved, install exceljs@^4.4.0"` and the agent proceeded directly to Task 2.

## What was built

### Task 2 — exceljs install + RI_RECALC_QUEUE registration (Wave 0)

| File | Change |
|---|---|
| `apps/backend/package.json` | Added `exceljs@^4.4.0` to dependencies. **xlsx retained** (still imported by `books.service.ts`); uninstall deferred to Plan 02-04 where the import is swapped. |
| `apps/backend/src/infra/queue/queue.module.ts` | Added `export const RI_RECALC_QUEUE = "ri-recalc";` and a fourth `BullModule.registerQueue` block with `attempts: 3`, `backoff: { type: "exponential", delay: 5000 }`. No processor attached — `RiRecalcProcessor` lands in Plan 02-03. |
| `apps/backend/src/infra/queue/queue.module.spec.ts` *(created)* | Asserts the four canonical queue names (`notifications`, `reports`, `ai-tasks`, `ri-recalc`). |

Commit: `bdb5c43` — `chore(deps)(02-01): install exceljs + register RI_RECALC_QUEUE (Wave 0)`

### Task 3 — Comprehension randomization, min-time gates, reserve-time limit, per-source RI coefficient

**FRAUD-01 — comprehension answer randomization** (`transactions.service.ts:702-720` → new `shuffle()` + `buildQuestion()` helpers):

- Fisher-Yates `shuffle<T>(arr: T[])` produces a new options array; `buildQuestion(q, correct, distractors)` sets `answerIdx = options.indexOf(correct)` after shuffle.
- Question 3 reworded from "Kitobni to'liq o'qidingizmi?" (the old free pass) to "Kitobni qachon o'qib tugatdingiz?" with correct = "Oxirgi 30 kun ichida".
- A `[0, 0, 0]` submission script no longer passes — across 1000 generations, the answerIdx-zero rate for question 1 is statistically uniform (≈250/1000), well below the spec's `< 800` canary.

**FRAUD-02 — server-side min-time gates** (`submitComprehensionTest` signature now `(userId, isbnScanId, answers, answerTimingsMs?)`):

- Whole-test gate: `elapsedMs = Date.now() - test.createdAt.getTime()` must be `>= 5_000 * questions.length`. Rejection includes the actual elapsed value in the Uzbek error message.
- Per-question gate (optional `answerTimingsMs[]`): any element `< 3_000` ms rejects with `BadRequestException`.
- Both gates run BEFORE the existing answerIdx grading loop.

**BOOK-03 — reserve-time borrow limit** (`reserve()` in `transactions.service.ts`):

- After the existing `hasOverdueBooks` check, count active transactions in statuses `BORROWED | RESERVED | PENDING`. If `>= getBorrowLimit(user.type, user.trustScore)`, throw `ForbiddenException`.
- Closes the loophole where a CITIZEN at limit 2 could queue PENDING/RESERVED reservations indefinitely and hold scarce copies.
- TrustScore 90+ bonus (+1 to the cap) is honored — STUDENT_UNIVERSITY at 5 active with trustScore 95 is allowed to reserve a 6th.

**RI-02 / STORE-03 — per-source coefficient sum** (`reading.service.ts:93-99`):

- Replaced the flat `0.9 * isbnScans.length` (which dropped MUTOLAA's 0.85x and EBOOK's 0.8x and double-counted STORE_MANUAL) with branching per `isbnScan.source`:
  - `USER_SCAN  × 0.9` (`COEF.ISBN_SCAN`)
  - `STORE_MANUAL × 0.9` (`COEF.STORE`)
  - `MUTOLAA × 0.85` (`COEF.MUTOLAA`)
  - `EBOOK × 0.8` (`COEF.EBOOK`)
- `components` JSON now exposes per-source counts (`totalScan`, `totalStore`, `totalMutolaa`, `totalEbook`) alongside the backward-compatible aggregate `totalIsbn`.

**Tests added (7 new):**
- `transactions.service.spec`: `comprehension test randomizes answer position (FRAUD-01)` (1000-iteration statistical canary)
- `transactions.service.spec`: `generated questions always store the correct value at answerIdx (FRAUD-01)` (sanity check across 100 iterations)
- `transactions.service.spec`: `rejects fast submission — elapsed < 5s/question (FRAUD-02)`
- `transactions.service.spec`: `rejects fast per-question timings — any answer < 3s (FRAUD-02)`
- `transactions.service.spec`: `accepts submission when elapsed and per-question gates pass (FRAUD-02)`
- `transactions.service.spec`: 3-test `reserve borrow limit (BOOK-03)` block (`STUDENT_UNIVERSITY at limit 5 cannot reserve 6th`, `STUDENT_UNIVERSITY with trustScore 90+ has limit 6`, `CITIZEN at limit 2 cannot reserve 3rd`)
- `reading.service.spec`: `applies per-source coefficient (RI-02 / STORE-03)` (exact-math regression on 1 lib + 4 sources = 44.5 weighted)
- `reading.service.spec`: `MUTOLAA-only user accrues 0.85x books-count (RI-02)` (2 × 0.85 = 1.7 → 17)

Commit: `5cd67d5` — `feat(reading,transactions)(02-01): FRAUD-01/02 + BOOK-03 + RI-02 surgical fixes`

### Task 4 — Store endpoint authorization via @CurrentUser (FRAUD-04)

- `storeManualEntry` signature now `(authUserId, phone, isbn)`. The first action is to load the auth user (`select: { id, role }`) and reject anyone other than `DOKON_OPERATOR` or `SUPER_ADMIN` with `ForbiddenException`.
- For `DOKON_OPERATOR`, additionally `prisma.institution.findFirst({ where: { directorId: authUserId } })` must return a row; missing → `ForbiddenException`. `SUPER_ADMIN` skips the institution check.
- `IsbnScan.storeId` is set from `authUserId` — the trustworthy JWT-derived value. Any `body.operatorId` is silently ignored (no 400) so the existing `dokon/page.tsx` frontend continues to work during the migration window.
- `transactions.controller.ts` switches the route signature to `(@CurrentUser("id") authUserId: string, @Body() body: { phone: string; isbn: string })` — `operatorId` removed from the DTO type so callers cannot smuggle it in via TypeScript.
- **Side-effect (Rule 1 deviation):** the `@CurrentUser` decorator previously ignored its `data` parameter, so the three pre-existing call-sites (`store.controller.ts:49/63`, `otm.controller.ts:96`) using `@CurrentUser("id")` were silently receiving the full `JwtPayload` object as a string. The decorator now properly maps `"id" -> payload.sub` and forwards any other JwtPayload key — fixing those latent bugs as a free side-effect.

**Tests added (5 new):**
- `storeManualEntry (FRAUD-04) — store entry`: 5 cases (derives operator, rejects non-DOKON/non-admin, rejects DOKON without Institution, SUPER_ADMIN skips institution check, rejects unknown phone)

Commit: `e677860` — `fix(transactions)(02-01): FRAUD-04 store endpoint authorization via @CurrentUser`

### Task 5 — RiskLevel BLOCKED → FLAGGED rename (FRAUD-06)

- `RISK_THRESHOLDS.BLOCKED` → `RISK_THRESHOLDS.FLAGGED` (70-100 band, unchanged).
- `RiskLevel` union member `"BLOCKED"` → `"FLAGGED"`.
- Three call-sites that compared `riskLevel === "BLOCKED"` (Kafka emit, Top-100 counter, dailyFraudScan auto-block trigger) updated to `=== "FLAGGED"`.
- `_getAction(FLAGGED)` returns `'review'` (not `'block'`) — aligns with the FRAUD-03 review-queue semantics that Plan 02-04 will wire up. Downstream consumers (`FraudScore.action` column, `getFraudStats`) now see `'review'` as the source-of-truth label for the highest-risk band.
- **Preserved per plan:** the `dailyFraudScan` auto-block path (`User.status = "BLOCKED"`) is still triggered on `riskLevel === "FLAGGED"`. The `"BLOCKED"` literal that remains in fraud.service.ts is the `UserStatus` enum value (PENDING / ACTIVE / **BLOCKED** / DELETED in schema.prisma — semantically distinct from the renamed RiskLevel). Plan 02-04 will remove that side-effect together with the review-queue endpoint.
- `predict.service.ts` and `ai.controller.ts` have no `"BLOCKED"` references — no cross-file rename needed.

**Tests added (5 new):**
- `RISK_THRESHOLDS`: `FLAGGED 70-100 oralig'ida (FRAUD-06)`
- `RISK_THRESHOLDS`: `BLOCKED kalit endi mavjud emas (FRAUD-06)` (asserts the old key is absent)
- `RISK_THRESHOLDS`: `RiskLevel union — FLAGGED qabul qiladi (type-level check)`
- `analyzeUser`: renamed `riskScore 70+ bo'lganda BLOCKED va Kafka event` to `... FLAGGED ...`; added `result.action === "review"` assertion.

Commit: `ae510c6` — `refactor(fraud)(02-01): rename RiskLevel BLOCKED -> FLAGGED (FRAUD-06)`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Fixed @CurrentUser decorator data parameter being ignored**
- **Found during:** Task 4 read-through of `current-user.decorator.ts`
- **Issue:** The decorator's signature was `(_data: unknown, ctx) => request.user as JwtPayload` — the `data` parameter (set when callers write `@CurrentUser("id")`) was discarded, so every call-site using a key selector got the full `JwtPayload` object instead of the field. Three pre-existing call-sites (`store.controller.ts:49/63`, `otm.controller.ts:96`) were silently broken before this plan ran. Task 4 plan explicitly requires `@CurrentUser("id") authUserId: string`, which would have inherited the same bug.
- **Fix:** Decorator now honors `data`: `"id"` maps to `payload.sub` (the JWT puts the user id in `sub`, but callers consistently spell it `"id"` for readability); any other key forwards verbatim (`role`, `phone`, etc.). No callers receive a string at runtime that they expected.
- **Files modified:** `apps/backend/src/common/decorators/current-user.decorator.ts`
- **Commit:** `e677860` (bundled with the rest of Task 4 because the fix is a prerequisite for Task 4's correctness)

No Rule 2 / Rule 3 / Rule 4 deviations required.

## Known Stubs

None introduced. The `xlsx` package remains in `dependencies` because `books.service.ts` still imports it; that swap is part of Plan 02-04 and tracked there. No UI placeholder values or hardcoded empty arrays were created.

## Verification

| Check | Command | Result |
|---|---|---|
| Targeted spec (Task 2) | `npx jest src/infra/queue/queue.module.spec.ts --bail` | 2/2 pass |
| Targeted specs (Task 3) | `npx jest --testPathPatterns='transactions.service.spec|reading.service.spec' --bail` | 62/62 pass |
| Targeted spec (Task 4) | `npx jest transactions.service.spec -t "store entry" --bail` | 5/5 pass |
| Targeted spec (Task 5) | `npx jest fraud.service.spec -t "FLAGGED" --bail` | 3/3 pass |
| Full backend suite | `cd apps/backend && npm test` | **699/699 pass** (+19 over 680 baseline) |
| TypeScript | `npx tsc --noEmit` | clean |
| Build | `npm run build` | clean |
| Grep gate (exceljs) | `node -e "require('./package.json').dependencies.exceljs"` | `^4.4.0` |
| Grep gate (queue) | `grep -c 'RI_RECALC_QUEUE = "ri-recalc"'` | 1 |
| RiskLevel "BLOCKED" remaining | `grep '"BLOCKED"' src/modules/ai/fraud.service.ts` | 3 hits — all comment / UserStatus enum value (NOT RiskLevel); see Task 5 decision |

## Threat Flags

None — every threat in the plan's `<threat_model>` (T-02-01 through T-02-06 + T-02-SC) is now mitigated. No new threat surface introduced; the JWT-derived `storeId` strictly reduces attack surface relative to the prior body-trusting endpoint.

## Self-Check: PASSED

**Created files exist:**
- `apps/backend/src/infra/queue/queue.module.spec.ts` — FOUND
- `.planning/phases/02-reading-index-engine-core-book-logic/02-01-SUMMARY.md` — FOUND (this file)

**Commits exist:**
- `bdb5c43` (Task 2 deps + queue) — FOUND
- `5cd67d5` (Task 3 FRAUD-01/02 + BOOK-03 + RI-02) — FOUND
- `e677860` (Task 4 FRAUD-04 + decorator fix) — FOUND
- `ae510c6` (Task 5 FRAUD-06 rename) — FOUND

**Backend test count delta:** 680 → 699 (+19 net, all green; target was ≥ 686 / +6, exceeded).
