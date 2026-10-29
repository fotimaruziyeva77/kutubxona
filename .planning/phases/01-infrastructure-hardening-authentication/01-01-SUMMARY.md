---
phase: 01-infrastructure-hardening-authentication
plan: 01
subsystem: notifications-sms
tags: [sms, eskiz, bullmq, otp, auth, notif-01, notif-04, auth-01]
status: partial-pending-human-checkpoint
requires:
  - "@nestjs/bullmq notifications queue (existing — Sprint 1)"
  - "ConfigService env (ESKIZ_EMAIL, ESKIZ_PASSWORD, ESKIZ_FROM, ESKIZ_BASE_URL)"
provides:
  - "EskizSmsClient — token-caching Eskiz HTTP SMS client"
  - "Active @Processor(NOTIFICATION_QUEUE) bound to BullMQ"
  - "Real SMS delivery path for OTP (AUTH-01), admin approval, AUTH-04 fallback"
affects:
  - "OTP send flow (auth.service.ts → sms.service.ts → notifications queue → processor → Eskiz)"
  - "AdminService.autoFallbackPendingUsers SMS notifications (AUTH-04)"
tech-stack:
  added: []   # no new npm packages — direct HTTP via native fetch (per RESEARCH)
  patterns:
    - "Lazy authenticate + in-memory token cache (Pitfall 5)"
    - "401 → clear-cache → re-auth → retry-once"
    - "Dev no-op when credentials unset (preserves dev/test boot)"
    - "Phone-masked structured delivery log {phone, status} (T-01-02)"
    - "forwardRef SmsModule ↔ QueueModule (circular import resolution)"
key-files:
  created:
    - apps/backend/src/infra/sms/eskiz.client.ts
    - apps/backend/src/infra/sms/eskiz.client.spec.ts
    - apps/backend/src/infra/queue/notification.processor.spec.ts
  modified:
    - apps/backend/src/infra/queue/notification.processor.ts
    - apps/backend/src/infra/queue/queue.module.ts
    - apps/backend/src/infra/sms/sms.module.ts
decisions:
  - "Direct native-fetch client over the unofficial eskiz-sms npm wrapper (supply-chain safety, matches iduz.service.ts pattern)"
  - "forwardRef on both sides of SmsModule ↔ QueueModule to inject EskizSmsClient into the processor without breaking SmsService's existing InjectQueue dependency"
  - "Token cached as a single instance field; re-auth only on 401 (Pitfall 5)"
  - "Dev no-op when ESKIZ_EMAIL is unset — warns and returns; never throws (lets unit tests in unrelated modules boot)"
  - "OTP length stays 6 digits — decision deferred to the user at the Task 3 checkpoint (default per Plan 01-03 test pin)"
metrics:
  duration: "~10 min (code) — Task 3 live-delivery checkpoint PENDING external credentials"
  completed_date: "2026-06-06"
  tasks_done: 2
  tasks_total: 3
  tests_added: 8
  tests_passing: "658 / 658 (full suite)"
---

# Phase 1 Plan 1: SMS Notification Keystone (Eskiz + Notification Processor) Summary

> Eskiz.uz HTTP SMS client with cached bearer token + 401-re-auth-retry, wired into a now-active `@Processor(NOTIFICATION_QUEUE)` — registration OTP delivery (AUTH-01), admin-approval SMS, and AUTH-04 14-day-fallback SMS now have a real delivery path instead of the prior `logger.debug` no-op (PITFALLS C3).

## Status

**Partial — 2 of 3 tasks complete. Task 3 is a PENDING human checkpoint** awaiting Eskiz.uz credentials from the user. The code path is fully wired and unit-tested; what remains is the live end-to-end verification against the real Eskiz provider, which requires:

1. User-supplied `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_FROM` (and optionally `ESKIZ_BASE_URL` if not the default `https://notify.eskiz.uz`).
2. A real test phone to receive the OTP.
3. The user's decision on OTP digit length (keep 6 — the current default — or switch to 4 per TZ §2.1).

See **"Pending Human Checkpoint (Task 3)"** below for the exact verification protocol and the `## CHECKPOINT REACHED` return.

## Tasks Completed (this run)

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wave 0 — Eskiz client + processor failing specs (RED) | `44b9ea0` | `eskiz.client.spec.ts`, `notification.processor.spec.ts` |
| 2 | Eskiz HTTP client + enabled @Processor (GREEN) | `24f39ea` | `eskiz.client.ts`, `notification.processor.ts`, `sms.module.ts`, `queue.module.ts` |
| 3 | Live OTP delivery verification | **PENDING** (human checkpoint — blocking-human) | — |

## Implementation Details

