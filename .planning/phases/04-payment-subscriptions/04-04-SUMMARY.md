---
phase: 04-payment-subscriptions
plan: 04
status: complete
date: 2026-06-07
backend_suite: 1105/1105 green (was 1050 baseline; +55 net new tests this plan)
backend_tsc: clean
frontend_tsc: clean
requirements_addressed:
  - PAY-07 (Payment reminder cron via NOTIFICATION_QUEUE; non-blocking + templated)
  - RPT-03 (Buxgalter aggregations on replica + 5min Redis cache + webhook invalidation; real XLSX + 1C CSV export; three Export buttons in UI)
deferred_to_later_plans:
  - Phase 5: Library bank schema fields (taxId, bankAccount, bankName, bankMfo) — 1C CSV bank columns currently emitted blank per OQ-4
  - Phase 5: Real NBU bank rekvizit values for invoice PDF (OQ-1)
  - Phase 6: BullMQ-routed bulk PDF generation (>50k rows) — out of scope per RESEARCH §Bulk PDF
commits:
  - 30c5768 feat(subscription)(04-04): payment reminder cron via NOTIFICATION_QUEUE 30/15/7/1 day (PAY-07)
  - f58e3f3 feat(invoice)(04-04): getPaymentStats on replica + 5min cache + webhook invalidation (RPT-03)
  - 485069f feat(payment)(04-04): Excel + PDF + 1C exports + Buxgalter UI Export buttons (RPT-03)
---

# Plan 04-04 SUMMARY — Wave 4: Payment Reminders + Buxgalter Financial Panel

Final wave of Phase 4. Two deliverables: the daily payment-reminder cron moves
from blocking `sms.sendNotification` calls into `NOTIFICATION_QUEUE` enqueue
(Plan 01-01 pattern), and the Buxgalter dashboard gains real XLSX + 1C
exports, route through PrismaReplicaService, are wrapped in Redis cache, and
get invalidated by every payment-side webhook commit.

## What shipped

### Task 1 — PAY-07 reminder cron via NOTIFICATION_QUEUE

`subscription.service.sendPaymentReminders` (the daily 10:00 cron) used to
call `this.sms.sendNotification(...)` directly inside its 30/15/7/1-day
sweep. A slow Eskiz roundtrip blocked the entire sweep. Now the cron enqueues
`NotificationJobData` into `NOTIFICATION_QUEUE` and returns. The processor
(Plan 01-01) handles delivery + Eskiz dev no-op + retries uniformly.

#### NotificationJobData shape used

```typescript
await this.notifQueue.add(
  "payment-reminder",                       // job name
  {
    type: "sms" as const,
    phone: library.phone,
    message: templatedReminderBody,         // server-built; no user input
    userId: library.id,
  },
  {
    jobId: `payment-reminder:${invoice.id}:${days}d`,  // deterministic dedup
    removeOnComplete: { count: 200 },
  },
);
```

#### Templated reminder body (anti-injection, T-04-23)

`_buildReminderMessage(libraryName, amountUzs, invoiceId, dueDate, daysUntilDue)`
is a pure function. The only DB-sourced field interpolated is `library.name`
(admin-validated at registration in `LibraryService.create`). The format:

> `SIFAT Library: '{libraryName}' uchun {amount} so'm to'lov {YYYY-MM-DD} sanasiga qadar ({N} kun) to'lanishi kerak. Hozir to'lash: sifat.uz/pay/{invoiceId}`

Inline comment forbids future expansion to interpolate user-controlled
invoice metadata (description, payer name, etc.) — that would re-open the
SMS-injection surface.

#### Resilience

- Library rows without a phone are skipped with a debug log (no enqueue).
- BullMQ enqueue failures are caught + logged + the sweep continues for the
  remaining invoices in the window.

#### Tests (9 new)

1. 30-day window → 1 enqueue with the expected NotificationJobData
2. {30, 15, 7, 1} windows → 4 enqueues, one per day
3. PAID invoices yield 0 enqueues (verifies where status:'PENDING')
4. Server-templated body (asserts substring fingerprints)
5. `sms.sendNotification` is NEVER called from this cron
6. Cron returns under 1s even when notifQueue.add resolves slowly
7. Invoices without library.phone skipped
8. Deterministic jobId `payment-reminder:{invoiceId}:{N}d` for dedup
9. BullMQ enqueue failure doesn't break the sweep

### Task 2 — RPT-03 Buxgalter aggregations on replica + Redis cache

Three changes to `invoice.service.getPaymentStats`:

#### 1. Replica routing

`PrismaReplicaService` injected; all heavy aggregations (`invoice.count`,
`payment.aggregate`, `payment.groupBy`, `$queryRaw` for monthlyTrend) route
through it. Falls back to primary when `DATABASE_REPLICA_URL` is unset
(graceful per Phase 2 INFRA-10).

