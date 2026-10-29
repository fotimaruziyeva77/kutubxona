# Pitfalls Research -- SIFAT Library

**Domain:** National-scale library management, reading index, and gamification platform (Uzbekistan)
**Researched:** 2026-06-06
**Overall confidence:** HIGH (grounded in codebase audit + domain research + Uzbekistan-specific sources)

---

## Executive Summary

SIFAT Library faces pitfalls across eight interconnected domains. The most dangerous are not the obvious ones (scaling, AI) but the ones that silently accumulate: **fraud detection that blocks legitimate users**, **offline sync that loses librarian transactions**, **comprehension tests that provide zero fraud protection**, and **database tables that grow without bound until they crash the system**.

The codebase audit reveals that several critical pitfalls are already present in the code: the comprehension test always puts correct answers at index 0, the fraud system auto-blocks users without admin review, the offline sync replays transactions without authentication tokens, and the ReadingIndex table grows by ~5M rows per night with no cleanup. These are not hypothetical -- they are ticking time bombs.

The government compliance dimension adds Uzbekistan-specific constraints: data localization requirements (recently relaxed but still strict for biometric/genetic data), PQ-9 decree mandates that create political pressure to show results (tempting shortcuts in fraud detection), and a target user base that includes rural areas with 2G connectivity where most modern web assumptions fail.

---

## Critical Pitfalls (Must Address Before Launch)

### C1: Comprehension Test Provides Zero Fraud Protection

**What goes wrong:** The comprehension test -- the primary defense against fake ISBN scan reads -- always places the correct answer at `answerIdx: 0` for all 3 questions. The third question literally asks "Did you read the entire book?" with "Yes" at index 0. Any automated script submitting `[0, 0, 0]` passes every test. With 25x BHM (minimum wage) prizes at stake in Top-100, this will be exploited within days of launch.

**Why it happens:** Quick placeholder implementation during Sprint 4 scaffolding. The questions are not book-specific -- they use only `title` and `author` metadata, not actual content.

**Consequences:**
- Top-100 rankings filled with fraudulent readers
- Government credibility destroyed (PQ-9 decree promises transparent rankings)
- Legitimate readers demotivated when they see fake accounts winning prizes
- Once fraud is public, restoring trust is nearly impossible

**Prevention:**
1. Randomize correct answer position using `Math.floor(Math.random() * options.length)` and shuffle options
2. Generate book-specific content questions using GPT-4 API (the NLQ module already integrates it)
3. Require minimum 5 questions, present random subset of 3
4. Add time-based anti-bot measures (minimum 5 seconds per question)
5. For high-stakes scenarios (Top-100 candidates), require a written summary analyzed by AI

**Detection:** Monitor pass rate. If >95% of users pass on first attempt, the test is trivially gameable.

**Sprint mapping:** Sprint 5 (Reading Index). Must be fixed before Top-100 goes live.

**Severity:** CRITICAL -- directly undermines the core value proposition of the platform.

**Confidence:** HIGH -- verified in codebase at `transactions.service.ts` lines 702-720.

---

### C2: Auto-Blocking Users Without Admin Review

**What goes wrong:** The `dailyFraudScan` cron (03:00 daily) automatically sets `user.status = "BLOCKED"` for any user with `riskScore >= 70`, with no human review step. The TZ explicitly states fraud detection should feed into a Top-100 review workflow, not instant account blocking. A legitimate user who reads several books after a vacation gap triggers `RI_SPIKE` (20 points) + multiple quick returns (12 points) + high activity (15 points) = 47+ points from normal behavior, and any additional flag pushes them over 70.

**Why it happens:** The RI_SPIKE rule compares `riRecords[0].score - riRecords[riRecords.length-1].score` across the last 5 records, not today vs. yesterday. A user inactive for 5 days then active for 1 day triggers a false positive. Combined with auto-blocking, legitimate users are silently blocked at 3 AM with no notification.

**Consequences:**
- Legitimate power readers blocked during Top-100 competition periods
- No notification sent (SMS/Push are stubbed -- see C3)
- Users cannot appeal because they do not know they are blocked
- Government officials discover their accounts blocked, causing political fallout

**Prevention:**
1. Replace auto-block with a `FLAGGED` status that requires admin review
2. Fix RI_SPIKE to compare consecutive days, not arbitrary 5-record windows
3. Add a "fraud review queue" in admin panel with approve/reject workflow
4. Never auto-block users with Trust Score > 70 -- flag only
5. Send notification (once SMS is working) before any status change

**Detection:** Monitor the ratio of blocks to flags. If >10% of flagged users are later unblocked by admins, the threshold is too aggressive.

**Sprint mapping:** Sprint 8 (AI/Fraud). But the auto-block bug should be fixed immediately.

**Severity:** CRITICAL -- blocks legitimate users, causes political and PR damage.

**Confidence:** HIGH -- verified in codebase at `fraud.service.ts` lines 212-246 and lines 100-111.

---

### C3: Notification System is Completely Non-Functional

**What goes wrong:** The entire notification pipeline -- SMS, Push, Email -- consists of debug-only stubs. The `@Processor()` decorator is commented out on `NotificationProcessor`. Every `SmsService.sendOtp()` call enqueues a job that silently disappears. This means:
- OTP codes for registration never arrive
- Bron confirmations never sent
- Overdue reminders never delivered
- Fraud block notifications never sent
- Top-100 announcements never reach users

**Why it happens:** Placeholder implementation waiting for Eskiz.uz API credentials and Firebase FCM setup.

**Consequences:**
- Phone verification (the entire registration flow) is broken in any real deployment
- Users cannot complete registration, making the platform unusable
- Overdue books accumulate without user awareness
- Trust in the platform erodes when expected notifications do not arrive

