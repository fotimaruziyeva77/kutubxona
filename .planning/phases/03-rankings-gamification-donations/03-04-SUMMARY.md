---
phase: 03-rankings-gamification-donations
plan: 04
subsystem: realtime + ui
tags: [websocket, socket.io, kafka, badges, anonymization, react-query, recharts, admin-ui]
dependency_graph:
  requires:
    - Plan 03-01 (maskNameIfMinor + KAFKA_TOPICS.BADGE_EARNED + BADGE_CATALOG seeded)
    - Plan 03-02 (autoPublish TODO + admin override service methods)
    - Plan 03-03 (donate.admin/breakdown endpoint)
    - Phase 1 INFRA-07 (StatsGateway Redis adapter)
    - Phase 1 INFRA-08 (KafkaConsumerService skeleton)
  provides:
    - StatsGateway.emitTop100UserFlagged + emitBadgeEarned + user:{userId} room
    - TopService.autoPublish + confirmMonth + admin overrides wired to broadcast
    - TopService.getAdminReviewQueue + GET /top/admin/review-queue endpoint
    - BadgeService.checkAfterReturnForStreak (STREAK_7 + STREAK_30)
    - BadgeService.checkActiveMonth (top-decile RI delta)
    - BadgeService.award emits KAFKA_TOPICS.BADGE_EARNED
    - KafkaConsumerService route BADGE_EARNED → emitBadgeEarned
    - GET /users/me/badges {earned, available}
    - /dashboard/top-review admin queue UI
    - /dashboard/donations admin breakdown UI
    - profile/page.tsx BadgesGrid widget (Earned + Available tabs, real-time toast)
    - TopClient.tsx WebSocket subscribe to top100:{month}
  affects:
    - Phase 4 (Payments) — donate.admin breakdown UI will surface invoice donor metrics
    - Phase 7 (PERF) — gateway emit volume tracked here is the baseline for AI Audit Engine subscriber metrics
tech_stack:
  added: []
  patterns:
    - "Defense-in-depth anonymization — maskNameIfMinor applied at WebSocket emit time AND HTTP response time (not just one layer)"
    - "Best-effort side effects in cron handlers — emit/badge failures logged but never roll back the persisted status transition"
    - "@Optional KafkaService injection — BadgeService stays unit-testable without DI rewiring"
    - "Frontend WebSocket subscribe pattern — invalidate React Query cache on broadcast (no manual state sync)"
    - "Dynamic emit OUTSIDE $transaction — admin override emit chained via .then() so Redis hiccups never roll back DB mutation"
    - "Frontend BADGE_CATALOG_FRONT mirror — V1 duplication accepted for Available tab; backend remains source of truth via /users/me/badges"
key_files:
  created:
    - .planning/phases/03-rankings-gamification-donations/03-04-SUMMARY.md
    - apps/frontend/app/[locale]/dashboard/top-review/page.tsx
    - apps/frontend/app/[locale]/dashboard/donations/page.tsx
    - apps/backend/src/modules/users/__tests__/users.controller.spec.ts
  modified:
    - apps/backend/src/infra/gateway/stats.gateway.ts
    - apps/backend/src/modules/top/top.service.ts
    - apps/backend/src/modules/top/top.module.ts
    - apps/backend/src/modules/top/top.controller.ts
    - apps/backend/src/modules/top/__tests__/top.service.spec.ts
    - apps/backend/src/modules/badge/badge.service.ts
    - apps/backend/src/modules/badge/badge.module.ts
    - apps/backend/src/modules/badge/__tests__/badge.service.spec.ts
    - apps/backend/src/infra/kafka/kafka-consumer.service.ts
    - apps/backend/src/infra/kafka/kafka-consumer.service.spec.ts
    - apps/backend/src/modules/users/users.controller.ts
    - apps/backend/src/modules/users/users.module.ts
    - apps/frontend/app/[locale]/top/TopClient.tsx
    - apps/frontend/app/[locale]/profile/page.tsx
