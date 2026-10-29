---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: completed
stopped_at: Phase 7 Plan 01 complete (2/2 tasks; commits d602bbe + e212ed6). Wave 0 PWA foundations shipped -- Serwist replaces hand-written sw.js with build-time precache manifest, Dexie.js offline DB schema (syncQueue + cachedBooks + cachedLibraries), 2G detection utility + useNetworkStatus hook, User.hideReadingHistory privacy column, AiAuditLog range-partitioned by month (60 partitions 2024-01..2028-12), ES ICU analysis plugin in docker-compose. Ready for Plan 07-02 (offline sync, components, audit retention cron).
last_updated: "2026-06-09T05:27:04.888Z"
last_activity: 2026-06-09 -- Phase 8 marked complete
progress:
  total_phases: 8
  completed_phases: 7
  total_plans: 46
  completed_plans: 44
  percent: 88
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-06)

**Core value:** Hududlar kesimida kitobxonlik indeksini real vaqtda hisoblash va shaffof reyting shakllantirib, davlat darajasida analitik qaror qabul qilishni ta'minlash.
**Current focus:** Phase 8 — Bookstore Ecosystem

## Current Position

Phase: 8 — COMPLETE
Plan: 4 of 4
Status: Phase 8 complete
Last activity: 2026-06-09 -- Phase 8 marked complete