**Prevention:**
1. Integrate Eskiz.uz or SMS.uz HTTP API immediately (this blocks MVP)
2. Re-enable the `@Processor(NOTIFICATION_QUEUE)` decorator
3. Add Firebase FCM for push notifications
4. Add Nodemailer/SMTP for email
5. Add a notification status dashboard so admins can see delivery rates

**Detection:** If registration completion rate drops below 30%, notifications are failing.

**Sprint mapping:** Sprint 2 (Auth) -- this is a Sprint 2 deliverable that was never completed.

**Severity:** CRITICAL -- blocks the entire user registration flow.

**Confidence:** HIGH -- verified in codebase at `notification.processor.ts`.

---

### C4: Offline Sync Replays Transactions Without Authentication

**What goes wrong:** The Service Worker `syncPendingTransactions()` function replays offline transactions via `fetch("/api/transactions", { method: "POST", body: ... })` with no `Authorization` header. The backend `JwtAuthGuard` rejects these with 401. Every transaction made while offline is silently lost.

**Why it happens:** The SW was implemented without considering that JWT tokens need to be stored alongside pending transactions in IndexedDB and included in replay requests.

**Consequences:**
- Rural librarians who work offline for hours lose all their book lending records
- Trust in the system collapses for the exact users who need offline support most
- Inventory counts become inaccurate (books marked as available that are actually lent out)
- No error feedback to the librarian -- transactions silently fail during background sync

**Prevention:**
1. Store the JWT access token alongside each pending transaction in IndexedDB
2. Include the `Authorization: Bearer ${token}` header in replay requests
3. Handle 401 by prompting re-authentication and requeueing (not discarding)
4. Add a visible sync status indicator in the UI ("3 transactions pending sync")
5. Add an "offline transaction log" that persists even after failed sync attempts
6. Implement token refresh logic in the SW using the refresh token

**Detection:** Compare offline transaction count with successful sync count. Any >0 delta means data loss.

**Sprint mapping:** Sprint 10 (PWA offline full). But the auth header fix is a 10-minute change that should happen now.

**Severity:** CRITICAL -- data loss for the most vulnerable user segment (rural librarians).

**Confidence:** HIGH -- verified in codebase at `sw.js` lines 141-152.

---

### C5: ReadingIndex Table Grows Without Bound -- Database Time Bomb

**What goes wrong:** `recalculateForUser()` always creates a new `ReadingIndex` record and never deletes old ones. With 5M users and nightly recalculation:
- Day 1: 5M rows
- Day 30: 150M rows
- Day 365: 1.8B rows
- No cleanup job exists. No pruning. No archival.

The table has no composite index on `(userId, calculatedAt)`, so queries that filter by user and order by date do full table scans as the table grows.

**Why it happens:** The display layer uses `take: 12` to show recent history, masking the underlying growth. In development with seed data, the problem is invisible.

**Consequences:**
- Within 60-90 days of production launch, the nightly RI cron starts taking hours instead of minutes
- `_buildTumanRiMap()` (which loads ALL RI records from the last 60 days) will attempt to load 300M+ rows into memory -- OOM crash
- Leaderboard queries become unusably slow
- Database storage costs grow linearly with no ceiling

**Prevention:**
1. Add `@@index([userId, calculatedAt])` to the Prisma schema immediately
2. Create a monthly cleanup job: keep last 13 months of daily records, archive older to cold storage
3. Consider PostgreSQL range partitioning by month on the ReadingIndex table
4. Move `_buildTumanRiMap()` to a PostgreSQL `GROUP BY` aggregation instead of loading rows into Node.js
5. Add a `ReadingIndexMonthly` materialized view for historical trend queries

**Detection:** Monitor table row count weekly. If growth exceeds 5M rows/day, something is wrong.

**Sprint mapping:** Sprint 5 (Reading Index engine) -- must be addressed when the real engine goes live.

**Severity:** CRITICAL -- will crash the database within 2-3 months of launch.

**Confidence:** HIGH -- verified in codebase at `reading.service.ts` line 131 and CONCERNS.md.

---

### C6: Nightly RI Recalculation is Sequential -- Will Take Days at Scale

**What goes wrong:** `recalculateAll()` runs a `for` loop over ALL active users sequentially, calling `recalculateForUser()` per user. Each call makes 2+ DB queries (transactions + ISBN scans) plus a `create` for the new RI record. With 5M users at ~50ms per user: **~69 hours** to complete. The cron fires at midnight but will not finish before the next midnight.

**Why it happens:** Works fine with seed data (hundreds of users). No load testing done yet.

**Consequences:**
- RI scores are always stale (never finished recalculating)
- The midnight cron overlaps with itself, creating duplicate RI records
- Database under constant load from sequential queries, degrading all other API performance
- Top-100 rankings based on stale data

**Prevention:**
1. Distribute recalculation via BullMQ: enqueue batches of 1,000 users per job
2. Use `concurrency: 10` on the BullMQ worker to process batches in parallel
3. Better yet: replace per-user queries with a single SQL `INSERT INTO reading_index SELECT ...` using `GROUP BY userId` with subquery aggregation
4. Add a "last recalculated" timestamp visible in admin panel
5. If full recalculation takes >2 hours, only recalculate users who had activity in the last 24 hours (incremental approach)

**Detection:** Add timing logs to the cron. If recalculation takes >30 minutes, it is a scaling problem.

**Sprint mapping:** Sprint 5 (Reading Index engine).

**Severity:** CRITICAL -- makes the core feature (Reading Index) unreliable at scale.

**Confidence:** HIGH -- verified in codebase at `reading.service.ts` lines 51-68.

---

## High-Risk Pitfalls (Address in Current Sprint)

### H1: Payme Webhook Accepts Untyped `any` Parameters -- Financial Security Risk