### EskizSmsClient (`apps/backend/src/infra/sms/eskiz.client.ts`)

- **Reads from ConfigService:** `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_FROM`, `ESKIZ_BASE_URL` (default `https://notify.eskiz.uz`). No hardcoded credentials anywhere.
- **`sendSms(phone, message)`** is the only public method. Lazily calls `_authenticate()` on first send, caches the bearer token on `this.token` as an instance field (NEVER persisted to disk/DB — T-01-03).
- **401 path:** clears `this.token`, calls `_authenticate()` exactly once, retries the send exactly once. Any non-2xx after that throws — the BullMQ job's `attempts: 3` + exponential backoff handles transient downstream failures.
- **Phone normalization:** strips non-digits and prefixes `998` if missing. Eskiz API expects digits-only `mobile_phone` (e.g. `998901234567`).
- **Delivery-status log (NOTIF-01):** `logger.log({ phone, status: 'success' | 'fail' })`. Phone is masked (`99890***67`) so logs do not leak full PII. Message body and token are **never** logged.
- **Dev no-op:** when `ESKIZ_EMAIL` is unset, logs a one-line warning and returns. Lets dev/test environments boot without credentials and keeps unrelated unit tests deterministic.

### NotificationProcessor (`apps/backend/src/infra/queue/notification.processor.ts`)

- **`@Processor(NOTIFICATION_QUEUE)` decorator re-enabled** (NOTIF-04 — was the only blocker preventing BullMQ from binding the worker).
- Constructor now takes `EskizSmsClient` via DI; `sendSms()` routes through `this.eskiz.sendSms(phone, message)` instead of the prior `logger.debug` no-op.
- `push` and `email` job types remain logger-only stubs (deferred to Phase 5 per RESEARCH.md).
- Existing `OnWorkerEvent('failed' / 'completed')` retry/DLQ telemetry preserved.

### Module wiring

`SmsModule` registers + exports `EskizSmsClient`; `QueueModule` imports `SmsModule` via `forwardRef()` so `NotificationProcessor` can inject the client without breaking the pre-existing circular import (`SmsService` already does `@InjectQueue(NOTIFICATION_QUEUE)` from `QueueModule`).

## Verification

| Check | Result |
|---|---|
| Targeted specs: `npx jest eskiz.client.spec notification.processor.spec --bail` | ✅ 8/8 pass |
| Full backend suite: `cd apps/backend && npm test` | ✅ 658/658 pass (36 suites) — was 650 before, +8 new |
| Type-check: `npx tsc --noEmit` | ✅ clean |
| Coverage gate (80% lines, infra excluded from collection) | ✅ pass |
| `notification.processor.ts` contains active `@Processor(NOTIFICATION_QUEUE)` | ✅ verified by `must_haves.artifacts.contains` |
| `eskiz.client.ts` ≥ 40 lines, exports injectable client | ✅ ~140 lines |
| 401 path re-authenticates exactly once + retries exactly once | ✅ proven by `should re-authenticate once on 401` spec |
| Token caching across multiple sends | ✅ proven by `should cache token across two sends` spec |

## Pending Human Checkpoint (Task 3)

> **STATUS: BLOCKING — awaiting user-provided Eskiz credentials.**
>
> Eskiz.uz is an external paid SMS provider. The user has not supplied credentials, so live end-to-end verification cannot be performed in this run.

### What the user must provide

1. **Backend env vars** (commit to `.env` locally, then in Vault for staging):
   - `ESKIZ_EMAIL` — Eskiz.uz account email (Eskiz dashboard → account email)
   - `ESKIZ_PASSWORD` — Eskiz API password (Eskiz dashboard → API settings)
   - `ESKIZ_FROM` — approved alphanumeric sender ID / nickname (Eskiz dashboard → SMS → Nickname; must be in "approved" state)
   - `ESKIZ_BASE_URL` — *optional*; defaults to `https://notify.eskiz.uz`. Override only if the project dashboard tells you to.

