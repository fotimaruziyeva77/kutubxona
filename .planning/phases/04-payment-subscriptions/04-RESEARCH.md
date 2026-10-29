# Phase 4 Research — Payment & Subscriptions

**Researched:** 2026-06-07
**Domain:** Payment integration (Payme JSON-RPC + Click HMAC), subscription lifecycle, invoice PDF + 1C export
**Confidence:** HIGH (codebase audit + Payme/Click official docs + slopcheck verified)

---

## Executive Summary

Phase 4 closes the financial perimeter for SIFAT Library. Three scaffolds already exist in the codebase — `apps/backend/src/modules/payment/` (PaymeService, ClickService, InvoiceService, SubscriptionService) and `apps/backend/src/modules/donate/` — and they ship a functional but **insecure** baseline. The work is therefore predominantly **FIX/EXTEND**, not greenfield: tighten what's there, add missing guards, swap placeholder signature methods, and wire the 12-hour timeout.

**Three load-bearing findings the planner must internalize before writing tasks:**

1. **Hand-roll Payme JSON-RPC, no SDK.** `paytechuz` and `@paytechuz/nestjs-payment` are slopcheck `[SLOP]` (hallucinated, do not exist on npm). The three nominal alternatives (`payme-uz`, `click-uz`, `payme-merchant-integrator`) are all `[SUS]`: <50 downloads/week, no source repo on most, last published 2022. The 280-line `payme.service.ts` already in-tree is closer to production than any of them. Tighten it, do not replace it.
2. **Click signature formula is currently WRONG.** The existing `click.service.ts:160-173` omits `service_id` from the MD5 concatenation; per current Click docs (verified 2026-06-07) the correct formula is `md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)` for Prepare and `md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)` for Complete. **Every callback the existing code accepts today would be rejected by real Click.** This is a FIX, not an EXTEND.
3. **The 12-hour Payme timeout is officially documented.** Payme transactions automatically cancel after 12 hours (43,200,000 ms) and transition to state −1 with cancel reason code 4. The current `_createTransaction` (`payme.service.ts:85-125`) does NOT enforce this — a stuck PENDING payment lives forever and blocks the invoice. PAY-04 must add a BullMQ delayed job (12h) on `CreateTransaction`, removed on `PerformTransaction` or fired on timeout to flip the payment to FAILED.

**Primary recommendation:** Reuse the existing scaffold, do not rewrite. Wave 0 hardens cross-cutting primitives (RedisLockService for SETNX-based idempotency, fix Click HMAC, swap Buxgalter cookie auth); Wave 1 wires PAY-01..04 hardening + 12h timeout; Wave 2 lands PDF/QR/invoice tightening + subscription state machine atomicity (PAY-05/PAY-06/PAY-08); Wave 3 ships reminders + Buxgalter 1C export + tests (PAY-07 + RPT-03).

---

## Project Constraints (from CLAUDE.md)

The following CLAUDE.md directives bind Phase 4 work; the planner must verify each is honored:

- **§VIII.3** — All personal data lives on O'zbekiston servers (Unicon.uz / TIF DC). Payme/Click webhook IPs are external by definition; whitelist them per IpWhitelistGuard pattern but do NOT proxy traffic abroad. Cloudflare CDN only — no CDN edge processing of payment payloads.
- **§VIII.1** — JWT auth: access 15min / refresh 30d via HttpOnly cookie. Buxgalter UI MUST be migrated off `localStorage.getItem("token")` (currently broken — see Current State Audit, RPT-03).
- **§VIII.4** — Audit log append-only, 2 year retention. Every state transition on `Payment` and `Subscription` MUST be captured in `AiAuditLog` (existing model) with `kim | qachon | nima | qayerdan | natija`.
- **§X.10.4 Caching** — Hot reads via Redis with explicit TTL keys. Buxgalter aggregations: 5-minute Redis cache, write-through invalidation on payment webhook ACK.
- **§XIII.2 Subscription States** — TRIAL → ACTIVE → PENDING → FROZEN → DELETED. **FROZEN and DELETED are administrator-only and require a reason string.** Trial timeout produces PENDING + invoice, never auto-FROZEN.
- **§XIII.3 Trial schedule** — Reminders day 20 (10d left), day 27 (3d left), day 30 trial→PENDING. PAY-07 calls for 30/15/7/1 day reminders for due invoices (separate cadence from trial reminders — both crons must coexist).
- **§XIV.2 Donations free for bookstores** — Phase 3 already shipped `DEV_DONATION_PAYMENT_STUB`; Phase 4 must NOT regress that path. Phase 4 hardens the same webhook surface for subscription invoices.
- **§XV.R1 Server localization** — PAYME_SECRET_KEY / CLICK_SECRET_KEY MUST be loaded from Vault in production, .env permitted only in dev. Boot must fail-hard if production env lacks Vault values for these.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PAY-01 | Payme JSON-RPC webhook with idempotency keys (Redis SETNX, 24h TTL) | Existing `payme.service.ts` handles 6 methods but lacks Redis-level idempotency. CreateTransaction uses DB unique `transactionId` only — race-safe but slow. Add SETNX layer per webhook hit. |
| PAY-02 | Click webhook with HMAC signature verification and idempotency | Existing `click.service.ts:160-173` signature formula is WRONG (missing service_id). Fix formula AND add idempotency. |
| PAY-03 | Payment state changes wrapped in Prisma `$transaction()` for atomicity | `payme.service.ts:144-164` and `click.service.ts:126-145` do three sequential awaits (payment.update + invoice.update + subscription.update) — NOT atomic. Wrap in interactive `prisma.$transaction(async (tx) => {...})`. |
| PAY-04 | 12-hour transaction timeout enforcement via BullMQ delayed job | BullMQ infra live (Plan 02-03, RI_RECALC_QUEUE pattern). Add PAYMENT_TIMEOUT_QUEUE; enqueue delayed 12h job on CreateTransaction; cancel job on PerformTransaction; on fire, transition Payment → FAILED + Subscription stays PENDING. |
| PAY-05 | Invoice PDF generation with organization details, bank requisites, QR payment code | `invoice.service.ts:171-292` already generates Puppeteer-based PDF. Missing: QR code embedding. `qrcode@1.5.4` already in package.json — generate data-URL inline. |
| PAY-06 | Subscription lifecycle: TRIAL(30d) → PENDING → ACTIVE/FROZEN(admin only) | `subscription.service.ts:215-268` handles trial expiry to PENDING but state machine has no validator. Add `updateStatus` guard that rejects invalid transitions. |
| PAY-07 | Payment reminder notifications at 30, 15, 7, 1 days before due date | `subscription.service.ts:164-210` cron implements this loop today but calls SMS directly, not via NotificationProcessor queue. Refactor to enqueue NotificationJobData via BullMQ NOTIFICATION_QUEUE (Plan 01-01 pattern). |
| PAY-08 | Subscription freeze/delete is admin-only (never automatic) | `subscription.service.ts:127-132` `updateStatus()` accepts any status but does NOT enforce admin role guard. Add controller-level @Roles + service-level state machine validator + reason-required for FROZEN/DELETED. |
| RPT-03 | Buxgalter panel: all payments, invoices, monthly/yearly revenue, Export Excel/PDF/1C | `invoice.service.ts:296-330` exports CSV-only (labeled "Excel" but is plaintext CSV). Buxgalter UI exists but uses broken localStorage auth. Add real XLSX via exceljs (already installed), 1C CSV format per Open Question OQ-3, fix UI auth. |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Payme webhook handling (CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction, GetStatement) | API / Backend | — | Payment provider talks to NestJS directly; never to browser. |
| Click webhook (Prepare, Complete) | API / Backend | — | Same — external POST callback. |
| Webhook idempotency (Redis SETNX) | API / Backend | Redis (Cache infra) | Atomic dedupe layer in front of DB transaction. |
| Subscription state machine + transition validation | API / Backend | Database (constraint) | Business rule; DB has enum but no transition constraint. App-level validator authoritative. |
| 12h Payment cancel scheduling | API / Backend | BullMQ (delayed jobs) | Existing `@nestjs/bullmq` v10 supports `delay` opt — no new infra. |
| Invoice PDF generation | API / Backend | PdfService (Puppeteer) | Existing PdfService. CPU-heavy, queue via REPORT_QUEUE if Buxgalter requests bulk. |
| QR payment code generation | API / Backend | `qrcode` lib | Generate data-URL server-side, embed in Puppeteer HTML. |
| Buxgalter dashboard (read-only finance) | Frontend Server (Next.js) | API / Backend | Browser → SSR/CSR → NestJS read endpoints. Heavy aggregations served from replica + Redis. |
| Reminder cron (30/15/7/1 day before due) | API / Backend | BullMQ (NOTIFICATION_QUEUE) | Enqueue, processor dispatches via Eskiz/Firebase. |
| 1C export / Excel export | API / Backend | exceljs + BullMQ if bulk | Synchronous stream for small ranges (<5k rows); BullMQ for full-year exports. |

---

## Architectural Patterns

### System Architecture Diagram

```
                                  ┌─────────────────────────────┐
       Payme/Click servers ──────►│  IpWhitelistGuard (Phase 3) │
       (external IPs whitelisted) └─────────────┬───────────────┘
                                                │
                                  ┌─────────────▼───────────────┐
                                  │  Signature verify           │
                                  │  - Payme: Basic Auth         │
                                  │  - Click: MD5(...service_id..)│
                                  └─────────────┬───────────────┘
                                                │
                                  ┌─────────────▼───────────────┐
                                  │  Redis SETNX idempotency    │
                                  │  webhook:{provider}:{txId}  │
                                  │  TTL 24h                    │
                                  └──────┬──────────────┬───────┘
                                  duplicate          new
                                         │              │
                              return cached      ┌──────▼──────────────┐
                                 response        │ prisma.$transaction │
                                                 │  • Payment.update    │
                                                 │  • Invoice.update    │
                                                 │  • Subscription.update│
                                                 │  • AiAuditLog.insert  │
                                                 └──────┬──────────────┘
                                                        │
                                ┌───────────────────────┴──┬─────────────────┐
                                │                          │                 │
                  ┌─────────────▼─────────┐    ┌───────────▼──────┐ ┌────────▼─────────┐
                  │ BullMQ:               │    │ BullMQ:           │ │ Kafka (existing) │
                  │ NOTIFICATION_QUEUE    │    │ PAYMENT_TIMEOUT   │ │ payment.completed│
                  │ • payment receipt     │    │ delay=12h         │ │ (NEW topic)      │
                  │ • subscription ACTIVE │    │ removeOnPerform   │ └──────────────────┘
                  └───────────────────────┘    └───────────────────┘

                          ┌─────────────────────────────────────────┐
                          │  Buxgalter dashboard (cookie auth)       │
                          │  • Read replica for aggregations         │
                          │  • Redis 5-min cache (stats:buxgalter)   │
                          │  • exceljs for XLSX export               │
                          │  • Puppeteer for invoice PDF             │
                          │  • CSV 1C-compatible for accounting tool │
                          └─────────────────────────────────────────┘
```

### Pattern 1: Two-Layer Idempotency (Redis SETNX + DB unique constraint)