**What goes wrong:** All Payme handler methods accept `id: any` and `params: any` with no schema validation. A malformed webhook payload with `params.account?.invoiceId` as `undefined` causes `prisma.invoice.findUnique({ where: { id: undefined } })`. Depending on Prisma version behavior, this could return null (safe) or throw an unhandled error (unsafe). More critically, an attacker who can send crafted webhook payloads could manipulate transaction states.

**Why it happens:** Payme's JSON-RPC protocol uses dynamic method dispatch, tempting developers to use `any` for flexibility.

**Consequences:**
- Financial data integrity compromised
- Subscription activations for unpaid invoices
- Unhandled exceptions in production payment flow

**Prevention:**
1. Create typed DTOs: `CheckPerformTransactionDto`, `CreateTransactionDto`, etc.
2. Validate with class-validator decorators
3. Add HMAC signature verification using Payme merchant key
4. Log all webhook payloads to an append-only audit table
5. Add idempotency keys to prevent duplicate transaction processing

**Sprint mapping:** Sprint 9 (Payme/Click integration).

**Severity:** HIGH -- financial integrity risk.

**Confidence:** HIGH -- verified in codebase at `payme.service.ts` lines 59-227.

---

### H2: Store Manual Entry Endpoint Allows Any User to Create Fake ISBN Records

**What goes wrong:** `storeManualEntry()` accepts `operatorId` as a string without verifying the caller is a valid `DOKON_OPERATOR` with an associated store entity. Any authenticated user who can call this endpoint can create fraudulent ISBN scan records for any phone number, inflating their own Reading Index.

**Why it happens:** The role guard may be applied at the controller level, but the service-level code has no authorization check. If the controller guard is misconfigured or missing, the endpoint is wide open.

**Consequences:**
- Massive fraud vector: users create fake store purchases to boost RI
- Top-100 rankings manipulated
- Store partners lose trust when fake records appear under their store ID

**Prevention:**
1. Verify `operatorId` matches the authenticated user ID
2. Verify the user has `DOKON_OPERATOR` role AND an associated store entity
3. Rate-limit: max 20 entries per operator per day
4. Require the target user (phone owner) to confirm within 24 hours
5. Audit all store entries with anomaly detection (same operator, many different phones = suspicious)

**Sprint mapping:** Sprint 4 (Book processes) or Sprint 9 (Store API).

**Severity:** HIGH -- fraud vector that bypasses all other fraud detection.

**Confidence:** HIGH -- verified in codebase at `transactions.service.ts` line 443.

---

### H3: OTP Rate Limiting Uses In-Memory Map -- Resets on Every Deploy

**What goes wrong:** `AuthService.sendLog` is a `Map<string, number[]>` in process memory. In a horizontally scaled deployment (multiple instances behind a load balancer), each instance has its own map. An attacker can exhaust SMS quota by distributing requests across instances. Worse, every zero-downtime deploy (Rolling update in Sprint 10) resets the map entirely.

**Consequences:**
- SMS cost explosion from automated OTP abuse
- Denial of service for legitimate users (SMS quota exhausted)
- Potential for phone number enumeration attacks

**Prevention:**
1. Move to Redis: `INCR otp:ratelimit:{phone}` with `EXPIRE 3600`
2. Use `CacheService` (already exists) for rate limiting
3. Add IP-based rate limiting as a second layer
4. Add daily SMS budget alerts (if >10,000 SMS sent, alert admin)

**Sprint mapping:** Sprint 2 (Auth system) -- should have been Redis from the start.

**Severity:** HIGH -- financial risk (SMS costs) and security risk.

**Confidence:** HIGH -- verified in codebase at `auth.service.ts` line 23.

---

### H4: `availableCount` Consistency Across Multiple Code Paths

**What goes wrong:** The book `availableCount` field is incremented/decremented across 5+ code paths: `reserve()`, `borrow()`, `cancelReservation()`, `returnBook()`, `autoExpireReservations()`. The `reserve()` method decrements count before the `bookTransaction` record is created. A crash between these two operations leaves the count permanently desynchronized. Additionally, `autoExpireReservations` uses the array transaction form (weaker semantics) while `returnBook` uses the callback form.

**Consequences:**
- Books shown as "available" when they are actually lent out (or vice versa)
- Librarians and users lose trust in the catalog accuracy
- Over time, drift accumulates and inventory audits show 5%+ discrepancy (triggering fraud alerts against the library itself)

**Prevention:**
1. Use interactive Prisma transactions (`$transaction(async (p) => {...})`) everywhere
2. Add a database-level CHECK constraint: `availableCount >= 0`
3. Add a nightly reconciliation cron: count active BORROWED records per book, compare with `totalCount - availableCount`
4. Log every count change with before/after values for audit trail

**Sprint mapping:** Sprint 4 (Book processes).

**Severity:** HIGH -- inventory accuracy is foundational for library operations.

**Confidence:** HIGH -- verified in codebase.

---

### H5: Vault Fallback to `.env` with Hardcoded Dev Token

**What goes wrong:** `VaultService` uses `"dev-root-token"` as the default Vault token. If `VAULT_TOKEN` is not set in production, the service silently falls back to `.env` values. This makes HashiCorp Vault entirely optional, defeating its purpose.

**Consequences:**
- Secrets stored in plaintext files instead of Vault
- No secret rotation capability
- If `.env` leaks (git misconfiguration, server breach), all secrets compromised
- Government audit failure (PQ-9 requires data security standards)

**Prevention:**
1. Add `VAULT_TOKEN` and `VAULT_ADDR` to `_assertEnvVars()` in `main.ts`
2. Throw on Vault health check failure in production mode
3. Remove the hardcoded `"dev-root-token"` -- use environment-specific configuration
4. Add a pre-commit hook with `detect-secrets` or `gitleaks`

