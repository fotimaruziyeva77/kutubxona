---
phase: 01-infrastructure-hardening-authentication
plan: 06
subsystem: auth + infra
tags: [auth, oneid, oauth2, pkce, csrf, cron, pgbouncer, replication, prisma]
status: partial
checkpoint_pending: true
requires:
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-RESEARCH.md (AUTH-03/04, INFRA-09/10)"
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-01-SUMMARY.md (NOTIF-01 SMS pathway)"
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-02-SUMMARY.md (Asia/Tashkent TZ)"
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-03-SUMMARY.md (global JwtAuthGuard + @Public)"
  - "@.planning/phases/01-infrastructure-hardening-authentication/01-04-SUMMARY.md (cookie-parser + refresh cookie pattern)"
provides:
  - "OneID/ID.UZ OAuth2.0+PKCE flow targeting the official sso.egov.uz provider with cookie-anchored CSRF"
  - "Test coverage for the 14-day PENDING->CITIZEN cron (already-built logic; verify-only)"
  - "PgBouncer connection pooling and a Postgres streaming-replication standby in the production compose"
affects:
  - "apps/backend/src/modules/auth/iduz.service.ts"
  - "apps/backend/src/modules/auth/iduz.controller.ts"
  - "apps/backend/src/modules/auth/__tests__/iduz.service.spec.ts"
  - "apps/backend/src/modules/admin/__tests__/admin.service.spec.ts"
  - "apps/backend/prisma/schema.prisma"
  - "apps/backend/.env.example"
  - ".env.prod.example"
  - "docker-compose.prod.yml"
tech-stack:
  added: ["edoburu/pgbouncer:1.22.0", "postgres:15-alpine (streaming replica)"]
  patterns: ["HttpOnly cookie CSRF state", "Prisma directUrl for migrations", "transaction-mode connection pooling"]
key-files:
  created: []
  modified:
    - "apps/backend/src/modules/auth/iduz.service.ts (OneID host + grant flow + PINFL normalization)"
    - "apps/backend/src/modules/auth/iduz.controller.ts (@Public + cookie CSRF; refresh-cookie alignment)"
    - "apps/backend/src/modules/auth/__tests__/iduz.service.spec.ts (+94/-24 lines, +4 net tests)"
    - "apps/backend/src/modules/admin/__tests__/admin.service.spec.ts (+65/-8 lines, +3 net tests)"
    - "apps/backend/prisma/schema.prisma (datasource directUrl)"
    - "docker-compose.prod.yml (pgbouncer + postgres-replica services + volume)"
    - "apps/backend/.env.example + .env.prod.example (IDUZ_*, DIRECT_DATABASE_URL, DATABASE_REPLICA_URL, DB_REPLICATION_*)"
decisions:
  - "OneID provider contract (sso.egov.uz / one_authorization_code / one_access_token_identify / PINFL in `pin` field) coded against RESEARCH Assumption A2 — live confirmation deferred to Task 2 human-verify checkpoint pending IDUZ_CLIENT_ID/SECRET delivery"
  - "CSRF state moved from client-supplied body field to HttpOnly iduz_state cookie (timing-safe verification, one-shot — cleared post-check)"
  - "PgBouncer in transaction-pool mode (not session) for max client multiplexing; Prisma forced to disable prepared-statement caching via ?pgbouncer=true&connection_limit=1"
  - "Read replica infrastructure provisioned but app-side routing (2nd PrismaClient or @prisma/extension-read-replicas) deferred to Phase 2/5 where heavy read paths actually exist — replica must NEVER serve auth/transactional reads (replication lag = read-after-write bugs)"
  - "Existing AUTH-04 cron was NOT rewritten — research confirmed it was already implemented at admin.service.ts:77-105; Plan 01-06 only adds test coverage proving the Plan 01-01 (SMS) and Plan 01-02 (TZ) dependencies are now satisfied"
metrics:
  duration_minutes: 13
  completed_date: "2026-06-06"
  tasks_complete: 3
  tasks_deferred: 1
  tests_added: 7
  test_suite: "680/680 green (+6 net over 674 baseline)"
---

# Phase 1 Plan 6: OneID OAuth fix, AUTH-04 verify, PgBouncer + read replica Summary

JWT/PKCE OAuth2 integration repointed at the actual Uzbekistan OneID provider (sso.egov.uz) with the non-standard `.do` grant flow, cookie-anchored CSRF, and PINFL extraction from the OneID `pin` field; AUTH-04 14-day fallback cron locked in by tests proving its upstream SMS + TZ dependencies are satisfied; and the production Postgres tier hardened with PgBouncer transaction-mode pooling (Prisma directUrl for migrations) plus a streaming-replication standby for future analytics workloads. **Task 2 (live OneID handshake) DEFERRED pending IDUZ_CLIENT_ID/SECRET delivery — code path is complete; only the live test remains.**

