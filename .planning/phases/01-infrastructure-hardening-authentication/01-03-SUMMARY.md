---
phase: 01-infrastructure-hardening-authentication
plan: 03
subsystem: auth
tags: [jwt, redis, nestjs, rate-limiting, guards, otp, ioredis, default-deny]

# Dependency graph
requires:
  - phase: 01-02
    provides: CacheService (ioredis client), JwtAuthGuard (per-route), hardened infra config
provides:
  - "CacheService.incrWithTtl — atomic Redis fixed-window counter (INCR + first-hit-only EXPIRE)"
  - "Redis-backed OTP rate limit (otp:rl:{phone}, 5/hr) replacing the in-memory Map"
  - "OTP digit length pinned to 6 (matches VerifyOtpDto @Length(6,6)) via a unit test"
  - "@Public() decorator + IS_PUBLIC_KEY for opting routes out of the global guard"
  - "JwtAuthGuard reflector bypass for @Public() routes"
  - "Global JwtAuthGuard (APP_GUARD) — default-deny: every route auth-protected unless @Public()"
  - "Public-route allowlist across auth/app/geo/libraries/books/top/donate/payment/reading/store/admin"
affects: [01-04, 01-05, 01-06, cookie-migration, oneid-auth]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic Redis fixed-window rate limiting via INCR + conditional EXPIRE"
    - "Global default-deny auth with @Public() metadata bypass (NestJS reflector pattern)"

key-files:
  created:
    - apps/backend/src/common/decorators/public.decorator.ts
    - apps/backend/src/common/decorators/index.ts
    - apps/backend/src/common/guards/jwt-auth.guard.spec.ts
    - apps/backend/src/infra/cache/cache.service.spec.ts
  modified:
    - apps/backend/src/infra/cache/cache.service.ts
    - apps/backend/src/modules/auth/auth.service.ts
    - apps/backend/src/modules/auth/auth.module.ts
    - apps/backend/src/modules/auth/auth.controller.ts
    - apps/backend/src/modules/auth/__tests__/auth.service.spec.ts
    - apps/backend/src/common/guards/jwt-auth.guard.ts
    - apps/backend/src/app.module.ts
    - apps/backend/src/app.controller.ts
    - "(cross-plan @Public) geo/libraries/books/top/donate/payment/reading/store/admin controllers"

key-decisions:
  - "Kept OTP at 6 digits (stronger brute-force resistance); 6-digit length pinned by a test. The 4-vs-6 choice remains a Plan 01-01 checkpoint override."
  - "Used a hand-written ioredis stub in the cache spec instead of adding ioredis-mock (no new npm dependency)."
  - "Imported CacheModule explicitly into AuthModule even though it is @Global() — makes the dependency explicit for isolated test/module contexts."
  - "Marked cross-plan public routes @Public() now (Rule 3) rather than deferring to owning plans, because the global guard would otherwise 401 the registration cascade, public search, leaderboards, and payment/store/mutolaa webhooks — breaking the no-lockout success criterion."

patterns-established:
  - "Rate limiting: AuthService delegates to CacheService.incrWithTtl with key otp:rl:{phone}, never an in-process Map"
  - "Auth: routes are protected by default (global JwtAuthGuard); opt out explicitly with @Public()"

requirements-completed: [INFRA-01, INFRA-03, AUTH-01]

# Metrics
duration: 14min
completed: 2026-06-06
---

# Phase 1 Plan 03: Access-Control & OTP Hardening Summary

**Redis-atomic per-phone OTP throttle (incrWithTtl), a 6-digit OTP length pinned by test, and a global default-deny JwtAuthGuard with an explicit @Public() allowlist spanning 12 controllers.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-06-06T08:55:12Z
- **Completed:** 2026-06-06T09:09:13Z
- **Tasks:** 4
- **Files modified:** 21 (4 created, 17 modified)

