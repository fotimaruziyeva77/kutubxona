# Phase 3 Research — Rankings, Gamification & Donations

**Researched:** 2026-06-06
**Domain:** Public rankings, fraud-resistance for prize-bearing leaderboards, gamification, transparent donations
**Confidence:** HIGH (codebase audit + Phase 1/2 VERIFICATION + REQUIREMENTS verified)

---

## Project Constraints (from CLAUDE.md)

The project root `CLAUDE.md` is the full TZ (technical specification) in Uzbek. Phase 3 must honor:

- **§V.2 Top-100 Final Score** — 6-component formula with exact weights (Verified Reading 40%, Consistency 15%, Diversity 10%, Comprehension 15%, Discipline 10%, Trust Score 10%) — this is already coded but with different weights interpretation; verify against the SS spec
- **§V.3 All open rankings** — `sifat.uz/top` must expose Top-100 (umumiy + erkak + ayol + o'quvchi + talaba), Top oilalar, Top mahallalar, Top maktablar, Top OTMlar, Top idoralar, Top tumanlar, Top viloyatlar, Donor Top-50, Eng ko'p o'qilgan kitoblar, RI xaritasi
- **§V.4 Top-100 selection workflow** — 28-kuni avtomatik ranking → 29-kuni AI fraud → 30-kuni admin tasdiq → 1-kuni e'lon
- **§V (privacy)** — 14 yoshgacha bolalar ismi yashiriladi, kichik bola uchun "A.K., 12 yosh, Toshkent" formati
- **§IV.4.4 Family** — oila reytingi 30 kunlik kutish davri bilan (FAM-05) — out of Phase 3 scope (Phase 6 FAM-04)
- **§XIV.3 Donat** — Payme + Click integratsiya, donat maqsadi tanlash, ochiq donatchilar ro'yhati, shaffof sarflash; donor TOP-50 ro'yhati real vaqt yangilanadi
- **§VIII Security** — barcha public endpointlar `@Public()` bilan belgilanishi kerak (Phase 1 INFRA-03 default-deny global guard), donat endpointlar IP whitelist ham talab qilishi mumkin
- **§X.2 DB schema** — Top100Entry, Badge, UserBadge, Donate models declared and migrated; Phase 3 must not redesign the schema, only extend it
- **§XI.2 CI/CD** — backend test coverage threshold 80% (jest.config.ts line 25); all new code requires unit specs

---

## Executive Summary

Phase 3 is a **finish-the-scaffold** phase, not a greenfield build. The Phase 0 audit + actual codebase inspection confirms that **all four major systems already exist as code** with passing unit specs:

| System | Service file | Status | What's missing |
|--------|-------------|--------|----------------|
| Top-100 ranking engine | `apps/backend/src/modules/top/top.service.ts` (282 lines) | Computes Final Score, persists `Top100Entry` (DRAFT/CONFIRMED), gender/age/userType filters work, anonymization works, 7 spec suites green | (1) workflow is a single `@Cron('0 2 28 * *')` — not 4-step 28→29→30→1; (2) AI fraud gating not invoked; (3) institutional rankings (`TOP-05`) missing; (4) no WebSocket emit for `TOP-07`; (5) frontend `TopClient.tsx` is fully wired but reads from these endpoints — works today |
| Badge system | `apps/backend/src/modules/badge/badge.service.ts` (167 lines) + 18-badge catalog | All 5 award triggers exist (`checkAfterReturn`, `checkAfterTest`, `checkAfterIsbnScan`, `checkAfterTrustUpdate`, `checkAfterDonation`, `checkTopEntries`), wired into `transactions.service.ts` + `donate.service.ts`, 9 spec suites green | (1) `seedBadges()` exists but is never called from bootstrap or seed.ts; (2) no `GET /users/me/badges` endpoint; (3) profile page does NOT render badges; (4) no badge notification (push/SMS — both deferred to Phase 5); (5) Top-100 badge award not chained from `confirmMonth` |
| Donation flow | `apps/backend/src/modules/donate/donate.service.ts` (181 lines) + controller (90 lines) | initiate/webhook/stats/getPublicDonors/recordSpending/getTopDonors all implemented, Payme/Click URL stubs work, 6 spec suites green | (1) Webhook has NO signature/IP verification — anyone can POST `/donate/webhook/payme` and mark a donation PAID; (2) NO idempotency key on webhook — duplicate calls double-credit donor; (3) `getTopDonors` `count: number` is documented but not returned (only `_sum`); (4) frontend `donate/page.tsx` calls `/donate/spending` which does NOT exist on backend; (5) no admin spend-tracking UI |
| Fraud Detection (Top-100) | `apps/backend/src/modules/ai/fraud.service.ts:188` `checkTop100Candidates()` | Already exists, called via `POST /ai/fraud/top100-check` (SUPER_ADMIN only), returns `{total, flagged, blocked, results}` | (1) Not invoked by the Top-100 cron workflow — workflow has no 29th-day step; (2) Inventory reconciliation cron (`FRAUD-08`) does not exist anywhere; (3) BookTransfer in-flight rows must be accounted for in reconciliation math |

**Primary recommendation:** Phase 3 ships in 4 waves:
- **Wave 0:** Test infrastructure verification + add the missing spec scaffolds (donate webhook idempotency, donation-spending model, badge profile endpoint, inventory reconciliation)
- **Wave 1 (FIX/EXTEND):** Top-100 workflow orchestration + TOP-08 leaderboard SQL fix + badge profile endpoint + donate webhook hardening
- **Wave 2 (NEW):** Institutional rankings (TOP-05), inventory reconciliation cron (FRAUD-08), donation `/spending` endpoint, badge seeder
- **Wave 3 (NEW):** Real-time leaderboard WebSocket integration (TOP-07), admin Top-100 review UI, frontend profile badge widget

The phase **does not require** schema changes. The Top100Entry, Badge, UserBadge, Donate models are already migrated and queryable. The Phase 1 + 2 infrastructure (BullMQ, Kafka, WebSocket Redis adapter, RiRecalcProcessor, FraudScore) is already in place and ready to consume.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Top-100 Final Score computation | **API / Backend (cron + service)** | Database (read-only aggregation via Prisma) | Per CLAUDE.md §V.4, ranking is computed centrally and persisted to `Top100Entry`. Frontend never re-ranks; it just renders. |
| Top-100 monthly workflow orchestration | **API / Backend (`@Cron` + state machine on `Top100Entry.status`)** | — | Phase 1 (`Asia/Tashkent` TZ confirmed at INFRA-05) means cron wall-clock matches CLAUDE.md §V.4 dates. State transitions are server-only. |
| Public ranking JSON endpoints | **API / Backend (`@Public()` controllers)** | CDN (via `next: { revalidate: 3600 }` in `top/page.tsx:28`) | Already wired in `top.controller.ts:18-47`. Public ranking pages must not require auth (CLAUDE.md §VIII.1 lists `/top` and `/donate` as public). |
| Anonymization of <14 children | **API / Backend** (server-side mask at JSON serialization) | — | Defense-in-depth: server is the SOLE source of truth. Frontend should never receive `full name + exact address` for a child; anonymization at read time prevents leaks via cache, screenshots, SSR pages, and WebSocket pushes. Already implemented in `top.service.ts:211` `anonimize(name)` helper — but only for `getTop100`; `getDraftMonth` (admin) and `top-donors` (public) need the same gate. |
| Badge award detection | **API / Backend (service calls inside `BookTransaction`/`Donate` flow)** | — | Already integrated into `transactions.service.ts:387,478,589,665` (4 award hooks) + `donate.service.ts:80`. Event-driven path is already live; no Kafka consumer needed. |
| Badge rendering on profile | **Frontend (Next.js client component)** | API (`GET /users/me/badges`) | New endpoint must be added. UI lives in `profile/page.tsx`. |
| Donation initiation + webhook | **API / Backend** | Payme/Click external HTTP | Webhook is `@Public()` because external (Phase 1 INFRA-03 + CLAUDE.md §VIII default-deny). Idempotency + signature verification are backend-only concerns. |
| Real-time leaderboard updates | **API / Backend (StatsGateway emit)** | Frontend (`socket.io-client` subscribe) | StatsGateway already has `emitTop100Update(month, entries)` method at `stats.gateway.ts:169` and `top100:{month}` room is whitelisted at line 204. Need to call this method from `confirmMonth` and on demand. |
| Inventory reconciliation | **API / Backend (`@Cron` + Prisma aggregate)** | Kafka (optional alert emit) | Must read both `Book.availableCount` and `BookTransaction{status: BORROWED}` AND `BookTransfer{status: PENDING}` per Phase 2 carry-over. |

---

## Current State Audit (per requirement, with file:line evidence)

### TOP-01 — 6-component Final Score formula

**Current state:** IMPLEMENTED with caveats.
- `top.service.ts:7-14` defines `FINAL_WEIGHTS` matching CLAUDE.md §V.2 exactly: `verifiedReading 0.40, consistency 0.15, diversity 0.10, comprehension 0.15, discipline 0.10, trust 0.10`.
- `top.service.ts:38-141` `computeMonthlyTop100()` iterates all `ACTIVE` users, builds 6 components, persists Top-200 (Top-100 + 100 reserves) as `Top100Entry` rows with `status: 'DRAFT'`.
- Spec assertion at `top.service.spec.ts:71-95` proves active readers rank above passive readers.

**Gap:** The computation loads **all active users** into memory via `prisma.user.findMany({where: {status: 'ACTIVE'}, ...with transactions/isbnScans/comprehensionTests})`. At 5M users this is identical to the Pitfall M4 in-memory sort problem. Phase 2 RI engine uses BullMQ fan-out with `addBulk`; Top-100 should reuse that pattern. **However:** Top-100 runs monthly, so single-execution wall-clock matters less than RI's nightly cron. Decision deferred to planner.

**Classification:** FIX (decompose monolithic query + verify weights) — primary build is done.

### TOP-02 — 28→29→30→1 monthly workflow

**Current state:** PARTIALLY IMPLEMENTED.
- `top.service.ts:37` has a single `@Cron("0 2 28 * *")` that computes DRAFT.
- `confirmMonth(month)` at line 145 is a manual admin-only step via `POST /top/:month/confirm`.
- **Missing:** 29-day AI fraud check step. The `checkTop100Candidates()` method exists in `fraud.service.ts:188` but is NOT auto-invoked by any cron — it's only triggered by `POST /ai/fraud/top100-check` (SUPER_ADMIN manual call at `ai.controller.ts:85`).
- **Missing:** 30-day admin review queue. Currently admin can call `GET /top/draft` to view DRAFT entries (line 257) but there's no flagged-by-fraud queue.
- **Missing:** 1-day publish (auto-CONFIRM if not vetoed). Currently the DRAFT → CONFIRMED transition is purely manual.

**Classification:** EXTEND (chain 3 missing cron steps + admin override endpoints).

### TOP-03 — Gender-specific rankings

**Current state:** IMPLEMENTED.
- `Top100Entry.gender UserGender` column exists at `schema.prisma:434` with `@@index([month, gender])` at line 442.
- Filter at `top.service.ts:170` honors `gender` query param. Tested at `top.service.spec.ts:202-212`.
- Frontend `TopClient.tsx:71-72` passes `gender=MALE|FEMALE` query params from "Erkaklar" / "Ayollar" tabs.

**Classification:** COMPLETE — no work needed; confirm via Phase 3 verifier.

### TOP-04 — Age group rankings (7-14, 15-30, 31-60, 60+)

**Current state:** IMPLEMENTED.
- `Top100Entry.ageGroup String` at `schema.prisma:435`.
- `top.service.ts:18-24` `getAgeGroup(dob)` computes age group from `User.dob`.
- Stored at write-time in `computeMonthlyTop100` (`top.service.ts:108`) and filterable in `getTop100`.
- Frontend tabs at `TopClient.tsx:50-54` cover all 4 groups.

**Classification:** COMPLETE.

### TOP-05 — Institutional rankings (maktablar, OTMlar, idoralar, viloyatlar, tumanlar)

**Current state:** PARTIALLY IMPLEMENTED.
- `top.service.ts:232-254` `getRegionalRanking(type)` returns viloyat/tuman ranking — **uses raw SQL with `${type === 'viloyat' ? '"viloyatId"' : '"tumanId"'}` string interpolation**. This is SQL injection-safe (the input is enum-constrained at the controller `@Param('type')` line 49) but the pattern is fragile.
- **Missing:** Institutional rankings for `Institution` model (MAKTAB/OTM/IDORA/MAHALLA). The `SchoolRating`, `OrgRating` models exist at `schema.prisma:690-705,793-808` from Sprint 7/9 schema scaffolds but are **not populated** — no service writes to them.
- Spec assertion at `top.service.spec.ts:248-258` only tests viloyat/tuman raw SQL path.

**Classification:** NEW (institutional rankings) + FIX (consider Prisma-native query rewrite for region path).

### TOP-06 — Children under 14 anonymization

**Current state:** IMPLEMENTED for `getTop100` only.
- `top.service.ts:211` invokes `anonimize(e.user.name)` when `getAge(e.user.dob) <= 14`.
- `anonimize()` at line 277-281 returns `"A.K."` format.
- Spec at `top.service.spec.ts:186-199` verifies child name masking.
- **BUT:** `getDraftMonth` (line 257) returns full `name` to admins — this is INTENTIONAL because admins need to manually verify suspected fraud cases. Acceptable per CLAUDE.md §V.4 (admin tasdiqlovi).
- **BUT:** `getTopDonors` and `getPublicDonors` in `donate.service.ts` do NOT apply age-based anonymization. **Risk:** if a 12-year-old donates and `isPublic=true`, their full name appears in `/top` donor block. **Decision required:** apply consistent anonymization across all public ranking endpoints.

**Classification:** EXTEND (apply anonymization to donor endpoints + draft if exposed to non-SUPER_ADMIN admins).

### TOP-07 — Real-time leaderboard via WebSocket

**Current state:** INFRASTRUCTURE READY, NOT INVOKED.
- `stats.gateway.ts:169-175` `emitTop100Update(month, entries)` method exists.
- `stats.gateway.ts:204` regex `^top100:\d{4}-\d{2}$` whitelists `top100:2026-05` room.
- Phase 1 INFRA-07 confirmed Redis adapter live for multi-instance fan-out.
- **NEVER CALLED:** `grep -r 'emitTop100Update'` returns 1 hit (the definition itself). Neither `confirmMonth` nor any other path invokes this.

**Decision points for the planner:**
1. **When to emit:** Options are (a) only on `confirmMonth` publish (once/month), (b) on every Top100Entry rank change during compute (high-frequency), (c) throttled diff broadcast on RI updates. **Recommendation:** start with (a) — once-per-publish — because the live business value is "users see when the monthly Top-100 drops". Real-time intra-month rank-thrashing is a v2 nicety, not a v1 requirement, and would cost significant Redis pub/sub volume.
2. **Payload size:** A `Top-100` entries list with components is ~30KB JSON. Acceptable for a once/month broadcast. For higher frequency, paginated diff messages needed.
3. **Frontend subscribe:** Add `socket.io-client` connection in `TopClient.tsx` to `top100:{month}` room with `staleTime: Infinity` on the affected React Query key when WS message arrives → invalidate query.

**Classification:** NEW (call existing emit method + frontend subscribe).

### TOP-08 — Leaderboard queries use SQL LIMIT/OFFSET (not in-memory sort)

**Current state:** BUG CONFIRMED.
- `reading.service.ts:414-425` `getLeaderboard()` does `SELECT DISTINCT ON ("userId") ...` (no ORDER BY score, no LIMIT in SQL) then JS-sorts and JS-slices. This loads ALL users into memory.
- `top.service.ts:175-198` `getTop100()` does use `take: limit, skip: offset` correctly against `Top100Entry` — so the **published** monthly leaderboard is fine; the bug is in the live RI leaderboard.

**Fix design:** Convert `getLeaderboard` raw query to:
```sql
SELECT * FROM (
  SELECT DISTINCT ON ("userId") "userId", score, "calculatedAt"
  FROM "ReadingIndex"
  ORDER BY "userId", "calculatedAt" DESC
) latest
ORDER BY score DESC
LIMIT $1 OFFSET $2
```
Use Prisma `$queryRaw` with parameter binding. Result: O(top-N) memory, full table scan happens server-side only.

**Classification:** FIX (10-line change in `reading.service.ts:414`).

### FRAUD-07 — Top-100 multi-layer verification before prize approval

**Current state:** SINGLE-LAYER IMPLEMENTED.
- `fraud.service.ts:188` `checkTop100Candidates()` runs `analyzeUser()` per candidate, returns `{total, flagged, blocked, results}`.
- **Layer 1** (existing): Phase 2 FraudScore action (`'review' | 'cleared' | 'confirmed' | 'none' | 'monitor'`).
- **Missing layers per CLAUDE.md §F1 (PITFALLS) and FRAUD-07 spirit:**
  - Layer 2: Comprehension test pass rate ≥ 80% over last 30 days (already a Trust signal; just needs to be re-asserted at Top-100 gate)
  - Layer 3: No `FraudScore.action='confirmed'` in last 90 days (hard block)
  - Layer 4: Trust score ≥ 50 (no Top-100 entry for users with TrustScore < 50)
  - Layer 5: Borrow-return pattern check (no >50% of returns within 6 hours of borrow — already a "QUICK_RETURNS" flag in `fraud.service.ts:147`, but should be exposed as a Top-100 hard gate)
  - Layer 6 (CLAUDE.md §V.4 step 4): Super Admin manual confirm. This already exists via `POST /top/:month/confirm`. **Per CLAUDE.md §V.4, an automatic 1-day-of-next-month auto-publish is fine; if admin rejects, the entry stays DRAFT and the month is empty.**

**Classification:** EXTEND (write a `Top100GuardService` that composes 4 hard gates above the existing `analyzeUser`).

### FRAUD-08 — Inventory reconciliation cron (5%+ discrepancy alert)

**Current state:** NOT IMPLEMENTED.
- No cron, no service, no spec related to inventory reconciliation in the codebase. Grep for `availableCount` reconciliation returns only the `Book.availableCount >= 0` CHECK constraint from Phase 2.
- **Phase 2 carry-over to respect:** Reconciliation math must include `BookTransfer{status: 'PENDING'}` rows. A book in roaming transit has `availableCount` already decremented at the source library but NOT YET incremented at the destination — the transit must be counted somewhere. Source library's "expected available" = `totalCount - count(BORROWED txns) - count(PENDING transfers in)`. Destination expected = `totalCount + count(PENDING transfers out)` — actually no, BOOK-02 transfers do NOT move the book record between libraries; they just track WHERE the book will be available next. Re-read schema.

**Re-checked:** `BookTransfer.fromLibraryId` is "where the book originates" (the library that owned it) and `toLibraryId` is "where the borrower will return it". Per Phase 2 SUMMARY 02-02, the source library `Book.availableCount` is NOT incremented at return; it waits for the bilateral confirm endpoint at `POST /libraries/:id/transfers/:tid/confirm`. So the math for inventory reconciliation per library:

```
expectedAvailable[libraryId] = SUM(book.totalCount) FOR books in library
                              - COUNT(BookTransaction WHERE bookId in library AND status='BORROWED')
                              - COUNT(BookTransfer WHERE fromLibraryId=library AND status='PENDING')
actualAvailable[libraryId]  = SUM(book.availableCount) FOR books in library
discrepancy                 = abs(expected - actual) / expected
IF discrepancy > 0.05 → emit AiAuditLog{scope:KUTUBXONA, issueType:'INVENTORY_DISCREPANCY', severity:CRITICAL}
                       AND emit Kafka topic 'inventory.discrepancy'
                       AND emit StatsGateway alert
```

**Classification:** NEW (1 cron, 1 service method, 1 spec, ~80 LOC).

### GAME-01 — Badge system with 15+ badges

**Current state:** 18 BADGES IMPLEMENTED (exceeds spec by 3).
- `badge.service.ts:5-24` declares `BADGE_CATALOG` with 18 entries: FIRST_BOOK, FIVE_BOOKS, TEN_BOOKS, TWENTY_BOOKS, FIFTY_BOOKS, HUNDRED_BOOKS, TOP_100, TOP_10, STREAK_7, STREAK_30, DISCIPLINE, DIVERSE_READER, FAST_READER, COMPREHENSION_ACE, ISBN_SCANNER, DONOR, TRUST_MASTER, ACTIVE_MONTH.
- `seedBadges()` (line 35) upserts the catalog — but is **never invoked** in `seed.ts`, bootstrap, or any controller.

**Gap:** STREAK_7, STREAK_30, ACTIVE_MONTH have catalog entries but NO award trigger code. There's no `checkAfterStreak()`. These badges will exist in DB but never be awarded.

**Classification:** EXTEND (wire `seedBadges()` into bootstrap or migration; implement 3 missing trigger methods).

### GAME-02 — Badge notifications when earned

**Current state:** NOT IMPLEMENTED.
- `badge.service.ts:55` only logs `Badge berildi: ${userId} → ${code}`. No push, no SMS, no email.
- Phase 5 covers Firebase FCM (`NOTIF-02`). SMS uses Eskiz which is Phase 1 carry-over.

**Decision required:** Phase 3 should **emit a Kafka event `badge.earned`** (per Phase 1 KafkaService pattern) when a badge is awarded. The Kafka consumer in `kafka-consumer.service.ts:26` already routes alert topics to `StatsGateway.emitNewAlert` — we can add `badge.earned` to that list and emit to a user-private WebSocket room (`user:{userId}`). Push notification delivery (FCM) defers to Phase 5; in-app toast via WebSocket can ship now.

**Classification:** EXTEND (1 Kafka topic + 1 consumer route + 1 gateway emit method).

### GAME-03 — Badges displayed on user profile

**Current state:** NOT IMPLEMENTED.
- `profile/page.tsx` at line 1-482 renders profile, reading stats, transaction history, ISBN scans — but **no badges**.
- No `GET /users/me/badges` endpoint. The `getUserBadges(userId)` method exists at `badge.service.ts:64-70` but no controller exposes it.

**Classification:** NEW (1 endpoint + 1 profile widget).

### DONAT-01 — Donation via Payme/Click with purpose selection

**Current state:** IMPLEMENTED AT STUB LEVEL.
- `donate.service.ts:168-180` `buildPaymentUrl()` returns a Payme/Click URL that **leads to the real Payme/Click checkout pages** but with hardcoded `MERCHANT_ID` / `CLICK_SERVICE_ID` placeholders.
- `donate.controller.ts:62-75` webhook endpoints `/donate/webhook/payme` and `/donate/webhook/click` accept callbacks and call `handlePaymentWebhook`.
- **CRITICAL SECURITY HOLES** (must address):
  1. **No signature verification.** Anyone can POST `{result: {transaction: '<existing-paymentId>'}}` to `/donate/webhook/payme` and mark a real donation PAID. The Phase 4 PAY-01 spec calls for "Payme JSON-RPC webhook with idempotency keys (Redis SETNX, 24h TTL)" and "Click webhook with HMAC signature verification".
  2. **No idempotency.** Calling `/donate/webhook/payme` twice with the same `paymentId` runs the badge award + status update twice. The PAID-second-time is a no-op for `donate.update` (PAID → PAID) but the badge service is called twice and `getStats` total may double-count if downstream code is added later.
  3. **No comment from Payme.** The real Payme JSON-RPC has 6 methods (CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction, GetStatement) — the current webhook accepts a flat `{id, result?: {transaction}}` payload that does NOT match Payme's spec. **This is a STUB endpoint.**

**Decision required (load-bearing):**
- Option A: Phase 3 ships full Payme/Click JSON-RPC integration for donations (Phase 4 then reuses it for subscriptions).
- Option B: Phase 3 stubs Payme/Click behind a feature flag (`DEV_DONATION_PAYMENT_STUB=true` similar to `DEV_OTP_BYPASS` from Phase 1) where the stub auto-completes the donation. Real Payme/Click defers to Phase 4.
- Option C: Phase 3 wires the real `PaymeService.handleWebhook()` (from `payment/payme.service.ts:29` — already has JSON-RPC + auth verification) to handle donation `account.payment_id` as a sibling to invoice payments.

**Recommended approach:** **Option B for Phase 3, real Payme in Phase 4.** Justification:
- Phase 4 is the explicit Payment & Subscriptions phase per ROADMAP.
- PAY-01..08 will harden Payme/Click webhook idempotency + signature verification — duplicating that work in Phase 3 violates DRY and the established roadmap.
- Donations don't have hard delivery deadlines (a donor doesn't suffer if their donation marks PAID via stub in dev and via real Payme in prod).
- The stub pattern is already proven via DEV_OTP_BYPASS (Phase 1).
- **Trap:** The current `donate.controller.ts:62` webhook is `@Public()` and will be **publicly reachable in production** if the stub is shipped unguarded. The flag must default to FALSE in production and enforce env assert at boot (mirroring `vault.service.ts:17` fail-hard pattern).

