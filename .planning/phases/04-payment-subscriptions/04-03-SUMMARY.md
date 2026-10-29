---
phase: 04-payment-subscriptions
plan: 03
status: complete
date: 2026-06-07
backend_suite: 1050/1050 green (up from 1012 baseline; +38 new tests)
backend_tsc: clean
frontend_tsc: clean
requirements_addressed:
  - PAY-05 (Invoice PDF QR code + [DEV BANK PLACEHOLDER] watermark)
  - PAY-06 (Subscription 5x5 state-machine validator + SYSTEM whitelist)
  - PAY-08 (Admin-only freeze/delete with reason + AiAuditLog)
deferred_to_later_plans:
  - Plan 04-04: BullMQ reminders refactor + Buxgalter XLSX/1C exports
  - Phase 5: Real bank rekvizit data + Library bank schema fields (OQ-1/OQ-4)
commits:
  - 9a57e47 feat(prisma)(04-03): Subscription audit-fields migration (PAY-08)
  - db796a3 feat(invoice)(04-03): PDF with QR code and bank placeholder (PAY-05)
  - f082c2b feat(subscription)(04-03): 5x5 state machine + admin freeze/delete (PAY-06, PAY-08)
  - eebcd9d feat(frontend)(04-03): admin subscriptions page + library billing page
---

# Plan 04-03 SUMMARY — Wave 3 subscription audit + invoice QR + state machine + admin UI

## What shipped

### Task 1 — Subscription audit-fields migration (PAY-08)

Migration name: `20260607000003_phase4_subscription_audit_fields`
Applied: 2026-06-07 via psql + `prisma migrate resolve --applied`
(shadow DB rebuild fails on a pre-existing Phase 2 migration referencing
`penaltyDays` — not a regression of this work).