**Sprint mapping:** Sprint 1 (Infrastructure) -- overdue.

**Severity:** HIGH -- security and compliance risk.

**Confidence:** HIGH -- verified in codebase at `vault.service.ts` line 15.

---

### H6: `extendDueDate` Uses Magic Number `-1` -- Extended Books Escape Penalty System

**What goes wrong:** `extendDueDate()` sets `penaltyDays: -1` as a sentinel meaning "already extended." But `penaltyDays` is used elsewhere to track actual late days. The `blockOverdueUsers` cron checks `penaltyDays >= 0` -- so extended books are excluded from overdue processing entirely. A user who extends once and then returns 30 days late faces zero consequences.

**Consequences:**
- Users game the system by always extending, then returning late without penalty
- Trust Score calculations are wrong for users who extend
- Overdue book alerts never fire for extended books

**Prevention:**
1. Add a separate `extended Boolean @default(false)` column to `BookTransaction`
2. Remove the magic `-1` from `penaltyDays`
3. Fix `blockOverdueUsers` to check extended books against extended due date
4. Also fix: `extendDueDate` allows unlimited extensions (no check for existing extension)

**Sprint mapping:** Sprint 4 (Book processes).

**Severity:** HIGH -- gaming vector for overdue system.

**Confidence:** HIGH -- verified in codebase at `transactions.service.ts` lines 251-266.

---

### H7: WebSocket Messages Lost in Multi-Instance Production

**What goes wrong:** With 3+ NestJS replicas behind Nginx, Socket.IO messages emitted on instance #1 are never received by clients connected to instance #2 or #3. Socket.IO uses in-memory adapter by default.

**Consequences:** Admins see stale dashboards. Alert notifications are unreliable. Top-100 live updates only reach a fraction of users.

**Prevention:**
1. Install `@socket.io/redis-adapter` before production deployment
2. Configure Nginx with sticky sessions (`ip_hash` or cookie-based)
3. Test with multiple backend instances in staging environment

**Sprint mapping:** Sprint 6 (Real-time statistics).

**Severity:** HIGH -- breaks real-time monitoring for admins.

---

### H8: Payme 12-Hour Transaction Timeout Not Enforced

**What goes wrong:** Payme creates a transaction via `CreateTransaction`, but the user never completes payment. Without timeout enforcement, the transaction stays PENDING forever, blocking the invoice.

**Consequences:** Invoices stuck in limbo. Subscriptions never activate. Buxgalter panel shows ghost transactions.

**Prevention:**
1. Add BullMQ delayed job: on `CreateTransaction`, schedule cancel job for 12 hours later
2. If `PerformTransaction` arrives, remove the delayed cancel job
3. If timeout fires: auto-cancel payment, revert invoice to UNPAID
4. Daily reconciliation cron: compare Payme `GetStatement` with local records

**Sprint mapping:** Sprint 9 (Payments).

**Severity:** HIGH -- financial integrity.

---

## Medium-Risk Pitfalls (Plan for V1.0)

### M1: RolesGuard Allows Undecorated Routes Through Without Auth Check

**What goes wrong:** `RolesGuard.canActivate()` returns `true` immediately if no `@Roles()` decorator is present. If a controller route omits both `@UseGuards(JwtAuthGuard)` and `@Roles()`, it is completely unprotected. With 20 controllers and growing, the probability of a missed guard increases.

**Prevention:**
1. Set `JwtAuthGuard` as a global guard in `AppModule`
2. Use a `@Public()` decorator for intentionally open routes
3. Audit all 20 controllers for missing guards
4. Add an integration test that verifies every non-public route requires auth

**Sprint mapping:** Sprint 10 (Security penetration testing).

**Severity:** MEDIUM -- depends on whether any routes are currently unguarded.

---

### M2: Uzbek NLP Keyword Matching is Brittle for Agglutinative Morphology

**What goes wrong:** `NlqService._parseQuery()` uses exact substring matching for Uzbek intent parsing: `"qanday"`, `"yo'q"`, `"pasay"`. Uzbek is agglutinative -- suffixes change meaning: "qandaydir" (somehow), "yo'qoldi" (disappeared), "pasaygan" (which has decreased). The current parser misses these common variations. Region aliases also fail for alternative spellings ("Farghona" vs "Fergana" vs "Farg'ona").

**Prevention:**
1. Add Unicode normalization (lowercase, remove diacritics) as a preprocessing step
2. Use stemming or lemmatization for Uzbek (research shows BERT-based POS taggers exist)
3. Consider GPT-4 for intent classification instead of keyword matching -- the NLQ module already integrates GPT-4
4. Build a test corpus from real admin queries before expanding keyword lists
5. For region matching, add an alias table with all known spellings (Latin, Cyrillic, colloquial)

**Sprint mapping:** Sprint 8 (AI system).

**Severity:** MEDIUM -- admin-facing feature, not user-facing.

---

### M3: RefreshToken Table Grows Unbounded

**What goes wrong:** Every login creates a `RefreshToken` row. Logout and rotation revoke tokens but never delete them. With 5M users logging in regularly, the table grows to hundreds of millions of rows.

**Prevention:**
1. Add a scheduled cron: `DELETE FROM RefreshToken WHERE expiresAt < NOW() OR revoked = true`
2. Add `@@index([expiresAt])` to the schema
3. Run cleanup daily, targeting tokens expired >7 days ago

**Sprint mapping:** Sprint 2 (Auth system).

**Severity:** MEDIUM -- performance degradation over months, not immediate.

---

### M4: Leaderboard Query Loads Entire Result Set Into Memory

**What goes wrong:** `getLeaderboard()` fetches ALL users' latest RI via `$queryRaw`, sorts in JavaScript, then slices to `limit`. With millions of users, this loads the entire result set into Node.js memory before slicing.

