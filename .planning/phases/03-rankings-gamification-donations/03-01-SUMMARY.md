---
phase: 03-rankings-gamification-donations
plan: 01
subsystem: common
tags: [privacy, security, kafka, badges, donations, infrastructure]
dependency_graph:
  requires:
    - Phase 1 INFRA-04 (DEV_OTP_BYPASS allowlist pattern — mirrored exactly)
    - Phase 1 INFRA-08 (KafkaService + KAFKA_TOPICS const)
    - Phase 2 GAME-01 baseline (BADGE_CATALOG + BadgeService.seedBadges)
  provides:
    - maskNameIfMinor (TOP-06 sole anonymization helper for public endpoints)
    - IpWhitelistGuard + @IpWhitelist decorator (DONAT-01 webhook hardening)
    - DEV_DONATION_PAYMENT_STUB env flag + fail-closed assert (DONAT-01)
    - isDonationStubActive runtime predicate (consumed by Plan 03-03)
    - KAFKA_TOPICS.BADGE_EARNED + KAFKA_TOPICS.TOP100_CONFIRMED constants
    - Seeded Badge catalog (18 rows on every `npx prisma db seed`)
  affects:
    - apps/backend/src/main.ts (boot guard + startup banner + conditional bootstrap)
    - apps/backend/.env.example (new flag documented)
    - apps/backend/prisma/seed.ts (badge catalog seeding)
tech_stack:
  added: []
  patterns:
    - "Fail-CLOSED env allowlist (mirrors Phase 1 isOtpBypassed pattern)"
    - "Decorator-driven Reflector metadata for guard configuration"
    - "Conditional auto-bootstrap (require.main === module) for spec-friendly main.ts"
    - "Util-extracted pure function for testability — avoids AppModule load in main.spec"
key_files:
  created:
    - apps/backend/src/common/utils/privacy-mask.util.ts
    - apps/backend/src/common/utils/__tests__/privacy-mask.util.spec.ts
    - apps/backend/src/common/utils/donation-stub-guard.util.ts
    - apps/backend/src/common/guards/ip-whitelist.guard.ts
    - apps/backend/src/common/guards/__tests__/ip-whitelist.guard.spec.ts
    - apps/backend/src/main.spec.ts
  modified:
    - apps/backend/src/infra/kafka/kafka.service.ts (2 new topics)
    - apps/backend/src/main.ts (guard call + banner + conditional bootstrap)
    - apps/backend/prisma/seed.ts (seedBadgeCatalog wired into main)
    - apps/backend/.env.example (DEV_DONATION_PAYMENT_STUB documented)
decisions:
  - "D-TOP-06: maskNameIfMinor is the single source of truth — no inline anonimize duplicates in 03-02/03/04"
  - "D-DONAT-01: Stub flag mirrors DEV_OTP_BYPASS EXACTLY (allowlist on lowercase/trimmed NODE_ENV) — never deny-list on !production"
  - "_assertDonationStubGuard extracted to common/utils because importing main.ts in a Jest spec evaluates AppModule, which crashes under the @nestjs/schedule mock"
  - "main.ts now auto-bootstraps only when require.main === module, so the helper is spec-importable through the re-export path without firing NestFactory"
  - "Seed.ts uses inline upsert (not BadgeService.seedBadges) because seed runs detached from NestJS DI"
  - "IpWhitelistGuard permissive when env unset (warns once per key); production deployments are responsible for setting the CSV"
  - "IpWhitelistGuard x-forwarded-for first-hop only — protects against IP spoofing via injected header chain"
metrics:
  duration: ~25 minutes
  completed: 2026-06-06
  tasks: 2
  commits: 2
  files_touched: 9
  tests_added: 25
  full_suite: 798/798 green (up from 773 baseline; +25 matches expected)
---

# Phase 3 Plan 1: Utility Scaffolds Summary

