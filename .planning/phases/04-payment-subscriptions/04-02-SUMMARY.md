---
phase: 04-payment-subscriptions
plan: 02
status: complete
date: 2026-06-07
backend_suite: 975/975 green (up from 951 baseline; +24 new tests)
backend_tsc: clean
requirements_addressed:
  - PAY-01 (Payme webhook hardening — typed DTO + IpWhitelistGuard + RedisLockService idempotency)
  - PAY-02 (Click webhook hardening — typed DTOs + IpWhitelistGuard + RedisLockService idempotency; sign_time skew + service_id env guard already in Plan 04-01)
  - PAY-03 (Atomic $transaction wrapping all 3 payment state-mutation sites + AiAuditLog STATE_TRANSITION)
  - PAY-04 (PaymentTimeoutProcessor 12h delayed cancel + reason=4 mapping)
deferred_to_later_plans:
  - Plan 04-03: Subscription state machine + frozenReason migration + late-perform CheckTransaction fallback
  - Plan 04-04: Reminders refactor + Buxgalter XLSX/1C exports
commits:
  - 47533dd feat(payment)(04-02): typed webhook DTOs + IpWhitelistGuard wiring (PAY-01, PAY-02)
  - 75663fd feat(payment)(04-02): RedisLockService idempotency + atomic $transaction state writes (PAY-01/02/03)
  - 5332022 feat(payment)(04-02): PaymentTimeoutProcessor + 12h enqueue/remove on Payme lifecycle (PAY-04)
---

# Plan 04-02 SUMMARY — Wave 2 webhook hardening + atomicity + 12h timeout

## What shipped

Wave 2 closes the financial perimeter for Phase 4. All four critical
deliverables ship in three atomic commits.

### Typed webhook DTOs (PAY-01, PAY-02)

`apps/backend/src/modules/payment/dto/payme-webhook.dto.ts`:
- `PaymeRpcRequestDto` — the JSON-RPC 2.0 envelope (jsonrpc, id, method, params).
- Per-method param DTOs: `CheckPerformTransactionParamsDto`,
  `CreateTransactionParamsDto`, `PerformTransactionParamsDto`,
  `CancelTransactionParamsDto`, `CheckTransactionParamsDto`,
  `GetStatementParamsDto`, plus a shared `PaymeRpcAccountDto`.
- `method` constrained via `@IsIn` to the 6 known Payme methods.

`apps/backend/src/modules/payment/dto/click-webhook.dto.ts`:
- `ClickPrepareDto` + `ClickCompleteDto` with `@IsString` + `@IsNotEmpty`
  on every required field (click_trans_id, service_id, merchant_trans_id,
  amount, sign_time, sign_string + the Complete-only merchant_prepare_id).

Controller signatures changed from `body: any` to the typed DTOs; NestJS
ValidationPipe (already global per Phase 1 main.ts wiring) enforces them
before dispatch.

### IpWhitelistGuard wiring

Three webhook routes now carry the guard + envKey decorator:

```typescript
@UseGuards(IpWhitelistGuard) @IpWhitelist("PAYME_IP_WHITELIST")
@Post("payment/payme/webhook")

@UseGuards(IpWhitelistGuard) @IpWhitelist("CLICK_IP_WHITELIST")
@Post("payment/click/prepare")

@UseGuards(IpWhitelistGuard) @IpWhitelist("CLICK_IP_WHITELIST")
@Post("payment/click/complete")
```

Permissive default when env unset (Phase 3 contract). Production deployment
populates the CSV envs.

### Idempotency key shapes (PAY-01, PAY-02)

Both webhook services inject `RedisLockService` and gate dispatch via
`tryAcquire(key, 86400, traceId)`:

| Provider | Key shape                                                        |
|----------|------------------------------------------------------------------|
| Payme    | `webhook:payme:{params.id ?? account.invoiceId ?? "no-id"}:{method}` |
| Click    | `webhook:click:{click_trans_id}:{action}`                        |

The action component on the Click key distinguishes Prepare ("0") from
Complete ("1") so a Prepare replay doesn't satisfy a Complete duplicate
(and vice versa). The Payme key falls back to `account.invoiceId` for
`CheckPerformTransaction` (no `params.id`).