**Prevention:**
1. Wrap the raw query in a subquery: `SELECT * FROM (...) AS sub ORDER BY score DESC LIMIT $1`
2. Add `OFFSET` for pagination support
3. Cache the Top-100/Top-1000 in Redis with 1-hour TTL

**Sprint mapping:** Sprint 5 (Reading Index/Top-100).

**Severity:** MEDIUM -- performance issue that compounds with user growth.

---

### M5: PWA Service Worker Caches Stale Auth State

**What goes wrong:** Service Worker caches API responses including auth-gated data. After token expiry or logout, SW serves stale cached data from a previous session.

**Prevention:**
1. Never cache authenticated API responses with CacheFirst strategy
2. Use NetworkFirst for all API calls, fall back to IndexedDB for offline
3. Clear all caches on logout
4. Include user ID in IndexedDB keys to prevent cross-user data leakage

**Sprint mapping:** Sprint 10 (PWA offline full).

**Severity:** MEDIUM -- security/privacy risk in shared device scenarios.

---

### M6: PDF Report Memory Pressure

**What goes wrong:** Generating monthly PDF reports for 200+ districts simultaneously exhausts server memory. Puppeteer launches headless Chrome per render.

**Prevention:**
1. Queue PDF generation via BullMQ with concurrency limit of 2-3
2. Reuse browser instance: launch once, create new pages per PDF
3. Consider `browserless` Docker container for dedicated PDF rendering
4. Close pages immediately after PDF buffer is extracted

**Sprint mapping:** Sprint 6 (Statistics/Reports).

**Severity:** MEDIUM -- monthly operational risk.

---

## Uzbekistan-Specific Challenges

### UZ1: Data Localization -- Relaxed But Still Strict for Biometrics

**What goes wrong:** As of 2026, Uzbekistan has relaxed its data localization rules (amendments to Article 27 of the Personal Data law). General personal data can now be stored abroad under certain conditions. However, **biometric data** (fingerprints, face images including Face ID, voice samples), **genetic data**, and **telecommunications metadata** must remain exclusively on Uzbekistan servers.

For SIFAT Library:
- QR code data (contains user identifiers): must stay local
- User photos (if profile photos are added): could be classified as biometric (face images)
- Voice-based comprehension tests (if ever added): biometric
- All standard PII (name, phone, address): already planned for Unicon.uz/TIF DC

**Prevention:**
1. Keep all data on Unicon.uz/TIF DC as already planned -- satisfies even the strictest interpretation
2. Use Cloudflare ONLY as CDN (no data processing at edge)
3. Never store user photos or biometric data outside Uzbekistan
4. Document data residency architecture for government audit
5. If adding profile photos or any biometric feature, conduct a specific data classification review

**Confidence:** HIGH -- verified via Library of Congress legal monitor, Dentons analysis, and Settle Advisory.

---

### UZ2: PQ-9 Political Pressure Creates Incentive to Fake Results

**What goes wrong:** The PQ-9 decree creates specific targets (10 books per person per year, Top-100 rankings, provincial performance metrics). Government officials at every level have career incentives to show good numbers. This creates systemic pressure to:
- Under-report fraud to keep numbers high
- Pressure libraries to inflate artificial check-out/check-in cycles
- Create ghost accounts with fake reading activity
- Disable fraud detection in "their" province

**Prevention:**
1. Fraud detection must be centralized and cannot be disabled by provincial admins
2. Audit logs must be append-only and accessible only to Super Admin
3. Add anomaly detection for suspicious provincial patterns (sudden 200% increase in one tuman)
4. Publish methodology publicly so external observers can verify
5. Add a "whistleblower" mechanism for librarians to report pressure to fake data

**Sprint mapping:** Sprint 8 (AI/Fraud) and Sprint 5 (Reading Index).

**Severity:** HIGH -- existential risk to platform credibility.

---

### UZ3: Rural Infrastructure Realities

**What goes wrong:** The platform assumes rural Uzbekistan has reliable smartphone access, 2G+ connectivity, and stable electricity. Reality:
- Some regions have intermittent electricity (especially in winter)
- Older phones have limited IndexedDB storage (as low as 50MB)
- 2G connections may drop mid-transaction
- Some librarians may not own smartphones
- SMS delivery in rural areas can be delayed by hours

**Prevention:**
1. PWA offline mode must be tested on actual 2G networks with old Android devices (not emulated)
2. Limit IndexedDB cache to essential data only (specific library catalog, not all 2,000+ libraries)
3. Add a USSD fallback for book check-in/check-out (text-message based, no smartphone needed)
4. Design the "paper fallback" protocol: what paper records to keep, how to enter them later
5. Test offline sync with 12-hour offline periods, not just 30-second simulations

**Sprint mapping:** Sprint 10 (PWA offline full) and Sprint 3 (Offline rejim asosi).

**Severity:** HIGH -- affects 30-40% of target libraries.

---

### UZ4: Multi-Script Support is Harder Than Translation

**What goes wrong:** O'zbek Latin, O'zbek Cyrillic, Qoraqalpoq, and Russian involve:
- Different character sets and keyboard layouts
- Book titles in mixed scripts (classic books in Cyrillic, new ones in Latin)
- Search must work across scripts: user types "Navoi" in Latin, finds the Cyrillic form
- Transliteration is not 1:1 (some letters have no direct equivalent)
- Database content needs to be searchable in both scripts

**Prevention:**
1. Implement transliteration layer in Elasticsearch: index both Latin and Cyrillic forms
2. Add a transliteration function for user search queries
3. Store canonical form in one script with computed transliteration field
4. Test search with mixed-script queries specifically
5. Do NOT assume i18n libraries handle transliteration -- they handle UI strings, not content search

**Sprint mapping:** Sprint 10 (Multi-language) and Sprint 3 (Elasticsearch).

