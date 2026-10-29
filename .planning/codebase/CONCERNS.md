# Codebase Concerns

**Analysis Date:** 2026-06-06

---

## Tech Debt

**Notification processor is fully stubbed — SMS/Push/Email are no-ops:**
- Issue: `NotificationProcessor` class at `apps/backend/src/infra/queue/notification.processor.ts` has all three send methods (`sendSms`, `sendPush`, `sendEmail`) as debug-only stubs. The `@Processor()` decorator is commented out (line 15). All SMS traffic silently disappears into log lines — no real SMS API (Eskiz.uz / SMS.uz) is wired in. Every `SmsService.sendOtp()` and `SmsService.sendNotification()` call enqueues a job that never actually sends a message.
- Files: `apps/backend/src/infra/queue/notification.processor.ts`, `apps/backend/src/infra/sms/sms.service.ts`
- Impact: OTP codes, bron confirmations, overdue reminders, and fraud alerts are never delivered. Core MVP flow (phone verification) is broken in any real deployment.
- Fix approach: Implement `sendSms` with Eskiz.uz or SMS.uz HTTP API, re-enable the `@Processor(NOTIFICATION_QUEUE)` decorator, add Firebase FCM for `sendPush`, and add Nodemailer/SMTP for `sendEmail`.

**NLQ query history is never persisted:**
- Issue: `NlqService.getQueryHistory()` in `apps/backend/src/modules/ai/nlq.service.ts` (line 504) has a comment "Future: Prisma da saqlash. Hozir cache dan" and returns an empty array from cache on every call. Query history is never stored.
- Files: `apps/backend/src/modules/ai/nlq.service.ts`
- Impact: Admin chat history is always empty; session continuity is impossible; audit of AI queries cannot be performed.
- Fix approach: Create a `NlqQueryLog` Prisma model with `userId`, `question`, `answer`, `usedLlm`, `confidence`, `createdAt`. Persist in `getQueryHistory()` and retrieve paginated.

**Kafka events not consumed in the backend — producer-only architecture:**
- Issue: `KafkaService` in `apps/backend/src/infra/kafka/kafka.service.ts` only implements a producer. No Kafka consumers (`@EventPattern` / consumer groups) exist anywhere in the backend codebase. Events emitted (`fraud.detected`, `tuman.ri.dropped`, `book.borrowed`, etc.) are sent to Kafka but nothing reads them to trigger downstream actions.
- Files: `apps/backend/src/infra/kafka/kafka.service.ts`, all `apps/backend/src/modules/ai/` services
- Impact: The real-time AI audit pipeline described in the TZ (Kafka → Python FastAPI AI Engine) is not connected. Fraud detection alerts flow to Kafka but no consumer triggers follow-up actions.
- Fix approach: Either add NestJS `@nestjs/microservices` Kafka consumers for fraud and RI-drop topics, or document clearly that the Python AI Engine is the consumer and establish the separate service boundary.

**OTP rate-limiting uses in-memory Map — resets on server restart:**
- Issue: `AuthService.sendLog` in `apps/backend/src/modules/auth/auth.service.ts` (line 23) is a `Map<string, number[]>` stored in process memory. Rate-limit state is lost on every server restart/redeploy, and does not work in multi-instance deployments.
- Files: `apps/backend/src/modules/auth/auth.service.ts`
- Impact: In a horizontally scaled or rolling-deploy scenario, an attacker can exhaust OTP sends across instances. With zero-downtime deploys (Sprint 10 target), this resets on each deploy.
- Fix approach: Move OTP rate-limit state to Redis using `CacheService`. Key: `otp:ratelimit:{phone}`, TTL 1 hour.

**Comprehension test questions are trivially gameable:**
- Issue: `TransactionsService.generateQuestions()` in `apps/backend/src/modules/transactions/transactions.service.ts` (line 702) always puts the correct answer at index 0 for all 3 questions. The third question asks "Kitobni to'liq o'qidingizmi?" with answer index 0 = "Ha, to'liq o'qidim". Any script that always submits `[0, 0, 0]` passes every test.
- Files: `apps/backend/src/modules/transactions/transactions.service.ts` (lines 702–720)
- Impact: The comprehension test — which is the main fraud defense for ISBN scans — provides zero protection. The fraud detection goal of 95%+ accuracy is undermined at the source.
- Fix approach: Randomize correct answer position. Generate book-specific questions (require real book metadata lookup). Add at least 5 questions and require random subset. Consider AI-generated questions via the NLQ module.

