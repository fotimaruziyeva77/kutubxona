---
phase: 04-payment-subscriptions
plan: 01
status: complete
date: 2026-06-07
backend_suite: 931/931 green (up from 891 baseline; +40 new tests)
frontend_tsc: clean
backend_tsc: clean
requirements_addressed:
  - PAY-01 (prep: RedisLockService + cache.setNx/getRaw — webhook idempotency primitive)
  - PAY-02 (Click HMAC signature corrected: RED-then-GREEN, service_id now included)
  - PAY-04 (prep: PAYMENT_TIMEOUT_QUEUE registered; processor attaches in Plan 04-02)
  - RPT-03 (prereq: Buxgalter UI cookie-auth migration; XLSX/1C export lands in Plan 04-04)
deferred_to_later_plans:
  - Plan 04-02: Webhook hardening + PaymentTimeoutProcessor + IpWhitelistGuard wiring
  - Plan 04-03: Subscription state machine + invoice atomicity
  - Plan 04-04: Reminders refactor + Buxgalter XLSX/1C exports
commits:
  - b0acc9d test(click)(04-01): RED test for missing service_id in HMAC formula (PAY-02)
  - 767e5a0 fix(click)(04-01): include service_id in MD5 signature per official Click docs (PAY-02 GREEN)
  - 74c2b05 feat(cache)(04-01): setNx + getRaw + RedisLockService for payment idempotency (PAY-01 prep)
  - b9e86fe feat(infra)(04-01): PAYMENT_TIMEOUT_QUEUE + Kafka topics + DEV_SUBSCRIPTION_PAYMENT_STUB pattern (PAY-04 prep)
  - dc2f630 fix(buxgalter)(04-01): cookie auth migration (RPT-03 prereq)
---

# Plan 04-01 SUMMARY — Wave 0 critical fixes + utility primitives

## What shipped

Wave 0 of Phase 4 closes two SECURITY-CRITICAL bugs that were live in
production code, and lands the five cross-cutting primitives every later
Phase 4 plan consumes.

### Critical fixes

1. **Click HMAC signature corrected (PAY-02)** — `_makeSign` in
   `apps/backend/src/modules/payment/click.service.ts:160-186` now includes
   `service_id` per the official Click formula. Pre-fix, every real Click
   callback was rejected with `-1` (signature mismatch).

2. **Buxgalter UI cookie-auth migration (RPT-03 prereq)** — all six fetch
   call sites in `apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx`
   now use `credentials: "include"`. The deprecated
   `localStorage.getItem("token")` flow returned 401 on every API call — page
   was non-functional in production.

### New primitives (consumed by 04-02 / 04-03 / 04-04)

3. **RedisLockService** — `apps/backend/src/infra/cache/redis-lock.service.ts`.
   Atomic SETNX-based payment-webhook idempotency. Injected from `CacheModule`
   (now exports both `CacheService` and `RedisLockService`).

4. **PAYMENT_TIMEOUT_QUEUE** registered in `queue.module.ts` with
   `attempts:1, removeOnComplete:{count:200}, removeOnFail:false`. Processor
   attaches in Plan 04-02.

5. **KAFKA_TOPICS additions** — `PAYMENT_COMPLETED`, `PAYMENT_RECEIVED`,
   `SUBSCRIPTION_ACTIVATED`, `SUBSCRIPTION_FROZEN`. Emit helpers added in
   04-02/03 (precedent from Plan 03-01 BADGE_EARNED).

6. **DEV_SUBSCRIPTION_PAYMENT_STUB pattern** — mirrors
   `donation-stub-guard.util.ts` EXACTLY (per OQ-6 user-approved decision).
   `isSubscriptionStubActive(env)` returns true iff flag === `"true"` AND
   `NODE_ENV` ∈ `{development, test, dev}`. `_assertSubscriptionStubGuard(env)`
   throws at boot in production if the flag is `"true"`.

7. **Production env hard-fail extended** — `PRODUCTION_REQUIRED_ENV` now
   includes `PAYME_MERCHANT_ID`, `PAYME_SECRET_KEY`, `PAYME_TEST_KEY`,
   `PAYME_LOGIN`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY`, `CLICK_SERVICE_ID`.
   Refactored into `common/utils/production-env.util.ts` so `main.spec` can
   exercise the asserter without booting `AppModule`.

## RED-test fixture digests (Click HMAC)

The new RED-first specs in
`apps/backend/src/modules/payment/__tests__/click.service.spec.ts`
exercise the official Click formula with these fixtures:

```
secret             = "testsecret"
click_trans_id     = "12345"
service_id         = "42"
merchant_trans_id  = "INV-ABC"
amount             = "3500000"
sign_time          = "2026-06-07 10:00:00"
merchant_prepare_id = "999"

Prepare raw (action=0):
  "12345" + "42" + "testsecret" + "INV-ABC" + "3500000" + "0" + "2026-06-07 10:00:00"
  = "1234542testsecretINV-ABC35000000" + "2026-06-07 10:00:00"

Complete raw (action=1):
  "12345" + "42" + "testsecret" + "INV-ABC" + "999" + "3500000" + "1" + "2026-06-07 10:00:00"
```

The pre-fix `_makeSign` produced a digest of
`"${click}${action}${secret}${merchant}${amount}${signTime}"` (with no
service_id and action interleaved BEFORE secret). RED specs failed against
that. GREEN specs pass against the corrected formula.

## RedisLockService injection signature

```typescript
constructor(private readonly lock: RedisLockService) {}