**Severity:** MEDIUM -- functional degradation, not system failure.

---

### UZ5: Timezone Mismatch in Nightly Crons

**What goes wrong:** Server is UTC, users in UTC+5 (Tashkent). "Midnight" cron runs at 19:00 Uzbekistan time, well within active hours.

**Prevention:**
1. Use `@Cron('0 19 * * *')` in UTC to match midnight UZ+5
2. Or configure `TZ=Asia/Tashkent` in Docker environment variables
3. Test all cron schedules against Uzbekistan business hours

**Sprint mapping:** Sprint 1 (Infrastructure).

**Severity:** MEDIUM -- affects RI freshness and fraud scan timing.

---

## Fraud and Gaming Prevention

### F1: The Fundamental Fraud Problem -- Monetary Incentives for Gaming

Top-100 readers receive prizes worth 25x BHM (minimum wage). This creates a financial incentive to game the system that far exceeds typical reading program incentives.

**Attack vectors identified:**
1. **Borrow-return cycling:** Check out a book, return it in 2 hours, repeat. Current detection (`QUICK_RETURNS` flag) only adds 12 points per 2 quick returns -- insufficient deterrent
2. **Comprehension test bypass:** Always submit `[0, 0, 0]` (see C1)
3. **Store manual entry fraud:** Any authenticated user can create fake store purchases (see H2)
4. **Multiple account fraud:** Register multiple phones, spread reading across accounts
5. **Librarian collusion:** A librarian checks out/in books for a friend without actual reading
6. **Family manipulation:** Join a "family" with high-reading members to boost family ranking
7. **Account farming:** Buy pre-registered accounts from farmers

**Prevention strategy (layered):**
- Layer 1: Fix comprehension tests (C1) -- primary defense
- Layer 2: Add time-based plausibility checks (minimum hold time proportional to page count)
- Layer 3: Location verification (GPS of check-out should be near library)
- Layer 4: Cross-reference patterns (same device ID across multiple accounts)
- Layer 5: Top-100 human interview requirement (the TZ already plans this)
- Layer 6: Monthly fraud review by independent audit team

---

### F2: RI Formula Rewards Quantity Over Quality

**What goes wrong:** The Reading Index formula weights "Kitoblar soni" (book count) at 30% -- the heaviest single factor. This incentivizes reading many short, easy books rather than engaging with substantive material.

**Prevention:**
1. Weight book complexity: page count, reading level, genre difficulty
2. Add a "pages read" component that normalizes across book lengths
3. Consider a logarithmic scale for book count: diminishing returns after 5 books/month
4. The "Janr xilma-xilligi" component (15%) partially addresses this but is insufficient alone

**Sprint mapping:** Sprint 5 (Reading Index formula tuning).

---

### F3: Dynamic QR Codes Must Actually Be Dynamic

**What goes wrong:** Static QR screenshots can be shared and reused if HMAC timestamp validation is not properly implemented on the backend.

**Prevention:**
1. QR payload: `{userId}:{timestamp}:{HMAC-SHA256(userId+timestamp, secret)}`
2. Backend validation: reject if `now - timestamp > 300 seconds`
3. Require librarian device GPS proximity check (optional but recommended)
4. Log all QR scan attempts with timestamp and location for anomaly detection

**Sprint mapping:** Sprint 4 (QR code system).

---

## Offline/Rural Deployment

### O1: IndexedDB Storage Limits on Low-End Devices

**What goes wrong:** On older Android devices common in rural Uzbekistan, browser storage quotas can be as low as 50-100MB. Caching the entire 2,000-library catalog exceeds quota and silently fails.

**Prevention:**
1. Only cache the specific library's catalog (not all libraries)
2. Implement storage quota checking before caching (`navigator.storage.estimate()`)
3. Prioritize: pending transactions > current library catalog > user profile > everything else
4. Add a "low storage" warning when usage exceeds 70% of quota
5. Hard limit of 50MB for IndexedDB data

---

### O2: Conflict Resolution When Two Librarians Work Offline on the Same Book

**What goes wrong:** Two librarians at the same library could both be offline. Librarian A checks out Book X to User A. Librarian B (still offline, unaware) checks out Book X to User B. When both sync, `availableCount` goes negative.

**Prevention:**
1. Use Last-Write-Wins with timestamp-based conflict detection
2. When a sync conflict is detected, mark the later transaction as `CONFLICT` and alert the librarian
3. Add a "pending sync" indicator showing other librarians' queued transactions
4. Consider "soft reservation" at the offline level

---

### O3: Background Sync Battery and Network Drain

**What goes wrong:** No retry backoff or configurable sync intervals. Sync fires every time the browser detects "online" even if the connection is too weak to complete a POST. Drains battery on mobile devices.

**Prevention:**
1. Implement exponential backoff: 1min, 5min, 15min, 1hr
2. Add connection quality check (`navigator.connection.effectiveType`)
3. Allow manual "sync now" button for librarians
4. Add battery-aware sync: if battery < 15%, defer sync

---

## AI/NLP for Uzbek Language

### AI1: GPT-4 Does Not Natively Handle Uzbek Well

**What goes wrong:** GPT-4's training data for Uzbek is limited. The TZ plans "o'zbek fine-tuning" but:
- GPT-4 cannot be fine-tuned (only GPT-3.5-turbo and GPT-4o-mini support fine-tuning via OpenAI API)
- Uzbek morphological errors account for >33% of LLM output errors
- The agglutinative nature means tokenization is inefficient
- Uzbek lacks standardized NLP resources

**Prevention:**
1. Use GPT-4 with carefully crafted Uzbek prompts + few-shot examples, not fine-tuning
2. Fall back to template-based responses for common admin queries (80% will be predictable)
3. Consider Mistral or open-source models that can actually be fine-tuned
4. Build a validation corpus of 500+ admin queries
5. Add "Was this helpful?" feedback to measure quality
6. Monitor the Aisha AI platform (Uzbek-specific AI) for potential integration