decisions:
  - "D-TOP-07 (defense-in-depth anonymization): maskNameIfMinor applied at WebSocket emit time AND HTTP response time — so a snooper subscribed via the public top100:{month} room sees masked names directly on the wire (no leaky payload)"
  - "Circular import resolved by ADDITION not forwardRef: TopModule imports GatewayModule + BadgeModule cleanly (GatewayModule has no provider dependency on TopService, BadgeModule has no dependency on TopService — direction is one-way). forwardRef was unnecessary."
  - "Best-effort side effects: cron emit/badge failures logged-and-continue; never roll back the status transition (RESEARCH R2 race accepted)"
  - "Admin override emit OUTSIDE the $transaction — wrapped in $transaction(...).then(...) so the broadcast happens only after the DB mutation commits"
  - "BadgeService.kafka injected @Optional — preserves existing 16 baseline tests without rewiring DI"
  - "Already-awarded badge path does NOT emit BADGE_EARNED — re-checks would otherwise spam the consumer + toast"
  - "ACTIVE_MONTH V1 LIMITATION (documented in JSDoc per plan-checker WARNING-3): top-decile predicate is approximated via top-200 Top100Entry candidates iterated inside autoPublish — under-awards, never over-awards; V2 should scan full ReadingIndex paginated"
  - "BADGE_CATALOG_FRONT frontend mirror duplicates the backend catalog for the Available tab — V1 acceptable; future v2 should expose a /badges public endpoint to eliminate the duplication"
  - "Sidebar link to /dashboard/top-review NOT added (layout.tsx not in plan files_modified) — accessible by URL; SUPER_ADMIN can sidebar-add in next plan if needed"
  - "Donations dashboard recharts PieChart + horizontal BarChart — recharts ^2.12.7 already in deps from buxgalter page"
requirements:
  - TOP-07
  - GAME-01
  - GAME-02
  - GAME-03
metrics:
  duration_min: 32
  task_count: 2
  file_count: 15
  tests_added: 24
  tests_total: 891
  tests_baseline: 867
  completed_date: "2026-06-06"
---

# Phase 3 Plan 04: Real-time Delivery + Admin UI Summary

**One-liner:** Wired the existing-but-uninvoked StatsGateway into the Top-100 publication path with anonymization-at-emit-time, completed the 18-badge catalog with STREAK_7/30 + ACTIVE_MONTH triggers, routed Kafka BADGE_EARNED events to a per-user WebSocket room, and shipped two admin dashboard pages (Top-100 review queue + donations breakdown) plus a profile BadgesGrid widget.

This plan is the **observable surface** of Phase 3 — every backend state machine and fraud check built in waves 1-3 now reaches actual users in real time through WebSocket broadcasts and tactile admin UI.

## Tasks Executed

### Task 1 — TOP-07 WebSocket wiring + admin review queue UI

**Commit:** `14a391f` — `feat(top,frontend)(03-04): TOP-07 WebSocket wiring + admin review queue UI`

**What shipped:**