## What was built

### Task 1 — OneID code-level fix (AUTH-03) — COMPLETE

| File | Change |
|---|---|
| `apps/backend/src/modules/auth/iduz.service.ts` | Rewritten endpoint targeting + grant flow. New `IDUZ_BASE_URL` env (default `https://sso.egov.uz`). Single `.do` endpoint for authorize + token + identify. `response_type=one_code`, PKCE (`code_challenge_method=S256`) preserved. Token grant `grant_type=one_authorization_code`. Userinfo POST `grant_type=one_access_token_identify`. PINFL normalized from `pin` (fallback `sub` / `pinfl`). OneID-specific fields (`full_name`, `sur_name`, `mid_name`, `birth_date` dd.mm.yyyy, `mob_phone_no`, `pport_no`) mapped to canonical `IduzUserInfo`. Production boot hard-fails when `IDUZ_CLIENT_ID/SECRET` are empty — no `dev-client` leak. |
| `apps/backend/src/modules/auth/iduz.controller.ts` | `@Public()` on `/authorize` and `/callback` (fixes the global-JwtAuthGuard lockout Plan 01-03 flagged). CSRF state now read from the `iduz_state` HttpOnly cookie set in `/authorize` and timing-safe verified in `/callback` — the previously-trusted client-supplied `expected_state` body field is gone (T-06-01 mitigation). Cookie cleared one-shot post-verification. Refresh token now rides the same Plan 01-04 HttpOnly cookie pattern (`/api/auth` scoped) instead of leaking via JSON body. |
| `apps/backend/src/modules/auth/__tests__/iduz.service.spec.ts` | Test contract rewritten: locks sso.egov.uz host, `one_code` response type, `one_authorization_code` token grant body, `one_access_token_identify` userinfo grant body, PINFL extraction from `pin` field, fallback to `sub`/`pinfl`, ConfigService-driven base URL with safe default. |
| `apps/backend/.env.example` + `.env.prod.example` | `IDUZ_BASE_URL` documented; prod hard-fail on missing `IDUZ_CLIENT_ID/SECRET` flagged. |

**Commits:**
- `e40bfd9` — feat(auth)(01-06): OneID host + grant + PINFL fix with cookie CSRF (AUTH-03 code)
- `fc91a93` — test(auth)(01-06): cover OneID authorize/token/userinfo with mocked fetch

### Task 2 — Live OneID handshake — DEFERRED (PENDING credentials)

**Status:** Code path complete. The only remaining work is a single live OAuth handshake against staging OneID. **No further code edits anticipated** unless the live contract differs from RESEARCH Assumption A2 in field-name or grant-string specifics — in which case the defensive normalization in `IduzService._normalizeUserInfo` makes any correction a one- or two-line change.

#### OneID credentials checklist (what to set when they arrive)

Set these in the staging backend's `.env` (or Vault) **before** running the live handshake:

```ini
IDUZ_BASE_URL=https://sso.egov.uz                     # confirm with provider (could be a staging subdomain)
IDUZ_CLIENT_ID=<value from OneID merchant portal>
IDUZ_CLIENT_SECRET=<value from OneID merchant portal>
IDUZ_REDIRECT_URI=https://staging.sifat.uz/auth/iduz/callback   # MUST match the URI registered with OneID
```

#### Manual test steps (run after credentials are set)

1. Restart the backend so ConfigService picks up the new IDUZ_* values. Verify boot does NOT throw "IDUZ_CLIENT_ID prod da majburiy".
2. From the frontend (or a curl client doing the PKCE dance), generate a `code_verifier` (random 43-128 chars), SHA-256 it, base64url-encode → `code_challenge`.
3. `GET /api/auth/iduz/authorize?code_challenge=<base64url>` — response should contain `{ url, state }`. Confirm `Set-Cookie: iduz_state=...; HttpOnly; SameSite=Lax; Path=/auth/iduz`. The `url` should be `https://sso.egov.uz/sso/oauth/Authorization.do?response_type=one_code&...`.
4. Follow the `url` in a browser. Authenticate with a OneID test account. OneID will redirect to `IDUZ_REDIRECT_URI` carrying `?code=...&state=...`.
5. The frontend `POST`s to `/api/auth/iduz/callback` with `{ code, state, code_verifier }` and the `iduz_state` cookie attached. Backend should:
   - Verify `state` matches the cookie (timing-safe), clear the cookie.
   - Exchange code at the OneID `.do` endpoint with `grant_type=one_authorization_code`.
   - Fetch userinfo with `grant_type=one_access_token_identify`.
   - Read PINFL from the `pin` field; auto-register / login the user as `CITIZEN`+`ACTIVE`.
   - Return `{ accessToken, isNew, userId }` and set the `refreshToken` HttpOnly cookie at `/api/auth`.
