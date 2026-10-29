---
phase: 3
slug: rankings-gamification-donations
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-06
updated: 2026-06-06
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 + ts-jest (apps/backend/jest.config.ts) |
| **Config file** | apps/backend/jest.config.ts |
| **Quick run command** | `cd apps/backend && npx jest <path> --bail --forceExit` |
| **Full suite command** | `cd apps/backend && npm test` |
| **Estimated runtime** | ~95 seconds (Phase 2 baseline: 773 tests; Phase 3 adds ~55 → ~828 total) |
| **Coverage gate** | 80% lines |
| **Notable** | Top100Entry, Badge, UserBadge, Donate, SchoolRating, OrgRating tables already in dev DB via Phase 0 schema. Existing TopService/BadgeService/DonateService specs extended in-place. PrismaReplicaService mocked via existing Phase 2 patterns. WebSocket emit mocks via jest.fn(). |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/backend && npx jest <touched-spec> --bail --forceExit`
- **After every plan wave:** Run `cd apps/backend && npm test`
- **Before `/gsd-verify-work`:** Full suite green + manual Top-100 monthly workflow dry-run (force-trigger all 4 crons in sequence) + WebSocket fan-out smoke + reconcileInventory dry-run
- **Max feedback latency:** 95 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-T1 | 03-01 | 1 | TOP-06, GAME-02, TOP-02 | T-03-01-I, T-03-01-T | maskNameIfMinor ≤14 boundary; IpWhitelistGuard rejects unwhitelisted IPs; Kafka topic constants typed | unit | `npx jest src/common/utils/__tests__/privacy-mask.util.spec.ts src/common/guards/__tests__/ip-whitelist.guard.spec.ts --bail` | ❌ Wave 0 (new files) | ⬜ pending |
| 03-01-T2 | 03-01 | 1 | DONAT-01, GAME-01 | T-03-01-S | DEV_DONATION_PAYMENT_STUB fails hard in production; seedBadges populates 18-entry catalog | unit | `npx jest src/main.spec.ts --bail` | ❌ Wave 0 (new file) | ⬜ pending |
| 03-02-T1 | 03-02 | 2 | TOP-01, TOP-02, TOP-03, TOP-04, TOP-06 | T-03-02-S, T-03-02-T, T-03-02-R, T-03-02-I | 4-cron state machine; FLAGGED entries skip auto-publish (D-2); admin overrides $transaction-wrapped; replica reads (D-1); maskNameIfMinor everywhere | unit | `npx jest src/modules/top/__tests__/top.service.spec.ts --bail` | ✅ extend existing 278-LOC spec | ⬜ pending |
| 03-02-T2 | 03-02 | 2 | FRAUD-07, TOP-08 | T-03-02-S, T-03-02-D | 4-layer verifyTop100Candidate; leaderboard SQL LIMIT/OFFSET; no in-memory sort | unit | `npx jest src/modules/ai/__tests__/fraud.service.spec.ts src/modules/reading/__tests__/reading.service.spec.ts --bail` | ❌ reading.service.spec scaffold needed | ⬜ pending |
| 03-03-T1 | 03-03 | 3 | TOP-05, FRAUD-08 | T-03-03-T, T-03-03-R | Institutional rankings cron writes SchoolRating + OrgRating; reconciliation cron alert-only (D-4) accounting for PENDING transfers; stuck-transfer warning | unit | `npx jest src/modules/top/__tests__/institutional.service.spec.ts src/modules/libraries/__tests__/reconciliation.service.spec.ts --bail` | ❌ Wave 2 (new files) | ⬜ pending |
| 03-03-T2 | 03-03 | 3 | DONAT-01, DONAT-02, DONAT-03, TOP-06 | T-03-03-S, T-03-03-D, T-03-03-I, T-03-03-I-2 | Stub-gated initiation; webhook idempotency + IP whitelist + signature stub; donor anonymization; admin breakdown role-gated | unit | `npx jest src/modules/donate/__tests__/ --bail` | ✅ extend existing 232-LOC spec | ⬜ pending |
| 03-04-T1 | 03-04 | 4 | TOP-07 | T-03-04-I | autoPublish + confirmMonth emit; anonymization at WebSocket emit time; frontend subscribe + invalidate | unit | `npx jest src/modules/top/__tests__/top.service.spec.ts -t "emit" --bail` | ✅ extend (after 03-02) | ⬜ pending |
| 03-04-T2 | 03-04 | 4 | GAME-01, GAME-02, GAME-03 | T-03-04-T, T-03-04-D | STREAK_7/30 + ACTIVE_MONTH triggers; Kafka emit on award; consumer routes to per-user room; GET /users/me/badges; profile widget Earned+Available (D-5) | unit | `npx jest src/modules/badge/__tests__/badge.service.spec.ts src/modules/users/__tests__/users.controller.spec.ts --bail` | ✅ extend badge (existing 224 LOC) + new users.controller.spec.ts | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

> Built into Plan 03-01 (combined Wave 0 + first-pass utility wave per RESEARCH §Build Order).

- [ ] `apps/backend/src/common/utils/privacy-mask.util.ts` + spec (TOP-06 source of truth)
- [ ] `apps/backend/src/common/guards/ip-whitelist.guard.ts` + spec (DONAT-01 hardening primitive)
- [ ] `apps/backend/src/main.ts` `_assertDonationStubGuard` + spec (DONAT-01 fail-closed)
- [ ] `apps/backend/prisma/seed.ts` invokes seedBadges or equivalent inline upsert loop (GAME-01 prerequisite)
- [ ] `apps/backend/src/infra/kafka/kafka.service.ts` adds `BADGE_EARNED` + `TOP100_CONFIRMED` to KAFKA_TOPICS (GAME-02 + TOP-02 broadcast channels)
- [ ] `apps/backend/src/modules/reading/__tests__/reading.service.spec.ts` scaffolded if missing (TOP-08 fix prerequisite, addressed inside Plan 03-02 Task 2)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Top-100 28→29→30→1 full month workflow | TOP-02 | Multi-day cron sequence; spec covers each transition but not the end-to-end calendar | Force-trigger all 4 crons via admin endpoints (or fake-timer dev script), verify state transitions in DB |
| WebSocket leaderboard fan-out across 2 replicas | TOP-07 | Requires 2+ backend replicas + live Redis adapter | `docker-compose up --scale backend=2`; subscribe a socket on replica A; trigger confirmMonth on replica B; verify event delivered |
| Children-under-14 anonymization in public UI | TOP-06 | UI rendering check + privacy | Visit /uz-Latn/top with a seeded 12-year-old user in CONFIRMED entries; confirm name appears as initials |
| Donation flow end-to-end with stub | DONAT-01 | Multi-step flow including frontend redirect | `DEV_DONATION_PAYMENT_STUB=true`, restart backend, POST /donate/initiate via curl or UI, redirect to /donate/stub/success, confirm donation lands as PAID in DB and DONOR badge awarded |
| Badge award notification toast | GAME-02 | Multi-channel delivery (Kafka → consumer → gateway → frontend) | Requires Kafka broker live; trigger checkAfterDonation; subscribe socket to user:{id} room; confirm toast appears |
| Inventory reconciliation alert | FRAUD-08 | Requires real Postgres + cron firing | Insert 8% inventory mismatch; force-trigger reconcileInventory; confirm AiAuditLog row + alert |
| Admin Top-100 review queue UI workflow | TOP-02 + admin overrides | Multi-action UI flow | Log in as SUPER_ADMIN; /dashboard/top-review; flag → clear → confirm; verify state changes in DB |
| Admin donations dashboard breakdown | DONAT-03 | Visual aggregation correctness | Log in as SUPER_ADMIN; /dashboard/donations; verify totals match manual SUM queries |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (privacy-mask, ip-whitelist, main.spec, reading.service.spec scaffold)
- [x] No watch-mode flags
- [x] Feedback latency < 95s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved — populated by planner 2026-06-06.