**What:** Redis layer fast-fails duplicates within a 24h window; DB unique constraint on `Payment.transactionId` is the immortal truth.
**When to use:** Every webhook endpoint that mutates persisted state.
**Example:**
```typescript
// Source: pattern derived from architecture.md §2 + existing donate.service.ts:111-153 cache.remember usage
async handlePaymeWebhook(authHeader: string, body: PaymeRpcRequest) {
  this._verifyAuth(authHeader);

  // Layer 1: Redis SETNX (24h TTL) — atomic, replica-safe
  const key = `webhook:payme:${body.params?.id ?? randomUUID()}:${body.method}`;
  const cached = await this.lockService.tryAcquire(key, 24 * 3600);
  if (!cached.acquired) return cached.cachedResponse;

  // Layer 2: DB transaction with unique constraint
  const response = await this.prisma.$transaction(async (tx) => {
    // existing handler body — payment.findFirst by transactionId is now within tx
    return this._dispatch(body.method, body.id, body.params, tx);
  });

  await this.lockService.storeResponse(key, response, 24 * 3600);
  return response;
}
```

### Pattern 2: BullMQ Delayed Cancel Job (PAY-04)

**What:** Schedule a cancel job on `CreateTransaction`; remove it on `PerformTransaction`; fire it on `CancelTransaction` arrival or after 12h.
**When to use:** Any payment provider with finite transaction lifetimes.
**Example:**
```typescript
// Source: BullMQ delayed jobs pattern, https://docs.bullmq.io/guide/jobs/delayed
// jobId is deterministic (payment.id), so re-add is a no-op
async _createTransaction(rpcId: any, params: any, tx: Prisma.TransactionClient) {
  const payment = await tx.payment.create({ ... });
  await this.timeoutQueue.add(
    "cancel-payment-timeout",
    { paymentId: payment.id, provider: "PAYME" },
    {
      jobId: `payment-timeout:${payment.id}`,
      delay: 12 * 60 * 60 * 1000, // 12h per Payme docs
      removeOnComplete: { count: 100 },
      removeOnFail: false,
    },
  );
  return { ... };
}

// Cancellation removes the timeout (idempotent — missing job is fine)
async _performTransaction(...) {
  // ... existing state update ...
  await this.timeoutQueue.remove(`payment-timeout:${payment.id}`).catch(() => undefined);
}
```

### Pattern 3: State Machine Validator (PAY-06, PAY-08)

```typescript
// Source: existing patterns in libraries.service / fraud.service review-queue
const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  TRIAL:   ["PENDING", "ACTIVE", "FROZEN"],          // FROZEN only when admin overrides
  PENDING: ["ACTIVE", "FROZEN"],                      // FROZEN admin-only
  ACTIVE:  ["PENDING", "FROZEN", "DELETED"],          // expiry -> PENDING; admin freeze/delete
  FROZEN:  ["ACTIVE", "DELETED"],                     // admin reactivates or deletes
  DELETED: [],                                        // terminal
};

function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus, by: UserRole, reason?: string) {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new BadRequestException(`Invalid transition ${from} → ${to}`);
  }
  if ((to === "FROZEN" || to === "DELETED") && by !== "SUPER_ADMIN" && by !== "BUXGALTER") {
    throw new ForbiddenException(`Only SUPER_ADMIN can move to ${to}`);
  }
  if ((to === "FROZEN" || to === "DELETED") && !reason) {
    throw new BadRequestException(`${to} requires a reason string`);
  }
}
```

### Anti-Patterns to Avoid

- **Three sequential `prisma.update`s without `$transaction`** — Current bug. A crash between updates leaves Invoice PAID but Subscription not ACTIVE.
- **Trusting webhook signature alone (no IP whitelist)** — Payme's docs do not publish IP ranges officially; Click does. Both should use IpWhitelistGuard with env-driven CSV (Phase 3 pattern). Without whitelist, an attacker who exfiltrates a secret can replay forever.
- **In-memory `signatureWarnedProviders` set as idempotency** — Phase 3 stubs use this only for log dedupe. Idempotency MUST use Redis or DB.
- **`updateStatus(id, status)` with no transition check** — Currently accepts any status, including `ACTIVE → DELETED` skip-FROZEN.
- **Storing PAYME_SECRET_KEY in .env.prod** — must go through Vault per §VIII.3 / Phase 1 INFRA-04 hard-fail.
- **CSV labeled as "Excel"** — Current `exportToExcel()` returns CSV. Buxgalters using actual Excel get encoding artifacts; use exceljs to emit real XLSX.

---

## Current State Audit (per requirement, with file:line evidence)

### PAY-01: Payme JSON-RPC webhook with idempotency keys (Redis SETNX, 24h TTL)

**Current state:** PARTIALLY BUILT
- `apps/backend/src/modules/payment/payme.service.ts:29-56` dispatches 6 JSON-RPC methods with switch.
- `:260-274` `_verifyAuth` uses Basic Auth (correct per Payme docs — Payme uses Basic, not HMAC).
- `:85-125` `_createTransaction` checks DB `payment.findFirst({ where: { transactionId } })` for idempotency — this works against duplicate `id` from Payme, BUT it's a slow DB hit. No Redis layer.
- No IP whitelist (`@UseGuards(IpWhitelistGuard)` not on `paymentController:paymeWebhook` at `payment.controller.ts:36-43`).
- DTOs are `any` (per PITFALLS H1 — `payme.service.ts:59,85,128,176,199,227`).

**Classification:** FIX (idempotency layer + DTOs) + EXTEND (IpWhitelistGuard wiring from Phase 3).

**Gap:** Add `RedisLockService` (new) using `SETNX paymentlock:payme:{transactionId}:{method} <traceId> EX 86400`; cache the response under `webhook:payme:{transactionId}:{method}` for replay; wire `@UseGuards(IpWhitelistGuard)` + `@IpWhitelist("PAYME_IP_WHITELIST")` on the controller route.

### PAY-02: Click webhook with HMAC signature verification and idempotency

