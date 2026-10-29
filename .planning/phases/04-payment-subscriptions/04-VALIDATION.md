---
phase: 4
slug: payment-subscriptions
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-07
closed: 2026-06-07
backend_suite_final: 1105
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 + ts-jest (apps/backend/jest.config.ts) |
| **Config file** | apps/backend/jest.config.ts |
| **Quick run command** | `cd apps/backend && npx jest <path> --bail --forceExit` |
| **Full suite command** | `cd apps/backend && npm test` |
| **Estimated runtime** | ~100 seconds (Phase 3 baseline: 891 tests; Phase 4 adds ~45 → ~936 total) |
| **Coverage gate** | 80% lines |
| **Notable** | Payment specs: 1395 LOC (Payme 567 + Click 303 + Invoice 331 + Subscription 194). Phase 4 EXTENDS in-place — minimal Wave 0 spec-creation gap. RedisLockService + PaymentTimeoutProcessor are new (require new spec files). Puppeteer headless PDF tested via fixture HTML snapshot. |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/backend && npx jest <touched-spec> --bail --forceExit`
- **After every plan wave:** Run `cd apps/backend && npm test`
- **Before `/gsd-verify-work`:** Full suite green + manual webhook simulation (Payme + Click) + invoice PDF visual smoke + 1C CSV column-shape verification
- **Max feedback latency:** 100 seconds

---

## Per-Task Verification Map

> Closed by Plan 04-04 — all 49 tasks across 4 plans landed green.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-T1 | 04-01 | 0 | INFRA — RedisLockService | T-04-01 | SETNX atomic acquire + cached response replay (24h TTL) | unit | `npx jest src/infra/cache/__tests__/redis-lock.service.spec.ts` | ✅ | ✅ |
| 04-01-T2 | 04-01 | 0 | PAY-02 | T-04-03 | Click HMAC formula includes service_id (official spec) | unit | `npx jest src/modules/payment/__tests__/click.service.spec.ts -t "sign"` | ✅ | ✅ |
| 04-01-T3 | 04-01 | 0 | RPT-03 prereq | T-04-04 | Buxgalter UI uses credentials:include (cookie auth) | smoke | manual page-load | ✅ | ✅ |
| 04-01-T4 | 04-01 | 0 | INFRA-04 | T-04-05 | Vault prod fail-hard for PAYME/CLICK keys | unit | `npx jest src/main` | ✅ | ✅ |
| 04-01-T5 | 04-01 | 0 | PAY-04 | T-04-06 | PAYMENT_TIMEOUT_QUEUE registered | unit | queue.module.spec | ✅ | ✅ |
| 04-01-T6 | 04-01 | 0 | INFRA — Kafka topics | T-04-07 | PAYMENT_COMPLETED + SUBSCRIPTION_ACTIVATED added | unit | kafka.service spec | ✅ | ✅ |
| 04-02-T1 | 04-02 | 1 | PAY-01 | T-04-08 | Payme webhook DTOs typed + ValidationPipe | unit | `npx jest src/modules/payment/__tests__/payme.service.spec.ts -t "dto"` | ✅ | ✅ |
| 04-02-T2 | 04-02 | 1 | PAY-01/02 | T-04-09 | IpWhitelistGuard wired on payme + click webhook routes | unit | `npx jest src/modules/payment/__tests__/payment.controller.spec.ts` | ✅ | ✅ |
| 04-02-T3 | 04-02 | 1 | PAY-01/02 | T-04-10 | RedisLockService idempotency layer in handleWebhook | unit | payme + click spec — `-t "idempot"` | ✅ | ✅ |
| 04-02-T4 | 04-02 | 1 | PAY-03 | T-04-11 | Payment + Invoice + Subscription + AiAuditLog atomic via $transaction | unit | `payme/click -t "atomic\|rollback"` | ✅ | ✅ |
| 04-02-T5 | 04-02 | 1 | PAY-04 | T-04-12 | 12h timeout delayed job + processor + reason=4 | unit | `npx jest src/infra/queue/__tests__/payment-timeout.processor.spec.ts` | ✅ | ✅ |
| 04-02-T6 | 04-02 | 1 | PAY-04 | T-04-13 | Cancel reason override (reason=4 when our timeout fired) | unit | payme spec — `-t "cancel"` | ✅ | ✅ |
| 04-03-T1 | 04-03 | 2 | PAY-08 | T-04-14 | Subscription audit columns migration (frozenReason/At/By + deletedReason/At/By) | DB | prisma migrate status | ✅ | ✅ |
| 04-03-T2 | 04-03 | 2 | PAY-05 | T-04-20 | Invoice PDF embeds QR data URL + [DEV BANK PLACEHOLDER] watermark | unit | `npx jest invoice.service.spec.ts -t "qr\|placeholder"` | ✅ | ✅ |
| 04-03-T3 | 04-03 | 2 | PAY-06/08 | T-04-15/16 | 5x5 state machine validator + SYSTEM whitelist + admin freeze/delete with reason | unit | `npx jest subscription.service.spec.ts -t "transition\|state"` | ✅ | ✅ |
| 04-03-T4 | 04-03 | 2 | UI — admin subscriptions + library billing pages | T-04-21 | Admin freeze/delete modal + library billing self-service via cookie auth | smoke | manual page-load | ✅ | ✅ |
| 04-04-T1 | 04-04 | 3 | PAY-07 | T-04-23/24 | Reminder cron via NOTIFICATION_QUEUE; templated body; no direct sms.sendNotification | unit | `npx jest subscription.service.spec.ts -t "reminder\|PAY-07"` | ✅ | ✅ |
| 04-04-T2 | 04-04 | 3 | RPT-03 | T-04-25/26 | getPaymentStats on replica + cache.remember 5min + webhook delPattern invalidation | unit | `npx jest invoice.service.spec.ts -t "stats\|cache\|replica"` + payme/click `-t "invalidat"` | ✅ | ✅ |
| 04-04-T3 | 04-04 | 3 | RPT-03 | T-04-27/28 | Real XLSX (exceljs) + 1C CSV (BOM + 11 col + blank bank) + Buxgalter UI Export buttons | unit | `npx jest invoice.service.spec.ts -t "xlsx\|1c"` | ✅ | ✅ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

> All Wave 0 deliverables shipped via Plan 04-01 (Tasks 1-3) + Plan 04-02 Wave 0
> add-ons. Closed by Plan 04-04 finalization.

- [x] RedisLockService (apps/backend/src/infra/cache/redis-lock.service.ts) + spec — SETNX semantics with 24h TTL (PAY-01/02)
- [x] Click HMAC signature CORRECTNESS fix (PAY-02 — service_id now included per official Click spec)
- [x] Buxgalter frontend cookie-auth fix (RPT-03 prerequisite — credentials: "include" replaces localStorage.getItem)
- [x] Vault env additions: PAYME_LOGIN, PAYME_MERCHANT_ID, PAYME_SECRET_KEY, PAYME_TEST_KEY, CLICK_MERCHANT_ID, CLICK_SECRET_KEY, CLICK_SERVICE_ID, PAYME_IP_WHITELIST, CLICK_IP_WHITELIST + .env.example placeholders
- [x] PAYMENT_TIMEOUT_QUEUE registration in queue.module.ts (PAY-04)
- [x] KAFKA_TOPICS additions: PAYMENT_COMPLETED, SUBSCRIPTION_ACTIVATED (Plan 04-01)
- [ ] DEV_SUBSCRIPTION_PAYMENT_STUB env flag pattern (OQ-6 — user-approved, mirrors DEV_OTP_BYPASS + DEV_DONATION_PAYMENT_STUB)

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Payme webhook end-to-end | PAY-01 | Requires Payme sandbox or replay of real merchant payload | curl simulated CreateTransaction → CheckPerformTransaction → PerformTransaction → verify subscription ACTIVE within 30s |
| Click webhook end-to-end | PAY-02 | Requires Click sandbox or replay of real merchant payload | curl Prepare (action=0) → Complete (action=1) with correct MD5; verify subscription ACTIVE within 30s |
| 12-hour timeout actually fires | PAY-04 | Requires waiting 12h OR fake-timer test mode | Force-trigger via admin endpoint or Jest fake timers; verify Payment → FAILED + AiAuditLog row |
| Invoice PDF visual correctness | PAY-05 | Visual check on real renderer | Generate invoice for a real Subscription; open PDF; confirm logo, bank requisites, QR code valid, amount + due date correct |
| Subscription state machine all transitions | PAY-06 | Multi-action admin flow | Trial → Pending (auto on expiry) → Active (on payment) → Frozen (admin) → Active (admin) → Deleted (admin); verify each transition logs AiAuditLog |
| Payment reminders at 30/15/7/1 days | PAY-07 | Multi-day cron sequence | Force-trigger checkUpcomingPayments with fake date; verify SMS enqueued at each interval (dev no-op via Phase 1 Eskiz) |
| Admin freeze/delete require reason | PAY-08 | Multi-step admin flow with audit | POST /subscriptions/admin/:id/freeze with empty reason → 400; with reason → 200 + AiAuditLog populated |
| Buxgalter Excel + PDF + 1C CSV exports | RPT-03 | Visual / format verification | Buxgalter dashboard → click each Export button; confirm file downloads; verify column shape matches 1C import requirements |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 100s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