**`extendDueDate` uses `penaltyDays = -1` as a "extended" flag — magic number:**
- Issue: `TransactionsService.extendDueDate()` in `apps/backend/src/modules/transactions/transactions.service.ts` (line 265) sets `penaltyDays: -1` as a sentinel meaning "this book has been extended once." The `penaltyDays` column is typed as `Int @default(0)` in the schema and is used elsewhere to accumulate actual late days. A negative value in an "overdue days" field will break any query that checks `penaltyDays >= 0` to find overdue books (see `blockOverdueUsers` cron at line 680 which does `penaltyDays: { gte: 0 }` — the extended flag bypasses it).
- Files: `apps/backend/src/modules/transactions/transactions.service.ts`, `apps/backend/prisma/schema.prisma`
- Impact: Extended books are excluded from overdue penalty cron. Users who extend always avoid trust score penalties even if they return late after the extension.
- Fix approach: Add a separate boolean column `extended Boolean @default(false)` to `BookTransaction`. Remove the magic `-1` from `penaltyDays`.

**`findAll` on transactions has no pagination — unbounded query:**
- Issue: `TransactionsService.findAll()` in `apps/backend/src/modules/transactions/transactions.service.ts` (line 516) returns all matching transactions with no `take`/`skip` limit. At scale (millions of transactions), this will cause OOM and timeout on any admin view.
- Files: `apps/backend/src/modules/transactions/transactions.service.ts`
- Impact: Admin transaction lists will crash or time out once data volume grows. p99 SLA target of 500ms is impossible without pagination.
- Fix approach: Add `limit: number = 50, offset: number = 0` parameters and apply `take`/`skip` in the Prisma query.

**`_buildTumanRiMap()` loads all RI records from 60 days without limit:**
- Issue: `AuditService._buildTumanRiMap()` in `apps/backend/src/modules/ai/audit.service.ts` (line 312) fetches all ReadingIndex records from the last 60 days with no `take` limit and performs aggregation in JavaScript. With 5M users × 2 months of nightly RI records, this could exceed 300M rows.
- Files: `apps/backend/src/modules/ai/audit.service.ts`
- Impact: The audit cron that runs every 15 minutes will stall the database at scale. Memory exhaustion on the backend process is likely.
- Fix approach: Use PostgreSQL `GROUP BY` via `$queryRaw` or Prisma aggregation with `groupBy` filtered by `user.address.tumanId` directly in the DB, not in application memory.

**`_getAvgRi()` in NLQ service loads up to 10,000 RI records into memory:**
- Issue: `NlqService._getAvgRi()` in `apps/backend/src/modules/ai/nlq.service.ts` (line 521) fetches up to 10,000 ReadingIndex records and averages them in JavaScript. With millions of users, `take: 10_000` is a soft cap that silently truncates results, making the average inaccurate.
- Files: `apps/backend/src/modules/ai/nlq.service.ts`
- Impact: Average RI values reported to admins will be wrong once user base exceeds 10,000 per region. Systematic undercount of high-RI users if they happen to be outside the 10K window.
- Fix approach: Use `prisma.readingIndex.aggregate({ _avg: { score: true }, where: {...} })` instead of fetching rows.

**`_checkTumanRiDrops()` performs two separate `groupBy` queries with disconnected logic:**
- Issue: `AuditService._checkTumanRiDrops()` in `apps/backend/src/modules/ai/audit.service.ts` (lines 71–90) runs two `groupBy` queries (`currentStats`, `prevStats`) but never actually uses their results — the real aggregation happens in `_buildTumanRiMap()` called separately. The two initial queries are dead code that hits the database on every 15-minute cron cycle.
- Files: `apps/backend/src/modules/ai/audit.service.ts`
- Impact: Wasted DB queries every 15 minutes. Code is confusing to maintain — two `groupBy` results declared but unused.
- Fix approach: Remove the two unused `groupBy` queries (lines 71–90). `_buildTumanRiMap()` is sufficient.