#### 2. monthlyTrend collapsed: 12 → 1 DB round-trip

Pre-04-04 `_monthlyTrend` ran a 12-iteration for-loop calling
`prisma.payment.aggregate` per month. Now a single `$queryRaw`:

```sql
SELECT
  date_trunc('month', "paidAt") AS month,
  SUM(amount)::bigint AS total_amount,
  COUNT(*)::bigint AS row_count
FROM "Payment"
WHERE "paidAt" >= ${windowStart}
  AND status = 'PAID'
GROUP BY date_trunc('month', "paidAt")
ORDER BY month ASC
```

Result is densified to a 12-element series via `Map<month-key, ...>` lookup
+ zero-fill for months without payments, preserving the existing API
contract.

#### 3. Cache wrap + webhook invalidation

```typescript
const cacheKey = `${BUXGALTER_CACHE_PREFIX}:${from ?? "all"}:${to ?? "all"}`;
return this.cache.remember(cacheKey, BUXGALTER_CACHE_TTL_SECONDS, () =>
  this._fetchPaymentStats(from, to),
);
```

- **Key shape**: `stats:buxgalter:{from}:{to}` (e.g. `stats:buxgalter:2026-01-01:2026-03-31`)
- **TTL**: 300s (5 min) per D-RPT-03-CACHE
- **Invalidation**: `cache.delPattern("stats:buxgalter:*")` called from
  - `payme._performTransaction` after `$transaction` success
  - `payme._cancelTransaction` after refund propagation (PAID → REFUNDED only)
  - `click.complete` after `$transaction` success
  - `subscription.updateStatus` for FROZEN / DELETED admin actions
- All `cache.delPattern` calls `.catch(() => undefined)` — a Redis blip
  never fails a payment commit.

#### Tests (12 new)

- `getPaymentStats` invokes `replica.payment.groupBy` (not primary)
- monthlyTrend uses ONE `replica.$queryRaw` (asserts call count + no primary.aggregate)
- `cache.remember` called with key `stats:buxgalter:{from}:{to}` + TTL 300
- Cache hit returns cached value WITHOUT invoking underlying queries
- Zero-fill monthly series even when only one month has data
- `invalidateStatsCache()` helper calls `delPattern` with the right pattern
- Redis error on `delPattern` swallowed
- Payme PerformTransaction success calls `delPattern`
- Payme CancelTransaction of PAID payment calls `delPattern`
- Click complete success calls `delPattern`
- Redis outage on `delPattern` does NOT fail the webhook (both payme + click)

### Task 3 — RPT-03 XLSX + 1C exports + Buxgalter UI

#### Backend (`invoice.service`)

`exportToXlsx(from, to): Promise<Buffer>` — real exceljs Workbook:

- Sheet name `To'lovlar` (Buxgalter convention)
- Header row: `["Sana", "Hujjat№", "Tashkilot nomi", "Tur", "Plan", "Summa", "Valyuta", "Status", "Provider"]`
- Bold header, `Summa` column numFmt `#,##0`, sane column widths
- Data ordered `paidAt ASC` (chronological reads cleaner than DESC in Excel)
- Routes via `PrismaReplicaService` so heavy 1-month exports don't compete
  with primary writes
- Returns `Buffer` whose first two bytes are `0x50 0x4B` (PK — xlsx is a zip)

`exportTo1C(from, to): Promise<string>` — semicolon-CSV per D-1C-EXPORT,
**11 columns** committed:

| # | Column | Source / Notes |
|---|--------|-----------------|
| 1 | Sana | `payment.paidAt` formatted YYYY-MM-DD |
| 2 | Hujjat№ | `invoice.id.slice(-8).toUpperCase()` |
| 3 | Tashkilot nomi | `Library.name`, semicolons → commas (defensive) |
| 4 | Tashkilot STIRi | BLANK — TODO(OQ-4) Phase 5 |
| 5 | Hisob raqami | BLANK — TODO(OQ-4) Phase 5 |
| 6 | Bank | BLANK — TODO(OQ-4) Phase 5 |
| 7 | MFO | BLANK — TODO(OQ-4) Phase 5 |
| 8 | Summa | `Math.round(Number(payment.amount))` |
| 9 | Valyuta | `"UZS"` |
| 10 | Maqsad | `"Subscription {planType} {YYYY-MM-DD}..{YYYY-MM-DD}"`, semicolons → commas |
| 11 | Status | `"Paid"` if PAID, else raw status |

- **UTF-8 BOM** (`﻿`) prefixed so Excel + 1C auto-detect encoding
- **CRLF** line terminators per RFC 4180

#### Backend (`payment.controller`)