**Classification:** FIX (harden webhook with stub flag + IP whitelist + idempotency + signature placeholder ready for Phase 4 swap).

### DONAT-02 — Public donor list with transparent allocation tracking

**Current state:** PARTIALLY IMPLEMENTED.
- `GET /donate/donors` returns recent 50 donors via `getPublicDonors(limit)` — works.
- `GET /donate/top-donors` returns Top-50 by sum — works.
- Frontend renders both at `donate/page.tsx:343-417`.
- **Missing:** `/donate/spending` endpoint that frontend calls at `donate/page.tsx:71-75`. This endpoint returns `[]` from a broken fetch (404). Result: "📋 Sarflash tarixi" tab silently shows empty state.
- **Missing in data model:** The current `Donate` model has `targetId, targetName` fields that admin updates via `PATCH /donate/:id/spend`. But there's no separate `DonateAllocation` table tracking many-to-one (one donation can fund partial books across libraries). The current design is "one donation = one target". Acceptable for V1 if products know.

**Classification:** EXTEND (add `getSpendingHistory()` service method + endpoint).

### DONAT-03 — Admin panel: total collected, spent, remaining, per-recipient breakdown

**Current state:** STATS ENDPOINT IMPLEMENTED, ADMIN UI MISSING.
- `GET /donate/stats` returns `{totalCollected, totalSpent, remaining, donorCount}` — works, public endpoint.
- **Missing:** Admin-only per-recipient breakdown. No endpoint like `GET /donate/admin/breakdown` that groups by `targetName` and shows allocation flow.
- **Missing in frontend:** No admin dashboard page like `dashboard/donations` — only `dashboard/buxgalter` exists which would be the natural home but Phase 4 territory.