6. Confirm a real OneID user is auto-verified end-to-end and PINFL is populated in the DB (`select id, phone from "User" where "createdAt" > now() - interval '5 minutes'`).
7. **If the live contract differs from Assumption A2** (different grant_type string, different PINFL field name, etc.), apply the one-line corrections to `iduz.service.ts` and rerun.

#### Resume signal

Reply **"approved"** with the confirmed provider/grant details (or describe the failure and the correct contract).

### Task 3 — AUTH-04 verify-only — COMPLETE

The 14-day PENDING → CITIZEN fallback cron is **already implemented** at `admin.service.ts:77-105` (research confirmed). This plan only added test coverage to prove its two upstream dependencies are now satisfied:
1. Plan 01-01 (NOTIF-01): the `sms.sendNotification` path actually enqueues to BullMQ → EskizSmsClient (no longer a stub).
2. Plan 01-02 (INFRA-05): the `@Cron(EVERY_DAY_AT_1AM)` resolves against Asia/Tashkent wall-clock (validated at the Docker layer; the `@nestjs/schedule` mock lets us invoke the cron method directly here).

| File | Change |
|---|---|
| `apps/backend/src/modules/admin/__tests__/admin.service.spec.ts` | Three new tests: (a) cron's Prisma `findMany` filter shape locks the 14-day cutoff + `PENDING + sifatId != null` predicate, (b) SMS enqueue is asserted with exact `(phone, "...14 kun...", userId)` arguments, (c) negative path (empty stale list) confirms no `updateMany` and no SMS — i.e., recent PENDING users are correctly untouched. Existing single test split into focused cases. |

**No production code in `admin.service.ts` was touched.**

**Commit:** `34200f6` — test(admin)(01-06): verify 14-day PENDING->CITIZEN cron + SMS reminder (AUTH-04)

### Task 4 — PgBouncer + Postgres read replica (INFRA-09/10) — COMPLETE

| File | Change |
|---|---|
| `docker-compose.prod.yml` | New `pgbouncer` service (edoburu/pgbouncer:1.22.0, transaction mode, `MAX_CLIENT_CONN=1000`, `DEFAULT_POOL_SIZE=25`, `IGNORE_STARTUP_PARAMETERS=extra_float_digits`). New `postgres-replica` service (postgres:15-alpine; bootstraps via `pg_basebackup -R` on first start, runs `hot_standby=on`). Primary `postgres` now starts with `wal_level=replica`, `max_wal_senders=10`, `max_replication_slots=10` and exposes `POSTGRES_REPLICATION_USER`/`PASSWORD` for the standby. New volume `postgres_replica_data` at `/srv/sifat/data/postgres-replica`. Backend `depends_on` now includes `pgbouncer.condition: service_healthy`. |
| `apps/backend/prisma/schema.prisma` | Datasource `db` now declares `directUrl = env("DIRECT_DATABASE_URL")` so Prisma migrations bypass the pooler (DDL prepared statements need a real Postgres session). |
| `apps/backend/.env.example` | `DIRECT_DATABASE_URL` + `DATABASE_REPLICA_URL` documented (dev mirrors `DATABASE_URL` — no pooler/replica locally). |
| `.env.prod.example` | `DATABASE_URL` repointed at `pgbouncer:6432` with required `?pgbouncer=true&connection_limit=1`. `DIRECT_DATABASE_URL` added pointing at `postgres:5432`. `DATABASE_REPLICA_URL` added pointing at `postgres-replica:5432`. `DB_REPLICATION_USER` + `DB_REPLICATION_PASSWORD` added with a non-collision warning. |

**Application-side read-routing wiring** (a 2nd PrismaClient or `@prisma/extension-read-replicas`) is **out of scope** for this plan and deferred to Phase 2/5 where the heavy read paths (stats, leaderboards) actually live. The replica infrastructure + connection string is in place; the routing code lands when there's a query to route.

**Validation:**
- `grep -c pgbouncer docker-compose.prod.yml` = 7 (acceptance >= 1)
- `grep -c directUrl apps/backend/prisma/schema.prisma` = 2 (acceptance >= 1)
- `npx prisma validate` → schema valid
- Backend test suite: 680/680 green