## Accomplishments
- Replaced the per-replica in-memory OTP rate-limit `Map` with an atomic Redis fixed-window counter (`CacheService.incrWithTtl`, key `otp:rl:{phone}`, 1h window) — survives restarts and is shared across replicas (PITFALLS H3 / threat T-03-01).
- Reconciled OTP digit length: generation stays 6 digits and is now pinned to `VerifyOtpDto @Length(6,6)` by a unit test (AUTH-01).
- Added the `@Public()` decorator + reflector bypass and registered `JwtAuthGuard` globally — every route is now auth-protected by default (closes the RolesGuard-returns-true gap, threat T-03-02).
- Audited all 20 controllers and marked every genuinely-public route `@Public()` so the global guard does not lock out login, registration, health, landing, leaderboards, or webhooks (threat T-03-03).

## Task Commits

Each task was committed atomically (TDD tasks: test+impl folded into one feat commit per task):

1. **Task 1: Redis atomic OTP rate limit + OTP length reconcile (INFRA-01, AUTH-01)** - `7b00d2a` (feat)
2. **Task 2: @Public() decorator + reflector bypass in JwtAuthGuard (INFRA-03)** - `2b1cd9e` (feat)
3. **Task 3: Controller audit — mark public routes with @Public()** - `a48f2bc` (feat)
4. **Task 4: Register JwtAuthGuard globally (INFRA-03)** - `b1e7b06` (feat)

## Files Created/Modified

**Created:**
- `apps/backend/src/common/decorators/public.decorator.ts` - `@Public()` + `IS_PUBLIC_KEY='isPublic'`
- `apps/backend/src/common/decorators/index.ts` - decorators barrel (CurrentUser, Roles, Public)
- `apps/backend/src/common/guards/jwt-auth.guard.spec.ts` - public-bypass, protected-reject, default-deny
- `apps/backend/src/infra/cache/cache.service.spec.ts` - incrWithTtl INCR + first-hit-only EXPIRE

**Modified (plan-owned):**
- `apps/backend/src/infra/cache/cache.service.ts` - added `incrWithTtl(key, ttlSeconds)`
- `apps/backend/src/modules/auth/auth.service.ts` - inject CacheService; removed `sendLog` Map; async Redis rate-limit
- `apps/backend/src/modules/auth/auth.module.ts` - import CacheModule
- `apps/backend/src/modules/auth/auth.controller.ts` - `@Public()` on login/otp.send/otp.verify/register.complete/password.reset/refresh (NOT logout)
- `apps/backend/src/modules/auth/__tests__/auth.service.spec.ts` - CacheService stub; rate-limit + OTP-length tests
- `apps/backend/src/common/guards/jwt-auth.guard.ts` - inject Reflector; `getAllAndOverride(IS_PUBLIC_KEY)` bypass
- `apps/backend/src/app.module.ts` - register `{ provide: APP_GUARD, useClass: JwtAuthGuard }` after ThrottlerGuard
- `apps/backend/src/app.controller.ts` - `@Public()` on health, health/ready

**Modified (cross-plan, see Deviations):**
- `geo`, `libraries`, `books`, `top`, `donate`, `payment`, `reading`, `store`, `admin` controllers - `@Public()` on existing public routes