**Sprint mapping:** Sprint 8 (AI system).

**Confidence:** MEDIUM -- based on published research on Uzbek LLM performance.

---

### AI2: RAG Pipeline Assumes Structured Data That May Not Exist

**What goes wrong:** The RAG architecture plans Pinecone/Weaviate for semantic search. But the NL Interface answers come from SQL aggregation, not document search. "Navoiyda bu oy kitobxonlik qanday?" needs a GROUP BY query, not vector similarity.

**Prevention:**
1. For structured data queries, use direct SQL with parameterized templates
2. Reserve RAG/vector search for unstructured content only (future book reviews)
3. Add 20-30 query templates covering 80% of admin questions
4. Use LLM only for natural language generation of the answer, not query planning

**Sprint mapping:** Sprint 8 (AI system).

---

## Scalability Traps

### S1: 15-Minute Audit Cron Loads All RI Records for 60 Days

**What goes wrong:** `_buildTumanRiMap()` runs every 15 minutes and loads all ReadingIndex records from the last 60 days with no limit. 5M users x 60 days = 300M records into Node.js memory.

**Prevention:**
1. Move to PostgreSQL `GROUP BY` aggregation -- never load individual records
2. Create a materialized view `tuman_ri_summary` refreshed hourly
3. Change cron interval to 1 hour for heavy aggregation
4. Cache tuman map in Redis with 15-minute TTL

---

### S2: Daily Fraud Scan -- 50,000 Sequential DB Queries

**What goes wrong:** `dailyFraudScan` processes up to 10,000 users with 5 DB queries each = 50,000 sequential queries at 03:00.

**Prevention:**
1. Process in batches via BullMQ with `concurrency: 50`
2. Pre-aggregate fraud signals in SQL instead of per-user queries
3. Stagger fraud scan to 04:00 to avoid overlap with RI recalculation (midnight)

---

### S3: `findAll` Without Pagination Will OOM at Scale

**What goes wrong:** `TransactionsService.findAll()` returns all matching transactions with no `take`/`skip` limit.

**Prevention:**
1. Add `limit: number = 50, offset: number = 0` to all `findAll` methods
2. Audit all service `findAll` methods across all 20 modules
3. Add a global interceptor that enforces maximum response size

---

### S4: Kafka Events Produced But Never Consumed

**What goes wrong:** `KafkaService` only implements a producer. No consumers exist in the backend. Events (`fraud.detected`, `tuman.ri.dropped`, `book.borrowed`) flow to Kafka but nothing reads them.

**Prevention:**
1. Either add NestJS `@nestjs/microservices` Kafka consumers for critical topics
2. Or clearly establish the Python AI Engine as the consumer and build that service
3. Until consumers exist, Kafka is dead infrastructure consuming resources

**Sprint mapping:** Sprint 8 (AI system).

---

## Government Compliance

### G1: No Data Deletion/Erasure Flow

**What goes wrong:** The TZ states users can delete their data. No `DELETE /users/me` endpoint exists. `DELETED` status does not cascade to PII (address, phone, name). Uzbekistan personal data law requires deletion upon request.

**Prevention:**
1. Implement `DELETE /users/me` with cascading soft-delete
2. Replace PII with anonymized placeholders
3. Retain non-PII for aggregate reporting
4. Add 30-day grace period before permanent deletion
5. Log deletion request in append-only audit log

**Sprint mapping:** Sprint 10 (V1.0 compliance).

---

### G2: Audit Log Must Be Truly Append-Only

**What goes wrong:** The TZ specifies append-only audit logs. But if stored in the same PostgreSQL that Super Admin accesses, they can be modified via direct database access.

**Prevention:**
1. Separate database or schema for audit logs with restricted credentials
2. Write-only database user for audit inserts (no UPDATE/DELETE permissions)
3. Cryptographic hash chains: each entry includes hash of previous entry
4. Replicate audit logs to separate, read-only server

**Sprint mapping:** Sprint 1 (Infrastructure) -- overdue.

---

### G3: Children's Privacy (Under 14) Requirements

**What goes wrong:** TZ requires hiding names of children under 14 in public rankings. System must track full data internally but anonymize externally.

**Prevention:**
1. Add `isMinor` computed field based on `dob`
2. All public API responses filter through privacy layer that anonymizes minors
3. Top-100 API must never return full names for minors
4. Profile pages for minors restricted (not publicly accessible)

**Sprint mapping:** Sprint 5 (Top-100) and Sprint 7 (School module).

---

## Prevention Strategy Summary

| Priority | Pitfall | Sprint | Fix Effort | Impact if Ignored |
|----------|---------|--------|------------|-------------------|
| 1 | C3: Notifications stubbed | Now | 2-3 days | Registration broken |
| 2 | C1: Comprehension test trivial | Sprint 5 | 1-2 days | Fraud exploitable |
| 3 | C4: Offline sync no auth | Now | 2 hours | Rural data loss |
| 4 | C2: Auto-block without review | Now | 4 hours | Legitimate users blocked |
| 5 | C5: ReadingIndex unbounded | Sprint 5 | 1 day | DB crash in 90 days |
| 6 | C6: Sequential RI recalc | Sprint 5 | 2-3 days | RI always stale |
| 7 | H1: Payme untyped params | Sprint 9 | 1 day | Financial security risk |
| 8 | H2: Store entry no auth check | Sprint 4-9 | 2 hours | Fraud vector |
| 9 | H3: OTP rate limit in-memory | Now | 1 hour | SMS cost explosion |
| 10 | H4: availableCount drift | Sprint 4 | 1 day | Inventory inaccuracy |
| 11 | H5: Vault dev token fallback | Now | 1 hour | Security compliance |
| 12 | H6: extendDueDate magic number | Sprint 4 | 2 hours | Overdue system bypass |
| 13 | H7: WebSocket multi-instance | Sprint 6 | 2 hours | Broken real-time |
| 14 | H8: Payme timeout not enforced | Sprint 9 | 4 hours | Ghost transactions |
| 15 | UZ2: PQ-9 pressure to fake | Sprint 5-8 | Ongoing | Platform credibility |
| 16 | UZ3: Rural infrastructure | Sprint 10 | 2 weeks | 30-40% libraries excluded |
| 17 | AI1: Uzbek NLP limitations | Sprint 8 | Ongoing | Admin tool unreliable |
| 18 | G1: No data deletion | Sprint 10 | 3 days | Legal non-compliance |