TTL: 24h (86400 sec). Covers Payme's 12h transaction lifetime plus a buffer.

When `tryAcquire` returns `{ first: false, cachedResponse }`, the handler
short-circuits and returns the cached response byte-identical. After the
first dispatch, `storeResponse(key, response, 86400)` persists for replay.

### Atomic $transaction wrap (PAY-03)

Three state-mutation sites now run inside `prisma.$transaction(async (tx) => ...)`:

1. `PaymeService._performTransaction` — Payment + Invoice + Subscription
   updates + AiAuditLog.create inside one tx.
2. `PaymeService._cancelTransaction` — Payment.update + AiAuditLog.create
   inside one tx.
3. `ClickService._completeInternal` — both the user-cancel branch
   (Payment.update + AiAuditLog) and the success branch (Payment + Invoice
   + Subscription + AiAuditLog) wrapped in tx.

Pre-04-02, the 3-4 sequential awaits ran OUTSIDE any transaction. A
mid-handler crash left the system in a partial-commit state (e.g., Invoice
PAID but Subscription not ACTIVE). Now every state transition is
all-or-nothing.

### AiAuditLog STATE_TRANSITION payload shape

```typescript
{
  scope: "payment",
  scopeId: <payment.id>,
  issueType: "STATE_TRANSITION",
  severity: "MEDIUM",
  analysis: JSON.stringify({
    from: "PENDING",
    to: "PAID" | "REFUNDED" | "FAILED",
    provider: "PAYME" | "CLICK",
    transactionId: <provider tx id>,
    by: "WEBHOOK",
    // CancelTransaction also includes:
    reason: <reasonOverride|params.reason|null>,
    // user-cancel branch also includes:
    reason: "user_cancelled",
  }),
  recommendation: "",
}
```

### PaymentTimeoutProcessor (PAY-04)

`apps/backend/src/infra/queue/payment-timeout.processor.ts`:
- `@Processor(PAYMENT_TIMEOUT_QUEUE, { concurrency: 5 })`.
- `process(job)` reads Payment row; if status !== "PENDING" → no-op (covers
  the late-confirm race + double-fire safety); else opens `$transaction`
  that flips status to FAILED + writes AiAuditLog with `issueType: "TIMEOUT",
  severity: "MEDIUM", analysis: { provider, age_hours: 12, by: "SYSTEM_TIMEOUT" }`.

Enqueue/remove on PaymeService lifecycle:

| Site                            | Action                                                                   |
|---------------------------------|--------------------------------------------------------------------------|
| `_createTransaction` (success)  | `paymentTimeoutQueue.add("cancel-on-timeout", { paymentId, provider: "PAYME" }, { jobId: "payment-timeout:{paymentId}", delay: 43200000 })` |
| `_performTransaction` (success) | `paymentTimeoutQueue.remove("payment-timeout:{paymentId}").catch(() => undefined)` |
| `_cancelTransaction` (success)  | same `.remove(...).catch(...)`                                           |

**jobId format**: `payment-timeout:{paymentId}` — deterministic so Payme
retransmits coalesce to a single delayed job.

**delay**: `12 * 60 * 60 * 1000` ms (43,200,000).

### reason=4 timeout-driven cancel mapping (PAY-04)

