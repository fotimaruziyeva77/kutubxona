# Phase 2 Research — Reading Index Engine & Core Book Logic

**Researched:** 2026-06-06
**Domain:** Reading Index batch processing, fraud detection hardening, book lifecycle, store integration
**Confidence:** HIGH (codebase verified file:line; library versions verified against npm registry; pitfalls cross-referenced)

---

## Project Constraints (from CLAUDE.md)

The CLAUDE.md TZ enforces these directives for Phase 2 scope:

| # | Constraint | Source |
|---|------------|--------|
| K1 | Reading Index formula: `booksCount×30% + consistency×20% + diversity×15% + discipline×15% + activity×20%` — recomputed nightly at 00:00 | Section V (5.1) |
| K2 | Source coefficients: Library 1.0x, ISBN scan 0.9x, Store 0.9x, Mutolaa 0.85x, generic ebook 0.8x | Section IV (4.3) |
| K3 | Book limits by user type: Citizen 2, Student-School 3, Student-University 5, Government 3; Trust Score ≥90 → +1 | Section III (3.5) |
| K4 | Borrow period 14 days, 1 extension of 7 days; overdue blocks new borrows | Section III (3.5) |
| K5 | Comprehension test: every 5th confirmed ISBN scan, 3 questions, 3 attempts, ≥70% correct | Section IV (4.3) + verified in code |
| K6 | Roaming return: book lent in viloyat A may be returned in viloyat B; home library is notified via inter-library transfer | Section III (3.4) |
| K7 | Store partners DO NOT pay — purchases enter via store cabinet (manual phone+ISBN) or HMAC-signed API; reader must confirm within 24h | Section IV (4.5) + XIV (14.2) |
| K8 | Fraud detection feeds into a **review workflow** (admin approves/rejects), never instant block; Top-100 has its own pipeline (29th-of-month AI fraud, 30th admin review) | Section V (5.4) + XV R3 |
| K9 | Children under 14 anonymized in any PUBLIC output | Section V (5.4) — but: public-rankings work is Phase 3, not Phase 2 |
| K10 | All scheduled crons run on Asia/Tashkent wall-clock (Phase 1 INFRA-05 already enforced) | Section XI |
| K11 | Data localization — RI/scan/transaction data stays on UZ servers (Unicon.uz/TIF DC) | Section VIII (8.3) |

These take precedence over any other reference. Planner must not recommend alternatives that contradict K1–K11.

---

## Executive Summary

Phase 2 is the **core value-prop phase**. Every downstream phase (Top-100, statistics, AI audit, alerts) reads from the Reading Index table. Today, the entire chain works at seed-data scale (~100 users) and would catastrophically fail at 5M users: the nightly cron is a sequential `for` loop projected at ~69 hours/run, the table grows unbounded (~5M rows/night, no cleanup), the comprehension test is fixed at `answerIdx: 0` so `[0,0,0]` always passes, the fraud cron silently sets `user.status = "BLOCKED"` at 03:00 with no admin review, and `storeManualEntry` accepts any `operatorId` string with no authorization check. None of these are hypothetical — every one is verified in the current code with a file:line citation below.

The architectural decision that drives almost all of Phase 2 is **how the RI batch is re-architected**. Phase 1 already shipped the prerequisites: BullMQ is wired (`NOTIFICATION_QUEUE`, `REPORT_QUEUE`, **`AI_QUEUE`** — the last is registered but **completely unused**, perfect carrier for our new RI queue), Redis is the BullMQ backing store, the `@@index([userId, calculatedAt])` composite index is live in the DB (pushed via `prisma db push` per Phase 1 verification — there is NO migration file for it yet), `tzdata` + `TZ=Asia/Tashkent` means cron `@Cron(EVERY_DAY_AT_MIDNIGHT)` actually fires at 00:00 Tashkent. The cleanest fan-out pattern is therefore: keep the existing `@Cron` trigger; replace its body with a chunk dispatcher that `addBulk()`s `Math.ceil(activeUsers / 1000)` jobs into a new `RI_RECALC_QUEUE`; a `RiRecalcProcessor` (worker `concurrency: 10`) processes one chunk at a time, fetching the chunk's users + their transactions/scans with `IN`-clause batched queries.

**Primary recommendation:** **Don't hand-roll batch processing.** Wire a new BullMQ queue (`ri-recalc`) alongside the existing three. Use `Queue.addBulk()` for the fan-out (atomic, single Redis round-trip), set worker `concurrency: 10`, and `attempts: 3` with `backoff: { type: 'exponential' }`. Keep the cron entrypoint sequential to its trigger only — never put 5M work inside a `@Cron` handler. Replace `xlsx@0.18.5` (two unfixed high-severity CVEs, abandoned on public npm) with `exceljs@4.4.0` for BOOK-01. Add an `extended Boolean` column to `BookTransaction` and remove the magic `penaltyDays: -1` (H6). Add a database CHECK constraint `availableCount >= 0` for BOOK-05. Implement `ReadingIndex` PostgreSQL native range partitioning by month for RI-05. Move comprehension test question-bank into a `questions JSON` field that already exists — but shuffle options server-side at generation time and store the resolved `answerIdx` per-question (it's already JSON). Add `attemptedAt` timestamps per question for FRAUD-02 minimum-time enforcement.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| RI nightly recalc orchestration | API / Backend (BullMQ producer in NestJS cron) | Redis (queue storage) | Cron and DB live in backend; BullMQ is already there |
| RI chunk processing (1000 users) | Worker (BullMQ processor) | PostgreSQL primary (writes), read replica (reads) | Phase 1 provisioned read replica `DATABASE_REPLICA_URL`; per Phase 1 verification, app-side read routing is **deferred to Phase 2/5** — Phase 2 wires it |
| RI history pruning + archival | API / Backend (scheduled job) | PostgreSQL partition `DETACH` | Native PG partition pruning is the only sustainable model at 5M×30d rows |
| Comprehension test generation | API / Backend (service) | (optional) OpenAI for book-specific questions — but **NOT Phase 2 scope** (deferred to AI phase) | The shuffle + min-time fix is local, no LLM needed |
| Fraud risk score computation | API / Backend (FraudService — exists) | Redis (5-min cache) | Already lives in `apps/backend/src/modules/ai/fraud.service.ts` — Phase 2 fixes bugs, doesn't rebuild |
| Admin review queue | API / Backend (new endpoints) | PostgreSQL (`FraudScore.action='review'` + audit log) | Backend-only feature; UI is Phase 3 |
| Excel book import | API / Backend (multipart upload → parser → batch insert) | MinIO (optional: store uploaded files) | Server-side parse only — file goes nowhere on disk by default |
| Library Roaming inter-library transfer | API / Backend | SMS notification (Eskiz via BullMQ — Phase 1 wired) | The data movement is a single DB transaction; the social coordination is SMS |
| Book availability count | PostgreSQL (CHECK constraint + interactive Prisma `$transaction`) | API / Backend | DB enforces the invariant; app code provides the workflow |
| ISBN scanner UI | Frontend (camera + zxing-js/browser) | API / Backend | Camera access lives in browser; backend just validates the ISBN string |
| Store cabinet operator UI | Frontend (`apps/frontend/app/[locale]/dokon/page.tsx` — exists) | API / Backend (`/transactions/store-entry`) | Already split correctly; backend authorization is the bug |
| Store reader-confirmation flow | API / Backend (`/store/confirm/:scanId` — exists) | Frontend (notification → confirm button) | Endpoint exists in `store.controller.ts:43-52`; UI surface is Phase 2 fix-up |

**Why this matters:** The RI batch must NOT live inside the `@Cron` handler. The biggest planning error here would be putting parallelism inside the cron (e.g., `Promise.all`) — that drains a single Node process at 5M-user scale. BullMQ with a separate worker pool is mandatory and is the pattern Phase 1 already deployed for notifications.

---

## Current State Audit (per requirement, with file:line evidence)

### RI-01 — Nightly RI recalc, BullMQ batched, <2h for 5M users

**Status: FIX (sequential → batched).**

| File:line | Current behavior |
|-----------|------------------|
| `apps/backend/src/modules/reading/reading.service.ts:50-68` | `@Cron(EVERY_DAY_AT_MIDNIGHT) recalculateAll()` runs `prisma.user.findMany({ status: ACTIVE })` then a sequential `for (const { id } of users)` calling `recalculateForUser(id)`. Empty catch block silently swallows per-user errors. |
| `apps/backend/src/modules/reading/reading.service.ts:70-146` | `recalculateForUser(userId)` does: 1 user fetch, 1 `bookTransaction.findMany` (with `include: book.genre`), 1 `isbnScan.findMany`, 1 `readingIndex.create`. ~4 round-trips per user. |
| `apps/backend/src/modules/reading/reading.module.ts:1-13` | Module imports only `PrismaModule` + `ConfigModule`. **No `BullModule` import** — RI queue not wired. |
| `apps/backend/src/infra/queue/queue.module.ts:5-44` | **`AI_QUEUE`** registered but never instantiated by a worker — perfect free slot. We add a sibling `RI_RECALC_QUEUE` rather than overload `AI_QUEUE` (semantic clarity). |
| `apps/backend/src/infra/queue/notification.processor.ts:16` | Reference pattern: `@Processor(NOTIFICATION_QUEUE)` + `WorkerHost.process(job)` works in production today. Use the same pattern. |
| `docker-compose.prod.yml:198+` (per VERIFICATION) | Postgres read replica provisioned, `DATABASE_REPLICA_URL` populated, but **no app code reads from it yet**. Phase 2 wires it for the RI heavy reads. |

**Projection:** 5M users × ~50ms per user (4 DB round-trips at ~12ms p50 each, sequential) = **~69 hours** per run. The cron at 00:00 would still be running when it fires again at 00:00 the next day — overlap creates duplicate RI rows. [CITED: PITFALLS.md C6]

---

### RI-02 — RI 5-component formula