**`_handleMissingBooks()` runs N+1 queries inside a loop:**
- Issue: `NlqService._handleMissingBooks()` in `apps/backend/src/modules/ai/nlq.service.ts` (lines 269–277) runs `prisma.book.findUnique()` in a `for` loop for each of the top 10 hot books — 10 sequential DB round-trips.
- Files: `apps/backend/src/modules/ai/nlq.service.ts`
- Impact: NLQ response latency for "missing books" query is O(N×latency) instead of O(1). Against the 3-second response target, 10 × 20ms = 200ms extra minimum.
- Fix approach: Use `prisma.book.findMany({ where: { id: { in: bookIds } } })` in one query, then map results.

**`_checkFundShortages()` runs N+1 queries inside a loop:**
- Issue: `AuditService._checkFundShortages()` in `apps/backend/src/modules/ai/audit.service.ts` (lines 230–251) similarly runs `prisma.book.findUnique()` per hot book inside a loop.
- Files: `apps/backend/src/modules/ai/audit.service.ts`
- Impact: Same as above, multiplied by the 15-minute cron frequency.
- Fix approach: Batch with `findMany({ where: { id: { in: [...] } } })`.

**`predictTumanRi` fetches monthly RI in a loop — 12 sequential DB queries:**
- Issue: `PredictService._getTumanMonthlyRi()` in `apps/backend/src/modules/ai/predict.service.ts` (lines 335–361) runs 12 sequential `prisma.readingIndex.findMany()` calls (one per month) with up to 5,000 records each.
- Files: `apps/backend/src/modules/ai/predict.service.ts`
- Impact: 60,000 records transferred per prediction call. Each call takes ~12× the single-query latency. Cached for 30 minutes, but cache miss hits DB hard.
- Fix approach: Single query with `GROUP BY` month using `$queryRaw`, or date-bucketing at the DB level.

---

## Known Bugs

**`extendDueDate` allows extension even for already-extended books (no flag check):**
- Symptoms: The method checks `penaltyDays > 0` to prevent extension on overdue books, but uses `penaltyDays = -1` as the "already extended" marker. When `penaltyDays === -1`, the condition `penaltyDays > 0` is false, so a second extension call succeeds, setting `penaltyDays = -1` again (no-op on the date because it already ran once). A user can call extend unlimited times.
- Files: `apps/backend/src/modules/transactions/transactions.service.ts` (lines 251–266)
- Trigger: Call `PATCH /transactions/:id/extend` twice on the same transaction.
- Workaround: None currently enforced.

**`dailyFraudScan` issues automatic USER blocks without admin review:**
- Symptoms: The cron at `apps/backend/src/modules/ai/fraud.service.ts` (lines 212–246) sets `user.status = "BLOCKED"` for any user with `riskScore >= 70` without any human review step. The TZ states fraud detection feeds into a Top-100 review workflow, not instant account blocking.
- Files: `apps/backend/src/modules/ai/fraud.service.ts`
- Trigger: Any user that triggers the BLOCKED threshold (e.g., 4+ borrows/day) is silently blocked at 03:00 without notification.
- Workaround: Admin can manually unblock via user management.

**`RI_SPIKE` fraud rule compares scores across different time windows incorrectly:**
- Symptoms: In `FraudService.analyzeUser()` at `apps/backend/src/modules/ai/fraud.service.ts` (lines 100–111), the code fetches the last 5 `readingIndex` records ordered by `calculatedAt DESC` and then computes `riRecords[0].score - riRecords[riRecords.length-1].score`. This compares today's score to the oldest of the 5 records (potentially 5 days old), not yesterday's score. A legitimate user who was inactive for 5 days and then read 3 books in one day would be falsely flagged.
- Files: `apps/backend/src/modules/ai/fraud.service.ts` (lines 99–111)
- Trigger: A user who reads several books after a gap of several days.
- Workaround: None.

**`storeManualEntry` does not verify operator belongs to a registered store:**
- Symptoms: `TransactionsService.storeManualEntry()` at `apps/backend/src/modules/transactions/transactions.service.ts` (line 443) accepts `operatorId` as a string and sets it as `storeId` without verifying that the caller is a valid `DOKON_OPERATOR` role with an associated store entity. Any authenticated user who calls this endpoint can create fraudulent ISBN scan records for any phone number.
- Files: `apps/backend/src/modules/transactions/transactions.service.ts`
- Trigger: Authenticated API call with any `userId` as `operatorId`.
- Workaround: Restricted by the controller's role guard if applied — needs verification.