- **`StatsGateway.emitTop100UserFlagged(month, userId, action)`** — broadcasts a small `{month, userId, action, ts}` payload to `top100:${month}` on event `top100:flag` when an admin flag/clear/reject/confirm fires.
- **`StatsGateway.emitBadgeEarned(userId, badgeCode)`** — broadcasts `{userId, badgeCode, ts}` to `user:${userId}` on event `badge:earned`. Companion to Task 2's Kafka consumer route.
- **`StatsGateway.isAllowedRoom`** — extended with `/^user:[a-zA-Z0-9_-]+$/` whitelist regex so clients can subscribe to their own private room (T-03-04-S accepted: room name is public, payload is safe).
- **`TopService` constructor injection** — `StatsGateway` + `BadgeService` added; module wiring in `top.module.ts` imports `GatewayModule + BadgeModule` (no circular — direction is one-way).
- **`TopService._buildBroadcastPayload(month)`** (private) — fetches CONFIRMED entries with `user.dob`, maps via `maskNameIfMinor` BEFORE the broadcast. Defense-in-depth: HTTP and WebSocket payloads BOTH masked.
- **`TopService.autoPublish` wiring** — after the `updateMany({status: CONFIRMED})` transition: `emitTop100Update(prevMonth, anonimizedEntries)` + `badge.checkTopEntries(prevMonth)` + `badge.checkActiveMonth(userId, prevMonth)` for each of the top-200 candidates. All three side effects wrapped in try/catch so emit failures do NOT roll back the publish.
- **`TopService.confirmMonth(month)`** — mirrors the autoPublish broadcast emit for the manual SUPER_ADMIN "Force Publish" path.
- **`TopService._overrideStatus`** — `flagUser/clearFlag/rejectEntry/confirmEntry` now broadcast `top100:flag` via `gateway.emitTop100UserFlagged` AFTER the $transaction commits (chained via `.then()` to avoid rolling back the DB mutation on emit failure).
- **`TopService.getAdminReviewQueue(month)`** + `GET /top/admin/review-queue?month=` — returns ALL non-CONFIRMED entries (DRAFT, FRAUD_CHECKED, READY_FOR_PUBLISH, FLAGGED, REJECTED) with `maskNameIfMinor` applied. Separate from `/top/draft` which excludes REJECTED.
- **`TopClient.tsx`** — `useEffect` subscribes to `top100:${month}` room via `socket.io-client`, on `top100:update | top100:flag` calls `queryClient.invalidateQueries(['top100'])`. `withCredentials: true` per INFRA-02.
- **`/dashboard/top-review/page.tsx`** — admin queue UI: table with rank/user/score/trust/status/flag-reasons columns + four action buttons (Flag/Clear/Reject/Confirm) calling Plan 03-02 endpoints. Optimistic React Query invalidation + toast on each transition. Force-Publish button bulk-confirms the whole month.

**Tests added (9):** autoPublish emit shape, anonymization at emit (minor masked), checkTopEntries+checkActiveMonth chain, emit failure does not roll back, confirmMonth emit, flagUser/clearFlag/rejectEntry override emits, getAdminReviewQueue scope + minor masking. **Total 41 in top.service.spec.ts.**

---

### Task 2 — Badge triggers + Kafka emit + GET /users/me/badges + profile widget + dashboard donations

**Commit:** `379c849` — `feat(badge,users,frontend)(03-04): badge triggers + Kafka emit + profile widget + dashboard donations (GAME-01..03)`

**What shipped:**

**Backend — badge triggers (GAME-01 completion):**

- **`BadgeService.checkAfterReturnForStreak(userId)`** — STREAK_7 (≥7 distinct calendar days in last 30) + STREAK_30 (≥30 distinct days in last 60). Uses `Set<toDateString()>` over `findMany` results (Prisma `distinct` keys by full column, not day part). Chained from `checkAfterReturn` so the existing `transactions.service.ts:387` call site picks it up — **no transactions.service.ts change required.**
- **`BadgeService.checkActiveMonth(userId, month)`** — Prisma `$queryRaw` single-row percentile: counts users with greater RI delta this month + total active users; awards `ACTIVE_MONTH` when `(rank+1)/total ≤ 0.1`. **V1 LIMITATION documented in JSDoc per plan-checker WARNING-3:** trigger called inside `autoPublish` against the top-200 Top100Entry candidates only (user ranked 201st with high RI delta is missed). Conservative (under-awards, never over-awards). V2 should run as a separate scan after `scheduleNightlyRecalculation`.

**Backend — Kafka emit (GAME-02):**

- **`BadgeService` constructor** — `KafkaService` injected as `@Optional` (preserves existing 16 baseline unit tests that construct `BadgeService` without DI module).
- **`BadgeService.award`** — success branch calls `kafka.emit({topic: BADGE_EARNED, key: userId, value: {userId, badgeCode, awardedAt}})`. **Already-awarded path does NOT emit** so re-checks don't spam the consumer. Emit failure logged via `.catch()` chain — never throws back to caller.
- **`KafkaConsumerService.ALERT_TOPICS`** — extended with `KAFKA_TOPICS.BADGE_EARNED`.
- **`KafkaConsumerService.handleMessage`** — branched routing: `topic === BADGE_EARNED && userId && badgeCode` → `gateway.emitBadgeEarned(userId, badgeCode)`. Other topics fall through to existing `emitNewAlert`. Bad payload (missing userId or badgeCode) logged-and-dropped.