**Current state:** BUILT BUT BROKEN (signature formula incorrect)
- `apps/backend/src/modules/payment/click.service.ts:27-79` `prepare()`, `:83-156` `complete()` implement 2-step flow.
- `:160-173` `_makeSign` formula is **WRONG**: omits `service_id`.

  Current code:
  ```typescript
  const raw = merchantPrepareId
    ? `${clickTransId}${action}${secretKey}${merchantTransId}${merchantPrepareId}${amount}${signTime}`
    : `${clickTransId}${action}${secretKey}${merchantTransId}${amount}${signTime}`;
  ```
  Per Click official docs (https://docs.click.uz/en/click-api-request/, verified 2026-06-07):
  ```
  Prepare:  md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)
  Complete: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
  ```
- `:57-70` checks `findFirst { transactionId }` then conditionally creates — same race window as Payme.
- No IpWhitelistGuard on the controller route (`payment.controller.ts:48-60`).

**Classification:** FIX (signature formula is a correctness bug — production code would silently reject every real Click callback).

**Gap:** (1) Fix `_makeSign` formula to match official spec including `service_id`. (2) Add SETNX idempotency. (3) Wire `IpWhitelistGuard` + `@IpWhitelist("CLICK_IP_WHITELIST")`. (4) The `service_id` value will come from `body.service_id` (per current Click body type `ClickPrepareBody.service_id: string`).

### PAY-03: Payment state changes wrapped in Prisma `$transaction()` for atomicity

**Current state:** BUILT BUT NOT ATOMIC
- `payme.service.ts:144-164` `_performTransaction` runs 3 sequential `await`s outside any `$transaction`. A crash between Invoice.PAID and Subscription.ACTIVE leaves the system in inconsistent state.
- `click.service.ts:126-145` `complete()` has the identical bug.
- Phase 2 already converted 4 sites in `transactions.service.ts` to interactive `$transaction(async tx => ...)` callback form (D-02-02). Same pattern applies here.

**Classification:** FIX (wrap existing logic in interactive transaction).

**Gap:** Convert to `await this.prisma.$transaction(async (tx) => { ...all three updates... })`. The transaction client `tx` passes through to the dispatched handler. Also write an `AiAuditLog` row inside the transaction for §VIII.4 compliance.

### PAY-04: 12-hour transaction timeout enforcement via BullMQ delayed job

**Current state:** NOT BUILT
- Payme docs (verified 2026-06-07 https://developer.help.paycom.uz/metody-merchant-api/createtransaction/): "Otмена по таймауту производится через 12 часов" — 12h auto-cancel, transitions to state −1 with reason code 4.
- Current `_createTransaction` creates Payment in PENDING and returns. Nothing schedules a future cancel. If Payme's own cancel call (`CancelTransaction`) never arrives — for example, Payme's webhook misfires — the Payment stays PENDING forever.
- BullMQ infra is live (`queue.module.ts:9-17` defines REPORT_QUEUE, AI_QUEUE, RI_RECALC_QUEUE, BOOK_IMPORT_QUEUE).

**Classification:** NEW.

**Gap:** Add `PAYMENT_TIMEOUT_QUEUE = "payment-timeout"` to `queue.module.ts`; create `PaymentTimeoutProcessor` (concurrency 5, attempts 1). On `_createTransaction`: `queue.add({ paymentId }, { jobId: \`payment-timeout:${payment.id}\`, delay: 12*60*60*1000 })`. On `_performTransaction` and `_cancelTransaction`: `queue.remove(jobId).catch(() => undefined)`. Processor handler: if payment still PENDING, wrap in `$transaction` → set PaymentStatus.FAILED, optionally set Invoice back to PENDING (Subscription stays in TRIAL/PENDING).

### PAY-05: Invoice PDF generation with organization details, bank requisites, QR payment code

**Current state:** MOSTLY BUILT, NO QR
- `invoice.service.ts:171-292` generates HTML → Puppeteer PDF. Includes sender, buyer, line item, bank requisites (NBU placeholder).
- `:280-282` mentions "Online to'lash uchun: sifat.uz/pay/{id}" but does NOT generate a QR code.
- `qrcode@1.5.4` already in `apps/backend/package.json:52`. `@types/qrcode@1.5.6` also installed.

**Classification:** EXTEND (add QR generation + embed as data URL).

**Gap:** `import * as QRCode from "qrcode"`; `const qrDataUrl = await QRCode.toDataURL(\`https://sifat.uz/pay/${invoice.id}\`, { width: 180, margin: 1 })`; embed as `<img src="${qrDataUrl}" />` in HTML. Real bank requisites need OQ-1 user confirmation (current code hardcodes UZ12 0000 0000... placeholder).

### PAY-06: Subscription lifecycle: TRIAL(30d) → PENDING → ACTIVE/FROZEN(admin only)

**Current state:** PARTIALLY BUILT
- `subscription.service.ts:35-50` `createTrial` sets `status=TRIAL`, `trialEnd=now+30d`, `endDate=now+365d`. Correct per §XIII.3.
- `:215-268` `trialExpiryReminders` cron at 09:00 daily: sends 3-day and 10-day reminders, then sweeps expired trials into PENDING + creates invoice. Good.
- `:127-132` `updateStatus(id, status, reason?)` has NO transition validator. Anyone with the JWT can set any status. `reason?` is optional even for FROZEN/DELETED.
- Schema enum at `schema.prisma:81-87` has all 5 states. No transition table.

**Classification:** EXTEND (add state machine validator + role guard).

**Gap:** Define `ALLOWED_TRANSITIONS` map; `updateStatus` rejects illegal transitions; FROZEN/DELETED require role check + non-empty reason. The reason should be persisted (add `frozenReason String?` like `Library.frozenReason`).

### PAY-07: Payment reminder notifications at 30, 15, 7, 1 days before due date

**Current state:** BUILT BUT SYNCHRONOUS
- `subscription.service.ts:164-210` `@Cron("0 10 * * *")` `sendPaymentReminders` loops days [30, 15, 7, 1], finds matching PENDING invoices, calls `this.sms.sendNotification(phone, message).catch(...)`.
- This calls `SmsService.sendNotification` directly instead of enqueueing through BullMQ NOTIFICATION_QUEUE (Plan 01-01 pattern). A slow SMS provider blocks the cron loop.

**Classification:** FIX (refactor to enqueue NotificationJobData).

**Gap:** Inject `@InjectQueue(NOTIFICATION_QUEUE) private notifQueue: Queue`; replace `await this.sms.sendNotification(...)` with `await this.notifQueue.add("payment-reminder", { type: "sms", phone, message, userId: lib.id })`. Cron returns immediately. The NotificationProcessor (already active per Plan 01-01) dispatches via Eskiz.

### PAY-08: Subscription freeze/delete is admin-only (never automatic)

**Current state:** NOT ENFORCED
- `subscription.service.ts:127-132` `updateStatus` is called from controller `payment.controller.ts:170-178` which has `@UseGuards(JwtAuthGuard)` but NO `@Roles()` decorator. Any authenticated user — including a librarian — can freeze any subscription.
- No automatic code paths produce FROZEN/DELETED today, which is the *intended* state. The risk is human (or breach-via-token) misuse.

**Classification:** FIX (role gate + reason requirement).

**Gap:** Controller route: `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)`. Service: state machine validator (see Pattern 3) enforces non-empty reason on FROZEN/DELETED. Write `AiAuditLog` row capturing actor + reason.

### RPT-03: Buxgalter panel — payments, invoices, monthly/yearly revenue, Export Excel/PDF/1C

**Current state:** MIXED
- Backend `invoice.service.ts:91-167` `getPaymentStats` aggregates `byStatus`, `byMethod`, monthlyTrend with 12 separate `prisma.payment.aggregate` calls in a for-loop. 12 round trips per request. Should use one `groupBy` with date_trunc.
- Backend `invoice.service.ts:296-330` "Excel" export is **plaintext CSV**. Real Excel would need exceljs (installed).
- Frontend `apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx:21-22,64,77,89,158-167` uses `localStorage.getItem("token")` — **broken under Phase 1 cookie auth.** Every API call returns 401. The page is non-functional in production.
- No 1C export endpoint exists.
- Aggregation queries hit primary, not replica.

**Classification:** FIX (auth migration + replica routing + real XLSX) + EXTEND (1C export).

**Gap:**
1. Frontend: replace `localStorage.getItem("token")` with `credentials: "include"` (cookie path already set in Phase 1).
2. Backend: route heavy aggregations through `PrismaReplicaService` (Phase 2 Plan 02-03).
3. Replace CSV-as-Excel with real `.xlsx` via `exceljs` (installed v4.4.0).
4. Add `/invoices/export/1c` returning a 1C-Bukhgalteriya-compatible CSV (delimiter, columns per OQ-3).
5. Cache `getPaymentStats` in Redis 5min keyed by `from-to` range.

---

## Payme JSON-RPC Handler Design (Load-Bearing Decision 1)

**Decision: Hand-roll. Tighten the existing 280-line `payme.service.ts`. Do NOT introduce an SDK.**

### Why no SDK

| Candidate | Verdict | Reasoning |
|-----------|---------|-----------|
| `paytechuz` (npm) | `[SLOP]` (slopcheck) — does not exist on npm | Hallucination — searches that suggest it conflate the Python `paytechuz` package (Django/FastAPI only per https://docs.pay-tech.uz/). |
| `@paytechuz/nestjs-payment` (npm) | `[SLOP]` (slopcheck) — does not exist on npm | Hallucination — there is no NestJS port of paytechuz. |
| `payme-merchant-integrator` (npm 1.2.13, last published 2022-08, 44 downloads) | `[SUS]` | Mongo-coupled, abandoned 4 years, low confidence. |
| `payme-uz` (npm 1.1.2, last published 2022-05, 32 downloads, no source repo) | `[SUS]` | No source repo on npm metadata — unreviewable. |
| `click-uz` (npm 1.1.2, last published 2022-04, 33 downloads, no source repo) | `[SUS]` | Same — unreviewable. |
| GitHub `samarbadriddin0v/payme-uz-integration-nodejs` | Reference only | Tutorial code, not a published package; not import-ready. |

The existing 280-line `payme.service.ts` is closer to a hardened implementation than any of these. Tightening it (Add DTOs + idempotency + atomic transaction + IpWhitelist) is roughly 6 hours of work. Replacing with a 2022-vintage Mongo-coupled package would take more, risk more, and verify less.

### Required hardening

1. **Typed DTOs replacing `any`.** Create `CheckPerformTransactionParamsDto`, `CreateTransactionParamsDto`, `PerformTransactionParamsDto`, `CancelTransactionParamsDto`, `CheckTransactionParamsDto`, `GetStatementParamsDto` with `class-validator` decorators (Pattern: existing `auth.dto.ts`). Validate via `class-transformer` `plainToInstance` + `validateOrReject` in the controller, before dispatch.

2. **IpWhitelistGuard wiring.** On `paymentController.paymeWebhook`: `@UseGuards(IpWhitelistGuard) @IpWhitelist("PAYME_IP_WHITELIST")`. Permissive default (Phase 3 pattern) in dev; production must populate the env CSV. **Open question OQ-2 — does Payme publish IPs?** If no, OQ-2 escalates the choice between "no IP whitelist for Payme, rely on Basic Auth + IP from x-real-ip header logged for forensics" vs "request IP list from Payme integration team".

3. **Basic Auth strengthening.** Existing `_verifyAuth` accepts `Paycom` username (test) OR anything else (production with `secretKey`). Per Payme docs the convention is `Paycom` for sandbox, the production username is provided by Payme on activation. Add `PAYME_LOGIN` env var; in production allowlist `[PAYME_LOGIN, "Paycom"]` and pick the right key by login (already done). Constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

4. **JSON-RPC error code panel (verified against Payme docs 2026-06-07):**

   | Code | Meaning | When |
   |------|---------|------|
   | `-32400` | System error | Internal DB/Redis failure |
   | `-32504` | Insufficient privileges | Auth check fail |
   | `-32601` | Method not found | Unknown method name |
   | `-31001` | Invalid amount | amount mismatch with invoice |
   | `-31003` | Transaction not found | unknown transactionId in Perform/Cancel/Check |
   | `-31007` | Order already paid | (use when Invoice.status already PAID) |
   | `-31008` | Cannot perform operation | wrong state transition |
   | `-31050..-31099` | Invalid account data | invoice id not found, library mismatch — message must be localized |
   | `-31099` | (custom) | reserved |

   Current code uses some of these but inconsistently — `-31050` is used for "invoice topilmadi" (correct) and "invoice allaqachon to'langan" (should be `-31007`). Fix.

5. **state field mapping (verified 2026-06-07):**

   | Payme state | Meaning | DB PaymentStatus |
   |-------------|---------|------------------|
   | `1` | created, awaiting confirmation | PENDING |
   | `2` | confirmed (paid) | PAID |
   | `-1` | cancelled before perform | FAILED |
   | `-2` | cancelled after perform (refund) | REFUNDED |

   Current code at `payme.service.ts:206-211` maps `REFUNDED` and `FAILED` both to `-1` — should distinguish (`REFUNDED → -2`, `FAILED → -1`).

6. **cancel reason codes:**

   | Reason | Meaning |
   |--------|---------|
   | `1` | wrong account |
   | `2` | error in execution |
   | `3` | wrong transaction (not the merchant's) |
   | `4` | **timeout (12h auto-cancel)** |
   | `5` | refund |

   PAY-04 must produce reason `4` when the BullMQ timeout job fires (per Payme docs).

---

## Click HMAC Handler Design

**Decision: Fix the signature formula, then apply identical idempotency + atomicity pattern as Payme.**

### Signature formula (CORRECTED — verified at https://docs.click.uz/en/click-api-request/ on 2026-06-07)

```typescript
// Prepare (action = 0)
const prepareRaw = `${click_trans_id}${service_id}${SECRET_KEY}${merchant_trans_id}${amount}${action}${sign_time}`;
const expected = crypto.createHash("md5").update(prepareRaw).digest("hex");

// Complete (action = 1)
const completeRaw = `${click_trans_id}${service_id}${SECRET_KEY}${merchant_trans_id}${merchant_prepare_id}${amount}${action}${sign_time}`;
```

**This differs from the existing `_makeSign` in three ways:**
- `service_id` is included (missing in current code — top bug)
- Order is fixed: `click_trans_id, service_id, SECRET_KEY, merchant_trans_id, [merchant_prepare_id?], amount, action, sign_time`
- (No change) MD5 hex digest, no Base64, no separator.

`service_id` value comes from `body.service_id` (already typed in `ClickPrepareBody.service_id: string` at `click.service.ts:179`). The existing handler signature must be updated to accept `service_id` from the body, not embed a constant.

### Error codes (verified 2026-06-07)

| Code | Meaning | When to use |
|------|---------|-------------|
| `0` | Success | Happy path |
| `-1` | SIGN_CHECK_FAILED | Signature mismatch |
| `-2` | INCORRECT_PARAMETER_AMOUNT | amount mismatch with invoice |
| `-3` | ACTION_NOT_FOUND | Unknown action |
| `-4` | ALREADY_PAID | Invoice already PAID |
| `-5` | USER_DOES_NOT_EXIST | Invoice id not found |
| `-6` | TRANSACTION_DOES_NOT_EXIST | Unknown click_trans_id on Complete |
| `-7` | FAILED_TO_UPDATE_USER | DB write error |
| `-8` | ERROR_IN_REQUEST_FROM_CLICK | Malformed request |
| `-9` | TRANSACTION_CANCELLED | Cancel acknowledged (caller wants to remove reservation) |

Current code uses `-1, -2, -4, -5, -6` correctly. Add `-9` handling for cancel acknowledgement.

### IP whitelist for Click

Click publishes their callback IP ranges in the merchant cabinet (not in public docs). Operator provides them in `CLICK_IP_WHITELIST` env on production deploy. Permissive in dev via Phase 3 IpWhitelistGuard. Document this in `.env.prod.example`.

---

## Idempotency Strategy (Load-Bearing Decision 2)

**Decision: Both layers, in this order:** (1) Redis SETNX with 24h TTL; (2) DB unique constraint on `Payment.transactionId` (already present at `schema.prisma:421`).

### Why both

| Layer | Strength | Weakness | Role |
|-------|----------|----------|------|
| Redis SETNX | Fast (1ms); atomic across replicas; replay-aware (cached response) | Lost on Redis restart (rare; we run replicated Redis in prod) | Fast-fail; replay cached response within 24h |
| DB unique constraint | Immortal; survives Redis loss | DB round-trip on every webhook; race exposure during the unique-constraint check window | Backstop; throws Prisma P2002 on true conflict |

### Implementation

Add `apps/backend/src/infra/cache/redis-lock.service.ts` (NEW):

```typescript
@Injectable()
export class RedisLockService {
  constructor(private readonly redis: CacheService) {}

  /** Atomic acquire. Returns true if caller is first; false if duplicate. */
  async tryAcquire(key: string, ttlSeconds: number, traceId: string): Promise<{ first: boolean; cachedResponse?: unknown }> {
    // SET key traceId NX EX ttlSeconds — atomic single round-trip
    const result = await this.redis.client.set(key, traceId, "EX", ttlSeconds, "NX");
    if (result === "OK") return { first: true };
    const cached = await this.redis.get<unknown>(`${key}:response`);
    return { first: false, cachedResponse: cached ?? undefined };
  }

  async storeResponse(key: string, response: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${key}:response`, response, ttlSeconds);
  }
}
```

`CacheService.client` is currently `private`. The Redis client must be exposed (either as a getter or by adding a `setNx` method to CacheService directly). The cleanest path is to add `setNx(key, value, ttlSeconds): Promise<boolean>` and `getRaw(key): Promise<string | null>` to CacheService, mirroring existing `incrWithTtl` helper.

### Key shape

- Payme: `webhook:payme:{params.id}:{method}` (params.id is Payme's transaction ID — unique per CreateTransaction call)
- Click: `webhook:click:{click_trans_id}:{action}` (action distinguishes prepare vs complete)
- TTL: 24h (Payme docs allow 12h transaction lifetime + buffer for retransmit storm)

### What about Donate?

Phase 3 ships `donate.service.handlePaymentWebhook` with `cache.remember("donate:webhook:{paymentId}", 7*24*3600, fn)`. That pattern is functionally idempotent but uses `remember` semantics (read-then-write, two RTTs, not atomic). Phase 4 should:
- (option A) leave Donate alone — it's working — and use the new RedisLockService only for new subscription payment paths. Migration to atomic SETNX comes in a v2 hardening pass.
- (option B) backport RedisLockService into Donate. Lower churn since donate-test suite already covers this. **Recommendation: option A** — minimal blast radius for Phase 4.

---

## Subscription State Machine (Load-Bearing Decision 3)

**Decision: Application-layer validator + reason-required + audit log. NO DB enum constraint (already enforced by Prisma).**

### State transition matrix

```
       TRIAL ──────────► PENDING ──────► ACTIVE
         │                  │             │
         │                  └────► ACTIVE │
         │                                ▼
         └─────► FROZEN ◄─── (admin) ─── FROZEN
                   │                       │
                   ├──► ACTIVE             ├──► DELETED (admin)
                   └──► DELETED            │
                          │                ▼
                          └──────► (terminal)
```

| From / To | TRIAL | PENDING | ACTIVE | FROZEN | DELETED |
|-----------|-------|---------|--------|--------|---------|
| **TRIAL** | — | ✅ (auto, trial expired) | ✅ (free plan, auto) | ✅ (admin) | ❌ |
| **PENDING** | ❌ | — | ✅ (auto, webhook) | ✅ (admin) | ❌ |
| **ACTIVE** | ❌ | ✅ (auto, renewal) | — | ✅ (admin) | ✅ (admin) |
| **FROZEN** | ❌ | ❌ | ✅ (admin) | — | ✅ (admin) |
| **DELETED** | ❌ | ❌ | ❌ | ❌ | — (terminal) |

### Validator implementation (see Pattern 3 above)

### Reason-required

`Subscription.frozenReason String?` — already exists on `Library.frozenReason String?` (`schema.prisma:249`), Subscription does not have one. **Schema migration needed:** add `frozenReason String?` to `Subscription` model.

### Audit

Every transition writes one `AiAuditLog` row (existing model from Phase 0). Fields:
- `scope = "subscription"`, `scopeId = subscriptionId`
- `issueType = "STATE_TRANSITION"`
- `severity = MEDIUM` (ACTIVE↔PENDING auto) or `HIGH` (FROZEN/DELETED)
- `analysis = JSON.stringify({ from, to, by: userId, reason })`
- `recommendation = ""` (or empty)

Inside `prisma.$transaction` so transition + audit are atomic.

### Auto-transition guards (PAY-08 enforcement)

`trialExpiryReminders` cron at `subscription.service.ts:215-268` moves TRIAL → PENDING or TRIAL → ACTIVE (free plan). This is auto, but it does NOT move to FROZEN/DELETED — those remain admin-only. **The validator must permit the auto-transitions** (`by: "SYSTEM"` bypass) and only require admin role for FROZEN/DELETED. Implementation: `assertTransition(from, to, by, reason)` where `by` is `"SYSTEM" | UserRole`. If `by === "SYSTEM"`, allowed set restricted to {TRIAL→PENDING, TRIAL→ACTIVE, PENDING→ACTIVE}. Everything else requires explicit human role.

---

## 12-Hour Timeout Pattern (Load-Bearing Decision 4)

**Decision: Per-payment BullMQ delayed job with deterministic jobId. Single job per Payment.**

### Why not a scheduled scanner

A naive alternative: cron at every minute scanning `WHERE status=PENDING AND createdAt < NOW() - INTERVAL '12 hours'`. Problems:
- 1440 cron firings per day forever
- N+1 scan complexity grows with PENDING table
- 1-minute false-positive window
- Cron overlap risk on slow DB

BullMQ delayed job is purpose-built for this:
- Single insert into Redis sorted set on CreateTransaction
- Atomic dequeue at exact 12h mark
- Self-balancing across BullMQ workers
- Free retry semantics (we set `attempts: 1` because retrying a cancel is destructive)

### Implementation

```typescript
// New queue
// queue.module.ts addition
export const PAYMENT_TIMEOUT_QUEUE = "payment-timeout";

BullModule.registerQueue({
  name: PAYMENT_TIMEOUT_QUEUE,
  defaultJobOptions: {
    attempts: 1,           // Do NOT retry a fired cancel
    removeOnComplete: { count: 200 },
    removeOnFail: false,
  },
})

// On CreateTransaction (inside the prisma $transaction)
await this.timeoutQueue.add(
  "cancel-on-timeout",
  { paymentId: payment.id, provider: "PAYME" },
  {
    jobId: `payment-timeout:${payment.id}`,   // deterministic — idempotent re-add is a no-op
    delay: 12 * 60 * 60 * 1000,
  },
);

// On PerformTransaction or CancelTransaction
await this.timeoutQueue.remove(`payment-timeout:${payment.id}`).catch(() => undefined);

// Processor
@Processor(PAYMENT_TIMEOUT_QUEUE)
class PaymentTimeoutProcessor extends WorkerHost {
  async process(job: Job<{ paymentId: string; provider: string }>) {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: job.data.paymentId } });
      if (!payment || payment.status !== "PENDING") return;  // already terminal
      await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      // Invoice stays PENDING — user can retry with a new transaction
      // Subscription stays TRIAL/PENDING — admin not auto-flipped
      // Audit log row
      await tx.aiAuditLog.create({ data: { scope: "payment", scopeId: payment.id, issueType: "TIMEOUT", severity: "MEDIUM", analysis: JSON.stringify({ provider: job.data.provider, age_hours: 12 }), recommendation: "" } });
    });
  }
}
```

### Edge cases

| Edge case | Behavior |
|-----------|----------|
| Payme calls CancelTransaction explicitly before 12h | `_cancelTransaction` removes the job (idempotent — missing job is fine). |
| Payme calls PerformTransaction at hour 11:59 | `_performTransaction` removes the job; payment is PAID. |
| BullMQ worker is down when 12h hits | Job stays in delayed set; fires when worker reconnects. Late cancel still works (we check `status === "PENDING"` before flipping). |
| User retries payment after timeout fired | New Payment row, new transactionId, new timeout job. Old FAILED Payment stays for audit. |
| Server clock drift | BullMQ uses Redis time, not server time — clock skew on Node host is irrelevant. |
| Replay attack: timeout job is re-fired by a malicious actor enqueueing it | jobId is deterministic; re-add is a no-op. Even if it fires twice, the `status === "PENDING"` guard short-circuits. |

### Reason code on Payme reconciliation

If Payme later calls `CancelTransaction` after our timeout fired, Payme expects us to return state −1 with reason `4`. The existing `_cancelTransaction` returns state `-1` but doesn't set `reason`. Add:
```typescript
return {
  jsonrpc: "2.0", id,
  result: { cancel_time: Date.now(), transaction: payment.id, state: -1, reason: 4 },
};
```
when the cancel came from our timeout (vs Payme-initiated, where reason should reflect actual Payme reason).

---

## Invoice PDF Stack (Load-Bearing Decision 5)

**Decision: Keep Puppeteer-core + add `qrcode` for QR. Do NOT switch to pdfkit.**

### Why Puppeteer wins for invoices

| Aspect | Puppeteer (current) | pdfkit | react-pdf |
|--------|---------------------|--------|-----------|
| HTML/CSS fidelity | ✅ Full Chromium rendering | ❌ Manual draw API | ⚠️ JSX → PDF, decent CSS |
| Existing investment | ✅ PdfService live (`infra/pdf/pdf.service.ts`) | ❌ New | ❌ New + React in backend |
| Cold-start time | ⚠️ 800-1500ms (Chromium boot) | ✅ 50ms | ✅ 80ms |
| Memory per PDF | ⚠️ ~150 MB (Chromium) | ✅ 20 MB | ✅ 30 MB |
| Invoice complexity (tables, branding, bank requisites, QR) | ✅ Native | ⚠️ Manual coords | ✅ JSX components |
| Phase 0 audit already wired | ✅ | ❌ | ❌ |

The "Reuse browser instance" anti-pattern from PITFALLS M6 applies for monthly batch PDF generation (Phase 5/6). For Phase 4 single-invoice generation, the current pattern (launch → page → pdf → close) is acceptable. Document the optimization as a Phase 6 follow-up (bulk reporting).

### QR code generation (PAY-05)

`qrcode@1.5.4` already in `package.json:52` and `@types/qrcode@1.5.6`. **No new dependency.** Slopcheck: `[OK]`.

```typescript
import * as QRCode from "qrcode";