**Classification:** NEW (1 admin endpoint + 1 dashboard page).

---

## Fix / Build Approaches (per requirement)

### TOP-01 (FIX): Verify formula weights and decompose monolithic query

**Action 1 (verification):** Add a parametric spec that asserts each weight is applied correctly:
```typescript
it("each component contributes its weighted share", async () => {
  const u = mockUser({ /* trustScore 100, all components 100 */ });
  await service.computeMonthlyTop100();
  const upsert = mockPrisma.top100Entry.upsert.mock.calls[0][0];
  expect(upsert.create.score).toBe(100); // sum of weights = 1.0
});
```

**Action 2 (decompose):** Replace the single `findMany` with a chunked Prisma query that streams users in batches of 1000 via `prisma.user.findMany({ skip, take, where })`. Reuse `RI_RECALC_QUEUE` pattern from `reading.service.ts:106` if monthly compute exceeds 5 minutes. **Not blocking for V1 if compute under 10 minutes locally** — verify with `EXPLAIN ANALYZE` against 100K user seed.

**Action 3 (data quality):** The current diversity bucket counts genres across **all-time** transactions (`u.transactions.map(t => t.book?.genre)`). The Final Score should reflect **monthly** behavior. Filter to `oneYearAgo` cutoff consistently — `top.service.ts:64` already has `oneYearAgo`, but line 83 uses `u.transactions` (all-time). Reconcile.

### TOP-02 (EXTEND): 4-step workflow orchestration

**State machine on `Top100Entry.status`:**
- `DRAFT` (28-kuni 02:00) — computed by existing cron, no admin/AI input yet
- `FRAUD_CHECKED` (29-kuni 02:00) — new cron flags suspicious entries
- `READY_FOR_PUBLISH` (30-kuni 02:00) — entries not flagged AND not admin-vetoed roll forward
- `CONFIRMED` (1-kuni 02:00 of next month) — automatic publish; admin can preempt with manual confirm any time

**Schema change required:** Add 2 new status enum values to `Top100Entry.status` (currently free-form `String @default("DRAFT")`). **Recommendation:** keep as String to avoid migration; document state machine in code:

```typescript
// Top100Entry.status state machine (Plan 03-XX):
// DRAFT → FRAUD_CHECKED → READY_FOR_PUBLISH → CONFIRMED
// Admin can transition any state → CONFIRMED (manual override) or REJECTED (kill entry)
```

**Cron registration (4 sibling crons):**
```typescript
@Cron("0 2 28 * *") computeRanking()         // DRAFT
@Cron("0 2 29 * *") aiFraudCheck()           // DRAFT → FRAUD_CHECKED
@Cron("0 2 30 * *") adminReviewWindowOpen()  // FRAUD_CHECKED → READY_FOR_PUBLISH (idempotent)
@Cron("0 2 1 * *")  autoPublish()            // READY_FOR_PUBLISH → CONFIRMED, badge.checkTopEntries
```

**Admin override endpoints:**
- `POST /top/:month/flag/:userId` — admin manually flags a user (sets entry status to FLAGGED)
- `POST /top/:month/clear/:userId` — admin un-flags (back to FRAUD_CHECKED)
- `POST /top/:month/confirm` — manual override of auto-publish (exists)
- `POST /top/:month/reject/:userId` — admin kills the entry entirely

**Concurrency safety:** Each cron should call `prisma.$transaction(async tx => {...})` to prevent race with manual admin actions firing during the cron window.

**Timezone:** Phase 1 INFRA-05 confirmed `TZ=Asia/Tashkent` on Alpine container with `tzdata`. So `@Cron("0 2 1 * *")` fires at 02:00 Tashkent on the 1st — correct per CLAUDE.md §V.4.

### TOP-03/04 (verify only)

No code change. Add an integration spec that hits `GET /top?gender=MALE&ageGroup=15-30&userType=STUDENT_UNIVERSITY` and asserts the filter chain passes through.

### TOP-05 (NEW): Institutional rankings

**Approach 1 — Aggregate at compute time:** Add a new cron `@Cron("0 3 1 * *")` `computeInstitutionalRankings()` that:
1. For each `Institution` (group by type MAKTAB/OTM/IDORA): aggregate `avg(ReadingIndex.score)` over the previous month's data, joined to `User.organizationId` or `User.schoolId` or `User.universityId`.
2. Persist to existing `SchoolRating` / `OrgRating` tables (already in schema lines 690-705, 793-808).
3. Expose `GET /top/institutional/:type` (`maktab|otm|idora|viloyat|tuman`) public endpoint.

**Approach 2 — Materialized view:** PostgreSQL materialized view `monthly_institution_ranking` refreshed daily. Simpler but requires raw SQL migration. Reject for V1 because Phase 2 already showed that partitioned tables + indexes deliver good enough performance without materialized view complexity.

**Recommendation:** Approach 1. Reuse `SchoolRating` and add a sibling `OrgRating` writer.

**Per-tier authorization:** `GET /top/institutional/:type` is `@Public()` per CLAUDE.md §V.3 (these are open rankings). No auth required.

### TOP-06 (EXTEND): Anonymization across all public endpoints

**Plan:** Lift the `getAge(dob) <= 14 ? anonimize(name) : name` ternary into a shared helper:
```typescript
// apps/backend/src/common/utils/anonimize-name.util.ts
export function maskNameIfMinor(name: string, dob: Date): string { ... }
```
Apply in:
- `top.service.ts:211` (already does it)
- `donate.service.ts:88-107` (`getPublicDonors`) — needs `User.dob` JOIN
- `donate.service.ts:142-165` (`getTopDonors`) — needs `User.dob` JOIN
- `top.service.ts:257-268` (`getDraftMonth`) — controlled override: SUPER_ADMIN sees full, TUMAN/VILOYAT admins see masked

**Risk:** Donor's `donorName` field (user-typed) can be a child's full name set by their parent. The mask must apply REGARDLESS of `donorName` — if `userId` resolves to a <14 child, mask. If no `userId` (anonymous), use the donor-supplied `donorName` as-is (parent's name typically).

### TOP-07 (NEW): Real-time leaderboard

**Backend integration:**
```typescript
// top.service.ts (extend confirmMonth + autoPublish)
import { StatsGateway } from "../../infra/gateway/stats.gateway";

constructor(
  private readonly prisma: PrismaService,
  private readonly gateway: StatsGateway   // INJECT
) {}

async confirmMonth(month: string) {
  await this.prisma.top100Entry.updateMany({ where: { month, status: 'READY_FOR_PUBLISH' }, data: { status: 'CONFIRMED' } });
  // Fetch top 100 for the broadcast
  const entries = await this.prisma.top100Entry.findMany({ where: { month, status: 'CONFIRMED' }, take: 100, orderBy: { rank: 'asc' }, include: { user: { select: { name: true, sifatId: true, dob: true } } } });
  // Apply anonymization at emit time
  const broadcast = entries.map(e => ({ ...e, user: { name: maskNameIfMinor(e.user.name, e.user.dob), sifatId: e.user.sifatId } }));
  this.gateway.emitTop100Update(month, broadcast);
  return { confirmed: true, month };
}
```

**Module wiring:** `top.module.ts` must import `GatewayModule` (which exports `StatsGateway`).

**Frontend integration in `TopClient.tsx`:**
```typescript
useEffect(() => {
  const socket = io(`${WS_URL}/stats`, { withCredentials: true });
  socket.emit('subscribe', { room: `top100:${month}` });
  socket.on('top100:update', () => {
    queryClient.invalidateQueries({ queryKey: ['top100'] });
  });
  return () => { socket.disconnect(); };
}, [month, queryClient]);
```

**Sticky session note:** Phase 1 INFRA-07 documented that Nginx `ip_hash` is required for Socket.IO long-polling fallback. This is a deploy constraint, not a Phase 3 code constraint.

### TOP-08 (FIX): SQL LIMIT/OFFSET

```typescript
async getLeaderboard(limit = 100, offset = 0) {
  return this.prisma.$queryRaw<Array<{ userId: string; score: number; calculatedAt: Date }>>`
    SELECT * FROM (
      SELECT DISTINCT ON ("userId") "userId", score, "calculatedAt"
      FROM "ReadingIndex"
      ORDER BY "userId", "calculatedAt" DESC
    ) AS latest
    ORDER BY latest.score DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}