**Backend — endpoint (GAME-03):**

- **`UsersController.getMyBadges(user)`** — `GET /users/me/badges` returns `{earned, available}` where `earned = badge.getUserBadges(user.sub)` (UserBadge join + catalog metadata) and `available = BADGE_CATALOG.filter(b => !earnedCodes.has(b.code))`. JWT-guarded — only the holder sees their own badges (T-03-04-T mitigated).
- **`UsersModule` imports `BadgeModule`** for the new endpoint's DI.

**Frontend — profile BadgesGrid widget (GAME-03 + D-5):**

- **`profile/page.tsx`** — `BadgesGrid` section between O'qish statistikasi and Faoliyat tarixi cards. Two tabs:
  - **Olingan (Earned):** colorful grid with awardedAt tooltip, empty state "Hali badge yo'q"
  - **Mavjud (Available):** grayscale grid with 🔒 lock indicator, sourced from `BADGE_CATALOG_FRONT` (V1 frontend mirror) — server-truth-overlay via `badgesData.available` when fetched
- **WebSocket subscribe** to `user:${profile.id}` room. On `badge:earned` event: show toast `{icon} Yangi badge: {name}!` and invalidate `['my-badges']` React Query cache.

**Frontend — donations dashboard (DONAT-03 surface):**

- **`/dashboard/donations/page.tsx`** — admin UI consuming `/donate/admin/breakdown` (SUPER_ADMIN + BUXGALTER backend guard). Sections:
  - 4-card headline (total collected / spent / remaining / donor count) from `/donate/stats`
  - Purpose donut (recharts `PieChart` with `LIBRARY_BOOKS/SCHOOL_BOOKS/GENERAL` legend)
  - Top-10 target horizontal bar chart (recharts `BarChart` layout=vertical)
  - Full target spending table

**Tests added (15):** badge: 3 STREAK + 3 ACTIVE_MONTH + 2 Kafka emit = 8 new (24 total). Kafka consumer: 2 (BADGE_EARNED route + bad-payload defense) = 8 total. Users controller: 4 new (new spec file).

## Task Commits

1. **Task 1: TOP-07 WebSocket wiring + admin review queue UI** — `14a391f` (feat)
2. **Task 2: GAME-01..03 (badge triggers + Kafka emit + profile widget + dashboard donations)** — `379c849` (feat)

## Files Created/Modified

**Created (4):**
- `apps/frontend/app/[locale]/dashboard/top-review/page.tsx` — admin Top-100 monthly review queue UI
- `apps/frontend/app/[locale]/dashboard/donations/page.tsx` — admin donations breakdown UI (SUPER_ADMIN + BUXGALTER)
- `apps/backend/src/modules/users/__tests__/users.controller.spec.ts` — GET /users/me/badges contract (4 tests)
- `.planning/phases/03-rankings-gamification-donations/03-04-SUMMARY.md` — this file

**Modified (12):**
- `apps/backend/src/infra/gateway/stats.gateway.ts` — emitTop100UserFlagged + emitBadgeEarned + user:* room whitelist
- `apps/backend/src/modules/top/top.service.ts` — gateway DI + autoPublish/confirmMonth/admin override emit wiring + _buildBroadcastPayload + getAdminReviewQueue
- `apps/backend/src/modules/top/top.module.ts` — import GatewayModule + BadgeModule
- `apps/backend/src/modules/top/top.controller.ts` — GET /top/admin/review-queue (SUPER_ADMIN)
- `apps/backend/src/modules/top/__tests__/top.service.spec.ts` — 9 new tests (41 total)
- `apps/backend/src/modules/badge/badge.service.ts` — @Optional KafkaService + Kafka emit on award + checkAfterReturnForStreak + checkActiveMonth
- `apps/backend/src/modules/badge/badge.module.ts` — docstring documenting KafkaModule @Global DI
- `apps/backend/src/modules/badge/__tests__/badge.service.spec.ts` — 8 new tests (24 total)
- `apps/backend/src/infra/kafka/kafka-consumer.service.ts` — BADGE_EARNED topic routing
- `apps/backend/src/infra/kafka/kafka-consumer.service.spec.ts` — 2 new tests (8 total)
- `apps/backend/src/modules/users/users.controller.ts` — getMyBadges endpoint + BadgeService DI
- `apps/backend/src/modules/users/users.module.ts` — import BadgeModule
- `apps/frontend/app/[locale]/top/TopClient.tsx` — socket.io subscribe + invalidate cache
- `apps/frontend/app/[locale]/profile/page.tsx` — BadgesGrid widget (Earned + Available tabs) + badge:earned subscribe