**`ReadingIndex` grows unboundedly — no pruning:**
- Symptoms: `ReadingService.recalculateForUser()` in `apps/backend/src/modules/reading/reading.service.ts` (line 131) always `create`s a new `ReadingIndex` record and never deletes old ones. History is capped at `take: 12` for display but the underlying table grows by ~5M rows/night.
- Files: `apps/backend/src/modules/reading/reading.service.ts`, `apps/backend/prisma/schema.prisma`
- Trigger: Daily cron after 30+ days of operation.
- Workaround: None. No migration or cleanup job exists.

**Orphaned `.tmp` file committed alongside test file:**
- Symptoms: `apps/backend/src/modules/ai/__tests__/nlq.service.spec.ts.tmp.17788.1778237664558` is present in the repo. This is a leftover from a crashed editor/tool session and should not be in version control.
- Files: `apps/backend/src/modules/ai/__tests__/nlq.service.spec.ts.tmp.17788.1778237664558`
- Trigger: Pre-existing; appears immediately when cloning.
- Workaround: Delete the file and add `*.tmp` to `.gitignore` (already present in root `.gitignore` but not backend-level).

---

## Security Considerations

**`.env` and `.env.prod` files present in the working tree:**
- Risk: Both `apps/backend/.env` and the root `.env` and `.env.prod` exist on disk. While root `.gitignore` excludes `.env` and `.env.*`, any misconfiguration (force-add, IDE commit, or submodule) could expose secrets. Additionally, `apps/backend/.env` has its own gitignore context that must also exclude it.
- Files: `.env`, `.env.prod`, `apps/backend/.env` (existence noted — contents not read)
- Current mitigation: Root `.gitignore` lists `.env` and `.env.*` (except `.example` variants).
- Recommendations: Add a pre-commit hook (e.g., `detect-secrets` or `gitleaks`) to prevent accidental secret commits. Confirm `apps/backend/.env` is also excluded by the nearest `.gitignore`.