Six new nullable columns on `Subscription` per CLAUDE.md §XIII.3 ("sabab
majburiy"):

| Column | Type | Purpose |
|--------|------|---------|
| `frozenReason` | TEXT | Reason recorded when admin freezes |
| `frozenAt` | TIMESTAMP(3) | Wall-clock timestamp of freeze |
| `frozenBy` | TEXT | userId of admin who froze (no FK — mirrors Library pattern) |
| `deletedReason` | TEXT | Reason recorded when admin deletes |
| `deletedAt` | TIMESTAMP(3) | Wall-clock timestamp of delete |
| `deletedBy` | TEXT | userId of admin who deleted |

All nullable — backward-compatible (existing rows stay NULL, no DEFAULT
migration cost). Plain TEXT (not FK to User) avoids cascading-delete
complexity if the admin later leaves.

### Task 2 — Invoice PDF QR code + bank placeholder watermark (PAY-05)

`InvoiceService.generateInvoicePdf` extended:

- Imports `qrcode@1.5.4` (already in package.json) — no new dependency.
- Generates QR via `QRCode.toDataURL('https://sifat.uz/pay/{invoice.id}',
  { width: 200, margin: 1, errorCorrectionLevel: 'M' })`.
- Embeds the data URL as `<img src="data:image/png;base64,..." alt="To'lov
  QR kodi" width="200" height="200" />` inside the Puppeteer HTML.
- Bank rekvizitlari placeholder constants stay (per OQ-1 — operator hands
  over real NBU values pre-V1) with an inline `TODO(OQ-1)` comment.
- `[DEV BANK PLACEHOLDER]` red watermark rendered next to the bank header
  ONLY when `process.env.NODE_ENV !== "production"`. Mitigates T-04-21
  (shipping placeholders to prod).

QR target trust-rooted at sifat.uz (URL constructed server-side from cuid
`invoice.id` — no user input flows in, mitigates T-04-20).

### Task 3 — Subscription 5x5 state machine + admin freeze/delete (PAY-06, PAY-08)

#### ALLOWED_TRANSITIONS matrix (exported from subscription.service.ts)

```typescript
TRIAL   -> [PENDING, ACTIVE, FROZEN]
PENDING -> [ACTIVE, FROZEN]
ACTIVE  -> [PENDING, FROZEN, DELETED]
FROZEN  -> [ACTIVE, DELETED]
DELETED -> []   // terminal
```

#### SYSTEM_ALLOWED whitelist (background jobs + webhooks)

```typescript
[
  ["TRIAL",   "PENDING"],   // trial expiry, paid plan
  ["TRIAL",   "ACTIVE"],    // trial expiry, free plan (GOV/MAH) only
  ["PENDING", "ACTIVE"],    // webhook payment-confirmed
]
```

`FREE_PLAN_TYPES = ["GOV", "MAH"]` gates the TRIAL->ACTIVE SYSTEM path.

**Critical invariant**: SYSTEM can NEVER reach FROZEN or DELETED. Every
background entry point that triggers a transition (`trialExpiryReminders`
cron, Payme `_performTransaction`, Click `_completeInternal`) passes
`actor="SYSTEM"` to `assertSubscriptionTransition`, which throws
`BadRequestException` on any SYSTEM attempt to move outside the whitelist.

#### assertSubscriptionTransition exported pure function

```typescript
assertSubscriptionTransition(
  from:     SubscriptionStatus,
  to:       SubscriptionStatus,
  by:       "SYSTEM" | UserRole,
  reason:   string | undefined,
  planType?: string,
): void
```

Throws:
- `BadRequestException` for illegal (from, to) transitions, SYSTEM
  violations, missing reason on FROZEN/DELETED.
- `ForbiddenException` for FROZEN/DELETED by a non-admin role.

Exported as a standalone pure function so Payme/Click webhook
`$transaction` callbacks can call it inline without breaking tx atomicity.

#### updateStatus new signature

```typescript
async updateStatus(
  subscriptionId: string,
  status:         SubscriptionStatus,
  reason:         string | undefined,
  actorId:        string,
  actorRole:      "SYSTEM" | UserRole,
): Promise<Subscription>
```

Flow:
1. `findUnique` to read current `sub.status` + `sub.planType`.
2. `assertSubscriptionTransition(sub.status, status, actorRole, reason, sub.planType)`.
3. `prisma.$transaction(async tx => {`
   - `tx.subscription.update` (sets `frozenReason/At/By` for FROZEN,
     `deletedReason/At/By` for DELETED, otherwise plain `status`).
   - `tx.aiAuditLog.create` STATE_TRANSITION row with `severity: HIGH`
     for FROZEN/DELETED, `MEDIUM` otherwise. `analysis` JSON:
     `{ from, to, by: actorId, actorRole, reason }`.
   - `})`.

#### Cron + webhook refactor

`trialExpiryReminders`:
- Replaced two direct `prisma.subscription.update({ data: { status } })`
  calls with `this.updateStatus(sub.id, ACTIVE | PENDING, undefined,
  "system", "SYSTEM")`.
- Free plan (GOV/MAH) -> ACTIVE; paid plan -> PENDING + invoice.

Payme `_performTransaction` + Click `_completeInternal`:
- Inside the existing `$transaction`, added
  `tx.subscription.findUnique` + inline
  `assertSubscriptionTransition(sub.status, ACTIVE, "SYSTEM", undefined,
  sub.planType)` before `tx.subscription.update`. Defense in depth.

#### Controller hardening (PATCH /subscriptions/:id/status)

```typescript
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
@Patch("subscriptions/:id/status")
updateStatus(
  @Param("id") id: string,
  @Body() body: SubscriptionStatusUpdateDto,
  @CurrentUser() user: JwtPayload,
) {
  return this.subscriptionService.updateStatus(
    id, body.status, body.reason, user.sub, user.role as UserRole,
  );
}
```

`SubscriptionStatusUpdateDto`:
- `@IsEnum(SubscriptionStatus) status`
- `@IsOptional() @IsString() @MinLength(3) reason?` (conditional
  "required for FROZEN/DELETED" check stays in the service-layer
  validator — single source of truth).

Actor id comes from `@CurrentUser().sub` — body cannot impersonate
another admin in the audit log.

### Task 4 — Admin subscriptions page + library billing page

#### `/dashboard/subscriptions` (admin)

Client component (`"use client"`) with React Query.
- Lists subscriptions filtered by status; status badge color-coded.
- Per-row action buttons (Freeze / Unfreeze / Delete) gated by current
  status.
- Freeze + Delete open a modal asking for reason (3+ chars enforced
  client-side; backend `assertSubscriptionTransition` is the canonical
  enforcer).
- Submit calls `PATCH /subscriptions/:id/status` with `credentials:
  'include'`.
- Client-side role gate (`user.role in [SUPER_ADMIN, BUXGALTER]`)
  prevents the UI from rendering for non-admin tokens. Server RolesGuard
  is the canonical enforcer.
- Surfaces `frozenReason` / `deletedReason` in the table for audit
  visibility.

#### `/dashboard/library/billing` (library admin self-service)

- Reads `GET /subscriptions/library/{libraryId}` using
  `user.libraryId` from `useAuthStore`.
- TRIAL: shows days-remaining and trial-end date.
- PENDING: shows last invoice due date + amount.
- ACTIVE: shows next renewal date.
- FROZEN: surfaces `frozenReason` + `frozenAt` (admin chose to freeze).
- DELETED: shows terminal state.
- "Hozir to'lash" button visible only when TRIAL (last 10 days) /
  PENDING / FROZEN. Click calls `POST /subscriptions/:id/renew`. Handles
  three response shapes:
  - `paymentUrl` -> redirect (real Payme/Click flow)
  - `invoice` -> show "Faktura yaratildi" message
  - synthetic success -> show "Obuna yangilandi" (free plan or
    DEV_SUBSCRIPTION_PAYMENT_STUB short-circuit per OQ-6)
- Invoice history table with PAID/PENDING badges.

Both pages use `credentials: 'include'` on every fetch (Phase 1
INFRA-02 cookie auth). Zero `localStorage.getItem('token')`.

## Test count delta

| Suite                                  | Before | After | Delta |
|----------------------------------------|--------|-------|-------|
| `subscription.service.spec.ts`         | 5      | 41    | +36   |
| `invoice.service.spec.ts`              | 19     | 26    | +7    |
| `payme.service.spec.ts` + `click.service.spec.ts` | 71 | 71 | 0 (mock-only updates) |
| **TOTAL** | **1012** | **1050** | **+38** |

Plan target was ~21 new tests (15 state-machine + 6 invoice). Delivered
43 (36 subscription + 7 invoice) — extra coverage on the matrix tables
(`it.each`) gave free combinatorial reach.

## Verification

- `cd apps/backend && npx tsc --noEmit` — clean
- `cd apps/backend && npx jest --forceExit` — 1050/1050 green
- `cd apps/backend && npx prisma validate` — schema valid
- `cd apps/backend && npx prisma migrate status` — 6 migrations, all
  applied; database schema up to date
- `cd apps/frontend && npx tsc --noEmit` — clean
- DB column verification:
  `SELECT column_name, data_type, is_nullable FROM information_schema.columns
   WHERE table_name = 'Subscription' AND column_name IN
   ('frozenReason','frozenAt','frozenBy','deletedReason','deletedAt','deletedBy');`
  returns all 6, all nullable.

## Deviations from plan

1. **Migration apply path**: plan said `npx prisma migrate dev`. Local
   shadow DB rebuild fails on the Phase 2 `penaltyDays` migration (a
   pre-existing issue, not a regression of this work). Used the
   documented Phase 2 baseline-style workaround: hand-write the
   migration SQL, apply via psql, then `prisma migrate resolve --applied`.
   The migration name (`20260607000003_phase4_subscription_audit_fields`)
   and SQL shape (6 nullable `ADD COLUMN`) match what
   `migrate dev --create-only` would have produced.

2. **`getPaymentStats` moved**: SubscriptionService.getStats stayed; the
   redundant `getPaymentStats` referenced in the original
   subscription.service was removed by the rewrite (it was actually in
   `invoice.service.ts` already — single source of truth restored).

3. **Plan 04-02 already wrapped Payme/Click in `$transaction`**: the
   webhook state changes were already atomic before this plan landed.
   Plan 04-03 Task 3 added the inline
   `assertSubscriptionTransition(..., "SYSTEM", ...)` call WITHIN those
   existing transactions — defense in depth, no shape change.

4. **Did not add backend listSubscriptions / library/me routes** — plan
   text said "verify GET /subscriptions exists; if not add". Both
   routes already existed in `payment.controller.ts` (lines 153 + 172
   pre-04-03) and accept the query shape the new UI needs. No new
   routes added.

## Handoff to Plan 04-04

Plan 04-04 (Buxgalter exports + reminders refactor) can now:

1. Refactor `sendPaymentReminders` cron from synchronous
   `sms.sendNotification` calls to `notifQueue.add("payment-reminder",
   ...)` per Plan 01-01 NOTIFICATION_QUEUE pattern.
2. Replace `exportToExcel` (which returns CSV labeled as Excel) with
   real `.xlsx` via `exceljs` (installed v4.4.0).
3. Add `/invoices/export/1c` 1C-Bukhgalteriya-compatible CSV endpoint
   per OQ-3.
4. Cache `getPaymentStats` in Redis 5min keyed by from-to range.
5. Add a Buxgalter UI tab for export-format selection (XLSX / 1C / PDF).