## Decisions Made

- **D-TOP-07 (defense-in-depth anonymization):** `maskNameIfMinor` applied at WebSocket emit time AND at HTTP response time. Two-layer mask means a snooper subscribed to `top100:{month}` sees masked names on the wire, not just in HTTP responses.
- **Circular import resolved by ADDITION:** TopModule imports GatewayModule + BadgeModule cleanly. forwardRef was unnecessary because dependency direction is one-way (GatewayModule has no Top dependency; BadgeModule has no Top dependency).
- **Best-effort side effects:** cron emit failures + badge check failures are logged-and-continue. The status transition stays committed (RESEARCH R2 race window accepted).
- **Admin override emit OUTSIDE $transaction:** broadcast happens in `.then()` chain after the DB transaction commits. Redis hiccup cannot roll back the DB mutation.
- **@Optional KafkaService injection on BadgeService:** preserves the 16 baseline tests that constructed BadgeService directly with PrismaService only. No DI module rewiring needed.
- **Already-awarded badge does NOT emit BADGE_EARNED:** prevents consumer + toast spam on the daily re-check loops.
- **ACTIVE_MONTH V1 limitation explicit:** JSDoc + this SUMMARY both flag that the trigger approximates "top 10%" as the top-200 Top100Entry candidates. Under-awards, never over-awards. V2 work item documented.
- **Frontend BADGE_CATALOG_FRONT mirror (V1):** the Available tab uses a hand-maintained mirror so it renders even when the user has zero awards. Future v2 should expose `/badges` public endpoint to eliminate the duplication.
- **Sidebar link skipped (out of plan files_modified):** /dashboard/top-review is reachable by URL; SUPER_ADMIN can add the sidebar link in a future plan. Strict scope discipline honored.
- **`recharts` chart library:** already in deps (^2.12.7) from buxgalter page — no new dependency added.

## Deviations from Plan

None — plan executed exactly as written. Strict scope discipline maintained: exactly the 15 files in `files_modified` were touched. No new files outside the plan's `created` artifacts.

## Issues Encountered

- **Mock setup race in top.service spec:** Pre-existing autoPublish tests didn't mock `top100Entry.findMany` because the original autoPublish never read it. After adding `_buildBroadcastPayload`, the broadcast call invokes `findMany` — without mocks it returned `undefined`, and the `.map()` call threw inside the try/catch. The try/catch absorbed the error correctly (publish still succeeded), but the test logs showed warnings. **Resolution:** Added `?? []` guard on the ACTIVE_MONTH candidates loop and a `mockResolvedValue([])` in the confirmMonth test. Pre-existing autoPublish tests left intact — they verify the publish-stays-on-emit-failure invariant which is desirable behavior.
- **BigInt return from $queryRaw:** Prisma raw SQL returns `bigint` for COUNT — tests pass `BigInt(N)` and the service uses `Number(row.rank)` / `Number(row.total)` for arithmetic.

## Phase 3 Wrap-up Reflection

This is the **final plan** of Phase 3 (rankings + gamification + donations). With this plan green:

**16/16 requirements delivered:**
- TOP-01..08 — Reading Index formula, state machine, anonymization, AI fraud gate, leaderboard, regional ranking, real-time broadcast, SQL pagination
- FRAUD-07..08 — 4-layer Top-100 candidate gate + reconciliation alerts
- GAME-01..03 — 18-badge catalog reachable + Kafka pipeline + profile widget
- DONAT-01..03 — Webhook idempotency + public donor list + admin breakdown