**VaultService falls back silently to `.env` and uses hardcoded `dev-root-token`:**
- Risk: `VaultService` constructor at `apps/backend/src/infra/vault/vault.service.ts` (line 15) uses `"dev-root-token"` as the default Vault token. If `VAULT_TOKEN` env var is not set in production, the service silently falls back to `.env` values for all secrets. This makes Vault optional rather than enforced, defeating its purpose.
- Files: `apps/backend/src/infra/vault/vault.service.ts`
- Current mitigation: None enforced in production. `main.ts` checks `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `REDIS_URL` — but not `VAULT_TOKEN` or `VAULT_ADDR`.
- Recommendations: Add `VAULT_TOKEN` and `VAULT_ADDR` to the production env var assertion in `main.ts` (`_assertEnvVars`). Throw on Vault health failure in production mode.

**Payme webhook methods use `any` typed parameters — no input validation:**
- Risk: All internal Payme handler methods in `apps/backend/src/modules/payment/payme.service.ts` (lines 59, 85, 128, 176, 199, 227) accept `id: any` and `params: any`. No schema validation is applied to webhook body parameters. A malformed request could cause unhandled exceptions or — more critically — `params.account?.invoiceId` being `undefined` causes `prisma.invoice.findUnique({ where: { id: undefined } })` which Prisma may handle unexpectedly.
- Files: `apps/backend/src/modules/payment/payme.service.ts`
- Current mitigation: Global `ValidationPipe` in `main.ts` uses `whitelist: true` but `forbidNonWhitelisted: false` — it strips but does not reject unknown fields. Typed DTOs for webhook body do not exist.
- Recommendations: Create typed DTOs for `PaymeRpcRequest` with class-validator decorators. Replace `any` with specific interfaces for each RPC method's `params`.

**`RolesGuard` allows any route with no `@Roles()` decorator through without authentication:**
- Risk: `RolesGuard.canActivate()` at `apps/backend/src/common/guards/roles.guard.ts` (line 17) returns `true` immediately if no roles are required on the route. This means any route that has `JwtAuthGuard` but not `@Roles()` will pass role checking even if no `JwtAuthGuard` is applied at the module level.
- Files: `apps/backend/src/common/guards/roles.guard.ts`
- Current mitigation: `JwtAuthGuard` is applied globally. However, if a controller omits `@UseGuards(JwtAuthGuard)`, the `RolesGuard` alone will not protect it.
- Recommendations: Audit all controllers for routes missing both guards. Consider setting `JwtAuthGuard` as a global guard in `AppModule` to enforce auth by default, using `@Public()` decorator for open routes.

**`ValidationPipe` has `forbidNonWhitelisted: false` — unexpected fields are silently stripped:**
- Risk: `main.ts` line 68 sets `forbidNonWhitelisted: false`. Extra fields in request bodies are silently ignored rather than rejected. This can mask API misuse and client bugs.
- Files: `apps/backend/src/main.ts`
- Current mitigation: `whitelist: true` strips unknown fields.
- Recommendations: Set `forbidNonWhitelisted: true` in production to surface client errors early and prevent confusion.

---

## Performance Bottlenecks

**Daily RI recalculation iterates all active users serially:**
- Problem: `ReadingService.recalculateAll()` in `apps/backend/src/modules/reading/reading.service.ts` (lines 51–68) runs a `for` loop over all ACTIVE users sequentially, calling `recalculateForUser()` per user. With 5M users, each requiring multiple DB queries, this cron will take hours and block the nightly job.
- Files: `apps/backend/src/modules/reading/reading.service.ts`
- Cause: Sequential async loop with no batching, worker pool, or BullMQ job distribution.
- Improvement path: Distribute recalculation via BullMQ — enqueue one job per user chunk (e.g., 1,000 users/job). Use `concurrency` setting on the worker to process in parallel. Alternatively, use a single raw SQL `UPDATE` with subquery aggregation.

**`dailyFraudScan` iterates up to 10,000 users serially, each with 5 DB queries:**
- Problem: `FraudService.dailyFraudScan()` at `apps/backend/src/modules/ai/fraud.service.ts` (lines 212–246) fetches up to 10,000 active users then calls `analyzeUser()` per user. Each `analyzeUser()` runs 5 parallel DB queries. Total: up to 50,000 DB queries in sequence per night.
- Files: `apps/backend/src/modules/ai/fraud.service.ts`
- Cause: Sequential `for...of` loop with no concurrency control.
- Improvement path: Process in parallel batches using `Promise.all()` with chunk size 50–100. Or distribute via BullMQ.

**`AuditService.runAuditCycle()` runs every 15 minutes with expensive `_buildTumanRiMap()`:**
- Problem: `AuditService` at `apps/backend/src/modules/ai/audit.service.ts` runs a cron every 15 minutes that calls `_buildTumanRiMap()`, loading all ReadingIndex records from the last 60 days with no `take` limit.
- Files: `apps/backend/src/modules/ai/audit.service.ts`
- Cause: No limit on the `findMany` in `_buildTumanRiMap()`. No incremental/differential processing — full scan every 15 minutes.
- Improvement path: Extend to 1-hour interval for the heavy RI map. Add materialized view or scheduled DB aggregation job. Cache the tuman map in Redis for 15 minutes and only rebuild on RI update events.

**`getLeaderboard()` uses raw SQL `DISTINCT ON` then sorts and slices in JavaScript:**
- Problem: `ReadingService.getLeaderboard()` at `apps/backend/src/modules/reading/reading.service.ts` (lines 179–190) fetches all users' latest RI via `$queryRaw`, sorts them in JavaScript, then slices to `limit`. With millions of users, this loads the entire result set into Node.js memory before slicing.
- Files: `apps/backend/src/modules/reading/reading.service.ts`
- Cause: `ORDER BY` in `$queryRaw` sorts by `userId` first (for `DISTINCT ON`), then JS re-sorts by `score`. The `LIMIT` clause is not applied to the raw query.
- Improvement path: Add `LIMIT` to the raw query after the outer sort: wrap in a subquery `SELECT * FROM (...) AS sub ORDER BY score DESC LIMIT $1`.

---

## Fragile Areas

**Book `availableCount` consistency relies on application-level transactions but has multiple code paths:**
- Files: `apps/backend/src/modules/transactions/transactions.service.ts` (reserve, borrow, cancelReservation, returnBook, autoExpireReservations)
- Why fragile: `availableCount` is incremented/decremented across many methods using `$transaction`. If any method throws mid-transaction, Prisma rolls back correctly. However, the `reserve()` method decrements count before the `bookTransaction` record is created — a crash between the two operations (unlikely but possible) could leave count out of sync. The `autoExpireReservations` cron also runs `$transaction([...])` array form (non-interactive), which has different semantics than the callback form used in `returnBook`.
- Safe modification: Always use the Prisma interactive transaction callback form (`$transaction(async (p) => {...})`), not the array form, for multi-step operations. Add a database-level CHECK constraint `availableCount >= 0`.
- Test coverage: `transactions.service.spec.ts` tests exist but coverage of rollback scenarios is not validated.

**`NlqService._parseQuery()` uses keyword matching — fragile for O'zbek language variations:**
- Files: `apps/backend/src/modules/ai/nlq.service.ts` (lines 115–153)
- Why fragile: Intent parsing relies on exact substring matching in Uzbek (e.g., `"qanday"`, `"yo'q"`, `"pasay"`). Uzbek has rich morphology; "qandaydir", "yo'qoldi", "pasaygan" will not match. Region alias matching fails for abbreviated or alternative spellings (e.g., "fergana" maps to `UZ-04` but "Farğona" does not).
- Safe modification: Before expanding keyword lists, add normalization (lowercase, remove diacritics). For new intents, test against real admin query samples.

**SW background sync (`syncPendingTransactions`) sends without authentication:**
- Files: `apps/frontend/public/sw.js` (lines 141–152)
- Why fragile: `syncPendingTransactions()` replays pending transactions stored in IndexedDB by sending `POST /api/transactions` with no `Authorization` header. The backend's `JwtAuthGuard` will reject these with 401.
- Safe modification: Store the access token alongside the pending transaction in IndexedDB. Include it in the replay request. Handle 401 by prompting re-authentication and requeueing.

**`checkTop100Candidates()` iterates 150 users serially and re-analyzes via cache:**
- Files: `apps/backend/src/modules/ai/fraud.service.ts` (lines 165–207)
- Why fragile: Runs on the 29th of every month. The cache TTL on `fraud:analysis:{userId}` is 300 seconds (5 minutes). If this check runs close to or after the daily fraud scan (03:00), results may be stale. Under high load on the 29th, serial processing of 150 users makes this the longest-running admin operation of the month.
- Safe modification: Run `checkTop100Candidates()` after cache invalidation or increase cache TTL awareness. Add a completion status indicator so admins know the check is in progress.

---

## Scaling Limits

**In-memory OTP rate limiter:**
- Current capacity: 1 instance, 5 OTPs/hour/phone.
- Limit: Breaks immediately in multi-instance (horizontal scale) deployments — each instance has its own `Map`.
- Scaling path: Move to Redis-backed rate limiting (already have `CacheService`). Use `INCR` + `EXPIRE` pattern.

**`ReadingIndex` table unbounded growth:**
- Current capacity: ~5M rows/night × 365 days = ~1.8B rows/year with no cleanup.
- Limit: Query performance on `ORDER BY calculatedAt DESC` degrades exponentially. The `ReadingIndex` table has no index on `userId + calculatedAt` combined.
- Scaling path: Add `@@index([userId, calculatedAt])` to `ReadingIndex` in `apps/backend/prisma/schema.prisma`. Add a scheduled job to archive/delete records older than 13 months. Consider using TimescaleDB or partitioning by month.

**`RefreshToken` table grows with every login — no cleanup:**
- Current capacity: Every login creates a row in `RefreshToken`. Logout and rotation revoke records but do not delete them.
- Limit: With 5M users logging in regularly, the table grows to hundreds of millions of rows. Queries on `{ token, revoked: false }` slow down.
- Scaling path: Add a scheduled cron to `DELETE FROM RefreshToken WHERE expiresAt < NOW() OR revoked = true`. Add `@@index([expiresAt])` to `RefreshToken` schema.

---

## Dependencies at Risk

**`node-vault` for HashiCorp Vault — last major update 2021:**
- Risk: `node-vault` (used in `apps/backend/src/infra/vault/vault.service.ts`) has limited maintenance activity. The official HashiCorp Vault client for Node.js is now `@hashicorp/vault-client-node`. Using an unmaintained wrapper for secrets management is a security risk.
- Impact: Security patches for Vault API changes or TLS updates may not be available.
- Migration plan: Replace with the official `@hashicorp/vault-client-node` package or direct HTTP calls with `node-fetch`.

**`forbidNonWhitelisted: false` in ValidationPipe is a silent API contract weakness:**
- Risk: Future API clients may rely on fields being silently accepted when they should be rejected, making it harder to enforce strict contracts later.
- Impact: Changing to `true` in the future becomes a breaking change for any client sending extra fields.
- Migration plan: Enable immediately (before public client usage grows) in `apps/backend/src/main.ts`.

---

## Missing Critical Features

**No inter-library book transfer mechanism in the data model:**
- Problem: The TZ describes "Roaming" return triggering an inter-library transfer so the source library can reclaim the book. `returnRoaming()` in `apps/backend/src/modules/transactions/transactions.service.ts` (line 333) sends an SMS notification but creates no transfer record. The source library's `availableCount` is incremented at the return library, not the home library.
- Blocks: The home library's fund count becomes inaccurate after a roaming return. No mechanism exists for the home library to confirm receipt.

**No push notification (FCM) integration — only placeholder:**
- Problem: `NotificationProcessor.sendPush()` is a debug-only stub. Firebase FCM (`firebase-admin`) is not installed or configured.
- Blocks: Sprint 4 requirement "Push bildirishnomalar — Firebase FCM" is unmet. Bron confirmation, overdue alerts, and Top-100 announcements cannot be pushed to mobile.

**No Mutolaa platform API client — only an inbound sync endpoint:**
- Problem: `ReadingService.syncMutolaaProgress()` in `apps/backend/src/modules/reading/reading.service.ts` (line 151) is an inbound handler but there is no outbound HTTP client or scheduler that polls/subscribes to Mutolaa events. The sync depends on Mutolaa calling the platform, not the platform polling Mutolaa.
- Blocks: If Mutolaa does not implement the callback, reading progress from the platform is never recorded.

**No data retention / GDPR-equivalent deletion flow:**
- Problem: The TZ notes users can delete their data. No `DELETE /users/me` endpoint exists, no cascade soft-delete strategy is implemented, and `DELETED` user status in the schema does not clean up associated PII (address, phone, name).
- Blocks: O'zbekiston personal data law compliance (required by server localization clause). Users cannot exercise the right to erasure.

---

## Test Coverage Gaps

**Branch coverage at 75.17% — well below production-safe threshold:**
- What's not tested: 24.83% of branches are untested. Key paths include: payment webhook error branches (Payme `CancelTransaction`, `GetStatement` edge cases), fraud detection boundary conditions (score exactly at 70), RI formula edge cases (0 borrows, exactly 5 genres).
- Files: `apps/backend/src/coverage/lcov-report/index.html` (75.17% branches, 80.77% functions)
- Risk: Payment processing failures, fraud misclassification at boundaries, and RI calculation errors go undetected.
- Priority: High. Payment and fraud paths must reach 90%+ branch coverage before V1.0.

**Controller layer has no tests — only service layer is tested:**
- What's not tested: No test files exist for any controller (`auth.controller.ts`, `books.controller.ts`, `libraries.controller.ts`, `transactions.controller.ts`, `payment.controller.ts`, etc.). Request validation, guard application, and response shaping are all untested.
- Files: All `apps/backend/src/modules/*/` controller files.
- Risk: Incorrect HTTP status codes, missing auth guards on sensitive endpoints, and malformed response shapes reach production undetected.
- Priority: High for auth, payment, and transactions controllers.

**Frontend has zero automated tests:**
- What's not tested: No test files (`*.test.tsx`, `*.spec.tsx`) exist in `apps/frontend/`. No Playwright E2E tests. No component unit tests.
- Files: `apps/frontend/` entire directory.
- Risk: Registration flow regressions, locale switching failures, and dashboard rendering errors are caught only manually.
- Priority: High for critical user flows (registration, login, bron, QR scan).

**Service Worker offline sync (`syncPendingTransactions`) is untested:**
- What's not tested: The background sync logic in `apps/frontend/public/sw.js` (lines 141–152) is hand-written JavaScript with no tests. IndexedDB interaction, retry behavior, and auth header handling are all unverified.
- Files: `apps/frontend/public/sw.js`
- Risk: Offline transactions are silently lost or duplicated when sync fires. This is the primary reliability mechanism for rural/offline librarians.
- Priority: High — core offline use case for the platform.

---

*Concerns audit: 2026-06-06*