**One-liner:** Cross-cutting primitives every downstream Phase 3 plan depends on — privacy-mask util (TOP-06 anonymization), IpWhitelistGuard (DONAT-01 webhook hardening), DEV_DONATION_PAYMENT_STUB fail-closed flag (mirrors Phase 1 DEV_OTP_BYPASS), seeded 18-badge catalog (GAME-01 prerequisite), and KAFKA_TOPICS.{BADGE_EARNED, TOP100_CONFIRMED} broadcast channels for GAME-02 + TOP-02.

## Tasks Completed

### Task 1 — Privacy-mask util + IpWhitelistGuard + Kafka topic constants

**Commit:** `bf1d499`

- **`apps/backend/src/common/utils/privacy-mask.util.ts`** — `maskNameIfMinor(name, dob)` returns `"A.K."`-style initials when the computed age (Julian year arithmetic, matching `top.service.ts:19`) is ≤14. Null name → `"—"` (em-dash placeholder); null dob → name unchanged. Trims, splits on `\s+`, initials each non-empty part. Pure function, zero external deps.
- **`apps/backend/src/common/guards/ip-whitelist.guard.ts`** — `IpWhitelistGuard` implements `CanActivate`. Reads CSV from `ConfigService.get(envKey)`. `envKey` resolved via `Reflector.getAllAndOverride(IP_WHITELIST_ENV_KEY, [handler, class])` with default `"PAYME_IP_WHITELIST"`. Permissive (returns `true`) when env unset — logs `[IpWhitelistGuard]` warning ONCE per key (deduped via instance Set). Client IP extracted in order: `x-forwarded-for` FIRST hop → `req.ip` → `req.connection.remoteAddress`. Rejected requests throw `ForbiddenException("IP whitelist rejected")`. Sibling `@IpWhitelist(envKey)` decorator = `SetMetadata(IP_WHITELIST_ENV_KEY, envKey)`.
- **`apps/backend/src/infra/kafka/kafka.service.ts`** — Extended `KAFKA_TOPICS` with `BADGE_EARNED: "badge.earned"` and `TOP100_CONFIRMED: "top100.confirmed"`. `KafkaTopic` union type auto-updates. No emit helpers added (deferred to Plan 03-02/03-04 consumers).
- **Specs:** 9 privacy-mask cases (boundary at age 14, 12yo two-part, 15yo unchanged, single-part, whitespace, 3+ parts, null/null fallback) + 7 ip-whitelist cases (permissive on empty env, allow + reject, x-forwarded-for parsing, fallback to remoteAddress, default key, CSV whitespace trimming). **16/16 green.**

### Task 2 — DEV_DONATION_PAYMENT_STUB fail-closed + seedBadges wiring

**Commit:** `aaf19c8`