const qrDataUrl = await QRCode.toDataURL(`https://sifat.uz/pay/${invoice.id}`, {
  width: 200,
  margin: 1,
  errorCorrectionLevel: "M",
});
// Embed as <img src="${qrDataUrl}" /> in Puppeteer HTML — DOM accepts data URIs.
```

### Bank requisites — OPEN QUESTION

Current `invoice.service.ts:274-277` hardcodes placeholder requisites:
- Bank: `NBU — O'zbekiston Milliy Banki`
- IBAN: `UZ12 0000 0000 0000 0000 0000 0000`
- MFO: `000000`

**OQ-1 — what are the real bank requisites?** Likely held by the Yoshlar ishlari agentligi finance department. Plan should include a `checkpoint:human-verify` task gating this on operator-provided values + a one-time seed into env vars or a `PlatformConfig` table.

### Bulk PDF generation (Buxgalter "download all PDFs for month")

Out of scope for Phase 4 single-invoice path. Note for Phase 5/6: route through BullMQ `REPORT_QUEUE` with concurrency 2, reuse browser instance, write to MinIO, return signed URL. Document but do not build.

---

## 1C Export Format (Load-Bearing Decision 6)

**Decision: Emit a CSV in the 1C-Bukhgalteriya "outgoing payments" shape, semicolon-delimited, UTF-8 BOM, with 11 standardized columns. Validate against Buxgalter feedback in Open Question OQ-3.**

### Why CSV not XML