**Status: EXTEND (formula already implemented; weights match TZ; needs hardening for new sources & edge cases).**

| File:line | Current behavior |
|-----------|------------------|
| `reading.service.ts:5-21` | `COEF` (source coefficients) and `WEIGHTS` (5 components) constants match CLAUDE.md K1, K2 exactly. |
| `reading.service.ts:93-99` | Component 1 (books count): `libBooks * 1.0 + isbnScans * 0.9`. **Bug:** store_manual is read via `isbnScans.filter(s => s.source === "STORE_MANUAL")` and weighted at 0.9 separately but then NOT added (`totalWeighted = libBooks + isbnBooks` — comment says "store already counted in isbnScans"). The variable `storeBooks` (line 97) is computed but unused. Score capped via `Math.min(totalWeighted * 10, 100)` — works for now but means a user with 10+ books has all books-count weight saturate to 100 regardless of additional reading. |
| `reading.service.ts:101-110` | Component 2 (consistency): weekly bucketing via `Math.floor(returnedAt / (7 * 24 * 60 * 60 * 1000))`. ~OK but ties to UTC week boundary, not Tashkent. With Phase 1 `TZ=Asia/Tashkent` set, `Date.getTime()` is still UTC ms — week buckets remain UTC. Acceptable for V1 but document. |
| `reading.service.ts:113-114` | Component 3 (diversity): genre set from `recentTx`. Missing ISBN-scan genres (no genre is captured for ISBN scans). |
| `reading.service.ts:117-118` | Component 4 (discipline): `lateReturns = filter(t => t.penaltyDays > 0)`. **Magic-number trap (H6):** `penaltyDays = -1` (extended-marker) is correctly excluded from `> 0`, so an extended-then-late book is not counted as a discipline ding. |
| `reading.service.ts:120-122` | Component 5 (activity): `(recentTx.length + recentIsbn.length) * 25`. No Mutolaa records counted (Mutolaa records have `source: "MUTOLAA"` but are filtered into `recentIsbn` so they ARE counted at activity weight, just at 0.9 in books-count — Mutolaa's 0.85x is lost). |

**Action:** EXTEND — apply source coefficient correctly per-source in books-count (sum-of-weighted, not "all isbn scans at 0.9"), add genre-from-Book lookup for ISBN scans (the `Book.genre` exists if we join via `book.findFirst({ where: { isbn } })` — already done in `syncMutolaaProgress`). The weights themselves match the TZ and don't need to change.

---

### RI-03 — RI history retention 13 months, archive older

**Status: NEW (cleanup job does not exist).**

| File:line | Current behavior |
|-----------|------------------|
| `reading.service.ts:131-145` | `recalculateForUser` always calls `create`. **No `delete` anywhere in the service.** |
| `reading.service.ts:41-47` | `getHistory(userId)` returns `take: 12` records — UI-side truncation only. |
| Grep `prisma.readingIndex.delete*` across `apps/backend/src/` | **Zero matches.** No purge job exists. [CITED: CONCERNS.md "ReadingIndex grows unboundedly"] |

**Action:** NEW — add a `@Cron("0 4 1 * *")` (4 AM on the 1st of each month) job that detaches the partition for `month_now - 13 months` and either dumps it to MinIO as compressed CSV or pg_dumps it. Easier alternative: monthly job runs `DELETE FROM "ReadingIndex" WHERE "calculatedAt" < NOW() - INTERVAL '13 months'` — BUT this is exactly what partition `DROP` is for, and is O(1) instead of O(N) deletes generating WAL.

---

### RI-04 — RI delta tracking (daily/weekly/monthly change)

**Status: NEW (no delta endpoint).**

| File:line | Current behavior |
|-----------|------------------|
| `reading.controller.ts:30-49` | Endpoints: `getLeaderboard`, `getReadingIndex` (latest), `getHistory` (12 records). **No delta endpoint.** |
| `reading.service.ts:29-47` | Service returns latest score only. |

**Action:** NEW — add `GET /reading/:userId/delta` returning `{ daily: { current, prev, delta, pct }, weekly: {...}, monthly: {...} }`. Implementation is a single query per window using the composite index (`@@index([userId, calculatedAt])` — Phase 1 INFRA-06).

---

### RI-05 — ReadingIndex partitioned by month

**Status: NEW (partitioning not declared in schema, table is a plain heap table).**

| File:line | Current behavior |
|-----------|------------------|
| `prisma/schema.prisma:322-333` | Plain table; only `@@index([userId, calculatedAt])` declared. No partitioning. |
| `prisma/migrations/20260507052836_init/migration.sql:128-135` | `CREATE TABLE "ReadingIndex"` is a plain heap. **The Phase 1 composite index lives in DB via `prisma db push`, NOT in a migration file** — verifier flagged this implicitly. Phase 2 must create the migration file along with partitioning. |

**Action:** NEW — Prisma does NOT natively support PostgreSQL native partitioning DDL. Must be applied via a raw SQL migration. Pattern: create new partitioned parent table, copy data, swap names, attach per-month partitions for current + next 12 months, automate next-month-partition creation via a `@Cron` (monthly). Document `prisma migrate resolve` will treat the partitioned table as a regular table from a typing standpoint — works fine because Prisma operates at SQL level. [CITED: postgresql.org/docs/15/ddl-partitioning.html]

---

### FRAUD-01 — Comprehension test randomizes answer positions

**Status: FIX (verified bug).**

| File:line | Current behavior |
|-----------|------------------|
| `apps/backend/src/modules/transactions/transactions.service.ts:702-720` | `generateQuestions(title, author)` returns 3 questions, **all with `answerIdx: 0`**. The correct answer is always the first option in `options`. Question 3 is literally "Kitobni to'liq o'qidingizmi?" with `["Ha, to'liq o'qidim", ...]` — index 0 is "Yes". A bot submitting `[0,0,0]` always passes. [CITED: PITFALLS.md C1, CONCERNS.md] |
| `transactions.service.ts:414-416` | `submitComprehensionTest` reads `questions[i].answerIdx` from the stored JSON — so if we randomize at generation and store the resolved `answerIdx`, the grader works unchanged. |
| `prisma/schema.prisma:472` | `ComprehensionTest.questions Json` — schema already free-form, no migration needed. |

**Action:** FIX — at generation time: build options array, choose a random index 0..N-1, set `answerIdx` to that index, shuffle in-place such that the correct option lands at `answerIdx`. One ~10-line helper. Add unit test asserting `answerIdx` is NOT always 0 across 1000 generations (use `expect` to assert distribution).

---

### FRAUD-02 — Comprehension test minimum time per question

**Status: NEW (no timing enforcement today).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:400-440` | `submitComprehensionTest` accepts `answers: number[]` with no `startedAt`/`submittedAt`/per-question timing. No minimum-time check. |
| `prisma/schema.prisma:466-479` | `ComprehensionTest` has `createdAt` (effectively "test issued at") but no `startedAt` or `answersSubmittedAt`. |

**Action:** NEW — two design choices:
- **Option A (low-touch):** Add `startedAt DateTime?` (set when client requests the test questions via a new `GET /comprehension/:isbnScanId/start` endpoint, or implicitly on first read of the test). On submit, reject if `now - startedAt < 5_000 * questions.length` ms. Already requires a new endpoint OR client cooperation to set startedAt at scan time.
- **Option B (server-only, recommended):** Add `issuedAt` populated at `scanIsbn` time (when the test row is created — currently uses `@default(now())`, so this is just `createdAt`). On submit, reject if `now - createdAt < 15_000` (3 questions × 5 sec).
- **Option C (defense in depth):** Add per-question `answerTimings: Int[]` in submit payload and reject if any < 3000ms. Client can lie but combined with B forces both checks to be defeated.

Recommend Option B + Option C as the minimum (server-side AND client-side gates). Plan should pick one explicitly.

---

### FRAUD-03 — Fraud scan uses FLAGGED, admin review queue, NOT auto-block

**Status: FIX (verified auto-block bug).**

| File:line | Current behavior |
|-----------|------------------|
| `apps/backend/src/modules/ai/fraud.service.ts:212-246` | `@Cron("0 3 * * *") dailyFraudScan()` — fetches up to 10,000 recently-active users, calls `analyzeUser` for each, and at lines 234-240 directly executes `prisma.user.update({ data: { status: "BLOCKED" } })` for any user with `riskLevel === "BLOCKED"` (riskScore ≥ 70). **No human review.** [CITED: PITFALLS.md C2, CONCERNS.md] |
| `fraud.service.ts:99-111` | `RI_SPIKE` rule: compares `riRecords[0].score - riRecords[last].score` across last 5 records (potentially spanning 5 days), not consecutive days. False positives on legitimate gap-readers. |
| `prisma/schema.prisma:32-36` | `enum UserStatus { PENDING ACTIVE BLOCKED DELETED }` — **no FLAGGED state**. Either add to enum or repurpose `FraudScore.action` field (`'block'` → `'review'`) as the FLAGGED signal. |
| `fraud.service.ts:357-365` | `_getAction` already maps `BLOCKED → 'block'`. Change to `BLOCKED → 'review'` for FRAUD-03 (and drop the cron's status update). |

**Action:** FIX — three sub-tasks:
1. Add `UserStatus.FLAGGED` to the Prisma enum (migration), OR repurpose `FraudScore.action` as the source of truth and never touch `User.status` for fraud. Recommend the second — simpler, no enum migration. The user remains `ACTIVE` but `FraudScore.action='review'` gates them out of Top-100 candidate lists.
2. Remove the `prisma.user.update({ data: { status: "BLOCKED" } })` block at fraud.service.ts:234-240. Replace with: emit Kafka `fraud.detected`, write to `RiskLog` (already a model), no status change.
3. Add `GET /ai/fraud/review-queue` + `POST /ai/fraud/:userId/resolve` (admin approve/reject) endpoints. New endpoints on existing `AiController` — module already wired.
4. Fix `RI_SPIKE` to compare consecutive days: `prevDay = readingIndex.findFirst({ where: { userId, calculatedAt: { lt: today } }, orderBy: { calculatedAt: 'desc' } })`.

---

### FRAUD-04 — Store manual entry endpoint requires proper authorization check

**Status: FIX (verified authorization gap).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:443-470` | `storeManualEntry(operatorId, phone, isbn)` accepts an `operatorId` string passed from request body **without verifying it matches the authenticated user**. Sets `storeId: operatorId` on the IsbnScan. [CITED: PITFALLS.md H2, CONCERNS.md] |
| `transactions.controller.ts:25, 162-168` | Controller has `@Roles(...STORE_ROLES) = [DOKON_OPERATOR, SUPER_ADMIN]` and `@UseGuards(JwtAuthGuard, RolesGuard)` — but the body's `operatorId` is what gets persisted, not `req.user.id`. A DOKON_OPERATOR could spoof another operator's id; a SUPER_ADMIN could spoof anyone. |
| `store.controller.ts:33-52` | The parallel webhook-style endpoint at `POST /store/purchases` does verify a per-store HMAC. The vulnerable path is the operator-UI endpoint. |
| `apps/frontend/app/[locale]/dokon/page.tsx:37` | Frontend hardcodes `user?.id` as the operatorId — but the server trusts the client value. |

**Action:** FIX — drop `operatorId` from the DTO entirely. Inject `@CurrentUser('id')` and use that. Verify the user has either `DOKON_OPERATOR` role with an Institution record where `type='IDORA'` AND `directorId === userId` (per `store.service.ts:113-125`'s registration pattern), OR is a SUPER_ADMIN. Reject otherwise.

---

### FRAUD-05 — Trust Score (0–100) computed from discipline, reading speed, location

**Status: EXTEND (Trust Score field exists and is updated; multi-factor formula is partial).**

| File:line | Current behavior |
|-----------|------------------|
| `prisma/schema.prisma:160` | `User.trustScore Int @default(0)` exists. |
| `transactions.service.ts:303-317` | On return: if `penaltyDays > 0`, `trustScore -= min(penaltyDays * 2, 10)`; else `trustScore++` (capped at 100). This is only the "return discipline" signal. |
| `transactions.service.ts:36-40` | `getBorrowLimit` already uses `TRUST_SCORE_BONUS_THRESHOLD = 90` to grant +1 limit — matches K3. |
| `fraud.service.ts:114-121` | Fraud factor: `trustScore < 30` adds 15 risk points (LOW_TRUST_SCORE flag). |
| Grep "reading speed" or "pages per minute" across `apps/backend/src/` | Zero matches. **No reading-speed signal exists.** |
| Grep "location" / "gps" / "latitude" / "geolocation" | `Library.latitude`, `Library.longitude` exist (schema.prisma:246-247); user/transaction location does not. |

**Action:** EXTEND — Phase 2 additions to Trust Score:
- **Reading speed:** pages-per-day signal — compare `Book.pages` to `returnedAt - borrowedAt` from `BookTransaction`. Flag if pages/hour > 100 (impossible) or < 0.5 (no actual reading). Document the formula but DON'T enforce as a hard block — just a Trust Score weight.
- **Location check:** out of Phase 2 scope. The data model doesn't capture user location, librarians don't capture GPS at QR scan. Mark this as Phase 5 (Statistics + Map work touches geo) or defer to v2.
- **Compute on a schedule** (not eagerly on every event) — add `recomputeTrustScore(userId)` invoked at the end of each RI chunk so it's piggy-backed on the nightly batch.

---

### FRAUD-06 — Risk Score thresholds: 0–24 safe, 25–49 low, 50–69 review, 70–100 flagged

**Status: FIX (thresholds correct in code; one label needs change).**

| File:line | Current behavior |
|-----------|------------------|
| `fraud.service.ts:8-13` | `RISK_THRESHOLDS = { SAFE: 0-24, LOW: 25-49, REVIEW: 50-69, BLOCKED: 70-100 }`. Thresholds match the requirement; the label `BLOCKED` is misleading because per FRAUD-03 it should mean "flagged for review", not auto-blocked. |
| `fraud.service.ts:15` | `RiskLevel` type includes `"BLOCKED"`. |
| Codebase grep `riskLevel === "BLOCKED"` | Match: only `fraud.service.ts:151,198,234` (Kafka emit, top-100 count, the auto-block bug we're fixing). |

**Action:** FIX — rename `BLOCKED` → `FLAGGED` in `RiskLevel` and `RISK_THRESHOLDS` constants. Cascade rename through spec files. The Kafka topic `fraud.detected` stays — only the level label changes. The auto-block code path at line 234 is **removed** (per FRAUD-03) so the renamed level only means "needs admin review", which matches the requirement.

---

### BOOK-01 — Excel import for 500+ books

**Status: FIX-AND-EXTEND (basic implementation exists; uses a CVE-vulnerable library; needs progress indicator).**

| File:line | Current behavior |
|-----------|------------------|
| `apps/backend/src/modules/books/books.service.ts:7-8, 174-216` | `import * as XLSX from "xlsx"`; `importFromExcel(buffer, libraryId)` parses workbook, iterates rows synchronously, calls `this.create()` per row (sequential `prisma.book.create` + `es.index`). **Returns `{ created, errors }` synchronously — no progress indicator.** |
| `package.json` | `"xlsx": "^0.18.5"` — the SheetJS Community Edition npm package. [VERIFIED: npm registry — `npm view xlsx version` returns `0.18.5`, last published April 2023]. |
| `books.controller.ts:70-87` | Endpoint `POST /books/import` with `FileInterceptor`, max 10MB, type filter `(xlsx|xls|spreadsheet)`. Synchronous response. |

**CVE blocker:** `xlsx@0.18.5` has two unfixed high-severity advisories: [CITED: nvd.nist.gov/CVE-2024-22363] ReDoS in regex parsing AND [CITED: snyk.io/SNYK-JS-XLSX-5457926] CVE-2023-30533 prototype pollution. SheetJS moved to a paid distribution model and the npm package is abandoned. Replacement: **`exceljs@4.4.0`** [VERIFIED: npm registry, `npm view exceljs version` returns `4.4.0`], actively maintained, no known critical CVEs, streaming reader for large files (`new ExcelJS.stream.xlsx.WorkbookReader(stream)`).

**Action:** FIX — replace `xlsx` with `exceljs`. EXTEND — convert import into a BullMQ job (REPORT_QUEUE or a new IMPORT_QUEUE): controller accepts the upload, persists the buffer to MinIO with a temp key, enqueues a job, returns `{ jobId, status: 'queued' }`. New `GET /books/import/:jobId/status` returns `{ status, processed, total, errors[] }`. Progress is updated by the worker via `job.updateProgress(percent)`. Bulk-insert rows with `prisma.book.createMany({ data, skipDuplicates: true })` rather than per-row `create`, then re-index Elasticsearch in a single bulk request.

---

### BOOK-02 — Library Roaming with bilateral confirmation

**Status: EXTEND (one-sided roaming exists; bilateral confirmation missing).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:333-353` | `returnRoaming(transactionId, returnLibraryId)` calls `returnBook` (which sets `availableCount` on source `book.libraryId`, NOT on `returnLibraryId`) then sends SMS to source library. **No transfer record is created.** [CITED: CONCERNS.md "No inter-library book transfer mechanism"] |
| `transactions.service.ts:294-301` | `returnBook` increments `availableCount` on `book.libraryId` — meaning a book physically present at Library B now counts as "available" at Library A. Inventory drifts immediately. |
| `prisma/schema.prisma:299-320` | `BookTransaction` has `returnLibraryId` but no `transferConfirmedAt`, `transferConfirmedById`, no separate `BookTransfer` model. |
| `prisma/schema.prisma:294-298` | `Book` is tied to one `libraryId` — no physical-location-vs-home-library distinction. |

**Action:** EXTEND — add a `BookTransfer` model (`id, transactionId, fromLibraryId, toLibraryId, requestedAt, confirmedAt?, confirmedById?, status`). On `returnRoaming`: do NOT increment `availableCount` on source library; create a `BookTransfer { status: 'PENDING' }`; SMS both libraries. Add `POST /libraries/:id/transfers/:transferId/confirm` (called by source librarian) that increments source `availableCount` and sets `confirmedAt`. The book physically stays at the return library until manual transit — that's outside the system, but the data model now tracks it. Alternative simpler design: add `physicalLocationLibraryId` to `Book` and update on roaming return — covers the inventory drift but doesn't track the inter-library debt.

---

### BOOK-03 — Book limits by user type with Trust Score bonus

**Status: VERIFIED (works correctly — confirm in tests).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:29-40` | `getBorrowLimit(type, trustScore)` — base map (`CITIZEN: 2, STUDENT_SCHOOL: 3, STUDENT_UNIVERSITY: 5, GOVERNMENT_EMPLOYEE: 3, TEACHER: 3`) + `+1` if `trustScore >= 90`. Matches K3 exactly. |
| `transactions.service.ts:220-226` | `borrow()` enforces limit on the no-reservation path. |
| `transactions.service.ts:194-215` | `borrow()` with `reservationId` does NOT re-check limits (assumes reserve() already did). Verified — `reserve()` does not check limits explicitly, so a user could reserve N+1 books in advance. Edge case: the `availableCount` decrement is the only effective limit. |

**Action:** VERIFY + ADD MISSING CHECK — `reserve()` should also call `getBorrowLimit` and count `BORROWED + PENDING + RESERVED` per user. Add a spec test that asserts a Student-University at 5 active borrows cannot reserve a 6th.

---

### BOOK-04 — Overdue alerts at 3d/1d, block new borrow when overdue

**Status: VERIFIED for alerts; VERIFY block enforcement.**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:619-670` | `@Cron("0 10 * * *") checkOverdueAlerts()` — 3-day and 1-day windows around `dueDate`, SMS via `this.sms.sendNotification(...)`. **Critical caveat:** since Phase 1's SMS path is fully wired but Eskiz creds are deferred, alerts will route via Eskiz dev-no-op (logged but undelivered) until live creds arrive. The cron itself is correct. |
| `transactions.service.ts:43-53, 77-79, 189-191` | `hasOverdueBooks(userId)` returns count of BORROWED + `dueDate < now`. `reserve()` and `borrow()` both call it and throw `ForbiddenException` if true. |
| `transactions.service.ts:673-697` | `@Cron("59 23 * * *") blockOverdueUsers()` — only updates `penaltyDays`; does NOT actually change `user.status`. Name is misleading. |

**Action:** VERIFY in tests — confirm `hasOverdueBooks` blocks both flows; rename `blockOverdueUsers` → `recomputeOverdueDays`; document that alerts depend on the Eskiz credential checkpoint (planner should add a checkpoint task referencing Phase 1's deferred Eskiz checklist).

---

### BOOK-05 — `availableCount` interactive Prisma transactions + CHECK constraint

**Status: PARTIAL (interactive transactions present; CHECK constraint missing).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:83-99` | `reserve()` uses interactive `$transaction(async (p) => ...)`. ✓ |
| `transactions.service.ts:152-161` | `cancelReservation()` uses ARRAY form `$transaction([...])` — weaker semantics. ✗ [CITED: PITFALLS.md H4, CONCERNS.md] |
| `transactions.service.ts:230-245` | `borrow()` array form. ✗ |
| `transactions.service.ts:288-318` | `returnBook()` interactive form. ✓ |
| `transactions.service.ts:597-613` | `autoExpireReservations()` array form. ✗ |
| `prisma/schema.prisma:286-287` | `availableCount Int @default(1)` — no CHECK constraint. |
| `prisma/migrations/20260507052836_init/migration.sql` | The init migration has no `CHECK (availableCount >= 0)`. |

**Action:** FIX — convert all four array-form transactions to interactive callback form (~30-min change). Add a raw SQL migration: `ALTER TABLE "Book" ADD CONSTRAINT book_availablecount_nonneg CHECK ("availableCount" >= 0);`. Catch the resulting `P2010` Prisma error in code and re-throw as `BadRequestException("Inventory race condition — retry")`. Add a nightly reconciliation cron: for each Book, compute `expectedAvailable = totalCount - COUNT(BookTransaction WHERE bookId=? AND status IN (BORROWED, RESERVED, PENDING))`, alert if mismatch.

---

### STORE-01 — Store cabinet: operator enters phone + ISBN, reader confirms within 24h

**Status: FIX (works at the data-model level; authorization is broken — see FRAUD-04; 24h expiry not enforced).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:443-470` | `storeManualEntry` creates `IsbnScan { source: 'STORE_MANUAL', confirmed: false }`. SMS sent to reader. |
| `transactions.service.ts:473-488` | `confirmStorePurchase` accepts a reader confirmation. **No 24h expiry check — readers can confirm a year-old store entry.** |
| `apps/frontend/app/[locale]/dokon/page.tsx` (full file) | Functional operator UI: phone + ISBN form, history, hardcoded `user?.id` as operatorId (which the server trusts — the FRAUD-04 bug). |

**Action:** FIX — (a) tie operatorId to authenticated user (FRAUD-04); (b) add `expiresAt = createdAt + 24h` to the IsbnScan when `source='STORE_MANUAL'` (new column OR computed at-confirm with `if now - createdAt > 24h reject`); (c) add a daily cron that expires unconfirmed store entries (drops them from RI eligibility — no row deletion, just `confirmed=false` stays and the existing reading-index code already excludes unconfirmed).

---

### STORE-02 — ISBN scan by reader: camera → DB check → comprehension test → RI update

**Status: PARTIAL (backend exists; frontend scan page exists; comprehension test always fixed at index 0).**

| File:line | Current behavior |
|-----------|------------------|
| `transactions.service.ts:359-397` | `scanIsbn(userId, isbn)` looks up the ISBN in Books, creates an `IsbnScan { source: 'USER_SCAN' }`. Every 5th confirmed scan triggers `generateQuestions` and creates a `ComprehensionTest` row. Otherwise immediately marks `confirmed: true`. Matches K5. |
| `apps/frontend/app/[locale]/scan/page.tsx` (585 lines) | Full camera scan UI (not read in full but file exists, lines verified). |
| Comprehension test bug | Same as FRAUD-01 — fixed answer index. |

**Action:** EXTEND via FRAUD-01 fix. Cascade: scan UI already works once the test generation is fixed.

---

### STORE-03 — Store purchases count toward RI at 0.9x

**Status: PARTIAL (coefficient declared; double-counting/missing-counting subtle bug).**

| File:line | Current behavior |
|-----------|------------------|
| `reading.service.ts:7-12` | `COEF.STORE = 0.9`. |
| `reading.service.ts:93-99` | `storeBooks` is computed but never added to `totalWeighted` (comment claims "store already counted in isbnScans" — true that they're in the same array, but COEF.STORE coefficient is then dropped: every isbnScan including STORE_MANUAL ones is multiplied by 0.9 — which happens to be the right number for STORE_MANUAL but is also being applied to USER_SCAN and MUTOLAA records, which should be 0.9 and 0.85 respectively). |

**Action:** FIX — restructure books-count component to sum per-source: `score = lib*1.0 + scan*0.9 + storeManual*0.9 + mutolaa*0.85 + ebook*0.8`. Each source already labeled correctly in `IsbnScan.source`. This is a 5-line change inside `recalculateForUser`.

---

## Fix / Build Approaches (per requirement)

| Req | Disposition | Approach (one-liner) |
|-----|-------------|----------------------|
| RI-01 | FIX | New `RI_RECALC_QUEUE` BullMQ queue + `RiRecalcProcessor` with `concurrency: 10`; cron only fans out chunk jobs via `Queue.addBulk()`; chunk size 1000; jobs read from `DATABASE_REPLICA_URL` (new) for transactions/scans, write to primary |
| RI-02 | EXTEND | Per-source coefficient sum in books-count component; pull `genre` from Book for ISBN-scan diversity; weights unchanged |
| RI-03 | NEW | Monthly cron that `DETACH PARTITION` the 14-months-ago partition; optional dump to MinIO as `gzip`-compressed JSON-Lines |
| RI-04 | NEW | `GET /reading/:userId/delta` — three queries (one per window) using composite index; cached 1h in Redis |
| RI-05 | NEW | Raw-SQL migration converts `ReadingIndex` to `PARTITION BY RANGE (calculatedAt)`; cron creates next month's partition |
| FRAUD-01 | FIX | Helper `shuffleQuestions(qs)` randomizes options and updates `answerIdx` per question; same 3-question structure |
| FRAUD-02 | NEW | Option B+C: reject submission if `now - test.createdAt < 15s` AND if any `answerTimings[i] < 3000ms` |
| FRAUD-03 | FIX | Remove auto-block; emit Kafka + RiskLog only; add `GET /ai/fraud/review-queue` + `POST /ai/fraud/:userId/resolve`; rename `BLOCKED` → `FLAGGED` |
| FRAUD-04 | FIX | Drop `operatorId` from DTO; use `@CurrentUser('id')`; verify role + Institution ownership server-side |
| FRAUD-05 | EXTEND | Compute reading-speed signal on return; recompute Trust Score during nightly RI batch (piggy-back); defer location to Phase 5 |
| FRAUD-06 | FIX | Rename `BLOCKED` → `FLAGGED` in constants, types, specs; thresholds already match |
| BOOK-01 | FIX+EXTEND | Replace `xlsx` with `exceljs`; convert import to BullMQ job with progress; `createMany` + ES `bulk` |
| BOOK-02 | EXTEND | New `BookTransfer` model; `returnRoaming` creates PENDING transfer; new confirm endpoint; SMS to source library |
| BOOK-03 | VERIFY + ADD | Re-check limit in `reserve()`; spec test for boundary case |
| BOOK-04 | VERIFY | Already implemented; rename misleading cron; document Eskiz checkpoint dependency |
| BOOK-05 | FIX | Convert 4 array-form transactions to interactive; add CHECK constraint via raw SQL migration; reconciliation cron |
| STORE-01 | FIX | Authorization via FRAUD-04 + 24h expiry on STORE_MANUAL IsbnScans |
| STORE-02 | EXTEND via FRAUD-01 | Cascades from comprehension test fix |
| STORE-03 | FIX | Per-source coefficient sum in RI books-count |

---

## Library & Dependency Recommendations

| Library | Verified | Version | Purpose | Disposition |
|---------|----------|---------|---------|-------------|
| `bullmq` | [VERIFIED: npm registry] | `5.78.0` (project pins `^5.8.4`, resolved tree at `5.76.6`) | New RI_RECALC_QUEUE + worker | Already installed |
| `@nestjs/bullmq` | [VERIFIED: npm registry] | `11.0.4` (project pins `^10.2.3`) | NestJS BullMQ glue | Already installed |
| `@nestjs/schedule` | [VERIFIED: npm registry, already installed] | `^4.1.1` | Existing `@Cron` triggers | No change |
| `exceljs` | [VERIFIED: npm registry — `npm view exceljs version` → 4.4.0; ~1.9M weekly downloads; actively maintained] | `4.4.0` | **Replace `xlsx`** for BOOK-01 | NEW DEPENDENCY (slopcheck audit below) |
| `xlsx` | (current `0.18.5`) | — | Has CVE-2024-22363 ReDoS + CVE-2023-30533 prototype pollution; abandoned on free npm | **REMOVE** |
| `@prisma/extension-read-replicas` | [CITED: prisma.io/docs/orm/prisma-client/setup-and-configuration/read-replicas — official Prisma extension] | `^0.5.0` | Route RI batch reads to replica | NEW DEPENDENCY (slopcheck audit below) |
| `zxing-js/browser` (front-end ISBN camera scan) | (already in front-end per scan/page.tsx scope) | Frontend only — not Phase 2 backend scope | Leave as-is | — |
| `node-fetch` | (already in deps via existing services) | Used by `eskiz.client.ts` per Phase 1 | No change | — |

### Versions to verify at execution time

```bash
# Backend phase
npm view exceljs version                          # expect 4.4.0+
npm view @prisma/extension-read-replicas version  # expect 0.5.0+
npm view xlsx version                              # confirm 0.18.5 — last touched; CVE check via npm audit
```

---

## Package Legitimacy Audit

> Run before installing new deps. Phase 2 introduces **two** new packages (`exceljs`, `@prisma/extension-read-replicas`) and removes **one** (`xlsx`).

| Package | Registry | Age | Downloads (per week) | Source Repo | slopcheck | Disposition |
|---------|----------|-----|----------------------|-------------|-----------|-------------|
| `exceljs` | npm | ~9 yrs (first published 2015) | ~1.9M | github.com/exceljs/exceljs | [ASSUMED] — slopcheck not run at research time | **APPROVED** (planner must add `checkpoint:human-verify` before install, OR run slopcheck during Wave 0) |
| `@prisma/extension-read-replicas` | npm | ~2 yrs | ~50K | github.com/prisma/extension-read-replicas (official Prisma org) | [ASSUMED] | **APPROVED** (official Prisma scoped package; planner adds checkpoint) |
| `xlsx` | npm (existing) | abandoned-on-public-npm | ~1.5M | git.sheetjs.com (paid mirror) | n/a — being removed | **REMOVED** due to CVE-2024-22363 + CVE-2023-30533 |

**Packages removed due to slopcheck or CVE verdict:** `xlsx@0.18.5` (CVE — not slopcheck).
**Packages flagged as suspicious:** None.

Because slopcheck was unavailable at research time, both new deps carry `[ASSUMED]` provenance. Plan must include a `checkpoint:human-verify` (or equivalent) task before `npm install` runs.

---

## RI Batch Architecture (the load-bearing decision)

### The single load-bearing question: how does the nightly RI fan out?

**Answer:** New BullMQ queue `ri-recalc`, registered as a sibling to `notifications` / `reports` / `ai-tasks`. The `@Cron(EVERY_DAY_AT_MIDNIGHT)` handler in `ReadingService` does ONLY this:

```typescript
// reading.service.ts — replace existing recalculateAll
@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
async scheduleNightlyRecalculation() {
  const activeUserCount = await this.prisma.user.count({ where: { status: 'ACTIVE' } });
  const CHUNK_SIZE = 1000;
  const totalChunks = Math.ceil(activeUserCount / CHUNK_SIZE);
  this.logger.log(`Scheduling RI recalc: ${activeUserCount} users → ${totalChunks} chunks`);

  const jobs = Array.from({ length: totalChunks }, (_, i) => ({
    name: 'ri-chunk',
    data: { chunkIndex: i, offset: i * CHUNK_SIZE, limit: CHUNK_SIZE, scheduledAt: new Date().toISOString() },
    opts: { attempts: 3, backoff: { type: 'exponential' as const, delay: 5000 } },
  }));

  await this.riQueue.addBulk(jobs);   // single Redis round-trip — addBulk is atomic
}
```

`addBulk` queues all jobs in a single Redis pipeline call ([CITED: docs.bullmq.io/guide/jobs/adding-bulks]) — at 5M users / 1000 per chunk = 5000 jobs, fits comfortably.

### Worker design

```typescript
// new file: apps/backend/src/modules/reading/ri-recalc.processor.ts
@Processor(RI_RECALC_QUEUE, { concurrency: 10 })
export class RiRecalcProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,          // primary (writes)
    private readonly prismaReplica: PrismaReplicaService, // NEW — DATABASE_REPLICA_URL
    private readonly logger: Logger,
  ) { super(); }

  async process(job: Job<{ offset: number; limit: number; chunkIndex: number; scheduledAt: string }>) {
    // 1. Load chunk users from replica
    const users = await this.prismaReplica.user.findMany({
      where: { status: 'ACTIVE' },
      skip: job.data.offset,
      take: job.data.limit,
      orderBy: { id: 'asc' },           // stable — same ordering every run, no drift
      select: { id: true, trustScore: true },
    });

    // 2. Single batched read of transactions for the whole chunk
    const userIds = users.map(u => u.id);
    const oneYearAgo = subYears(new Date(), 1);

    const [txns, scans] = await Promise.all([
      this.prismaReplica.bookTransaction.findMany({
        where: { userId: { in: userIds }, status: 'RETURNED', returnedAt: { gte: oneYearAgo } },
        select: { userId: true, returnedAt: true, penaltyDays: true, book: { select: { genre: true } } },
      }),
      this.prismaReplica.isbnScan.findMany({
        where: { userId: { in: userIds }, confirmed: true, confirmedAt: { gte: oneYearAgo } },
        select: { userId: true, source: true, isbn: true, confirmedAt: true },
      }),
    ]);

    // 3. Group in-memory by userId; compute formula; createMany on primary
    const records = users.map(u => computeRi(u, groupByUser(txns, scans, u.id)));
    await this.prisma.readingIndex.createMany({ data: records, skipDuplicates: false });

    await job.updateProgress(100);
  }
}
```

**Why this works at 5M:**
- **5000 jobs × ~12 sec/job (1000 users, 2 batched DB reads, 1 batched write) × 10 concurrent = ~6000 sec ≈ 100 minutes.** Comfortably under the <2h target.
- Replica read removes 100% of read load from the primary during the batch window.
- `createMany` produces ONE INSERT statement per chunk instead of 1000.
- `attempts: 3` + exponential backoff means a transient replica blip doesn't lose a chunk.

### Why NOT a single SQL `INSERT INTO ... SELECT GROUP BY userId`

Tempting (one statement, zero JS), but the RI formula has branching arithmetic (weekly bucketing, discipline penalty curves, source coefficient lookups) that is awkward to express in pure SQL without sacrificing readability. The hybrid (chunked read → JS compute → chunked write) keeps the formula in TypeScript where it's already covered by `reading.service.spec.ts` and where the planner can re-test it deterministically.

### Read-replica wiring

Phase 1 provisioned the replica + `DATABASE_REPLICA_URL` env var but **deferred app-side routing to Phase 2** (per VERIFICATION line 47 and STATE line 71). Phase 2 wires it via the official `@prisma/extension-read-replicas` extension, applied **only to the replica client** used by the RI worker — the rest of the app keeps the existing single-client Prisma. Pattern:

```typescript
// new file: apps/backend/src/infra/prisma/prisma-replica.service.ts
@Injectable()
export class PrismaReplicaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({ datasources: { db: { url: process.env.DATABASE_REPLICA_URL } } });
  }
  async onModuleInit() { await this.$connect(); }
}
```

No extension needed if we just instantiate a second `PrismaClient` pointing at the replica URL — simpler than the extension for our use case (we only want reads on this client; writes go to the primary `PrismaService`).

---

## Comprehension Test Design (fixes FRAUD-01, -02)

### Generation (FRAUD-01)

```typescript
// transactions.service.ts — replace generateQuestions
private generateQuestions(title: string, author: string) {
  return [
    this.shuffle({
      q: `Bu kitobning muallifi kim?`,
      correct: author,
      distractors: ['Abdulla Qahhor', "O'tkir Hoshimov", 'Erkin Vohidov'],
    }),
    this.shuffle({
      q: `Siz o'qigan kitobning nomi nima?`,
      correct: title,
      distractors: ['Mehrobdan chayon', "O'tkan kunlar", 'Sarob'],
    }),
    this.shuffle({
      q: `Kitobni qachon o'qib tugatdingiz?`,
      correct: 'Oxirgi 30 kun ichida',
      distractors: ['Bir necha yil oldin', 'Hech o\'qimadim', 'Bilmayman'],
    }),
  ];
}

