---
phase: 1
slug: infrastructure-hardening-authentication
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-06
updated: 2026-06-06
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 30 + ts-jest (apps/backend/jest.config.ts; testEnvironment node, rootDir src, .spec.ts) |
| **Config file** | apps/backend/jest.config.ts |
| **Quick run command** | `cd apps/backend && npx jest <path> -x` |
| **Full suite command** | `cd apps/backend && npm test` |
| **Estimated runtime** | ~60 seconds |
| **Coverage gate** | 80% lines (controllers/infra/guards excluded from collection) |
| **Notable** | `@nestjs/schedule` is mocked (src/__mocks__/@nestjs/schedule.ts) so crons are unit-testable by direct call |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/backend && npx jest <touched-spec> -x`
- **After every plan wave:** Run `cd apps/backend && npm test`
- **Before `/gsd-verify-work`:** Full suite green + manual registration smoke (OTP→verify→complete) against staging Eskiz
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 | 01 | 1 | NOTIF-01 | T-01-03 | Token cached, 401 re-auth (RED scaffold) | unit | `npx jest eskiz.client.spec notification.processor.spec` | ❌ Wave 0 (create) | ⬜ pending |
| 01-T2 | 01 | 1 | NOTIF-01, NOTIF-04 | T-01-02/03 | Eskiz client cached-token + enabled @Processor | unit | `npx jest eskiz.client.spec notification.processor.spec -x` | ✅ from 01-T1 | ⬜ pending |
| 01-T3 | 01 | 1 | AUTH-01 | T-01-01 | Live OTP SMS delivered (human checkpoint) | manual | live SMS to test phone | n/a | ⬜ pending |
| 02-T1 | 02 | 1 | INFRA-04 | T-02-01 | Vault throws in prod on missing token | unit | `npx jest vault.service.spec -x` | ❌ Wave 0 (create) | ⬜ pending |
| 02-T2 | 02 | 1 | INFRA-05 | T-02-02 | tzdata + TZ=Asia/Tashkent present | source/grep | grep tzdata + Asia/Tashkent | ✅ config | ⬜ pending |
| 02-T3 | 02 | 1 | INFRA-06 | T-02-03 | Composite index in schema | source/grep | grep `@@index([userId, calculatedAt])` | ✅ schema | ⬜ pending |
| 02-T4 | 02 | 1 | INFRA-06 | T-02-03 | [BLOCKING] index pushed to live DB | migration | `npx prisma db push --skip-generate` | n/a | ⬜ pending |
| 03-T1 | 03 | 1 | INFRA-01, AUTH-01 | T-03-01/04/05 | Redis atomic rate limit + OTP length | unit | `npx jest cache.service.spec auth.service.spec -x` | ❌ Wave 0 (create cache.service.spec) | ⬜ pending |
| 03-T2 | 03 | 1 | INFRA-03 | T-03-02 | @Public() bypass in guard | unit | `npx jest jwt-auth.guard.spec -x` | ❌ Wave 0 (create) | ⬜ pending |
| 03-T3 | 03 | 1 | INFRA-03 | T-03-03 | Public routes marked before global guard | source/grep | grep `@Public()` count >= 7 | ✅ controllers | ⬜ pending |
| 03-T4 | 03 | 1 | INFRA-03 | T-03-02/03 | Global JwtAuthGuard default-deny | unit | `npx jest jwt-auth.guard.spec -x` + grep app.module | ✅ from 03-T2 | ⬜ pending |
| 04-T1 | 04 | 2 | INFRA-02 | T-04-04 | Cookie contract (RED scaffold) | unit (controller) | `npx jest auth.controller.spec` | ❌ Wave 0 (create) | ⬜ pending |
| 04-T2 | 04 | 2 | INFRA-02 | T-04-01/02/03 | Backend sets/reads HttpOnly refresh cookie | unit (controller) | `npx jest auth.controller.spec -x` | ✅ from 04-T1 | ⬜ pending |
| 04-T3 | 04 | 2 | INFRA-02 | T-04-01 | withCredentials + no refresh in localStorage | source/grep | grep withCredentials >= 1 | ✅ frontend | ⬜ pending |
| 04-T4 | 04 | 2 | AUTH-02 | — | Bare /login → /uz-Latn/login | source/grep | grep localePrefix\|locales | ✅ middleware | ⬜ pending |
| 05-T1 | 05 | 1 | INFRA-07 | T-05-SC | Redis adapter in afterInit | source/grep | grep createAdapter >= 1 | ✅ gateway | ⬜ pending |
| 05-T2 | 05 | 1 | INFRA-08 | T-05-01/02 | Consumer routing + broker no-op (RED) | unit | `npx jest kafka-consumer.service.spec` | ❌ Wave 0 (create) | ⬜ pending |
| 05-T3 | 05 | 1 | INFRA-08 | T-05-01/02 | Kafka consumer routes events to gateway | unit | `npx jest kafka-consumer.service.spec -x` | ✅ from 05-T2 | ⬜ pending |
| 06-T1 | 06 | 3 | AUTH-03 | T-06-01/02/03 | OneID host/grant + cookie CSRF (mock) | unit | `npx jest iduz.service.spec -x` | ✅ extend existing | ⬜ pending |
| 06-T2 | 06 | 3 | AUTH-03 | T-06-03 | Live OneID handshake (human checkpoint) | manual | staging OAuth flow | n/a | ⬜ pending |
| 06-T3 | 06 | 3 | AUTH-04 | — | 14-day PENDING→CITIZEN cron + SMS enqueue | unit | `npx jest admin.service.spec -x` | ✅ extend existing | ⬜ pending |
| 06-T4 | 06 | 3 | INFRA-09, INFRA-10 | T-06-04/05 | PgBouncer + directUrl + replica compose | source/grep | grep pgbouncer + directUrl | ✅ config | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

> New spec files that must be created before/at the start of each plan (RESEARCH Validation Architecture identified these gaps — no controller/guard/vault/kafka/eskiz tests exist today).

- [ ] Jest config + test setup verified for apps/backend (exists; confirm discovery)
- [ ] `eskiz.client.spec.ts` — Eskiz SMS client mock (NOTIF-01, AUTH-01) — Plan 01 Task 1
- [ ] `notification.processor.spec.ts` — processor sms-routing (NOTIF-04) — Plan 01 Task 1
- [ ] `cache.service.spec.ts` — incrWithTtl atomic counter (INFRA-01) — Plan 03 Task 1
- [ ] `vault.service.spec.ts` — prod fail-hard (INFRA-04) — Plan 02 Task 1
- [ ] `jwt-auth.guard.spec.ts` — @Public() bypass + default-deny (INFRA-03) — Plan 03 Task 2/4
- [ ] `auth.controller.spec.ts` — refresh-cookie set/read (INFRA-02); FIRST controller test in the codebase — Plan 04 Task 1
- [ ] `kafka-consumer.service.spec.ts` — event→gateway routing + broker no-op (INFRA-08) — Plan 05 Task 2
- [ ] Redis test double (ioredis-mock or stubbed client) fixture for OTP rate-limit + adapter tests (INFRA-01/07)
- [ ] Eskiz fetch-mock fixture (jest.spyOn(global,'fetch')) for OTP send tests (AUTH-01, NOTIF-01)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live SMS delivery via Eskiz.uz | AUTH-01, NOTIF-01 | Requires real provider credentials + phone | POST /api/auth/otp/send to a test number; confirm SMS arrives within 30s (Plan 01 Task 3 checkpoint) |
| OneID PKCE live handshake | AUTH-03 | Requires real OneID client_id/secret + sso.egov.uz contract | Complete OAuth flow end-to-end against staging; confirm gov user auto-verified, PINFL from `pin` (Plan 06 Task 2 checkpoint) |
| Multi-instance WebSocket fan-out | INFRA-07 | Requires 2+ backend replicas + Redis in staging | Emit on instance A, confirm a client on instance B receives it |
| Cookie refresh loop (no 15-min logout) | INFRA-02 | Requires real browser session over access-token expiry | Login, wait past access TTL, confirm silent refresh via cookie; DevTools shows refreshToken HttpOnly, absent from localStorage |
| Prod Vault fail-hard | INFRA-04 | Requires prod-mode boot without VAULT_TOKEN | Boot with NODE_ENV=production and no VAULT_TOKEN; confirm startup aborts |
| PgBouncer/replica behavior | INFRA-09, INFRA-10 | Requires the prod compose stack | `docker compose -f docker-compose.prod.yml up`; confirm app connects via pgbouncer, migrations via directUrl |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are explicit Wave 0 / human-checkpoint manual entries
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (grep/source assertions count)
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready for execution