1C:Бухгалтерия 8.3 for Uzbekistan supports both CSV import via "External processing" and XML via the `1CClientBankExchange.txt` format ("Клиент-банк"). XML is the canonical bank-statement format; CSV is the practical accounting-tool format that operators use day-to-day. The Buxgalter UI currently exports CSV (mis-labeled as Excel), so CSV is the expected pattern. **Recommend CSV first; XML deferred** to a v2 follow-up if 1C operator pushback.

### Proposed CSV shape (semicolon delimiter, UTF-8 BOM, RFC 4180)

```
Sana;Hujjat№;Tashkilot nomi;Tashkilot STIRi;Hisob raqami;Bank;MFO;Summa;Valyuta;Maqsad;Status
2026-06-15;INV-A8F2C401;Karmana tuman 8-maktab;310123456;20208000400000123456;NBU;00014;3500000;UZS;Subscription SCH_STANDARD 2026;Paid
```

| Column | Source | Note |
|--------|--------|------|
| Sana | `payment.paidAt` ISO date | Required by 1C |
| Hujjat№ | `invoice.id` last 8 chars uppercase | Human-readable doc# |
| Tashkilot nomi | `Library.name` | |
| Tashkilot STIRi | needs `Library.taxId` schema addition or default `"310000000"` | **OQ-4: do libraries have STIR/TIN field?** |
| Hisob raqami | needs `Library.bankAccount` schema addition | **OQ-4** |
| Bank | needs `Library.bankName` schema addition | **OQ-4** |
| MFO | needs `Library.bankMfo` schema addition | **OQ-4** |
| Summa | `payment.amount` Decimal | UZS |
| Valyuta | constant `"UZS"` | |
| Maqsad | `"Subscription ${subscription.planType} ${YYYY-MM-DD..YYYY-MM-DD}"` | |
| Status | `payment.status` | PAID/PENDING |

### Schema additions for full 1C compatibility

**OQ-4 — do libraries have bank info today?** Quick audit: `Library` model (`schema.prisma:234-264`) has `phone`, `address`, `workHours`, `latitude`, `longitude` but no bank fields. Either:
- (a) add `taxId String?`, `bankAccount String?`, `bankName String?`, `bankMfo String?` to Library; populate via Library admin form; default empty in CSV.
- (b) emit only what we have, leave bank columns blank, document for v2.

**Recommendation: (b) for Phase 4 — emit blank columns; flag schema migration as a Phase 5 follow-up.** Avoids scope creep.

### Alternative format — 1CClientBankExchange.txt

If accounting team uses bank statement import (rare for SaaS subscriptions; standard for direct bank-to-bank flows), produce:

```
1CClientBankExchange
ВерсияФормата=1.03
Кодировка=Windows
Отправитель=SIFAT Library Platform
Получатель=
ДатаНачала=2026-06-01
ДатаКонца=2026-06-30
РасчСчет=20208000400000123456

СекцияДокумент=Платежное поручение
Номер=A8F2C401
Дата=2026-06-15
Сумма=3500000.00
ПлательщикСчет=20208000400000654321
ПлательщикИНН=310123456
Плательщик=Karmana tuman 8-maktab
ПолучательСчет=20208000400000123456
ПолучательИНН=310000001
Получатель=SIFAT Library Platform
НазначениеПлатежа=Subscription SCH_STANDARD 2026
КонецДокумента
```

**This is the canonical format if Buxgalter feedback in OQ-3 confirms 1C 8.3 bank-exchange path. Implement after confirmation, not before.**

---

## Library & Dependency Recommendations

### Already installed (verified slopcheck `[OK]`)

| Library | Version | Purpose |
|---------|---------|---------|
| `qrcode` | `1.5.4` `[VERIFIED: npm registry]` — installed at `apps/backend/package.json:52` | QR payment code in invoice PDF (PAY-05) |
| `exceljs` | `4.4.0` `[VERIFIED: npm registry]` — installed at `:43` | Real XLSX export for Buxgalter (RPT-03) |
| `puppeteer-core` | `22.15.0` `[VERIFIED: npm registry]` — installed at `:51` | Invoice PDF (PAY-05 reuse) |
| `bullmq` | `5.8.4` + `@nestjs/bullmq@10.2.3` `[VERIFIED: npm registry]` | 12h timeout delayed job (PAY-04) |
| `ioredis` | `5.4.1` `[VERIFIED: npm registry]` | Redis SETNX in RedisLockService (PAY-01/02) |
| `class-validator` + `class-transformer` | `0.14.1` / `0.5.1` `[VERIFIED: npm registry]` | Webhook DTOs (PAY-01/02 hardening) |
| `crypto` (Node built-in) | — | MD5 (Click), Basic Auth (Payme), `timingSafeEqual` |

### NOT installed and NOT recommended

| Library | Status | Reason |
|---------|--------|--------|
| `paytechuz` | `[SLOP]` (slopcheck — package does not exist on npm) | Hallucination; Python only via PayTechUZ docs |
| `@paytechuz/nestjs-payment` | `[SLOP]` (slopcheck) | Hallucination |
| `payme-merchant-integrator` | `[SUS]` (slopcheck — 44 weekly downloads, last published 2022) | Abandoned, MongoDB-coupled |
| `payme-uz` | `[SUS]` (slopcheck — 32 downloads, no source repo on npm) | Unreviewable |
| `click-uz` | `[SUS]` (slopcheck — 33 downloads, no source repo) | Unreviewable |

**Verdict: zero new npm dependencies needed. Phase 4 is pure hand-rolling on existing infra.**

### Version verification commands

Already executed during research:
```bash
npm view qrcode version          # 1.5.4
npm view exceljs version         # 4.4.0
npm view bullmq version          # 5.78.0 (we use 5.8.4 — older but stable)
npm view paytechuz version       # NOT FOUND (slopcheck confirms)
npm view @paytechuz/nestjs-payment version  # NOT FOUND
npm view payme-merchant-integrator version  # 1.2.13 (2022-08-05)
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `qrcode` | npm | 9+ yrs (1.5.4 latest 2024) | ~13M/week | [github.com/soldair/node-qrcode](https://github.com/soldair/node-qrcode) | `[OK]` | Approved (already installed) |
| `exceljs` | npm | 8+ yrs | ~2.7M/week | [github.com/exceljs/exceljs](https://github.com/exceljs/exceljs) | `[OK]` | Approved (already installed) |
| `puppeteer-core` | npm | 7+ yrs | ~5M/week | [github.com/puppeteer/puppeteer](https://github.com/puppeteer/puppeteer) | `[OK]` | Approved (already installed) |
| `bullmq` | npm | 5+ yrs | ~1.5M/week | [github.com/taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) | `[OK]` | Approved (already installed) |
| `@nestjs/bullmq` | npm | 2+ yrs | ~150k/week | [github.com/nestjs/bull](https://github.com/nestjs/bull) | `[OK]` | Approved (already installed) |
| `paytechuz` | npm | — | — | — | `[SLOP]` | **REMOVED — does not exist on npm** |
| `@paytechuz/nestjs-payment` | npm | — | — | — | `[SLOP]` | **REMOVED — does not exist on npm** |
| `payme-merchant-integrator` | npm | 4 yrs (1.2.13) | 44/week | yusufjonnazarov/… (low signal) | `[SUS]` | **REJECTED — would require checkpoint, but hand-roll is strictly better** |
| `payme-uz` | npm | 4 yrs (1.1.2) | 32/week | none on npm metadata | `[SUS]` | **REJECTED — same as above** |
| `click-uz` | npm | 4 yrs (1.1.2) | 33/week | none on npm metadata | `[SUS]` | **REJECTED — same as above** |

**Packages removed due to slopcheck [SLOP] verdict:** `paytechuz`, `@paytechuz/nestjs-payment`
**Packages flagged as suspicious [SUS] and rejected outright:** `payme-merchant-integrator`, `payme-uz`, `click-uz` — hand-rolling on existing tested `payme.service.ts` is strictly safer.
**No new packages will be installed for Phase 4.** Plan should NOT include any `npm install ...` task.

---

## Phase 1 + 2 + 3 Carry-overs Respected

| Phase | Carry-over | Phase 4 usage |
|-------|-----------|---------------|
| 1 | `JwtAuthGuard` global default-deny + `@Public()` allowlist | Payme/Click webhook endpoints already `@Public()`. Buxgalter admin endpoints add `@Roles(SUPER_ADMIN, BUXGALTER)`. |
| 1 | HttpOnly cookie auth (refresh) + `credentials: include` | Buxgalter UI MUST migrate — currently broken via localStorage. |
| 1 | Vault prod fail-hard | PAYME_SECRET_KEY, PAYME_TEST_KEY, CLICK_SECRET_KEY, PAYME_LOGIN, CLICK_MERCHANT_ID, CLICK_SERVICE_ID must be Vault-backed in prod. Add to `_assertEnvVars` in main.ts. |
| 1 | BullMQ + Redis live, REPORT_QUEUE + NOTIFICATION_QUEUE active | Add PAYMENT_TIMEOUT_QUEUE alongside. Refactor PAY-07 reminders to use NOTIFICATION_QUEUE. |
| 1 | Kafka consumer wired (graceful no-op when KAFKA_BROKERS unset) | Add `KAFKA_TOPICS.PAYMENT_COMPLETED` and `SUBSCRIPTION_ACTIVATED`. Emit from inside `$transaction`. Phase 7 may consume. |
| 1 | `Asia/Tashkent` Docker timezone | Cron schedules for reminders run in local time as expected. |
| 2 | `PrismaReplicaService` (DATABASE_REPLICA_URL fallback) | Route Buxgalter aggregations (getPaymentStats, getStats) through replica. |
| 2 | Interactive `$transaction(async tx => ...)` pattern (4 sites in `transactions.service.ts`) | Apply identical pattern to `_performTransaction`, `complete()`, subscription `updateStatus`. |
| 2 | exceljs already in package.json (Plan 02-01) | Use for real XLSX export instead of CSV (RPT-03). |
| 2 | `AiAuditLog` model present | Write transition rows for every Subscription status change. |
| 3 | `IpWhitelistGuard` + `@IpWhitelist(envKey)` (Reflector-driven) | Reuse on Payme + Click webhook routes. Permissive in dev (warns once). |
| 3 | `cache.remember` for donate webhook idempotency | Keep Donate's pattern; do NOT regress. Subscription payments use new RedisLockService (atomic SETNX) for cleaner semantics. |
| 3 | `_verifyPaymeSignature` / `_verifyClickSignature` placeholder stubs in `donate.service.ts:87-104` | Phase 4 EXTENDs these into real verifiers in `payme.service.ts` (Basic Auth, already correct) and `click.service.ts` (signature formula, currently WRONG — fix in Wave 0). Pull the real verifiers into `donate.service.ts` too. |
| 3 | `_assertDonationStubGuard` in main.ts | No change — the donation stub is orthogonal to subscription payments. |
| 3 | `KAFKA_TOPICS.BADGE_EARNED`, `TOP100_CONFIRMED` constants | Pattern: add `PAYMENT_COMPLETED`, `SUBSCRIPTION_ACTIVATED` the same way. |

---

## Build Order (Waves)

### Wave 0 — Cross-cutting primitives + bug fixes (~1-1.5 days)

Goal: ground every later wave in working primitives. No business logic yet.

1. **RedisLockService** (NEW) — `apps/backend/src/infra/cache/redis-lock.service.ts`; CacheService gets `setNx(key, value, ttl): Promise<boolean>` + `getRaw(key)`; unit tests verify SETNX atomicity, response cache, dual-call no-op.
2. **Click HMAC formula fix** (FIX) — `click.service.ts:160-173` `_makeSign` rewritten to include `service_id` in the correct position. Existing `click.service.spec.ts` (303 LOC) updated against the new shape. **Failing test guides the rewrite — RED first.**
3. **Buxgalter UI cookie auth migration** (FIX) — `apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx` — remove `authHeaders()`, use `credentials: "include"` in all fetches. No backend change needed (Phase 1 cookie auth already supports the path).
4. **Vault env additions** (EXTEND) — main.ts `_assertEnvVars`: add `PAYME_SECRET_KEY`, `PAYME_TEST_KEY`, `PAYME_LOGIN`, `CLICK_SECRET_KEY`, `CLICK_MERCHANT_ID`, `CLICK_SERVICE_ID` to the production assertion set. Vault rotation pattern documented (out of scope to build).
5. **PAYMENT_TIMEOUT_QUEUE registration** (NEW) — `queue.module.ts` adds the queue + default options; no processor yet (Wave 1 attaches it).
6. **KAFKA_TOPICS additions** (NEW) — `kafka.service.ts:11-25` adds `PAYMENT_COMPLETED: "payment.completed"`, `SUBSCRIPTION_ACTIVATED: "subscription.activated"`. No emit code yet.

### Wave 1 — PAY-01 to PAY-04 (~2-3 days)

Goal: webhook security + atomicity + 12h timeout.

1. **Webhook DTOs** (PAY-01, PAY-02) — typed `CheckPerformTransactionParamsDto`, `CreateTransactionParamsDto`, … with class-validator. Apply `ValidationPipe` on the controller routes.
2. **PaymentController IpWhitelistGuard wiring** (PAY-01, PAY-02) — `@UseGuards(IpWhitelistGuard) @IpWhitelist("PAYME_IP_WHITELIST")` on `paymeWebhook`; `@IpWhitelist("CLICK_IP_WHITELIST")` on `clickPrepare` and `clickComplete`.
3. **RedisLockService wiring** (PAY-01, PAY-02) — Payme handler wraps `_dispatch` in `RedisLockService.tryAcquire("webhook:payme:{txId}:{method}", 86400)`; replays cached response on duplicate. Same for Click prepare + complete with key `webhook:click:{click_trans_id}:{action}`.
4. **Atomic transitions** (PAY-03) — `_performTransaction` and `complete()` wrapped in `prisma.$transaction(async tx => ...)`. Pass `tx` to nested handlers. Write `AiAuditLog` inside the transaction.
5. **PaymentTimeoutProcessor** (PAY-04) — implements the delayed-cancel pattern from §12-Hour Timeout above. `_createTransaction` enqueues; `_performTransaction` and `_cancelTransaction` remove.
6. **CancelTransaction reason code mapping** (PAY-04) — return reason `4` when the cancel came from our timeout vs caller-supplied.
7. **Tests** — extend `payme.service.spec.ts` and `click.service.spec.ts` (already 567 + 303 LOC) for new DTOs, idempotency duplicates, transaction rollback on partial failure, timeout job add/remove.

### Wave 2 — PAY-05, PAY-06, PAY-08 (~1.5-2 days)

Goal: invoice PDF + state machine.

1. **QR code in invoice PDF** (PAY-05) — `invoice.service.ts:171-292` — generate `qrDataUrl` for `https://sifat.uz/pay/{id}` via `qrcode.toDataURL()`; inject `<img src="${qrDataUrl}" />` into the HTML body. Test asserts data-URL is present.
2. **Real bank requisites** (PAY-05) — accept hardcoded placeholders for V1; add a TODO + checkpoint:human-verify for OQ-1 — operator confirmation of bank info. Plan does NOT include schema additions yet.
3. **Subscription state machine** (PAY-06, PAY-08) — `subscription.service.ts` adds `assertTransition(from, to, by, reason)` validator + ALLOWED_TRANSITIONS map. `updateStatus(id, status, reason, actorId)` calls the validator inside a `$transaction` and writes AiAuditLog.
4. **Schema migration: `Subscription.frozenReason String?`** (PAY-08) — Prisma migration `add_subscription_frozen_reason`. Existing rows default null.
5. **Controller role guard** (PAY-08) — `payment.controller.ts:170-178` `PATCH /subscriptions/:id/status` adds `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)`. Body shape: `{ status: SubscriptionStatus; reason?: string }`.
6. **Tests** — `subscription.service.spec.ts` (194 LOC) extended for state machine: all 25 transition cells in the matrix table verified; FROZEN/DELETED rejected without reason; non-admin call rejected.