Progress: [██████████] 96%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 1 P2 | 6min | 4 tasks | 5 files |
| Phase 1 P3 | 14min | 4 tasks | 21 files |
| Phase 1 P5 | 5min | 3 tasks | 5 files |
| Phase 1 P4 | 23min | 4 tasks | 9 files |
| Phase 1 P6 | 13min | 3 tasks (Task 2 deferred) | 8 files |
| Phase 02 P01 | 15 | 5 tasks | 7 files |
| Phase 02 P02 | 35 | 5 tasks | 6 files |
| Phase 02 P03 | 22 | 3 tasks | 9 files |
| Phase 02 P04 | 28 | 4 tasks | 19 files |
| Phase 02 P05 | 30 | 4 tasks | 9 files |
| Phase 03 P01 | 25 | 2 tasks | 9 files |
| Phase 03 P02 | 14min | 2 tasks | 9 files |
| Phase 03 P03 | 18min | 2 tasks | 11 files |
| Phase 03 P04 | 32 | 2 tasks | 17 files |
| Phase 07 P01 | 12min | 2 tasks | 10 files |
| Phase 07 P06 | 5min | 2 tasks | 13 files |
| Phase 08 P04 | 7min | 2 tasks | 9 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 7 phases derived from dependency order -- infra fixes first, then RI engine, then revenue (payments), then monitoring, then PQ-9 modules, then AI + production hardening
- [Roadmap]: Phase 4 (Payments) depends only on Phase 1 and can run in parallel with Phase 2/3
- [Roadmap]: AI system (AI-01 through AI-05) placed in Phase 7 alongside production launch -- rule-based fallbacks already exist in NestJS, full AI is enhancement not blocker
- [Roadmap]: ML-based fraud detection deferred to v2 -- rule-based fraud with FLAGGED status is V1.0 scope
- [Phase ?]: [01-02]: Vault fails hard in production (no dev-root-token fallback); VAULT_TOKEN/VAULT_ADDR asserted at boot
- [Phase ?]: [01-02]: Alpine container timezone needs tzdata + TZ=Asia/Tashkent for correct cron wall-clock
- [Phase ?]: [01-03]: OTP rate limiting moved to atomic Redis incrWithTtl (INCR + first-hit-only EXPIRE); per-replica in-memory Map removed
- [Phase ?]: [01-03]: JwtAuthGuard registered globally (default-deny) with @Public() allowlist across 12 controllers; iduz routes deferred to Plan 06
- [Phase ?]: [01-03]: OTP kept at 6 digits (pinned by test); 4-vs-6 override remains a Plan 01-01 checkpoint
- [Phase ?]: [01-05]: WebSocket multi-replica fan-out via @socket.io/redis-adapter in StatsGateway.afterInit; Nginx ip_hash sticky sessions required in prod
- [Phase ?]: [01-05]: Kafka consumer (INFRA-08) built on installed kafkajs (not @nestjs/microservices); routes alert topics to gateway, no-ops when KAFKA_BROKERS unset
- [Phase ?]: [01-01]: SMS keystone — direct-fetch Eskiz client over the unofficial eskiz-sms wrapper (supply-chain); token cached as instance field, re-auth only on 401 (Pitfall 5); forwardRef on SmsModule↔QueueModule to break the import cycle when wiring EskizSmsClient into NotificationProcessor; @Processor(NOTIFICATION_QUEUE) decorator re-enabled (NOTIF-04); Task 3 live-delivery verification PENDING — blocked on user-supplied Eskiz credentials
- [Phase ?]: [01-04]: INFRA-02 cookie migration shipped atomically in 4 commits (RED spec → backend GREEN → frontend GREEN → middleware); refreshToken now lives ONLY in HttpOnly cookie scoped to /api/auth (sameSite=lax, secure-in-prod, maxAge=30d); axios withCredentials:true; Zustand partialize no longer persists refreshToken; auth.controller.spec is the first controller-level test in the codebase (6/6 GREEN); full backend suite 674/674 (+6 over baseline 668); AUTH-02 localePrefix='always' pinned explicitly; runtime-verified /login /register /dashboard all 307 to /uz-Latn/*
- [Phase ?]: [01-06]: OneID OAuth2 repointed at sso.egov.uz with non-standard .do grant flow (one_authorization_code / one_access_token_identify); PINFL from `pin` field with sub/pinfl fallback; CSRF state now anchored to HttpOnly iduz_state cookie (timing-safe), client-supplied expected_state body field removed; @Public() on iduz routes resolves the Plan 01-03 deferred lockout; prod boot hard-fails when IDUZ_CLIENT_ID/SECRET unset (no dev-client leak); Task 2 live handshake PENDING credentials
- [Phase ?]: [01-06]: INFRA-09/10 — PgBouncer (edoburu/pgbouncer:1.22.0, transaction mode) + postgres-replica (streaming via pg_basebackup -R) added to docker-compose.prod.yml; schema.prisma datasource gets directUrl env("DIRECT_DATABASE_URL") so migrations bypass the pooler; DATABASE_URL=...pgbouncer:6432?pgbouncer=true&connection_limit=1 to disable Prisma prepared-statement caching (Pitfall 4); app-side read-replica routing DEFERRED to Phase 2/5
- [Phase ?]: [01-06]: AUTH-04 verify-only — admin.service cron at lines 77-105 already converts 14d PENDING -> ACTIVE+CITIZEN; test suite now asserts findMany 14-day cutoff shape, SMS enqueue per stale user, and negative case (recent PENDING untouched); no production logic in admin.service.ts modified
- [Phase ?]: [02-01]: exceljs@^4.4.0 installed; xlsx uninstall deferred to Plan 02-04 with the books.service import swap
- [Phase ?]: [02-01]: RiskLevel BLOCKED renamed to FLAGGED with action='review' mapping; User.status='BLOCKED' auto-block preserved pending Plan 02-04 review-queue endpoint
- [Phase ?]: [02-01]: @CurrentUser decorator data parameter now honored — 'id' maps to payload.sub; pre-existing latent bug in store/otm controllers fixed as Rule 1 side-effect
- [Phase ?]: [02-02]: Bootstrap fix — dev DB was db-pushed in Phase 1, so `_prisma_migrations` table did not exist. Used `prisma migrate resolve --applied` for the 2 prior migrations (init + sprint2_geo_auth) THEN `migrate deploy` for the 3 new Phase 2 migrations. Canonical recovery sequence per Prisma baselining docs
- [Phase ?]: [02-02]: ReadingIndex is now a PostgreSQL native range-partitioned table (PARTITION BY RANGE (calculatedAt)) with 16 monthly partitions covering 2025-05 through 2026-08. Composite PK is (id, calculatedAt). Prisma still models it as a regular table — PG transparently routes inserts/selects. PG ≥ 11 auto-propagates the composite index to every partition
- [Phase ?]: [02-02]: BookTransaction.extended Boolean replaces the legacy penaltyDays = -1 sentinel; backfill in migration; extendDueDate now writes extended=true; second-extension guard reads tx.extended === true (H6 retired)
- [Phase ?]: [02-02]: BookTransfer model wired (PENDING/CONFIRMED/REJECTED). returnRoaming creates PENDING rows; the source library Book.availableCount is NO LONGER bumped on roaming return — the move-of-inventory waits for the bilateral confirm endpoint (Plan 02-05)
- [Phase ?]: [02-02]: All 4 array-form prisma.$transaction([...]) sites converted to interactive callback form (cancelReservation, borrow, autoExpireReservations + Task 2's returnRoaming). isRaceError/rethrowRace helpers translate Prisma P2010 CHECK violations to BadRequestException("Inventory race condition — retry"). Plan accepted ≥6 interactive; we have 7
- [Phase ?]: [02-03]: RI batch engine via BullMQ fan-out — PrismaReplicaService (dual PrismaClient, falls back to primary when DATABASE_REPLICA_URL unset, mirrors Kafka graceful-no-op) + RiRecalcProcessor (@Processor concurrency 10, single createMany per chunk against partitioned ReadingIndex from 02-02) + scheduleNightlyRecalculation (count → ceil/1000 → addBulk with jobId='ri-recalc:YYYY-MM-DD:N' for dedupe). 5M users projected ~100 min vs. 69h sequential (C6 closed)
- [Phase ?]: [02-03]: FRAUD-05 reading-speed signal (signal 2 of 3) folded into the RI processor: pages/hour > 100 OR borrow-to-return < 30min → bounded -5 trust delta per user per chunk. Two-sided gate (plausible-pace = no-op) prevents false positives. Comprehension-test signal (3 of 3) deferred to Plan 02-05; location signal (4) deferred to v2
- [Phase ?]: [02-04]: BOOK-01 V1 file payload = base64 in BullMQ data, 10MB FileInterceptor cap; MinIO offload deferred to V2
- [Phase ?]: [02-04]: FRAUD-03 dailyFraudScan auto-block REMOVED; admin review queue (TUMAN/VILOYAT/SUPER tier-scoped); resolveReview updates FraudScore.action only (User.status mutation remains a separate admin action)
- [Phase ?]: [02-04]: RI_SPIKE rule fixed — today vs yesterday explicit findFirst, not the 5-record window; missing yesterday → skip rule
- [Phase ?]: [02-04]: RI-04 delta cache TTL = 1h Redis, no explicit invalidation (1h staleness ceiling acceptable; Kafka-driven invalidation deferred)
- [Phase ?]: [02-04]: RI-03 partition lifecycle bounded at 13 months; older partitions O(1)-dropped via DETACH+DROP TABLE; STORE-01 24h confirm gate uses server-side time comparison
- [Phase ?]: [02-05]: BOOK-02 bilateral confirm ships — POST /libraries/:id/transfers/:tid/confirm in LibrariesController; interactive $transaction with Prisma's atomic { increment: 1 } on Book.availableCount; double-confirm rejected at the in-transaction status check (T-02-24); auth gate is SUPER_ADMIN bypass OR Institution.directorId match OR tier-admin (TUMAN/VILOYAT) via RolesGuard (T-02-23)
- [Phase ?]: [02-05]: blockOverdueUsers cron renamed to recomputeOverdueDays — naming honesty; the cron has never called prisma.user.update or changed user.status, it only updates BookTransaction.penaltyDays. The actual borrow-time block lives in hasOverdueBooks() entry-point ForbiddenException. Grep gate verifies 0 occurrences of the old name in transactions.service.ts
- [Phase ?]: [02-05]: FRAUD-05 signal 3 (comprehension pass-rate) lands in RiRecalcProcessor — last-30d passRate > 0.8 → +5, < 0.4 → -5, mid-range no-op. Combined with reading-speed signal (Plan 02-03) into a single bounded delta [-10, +10] per chunk per user (T-02-25). FRAUD-05 V1 signals (discipline + speed + comprehension) all shipped; location signal (4) deferred to v2
- [Phase ?]: [02-05]: STORE-02 verified end-to-end by spec-only audit trail — no STORE-02-specific code needed. Cascade: scan → FRAUD-01 randomized answerIdx → FRAUD-02 min-time gate → STORE-01 24h gate → RI credit at STORE_COEF 0.9x. All 19 Phase 2 requirements have passing specs. Backend suite 773/773 (+105 from Phase 1 baseline 668)
- [Phase ?]: [03-01]: TOP-06 anonymization is now a SINGLE source of truth — `apps/backend/src/common/utils/privacy-mask.util.ts maskNameIfMinor(name, dob)`. Replaces the inline `anonimize()` in top.service.ts:277 (kept for back-compat; 03-02 will route through the new util). Boundary is inclusive (≤14 is minor) per CLAUDE.md §V.4 phrasing "14 yoshgacha" + the "12 yosh" example.
- [Phase ?]: [03-01]: DEV_DONATION_PAYMENT_STUB mirrors DEV_OTP_BYPASS EXACTLY (allowlist on lowercased+trimmed NODE_ENV ∈ {development,test,dev}). Helper extracted to `common/utils/donation-stub-guard.util.ts` and re-exported from main.ts — extraction was forced by the @nestjs/schedule jest mock not exposing ScheduleModule.forRoot(), which crashes any spec that imports main.ts directly. main.ts now auto-bootstraps only when `require.main === module`.
- [Phase ?]: [03-01]: IpWhitelistGuard reads CSV env via Reflector-driven `@IpWhitelist(envKey)` metadata; default key `PAYME_IP_WHITELIST`. Permissive when env unset (warns once per key); x-forwarded-for FIRST hop preferred over req.ip to match Nginx setup; rejected requests throw `ForbiddenException("IP whitelist rejected")`. Consumed by Plan 03-03 donate webhook controllers.
- [Phase ?]: [03-01]: KAFKA_TOPICS gained BADGE_EARNED + TOP100_CONFIRMED constants only — emit helpers deferred to Plan 03-02 (Top-100 auto-publish) / Plan 03-04 (badge.earned consumer). Prevents speculative emit code that consumer plans would need to rewrite.
- [Phase ?]: [03-01]: prisma/seed.ts now seeds the 18-entry BADGE_CATALOG via inline upsert loop (not BadgeService.seedBadges — seed.ts runs detached from NestJS DI). Idempotent on `code` unique constraint. Backend suite 798/798 (+25 from 773 baseline: 9 privacy-mask + 7 ip-whitelist + 9 main guard).
- [Phase ?]: Plan 03-02: 4-cron Top-100 state machine replaces single-cron; FLAGGED preserves rank gaps per D-2
- [Phase ?]: Plan 03-02: FRAUD-07 4-layer gate (trust50/fraud90d/comprehension80/quickreturn50) composed above analyzeUser
- [Phase ?]: Plan 03-02: TOP-08 leaderboard rewritten with SQL LIMIT/OFFSET — closes Node-memory DoS bug
- [Phase ?]: Plan 03-03: TOP-05 InstitutionalService @Cron("0 3 * * *") writes SchoolRating (MAKTAB+OTM — OTM is schema debt for V2 UniRating per D-6/D-7) + OrgRating (IDORA per-employee with isMvp on rank-1 per PQ-9 §9b(d)); reads via PrismaReplicaService, writes via primary
- [Phase ?]: Plan 03-03: FRAUD-08 ReconciliationService @Cron("0 4 * * *") ALERT-ONLY per D-4 — expected_available = totalCount - BORROWED - PENDING BookTransfer; >5% → CRITICAL AiAuditLog + StatsGateway.emitNewAlert; PENDING BookTransfer carve-out prevents false roaming-return alerts; spec asserts book.update/updateMany/bookTransaction.update/updateMany are NEVER called
- [Phase ?]: Plan 03-03: BookTransfer uses requestedAt (not createdAt) — Phase 2 BOOK-02 schema reality; STUCK_TRANSFER scan flags PENDING > 30 days (R5) as Severity.MEDIUM (Prisma enum has no WARNING)
- [Phase ?]: Plan 03-03: DONAT-01 stub flag wired — initiateDonation short-circuits to /donate/stub/success?paymentId=... when isDonationStubActive(env) returns true; handlePaymentWebhook wrapped in cache.remember("donate:webhook:<id>", 7d) for idempotency; _verifyPayme/ClickSignature placeholder stubs warn once per provider and return true (Phase 4 PAY-01..08 swap point)
- [Phase ?]: Plan 03-03: Donate webhook controller routes wrapped in @UseGuards(IpWhitelistGuard) + @IpWhitelist("PAYME_IP_WHITELIST"|"CLICK_IP_WHITELIST"); authorization header forwarded to signature verifier
- [Phase ?]: Plan 03-03: DONAT-02 /donate/spending @Public endpoint + DONAT-03 /donate/admin/breakdown (@Roles SUPER_ADMIN, BUXGALTER) with parallel groupBy(targetId,targetName) + groupBy(purpose)
- [Phase ?]: Plan 03-03: TOP-06 donor anonymization via _resolveDonorName private helper — maskNameIfMinor applied at both getPublicDonors and getTopDonors; anonymous donor (userId=null) keeps parent-typed donorName as-is per D-TOP-06
- [Phase ?]: [03-04]: Defense-in-depth anonymization - maskNameIfMinor at WebSocket emit AND HTTP response
- [Phase ?]: [03-04]: Best-effort side effects in crons - emit/badge failures logged but never roll back DB transition
- [Phase ?]: [03-04]: ACTIVE_MONTH V1 approximates top-decile via top-200 Top100Entry candidates - V2 should scan full ReadingIndex
- [Phase ?]: [03-04]: @Optional KafkaService DI on BadgeService preserves existing 16 baseline unit tests
- [Phase 7]: [07-01]: Serwist SW disabled in dev mode (disable: NODE_ENV=development); sync.ts stub created for tsc pass (Plan 07-02 replaces with full Background Sync replay)
- [Phase 7]: [07-01]: AiAuditLog 60 fixed monthly partitions (2024-01..2028-12) following Phase 2 ReadingIndex pattern; Prisma model unchanged (PG transparent routing)
- [Phase 7]: [07-01]: ES ICU analysis plugin via docker-compose command override for I18N-03 multi-script search; old hand-written sw.js replaced by Serwist build-time generation
- [Phase ?]: [Phase 7]: [07-06]: axe-audit uses HTML fixtures for deterministic JSDOM testing; separate jest.config + tsconfig with esModuleInterop for axe-core import
- [Phase ?]: Leaflet map split into wrapper + inner component for SSR-safe dynamic import in Next.js store pages

### Pending Todos

None yet.

### Blockers/Concerns

- 6 critical bugs identified in research (C1-C6) -- all mapped to Phase 1 and Phase 2
- Notification system is completely non-functional (C3) -- blocks registration, mapped to Phase 1
- Eskiz.uz API credentials needed for SMS OTP -- external dependency -- BLOCKING the 01-01 Task 3 live-delivery checkpoint (code path complete, only env vars + a test phone are missing)
- OneID (sso.egov.uz) IDUZ_CLIENT_ID + IDUZ_CLIENT_SECRET needed -- external dependency -- BLOCKING the 01-06 Task 2 live-handshake checkpoint (code path complete; see 01-06-SUMMARY.md "OneID credentials checklist" for exact env vars + manual test steps)
- Firebase FCM setup needed for push notifications -- mapped to Phase 5
- docker-compose.prod.yml pre-existing structural issue: backend + frontend services have BOTH container_name and deploy.replicas>1 set (Compose v2 rejects this). Not introduced by Plan 01-06 -- predates this phase. Address in a follow-up infra plan

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| AI/ML | Python FastAPI AI Engine as separate gRPC + Kafka service (AI-V2-01) | v2 | 2026-06-06 |
| AI/ML | XGBoost/Random Forest fraud ML model (AI-V2-02) | v2 | 2026-06-06 |
| AI/ML | RAG pipeline with pgvector (AI-V2-03) | v2 | 2026-06-06 |
| AI/ML | Prophet forecasting with holiday calendar (AI-V2-04) | v2 | 2026-06-06 |
| Integration | Mutolaa platform API (EXT-V2-01) | v2 | 2026-06-06 |
| Integration | Store full API with HMAC webhooks (EXT-V2-02) | v2 | 2026-06-06 |

## Session Continuity

Last session: 2026-06-09T05:25:20.929Z
Stopped at: Phase 7 Plan 01 complete (2/2 tasks; commits d602bbe + e212ed6). Wave 0 PWA foundations shipped -- Serwist replaces hand-written sw.js with build-time precache manifest, Dexie.js offline DB schema (syncQueue + cachedBooks + cachedLibraries), 2G detection utility + useNetworkStatus hook, User.hideReadingHistory privacy column, AiAuditLog range-partitioned by month (60 partitions 2024-01..2028-12), ES ICU analysis plugin in docker-compose. Ready for Plan 07-02 (offline sync, components, audit retention cron).
Resume file: None