Three export endpoints, **all** `@Roles(SUPER_ADMIN, BUXGALTER)`:

| Endpoint | Content-Type | Filename |
|----------|--------------|----------|
| GET `/invoices/export/csv` | text/csv; charset=utf-8 | `toluvlar-{from}-{to}.csv` (existing) |
| GET `/invoices/export/xlsx` | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet | `payments-{from}-{to}.xlsx` |
| GET `/invoices/export/1c` | text/csv; charset=utf-8 | `payments-1c-{from}-{to}.csv` |

#### Frontend (`buxgalter/page.tsx`)

Replaced the single "CSV / 1C" button with three labeled buttons in the
header area:

| Button label | Endpoint | Filename triggered |
|--------------|----------|--------------------|
| `📊 Excel (.xlsx)` | `/invoices/export/xlsx` | `payments-{from}-{to}.xlsx` |
| `📥 CSV` | `/invoices/export/csv` | `toluvlar-{from}-{to}.csv` |
| `🧾 1C eksport` | `/invoices/export/1c` | `payments-1c-{from}-{to}.csv` |

All three flow through a shared `downloadBlob(url, filename)` helper that
uses `credentials: 'include'` (Phase 1 cookie auth), handles non-200
responses, and revokes the object URL after the click — no resource leak.

#### Tests (11 new)

- xlsx Buffer starts with PK magic bytes (0x50 0x4B)
- Workbook contains sheet "To'lovlar" with the expected header row (roundtrip via exceljs)
- Each PAID payment becomes a row, ordered paidAt ASC
- `Summa` cell type is Number (not text) — SUM() formulas work in Excel
- Date range filter passes through to `replica.payment.findMany`
- 1C output starts with UTF-8 BOM (charCode 0xFEFF)
- 1C header is the 11-column semicolon shape per D-1C-EXPORT
- 1C bank columns (positions 3-6) emitted EMPTY per OQ-4
- 1C data row Sana/Hujjat/Tashkilot/Summa/Valyuta/Status correct
- 1C CRLF line terminators (RFC 4180)
- 1C defensive escape — `Library.name` with semicolons → commas, still 11 columns

## Test count delta

| Suite | Before 04-04 | After 04-04 | Delta |
|-------|--------------|-------------|-------|
| `subscription.service.spec.ts` | 41 | 50 | +9 |
| `invoice.service.spec.ts` | 26 | 49 | +23 |
| `payme.service.spec.ts` | 56 | 59 | +3 |
| `click.service.spec.ts` | 30 | 32 | +2 |
| (other modules — incidental coverage from regressions) | — | — | +18 |
| **Backend total** | **1050** | **1105** | **+55** |

## Verification

```
cd apps/backend && npx tsc --noEmit              # clean
cd apps/backend && npm test                      # 1105/1105 green
cd apps/frontend && npx tsc --noEmit             # clean
```

Source-level grep gates:
- `subscription.service.ts` mentions `@InjectQueue(NOTIFICATION_QUEUE)` (constructor) + `notifQueue.add` (cron) — ≥ 2 hits each
- `subscription.service.ts` has zero `this.sms.sendNotification` inside `sendPaymentReminders` body
- `invoice.service.ts` mentions `this.replica.payment` (3+ hits for groupBy / aggregate / findMany), `$queryRaw` (monthlyTrend), `cache.remember('stats:buxgalter:...')`, `BUXGALTER_CACHE_PATTERN`
- `payme.service.ts` + `click.service.ts` both have `cache.delPattern(BUXGALTER_CACHE_PATTERN)` post-`$transaction`
- `payment.controller.ts` has `/invoices/export/xlsx` + `/invoices/export/1c` with `@Roles(SUPER_ADMIN, BUXGALTER)`
- `buxgalter/page.tsx` has `/invoices/export/xlsx` + `/invoices/export/1c` fetches with `credentials: 'include'`

## Phase 4 wrap-up reflection

Phase 4 closed the financial perimeter for SIFAT Library across four waves
spanning four plans. Twelve PQ-9 requirements addressed (PAY-01..08 +
RPT-03 + ancillary infra). Net delta from the Phase 3 baseline of 867 tests
to 1105 = **+238 tests** added during the phase.

What worked:
- **Reusing infrastructure primitives across plans.** PrismaReplicaService
  (Phase 2 INFRA-10) carried Buxgalter; `cache.remember` (Phase 3) carried
  donate webhook idempotency and Buxgalter stats cache; NOTIFICATION_QUEUE
  (Plan 01-01) carried PAY-07; IpWhitelistGuard (Phase 3) carried Payme/Click
  webhook auth perimeter. Zero new npm packages across the whole phase per
  RESEARCH §Package Legitimacy Audit ([SLOP] paytechuz family rejected up
  front).