### Wave 3 — PAY-07, RPT-03 (~1.5-2 days)

Goal: reminders via queue + Buxgalter financials.

1. **Reminder cron refactor** (PAY-07) — `sendPaymentReminders` injects `@InjectQueue(NOTIFICATION_QUEUE) private notifQueue`; replaces direct `sms.sendNotification` with `notifQueue.add("payment-reminder", {type:"sms", phone, message})`. Cron loop no longer blocks on SMS provider.
2. **Real XLSX export** (RPT-03) — replace `invoice.service.ts:296-330` CSV with `exceljs` workbook: columns matching current CSV plus formatted dates, currency. Endpoint: `GET /invoices/export/xlsx?from=&to=`. Old `GET /invoices/export/csv` retained for backward compat (Buxgalter UI button updates to call xlsx).
3. **1C CSV export endpoint** (RPT-03) — `GET /invoices/export/1c?from=&to=` — emits semicolon-delimited UTF-8 BOM CSV per §1C Export Format. Bank columns blank pending Library schema additions (OQ-4 deferred). Buxgalter UI gets a separate "1C" button.
4. **Replica routing for aggregations** (RPT-03) — `invoice.service.ts:91-167` `getPaymentStats` and `subscription.service.ts:136-160` `getStats` accept `PrismaReplicaService`; heavy aggregations route to replica. `monthlyTrend` for-loop replaced with one `groupBy({ by: ["paidAt_year_month"] })` query using a raw `date_trunc('month', "paidAt")` expression.
5. **Redis cache for Buxgalter aggregations** (RPT-03) — wrap `getPaymentStats` in `cache.remember("stats:buxgalter:{from}:{to}", 300, ...)`. Invalidate via `delPattern("stats:buxgalter:*")` from inside the payment webhook transaction success path.
6. **Buxgalter UI 1C button + xlsx button** (RPT-03) — `buxgalter/page.tsx` updates the "📥 CSV / 1C" button to dropdown: "Excel (.xlsx)" / "CSV (oddiy)" / "1C eksport".
7. **Tests** — `invoice.service.spec.ts` (331 LOC) extended for xlsx + 1C; `subscription.service.spec.ts` extended for replica routing; frontend smoke test for cookie auth in Buxgalter UI.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 29 + ts-jest (`apps/backend/jest.config.ts`) |
| Config file | `apps/backend/jest.config.ts` |
| Quick run command | `cd apps/backend && npx jest <path> --bail --forceExit` |
| Full suite command | `cd apps/backend && npm test` |
| Estimated runtime | ~100 seconds (Phase 3 baseline: 867 tests; Phase 4 adds ~45 → ~912 total) |
| Coverage gate | 80% lines |
| Notable | `payment/__tests__/` already covers Payme (567 LOC), Click (303 LOC), Invoice (331 LOC), Subscription (194 LOC). All four spec files EXIST and pass today. Phase 4 EXTENDS in-place; ~no Wave 0 spec-creation gap. |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| PAY-01 | Payme webhook: typed DTOs, IpWhitelist, SETNX idempotency, dispatcher correctness | unit | `pytest`-equivalent: `npx jest src/modules/payment/__tests__/payme.service.spec.ts -t "idempot" --bail` | ✅ extend existing (567 LOC) |
| PAY-01 | RedisLockService SETNX atomicity + response cache | unit | `npx jest src/infra/cache/__tests__/redis-lock.service.spec.ts --bail` | ❌ Wave 0 (new file) |
| PAY-02 | Click signature formula (NEW correct order) + idempotency | unit | `npx jest src/modules/payment/__tests__/click.service.spec.ts -t "sign\|idempot" --bail` | ✅ extend existing (303 LOC) — RED first against new formula |
| PAY-03 | Atomic `$transaction` rollback on partial failure | unit | `npx jest src/modules/payment/__tests__/payme.service.spec.ts -t "atomic\|rollback" --bail` | ✅ extend |
| PAY-04 | 12h timeout: add job on CreateTransaction, remove on Perform/Cancel, fire on timeout flips to FAILED | unit | `npx jest src/modules/payment/__tests__/payment-timeout.processor.spec.ts --bail` | ❌ Wave 1 (new file) |
| PAY-05 | Invoice PDF contains QR data URL | unit | `npx jest src/modules/payment/__tests__/invoice.service.spec.ts -t "qr" --bail` | ✅ extend existing (331 LOC) |
| PAY-06 | State machine: all 25 cells (5x5 matrix) verified | unit | `npx jest src/modules/payment/__tests__/subscription.service.spec.ts -t "transition" --bail` | ✅ extend existing (194 LOC) |
| PAY-07 | Reminders enqueue via NOTIFICATION_QUEUE not direct sms | unit | `npx jest src/modules/payment/__tests__/subscription.service.spec.ts -t "remind" --bail` | ✅ extend |
| PAY-08 | FROZEN/DELETED require role + reason; system bypass for auto-transitions only | unit | `npx jest src/modules/payment/__tests__/subscription.service.spec.ts -t "freeze\|admin" --bail` | ✅ extend |
| RPT-03 | XLSX export contains real workbook structure (exceljs roundtrip) + 1C CSV format | unit | `npx jest src/modules/payment/__tests__/invoice.service.spec.ts -t "xlsx\|1c" --bail` | ✅ extend |

### Sampling Rate
- **Per task commit:** `npx jest <touched-spec> --bail --forceExit`
- **Per wave merge:** `cd apps/backend && npm test`
- **Phase gate:** Full suite green; manual webhook smoke (Payme + Click sandbox); 12h timeout dry-run with fake timers; Buxgalter UI cookie-auth visible-load check; xlsx download validates in Excel; PDF QR scannable.

### Wave 0 Gaps
- [ ] `apps/backend/src/infra/cache/redis-lock.service.ts` + spec (PAY-01/02 atomic SETNX)
- [ ] `apps/backend/src/infra/cache/cache.service.ts` adds `setNx(key, value, ttl)` + `getRaw(key)` methods + spec extension
- [ ] `apps/backend/src/modules/payment/dto/*.ts` (typed webhook DTOs — likely 6 files: `payme-check-perform.dto.ts`, `payme-create-transaction.dto.ts`, `payme-perform.dto.ts`, `payme-cancel.dto.ts`, `payme-check.dto.ts`, `click-prepare.dto.ts`, `click-complete.dto.ts`)
- [ ] `apps/backend/src/infra/queue/payment-timeout.processor.ts` + spec (Wave 1, depends on Wave 0 queue registration)
- [ ] Click HMAC formula fix in `click.service.ts:160-173` — RED test against new formula goes first
- [ ] Buxgalter UI cookie auth migration (frontend; smoke test in dev)

---

## Risks & Gotchas