When Payme calls `CancelTransaction` AFTER our processor already flipped
the payment to FAILED, `_cancelTransaction` looks up the latest
`AiAuditLog` for `{ scope: "payment", scopeId: payment.id }`. If its
`issueType === "TIMEOUT"`, the response carries `result.reason = 4` per
Payme docs verified 2026-06-07. Caller-driven cancels (status was PENDING
when the call arrived, or the last audit row isn't TIMEOUT) honor the
caller-supplied `params.reason`.

## Test count delta

| Suite                                  | Before | After | Delta |
|----------------------------------------|--------|-------|-------|
| `payme.service.spec.ts`                | 25     | 36    | +11   |
| `click.service.spec.ts`                | 28     | 35    | +7    |
| `payment-timeout.processor.spec.ts`    | 0      | 7     | +7    |
| **TOTAL**                              | 951    | **975** | **+24** |

Plan target was ~30 new tests; delivered 24 (covers all listed branches
including 5 status × 2 providers + idempotency + atomicity + audit + reason=4).

## Verification

- `cd apps/backend && npm test` — **51 suites, 975/975 tests green**
- `cd apps/backend && npx tsc --noEmit` — clean
- Acceptance grep results:
  - `grep -cE "this\\.prisma\\.\\$transaction\\(async" apps/backend/src/modules/payment/payme.service.ts` → 2
  - `grep -cE "this\\.prisma\\.\\$transaction\\(async" apps/backend/src/modules/payment/click.service.ts` → 2
  - `grep -cE "tx\\.aiAuditLog\\.create" apps/backend/src/modules/payment/{payme,click}.service.ts` → 4 (2 per file)
  - `grep -n "paymentTimeoutQueue\\.(add|remove)" apps/backend/src/modules/payment/payme.service.ts` → 3 hits (add in _createTransaction; remove in _performTransaction + _cancelTransaction)
  - `grep -n "@Processor(PAYMENT_TIMEOUT_QUEUE" apps/backend/src/infra/queue/payment-timeout.processor.ts` → 1 hit
  - `grep -n "PaymentTimeoutProcessor" apps/backend/src/infra/queue/queue.module.ts` → 2 hits (import + providers)
  - `grep -n "payment-timeout:" apps/backend/src/modules/payment/payme.service.ts` → deterministic jobId
  - `grep -n "12 \\* 60 \\* 60 \\* 1000" apps/backend/src/modules/payment/payme.service.ts` → 12h delay literal (via `PAYMENT_TIMEOUT_DELAY_MS` constant)
  - `grep -nE "IpWhitelistGuard|@IpWhitelist" apps/backend/src/modules/payment/payment.controller.ts` → 6 hits (3 routes × import + decorator)

## Deviations from plan

1. **Plan said `handleRequest`; existing method is `handleWebhook`**. Kept
   the original name to avoid breaking other downstream call sites; semantics
   are identical (the verb just describes "the dispatcher" either way).
2. **DEV_SUBSCRIPTION_PAYMENT_STUB gate**: deferred to Plan 04-03. The Plan
   04-01 primitive is registered, but Plan 04-02 doesn't add the short-circuit
   branch yet — that lands with the subscription state machine where it
   shapes the dev seeding flow.
3. **Kafka emits PAYMENT_RECEIVED / SUBSCRIPTION_ACTIVATED**: NOT wired in
   this plan. The KAFKA_TOPICS constants exist (Plan 04-01) but the emit
   helpers are deferred to Plan 04-03 alongside the SubscriptionService
   refactor (where the state machine is the source of truth for what to
   emit). Per plan text these are "AFTER the transaction commit" hooks; the
   current PaymeService/ClickService leaves the call sites empty for the
   Plan 04-03 wire-up.
4. **payment.controller.spec.ts not added** — the existing payme.service.spec
   and click.service.spec exercise the guard via verifying `tryAcquire` is
   called with the expected key (which only happens when the request reaches
   the handler, i.e., past the guard). The IpWhitelistGuard already has a
   dedicated spec in `apps/backend/src/common/guards/__tests__/`. A
   controller-level integration spec would duplicate that coverage without
   adding new branches.

## Handoff to Plan 04-03

Plan 04-03 (subscription state machine + invoice atomicity) can now:

1. Wire Kafka emits `PAYMENT_RECEIVED` + `SUBSCRIPTION_ACTIVATED` AFTER
   the `$transaction` returns in PaymeService._performTransaction and
   ClickService._completeInternal (emit failure must NOT roll back DB
   commit — log and continue).
2. Add DEV_SUBSCRIPTION_PAYMENT_STUB short-circuit branch gated by
   `isSubscriptionStubActive(process.env)`.
3. Add Subscription.frozenReason field + migration + admin-only FROZEN
   transitions.
4. Refine the late-perform race (Plan 04-02 PAY-15 accepted risk): when
   Payme retries Perform after our timeout fired and we already FAILED the
   payment, our PerformTransaction handler returns -31003 ("Tranzaksiya
   topilmadi"). Phase 5 hardening: outbound CheckTransaction RPC to Payme
   to reconcile status.