```

Composite index `@@index([userId, calculatedAt])` from Phase 1 INFRA-06 makes the inner `DISTINCT ON` fast. The outer `ORDER BY score DESC LIMIT N` requires either a sort over the result of `DISTINCT ON` (O(N log N) where N = total users) or — if a materialized "latest RI per user" view exists — O(top-N). For V1 the sort cost is acceptable; v2 can add a covering index `(score DESC) WHERE rank IS NOT NULL` if hot.

### FRAUD-07 (EXTEND): Multi-layer Top-100 verification

**Compose 4 hard gates above `analyzeUser`:**

```typescript
// fraud.service.ts (or new top-100-guard.service.ts)
async verifyTop100Candidate(userId: string): Promise<{passed: boolean, reasons: string[]}> {
  const reasons: string[] = [];
  const [user, fraudHistory, comprehensionStats, quickReturns] = await Promise.all([
    this.prisma.user.findUnique({ where: {id: userId}, select: { trustScore: true } }),
    this.prisma.riskLog.findMany({ where: { riskType: 'FRAUD_REVIEW_RESOLVED', createdAt: { gte: ninetyDaysAgo() }, description: { contains: userId } } }),
    this._computeComprehensionPassRate(userId, 30),
    this._quickReturnRatio(userId, 30)
  ]);
  if (!user || user.trustScore < 50) reasons.push('TRUST_BELOW_50');
  if (fraudHistory.some(r => /"decision":"reject"/.test(r.description))) reasons.push('CONFIRMED_FRAUD_90D');
  if (comprehensionStats.passRate < 0.8) reasons.push('LOW_COMPREHENSION');
  if (quickReturns > 0.5) reasons.push('SUSPECT_QUICK_RETURN_PATTERN');
  return { passed: reasons.length === 0, reasons };
}
```

Integrate into Top-100 29-day cron: every DRAFT entry passes through `verifyTop100Candidate`. Failed entries get `status='FLAGGED'` and are exposed in admin review queue.

### FRAUD-08 (NEW): Inventory reconciliation cron

```typescript
// reconciliation.service.ts (new file under apps/backend/src/modules/libraries/)
@Cron("0 4 * * *")  // 04:00 Tashkent daily
async reconcileInventory() {
  const libraries = await this.prisma.library.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true } });
  for (const lib of libraries) {
    const [books, borrowed, pendingTransfers] = await Promise.all([
      this.prisma.book.aggregate({ where: { libraryId: lib.id }, _sum: { totalCount: true, availableCount: true } }),
      this.prisma.bookTransaction.count({ where: { book: { libraryId: lib.id }, status: 'BORROWED' } }),
      this.prisma.bookTransfer.count({ where: { fromLibraryId: lib.id, status: 'PENDING' } })
    ]);
    const expected = (books._sum.totalCount ?? 0) - borrowed - pendingTransfers;
    const actual   = books._sum.availableCount ?? 0;
    if (expected === 0) continue;
    const discrepancy = Math.abs(expected - actual) / expected;
    if (discrepancy > 0.05) {
      await this.prisma.aiAuditLog.create({ data: {
        scope: 'KUTUBXONA', scopeId: lib.id, issueType: 'INVENTORY_DISCREPANCY',
        severity: 'CRITICAL',
        analysis: `${lib.name}: expected ${expected}, actual ${actual} (${(discrepancy*100).toFixed(1)}% farq)`,
        recommendation: 'Kutubxonachi qo\'l bilan inventarizatsiya qilishi va farqni hisobotlashi kerak'
      }});
      this.gateway.emitNewAlert({ scope: 'KUTUBXONA', libraryId: lib.id, discrepancy, expected, actual });
    }
  }
}
```

### GAME-01 (EXTEND): Wire seedBadges + add 3 missing trigger methods

**Seeding:** Add a one-off migration that calls `seedBadges()` at deploy time, OR call it from `app.module.ts` `OnModuleInit` (only if catalog is empty — `if (await prisma.badge.count() === 0)`). **Recommended:** add to `seed.ts` so dev + CI both seed.

**Missing trigger methods:**
```typescript
// badge.service.ts
async checkAfterReturnForStreak(userId: string) {
  // STREAK_7: 7 distinct days with a RETURNED transaction in last 7 days
  // STREAK_30: 30 distinct days with a RETURNED transaction in last 30 days
}