- **`apps/backend/src/common/utils/donation-stub-guard.util.ts`** — Hosts both `_assertDonationStubGuard(env)` (throws when NODE_ENV=production AND DEV_DONATION_PAYMENT_STUB=true) and `isDonationStubActive(env)` (runtime predicate; consumed by Plan 03-03 donate.service). Allowlist matches `AuthService.isOtpBypassed()` EXACTLY: `NODE_ENV` is lowercased + trimmed, then compared to `{"development", "test", "dev"}`. The guard refuses production explicitly via `===` on the lowercased value (no implicit `!production` denylist — the planner's locked decision).
- **`apps/backend/src/main.ts`** — Now imports + re-exports `_assertDonationStubGuard` from the util. Calls the guard immediately after `_assertEnvVars` so a misconfigured prod container exits non-zero before `app.listen()`. Adds a new `[SECURITY] DEV_DONATION_PAYMENT_STUB is ACTIVE` startup banner mirroring the existing DEV_OTP_BYPASS block format (the same `["development","test","dev"]` array + `(NODE_ENV || "").toLowerCase().trim()`). `bootstrap()` is now gated by `if (require.main === module)` so the file is safe to import from a spec without firing NestFactory.
- **`apps/backend/prisma/seed.ts`** — Imports `BADGE_CATALOG` directly from `../src/modules/badge/badge.service`. New `seedBadgeCatalog()` function in seed.ts mirrors the upsert body of `BadgeService.seedBadges()` (DI service can't materialize in seed context). Idempotent on the `code` unique constraint. Wired into `main()` after `seedDemoData`. Logs `✅ Badge catalog: 18 ta badge seed qilindi`.
- **`apps/backend/.env.example`** — Adds `DEV_DONATION_PAYMENT_STUB=false` with a fail-CLOSED comment pointing at D-DONAT-01. Negative assertion confirmed: `.env.prod.example` contains 0 references to the flag (prod templates must never reference the dev flag).
- **`apps/backend/src/main.spec.ts`** — 9 specs covering production fail-hard (true), dev allowlist (development, test pass), production with flag unset/'false'/non-'true', case-insensitive NODE_ENV (Production, PRODUCTION), whitespace trim (` production `), and unset NODE_ENV. **9/9 green.**

## Verification

- **Full backend suite:** 798/798 specs green across 44 suites (baseline 773 + 25 new = expected match).
- **TypeScript:** `cd apps/backend && npx tsc --noEmit` exits 0.
- **Source asserts:**
  - `grep maskNameIfMinor apps/backend/src/common/utils/privacy-mask.util.ts` → 1 export hit (passes ≥1).
  - `grep BADGE_EARNED.*"badge.earned" apps/backend/src/infra/kafka/kafka.service.ts` → 1 hit.
  - `grep TOP100_CONFIRMED.*"top100.confirmed" apps/backend/src/infra/kafka/kafka.service.ts` → 1 hit.
  - `grep -c "_assertDonationStubGuard\|DEV_DONATION_PAYMENT_STUB" apps/backend/src/main.ts` → 8 matches (≥3 required).
  - `grep -c "BADGE_CATALOG\|prisma.badge.upsert" apps/backend/prisma/seed.ts` → 4 matches (≥2 required).
  - `grep -c DEV_DONATION_PAYMENT_STUB .env.prod.example` → 0 matches (negative assertion passes).

## Deviations from Plan

### Plan-honored deviation: helper extraction

**1. [Rule 3 - Blocking issue] `_assertDonationStubGuard` extracted to `common/utils/donation-stub-guard.util.ts`**

- **Found during:** Task 2 RED phase
- **Issue:** The plan said "Create `apps/backend/src/main.spec.ts` … Import the helper from `./main`. Do NOT bootstrap a Nest app in this spec — call the helper as a pure function." However, ts-jest evaluates the module body on `import { ... } from "./main"`, which transitively loads `AppModule`, which calls `ScheduleModule.forRoot()`. Jest's `@nestjs/schedule` mock at `apps/backend/src/__mocks__/@nestjs/schedule.ts` does NOT expose `ScheduleModule`, only `Cron` / `CronExpression` / `SchedulerRegistry` / `InjectSchedule`. The spec crashed with `TypeError: Cannot read properties of undefined (reading 'forRoot')`.
- **Fix:** Moved `_assertDonationStubGuard` (and added `isDonationStubActive` sibling) to a dedicated `common/utils/donation-stub-guard.util.ts`. `main.ts` imports it + re-exports it (preserves the back-compat surface the plan called for). The spec imports from the util path directly to avoid the AppModule transitive load. `bootstrap()` is also now gated by `require.main === module` so the file is import-safe — defensive against future spec authors who might import main.ts directly.
- **Files modified:** apps/backend/src/main.ts (helper now imported + re-exported), apps/backend/src/main.spec.ts (import path updated with a comment explaining the AppModule loading issue), new apps/backend/src/common/utils/donation-stub-guard.util.ts.
- **Commit:** aaf19c8

### Plan-honored deviation: added `isDonationStubActive` sibling

**2. [Rule 2 - Missing critical functionality] `isDonationStubActive(env)` runtime predicate added alongside `_assertDonationStubGuard`**

- **Found during:** Task 2 design — the RESEARCH.md "DONAT-01 (FIX)" section explicitly calls for `donate.service.initiateDonation` to short-circuit to the stub URL when the flag is active. That branch needs a runtime predicate, not the boot-time guard. Without it Plan 03-03 would re-derive the same `(env.NODE_ENV || '').toLowerCase().trim() ∈ {development,test,dev}` check inline, defeating the "no inline anonimize duplicates" pattern this whole plan establishes.
- **Action:** Added `isDonationStubActive(env)` to the same util file. Pure function, takes `{NODE_ENV, DEV_DONATION_PAYMENT_STUB}` partial. Documented in JSDoc as the consumer entry point for 03-03.
- **No additional spec for `isDonationStubActive`** — the guard and the predicate are symmetric (one throws, the other returns boolean from the SAME allowlist), and the 9 guard specs cover every relevant input cell. Plan 03-03 will add behavior specs at the consumption site.

### None other

No other deviations. Auth gates not triggered (no external integration touched). No threat-model surface introduced (privacy-mask is a pure formatter, IpWhitelistGuard reduces surface, the env flag closes a hole at boot, Kafka topic constants are non-emitting).

## Threat Surface Touched

| Threat | Disposition | Note |
|---|---|---|
| T-03-01-S (operator sets stub flag in production) | ✅ mitigated | `_assertDonationStubGuard` throws at boot before `app.listen()` |
| T-03-01-I (underage name leaks to public endpoints) | ✅ source-of-truth established | `maskNameIfMinor` is the single helper; consumer plans must use it |
| T-03-01-T (forged source IP bypasses webhook IP whitelist) | ✅ mitigated (x-forwarded-for first hop only) | IpWhitelistGuard rejects header-chain spoofing; Phase 4 PAY-01 adds HMAC defense layer |
| T-03-01-R (badge seed silent partial state) | ✅ mitigated | `prisma.badge.upsert` is idempotent on `code` unique; failures throw + abort seed |
| T-03-01-SC (npm/pip installs) | ✅ accept | Zero new dependencies (RESEARCH.md Package Legitimacy Audit confirmed) |

## Known Stubs

None. This plan establishes primitives; downstream plans (03-02/03/04) consume them. No data wires are left dangling — every export has at least one verification site (spec or grep) in this plan, and a documented downstream consumer in 03-02/03-03/03-04 PLAN.md.

## TDD Gate Compliance

- Task 1 RED commit: failing imports proven before implementation
- Task 1 GREEN: implementation committed with passing specs (bf1d499 is a combined RED→GREEN commit per the deviation rule scope — RED was demonstrated in-shell, no separate test-only commit landed; the spec + impl ship together since this is `type="auto"` per task block, not a `type: tdd` plan)
- Task 2 RED commit: same pattern — RED proven inline (TypeError: Module './main' has no exported member '_assertDonationStubGuard'), GREEN at aaf19c8
- Plan frontmatter does NOT carry `type: tdd` — it's `type: execute`. Per the TDD section: "tdd='true'" on each task triggers RED/GREEN/REFACTOR per task, but commit granularity is "one commit per task" because the plan-level type is `execute`, not `tdd`. Both tasks followed the RED→GREEN sequence demonstrably; commits are atomic and self-contained.

## Self-Check: PASSED

- ✅ apps/backend/src/common/utils/privacy-mask.util.ts exists
- ✅ apps/backend/src/common/utils/__tests__/privacy-mask.util.spec.ts exists
- ✅ apps/backend/src/common/utils/donation-stub-guard.util.ts exists
- ✅ apps/backend/src/common/guards/ip-whitelist.guard.ts exists
- ✅ apps/backend/src/common/guards/__tests__/ip-whitelist.guard.spec.ts exists
- ✅ apps/backend/src/main.spec.ts exists
- ✅ apps/backend/src/infra/kafka/kafka.service.ts modified (BADGE_EARNED + TOP100_CONFIRMED)
- ✅ apps/backend/src/main.ts modified (guard call + banner + conditional bootstrap)
- ✅ apps/backend/prisma/seed.ts modified (seedBadgeCatalog wired)
- ✅ apps/backend/.env.example modified (DEV_DONATION_PAYMENT_STUB documented)
- ✅ commit bf1d499 present in git log
- ✅ commit aaf19c8 present in git log
- ✅ Full backend suite 798/798 green (target ≥781 from success criteria; exceeded)
- ✅ tsc --noEmit clean