---

## Phase-Specific Warnings

| Phase/Sprint | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Sprint 2 (Auth) | OTP rate limit in-memory, notifications stubbed | Redis rate limiting, Eskiz.uz integration |
| Sprint 4 (Book processes) | availableCount drift, extendDueDate bypass | Interactive transactions, separate boolean column |
| Sprint 5 (Reading Index) | Sequential cron, unbounded table, trivial comprehension test | BullMQ batching, table partitioning, question randomization |
| Sprint 6 (Statistics) | Audit cron loads 300M rows, WebSocket multi-instance | PostgreSQL GROUP BY, Redis adapter |
| Sprint 7 (School/Family) | Children's privacy violations in rankings | Automatic minor anonymization in public APIs |
| Sprint 8 (AI/Fraud) | Auto-blocking without review, Uzbek NLP quality, Kafka no consumers | FLAGGED status, template-first approach, consumer implementation |
| Sprint 9 (Payments) | Payme webhook injection, untyped params, timeout not enforced | Typed DTOs, HMAC verification, BullMQ delayed cancel |
| Sprint 10 (Launch) | Offline sync data loss, no data deletion, timezone mismatch | Auth header in SW sync, DELETE /users/me, TZ config |

---

## Sources

- Codebase audit: `CONCERNS.md` (2026-06-06) -- all code-level pitfalls verified against source
- [Advancing NLP in Uzbek: Challenges and Solutions](https://www.researchgate.net/publication/380846953_ADVANCING_NATURAL_LANGUAGE_PROCESSING_IN_UZBEK_CHALLENGES_AND_SOLUTIONS)
- [Investigating Linguistic Errors in LLM Generation of Uzbek Text](https://www.tandfonline.com/doi/full/10.1080/23311983.2025.2600519)
- [Making Open-Source LLMs Work for Banking in Uzbekistan](https://aiphoria.ai/blog/when-languages-lack-data-making-open-source-llms-work-for-banking-in-uzbekistan)
- [Uzbekistan Data Localization -- Dentons Analysis (March 2026)](https://www.dentons.com/en/insights/articles/2026/march/31/uzbekistan-dismantles-strict-data-localization-regime)
- [Uzbekistan Personal Data Law -- Library of Congress](https://www.loc.gov/item/global-legal-monitor/2021-05-07/uzbekistan-new-requirements-for-uzbek-citizens-personal-data-localization-enter-into-force/)
- [Uzbekistan Eases Data Localization Rules](https://timesca.com/uzbekistan-eases-data-localization-rules-to-support-global-payment-platforms/)
- [Personal Data Compliance in Uzbekistan -- Legal500](https://www.legal500.com/developments/thought-leadership/personal-data-compliance-in-uzbekistan/)
- [PayTechUZ -- Unified Payment Library for Uzbekistan](https://docs.pay-tech.uz/)
- [Offline Sync and Conflict Resolution Patterns (Feb 2026)](https://www.sachith.co.uk/offline-sync-conflict-resolution-patterns-architecture-trade%E2%80%91offs-practical-guide-feb-19-2026/)
- [Offline-First Web Applications: Service Workers and Sync Strategies](https://letsbuildsolutions.com/blog/web-engineering/building-offline-first-web-applications-service-workers-indexeddb-and-sync-strategies-in-production/)
- [Data Isolation in Multi-Tenant SaaS -- Redis](https://redis.io/blog/data-isolation-multi-tenant-saas/)
- [Multi-Tenant SaaS Privacy and Data Isolation](https://complydog.com/blog/multi-tenant-saas-privacy-data-isolation-compliance-architecture)
- [9 Pitfalls to Scaling Innovation from Pilot to Production -- CIO](https://www.cio.com/article/215727/9-pitfalls-to-scaling-innovation-from-pilot-to-production.html)
- [Determinants of Scale-up from Pilot to National Registry -- NIH](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7539163/)
- [PostgreSQL Table Partitioning Documentation](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Handling 2 Million Background Jobs a Day with BullMQ](https://medium.com/@connect.hashblock/handling-2-million-background-jobs-a-day-in-nestjs-with-bullmq-and-rate-limited-queues-d059f8c69681)
- [Ensuring Accountability with Digital Reading Logs -- Beanstack](https://www.beanstack.com/blog/ensuring-accountability-with-digital-reading-logs)
- [Data Sovereignty in the Education Sector -- InCountry](https://incountry.com/blog/data-sovereignty-in-the-education-sector-requirements-and-challenges/)
- [BBPOS: BERT-based POS Tagging for Uzbek](https://arxiv.org/pdf/2501.10107)
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/)
- [Payme Merchant API](https://developer.payme.uz/documentation)
- [IndexedDB Storage Quota](https://web.dev/articles/storage-for-the-web)

---

*Pitfalls research: 2026-06-06 | SIFAT Library | 6 critical + 8 high + 6 medium pitfalls + Uzbekistan-specific + fraud/offline/AI/scaling/compliance analysis*