**Commit:** `8eb71c4` — feat(infra)(01-06): PgBouncer + Postgres read replica in prod compose (INFRA-09/10)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Local .env missing DIRECT_DATABASE_URL after schema change**
- **Found during:** Task 4 (`npx prisma validate` after adding `directUrl` to schema)
- **Issue:** Schema declares `env("DIRECT_DATABASE_URL")` but the local `apps/backend/.env` had no such variable, so Prisma validation failed (`P1012: Environment variable not found`).
- **Fix:** Added `DIRECT_DATABASE_URL` (mirroring `DATABASE_URL` — no local pooler) and `DATABASE_REPLICA_URL` (mirroring `DATABASE_URL` — no local replica) to `apps/backend/.env`. The `.env` is gitignored so this is a local-only convenience; the contract is documented in `.env.example`.
- **Files modified:** `apps/backend/.env` (gitignored)
- **Commit:** N/A (gitignored file)

### Auth gates / Checkpoints

**Task 2 — DEFERRED.** The OneID live handshake checkpoint is intentionally not executed. Per the orchestrator's environment notes, `IDUZ_CLIENT_ID` / `IDUZ_CLIENT_SECRET` have not been provided. The code path is complete and the "OneID credentials checklist" + manual test steps above are the exact resume procedure.

### Pre-existing issue surfaced (NOT introduced by this plan)

`docker compose -f docker-compose.prod.yml config --quiet` returns exit code 1 with the message `can't set container_name and {backend|frontend} as container name must be unique: invalid compose project`. This is **pre-existing** behavior at HEAD-1 (verified by checking the same command against the parent commit) — the `backend` and `frontend` services have **both** `container_name` and `deploy.replicas > 1` set, which Compose v2 forbids. Plan 01-06 changes are YAML-valid (confirmed via Python yaml parser — all services present, all volumes declared, structure intact). This issue should be addressed in a follow-up infra plan; tracking as a deferred item rather than fixing in this plan to keep scope tight to AUTH-03/AUTH-04/INFRA-09/INFRA-10.

## Threat surface

| Mitigation | File | Status |
|---|---|---|
| T-06-01 (CSRF spoofing on OneID callback) | `iduz.controller.ts` | Cookie-anchored timing-safe state verification replaces body-trust |
| T-06-02 (client_secret / PINFL disclosure) | `iduz.service.ts` | No `dev-client` default in prod; PINFL flows server-side only through the `.do` identify call |
| T-06-03 (wrong IdP host) | `iduz.service.ts` | sso.egov.uz target; live confirmation deferred to Task 2 (Assumption A2) |
| T-06-04 (stale-replica reads on auth/transactional paths) | `docker-compose.prod.yml`, `.env.prod.example` | Documented constraint: replica is analytics-only; app-side routing not wired here |
| T-06-05 (Prisma + PgBouncer prepared-statement DoS) | `schema.prisma`, `.env.prod.example` | `?pgbouncer=true&connection_limit=1` + `directUrl` for migrations |
| T-06-SC (supply chain on PgBouncer image) | `docker-compose.prod.yml` | Pinned `edoburu/pgbouncer:1.22.0` |

## Self-Check: PASSED

- File `apps/backend/src/modules/auth/iduz.service.ts` → FOUND (rewrites verified, sso.egov.uz target confirmed via grep)
- File `apps/backend/src/modules/auth/iduz.controller.ts` → FOUND (@Public + cookie CSRF verified)
- File `apps/backend/src/modules/auth/__tests__/iduz.service.spec.ts` → FOUND (18/18 tests pass)
- File `apps/backend/src/modules/admin/__tests__/admin.service.spec.ts` → FOUND (12/12 tests pass)
- File `apps/backend/prisma/schema.prisma` → FOUND (`directUrl` present, `npx prisma validate` clean)
- File `docker-compose.prod.yml` → FOUND (pgbouncer + postgres-replica services present, volume declared)
- File `apps/backend/.env.example` → FOUND (IDUZ_BASE_URL, DIRECT_DATABASE_URL, DATABASE_REPLICA_URL documented)
- File `.env.prod.example` → FOUND (IDUZ_*, DATABASE_URL via pgbouncer, DIRECT_DATABASE_URL, DATABASE_REPLICA_URL, DB_REPLICATION_* documented)
- Commit `e40bfd9` → FOUND in git log
- Commit `fc91a93` → FOUND in git log
- Commit `34200f6` → FOUND in git log
- Commit `8eb71c4` → FOUND in git log
- Backend test suite → 680/680 green (+6 net over 674 baseline)
- TypeScript: `tsc --noEmit` → clean
- Prisma: `npx prisma validate` → schema valid

## CHECKPOINT REACHED

Task 2 (OneID live handshake) is deferred pending IDUZ_CLIENT_ID/SECRET delivery. All code-level work (Tasks 1, 3, 4) is complete and committed atomically. When credentials arrive, follow the "OneID credentials checklist" + "Manual test steps" above — no further code edits are anticipated.