async checkActiveMonth(userId: string, month: string) {
  // ACTIVE_MONTH: user's RI delta for this month is in top 10% of all users
}
```

`checkAfterReturnForStreak` wires into the existing `transactions.service.ts:387` `this.badge.checkAfterReturn(tx.userId)` call site (chain it).

`checkActiveMonth` wires into Top-100 publish flow (run after `autoPublish`).

### GAME-02 (EXTEND): Kafka-based badge notification

**New Kafka topic:** Add `'badge.earned'` to `kafka.service.ts:6-18` `KAFKA_TOPICS` const.

**Emit:** In `badge.service.ts` `award()` success branch, call `this.kafka.emit({ topic: KAFKA_TOPICS.BADGE_EARNED, key: userId, value: { userId, badgeCode } })`.

**Consume:** Add `KAFKA_TOPICS.BADGE_EARNED` to `kafka-consumer.service.ts:26` `ALERT_TOPICS`. The consumer already routes to `StatsGateway.emitNewAlert`. **Better:** add a new `emitBadgeEarned(userId, badge)` method on the gateway that emits to a user-private room `user:{userId}`.

**Frontend:** `TopClient`/`profile/page.tsx` subscribes to `user:{userId}` room on mount. Renders toast on `badge:earned` event.

### GAME-03 (NEW): Profile badge widget

**Backend endpoint:**
```typescript
// users.controller.ts (extend)
@Get("me/badges")
@UseGuards(JwtAuthGuard)
async getMyBadges(@CurrentUser() user: JwtPayload) {
  return this.badge.getUserBadges(user.sub);
}
```

`users.module.ts` must import `BadgeModule`.

**Frontend widget:** New `<BadgesGrid>` component in `profile/page.tsx` rendering 18-cell grid where unearned badges are grayscale + locked icon, earned badges are colorful with `awardedAt` tooltip.

### DONAT-01 (FIX): Webhook hardening + stub flag

**Defense in depth:**
1. **Env-gated stub:** Add `DEV_DONATION_PAYMENT_STUB` env var. When `true` AND `NODE_ENV in {development,test,dev}`, `initiateDonation` returns `paymentUrl: '/donate/stub/success?paymentId=...'` instead of Payme/Click URLs. The stub page calls `POST /donate/webhook/payme` with the paymentId server-side. **Production fail-hard:** `vault.service.ts:17` pattern — backend boot asserts that if `DEV_DONATION_PAYMENT_STUB=true` AND `NODE_ENV=production`, throw and exit.

2. **IP whitelist for webhook:**
```typescript
// donate.controller.ts
@Post("webhook/payme")
@Public()
@UseGuards(IpWhitelistGuard)  // new guard reading PAYME_IP_WHITELIST env var (CSV)
```

3. **Idempotency key:** Wrap `handlePaymentWebhook` with `cache.remember(`donate:webhook:${paymentId}`, 86400, async () => actual())`. If already cached, return cached response without re-processing. Uses Phase 1 `CacheService`.

4. **Signature placeholder:** Add `_verifyPaymeSignature(authHeader, body)` method that NO-OPs in V1 (logs a warn) but is the single integration point for Phase 4 to swap in real HMAC verification.

**Caveat:** The current `donate.controller.ts:65-67` parses `body.result?.transaction` as success indicator — this does NOT match Payme JSON-RPC. **Acceptable for V1 stub**, must be aligned with `PaymeService.handleWebhook()` in Phase 4.

### DONAT-02 (EXTEND): /donate/spending endpoint

```typescript
// donate.service.ts
async getSpendingHistory(limit = 20): Promise<SpendingItem[]> {
  return (await this.prisma.donate.findMany({
    where: { status: 'PAID', targetId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit
  })).map(d => ({
    id: d.id,
    amount: Number(d.amount),
    description: d.targetName ?? 'Sarflandi',
    libraryName: d.targetName,  // V1: same as description; V2 join Library table on targetId
    createdAt: d.createdAt
  }));
}
```

```typescript
// donate.controller.ts
@Public()
@Get("spending")
@ApiOperation({ summary: "Donat sarflash tarixi (ochiq)" })
getSpending(@Query("limit") limit?: string) {
  return this.svc.getSpendingHistory(limit ? parseInt(limit) : 20);
}
```

### DONAT-03 (NEW): Admin breakdown endpoint + dashboard page

```typescript
@Get("admin/breakdown")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
async getAdminBreakdown() {
  const byTarget = await this.prisma.donate.groupBy({
    by: ['targetId', 'targetName'],
    where: { status: 'PAID' },
    _sum: { amount: true },
    _count: { id: true }
  });
  const byPurpose = await this.prisma.donate.groupBy({
    by: ['purpose'],
    where: { status: 'PAID' },
    _sum: { amount: true }
  });
  return { byTarget, byPurpose };
}
```

Frontend page at `dashboard/donations/page.tsx`.

---

## Top-100 Monthly Workflow Design (load-bearing decision 1)

**Decision:** 4 sibling crons + state machine on `Top100Entry.status`.

**Why not a single multi-step cron with branches:**
- Atomicity of state transitions is easier to reason about with one cron per state.
- Admin can preempt any state at any time (manual confirm or reject) without race conditions.
- Each cron is independently testable (mock `Top100Entry.findMany({where:{status:'X'}})` and assert state transition).
- Failure isolation: if 29-day fraud check crashes due to AI Service downtime, the 30-day cron can detect that DRAFT entries haven't moved and skip + log AiAuditLog.

**State machine:**
```
                  POST /top/compute (admin manual trigger)
                              ↓
@Cron 28th 02:00 → DRAFT (existing — verify weights + decompose query)
                              ↓
@Cron 29th 02:00 → FRAUD_CHECKED  (new — runs verifyTop100Candidate, sets FLAGGED for failures)
                              ↓
@Cron 30th 02:00 → READY_FOR_PUBLISH (new — non-flagged entries roll forward, admin window opens)
                              ↓
@Cron 1st 02:00  → CONFIRMED (new — auto-publish + WebSocket emit + badge.checkTopEntries + Kafka emit)

Admin override at any time:
  POST /top/:month/confirm/:userId        → entry.status = CONFIRMED (force publish)
  POST /top/:month/flag/:userId           → entry.status = FLAGGED  (admin sees suspicion)
  POST /top/:month/clear/:userId          → entry.status = FRAUD_CHECKED (un-flag)
  POST /top/:month/reject/:userId         → entry.status = REJECTED (remove from public ranking)
```

**Concurrency:** All admin override endpoints + crons MUST use `prisma.$transaction(async tx => {...})` interactive form (mirroring Phase 2 BOOK-05 pattern). The state machine has fewer states than BOOK-05 has transaction statuses but the same race-safety discipline applies.

**Kafka emit on CONFIRMED:** Emit `KAFKA_TOPICS.TOP100_CONFIRMED` (new topic) on each auto-publish, so AI engine (v2) can subscribe later.

**Audit trail:** Every state transition writes an `AiAuditLog{scope: 'TOP100', scopeId: month, issueType: 'STATE_TRANSITION'}` entry. Append-only per Phase 1 §VIII.4 audit rules.

---

## Real-time Leaderboard Architecture (load-bearing decision 2)

**Decision:** Emit on publish only (once/month per ranking type) + targeted invalidation on admin overrides.

**Rationale:**
- 5M users * 1 leaderboard update * 30KB payload * Redis pub/sub fan-out = ~150GB Redis traffic if real-time. Unsustainable.
- The business goal is "users see when the monthly Top-100 drops" — this is once/month.
- Intra-month rank thrashing (continuous rank updates as new transactions happen) is interesting UX but trivially gamed: a user who borrows + returns 10 books in 10 minutes would create flicker. Defer to v2.

**Emit triggers (sparingly):**
- `autoPublish` cron (1st of month 02:00) → `gateway.emitTop100Update(month, entries)` to `top100:{month}` room
- `confirmMonth` manual admin action → same emit
- `POST /top/:month/flag/:userId` → emit `gateway.emitTop100UserFlagged(month, userId)` (smaller payload, just userId)
- Each emit broadcasts to room `top100:{month}` (e.g., `top100:2026-05`) — clients subscribed via `socket.emit('subscribe', {room: 'top100:2026-05'})`.

**Payload structure:**
```typescript
// On full publish
{ type: 'top100:update', month: '2026-05', top10: [...10 entries...], ts: ISO8601 }
// On flag
{ type: 'top100:flag', month: '2026-05', userId: 'cuid', ts: ISO8601 }
// On clear
{ type: 'top100:clear', month: '2026-05', userId: 'cuid', ts: ISO8601 }
```

**Frontend pattern:**
- `TopClient.tsx` subscribes to current-month room on mount + on month change.
- On any message, invalidate React Query `['top100', tab, page]` keys.
- Don't trust WebSocket payload as data — it's a notification; refetch via REST.

**Redis adapter behavior (Phase 1 INFRA-07):** Already handles multi-instance fan-out. No additional config needed.

**Anonymization at emit time:** Apply `maskNameIfMinor(name, dob)` to entries BEFORE emit. WebSocket payload is the same threat surface as REST JSON.

---

## Badge Award Detection Pattern (load-bearing decision 3)

**Decision:** Event-driven via direct service-to-service call (no Kafka) for award detection; Kafka only for cross-service notification (GAME-02).

**Why not pure Kafka for detection:**
- The award trigger fires INSIDE a `BookTransaction` flow that has already taken a Prisma transaction lock. Detaching the badge check to Kafka means the award could fire BEFORE the transaction commits — race condition where a user who almost-returned a book gets the badge.
- Phase 2 wired the direct call pattern (`transactions.service.ts:387 → badge.checkAfterReturn`) and it has 9 passing specs. Don't redesign what works.
- Kafka is appropriate for cross-service notification ("user X earned badge Y" → push notification service, WebSocket service, analytics) but not for detection.

**Award detection chain (already live, audit confirms):**
- `transactions.service.returnBook()` → `badge.checkAfterReturn(userId)` (line 387)
- `transactions.service.completeRoamingReturn()` → `badge.checkAfterReturn(userId)` (line 478)
- `transactions.service.submitComprehensionTest()` → `badge.checkAfterTest(userId)` (line 589)
- `transactions.service.confirmIsbnScan()` → `badge.checkAfterIsbnScan(userId)` (line 665)
- `donate.service.handlePaymentWebhook()` → `badge.checkAfterDonation(userId)` (line 80)
- `top.service.autoPublish()` (NEW) → `badge.checkTopEntries(month)` (already exists at `badge.service.ts:151`)

**Notification (NEW):**
- `badge.service.award()` success → `kafka.emit({ topic: BADGE_EARNED, key: userId, value: {userId, badgeCode} })`
- `kafka-consumer.service.ALERT_TOPICS` adds `BADGE_EARNED` → routes to `gateway.emitBadgeEarned(userId, badgeCode)`
- Gateway emits to `user:{userId}` private room
- Frontend hooks render in-app toast

**Why Kafka for notification when direct call would work:** Notification routing may go to multiple sinks (WebSocket toast, FCM push, email, analytics dashboard). Kafka decouples this. Phase 1 already proved the Kafka graceful no-op pattern works in dev.

---

## Donation Payment Stub Strategy (load-bearing decision 4)

**Decision:** Phase 3 ships a stub gated by `DEV_DONATION_PAYMENT_STUB` env flag. Real Payme/Click defers to Phase 4 (PAY-01..08).

**Justification (recap):**
- Phase 4 is the explicit Payment phase per ROADMAP.
- `apps/backend/src/modules/payment/payme.service.ts` already has the full JSON-RPC 2.0 handler with `_verifyAuth(authHeader)` — Phase 4 will harden idempotency + HMAC + 12-hour timeout for SUBSCRIPTIONS.
- Donations can ride on the SAME PaymeService.handleWebhook() in Phase 4 with a tiny extension: the Payme `params.account` shape currently expects `{invoiceId}` for subscription payments; donations need `{donationId}` or `{paymentId}` as a sibling field. The handler dispatches based on `account` shape.

**Phase 3 stub deliverables:**
1. `DEV_DONATION_PAYMENT_STUB` env var with fail-hard production assert (mirror `VAULT_TOKEN` from Phase 1 INFRA-04).
2. New `/donate/stub/success?paymentId={id}` endpoint (dev/staging only) that auto-posts to the webhook server-side, simulating a successful Payme/Click flow.
3. **Real `_verifyPaymeSignature()` and `_verifyClickSignature()` methods that NO-OP and log a warn** but are the single integration point Phase 4 will swap.
4. Idempotency key via `cache.remember('donate:webhook:${paymentId}', 86400, ...)` — this is **real** even with the stub; it'll protect real Phase 4 webhooks too.
5. IP whitelist guard `PAYME_IP_WHITELIST` env CSV — real even with stub; will be populated with Payme's published IPs in Phase 4.

**End-to-end test in dev with stub:**
- User opens `/donate` → fills form → submits
- Frontend `POST /donate/initiate` → backend creates `Donate{status:PENDING}` → returns `paymentUrl: '/donate/stub/success?paymentId=abc'`
- Frontend redirects to `/donate/stub/success?paymentId=abc` (a Next.js page)
- That page POSTs `{result: {transaction: 'abc'}}` to `/donate/webhook/payme`
- Backend updates `Donate{status:PAID}`, awards DONOR badge, returns

**Production flag check at boot:**
```typescript
// main.ts (extend _assertEnvVars)
if (process.env.NODE_ENV === 'production' && process.env.DEV_DONATION_PAYMENT_STUB === 'true') {
  throw new Error('[FATAL] DEV_DONATION_PAYMENT_STUB MUST NOT be true in production');
}
```

---

## TOP-06 Anonymization Layer Design

**Decision:** Apply at SERVICE layer (not middleware, not response interceptor) because:
- Different endpoints have different anonymization rules (public sees masked; SUPER_ADMIN sees full).
- The decision data (`dob`) lives in the User table and is only loaded by some queries.
- Middleware would have to introspect the response shape — fragile.
- A response interceptor would re-execute queries — wasteful.

**Implementation:**

```typescript
// apps/backend/src/common/utils/privacy-mask.util.ts
export function maskNameIfMinor(name: string | null, dob: Date | null): string {
  if (!name) return '—';
  if (!dob) return name;
  const ageMs = Date.now() - dob.getTime();
  const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears > 14) return name;
  const parts = name.trim().split(/\s+/);
  return parts.map(p => p[0]?.toUpperCase() + '.').join('');
}
```

**Apply at:**
- `top.service.ts:211` (already)
- `donate.service.ts:88` `getPublicDonors` (NEW — must JOIN `user.dob`)
- `donate.service.ts:142` `getTopDonors` (NEW — JOIN dob)
- `top.service.ts:257` `getDraftMonth` — **scoped:** SUPER_ADMIN sees full, TUMAN_ADMIN sees masked. Determined by `@CurrentUser` role check inside service.
- WebSocket emit payload (TOP-07 broadcast) — apply BEFORE `emitTop100Update`.

**Test:** Add a parametric spec across all 4 endpoints asserting that a child user's name is masked.

**Server-side regional info masking:** CLAUDE.md §V.4 also requires "no exact address" for children. Currently `top.service.ts:214` returns `viloyatId` only (not full address). Confirm this is the case in `getPublicDonors` too — currently it returns no address (only `sifatId`), so OK.

---

## Library & Dependency Recommendations

| Library | Version | Purpose | Status | Verified |
|---------|---------|---------|--------|----------|
| `@nestjs/bullmq` | ^10.2.3 | BullMQ wrapper for optional Top-100 fan-out | Already installed | `backend/package.json:19` `[VERIFIED: npm package present]` |
| `bullmq` | ^5.8.4 | Queue infrastructure | Already installed | `backend/package.json:35` `[VERIFIED]` |
| `socket.io-client` | ^4.7.5 | Frontend WebSocket | Already installed | `frontend/package.json:30` `[VERIFIED]` |
| `@socket.io/redis-adapter` | ^8.3.0 | Multi-instance fan-out | Already installed and wired (Phase 1) | `backend/package.json:35` `[VERIFIED]` |
| `kafkajs` | ^2.2.4 | Kafka producer/consumer | Already installed and wired (Phase 1) | `backend/package.json:44` `[VERIFIED]` |
| `ioredis` | ^5.4.1 | Cache + rate limit | Already installed | `backend/package.json:42` `[VERIFIED]` |
| `qrcode` | ^1.5.4 | Not needed for Phase 3 (badge icons are emoji) | Already installed | — |
| `puppeteer-core` | ^22.15.0 | Not needed for Phase 3 (no PDF) | Already installed | — |

**No new npm packages required for Phase 3.** All required infrastructure was installed in Phase 1.

## Package Legitimacy Audit

> All packages above are already installed and have been through Phase 1 + 2 verification. Phase 3 introduces NO new external dependencies — this audit is a confirmation pass.

| Package | Registry | Age | Disposition |
|---------|----------|-----|-------------|
| `@nestjs/bullmq` | npm | 2+ yrs | Approved (already installed) |
| `bullmq` | npm | 5+ yrs | Approved (already installed) |
| `socket.io-client` | npm | 10+ yrs | Approved (already installed) |
| `@socket.io/redis-adapter` | npm | 7+ yrs | Approved (already installed) |
| `kafkajs` | npm | 7+ yrs | Approved (already installed) |
| `ioredis` | npm | 10+ yrs | Approved (already installed) |

No `slopcheck` run necessary — Phase 3 ships zero new packages.

---

## Architecture Patterns

### System Architecture Diagram

```
                          PHASE 3 SCOPE
              ┌────────────────────────────────────────┐
              │                                        │
   USER ─── HTTP GET /top ─→ TopController ─→ TopService.getTop100
   USER ─── HTTP GET /top ─→ TopController ─→ TopService.getRegionalRanking
   USER ─── HTTP GET /top/institutional/* ─→ TopController.getInstitutional (NEW)
              │                                        │
              │   STATE MACHINE (Cron-driven):         │
              │                                        │
              │   28th 02:00 ──→ DRAFT                 │
              │       (TopService.computeRanking)      │
              │                  │                     │
              │   29th 02:00 ──→ FRAUD_CHECKED ◄──FraudService.verifyTop100Candidate
              │                  │                     │
              │   30th 02:00 ──→ READY_FOR_PUBLISH    │
              │                  │                     │
              │    1st 02:00 ──→ CONFIRMED             │
              │       │                                │
              │       ├──→ StatsGateway.emitTop100Update ──→ WebSocket → frontend
              │       ├──→ BadgeService.checkTopEntries  ──→ awards TOP_10/TOP_100
              │       └──→ KafkaService.emit(TOP100_CONFIRMED) (future AI consumer)
              │                                        │
   ADMIN ── POST /top/:month/confirm ─→ TopService.confirmMonth (manual override)
   ADMIN ── POST /top/:month/flag    ─→ TopService.flagUser
              │                                        │
              │                                        │
   USER ── HTTP /donate/* ─→ DonateController          │
              │                                        │
              │   POST /donate/initiate                │
              │       │                                │
              │       ├── if DEV_STUB=true ──→ /donate/stub/success  │
              │       └── else ──────────────→ Payme/Click checkout (Phase 4)
              │                                        │
              │   POST /donate/webhook/payme ◄── Payme/Click  │
              │       │ IpWhitelistGuard, idempotency, signature stub
              │       ├──→ donate.status = PAID         │
              │       └──→ BadgeService.checkAfterDonation │
              │                                        │
   USER ── HTTP /users/me/badges ──→ BadgeService.getUserBadges (NEW endpoint)
              │                                        │
              │   BOOK FLOWS (Phase 2 already wired):   │
              │   transactions.returnBook ──→ badge.checkAfterReturn
              │   transactions.submitTest ──→ badge.checkAfterTest
              │   ...                                  │
              │       │                                │
              │       └──→ Kafka emit BADGE_EARNED ──→ Consumer ──→ Gateway emit toast
              │                                        │
              │   @Cron 04:00 daily                    │
              │       ReconciliationService.reconcileInventory (NEW, FRAUD-08)
              │       └─→ AiAuditLog{INVENTORY_DISCREPANCY} if > 5%
              │           └─→ StatsGateway.emitNewAlert                │
              │                                                       │
              └───────────────────────────────────────────────────────┘
```

### Component Responsibilities

| File | Responsibility |
|------|---------------|
| `apps/backend/src/modules/top/top.service.ts` | Final Score computation, state machine, anonymization helper, institutional rankings |
| `apps/backend/src/modules/top/top.controller.ts` | `@Public()` endpoints for public ranking access; `@Roles(SUPER_ADMIN)` for admin override |
| `apps/backend/src/modules/ai/fraud.service.ts` | `verifyTop100Candidate` multi-layer gate (NEW method) reuses existing `analyzeUser` |
| `apps/backend/src/modules/badge/badge.service.ts` | Award detection + new streak/active-month triggers + Kafka emit on award |
| `apps/backend/src/modules/donate/donate.service.ts` | Stub-gated initiation, idempotent webhook, spending breakdown, top-donor anonymization |
| `apps/backend/src/modules/donate/donate.controller.ts` | `@Public()` for initiate/webhook (with IpWhitelistGuard); `@Roles(SUPER_ADMIN, BUXGALTER)` for admin breakdown |
| `apps/backend/src/modules/libraries/reconciliation.service.ts` (NEW) | `@Cron` daily inventory math + alert |
| `apps/backend/src/common/utils/privacy-mask.util.ts` (NEW) | Shared `maskNameIfMinor(name, dob)` helper |
| `apps/backend/src/common/guards/ip-whitelist.guard.ts` (NEW) | Reads `PAYME_IP_WHITELIST` / `CLICK_IP_WHITELIST` CSV env vars; 403 on mismatch |
| `apps/backend/src/infra/gateway/stats.gateway.ts` | Add `emitBadgeEarned`, `emitTop100UserFlagged` methods |
| `apps/backend/src/infra/kafka/kafka.service.ts` | Add `TOP100_CONFIRMED`, `BADGE_EARNED` topics |
| `apps/backend/src/users/users.controller.ts` | Add `GET /users/me/badges` (1-liner delegating to BadgeService) |
| `apps/frontend/app/[locale]/profile/page.tsx` | Add `<BadgesGrid>` widget |
| `apps/frontend/app/[locale]/top/TopClient.tsx` | Add `socket.io-client` subscription + React Query invalidation |
| `apps/frontend/app/[locale]/dashboard/donations/page.tsx` (NEW) | Admin spend breakdown |
| `apps/frontend/app/[locale]/dashboard/top-review/page.tsx` (NEW) | Admin Top-100 30-day review queue UI |

---

## Phase 1 + 2 Carry-overs Respected

| Carry-over | Phase 3 obligation |
|-----------|---------------------|
| **INFRA-03 Global JwtAuthGuard + `@Public()`** | All Phase 3 public ranking + donate endpoints MUST have `@Public()`; admin endpoints MUST have `@Roles(...)`. Donate webhook MUST be `@Public() + IpWhitelistGuard`. |
| **INFRA-07 WebSocket Redis adapter** | TOP-07 reuses `StatsGateway` as-is. No new adapter code; just call existing methods. |
| **INFRA-08 Kafka consumer** | GAME-02 adds `BADGE_EARNED` to `ALERT_TOPICS` in `kafka-consumer.service.ts:26`. Don't create a new consumer service. |
| **INFRA-05 TZ Asia/Tashkent** | All Phase 3 crons use natural Tashkent time (`@Cron('0 2 1 * *')` = 02:00 Tashkent on 1st). No UTC conversion needed. |
| **INFRA-02 Cookie auth + `withCredentials: true`** | Frontend WebSocket connection MUST use `io(url, { withCredentials: true })` to propagate refresh cookie. |
| **RI-05 ReadingIndex partitioned table** | TopService monthly compute reads ReadingIndex via Prisma — partitioning is transparent. Use date-range filters that align with partition boundaries (e.g., `gte: startOfMonth(monthStr)`) for partition pruning. |
| **RI batch engine (PrismaReplicaService)** | Top-100 compute is heavy READ. Use `this.replica.user.findMany(...)` instead of `this.prisma.user.findMany(...)` to offload from primary. Phase 2 RiRecalcProcessor pattern. |
| **FRAUD-03 admin review queue (FraudScore)** | FRAUD-07 multi-layer gate consults `FraudScore.action` ('cleared'/'confirmed'/'review'). No new FraudScore semantics. |
| **FRAUD-05 Trust Score signals** | FRAUD-07 reads `user.trustScore`. Phase 2 already wires 3 signals into TrustScore. |
| **BOOK-02 BookTransfer model** | FRAUD-08 reconciliation MUST include `BookTransfer{status:PENDING}` in inventory math. |
| **BOOK-05 CHECK constraint + interactive $transaction** | Phase 3 admin override endpoints (flag, clear, confirm) MUST use interactive `$transaction(async tx => ...)` form. |
| **DEV_OTP_BYPASS pattern (Phase 1 AUTH-01)** | `DEV_DONATION_PAYMENT_STUB` MIRRORS this pattern: NODE_ENV allowlist, fail-hard in production. |
| **schema.prisma `Top100Entry`/`Badge`/`UserBadge`/`Donate`** | No schema changes in Phase 3. Use existing tables. |

---

## Build Order (waves)

### Wave 0 — Test infrastructure & shared utilities (1 plan)

| Task | Files |
|------|-------|
| Create `privacy-mask.util.ts` + spec | `apps/backend/src/common/utils/privacy-mask.util.ts` |
| Create `IpWhitelistGuard` + spec | `apps/backend/src/common/guards/ip-whitelist.guard.ts` |
| Wire `seedBadges()` into `prisma/seed.ts` | `apps/backend/prisma/seed.ts` |
| Add `DEV_DONATION_PAYMENT_STUB` env var fail-hard in `main.ts` | `apps/backend/src/main.ts` |
| Add `TOP100_CONFIRMED`, `BADGE_EARNED` to `KAFKA_TOPICS` | `apps/backend/src/infra/kafka/kafka.service.ts` |

**Verification:** `npm test` green; backend boot fails when DEV_DONATION_PAYMENT_STUB=true + NODE_ENV=production.

### Wave 1 — Top-100 core fixes (1 plan)

| Task | Files |
|------|-------|
| TOP-08 fix `getLeaderboard` SQL LIMIT/OFFSET | `apps/backend/src/modules/reading/reading.service.ts:414` |
| TOP-02 4-cron state machine (replace single cron) | `apps/backend/src/modules/top/top.service.ts:37,145` |
| TOP-01 add weight parity spec + diversity 12-month filter fix | `apps/backend/src/modules/top/top.service.ts:64,83` |
| FRAUD-07 `verifyTop100Candidate` 4-layer gate | `apps/backend/src/modules/ai/fraud.service.ts` |
| TOP-06 apply `maskNameIfMinor` to donor + draft endpoints | `apps/backend/src/modules/donate/donate.service.ts:88,142` |

**Verification:** Full backend suite green; spec asserts state machine transitions DRAFT→FRAUD_CHECKED→READY_FOR_PUBLISH→CONFIRMED with admin override.

### Wave 2 — Institutional rankings, reconciliation, donation hardening (1 plan)

| Task | Files |
|------|-------|
| TOP-05 institutional rankings cron + endpoint | NEW `apps/backend/src/modules/top/institutional.service.ts` |
| FRAUD-08 inventory reconciliation cron + alert emit | NEW `apps/backend/src/modules/libraries/reconciliation.service.ts` |
| DONAT-01 webhook hardening: IpWhitelistGuard + idempotency `cache.remember` + signature stubs | `apps/backend/src/modules/donate/donate.controller.ts:62`, `donate.service.ts:66` |
| DONAT-02 `/donate/spending` endpoint | `apps/backend/src/modules/donate/donate.{controller,service}.ts` |
| DONAT-03 admin breakdown endpoint | `apps/backend/src/modules/donate/donate.{controller,service}.ts` |
| Donate stub success Next.js page | NEW `apps/frontend/app/[locale]/donate/stub/success/page.tsx` |

**Verification:** Reconciliation cron unit-tested with seeded BookTransfer{PENDING} edge case; donation webhook rejects unwhitelisted IP; double-webhook-call test confirms idempotency (badge awarded only once).

### Wave 3 — Real-time, badges UI, admin dashboards (1 plan)

| Task | Files |
|------|-------|
| TOP-07 `confirmMonth` + `autoPublish` invoke `gateway.emitTop100Update` | `apps/backend/src/modules/top/top.service.ts` |
| TOP-07 frontend WebSocket subscription | `apps/frontend/app/[locale]/top/TopClient.tsx` |
| GAME-02 badge.service emit Kafka BADGE_EARNED + consumer route | `apps/backend/src/modules/badge/badge.service.ts:55`, `apps/backend/src/infra/kafka/kafka-consumer.service.ts:26` |
| GAME-03 `GET /users/me/badges` endpoint | `apps/backend/src/modules/users/users.controller.ts` + module import |
| GAME-03 `<BadgesGrid>` component | `apps/frontend/app/[locale]/profile/page.tsx` (extend) |
| GAME-01 add `STREAK_7/30`, `ACTIVE_MONTH` triggers | `apps/backend/src/modules/badge/badge.service.ts` |
| Admin Top-100 review UI | NEW `apps/frontend/app/[locale]/dashboard/top-review/page.tsx` |
| Admin donations breakdown UI | NEW `apps/frontend/app/[locale]/dashboard/donations/page.tsx` |

**Verification:** End-to-end test from `TopClient` subscribe → admin manual `confirmMonth` → frontend receives `top100:update` → React Query invalidates → table refreshes.

---

## Validation Architecture (Nyquist)

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest ^29 (ts-jest preset, see `apps/backend/jest.config.ts`) |
| Config file | `apps/backend/jest.config.ts` |
| Quick run command | `cd apps/backend && npx jest <pattern> --bail --forceExit` |
| Full suite command | `cd apps/backend && npm test` |
| Frontend | None for Phase 3 (existing frontend Jest config covers basic component tests, but TopClient/profile changes are light and integration-tested via Playwright in v2) |
| Coverage threshold | 80% lines (jest.config.ts:25) — enforced |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TOP-01 | Final Score formula = sum of 6 weighted components | unit | `npx jest top.service.spec -t "weighted share"` | ✅ existing + extend |
| TOP-02 | DRAFT → FRAUD_CHECKED → READY_FOR_PUBLISH → CONFIRMED state machine | unit | `npx jest top.service.spec -t "state machine"` | ❌ Wave 1 |
| TOP-02 | Admin override `confirm/flag/clear/reject` | unit | `npx jest top.service.spec -t "admin override"` | ❌ Wave 1 |
| TOP-03 | Gender filter narrows result set | unit | `npx jest top.service.spec -t "gender filtri"` | ✅ existing line 201 |
| TOP-04 | Age group computed from DOB at write time | unit | `npx jest top.service.spec -t "ageGroup"` | ✅ existing line 120 |
| TOP-05 | Institutional rankings populated for MAKTAB/OTM/IDORA | unit | `npx jest institutional.service.spec` | ❌ Wave 2 |
| TOP-06 | <14 child name masked in `getTop100`/`getPublicDonors`/`getTopDonors` | unit | `npx jest "*.service.spec" -t "anonimlanadi"` | ✅ partial (top only); extend donor in Wave 1 |
| TOP-07 | `confirmMonth` invokes `gateway.emitTop100Update` | unit | `npx jest top.service.spec -t "WebSocket emit"` | ❌ Wave 3 |
| TOP-08 | Leaderboard uses LIMIT/OFFSET | unit | `npx jest reading.service.spec -t "leaderboard SQL"` | ❌ Wave 1 |
| FRAUD-07 | 4-layer gate rejects low trust / fraud history / low comprehension / suspect pattern | unit | `npx jest fraud.service.spec -t "verifyTop100Candidate"` | ❌ Wave 1 |
| FRAUD-08 | Inventory discrepancy > 5% generates AiAuditLog + Kafka emit | unit | `npx jest reconciliation.service.spec` | ❌ Wave 2 |
| FRAUD-08 | Includes BookTransfer{PENDING} in expected-available math | unit | `npx jest reconciliation.service.spec -t "in-flight transfers"` | ❌ Wave 2 |
| GAME-01 | All 18 badges in catalog (including STREAK_7/30, ACTIVE_MONTH) seed correctly | unit | `npx jest badge.service.spec -t "BADGE_CATALOG"` | ✅ existing line 45 (asserts 18); extend |
| GAME-02 | Badge award emits Kafka BADGE_EARNED + gateway emit | unit | `npx jest badge.service.spec -t "Kafka emit"` | ❌ Wave 3 |
| GAME-03 | `GET /users/me/badges` returns user's earned badges | unit | `npx jest users.controller.spec -t "badges"` | ❌ Wave 3 |
| DONAT-01 | Stub flag fails hard in production | unit | `npx jest main.spec -t "DEV_DONATION_PAYMENT_STUB"` | ❌ Wave 0 |
| DONAT-01 | Webhook rejects non-whitelisted IP | unit | `npx jest donate.controller.spec -t "IP whitelist"` | ❌ Wave 2 |
| DONAT-01 | Duplicate webhook calls credit donor once (idempotency) | unit | `npx jest donate.service.spec -t "idempotent"` | ❌ Wave 2 |
| DONAT-02 | `/donate/spending` returns paid donations with non-null targetId | unit | `npx jest donate.service.spec -t "spending"` | ❌ Wave 2 |
| DONAT-03 | Admin breakdown groups by targetId + purpose | unit | `npx jest donate.service.spec -t "breakdown"` | ❌ Wave 2 |

### Sampling Rate

- **Per task commit:** `npx jest <changed-service>.spec.ts --bail --forceExit` (< 10s)
- **Per wave merge:** `npm test` (currently 773 tests, ~32s; Phase 3 will add ~50–80 tests)
- **Phase gate:** Full suite green; `npx tsc --noEmit` clean (both backend + frontend); manual smoke test of `/top` and `/donate` pages with WebSocket connected

### Wave 0 Gaps

- [x] `apps/backend/src/common/utils/privacy-mask.util.ts` + spec — supports TOP-06 anonymization across endpoints
- [x] `apps/backend/src/common/guards/ip-whitelist.guard.ts` + spec — supports DONAT-01
- [x] Add `BADGE_EARNED`, `TOP100_CONFIRMED` to `KAFKA_TOPICS` (kafka.service.ts) — supports GAME-02 + TOP-02
- [x] `DEV_DONATION_PAYMENT_STUB` fail-hard in `main.ts:_assertEnvVars`
- [x] `seedBadges()` invoked in `prisma/seed.ts` so dev DB has badges to award against
- [x] Existing test framework + 80% coverage threshold are already enforced; Phase 3 must maintain ≥ 80% on each new service

---

## Risks & Gotchas

### R1: 25x BHM (~$2,500) prize creates state-actor-level gaming incentive

**Scenario:** A coordinated network of 200 fake accounts, each "reading" 50 books/month via the comprehension test backdoor (now closed in Phase 2 FRAUD-01) + ISBN scan flood + librarian collusion. Even after Phase 2 hardening, the Top-100 ranks 100 people; if 30 are fake, the platform loses credibility.

**Mitigation in Phase 3:**
- FRAUD-07 multi-layer gate hard-rejects entries with TrustScore < 50 or any `FraudScore.action='confirmed'` in last 90d.
- 30-day admin review window (state READY_FOR_PUBLISH) gives SUPER_ADMIN time to manually verify Top-100 candidates.
- Auto-publish only triggers if no admin override fires during the review window. **Risk:** if SUPER_ADMIN forgets, fake accounts publish. **Mitigation:** Smart Alert (Phase 5) on 25th of month: "Top-100 30-day review window opens tomorrow — XX candidates pending".

### R2: WebSocket emit timing race during `confirmMonth`

**Scenario:** `confirmMonth` does `updateMany` + WebSocket emit. If the cron crashes between updateMany and emit, DB is updated but frontends don't refresh. Next-month cron correctly proceeds, but users see stale rank until manual refresh.

**Mitigation:** Wrap in `prisma.$transaction(async tx => { ... })` — but WebSocket emit is OUTSIDE the transaction (transactions can't include side effects to external systems). **Accepted V1 risk:** failure mode is "stale display", not "wrong data". Frontend can periodically re-fetch via React Query `staleTime: 60_000`.

### R3: Idempotency key TTL of 24 hours may be too short

**Scenario:** A Payme retry storm 25 hours after first webhook delivers a second IDEMPOTENT call. The Redis cache for `donate:webhook:${paymentId}` has expired. Second call re-processes, double-awarding badge.

**Mitigation:** Bump TTL to 7 days. CLAUDE.md doesn't specify TTL; Payme docs recommend 30 days. **Phase 4 will revisit when full Payme integration lands.** V1 stub TTL: 7 days.

### R4: Inventory reconciliation false positives during high-traffic minutes

**Scenario:** Reconciliation cron at 04:00 reads `book.availableCount` and `bookTransaction.count(BORROWED)` at slightly different times. A borrow that commits at 04:00:00.500 may be counted in one and not the other, generating spurious "5% discrepancy" alerts.

**Mitigation:** Wrap reconciliation read in `$transaction(async tx => { ... }, { isolationLevel: 'RepeatableRead' })`. Or schedule at 04:00 (already low-traffic for libraries). **Accepted V1 risk:** 0.1% false positive rate is acceptable for an "alert admin" path.

### R5: BookTransfer{PENDING} can stay forever (Phase 2 deferral)

**Phase 2 SUMMARY notes:** BookTransfer rejection endpoint (PENDING → REJECTED) deferred to v2. So a BookTransfer can stay PENDING indefinitely if the source library never confirms. Reconciliation math counts it in "expected available", correctly reflecting that the book is in transit. But a stuck transfer means the source library's `availableCount` never recovers.

**Mitigation:** FRAUD-08 reconciliation should also flag **stuck transfers** (PENDING > 30 days) with `severity: WARNING`. Add to the same cron.

### R6: Anonymization helper applied inconsistently across new code

**Scenario:** Phase 3 adds 4 new endpoints (institutional rankings, donor breakdown, spending, badges). Each one independently writes `user.name` to response. Developer forgets to apply `maskNameIfMinor`.

**Mitigation:** Linting rule (custom ESLint plugin) — out of scope for V1. **V1 mitigation:** spec-level cross-check that any endpoint returning `user.name` for public consumption applies the mask. Add an integration test that hits each public endpoint with a known child user and asserts no full name appears in the response.

### R7: Real-time WebSocket fan-out at scale

**Scenario:** 1M concurrent connections to `top100:2026-05` room. A single `emitTop100Update` broadcast pushes 30KB payload * 1M = 30GB. Redis pub/sub bandwidth peaks.

**Mitigation:** **Not a V1 problem** — V1 target is 50K concurrent (SLA per CLAUDE.md §X.4). Document the scaling concern; v2 explores per-region rooms (`top100:viloyat:{id}:2026-05`) with smaller payloads.

### R8: Badge race condition during high-frequency transaction flow

**Scenario:** User returns 6 books within 1 minute (legitimate or via librarian batch). All 6 returns trigger `checkAfterReturn(userId)` in parallel. Both rage at `returnedCount === 5` (FIVE_BOOKS milestone) — both attempt `userBadge.create`. `@@unique([userId, badgeId])` ensures only one succeeds, but the loser sees a Prisma P2002 error logged.

**Mitigation:** Already handled at `badge.service.ts:57` `try/catch` — duplicate failure returns `false` without crashing. Phase 3 should add an explicit spec for this race.

### R9: `User.dob` JOIN cost on every donor lookup

**Scenario:** `getPublicDonors` adds `user: { select: { name, sifatId, dob } }` JOIN. At 50 results per page, this is 50 extra column reads. Cumulative across heavy traffic on `/donate` could spike DB load.

**Mitigation:** Add covering index `User(id) INCLUDE (name, sifatId, dob)` — out of scope for V1. **Accepted V1 risk:** measure with k6 in Phase 7.

---

## Open Questions

1. **Should Top-100 compute use PrismaReplicaService (read replica)?**
   - **What we know:** Phase 1 INFRA-10 set up streaming replica; Phase 2 RiRecalcProcessor uses `PrismaReplicaService` for batch reads with primary fallback.
   - **What's unclear:** Top-100 runs once/month and currently reads in <2 minutes against dev seed. Production scale at 5M users TBD.
   - **Recommendation:** Use `this.replica.user.findMany(...)` for the read side; primary for `top100Entry.upsert`. Mirrors Phase 2 pattern exactly. Low cost to implement, high benefit at scale.

2. **Should the 1-day auto-publish cron require zero `Top100Entry{status: 'FLAGGED'}` to proceed?**
   - **What we know:** CLAUDE.md §V.4 says "1-kuni rasmiy Top-100 e'lon" — admin tasdiqlovi in step 4.
   - **What's unclear:** if 5 entries are FLAGGED on 1st 02:00, does the cron publish the OTHER 95 + 5 reserves to fill the gap, or does it BLOCK auto-publish until admin acts?
   - **Recommendation:** Auto-publish only the non-FLAGGED entries (could be < 100). The empty slots in Top-100 are intentional — they signal "we're investigating" and protect platform credibility. Add a `forcePublish` admin override for edge cases.

3. **DONAT-01: Is the simple `{result: {transaction}}` webhook payload acceptable for V1 stub, or must it match Payme JSON-RPC 2.0 exactly?**
   - **What we know:** Real Payme expects 6 JSON-RPC methods with specific param shapes. `PaymeService.handleWebhook()` already implements them. Donation webhook in `donate.controller.ts:62` does NOT match.
   - **What's unclear:** if frontend dev mode posts via fetch to `/donate/webhook/payme`, must the payload match real Payme to ease Phase 4 swap, or can V1 use a simpler shape since Phase 4 will refactor anyway?
   - **Recommendation:** Use the SIMPLE shape in V1 stub (as currently coded). Phase 4 will swap the `@Public() webhook/payme` route to delegate to `PaymeService.handleWebhook(authHeader, body)` and accept the real JSON-RPC payload.

4. **Should the inventory reconciliation cron also re-sync `Book.availableCount` (auto-fix), or only alert?**
   - **What we know:** CLAUDE.md §X.4 specifies "fond inventarizatsiya" (Plan 03-13 in TZ) — admin alert. No mention of auto-fix.
   - **What's unclear:** if cron auto-fixes, it may hide librarian theft / miscount. If cron only alerts, manual response time matters.
   - **Recommendation:** ALERT ONLY in V1. Auto-fix is dangerous when "discrepancy" could be a fraud signal. Document this decision in the cron's docblock.

5. **GAME-03 profile widget: render all 18 badges (locked + unlocked) or only earned?**
   - **What we know:** Badge gamification UX literature says "show what's possible to earn next" — render locked + unlocked.
   - **What's unclear:** locked badges may overwhelm new users with 0 badges.
   - **Recommendation:** Default render: "Earned" tab (X badges) + "Available" tab (18-X badges grayscale). User taps to switch.

6. **TOP-05 institutional ranking: where to source the school/OTM/idora link?**
   - **What we know:** `User.schoolId, universityId, organizationId` denormalized at `schema.prisma:163-171`. `Institution.code` at line 569 is a string like `MAKTAB-08012-008`.
   - **What's unclear:** is `User.schoolId` the `Institution.id`, the `Institution.code`, or a separate string ID? No FK constraint declared in the schema.
   - **Recommendation:** Treat as `Institution.id` (the CUID), aligned with `Institution.directorId String?` pattern at line 577. Verify with `prisma.user.findFirst({where: {schoolId: {not: null}}, include: {institution: ???}})` — but no relation declared so include won't work; use manual join in service.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL 15 | All persistence | Phase 1 confirmed | 15+ | — |
| Redis 7 | BullMQ + cache + Socket.IO adapter | Phase 1 confirmed | 7 | — |
| Kafka (kafkajs) | Optional badge.earned / top100.confirmed emit | Phase 1 confirmed (graceful no-op) | Broker optional | Backend boots without broker (warn log) |
| Node.js 20 LTS | Runtime | Phase 1 confirmed | 20+ | — |
| `socket.io-client` 4.7.5 | Frontend WebSocket | Already installed | — | — |
| Payme/Click API endpoints | DONAT-01 real path | Not required for V1 stub | — | DEV_DONATION_PAYMENT_STUB flag + Phase 4 hardening |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None requiring fallback design — all listed items are either present or have established graceful degradation patterns.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 3 ships zero new npm packages | Library Recommendations | If a new package is needed, slopcheck must run first. Low risk — Phase 1 + 2 already installed everything. |
| A2 | The DEV_OTP_BYPASS env pattern (boot-time fail-hard in production) is the canonical pattern for stub flags | DONAT-01, Wave 0 | Different security stance for donation stub could be required. Recommend confirming with project owner. |
| A3 | The Top100Entry.status free-form String column accepts new values (DRAFT, FRAUD_CHECKED, READY_FOR_PUBLISH, CONFIRMED, FLAGGED, REJECTED) without schema migration | TOP-02 state machine | If column has a CHECK constraint we missed, ALTER TABLE migration needed. Verified: schema.prisma:437 has `@default("DRAFT")` but no enum constraint — safe. |
| A4 | The existing 18 badges in BADGE_CATALOG include 3 (STREAK_7/30, ACTIVE_MONTH) without trigger code, and Phase 3 wires those triggers | GAME-01 | Already verified via codebase grep — no `checkAfterStreak` method exists. |
| A5 | Inventory reconciliation tolerates a 5% discrepancy threshold (not parameterized) | FRAUD-08 | Project owner may want viloyat-level threshold variance. V1 hardcodes 5% per requirement spec; planner can extract to config. |
| A6 | Real Payme/Click integration defers to Phase 4 PAY-01..08 entirely; Phase 3 does NOT need real signature verification | DONAT-01 | If project owner requires real Payme integration in Phase 3 (e.g., for a donation campaign launch before Phase 4 ships), this RESEARCH must be reconsidered. |
| A7 | The 1st-day auto-publish cron blocks if any entries are FLAGGED and only publishes non-FLAGGED entries | Open Question 2 | Could differ from project owner's intent. Recommend confirming in discuss-phase. |
| A8 | `User.schoolId` stores the `Institution.id` CUID | TOP-05 + Open Question 6 | Could be `Institution.code` instead. Recommend confirming or adding FK constraint. |

---

## Sources

### Primary (HIGH confidence)
- `apps/backend/src/modules/top/{top.service.ts, top.controller.ts, top.module.ts}` — current Top-100 implementation
- `apps/backend/src/modules/badge/{badge.service.ts, badge.module.ts}` — current badge system
- `apps/backend/src/modules/donate/{donate.service.ts, donate.controller.ts, donate.module.ts}` — current donation flow
- `apps/backend/src/modules/ai/fraud.service.ts:188` — `checkTop100Candidates` already wired
- `apps/backend/prisma/schema.prisma:426-484` — Top100Entry, Badge, UserBadge, Donate models
- `apps/backend/src/infra/gateway/stats.gateway.ts:169` — `emitTop100Update` method present, never invoked
- `apps/backend/src/infra/kafka/{kafka.service.ts, kafka-consumer.service.ts}` — INFRA-08 carry-over
- `apps/frontend/app/[locale]/{top/TopClient.tsx, donate/page.tsx, profile/page.tsx}` — current frontend state
- `.planning/phases/02-reading-index-engine-core-book-logic/02-VERIFICATION.md` — Phase 2 carry-overs canon
- `.planning/phases/01-infrastructure-hardening-authentication/01-VERIFICATION.md` — Phase 1 carry-overs canon
- `.planning/REQUIREMENTS.md:38-58, 187-195` — Phase 3 requirement IDs
- `CLAUDE.md` — V.2 Final Score, V.3 ranking list, V.4 workflow, XIV.3 donation, VIII security defaults

### Secondary (MEDIUM confidence)
- `.planning/research/PITFALLS.md F1-F3, C1, C5, C6, H4, M4` — fraud gaming + RI scaling concerns
- `.planning/research/ARCHITECTURE.md §1-§5` — Phase 1-2 architecture decisions (Kafka, BullMQ, WebSocket adapters)
- `.planning/research/FEATURES.md` — Donat module + gamification value-prop analysis

### Tertiary (LOW confidence)
- None — Phase 3 is fully scoped from local codebase + planning docs. No external lookups needed for V1.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TOP-01 | 6-component Final Score formula | Implemented in `top.service.ts:7-141`; verify weights + decompose monolithic query (FIX) |
| TOP-02 | Monthly workflow 28→29→30→1 | Partial (1 of 4 crons); add state machine + 3 missing crons (EXTEND) |
| TOP-03 | Gender-specific rankings | Complete (`top.service.ts:170` + index `@@index([month, gender])`) |
| TOP-04 | Age group rankings | Complete (`top.service.ts:18-24, 108`) |
| TOP-05 | Institutional rankings | Partial (viloyat/tuman via raw SQL); add MAKTAB/OTM/IDORA aggregation cron + endpoint (NEW) |
| TOP-06 | Children under 14 anonymization | Partial (`top.service.ts:211`); apply to donor + draft endpoints + WebSocket emit (EXTEND) |
| TOP-07 | Real-time leaderboard via WebSocket | Infra ready; invoke `gateway.emitTop100Update` from confirm/autoPublish + frontend subscribe (NEW invocation) |
| TOP-08 | LIMIT/OFFSET (not in-memory sort) | Bug at `reading.service.ts:414`; rewrite SQL (FIX, 10 LOC) |
| FRAUD-07 | Top-100 multi-layer verification | Single layer via `checkTop100Candidates`; add 4-layer `verifyTop100Candidate` (EXTEND) |
| FRAUD-08 | Inventory reconciliation 5%+ alert | Not implemented; new cron + service + Kafka emit + AiAuditLog write (NEW) |
| GAME-01 | 15+ badges | 18 badges in catalog; wire `seedBadges()` to seed.ts + add 3 missing triggers (EXTEND) |
| GAME-02 | Badge notifications | Award persists to UserBadge; add Kafka emit + consumer route + WebSocket toast (NEW notification path) |
| GAME-03 | Badges on profile | `getUserBadges` method exists; add `GET /users/me/badges` endpoint + frontend grid (NEW) |
| DONAT-01 | Payme/Click integration | Stub URLs in `donate.service.ts:168`; add DEV_DONATION_PAYMENT_STUB flag + IpWhitelistGuard + idempotency + signature placeholders for Phase 4 swap (FIX) |
| DONAT-02 | Public donor list + spending tracking | Donor list done; spending endpoint missing (frontend 404s); add `/donate/spending` (EXTEND) |
| DONAT-03 | Admin breakdown panel | Stats endpoint exists; add admin per-recipient grouping + dashboard page (NEW) |

---

## Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Current state audit | HIGH | Every claim has file:line citation against actual codebase; verified live |
| Top-100 workflow design | HIGH | State machine pattern is standard; CLAUDE.md §V.4 prescribes the dates exactly |
| Real-time leaderboard architecture | HIGH | Phase 1 INFRA-07 already shipped the multi-instance Redis adapter; method exists but uninvoked |
| Badge award detection | HIGH | Existing direct-service-call pattern from Phase 2 transactions; 9 passing specs prove it |
| Donation payment stub | MEDIUM | Pattern is established (DEV_OTP_BYPASS); the specific question of "real Phase 3 vs stub" is a project-owner decision (see Open Q 3) |
| Inventory reconciliation math | HIGH | BookTransfer semantics confirmed in Phase 2 SUMMARY 02-02; reconciliation formula derived from schema invariants |
| TOP-06 anonymization layer | HIGH | Privacy mask helper is a simple utility; cross-endpoint application is mechanical |
| Phase 1+2 carry-over respect | HIGH | All listed obligations are quoted from VERIFICATION docs |

**Research date:** 2026-06-06
**Valid until:** 2026-07-06 (30 days for stable infrastructure carry-overs; faster expiration if PAY-01 Phase 4 ships earlier than Phase 3 closure)

---

*Researched by gsd-researcher. Consumed by gsd-planner for Phase 3 PLAN.md creation.*