## Decisions Made
- **OTP length = 6.** Kept the stronger 6-digit code (matches current code + better brute-force resistance) and pinned it with a test. The Plan 01-01 live checkpoint can still override to 4.
- **No ioredis-mock.** Used a hand-written ioredis stub in the cache spec to avoid a new npm dependency and to assert the exact EXPIRE-once semantics.
- **Explicit CacheModule import in AuthModule** despite CacheModule being `@Global()`, for clarity and isolated-context safety.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Marked cross-plan public routes `@Public()` to prevent global-guard lockout**
- **Found during:** Task 3 (controller audit) / Task 4 (global guard registration)
- **Issue:** The plan's Task 3 said to edit only `auth.controller.ts` and `app.controller.ts` and merely *list* cross-plan public routes in the SUMMARY, asserting the global-guard registration was "acceptable" (citing only OneID). The audit revealed the breakage is far broader: registering the global guard (Task 4) without marking these would 401 the **registration geo-cascade** (`/geo/*`, used during signup), **public library/book search** (`/libraries/*`, `/books/*`), **all open leaderboards/top rankings** (`/top/*`, `/reading/leaderboard`, `/reading/:userId*`), the **public donate stats + initiate** (`/donate/*`), and the **payment/store/mutolaa webhooks** (`/payment/*/webhook`, `/store/purchases`, `/reading/webhook/mutolaa`) and the **public B2B demo-request** (`/admin/demo-request`). That directly violates this plan's success criterion "no lockout (login, register, otp send/verify, health, public top/landing)" and is exactly PITFALLS Pitfall 1.
- **Fix:** Added `@Public()` to those genuinely-public routes (GET reads, anonymous donate, and HMAC/IP-protected webhooks) across `geo`, `libraries`, `books`, `top`, `donate`, `payment`, `reading`, `store`, `admin` controllers. Mutation/admin endpoints were left guarded. The global guard is now correct (default-deny + complete allowlist).
- **Files modified:** geo/libraries/books/top/donate/payment/reading/store/admin controllers
- **Verification:** `tsc --noEmit` clean; full suite green (33 suites, 644 tests); manual route-by-route audit confirmed only pre-existing public routes were opened and `logout` stays guarded.
- **Committed in:** `a48f2bc` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking)
**Impact on plan:** Necessary for the plan's own "no lockout" success criterion and for Task 4 to be safe. No scope creep — only routes already public (no guard, or documented "ochiq/auth kerak emas") were marked; no behavior changed beyond auth gating. Cross-plan files were touched only to add the metadata decorator.

## Cross-Plan / Follow-up Items (for owning plans)

- **`apps/backend/src/modules/auth/iduz.controller.ts` (owned by Plan 06, AUTH-03):** All `auth/iduz/*` OAuth routes are pre-auth/public but were intentionally NOT modified here per the plan. They are temporarily 401'd by the now-global guard. This is acceptable because OneID is not yet live (gated on `sso.egov.uz` credentials in Plan 06). **Plan 06 MUST add `@Public()` to every `iduz/*` route** (authorize, callback/token exchange, userinfo) when wiring AUTH-03, or OneID login will 401.
- **Webhook hardening note:** `/payment/*`, `/store/purchases`, `/donate/webhook/*`, and `/reading/webhook/mutolaa` are now `@Public()` (no JWT) and rely on HMAC-signature / IP-whitelist verification at the handler level (already implemented for store & mutolaa; payme/click handlers verify provider auth). The owning payment/store/reading plans should confirm every public webhook validates its signature, since the framework auth layer no longer fronts them.

## Issues Encountered
- The `common/decorators/index.ts` barrel did not previously exist (the codebase imported decorators by direct file path). Created the barrel and kept the direct `public.decorator` import in the guard to avoid a circular import (guard → decorators barrel → guard-adjacent). No functional impact.
- Full-suite run prints a "worker process failed to exit gracefully" warning — a pre-existing teardown leak (Redis/timer handles in some specs), not a failure; all 644 tests pass.

## Threat Flags
None — no new security surface introduced. All changes tighten existing surface (Redis-atomic throttle, global default-deny). Public webhooks were already public before this plan; they are now explicitly allowlisted and flagged above for signature-verification confirmation by their owning plans.

## User Setup Required
None - no external service configuration required. (The Redis instance used by `incrWithTtl` is the same already-running `sifat-redis` used by CacheService/BullMQ.)

## Next Phase Readiness
- Global default-deny guard is live; Plan 01-04 (cookie refresh migration) and Plan 01-06 (OneID) can assume the global guard exists and must use `@Public()` for any pre-auth route.
- **Blocker for Plan 06:** add `@Public()` to `iduz/*` routes (see Cross-Plan items) before enabling OneID.

## Self-Check: PASSED

- Created files verified on disk: public.decorator.ts, decorators/index.ts, jwt-auth.guard.spec.ts, cache.service.spec.ts, 01-03-SUMMARY.md — all FOUND.
- Task commits verified in git log: 7b00d2a, 2b1cd9e, a48f2bc, b1e7b06 — all FOUND.
- Full backend suite: 33 suites / 644 tests passing. `tsc --noEmit` clean. No file deletions across the 4 task commits.

---
*Phase: 01-infrastructure-hardening-authentication*
*Completed: 2026-06-06*