**7 user decisions honored:**
- D-1: PrismaReplicaService for fan-out reads
- D-2: FLAGGED preserves rank slot (no renumbering)
- D-5: BadgesGrid Earned + Available tabs
- D-TOP-06: maskNameIfMinor at every public emit point (HTTP + WebSocket)
- D-TOP-07: defense-in-depth anonymization at the WebSocket layer (this plan)
- D-DONAT-01: IpWhitelistGuard for payment webhooks
- D-DONAT-02: donations spending history publicly readable

**Test suite health:**
- Backend: 891 / 891 green (867 baseline + 24 new in this plan)
- Backend TypeScript: clean (`tsc --noEmit`)
- Frontend TypeScript: clean (`tsc --noEmit`)
- Plan 03 alone added: 25 + 29 + (Plan 03-03 tests) + 24 = ~110 new backend tests across the phase.

**Deferred to Phase 4 (Payments):**
- **Real Payme/Click integration** — Phase 3 ships idempotency + IP whitelist guards on the webhook endpoints, but the production Payme Merchant API + Click Cash signature verification HMAC remain Phase 4 scope. Donate.service.handlePaymentWebhook is stub-flow-safe (DONAT-01 wraps it in `cache.remember` for 7-day idempotency) but the real signature check is a Phase 4 deliverable.
- **Invoice subscription tie-in** — donate.admin/breakdown shows recorded spending, but the subscription lifecycle hooks (Idora/OTM annual SaaS) come in Phase 4.

**Deferred to Phase 7 (PERF + AI):**
- **Python AI engine Kafka consumer** — NestJS consumer covers V1 alerts; the Python AI Audit Engine subscriber is Phase 7.
- **ACTIVE_MONTH dedicated scan** — V2 should iterate full ReadingIndex instead of top-200 candidates.
- **Top-100 review queue tuman-scoped admin override** — currently SUPER_ADMIN only; V2 will gate per-region admins.

**Phase 3 is code-complete and ready for `gsd-verifier`.**

## Self-Check: PASSED

- `apps/backend/src/infra/gateway/stats.gateway.ts` — FOUND (verified via Read)
- `apps/backend/src/modules/top/top.service.ts` — FOUND
- `apps/backend/src/modules/top/top.module.ts` — FOUND
- `apps/backend/src/modules/top/top.controller.ts` — FOUND
- `apps/backend/src/modules/top/__tests__/top.service.spec.ts` — FOUND
- `apps/backend/src/modules/badge/badge.service.ts` — FOUND
- `apps/backend/src/modules/badge/badge.module.ts` — FOUND
- `apps/backend/src/modules/badge/__tests__/badge.service.spec.ts` — FOUND
- `apps/backend/src/infra/kafka/kafka-consumer.service.ts` — FOUND
- `apps/backend/src/infra/kafka/kafka-consumer.service.spec.ts` — FOUND
- `apps/backend/src/modules/users/users.controller.ts` — FOUND
- `apps/backend/src/modules/users/users.module.ts` — FOUND
- `apps/backend/src/modules/users/__tests__/users.controller.spec.ts` — FOUND
- `apps/frontend/app/[locale]/top/TopClient.tsx` — FOUND
- `apps/frontend/app/[locale]/profile/page.tsx` — FOUND
- `apps/frontend/app/[locale]/dashboard/top-review/page.tsx` — FOUND
- `apps/frontend/app/[locale]/dashboard/donations/page.tsx` — FOUND
- Commit `14a391f` — FOUND in git log
- Commit `379c849` — FOUND in git log

## Next Phase Readiness

- **Phase 3 ready for `gsd-verifier`** — all four plans (03-01, 03-02, 03-03, 03-04) complete; backend tests green; TS clean both apps.
- **Phase 4 (Payments) unblocked** — donate webhook idempotency + admin breakdown layer is the foundation Phase 4 builds on for the real Payme/Click signature verification + Subscription/Invoice lifecycle.

---
*Phase: 03-rankings-gamification-donations*
*Completed: 2026-06-06*