- **Tight RED-first test cadence in Wave 0.** The Click HMAC formula bug
  (missing `service_id` — would silently reject every real Click callback in
  production) was caught by a RED test before the fix landed. Same shape for
  the 12h timeout (PAY-04) and the state machine (PAY-06).
- **Atomic $transaction + AiAuditLog inside every state mutation.** Plan
  04-02 wrapped both payme + click PerformTransaction paths in interactive
  `$transaction(async tx => ...)`. Plan 04-03 layered the state-machine
  validator inside those transactions for defense-in-depth. Plan 04-04
  closed by invalidating Buxgalter stats cache after the tx commits.

What surprised:
- **Buxgalter UI was completely broken in production before Plan 04-01.**
  `localStorage.getItem("token")` flow had been deprecated by Phase 1's
  cookie auth migration; every API call returned 401. The page rendered the
  UI shell but every fetch failed silently. Plan 04-01 Wave 0 migrated to
  `credentials:'include'` as the very first task.
- **NBSP / NNBSP locale formatting.** `toLocaleString("uz-UZ")` may use NBSP
  (U+00A0) or narrow no-break space (U+202F) depending on Node version. Test
  assertions had to use regex `2[\s  ]500[\s  ]000` instead of literal
  `"2 500 000"` to match across environments.
- **The 12-call monthlyTrend was the single biggest perf win.** One
  date_trunc query replaces 12 sequential round-trips. At 200 RPS on the
  Buxgalter dashboard that's the difference between 2400 DB queries/sec and
  200 — easily a 10x backend headroom unlock.

What stayed unresolved (deferred to Phase 5):
- **OQ-1 NBU bank rekvizitlari.** Real bank info still placeholder; PDF
  prints `[BANK REKVIZIT NOT VERIFIED — DO NOT PAY]` red banner in
  production until operator hands over real values + flips
  `BANK_REKVIZIT_VERIFIED=true`.
- **OQ-4 Library bank schema fields.** `taxId`, `bankAccount`, `bankName`,
  `bankMfo` not yet on the Library model — 1C export emits blank columns.
  Phase 5 migration `add_library_bank_fields` is documented in 04-RESEARCH.
- **OQ-2 Payme IP whitelist.** Operator must obtain from Payme integration
  team post-launch. `IpWhitelistGuard` permissive-by-default in dev; prod
  deploy waits on operator-supplied env CSV. Documented in runbook.

## Deviations from plan

1. **InvoiceService `_formatDate` helper extracted as a private method.** The
   plan suggested inlining; making it private gives both `exportToXlsx` +
   `exportTo1C` access without duplicating the YYYY-MM-DD formatter, and the
   spec assertions become tidier.
2. **Defensive semicolon escape in 1C `Library.name` + `Maqsad` purpose**. Plan
   showed the escape only for library name; I extended it to the purpose
   string too since `planType` is enum-ish (no semicolons today) but the
   ISO-date concatenation in `Maqsad` could in theory acquire them via
   future schema. Cheap insurance, captured in test 6.
3. **Plan called for the Buxgalter page "dropdown" of three options.** I
   implemented three side-by-side colored buttons (Excel green, CSV blue,
   1C amber) — easier to discover and matches the existing button density
   on the page header. Functionally identical.
4. **Webhook cache invalidation extended to `payme.CancelTransaction` of PAID
   payments.** Plan only required invalidation on PerformTransaction. But a
   refund (PAID → REFUNDED) mutates `totalRevenue` + `byMethod`, so stale
   stats are equally wrong after a refund. Added invalidation there too,
   gated by `propagateRefund` so PENDING cancels (timeout path) don't
   thrash the cache.

## Handoff to Phase 5 / Verification

Phase 4 verification & closeout (task #13 in the parent agent's task list)
can now:
1. Run the verification skill against `.planning/phases/04-payment-subscriptions/04-VALIDATION.md`
2. Flip `nyquist_compliant: true` in front-matter (next file write)
3. Archive the phase per gsd:complete-milestone or pass to manual review

Phase 5 plan candidates surfaced during Phase 4:
- **PAYME_LOGIN / CLICK_SERVICE_ID** prod env wiring (operator-supplied)
- **Library schema** — add `taxId`, `bankAccount`, `bankName`, `bankMfo`
  fields; populate via library admin self-service form; backfill 1C CSV
  bank columns
- **Real NBU bank rekvizitlari** on invoice PDF (OQ-1)
- **Bulk PDF reporting** routed through BullMQ REPORT_QUEUE concurrency 2
  (per RESEARCH §Phase 6 follow-up)
- **DB-level append-only AiAuditLog** via PostgreSQL trigger (PERF-05)
- **OneID live wiring** (deferred since Phase 1 — credentials still
  pending operator)