2. **A test phone number** to receive the OTP (e.g. user's own mobile, format `+998XXXXXXXXX`).

3. **OTP digit-length decision for Plan 01-03 / `auth.service.ts`:**
   - **"keep 6"** — current code, current spec pin, current `VerifyOtpDto @Length(6,6)`. Default. No change needed.
   - **"switch to 4"** — strict reading of TZ §2.1 ("4 raqam"). Plan 01-03 will land the auth.service + DTO change in that case.

### Verification protocol (user runs these steps, not Claude)

1. Provide the four env vars listed above in `apps/backend/.env`.
2. Confirm the `from` sender nickname is in "approved" state in the Eskiz dashboard.
3. Ensure Redis + Postgres dev services are up (`docker compose up -d` — `sifat-postgres:55432`, `sifat-redis:56379` are already running per environment notes).
4. Start the backend: `cd apps/backend && npm run dev`.
5. From a separate shell: `curl -X POST http://localhost:3001/api/auth/otp/send -H "Content-Type: application/json" -d '{"phone":"+998XXXXXXXXX","purpose":"register"}'`.
6. **Confirm the SMS arrives on the test phone within ~30 seconds.**
7. **Confirm the backend log shows** `{phone: "99890***XX", status: "success"}` (and NO `[eskiz dev no-op]` warning — that warning means env vars are still missing).
8. **Reply with the OTP-length decision:** `"approved, keep 6"` or `"approved, switch to 4"`.

### Failure handling at the checkpoint

- If no SMS arrives → check (a) `from` nickname is approved, (b) `ESKIZ_PASSWORD` is the API password (not the dashboard login), (c) the test phone is reachable. Inspect backend log for HTTP status of the Eskiz response.
- If you see `[eskiz dev no-op]` in the log → `ESKIZ_EMAIL` is not being read by `ConfigService` — verify `.env` is loaded.
- If you see `Eskiz auth failed: 401` → credentials are wrong.
- If you see `Eskiz auth failed: 4xx` (other) → the `email`/`password` field shape may differ for this account; check the Eskiz dashboard's API docs / Postman collection for this account's exact contract.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking issue] Circular module dependency between SmsModule and QueueModule**

- **Found during:** Task 2, when wiring `EskizSmsClient` into `NotificationProcessor`.
- **Issue:** `SmsModule` already imports `QueueModule` (so `SmsService` can `@InjectQueue(NOTIFICATION_QUEUE)`). Adding `QueueModule.imports = [SmsModule]` so `NotificationProcessor` can inject `EskizSmsClient` would create a circular import.
- **Fix:** Used `forwardRef(() => …)` on both sides — `SmsModule.imports = [forwardRef(() => QueueModule)]` and `QueueModule.imports = [forwardRef(() => SmsModule), …]`. This is the standard Nest pattern documented for circular module dependencies and does not introduce new behavior.
- **Files modified:** `apps/backend/src/infra/sms/sms.module.ts`, `apps/backend/src/infra/queue/queue.module.ts`.
- **Commit:** `24f39ea` (same task commit — atomic with the feature).

### Additions beyond plan-prescribed minimum

**2. [Rule 2 — Critical functionality] Phone masking in the delivery-status log**

- **Why:** The plan's `<threat_model>` lists T-01-02 (info disclosure of credentials/PII) with `mitigate` disposition. Logging the full phone number in the success log would leak PII into log aggregation. Implemented `_maskPhone()` so the log carries `99890***67` instead of the full number. The plan's `action` block already said "structured logger.log with `{phone, status}` is sufficient for this phase" — masking is the minimum necessary mitigation for the listed STRIDE threat.

### CLAUDE.md compliance

- §VIII.2 OWASP A02 (Cryptographic Failures): credentials never logged; token never persisted.
- §VIII.2 OWASP A09 (Logging Failures): delivery-status structured log added.
- §VIII.3 data residency: Eskiz is the named provider in REQUIREMENTS (and called from O'zbekiston-hosted backend); no cross-border data flow introduced.

No CLAUDE.md rules contradicted by this plan's instructions.

## Known Stubs

| Stub | File | Reason |
|---|---|---|
| `push` notifications | `notification.processor.ts:sendPush` | Firebase FCM deferred to Phase 5 per RESEARCH.md (NOTIF-02 out of Phase 1 scope) |
| `email` notifications | `notification.processor.ts:sendEmail` | Email provider deferred to Phase 5 per RESEARCH.md (NOTIF-03 out of Phase 1 scope) |

Both are documented stubs from prior research and remain unchanged by this plan.

## Self-Check: PASSED

| Artifact | Check | Result |
|---|---|---|
| `apps/backend/src/infra/sms/eskiz.client.ts` | File exists | FOUND |
| `apps/backend/src/infra/sms/eskiz.client.spec.ts` | File exists | FOUND |
| `apps/backend/src/infra/queue/notification.processor.ts` | File exists + contains `@Processor` | FOUND |
| `apps/backend/src/infra/queue/notification.processor.spec.ts` | File exists | FOUND |
| `apps/backend/src/infra/sms/sms.module.ts` | File exists | FOUND |
| `apps/backend/src/infra/queue/queue.module.ts` | File exists | FOUND |
| Commit `44b9ea0` (Task 1 RED) | Exists in git log | FOUND |
| Commit `24f39ea` (Task 2 GREEN) | Exists in git log | FOUND |
| Unexpected file deletions on the two new commits | none | clean |