private shuffle(q: { q: string; correct: string; distractors: string[] }) {
  const options = [q.correct, ...q.distractors];
  // Fisher-Yates
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  const answerIdx = options.indexOf(q.correct);
  return { q: q.q, options, answerIdx };
}
```

Note the third question is reworded from "Did you read the entire book?" (where every answer was easily guessable) to "When did you finish?" — still gameable by a single bot, but combined with FRAUD-02 timing the trivial bot is blocked.

### Statistical verification: 

The plan must include a spec test asserting that across N=1000 generations, the `answerIdx` distribution across `[0,1,2,3]` is approximately uniform (chi-squared test, or just `expect(count[0]).toBeLessThan(400)`). Don't ship without this — it's the canary against future regressions.

### Minimum-time enforcement (FRAUD-02)

```typescript
// transactions.service.ts — modify submitComprehensionTest
async submitComprehensionTest(userId, isbnScanId, answers, answerTimingsMs?) {
  const test = await this.prisma.comprehensionTest.findUnique({ where: { isbnScanId }, ... });
  // ...existing checks...

  // FRAUD-02 server-side gate: minimum 5 seconds per question
  const elapsedMs = Date.now() - test.createdAt.getTime();
  const minMs = test.questions.length * 5000;
  if (elapsedMs < minMs) {
    throw new BadRequestException(`Test juda tez topshirildi (${elapsedMs}ms). Har savol uchun kamida 5 soniya o'qish kerak.`);
  }

  // Per-question gate (defense in depth)
  if (answerTimingsMs && answerTimingsMs.some(t => t < 3000)) {
    throw new BadRequestException('Savollarga juda tez javob berildi (har biri kamida 3 soniya).');
  }
  // ...
}
```

Both gates needed: Option B catches naïve scripts that POST instantly. Option C catches scripts that `sleep 15s` once but then `[0,0,0]` quickly — but actually the elapsed check catches that case too. The per-question check matters only if the user opens the test page, walks away for 20 min, then answers all 3 in <3s each.

---

## Trust Score / Risk Score Formulas

### Trust Score (0–100) — Phase 2 updates

| Signal | Source | Weight | Today's State |
|--------|--------|--------|---------------|
| Return on time | `BookTransaction.penaltyDays == 0` on return | +1 per on-time return (already wired) | EXISTS @ `transactions.service.ts:310-316` |
| Return late | `penaltyDays > 0` | `-min(penaltyDays*2, 10)` per late return | EXISTS @ `transactions.service.ts:303-307` |
| Reading speed (NEW, Phase 2) | `(returnedAt - borrowedAt)` vs `book.pages` | -5 if pages/hour > 100 (impossibly fast) or 0 if borrowed-returned in < 30 min | NEW — compute on return |
| Comprehension test pass rate | `passed / attempts` over last 30 days | +5 if rate > 0.8, -5 if rate < 0.4 | NEW — compute during nightly Trust Score recompute |
| Location check | n/a | Deferred to Phase 5/v2 | OUT OF SCOPE |

Trust Score is bounded [0, 100]. Initial value on registration is `0` (per current schema default), so it climbs from inactive `0` → demonstrated-trustworthy `100` via good behavior. The +1 bonus at threshold ≥90 in `getBorrowLimit` matches K3.

### Risk Score (0–100) — Phase 2 changes to FraudService

| Rule | Points | Code today | Change |
|------|--------|-----------|--------|
| HIGH_DAILY_BORROWS (>3/day) | up to 30 | fraud.service.ts:65-74 | Keep |
| EXCESSIVE_ISBN_SCANS (>5/day avg over 7d) | up to 20 | :76-86 | Keep |
| COMPREHENSION_FAILURES (≥3 in 30d) | up to 25 | :88-97 | Keep — but the comprehension test will get harder per FRAUD-01/02, so the false-positive rate from this rule will drop |
| RI_SPIKE (today vs N-records-ago) | 20 | :99-111 | **FIX:** compare today vs yesterday only |
| LOW_TRUST_SCORE (<30) | 15 | :113-121 | Keep |
| QUICK_RETURNS (<2h, ≥2 in 30d) | 12 | :123-132 | Keep |

Risk Score thresholds (FRAUD-06):
- 0–24 SAFE → no action
- 25–49 LOW → monitor (no user-facing change)
- 50–69 REVIEW → admin notified, NO auto action
- 70–100 **FLAGGED** (renamed from BLOCKED) → admin review queue entry created, Kafka emit, NO user.status change

---

## Build Order (waves)

### Wave 0 — Foundation & non-breaking prep (parallel-safe)
- W0-1: Add `exceljs` dep + remove `xlsx` (planner inserts `checkpoint:human-verify` for slopcheck per Package Legitimacy Audit)
- W0-2: Add `@prisma/extension-read-replicas` OR confirm decision to use plain second-PrismaClient pattern (recommended)
- W0-3: Create `RI_RECALC_QUEUE` constant in `queue.module.ts` next to `AI_QUEUE`; do NOT yet attach a processor
- W0-4: Generate Prisma migration capturing the Phase-1-pushed `@@index([userId, calculatedAt])` (it lives in DB but no migration file; this is a paper trail fix)
- W0-5: Test fixtures — confirm `reading.service.spec.ts`, `transactions.service.spec.ts`, `fraud.service.spec.ts`, `books.service.spec.ts`, `store.service.spec.ts` exist (all verified above) and add mock for `PrismaReplicaService`

### Wave 1 — Bug fixes (independent, all parallel-safe)
- W1-1: FRAUD-01 — `shuffle()` helper + reworked questions + distribution spec test
- W1-2: FRAUD-02 — minimum-time enforcement (elapsed + per-question timings)
- W1-3: FRAUD-04 — drop `operatorId` from store-entry DTO, use `@CurrentUser`, verify Institution ownership
- W1-4: FRAUD-06 — rename `BLOCKED` → `FLAGGED` in fraud.service.ts + types + specs
- W1-5: BOOK-05 part 1 — convert 4 array-form `$transaction([...])` to interactive callback form in transactions.service.ts
- W1-6: STORE-03 / RI-02 — per-source coefficient sum in `recalculateForUser` books-count component
- W1-7: H6 fix — add `extended Boolean @default(false)` to BookTransaction; remove `penaltyDays: -1` magic number from `extendDueDate`

### Wave 2 — Schema / structural changes (sequential after W1)
- W2-1: BOOK-05 part 2 — raw SQL migration `ALTER TABLE "Book" ADD CONSTRAINT book_availablecount_nonneg CHECK ("availableCount" >= 0)`
- W2-2: RI-05 — raw SQL migration converting `ReadingIndex` to `PARTITION BY RANGE (calculatedAt)`, attach 14 months of partitions (last 1, current, next 12)
- W2-3: BOOK-02 — add `BookTransfer` model + migration; refactor `returnRoaming` to create PENDING transfer instead of bumping source-library `availableCount`
- W2-4: FRAUD-03 (schema part) — decide between adding `UserStatus.FLAGGED` enum vs. using `FraudScore.action='review'`; recommend the latter (no enum migration)

### Wave 3 — Batch architecture (depends on W0, W2-2)
- W3-1: Create `PrismaReplicaService` pointing at `DATABASE_REPLICA_URL`
- W3-2: Create `RiRecalcProcessor` (the worker)
- W3-3: Replace `recalculateAll()` body in `ReadingService` with `scheduleNightlyRecalculation` chunk dispatcher
- W3-4: Spec tests for: chunk fan-out, single-chunk processing correctness, replica-vs-primary routing, error/retry behavior
- W3-5: Load harness — k6 script (Phase 7 will scale, but a 1000-user simulation here proves the chunk works)

### Wave 4 — New endpoints (depends on W3 for some)
- W4-1: RI-04 — `GET /reading/:userId/delta` (3 windows, Redis cache)
- W4-2: FRAUD-03 — `GET /ai/fraud/review-queue` + `POST /ai/fraud/:userId/resolve`
- W4-3: FRAUD-03 — remove auto-block code at fraud.service.ts:234-240
- W4-4: BOOK-02 — `POST /libraries/:id/transfers/:transferId/confirm`
- W4-5: BOOK-01 — convert import to BullMQ job + progress endpoint (uses exceljs from W0-1)
- W4-6: STORE-01 — 24h expiry enforcement in `confirmStorePurchase`
- W4-7: RI-03 — monthly partition-detach cron

### Wave 5 — Validation
- W5-1: Full backend test suite green (680+ baseline from Phase 1)
- W5-2: Integration test: simulate nightly run with 10K seed users → BullMQ chunks → confirm <30s wall-clock on a dev machine
- W5-3: Reconciliation spec: confirm `availableCount` CHECK constraint catches races (deliberately attempt to over-decrement)

---

## Validation Architecture (Nyquist — workflow.nyquist_validation: true)

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest 30.3 + ts-jest 29.4 (backend) |
| Config file | `apps/backend/jest.config.ts` (rootDir = `src`, regex `.*\.spec\.ts$`, coverage threshold `lines: 80`) |
| Existing baseline | 680/680 tests passing as of Phase 1 verification (2026-06-06) |
| Quick run command | `cd apps/backend && npx jest --testPathPattern '(reading\|transactions\|books\|store\|ai/fraud)' --bail` |
| Full suite command | `cd apps/backend && npm test` |
| Front-end (out of phase-2 scope mostly) | No automated tests exist [CITED: CONCERNS.md "Frontend has zero automated tests"] — Phase 2 leaves this unchanged |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RI-01 | Cron schedules N chunks via `Queue.addBulk` where N=ceil(activeUsers/1000) | unit (mock Queue) | `npx jest reading.service.spec.ts -t "scheduleNightlyRecalculation"` | ✅ extend `reading.service.spec.ts` |
| RI-01 | RiRecalcProcessor processes a chunk, calls `createMany` once with correct shape | unit (mock Prisma) | `npx jest ri-recalc.processor.spec.ts` | ❌ Wave 0 (new) |
| RI-02 | 5-component formula matches CLAUDE.md weights for canonical inputs | unit | `npx jest reading.service.spec.ts -t "recalculateForUser formula"` | ✅ extend existing |
| RI-02 | Source coefficient applied per-source (not flat 0.9 across all isbn scans) | unit | `npx jest reading.service.spec.ts -t "applies per-source coefficient"` | ❌ Wave 1 (new spec case) |
| RI-03 | Partition-detach cron is invoked monthly at expected time | unit (mock Date + Cron) | `npx jest reading.service.spec.ts -t "monthly partition cleanup"` | ❌ Wave 4 |
| RI-04 | Delta endpoint returns correct prev / current / pct for 3 windows | unit + e2e-via-supertest if available | `npx jest reading.service.spec.ts -t "delta"` | ❌ Wave 4 |
| RI-05 | Migration script attaches 14 partitions; new RI rows route to current-month partition | integration (real PG) | NOT runnable in CI without PG container — manual or testcontainers | ❌ Wave 2 (gap — manual checkpoint) |
| FRAUD-01 | `generateQuestions` answerIdx distribution is not always 0 (chi-squared over 1000 calls) | unit | `npx jest transactions.service.spec.ts -t "comprehension test randomizes"` | ❌ Wave 1 (new) |
| FRAUD-02 | submit < 15s after createdAt → 400 BadRequest | unit | `npx jest transactions.service.spec.ts -t "rejects fast submission"` | ❌ Wave 1 (new) |
| FRAUD-02 | per-question timing < 3s → 400 BadRequest | unit | `npx jest transactions.service.spec.ts -t "rejects fast per-question"` | ❌ Wave 1 (new) |
| FRAUD-03 | `dailyFraudScan` does NOT call `user.update({ status: BLOCKED })` | unit | `npx jest fraud.service.spec.ts -t "does not auto-block"` | ✅ extend `fraud.service.spec.ts` |
| FRAUD-03 | Review queue endpoint returns FLAGGED users sorted by riskScore desc | unit | `npx jest fraud.service.spec.ts -t "review queue"` | ❌ Wave 4 |
| FRAUD-04 | Store-entry with body operatorId ≠ authenticated user → ignored / forbidden | unit | `npx jest transactions.service.spec.ts -t "uses authenticated user for store entry"` | ❌ Wave 1 |
| FRAUD-05 | Reading speed signal subtracts trust score for impossibly fast read | unit | `npx jest transactions.service.spec.ts -t "trust score reading speed"` | ❌ Wave 1 |
| FRAUD-06 | `RiskLevel` type contains FLAGGED not BLOCKED | unit (type-level + value) | `npx jest fraud.service.spec.ts -t "risk level FLAGGED"` | ❌ Wave 1 |
| BOOK-01 | exceljs import of 100-row XLSX returns 100 created, 0 errors | unit (mock fs + ExcelJS streamed) | `npx jest books.service.spec.ts -t "imports valid XLSX"` | ✅ extend `books.service.spec.ts` |
| BOOK-01 | Import job updates progress and is queryable mid-run | integration | `npx jest books.import.processor.spec.ts` | ❌ Wave 4 |
| BOOK-02 | `returnRoaming` creates a PENDING `BookTransfer` row and does NOT bump source availableCount | unit | `npx jest transactions.service.spec.ts -t "roaming returns pending transfer"` | ❌ Wave 2 |
| BOOK-03 | Reserve at limit → 400 BadRequest | unit | `npx jest transactions.service.spec.ts -t "reserve at limit"` | ❌ Wave 1 |
| BOOK-04 | Cron at 10:00 sends 3d alert | unit (existing) — verify it survives refactor | `npx jest transactions.service.spec.ts -t "checkOverdueAlerts"` | ✅ extend |
| BOOK-05 | Interactive transaction form is used in all 5 paths | code-grep AND spec asserting `$transaction(async (p) => ...)` is the only form | `npx jest transactions.service.spec.ts -t "uses interactive transactions"` | ❌ Wave 1 |
| BOOK-05 | CHECK constraint rejects negative availableCount | integration (real PG) | manual / testcontainers | ❌ Wave 2 (manual) |
| STORE-01 | Confirm store purchase older than 24h → 400 BadRequest | unit | `npx jest store.service.spec.ts -t "expires 24h"` | ✅ extend `store.service.spec.ts` |
| STORE-02 | Camera ISBN scan triggers comprehension test on every 5th confirmed scan | unit (existing) | `npx jest transactions.service.spec.ts -t "scanIsbn"` | ✅ exists |
| STORE-03 | RI books-count component uses 0.9x for STORE_MANUAL specifically | unit | `npx jest reading.service.spec.ts -t "applies per-source coefficient"` | ❌ Wave 1 (covered above) |

### Sampling Rate

- **Per task commit:** `cd apps/backend && npx jest --testPathPattern '(reading|transactions|books|store|ai/fraud)' --bail` (target <30s wall-clock)
- **Per wave merge:** `cd apps/backend && npm test` (full 680+ suite)
- **Phase gate (before `/gsd-verify-work`):** full suite green + manual integration smoke (partitioning migration + CHECK constraint verification on a fresh DB)

### Wave 0 Gaps

- [ ] `apps/backend/src/modules/reading/__tests__/ri-recalc.processor.spec.ts` — new processor unit tests for chunk processing
- [ ] `apps/backend/src/modules/books/__tests__/books.import.processor.spec.ts` — new XLSX import processor tests (Wave 4)
- [ ] Mock for `PrismaReplicaService` (extend `apps/backend/src/__mocks__/`)
- [ ] Real-PostgreSQL integration tests for partition migration and CHECK constraint — recommend `testcontainers` (~50KB dep) OR an explicit manual checkpoint task that runs the migration on a fresh DB and asserts via `psql`
- [ ] No framework install needed — jest 30 + ts-jest already cover all units

---

## Risks & Gotchas

1. **Composite index lives in DB without a migration file.** Phase 1's `prisma db push` added `ReadingIndex_userId_calculatedAt_idx` but did NOT create a migration file. Phase 2's RI-05 partitioning migration WILL conflict with this index unless the index is rebuilt on each partition. The plan must either (a) generate a migration file that captures the index on the parent table — partitioned-table indexes propagate to partitions in PG ≥ 11 — and DROP the orphan, or (b) DROP the orphan and re-create on each partition.

2. **BullMQ jobs must be idempotent.** A worker that retries a chunk after a crash will create duplicate `ReadingIndex` rows. Mitigation: chunk job key = `ri-recalc:${date}:${chunkIndex}` with `removeOnComplete: { count: 100 }`, AND make the worker delete-then-insert OR use `createMany({ skipDuplicates: true })` based on `[userId, calculatedAt::date]` uniqueness (requires a unique constraint scoped to date — not yet present; if added, will conflict with the composite index).

3. **PgBouncer + Prisma prepared statements.** Phase 1 set `?pgbouncer=true` on `DATABASE_URL` which disables Prisma's prepared-statement cache. The replica URL `DATABASE_REPLICA_URL` is a direct postgres URL (no pooler) per Phase 1 plan — confirm before using `$queryRaw` against it. [CITED: STATE.md line 81 "INFRA-09/10 ... DATABASE_URL=...pgbouncer:6432?pgbouncer=true&connection_limit=1"]

4. **The Phase 1 deferred Eskiz checkpoint blocks live BOOK-04 alerts.** Cron fires correctly, SMS payloads correctly enqueue via `EskizSmsClient.sendSms`, but `ESKIZ_EMAIL` unset → no-op delivery. Documented behavior; user is aware. Phase 2 should NOT block on this — RI engine and fraud fixes are entirely independent.

5. **Postgres partitioning under Prisma.** Prisma generates `CREATE TABLE` not `CREATE TABLE ... PARTITION BY`. The RI-05 migration MUST be a hand-edited raw SQL file. The Prisma schema will continue to model `ReadingIndex` as a regular table — Prisma operations work fine because PG transparently routes inserts/selects to the right partition. Document this clearly in the migration so future devs don't `npx prisma migrate dev` and break it.

6. **`xlsx` removal cascades.** Grep confirmed `xlsx` is used only in `books.service.ts` — safe to swap. But check `package-lock.json` for transitive uses (unlikely).

7. **DEV_OTP_BYPASS in dev.** Phase 1 ships `DEV_OTP_BYPASS=true` for dev. All Phase 2 work that touches store entries / scan endpoints must not assume real OTP flow in dev — keep the same NODE_ENV guard pattern for any new sensitive endpoints (FRAUD-04 store-entry needs auth review).

8. **Frontend has zero automated tests** [CITED: CONCERNS.md]. Phase 2 frontend changes (scan, dokon UI updates) won't have unit tests. Either accept this risk (it's the project baseline) or add 1-2 critical Playwright tests for the comprehension test flow.

9. **The `_recentIsbnScans` count in fraud.service.ts counts ALL scans (not just confirmed).** A user who scans 10 ISBNs but never confirms any will trigger `EXCESSIVE_ISBN_SCANS`. Verify if this is intended; if not, add `confirmed: true` to the filter at fraud.service.ts:291-295.

10. **`extended Boolean` migration is destructive if there are extended transactions in dev seeds.** Check seed.ts (`prisma/seed.ts`) for any `penaltyDays: -1` rows. The migration should: ADD `extended` column → backfill `UPDATE WHERE penaltyDays = -1 SET extended = true, penaltyDays = 0` → drop the magic-number behavior in `extendDueDate`.

---

## Open Questions

1. **`UserStatus.FLAGGED` enum vs `FraudScore.action='review'` for FRAUD-03.**
   - What we know: Both work mechanically; the enum option requires a Prisma migration + downstream guard updates; the action-field option is in-place.
   - What's unclear: Will Phase 3 (Top-100) want to filter users by `User.status` directly?
   - Recommendation: Use `FraudScore.action='review'`. Top-100 already joins `FraudScore` (per `checkTop100Candidates` at fraud.service.ts:165-207). No User schema change.

2. **Trust Score location signal — Phase 2 or v2?**
   - What we know: User location is not captured anywhere. Library location exists. Capturing user location is a privacy-sensitive change.
   - Recommendation: Defer to v2. The other Trust Score signals (return discipline, reading speed, comprehension pass rate) already provide a strong signal.

3. **Comprehension test — book-specific questions via OpenAI?**
   - What we know: `openai@4.52.7` is already in `package.json`. Generating questions from real content adds significant fraud resistance.
   - Recommendation: Out of Phase 2 scope. The shuffle fix + minimum-time gate close the trivial-bot loophole. AI-generated questions are a Phase 7 enhancement (AI-01..05).

4. **Should `IsbnScan.confirmed=false` rows expire automatically?**
   - What we know: A scan starts unconfirmed; passing the comprehension test sets confirmed=true. There's no row-level expiry.
   - Recommendation: Add a 30-day TTL on unconfirmed scans (daily cron). Safer for DB growth long-term and matches the "test allaqachon o'tilgan" / lapsed state UX.

5. **Read-replica lag tolerance for nightly RI batch.**
   - What we know: RI batch reads from replica, writes to primary. If replica lag > a few minutes, the RI is based on slightly-stale data.
   - Recommendation: Acceptable — RI is a 24-hour-granularity statistic. Document this in the migration notes.

6. **`@prisma/extension-read-replicas` vs. dual `PrismaClient`.**
   - What we know: The official extension supports a `replicas` array; or we can instantiate a second client directly.
   - Recommendation: Dual `PrismaClient` is simpler and sufficient for Phase 2 (only the RI worker uses the replica). Reconsider the extension in Phase 5 if more services need replica routing.

7. **Partition window: 13 months "keep" + 1 future month — is the 13 in CLAUDE.md hard?**
   - What we know: Requirement RI-03 says "keep 13 months". TZ Section V.2 mentions Monthly Top-100. 13 months covers all of last year + current month for delta comparisons.
   - Recommendation: Confirm with user during discuss-phase if 12 vs 13 is meaningful. Defaulting to 13 per the requirement.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All backend work | ✓ | 20 LTS (per Dockerfile) | — |
| PostgreSQL primary | All writes | ✓ (docker-compose) | 15 | — |
| PostgreSQL replica | RI worker reads | ✓ provisioned (docker-compose.prod.yml:198+); needs `DATABASE_REPLICA_URL` in `.env` | 15 | Worker can fall back to primary client (single env-var flag) |
| Redis | BullMQ backing store | ✓ | 7 | — |
| BullMQ | New RI queue | ✓ installed `5.76.6` | matches `^5.8.4` | — |
| exceljs | BOOK-01 replacement | ✗ NOT installed yet | target `4.4.0` | Keep `xlsx` (with CVE caveat) — NOT recommended |
| @prisma/extension-read-replicas | OPTIONAL (only if we choose extension over plain second-client) | ✗ NOT installed | target `0.5.0` | Plain second `PrismaClient` — recommended path, no new dep |
| Eskiz.uz API creds | BOOK-04 SMS delivery | ✗ deferred from Phase 1 | — | Notifications no-op (logged) — already a documented Phase 1 deferral |

**Missing dependencies with no fallback:** None blocking. exceljs is required to remove the CVE-vulnerable `xlsx`, but the install is a Wave 0 task gated by a slopcheck checkpoint.

**Missing dependencies with fallback:** Eskiz live SMS — Phase 1's documented deferral. RI/fraud work is independent of SMS delivery.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RI-01 | Nightly RI recalculation via BullMQ batched processing (1000-user chunks, <2h for 5M users) | RI Batch Architecture section; uses existing BullMQ + Redis + Phase 1 composite index + provisioned replica |
| RI-02 | RI formula: 5 components with documented weights | Already implemented; needs per-source coefficient fix (W1-6) |
| RI-03 | RI history stored with cleanup (13 months + archive) | NEW monthly partition-detach cron (W4-7) — feasible via PG `DETACH PARTITION` |
| RI-04 | RI delta tracking — daily/weekly/monthly | NEW endpoint over composite index (W4-1) — single fast query each |
| RI-05 | ReadingIndex partitioned by month | Raw-SQL migration in W2-2; native PG range partitioning; documented `prisma migrate` interaction |
| FRAUD-01 | Comprehension test randomizes answer positions | shuffle() helper + spec test for distribution (W1-1) |
| FRAUD-02 | Minimum time per question | Server-side elapsed + per-question timing checks (W1-2) |
| FRAUD-03 | Fraud scan uses FLAGGED + admin review (NOT auto-block) | Remove user.status update; add review-queue endpoints; use FraudScore.action field as source-of-truth (W4-2, W4-3) |
| FRAUD-04 | Store manual entry authorization | Drop body operatorId, use @CurrentUser, verify Institution ownership (W1-3) |
| FRAUD-05 | Trust Score from discipline + speed + (deferred) location | Already partial; add reading-speed signal during nightly recompute (W1-5 extension) |
| FRAUD-06 | Risk Score thresholds 0-24/25-49/50-69/70-100 | Already match; rename BLOCKED→FLAGGED (W1-4) |
| BOOK-01 | Excel import for 500+ books with progress | Replace xlsx with exceljs; convert to BullMQ job with progress (W0-1, W4-5) |
| BOOK-02 | Library Roaming with bilateral confirmation | New BookTransfer model + confirm endpoint (W2-3, W4-4) |
| BOOK-03 | Book limits by user type + Trust Score bonus | Verified; add missing check in reserve() (W1) |
| BOOK-04 | Overdue alerts at 3d/1d + block new borrow | Already implemented; verify and document Eskiz dependency (W5) |
| BOOK-05 | Interactive transactions + CHECK constraint | Convert 4 array-form transactions (W1-5); add CHECK migration (W2-1) |
| STORE-01 | Store cabinet 24h confirm window | Authorization fix (FRAUD-04) + 24h expiry check (W4-6) |
| STORE-02 | ISBN camera scan + comprehension test | Cascades from FRAUD-01/02 fixes |
| STORE-03 | Store purchases 0.9x toward RI | Per-source coefficient fix (W1-6) |

---

## Sources

### Primary (HIGH confidence — codebase verified)

- `apps/backend/src/modules/reading/reading.service.ts` (lines cited inline)
- `apps/backend/src/modules/transactions/transactions.service.ts`
- `apps/backend/src/modules/books/books.service.ts`
- `apps/backend/src/modules/store/store.service.ts` & `store.controller.ts`
- `apps/backend/src/modules/ai/fraud.service.ts`
- `apps/backend/src/infra/queue/queue.module.ts` & `notification.processor.ts`
- `apps/backend/prisma/schema.prisma` (lines 150-479 covering User, Book, BookTransaction, ReadingIndex, FraudScore, IsbnScan, ComprehensionTest)
- `apps/backend/prisma/migrations/20260507052836_init/migration.sql`
- `.planning/phases/01-infrastructure-hardening-authentication/01-VERIFICATION.md`
- `.planning/STATE.md`
- `.planning/REQUIREMENTS.md`

### Primary (HIGH confidence — planning research)

- `.planning/research/PITFALLS.md` (C1, C2, C5, C6, H2, H4, H6, F1, F2, S1, S2)
- `.planning/research/ARCHITECTURE.md` (Section 5 Scheduled Jobs, Section 1 AI Architecture, Section 6 Data Isolation)
- `.planning/research/STACK.md` (BullMQ batch processing, Read replica config)
- `.planning/codebase/CONCERNS.md` (verified bugs)

### Secondary (MEDIUM confidence — external)

- [Vulert CVE-2024-22363: xlsx ReDoS](https://vulert.com/vuln-db/CVE-2024-22363) — verifies xlsx@0.18.5 is vulnerable
- [Snyk SNYK-JS-XLSX-5457926: Prototype Pollution](https://security.snyk.io/vuln/SNYK-JS-XLSX-5457926) — second xlsx CVE
- [PostgreSQL Documentation: Range Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — RI-05 implementation reference
- [BullMQ Queue.addBulk](https://docs.bullmq.io/guide/jobs/adding-bulks) — atomic bulk job dispatch pattern
- [Prisma read replicas extension](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/read-replicas) — alternate read replica wiring

### Verified versions (npm registry, 2026-06-06)

- `exceljs@4.4.0` — `npm view exceljs version`
- `xlsx@0.18.5` — `npm view xlsx version` (matches `package.json`; confirms abandoned-on-public-npm state)
- `bullmq@5.78.0` — `npm view bullmq version` (project pins `^5.8.4`)
- `@nestjs/bullmq@11.0.4` — `npm view @nestjs/bullmq version` (project pins `^10.2.3`)
- `@nestjs/schedule@^4.1.1` — already installed

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@prisma/extension-read-replicas` is the official Prisma extension and is the canonical wiring path | Library & Dependency Recommendations | Plan recommends a non-existent extension. Mitigated by recommending plain second-`PrismaClient` as the primary path. |
| A2 | slopcheck not available at research time; `exceljs` and `@prisma/extension-read-replicas` tagged [ASSUMED] | Package Legitimacy Audit | Planner adds checkpoint:human-verify before install. Risk is low — exceljs is a well-known package; the extension is in the Prisma official org. |
| A3 | `DATABASE_REPLICA_URL` is a direct postgres URL (no PgBouncer), suitable for `$queryRaw` and `IN`-clause batched reads | Read-replica wiring | If actually routed through PgBouncer, `$queryRaw` prepared statements may break. Mitigated by W3-1 spec test attempting a `$queryRaw`. |
| A4 | The replica is in sync within seconds of primary (acceptable lag for a daily RI batch) | Open Q 5 | RI score uses 1-day-stale data. Stated cost is acceptable per the daily-recompute design. |
| A5 | The Phase-1-pushed composite index `ReadingIndex_userId_calculatedAt_idx` is the only declared index on the table | RI-05 partitioning gotcha | If other indexes exist (added by some past `db push`), the partitioning migration needs to re-create them too. Plan must `psql` inspect indexes before running the migration. |
| A6 | `FraudScore.action='review'` is sufficient signal for downstream consumers (Top-100, AiController endpoints) without adding `UserStatus.FLAGGED` | FRAUD-03 design choice | Phase 3 (Top-100) might prefer `User.status` filtering. Verify with discuss-phase. |
| A7 | The current comprehension-test 70%-pass threshold (Math.ceil(questions.length * 0.7)) remains correct after randomization fix | FRAUD-01 | If we expand to 5 questions, threshold becomes 4 correct = 80%, which may be too strict. Phase 2 keeps 3 questions. |
| A8 | Mutolaa, mass ebook (EBOOK), and store coefficients (0.85, 0.8, 0.9) match CLAUDE.md Section IV.3 | RI-02 fix | These values are pulled from K2 which is verbatim from CLAUDE.md, so verified. |

**Items NOT in the assumptions log because they're verified:**
- BullMQ + Redis are live (Phase 1 verification)
- Composite index `(userId, calculatedAt)` is live in DB (Phase 1 verification line 75)
- Kafka consumer service is live (Phase 1 INFRA-08 complete)
- Cron timezone is Asia/Tashkent (Phase 1 INFRA-05 complete)
- @Processor decorator on NotificationProcessor is active (Phase 1 NOTIF-04 complete)
- Eskiz live SMS deferred (Phase 1 documented deferral)
- xlsx@0.18.5 CVEs (multiple primary sources)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — BullMQ, Redis, Prisma already deployed and verified in Phase 1
- Architecture: HIGH — codebase audit confirms gaps and read-replica provisioning per Phase 1
- Pitfalls: HIGH — every cited bug verified at file:line in the current source tree
- Library choices: HIGH for `exceljs` (verified version + clean source repo); MEDIUM for `@prisma/extension-read-replicas` (research-time assumption; mitigated by recommending plain second-PrismaClient as primary path)

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (30 days for stable code-base; major Prisma or BullMQ minor versions may shift recommendations)