### R1 — Click HMAC formula is wrong in production code right now
**Severity:** Critical (blocks PAY-02 even with idempotency).
**Detection:** Any real Click callback → signature mismatch → −1 returned. Sandbox tests will pass because they use the same wrong formula on both sides.
**Mitigation:** Wave 0 fix is the first thing planner schedules. Fix backed by RED unit test against expected MD5 derived from official `md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)` formula.

### R2 — Signature replay attack
**Severity:** High.
**Vector:** Attacker captures one valid Click webhook (e.g., man-in-the-middle on the merchant network) and replays it months later.
**Mitigation:** Redis SETNX with 24h TTL prevents intra-day replay. Beyond 24h, DB unique constraint on `Payment.transactionId` blocks duplicates. Additionally: `sign_time` is a unix timestamp; reject if `Math.abs(now - sign_time) > 5*60` (5 min skew window). **Add this check explicitly.**

### R3 — Double-charging via duplicate provider POSTs
**Severity:** High.
**Vector:** Payme network blip causes provider to retransmit `PerformTransaction`. Without idempotency the second call re-runs `payment.update + invoice.update + subscription.update`, which is mostly safe via PK lookups but writes duplicate audit log rows.
**Mitigation:** Redis SETNX gate; cached response returned identically for replay. AiAuditLog rows checked for `idempotent_replay = true` flag.

### R4 — Race condition on state transitions
**Severity:** Medium.
**Vector:** Two webhooks (Payme `PerformTransaction` + Click `Complete`) for the same invoice arrive within 100ms. Without `$transaction`, second one races on `Subscription.update`.
**Mitigation:** Interactive `$transaction(async tx => ...)` serializes via row-lock on the Subscription FK. Both sides increment `updatedAt`; if both succeed, the resulting state is idempotent.

### R5 — 12h timeout fires after legitimate late confirm
**Severity:** Medium.
**Vector:** User starts payment, Payme delays confirm webhook to 12h+1m (Payme infrastructure incident).
**Mitigation:** Processor double-checks `status === "PENDING"` before flipping to FAILED. If a late `PerformTransaction` arrives after our timeout fired, the existing `_performTransaction` re-checks transactionId and returns the PAID state from current `payment.status` — but our timeout already set FAILED. Bug: late perform would silently fail. **Fix:** in PaymentTimeoutProcessor handler, additionally check Payme's `CheckTransaction` (RPC outbound call) for actual state before flipping. If Payme says state=2 (paid), flip our row to PAID instead of FAILED.

### R6 — Buxgalter UI cookie auth migration breaks token-based tests
**Severity:** Low.
**Vector:** Any frontend test mocking `localStorage.token` no longer represents production behavior.
**Mitigation:** Update test mocks to use cookie-set Mock Service Worker (msw) pattern, or document as "manual smoke" if mocking is heavy.

### R7 — Payme login string for production unknown today
**Severity:** Low (operator-resolvable).
**Vector:** Current `_verifyAuth` accepts `"Paycom"` (test) OR anything else (treated as production with `secretKey`). Production Payme convention: each merchant gets a specific login string.
**Mitigation:** Add `PAYME_LOGIN` env, allowlist `[PAYME_LOGIN, "Paycom"]` in `_verifyAuth`, fail-hard if PAYME_LOGIN unset in production.

### R8 — Click `service_id` not validated against config
**Severity:** Low.
**Vector:** Click sends a `service_id` we don't recognize (e.g., test vs prod confusion). Currently `_makeSign` accepts it and recomputes hash; no business-logic check.
**Mitigation:** Verify `body.service_id === CLICK_SERVICE_ID` from env before computing signature. Reject with error `-1` (SIGN_CHECK_FAILED) if mismatch.

### R9 — Subscription auto-transition writes audit row as "SYSTEM" — could be spoofed
**Severity:** Low.
**Vector:** Theoretically an attacker with DB write access could fake a SYSTEM transition. But DB write access already means full compromise.
**Mitigation:** Audit log is append-only at the application level. PERF-05 (Phase 7) will enforce DB-level append-only via PostgreSQL trigger.

### R10 — Trial subscription with FREE plan auto-activates with no payment
**Severity:** Low (intended behavior).
**Vector:** Per `subscription.service.ts:250-257`, free plans (GOV, MAH) skip invoice creation entirely. The state machine validator must permit `TRIAL → ACTIVE` for `by: "SYSTEM"` when planType is GOV/MAH.
**Mitigation:** Encode in transition validator: `planType ∈ {GOV, MAH} → TRIAL → ACTIVE` allowed as SYSTEM auto-transition. Verified in state machine spec.

### R11 — exceljs bundle size + worker thread requirements
**Severity:** Low.
**Vector:** exceljs is ~700KB unzipped; small but synchronous workbook generation can block event loop for large exports.
**Mitigation:** For Buxgalter typical ranges (1 month, <5k payments) synchronous is fine. For full-year (>50k payments) route through BullMQ REPORT_QUEUE. Document as Phase 6 optimization.

### R12 — QR code URL points to a route that doesn't exist yet
**Severity:** Low.
**Vector:** `https://sifat.uz/pay/${invoice.id}` — no such page in `apps/frontend/app/` today.
**Mitigation:** Phase 4 task list includes building `/pay/[id]/page.tsx` that loads invoice → renders Payme + Click + bank-transfer choice. Simple page.

---

## Runtime State Inventory

Phase 4 is greenfield financial infrastructure (no rename / refactor / migration). The closest pre-existing state-touch is **Subscription/Invoice/Payment data** seeded during Phase 0 / Phase 3 tests:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | (a) `Subscription` rows from `prisma/seed.ts` test data — likely 0 or seeded library examples; (b) Phase 3 `Donate` rows are orthogonal | None — Phase 4 reads/writes new rows; existing rows continue to work post state-machine change because validator permits all current valid states. **Verify:** seeded subscriptions are in {TRIAL, ACTIVE} states only — confirm via `prisma/seed.ts` audit. |
| Live service config | None — Payme/Click test sandbox configurations live in `.env` only, not in any external dashboard | None. New env vars (PAYME_LOGIN, CLICK_SERVICE_ID) operator-supplied. |
| OS-registered state | None (no Task Scheduler, no systemd, no Windows services) | None. |
| Secrets / env vars | (a) `.env.example` may not list PAYME_LOGIN, CLICK_SERVICE_ID — confirm; (b) Vault prod path requires update | Update `.env.example` + Vault paths. |
| Build artifacts | None (no compiled binaries depend on payment paths) | None. |

**Verified by:** code audit of `subscription.service.ts:11-20` PLAN_PRICES constants (no implicit state); `seed.ts` not specifically reviewed but no Phase 3 SUMMARY mentions subscription seeding.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis | RedisLockService (PAY-01/02), BullMQ delayed jobs (PAY-04), Buxgalter cache (RPT-03) | ✓ (Phase 1 INFRA-01) | ioredis 5.4.1 | None — required |
| PostgreSQL | Payment / Invoice / Subscription persistence | ✓ (Phase 1) | Prisma 5.14, PG 15 | None — required |
| PostgreSQL read replica | Buxgalter aggregations (RPT-03) | ✓ in prod (Phase 1 INFRA-10), gracefully falls back to primary in dev | DATABASE_REPLICA_URL | Primary DB (graceful) |
| BullMQ | Reminder queue (PAY-07), Payment timeout (PAY-04) | ✓ (Phase 1 + Plan 02-03) | bullmq 5.8.4 + @nestjs/bullmq 10.2.3 | None — required |
| Eskiz SMS | PAY-07 reminder delivery | ⚠️ code-complete, live delivery PENDING ESKIZ_EMAIL/PASSWORD/FROM | EskizSmsClient + DEV_OTP_BYPASS dev path | Dev: NotificationProcessor logs silently; Prod: must have creds before reminders go live |
| Puppeteer / Chromium | Invoice PDF (PAY-05) | ✓ (PdfService live) | puppeteer-core 22.15.0 + @sparticuz/chromium 130.0.0 | None — required, but PDF feature is optional path |
| qrcode npm | Invoice QR code (PAY-05) | ✓ installed | qrcode 1.5.4 | None — required |
| exceljs npm | XLSX export (RPT-03) | ✓ installed | exceljs 4.4.0 | None — required |
| Vault | Production secrets (PAYME/CLICK keys) | ✓ (Phase 1 INFRA-04 fail-hard) | node-vault 0.12 | Dev: `.env` (gated on NODE_ENV) |
| Kafka brokers | PAYMENT_COMPLETED / SUBSCRIPTION_ACTIVATED emit | ⚠️ optional (graceful no-op when KAFKA_BROKERS unset) | kafkajs 2.2.4 | No consumer in Phase 4 anyway |
| Payme merchant sandbox | Live Payme integration test | ❌ credentials PENDING operator | — | DEV_DONATION_PAYMENT_STUB pattern can be adapted for subscription stub in dev |
| Click merchant sandbox | Live Click integration test | ❌ credentials PENDING operator | — | Same as above |