// Atomic acquire
const result = await this.lock.tryAcquire(
  "webhook:payme:tx-1:CreateTransaction",
  86400,        // TTL in seconds
  "trace-A",    // traceId stored as the SETNX value
);
// { first: true } on first call
// { first: false, cachedResponse } on duplicate within TTL
// cachedResponse is undefined if no response has been stored yet

// Store handler response for replay
await this.lock.storeResponse(
  "webhook:payme:tx-1:CreateTransaction",
  { jsonrpc: "2.0", id: 1, result: { allow: true } },
  86400,
);
// Stored under "webhook:payme:tx-1:CreateTransaction:response"
```

Module wiring: `CacheModule` (global) now exports `RedisLockService` — any
module can inject it without re-importing `CacheModule`.

## DEV_SUBSCRIPTION_PAYMENT_STUB env semantics (for downstream plans)

Identical to DEV_DONATION_PAYMENT_STUB:

| `NODE_ENV`        | `DEV_SUBSCRIPTION_PAYMENT_STUB` | Behavior                                    |
|-------------------|--------------------------------|---------------------------------------------|
| `production`      | `"true"`                       | Boot THROWS with `[FATAL]` (fail-CLOSED)    |
| `production`      | `"false"` / unset / other      | Stub inactive; real Payme/Click used        |
| `development`/`test`/`dev` | `"true"`              | Stub ACTIVE — boot banner emitted           |
| any                | not `"true"`                  | `isSubscriptionStubActive()` → `false`       |

Plan 04-02 webhook handlers gate their short-circuit branches on
`isSubscriptionStubActive(process.env)`. The boot banner shape mirrors
DEV_OTP_BYPASS + DEV_DONATION_PAYMENT_STUB:

```
[SECURITY] DEV_SUBSCRIPTION_PAYMENT_STUB is ACTIVE
Payme/Click subscription webhooks short-circuit to synthetic success in dev only.
NODE_ENV=development
DO NOT use this in any environment with real users.
```

## Production-required env (updated)

`apps/backend/src/common/utils/production-env.util.ts` exports the canonical
list. New keys vs. pre-04-01:

- `PAYME_MERCHANT_ID`
- `PAYME_SECRET_KEY`
- `PAYME_TEST_KEY`
- `PAYME_LOGIN` (Basic-Auth username; sandbox value `"Paycom"`)
- `CLICK_MERCHANT_ID`
- `CLICK_SECRET_KEY`
- `CLICK_SERVICE_ID`

IP-whitelist envs (`PAYME_IP_WHITELIST`, `CLICK_IP_WHITELIST`) are documented
in `.env.example` but NOT in the required set — permissive default in dev,
operator populates them in `.env.prod`.

## Backend suite delta from baseline

- Pre-04-01 baseline (Phase 3 closeout): **891/891 green**
- Post-04-01: **931/931 green** (+40 new tests)
  - +2 Click HMAC official formula (RED-then-GREEN)
  - +4 CacheService.setNx/getRaw
  - +5 RedisLockService.tryAcquire/storeResponse
  - +4 queue.module + KAFKA topics constants
  - +16 subscription-stub-guard.util (mirrors donation-stub-guard.util)
  - +9 main.spec _assertEnvVars + _assertSubscriptionStubGuard wiring

Plan target was ≥916; delivered 931.

## Verification

- `cd apps/backend && npm test` — **50 suites, 931/931 tests green**
- `cd apps/backend && npx tsc --noEmit` — clean
- `cd apps/frontend && npx tsc --noEmit` — clean
- `grep -n "service_id" apps/backend/src/modules/payment/click.service.ts` —
  19 hits (formula, callers, service_id env mismatch guard, docs)
- `grep -n "PAYMENT_TIMEOUT_QUEUE" apps/backend/src/infra/queue/queue.module.ts` —
  2 hits (constant export + registerQueue config)
- `grep -n "credentials:\\s*[\"']include[\"']" apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx` —
  6 hits, one per fetch call (plus 1 explanatory comment)
- `grep -n "localStorage.getItem" apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx` —
  1 hit, in the explanatory comment ONLY (no functional reference)

## Deviations from plan

None functional. One minor refactor for testability: `_assertEnvVars` and
`PRODUCTION_REQUIRED_ENV` were extracted from `main.ts` to a new
`common/utils/production-env.util.ts` because importing them from `main.ts`
in the spec triggered `AppModule` evaluation (same root cause already handled
for `_assertDonationStubGuard` in Plan 03-01). `main.ts` re-imports + uses
them unchanged; spec imports from the util file. Behavior identical.

## Handoff to Plan 04-02

Plan 04-02 (webhook hardening + 12h timeout) can now:

1. Inject `RedisLockService` directly into `PaymeService` and `ClickService`
   (CacheModule global export already wires it).
2. `@InjectQueue(PAYMENT_TIMEOUT_QUEUE)` for the delayed cancel jobs +
   register the `PaymentTimeoutProcessor` `@Processor(PAYMENT_TIMEOUT_QUEUE)`.
3. Emit `KAFKA_TOPICS.PAYMENT_COMPLETED` /
   `KAFKA_TOPICS.SUBSCRIPTION_ACTIVATED` from the webhook handlers (add
   `emitPaymentCompleted` / `emitSubscriptionActivated` helpers per Plan
   03-01 precedent).
4. Gate dev-stub branches on `isSubscriptionStubActive(process.env)`.
5. Click HMAC formula already correct (Wave 0) — no further changes needed.