**Missing dependencies with no fallback:** none for Phase 4 code paths.
**Missing dependencies with fallback:** Eskiz live (dev no-op + DEV_OTP_BYPASS), Payme/Click live sandbox (recommend `DEV_SUBSCRIPTION_PAYMENT_STUB` flag analogous to Phase 3's `DEV_DONATION_PAYMENT_STUB` — fail-hard in production, allow stub-success page in dev).

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Basic Auth (Payme), MD5 HMAC (Click), timingSafeEqual for both |
| V3 Session Management | yes (Buxgalter UI) | HttpOnly cookie (Phase 1) — fix UI to use it |
| V4 Access Control | yes | RolesGuard on PATCH /subscriptions/:id/status (SUPER_ADMIN, BUXGALTER); BUXGALTER on Buxgalter endpoints |
| V5 Input Validation | yes | class-validator DTOs for all webhook bodies; Zod (already in deps) for query strings |
| V6 Cryptography | yes | MD5 only for Click signature (mandated by their API — NOT for hashing internal data); crypto.timingSafeEqual for Basic Auth; never use crypto.createHash without explicit purpose |
| V8 Data Protection | yes | Payment.amount Decimal precision preserved; Invoice PDF stored ephemerally (not persisted); cookies HttpOnly + secure-in-prod |
| V9 Communication | yes | TLS 1.3 (existing infra); Payme/Click callbacks over HTTPS only |
| V11 Business Logic | yes | State machine validator prevents skip-frozen path; reason required for FROZEN/DELETED; 12h timeout enforced |
| V14 Configuration | yes | Vault for secrets; .env in dev only; fail-hard prod assertion |

### Known Threat Patterns for NestJS Payment Webhooks

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Webhook signature forgery | Spoofing | timingSafeEqual on Basic Auth (Payme), MD5 compare on Click; constant-time comparison |
| Webhook replay (intra-day) | Tampering | Redis SETNX 24h |
| Webhook replay (cross-day) | Tampering | DB unique constraint on transactionId |
| Webhook replay (with stale sign_time) | Tampering | 5-min skew window check on sign_time |
| Webhook IP spoofing | Spoofing | IpWhitelistGuard with x-forwarded-for first-hop |
| State machine bypass (skip FROZEN) | Tampering | ALLOWED_TRANSITIONS application validator |
| Mass invoice creation via stolen Buxgalter cookie | Elevation | Refresh token rotation (Phase 1), short access token TTL (15min), cookie sameSite=lax |
| Double-spending via Payme + Click for same invoice | Tampering | Invoice has single subscription FK; subscription.update inside `$transaction` row-locks the row; either Payme or Click sees the locked row first |
| Operator (insider) freezes competitor library | Elevation, Repudiation | AiAuditLog append-only with actor + reason; 2-year retention |
| Bulk PDF generation DOS | Denial | Queue PDF generation via BullMQ REPORT_QUEUE concurrency 2 (Phase 6, document only) |

---

## Open Questions

### OQ-1 — Real bank requisites for SIFAT Library / Yoshlar ishlari agentligi
- **What we know:** `invoice.service.ts:274-277` uses placeholder NBU IBAN. Real values held by operator finance team.
- **What's unclear:** Specific IBAN, MFO, full bank name, and whether requisites differ for each region/branch.
- **Recommendation:** Plan includes a `checkpoint:human-verify` task before Wave 2 PDF generation lands in production. Plan task is "ask operator for bank info; populate via env (BANK_NAME, BANK_IBAN, BANK_MFO) or a one-row PlatformConfig table". Dev seed retains placeholders. **Severity:** Low — PDF renders fine; just wrong content until confirmed.

### OQ-2 — Payme callback IP whitelist
- **What we know:** Payme does not publicly publish callback IP ranges. Operator must request from Payme integration team.
- **What's unclear:** Whether Payme even uses static IPs or rotates via load balancer.
- **Recommendation:** IpWhitelistGuard wired permissive-by-default (Phase 3 pattern); leave `PAYME_IP_WHITELIST` env unset until operator obtains list. Document this in the operator runbook. Production fallback: do NOT enforce IP whitelist if list not provided; rely on Basic Auth + sign_time skew window + SETNX idempotency as the security perimeter.

### OQ-3 — 1C export format (CSV columns + delimiter)
- **What we know:** 1C:Бухгалтерия 8.3 for Uzbekistan supports CSV import via "Внешняя обработка"; bank statement format `1CClientBankExchange.txt` is the canonical bank-side format. Buxgalter UI shows a single "CSV / 1C" button.
- **What's unclear:** Whether Buxgalter actually imports into 1C or uses Excel as the bridge. The semicolon-delimited 11-column shape proposed in this RESEARCH is a reasonable default but unverified.
- **Recommendation:** Plan task: prompt operator (Buxgalter) for a sample 1C-accepted CSV before Wave 3. If `1CClientBankExchange.txt` is required, Phase 4 ships CSV first; XML format becomes a Phase 5 task. Document fallback as "operator opens xlsx in Excel and manually pastes into 1C" — works without changes.

### OQ-4 — Library bank info schema
- **What we know:** `Library` model has no `taxId`, `bankAccount`, `bankName`, `bankMfo`. 1C export will leave these columns blank.
- **What's unclear:** Whether libraries provide this info at registration (typical for paid SaaS) or only at first invoice (typical for grant-funded institutions).
- **Recommendation:** Phase 4 ships with blank columns in 1C CSV. Add `Library.taxId String?`, `bankAccount String?`, `bankName String?`, `bankMfo String?` as a Phase 5 schema migration once operator confirms requirement. No blocker for Phase 4 close.

### OQ-5 — Payme production login string
- **What we know:** Sandbox uses `Paycom`. Production login is merchant-specific, provided by Payme on activation.
- **What's unclear:** The exact string for SIFAT Library's production merchant.
- **Recommendation:** Add `PAYME_LOGIN` env; default empty; `_verifyAuth` accepts `[PAYME_LOGIN, "Paycom"]` with appropriate secret. Production deploy waits for operator to populate.

### OQ-6 — Should subscription payments support a dev stub (analogous to DEV_DONATION_PAYMENT_STUB)?
- **What we know:** Phase 3 ships `DEV_DONATION_PAYMENT_STUB` for dev/test bypass with prod fail-hard guard. The same pattern would make Phase 4 testable without live Payme/Click sandbox credentials.
- **What's unclear:** Whether operator wants this flag (it's purely for dev velocity).
- **Recommendation:** Add `DEV_SUBSCRIPTION_PAYMENT_STUB` flag with identical NODE_ENV allowlist semantics + boot-time fail-hard. Lets developers POST /subscriptions/:id/renew → stub success page (creates PAID Payment + ACTIVE Subscription synthetically) when flag is set. Production-safe.

### OQ-7 — Hardcoded plan prices vs database-driven
- **What we know:** `subscription.service.ts:11-20` hardcodes 8 plan prices.
- **What's unclear:** Whether operator wants per-region pricing, discounts, or runtime price updates.
- **Recommendation:** Out of scope for Phase 4. Document as Phase 5+ enhancement (`PlanPrice` model with effective-dated rows).

---

## Assumptions Log

> Claims tagged `[ASSUMED]` need user/operator confirmation before becoming locked decisions.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The semicolon-delimited 11-column CSV proposal for 1C export is acceptable to Buxgalter `[ASSUMED]` | §1C Export Format | Medium — Buxgalter rejects file; operator must re-export via Excel manually. Phase 4 CSV button still works for Excel. |
| A2 | Payme callback IP whitelist will be obtained by operator post-launch `[ASSUMED]` | OQ-2, R-IpWhitelist | Low — fallback to no-IP-whitelist + Basic Auth is acceptable per Phase 3 permissive default. |
| A3 | Click sandbox testing uses `service_id` from operator-provided env `[ASSUMED]` | OQ-5 | Low — invalid service_id rejected at sign verification step. |
| A4 | Subscription seed data lives only in {TRIAL, ACTIVE} states `[ASSUMED — to verify against prisma/seed.ts]` | §Runtime State Inventory | Low — if FROZEN exists, the new validator must permit it as an initial state (not a transition target). Mitigation: allow any state as `from` initial. |
| A5 | Hardcoded bank requisites are tolerable in dev/staging PDFs `[ASSUMED]` | OQ-1 | Low — only matters at production cutover. |
| A6 | Phase 3 Donate's `cache.remember` idempotency pattern does NOT need migration to SETNX in Phase 4 `[ASSUMED — minimal-blast-radius pick]` | §Idempotency, §Phase 3 Carry-overs | Low — donate-test suite covers current pattern; bug surface is small. |
| A7 | Buxgalter accepts XLSX as primary export and CSV/1C as secondary `[ASSUMED]` | RPT-03 Wave 3 | Low — UI offers all three. |
| A8 | Plan price changes for v1 happen via code edits + redeploy, not runtime config `[ASSUMED]` | OQ-7 | Low — operator-managed; Phase 5 can add. |
| A9 | `DEV_SUBSCRIPTION_PAYMENT_STUB` flag is desired for development velocity `[ASSUMED]` | OQ-6 | Low — if rejected, dev relies on live sandbox credentials only. |
| A10 | exceljs synchronous workbook generation is acceptable for typical 1-month / <5k row Buxgalter exports `[ASSUMED]` | R11 | Low — verified by Phase 2 pattern (Excel book import via exceljs already in use). |

---

## Sources

### Primary (HIGH confidence)
- **Payme Merchant API official docs** (verified 2026-06-07):
  - [CheckPerformTransaction](https://developer.help.paycom.uz/metody-merchant-api/checktransaction/)
  - [CreateTransaction](https://developer.help.paycom.uz/metody-merchant-api/createtransaction/) — confirms 12h auto-cancel + state −1 + reason code 4
  - [PerformTransaction](https://developer.help.paycom.uz/metody-merchant-api/performtransaction/)
  - [CancelTransaction](https://developer.help.paycom.uz/metody-merchant-api/canceltransaction/)
- **Click Merchant API official docs** (verified 2026-06-07):
  - [Click-API Request (Prepare/Complete sign_string formula)](https://docs.click.uz/en/click-api-request/) — confirms `md5(click_trans_id + service_id + SECRET_KEY + ...)` formula
- **PayTechUZ docs** [docs.pay-tech.uz](https://docs.pay-tech.uz/) — confirms Django/FastAPI only, no NestJS port
- **Codebase audit:**
  - `apps/backend/src/modules/payment/payme.service.ts` (280 LOC)
  - `apps/backend/src/modules/payment/click.service.ts` (203 LOC, signature bug at lines 160-173)
  - `apps/backend/src/modules/payment/invoice.service.ts` (332 LOC)
  - `apps/backend/src/modules/payment/subscription.service.ts` (270 LOC)
  - `apps/backend/src/modules/donate/donate.service.ts` (351 LOC)
  - `apps/backend/src/common/guards/ip-whitelist.guard.ts` (116 LOC)
  - `apps/backend/src/common/utils/donation-stub-guard.util.ts` (46 LOC)
  - `apps/backend/src/infra/cache/cache.service.ts` (108 LOC)
  - `apps/backend/src/infra/queue/queue.module.ts` (72 LOC)
  - `apps/backend/src/infra/pdf/pdf.service.ts` (132 LOC)
  - `apps/backend/prisma/schema.prisma:81-101` (enums), `:234-264` (Library), `:386-484` (Subscription/Invoice/Payment/Donate)
  - `apps/frontend/app/[locale]/dashboard/buxgalter/page.tsx` (586 LOC)
- **slopcheck verification 2026-06-07:**
  - `[SLOP]` `paytechuz`, `@paytechuz/nestjs-payment` (hallucinated; do not exist on npm)
  - `[SUS]` `payme-uz`, `click-uz`, `payme-merchant-integrator` (low downloads, abandoned)
  - `[OK]` `qrcode`, `exceljs`, `puppeteer-core`, `bullmq`, `@nestjs/bullmq`

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` §2 Payment Integration Architecture
- `.planning/research/PITFALLS.md` H1 (Payme untyped DTOs), H8 (12h timeout), R3 (signature replay)
- `.planning/research/STACK.md` (existing stack already covers needs)
- `.planning/phases/03-rankings-gamification-donations/` SUMMARY files (Phase 3 carry-overs)
- `.planning/phases/01-infrastructure-hardening-authentication/01-VERIFICATION.md` (Phase 1 baseline)

### Tertiary (LOW confidence — flagged for validation)
- 1C:Бухгалтерия 8.3 CSV import format — proposal in §1C Export Format is reasoned but unverified against actual Uzbekistan accountant practice. Requires Buxgalter feedback (OQ-3).
- Payme callback IP ranges — assumed not publicly published; operator must verify (OQ-2).
- Click callback IP ranges — assumed delivered via merchant cabinet, not public docs (OQ-2/OQ-5).

---

## Metadata

**Confidence breakdown:**
- Webhook design (Payme + Click): HIGH — official docs verified 2026-06-07, signature formula confirmed
- Idempotency pattern (SETNX + DB constraint): HIGH — standard industry pattern, infrastructure already in place
- 12h timeout via BullMQ: HIGH — Payme docs confirm, BullMQ delayed-job pattern documented
- State machine (PAY-06/08): HIGH — all 5 states present in enum, transition table is straightforward
- Invoice PDF + QR: HIGH — existing Puppeteer + qrcode installed
- 1C export format: LOW — semicolon-CSV proposal is reasoned but needs operator verification
- Bank requisites: LOW — placeholders in code; operator must populate
- Buxgalter UI cookie auth migration: HIGH — Phase 1 cookie infra ready, frontend change is mechanical

**Research date:** 2026-06-07
**Valid until:** 2026-07-07 (1 month — Payme/Click APIs are stable; revisit if Payme major version changes)
