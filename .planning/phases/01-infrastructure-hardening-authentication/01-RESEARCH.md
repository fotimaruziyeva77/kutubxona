# Phase 1 Research — Infrastructure Hardening & Authentication

**Researched:** 2026-06-06
**Domain:** NestJS 10 backend hardening, JWT/cookie auth, SMS OTP (Eskiz.uz), OneID OAuth2 PKCE, Redis rate limiting, WebSocket scaling, Kafka consumers, Docker/Postgres production infra
**Confidence:** HIGH (every claim below is verified against the actual source files with file:line evidence)
**Phase type:** BROWNFIELD — most code exists; this phase fixes bugs and wires real integrations. No greenfield scaffolding.

---

## Executive Summary

Phase 1 is a **hardening-and-wiring phase**, not a build-from-scratch phase. The backend already has working JWT auth, an OTP flow, an ID.UZ controller, a WebSocket gateway, a Kafka producer, a notification queue, and a complete `User.PENDING → CITIZEN` 14-day cron. The work breaks into three buckets:

1. **Pure bug fixes / config (small, high-confidence):** move OTP rate-limit from an in-memory `Map` to Redis (INFRA-01), make Vault fail hard in prod (INFRA-04), add a `TZ=Asia/Tashkent` env + `@@index([userId, calculatedAt])` (INFRA-05/06), register `JwtAuthGuard` globally with a new `@Public()` decorator (INFRA-03), add the Socket.IO Redis adapter (INFRA-07), add a locale-redirect middleware tweak (AUTH-02).
2. **Real integration wiring (medium, external-dependency-gated):** implement the Eskiz.uz SMS HTTP client and re-enable the commented-out `@Processor` (NOTIF-01/NOTIF-04/C3) — **this unblocks the entire registration flow and AUTH-04's notifications**; activate a NestJS Kafka consumer (INFRA-08); correct and complete the OneID/ID.UZ endpoints (AUTH-03).
3. **Production infra additions (medium, ops-heavy):** PgBouncer connection pooling (INFRA-09) and a PostgreSQL read replica (INFRA-10) in `docker-compose.prod.yml`.

**Primary recommendation:** Do NOT treat this as 16 independent tasks. The notification fix (C3/NOTIF-01/NOTIF-04) is the keystone — OTP delivery (AUTH-01), admin approval SMS, and the AUTH-04 fallback SMS all silently no-op until it lands. Sequence it first. The two most error-prone correctness traps are: (a) the cookie refresh-token migration (INFRA-02) touches backend controller + axios client + Zustand store + CORS together and is easy to half-migrate, and (b) AUTH-03 OneID is currently pointed at the **wrong endpoints** (`sso.id.uz` instead of the official `sso.egov.uz`) and will not authenticate against real OneID.

---

## User Constraints

No `CONTEXT.md` exists for this phase (`.planning/phases/01-infrastructure-hardening-authentication/*-CONTEXT.md` not found). There are no locked decisions from a discuss-phase step. The constraints below are derived from `CLAUDE.md` (the full TZ, which carries locked-decision authority) and `.planning/STATE.md`.

### Locked Decisions (from CLAUDE.md / STATE.md)
- **Server localization (R1, CLAUDE.md §VIII):** All personal data must stay on Uzbekistan servers (Unicon.uz / TIF DC). Cloudflare is CDN-only. [CITED: CLAUDE.md §8.3]
- **JWT config (CLAUDE.md §8.1):** Access token 15 min HS256, refresh 30 days HttpOnly cookie, token rotation (old token revoked on refresh), bcrypt(12). [CITED: CLAUDE.md §8.1] — refresh-cookie part is the INFRA-02 requirement.
- **OTP rules (CLAUDE.md §SPRINT 2 / AUTH-01):** SMS OTP, 4-digit per §2.1 / 6-digit as currently coded, 2-minute expiry, rate limiting 5 attempts/hour. [CITED: CLAUDE.md §2.1, REQUIREMENTS AUTH-01]
- **ID.UZ (CLAUDE.md §8.1):** Government users via PKCE OAuth2.0. [CITED: CLAUDE.md §8.1]
- **ML fraud deferred to v2 (STATE.md):** Rule-based fraud with FLAGGED status is V1.0 scope. Not in Phase 1. [CITED: STATE.md Decisions]

### Claude's Discretion
- Exact Redis rate-limit key structure and atomic primitive (`INCR`+`EXPIRE` vs sorted-set sliding window).
- Whether OTP is 4-digit (TZ §2.1 prose) or 6-digit (current code). **Open question — flag for user.**
- SMS provider: Eskiz.uz is named in REQUIREMENTS; SMS.uz is mentioned as alternate in TZ. Recommend Eskiz.uz.
- Cookie `SameSite` policy (`lax` vs `strict`) and whether to keep access token client-readable while moving only the refresh token to a cookie.

### Deferred Ideas (OUT OF SCOPE for Phase 1)
- Python FastAPI AI Engine as the Kafka consumer (AI-V2-01). Phase 1 INFRA-08 = a **NestJS** consumer only.
- Firebase FCM push (NOTIF-02) → Phase 5.
- Email notifications (NOTIF-03) → Phase 5.
- RefreshToken table cleanup cron (M3 in PITFALLS) — not a Phase 1 requirement; note for Phase 2/backlog.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-01 | OTP rate limiting in Redis | Current state confirmed (`auth.service.ts:23,254`); fix = `CacheService` + atomic INCR/EXPIRE (needs new method) |
| INFRA-02 | Refresh tokens in HttpOnly cookies | Confirmed localStorage (`auth.store.ts:43-48`, `client.ts:26-35`, `auth.controller.ts:123`); fix = `cookie-parser` + `res.cookie` + axios `withCredentials` |
| INFRA-03 | Global JwtAuthGuard + @Public() | Confirmed only `ThrottlerGuard` global (`app.module.ts:77-83`); `@Public()` does not exist; fix = APP_GUARD + reflector check |
| INFRA-04 | Vault fails hard in prod | Confirmed silent fallback + `dev-root-token` (`vault.service.ts:15,24`); fix = `_assertEnvVars` + throw in prod |
| INFRA-05 | Docker TZ Asia/Tashkent | Confirmed absent in Dockerfile + both compose files; fix = `TZ` env + `tzdata` apk pkg |
| INFRA-06 | ReadingIndex composite index | Confirmed `ReadingIndex` model has ZERO indexes (`schema.prisma:316-323`); fix = `@@index([userId, calculatedAt])` + migration |
| INFRA-07 | StatsGateway Redis adapter | Confirmed default in-memory adapter (`stats.gateway.ts`, `gateway.module.ts`); fix = `@socket.io/redis-adapter` in `afterInit` |
| INFRA-08 | Kafka consumer activated | Confirmed producer-only (`kafka.service.ts`), no `@EventPattern` anywhere; fix = new NestJS consumer |
| INFRA-09 | PgBouncer pooling | Confirmed absent in `docker-compose.prod.yml`; fix = new service + `DATABASE_URL` via pgbouncer |
| INFRA-10 | Postgres read replica | Confirmed absent; fix = streaming replica service + read-routing strategy |
| AUTH-01 | Eskiz.uz OTP, 2-min, 5/hr | OTP flow exists (`auth.service.ts:66-99`); SMS delivery is a no-op stub; depends on NOTIF-01 |
| AUTH-02 | Auth pages without locale prefix | Confirmed all routes under `app/[locale]/` (login, register); middleware does not handle bare `/login` |
| AUTH-03 | ID.UZ PKCE OAuth2.0 | Substantially implemented (`iduz.service.ts`, `iduz.controller.ts`) BUT **wrong endpoints** (`sso.id.uz` ≠ official `sso.egov.uz`) and weak state check |
| AUTH-04 | PENDING→citizen after 14 days | **Already implemented** (`admin.service.ts:77-105`); only gap = the SMS it sends is a no-op until NOTIF-01 |
| NOTIF-01 | Eskiz.uz delivery + status tracking | Stub (`notification.processor.ts:57-59`); the core build of this phase |
| NOTIF-04 | Notification processor enabled | Confirmed `@Processor` commented out (`notification.processor.ts:15`); fix = uncomment + wire to NOTIF-01 |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| OTP generation + rate limit | API / Backend | Redis | Security state must be server-side and shared across replicas |
| SMS delivery | API / Backend (BullMQ worker) | Eskiz.uz (external) | Async, retriable; never block the request thread |
| Refresh token storage | Browser (HttpOnly cookie, set by API) | API | Cookie is set/read by server; JS must NOT read it (XSS defense) |
| Access token storage | Browser (memory / Zustand) | — | Short-lived; acceptable client-side, sent as Bearer header |
| Auth route protection | API / Backend (global guard) | — | Default-deny at the framework layer, not per-controller |
| Locale routing | Frontend Server (Next.js middleware) | — | SSR redirect before render; not a backend concern |
| OneID OAuth exchange | API / Backend | sso.egov.uz (external) | client_secret + PINFL must never touch the browser |
| WebSocket fan-out | API / Backend | Redis (pub/sub adapter) | Multi-replica delivery requires shared bus |
| Kafka event consumption | API / Backend (NestJS consumer) | Kafka | Server-side event processing |
| Connection pooling / replica | Database / Storage (PgBouncer, replica) | — | Infra layer, transparent to app code via connection strings |

---

## Current State Audit (per requirement, with file:line evidence)

### INFRA-01 — OTP rate limiting uses in-memory Map — FIX
- **Evidence:** `apps/backend/src/modules/auth/auth.service.ts:23` → `private readonly sendLog = new Map<string, number[]>();`. Logic at lines 254-263 (`checkRateLimit`) filters timestamps in-process. [VERIFIED: codebase]
- **Note:** There is ALSO a `@nestjs/throttler` decorator on the controller (`auth.controller.ts:83` → `@Throttle({ strict: { ttl: 3_600_000, limit: 5 } })`). This is IP/route-based and is a separate, partial layer — it does NOT key on phone number and is also in-memory by default. The requirement targets the `Map` specifically.
- **Verdict:** FIX existing. Replace the `Map` with Redis. `CacheService` exists (`infra/cache/cache.service.ts`) but exposes only `get/set/del/remember` — **no atomic `incr`/`expire`**. Must add an `incr(key, ttlSeconds)` method or use the raw `ioredis` client.

### INFRA-02 — Refresh tokens in localStorage — FIX (multi-file)
- **Evidence (frontend store):** `apps/frontend/store/auth.store.ts:43-48` writes both tokens to `localStorage`; `partialize` (lines 63-68) persists `refreshToken` to the `sifat-auth` localStorage key via Zustand `persist`.
- **Evidence (axios):** `apps/frontend/lib/api/client.ts:26-35` reads `refreshToken` from `localStorage` and POSTs it in the JSON body to `/api/auth/refresh`.
- **Evidence (backend):** `auth.controller.ts:118-125` returns `{ accessToken, refreshToken }` in the JSON response body; `auth.service.ts:189-202` `refreshToken()` takes the token from the request body (`RefreshTokenDto`). No cookie is ever set.
- **Verdict:** FIX. This is the highest-coordination task in the phase — backend `/refresh` and `/login` and `/register/complete` must `res.cookie('refreshToken', ...)` (HttpOnly, Secure in prod, SameSite); axios must use `withCredentials: true`; the store must stop persisting `refreshToken`; CORS already has `credentials: true` (`main.ts:57`) — good.

### INFRA-03 — JwtAuthGuard not global, no @Public() — FIX
- **Evidence:** `apps/backend/src/app.module.ts:77-83` registers only `ThrottlerGuard` as `APP_GUARD`. `JwtAuthGuard` is applied per-route via `@UseGuards(JwtAuthGuard)` (e.g., `auth.controller.ts:130`). No `@Public()` decorator exists in `common/decorators/` (only `current-user.decorator.ts`, `roles.decorator.ts`). [VERIFIED: codebase]
- **Risk (PITFALLS M1):** `RolesGuard.canActivate` returns `true` when no `@Roles()` is present (`roles.guard.ts:17`), so any controller missing BOTH guards is unprotected. Making `JwtAuthGuard` global closes this.
- **Verdict:** FIX. Add `@Public()` (`SetMetadata('isPublic', true)`), make `JwtAuthGuard` read the reflector and skip public routes, register globally. **Gotcha:** the global `JwtAuthGuard` currently has no public-route awareness — registering it global as-is will 401 the login/OTP/landing/health endpoints. Public routes that MUST be marked `@Public()`: `auth/login`, `auth/otp/send`, `auth/otp/verify`, `auth/register/complete`, `auth/password/reset`, `auth/refresh`, all `auth/iduz/*`, `health`, `/`, all public landing/top/search GET endpoints, payment webhooks. This requires a controller audit.

### INFRA-04 — Vault soft fallback + hardcoded dev token — FIX
- **Evidence:** `apps/backend/src/infra/vault/vault.service.ts:15` → `token: this.config.get<string>("VAULT_TOKEN") ?? "dev-root-token"`. `onModuleInit` (lines 19-26) catches health failure and only `logger.warn`s. `main.ts:117-122` `_assertEnvVars` checks `DATABASE_URL/JWT_SECRET/JWT_REFRESH_SECRET/REDIS_URL` but **not** `VAULT_TOKEN`/`VAULT_ADDR`. [VERIFIED: codebase]
- **Verdict:** FIX. Add `VAULT_TOKEN`+`VAULT_ADDR` to `_assertEnvVars` (prod), remove the `?? "dev-root-token"` default in prod, throw on health failure when `NODE_ENV === production`.
- **Dependency-at-risk (CONCERNS):** `node-vault@0.12` is barely maintained (last major 2021). Replacement is out of Phase 1 scope but note for backlog.

### INFRA-05 — Docker timezone not set — FIX (config)
- **Evidence:** No `TZ` env in `apps/backend/Dockerfile` (read in full), nor in `docker-compose.yml` (infra-only; no backend service — backend runs via `npm run dev` locally) nor `docker-compose.prod.yml` backend service (lines 38-74). [VERIFIED: codebase]
- **Crons affected:** `admin.service.ts` uses `@Cron(CronExpression.EVERY_DAY_AT_1AM)` etc. `@nestjs/schedule` resolves these against the **process** timezone. Without `TZ`, "1 AM" = 1 AM UTC = 6 AM Tashkent (UZ is UTC+5). [CITED: PITFALLS UZ5]
- **Verdict:** FIX. Set `TZ=Asia/Tashkent` in the prod compose backend `environment:` AND install `tzdata` in the Alpine Dockerfile (`apk add --no-cache tzdata`) — Alpine has no tz database by default, so `TZ` alone is silently ignored. **This is the classic Alpine gotcha.** Alternatively, pin each cron to an explicit UTC time. Recommend `tzdata` + `TZ` env for clarity.

### INFRA-06 — ReadingIndex missing composite index — FIX (schema)
- **Evidence:** `apps/backend/prisma/schema.prisma:316-323`. The `ReadingIndex` model has `userId`, `score`, `components`, `calculatedAt` and **no `@@index` at all**. [VERIFIED: codebase]
- **Verdict:** FIX. Add `@@index([userId, calculatedAt])`. Generate a Prisma migration. **Gotcha:** on an already-populated prod table this is a locking `CREATE INDEX` — use `CREATE INDEX CONCURRENTLY` (Prisma migrations don't emit this automatically; may need a hand-edited migration with `CONCURRENTLY` outside a transaction). On a fresh/dev DB it's trivial.

### INFRA-07 — WebSocket no Redis adapter — FIX
- **Evidence:** `apps/backend/src/infra/gateway/stats.gateway.ts` — `@WebSocketGateway` with `path:/ws`, `namespace:/stats`, default adapter. No `afterInit`, no `adapter()` call. `gateway.module.ts` provides only `StatsGateway`. `@socket.io/redis-adapter` is not installed. [VERIFIED: codebase]
- **Verdict:** FIX. Install `@socket.io/redis-adapter` (verified v8.3.0). Wire two `ioredis` clients (pub/sub) in `afterInit`. **Gotcha:** also needs Nginx sticky sessions for multi-replica WS (`ip_hash`) — note for the prod Nginx config. Also: WS connection currently has **no JWT auth** in `handleConnection` (`stats.gateway.ts:45-48`) — out of strict Phase 1 scope but a related security gap (PITFALLS anti-pattern #6).

### INFRA-08 — Kafka consumer not activated — NEW (within NestJS)
- **Evidence:** `apps/backend/src/infra/kafka/kafka.service.ts` is producer-only. Grep for `EventPattern|MessagePattern|consumer` across `src/` returned **zero** matches. [VERIFIED: codebase]
- **Verdict:** NEW build (small). Per STATE.md, the Python AI Engine consumer is v2-deferred, so Phase 1 INFRA-08 = a NestJS consumer that subscribes to the existing topics (`fraud.detected`, `tuman.ri.dropped`, etc., defined in `KAFKA_TOPICS`) and routes to `StatsGateway`/services. **Gotcha:** Kafka degrades gracefully (`KAFKA_BROKERS` optional); the consumer must also no-op cleanly when brokers are absent so dev/test don't break.

### INFRA-09 — PgBouncer absent — NEW (infra)
- **Evidence:** No `pgbouncer` service in `docker-compose.prod.yml` (read services lines 12-279). Backend connects directly to `postgres:5432` via `DATABASE_URL`. [VERIFIED: codebase]
- **Verdict:** NEW. Add `edoburu/pgbouncer` service; point prod `DATABASE_URL` at pgbouncer:6432. **Gotcha (critical):** Prisma + PgBouncer requires `pgbouncer=true` in the connection string and **transaction** pool mode; prepared statements break in transaction mode without it. Migrations must run against the **direct** Postgres connection (`directUrl` in Prisma datasource), not through PgBouncer.

### INFRA-10 — Read replica absent — NEW (infra)
- **Evidence:** Single `postgres` service in prod compose. No replica, no read-routing in code (`PrismaService` is a single client). [VERIFIED: codebase]
- **Verdict:** NEW (heaviest infra task). Add a streaming-replication standby Postgres service. App-side read routing options: (a) a second `PrismaClient` pointed at the replica for known-heavy read paths (stats/leaderboards), or (b) the `@prisma/extension-read-replicas` extension. **Gotcha:** replication lag means reads-after-writes can be stale; only route analytics/leaderboard queries, never auth/transaction reads. This is the lowest-urgency Phase 1 item (it's a scale optimization, not a correctness fix) — consider gating behind a checkpoint or deferring if scope pressure.

### AUTH-01 — Eskiz.uz OTP, 2-min, 5/hr — PARTIAL (depends on NOTIF-01)
- **Evidence:** OTP generation/expiry exists (`auth.service.ts:86-87`, `OTP_TTL_MS = 2*60*1000` line 13 ✓ 2-min). `sendOtp` enqueues via `sms.sendOtp` (`sms.service.ts:15-30`) → BullMQ `notifications` queue → `NotificationProcessor.sendSms` which is a `logger.debug` no-op. So OTP is **generated and stored but never sent**. [VERIFIED: codebase]
- **Note:** OTP is currently **6 digits** (`auth.service.ts:86` `100000 + random*900000`) and `VerifyOtpDto` enforces `@Length(6,6)`. TZ §2.1 prose says "4 raqam". **Discrepancy — open question.**
- **Verdict:** Mostly wiring NOTIF-01 + moving rate-limit to Redis (INFRA-01). 5/hr already enforced (in-memory + throttler).

### AUTH-02 — Auth pages without locale prefix — FIX (frontend)
- **Evidence:** `apps/frontend/middleware.ts` uses bare `createMiddleware({locales, defaultLocale})` with matcher excluding `/api,_next,...`. All routes live under `app/[locale]/` (confirmed: `login`, `register`, `dashboard`, etc.). next-intl default `localePrefix` is `always`, so a bare `/login` 404s or redirects inconsistently. [VERIFIED: codebase]
- **Verdict:** FIX (small). next-intl middleware already redirects `/` → `/uz-Latn` by default; the requirement wants bare `/login` → `/uz-Latn/login`. Confirm `localePrefix` strategy and that the matcher covers `/login`, `/register`. May need `localePrefix: 'as-needed'` or explicit rewrite. Low risk.

### AUTH-03 — ID.UZ PKCE — IMPLEMENTED BUT WRONG ENDPOINTS — FIX (correctness-critical)
- **Evidence:** `iduz.service.ts` + `iduz.controller.ts` implement the full PKCE dance (build auth URL with `code_challenge`/`S256`, exchange code+verifier, fetch userinfo, login-or-register). Endpoints hardcoded at `iduz.service.ts:24-26`:
  - `authUrl = https://sso.id.uz/auth/oauth2/v1/authorize`
  - `tokenUrl = https://sso.id.uz/auth/oauth2/v1/token`
  - `userInfoUrl = https://sso.id.uz/auth/oauth2/v1/userinfo`
- **PROBLEM [VERIFIED: web research]:** The official Uzbekistan government identity system is **OneID at `sso.egov.uz`** (authorization endpoint `https://sso.egov.uz/sso/oauth/Authorization.do`), not `sso.id.uz`. OneID uses a **non-standard** flow: a single `.do` endpoint with `grant_type=one_authorization_code` (token) and `grant_type=one_access_token_identify` (userinfo), and returns the PINFL in a `pin` field (plus `full_name`, `sur_name`, `mid_name`, `birth_date`, `mob_phone_no`, `pport_no`). It is NOT a textbook `response_type=code` + `/userinfo` OIDC provider.
- **Other gaps:** State CSRF check (`iduz.controller.ts:60-65`) trusts a client-supplied `expected_state` from the body instead of reading the httpOnly `iduz_state` cookie set in `/authorize` (lines 34-39) — the cookie is set but never verified against. `clientId` defaults to `dev-client` (line 32).
- **Verdict:** FIX (significant). The endpoint URLs and grant flow must be reconciled with the **actual OneID provider contract** the project has been granted. **This requires the official OneID merchant/integration docs and credentials — an external dependency and an open question.** If the project genuinely has an `id.uz` (vs `egov.uz`) contract, confirm which provider. Until confirmed, AUTH-03 cannot be verified end-to-end. Also fix the state check to use the cookie.

### AUTH-04 — PENDING → citizen after 14 days — ALREADY IMPLEMENTED
- **Evidence:** `apps/backend/src/modules/admin/admin.service.ts:77-105` → `@Cron(CronExpression.EVERY_DAY_AT_1AM) autoFallbackPendingUsers()`: finds `PENDING` users with `sifatId != null` and `createdAt < now-14d`, bulk-updates to `ACTIVE`+`CITIZEN`, sends SMS. A 7-day reminder cron exists too (lines 108-136). `PENDING_AUTO_FALLBACK_DAYS = 14` (line 8). [VERIFIED: codebase]
- **Verdict:** NO new logic needed. The ONLY gap is that the SMS it sends is a no-op until NOTIF-01 lands, and the `@Cron` fires at the wrong wall-clock time until INFRA-05 (TZ) lands. Phase 1 just needs to make those two dependencies real and add a test. **Do not let the planner re-build this.**

### NOTIF-01 / NOTIF-04 — Notification processor stubbed + @Processor commented — NEW (keystone)
- **Evidence:** `apps/backend/src/infra/queue/notification.processor.ts:15` → `// @Processor(NOTIFICATION_QUEUE)` commented out; the class is registered as a plain provider in `queue.module.ts:40` but without the decorator BullMQ never binds it to the queue. `sendSms` (lines 57-59), `sendPush`, `sendEmail` are `logger.debug` stubs. [VERIFIED: codebase]
- **Verdict:** NEW build (the real work of the phase). (1) Uncomment `@Processor(NOTIFICATION_QUEUE)` and re-import the constant. (2) Implement `sendSms` against Eskiz.uz HTTP API (auth → token cache → send → optional status callback). (3) Add a delivery-status field/log for tracking (NOTIF-01 says "status tracking"). Push/email stay stubs (Phase 5). **Gotcha:** the processor must obtain an Eskiz auth token and cache it (Eskiz tokens are bearer JWTs with a TTL ~30 days; re-auth on 401). Do NOT auth per-message.

---

## Fix Approaches (per requirement)

| Req | NEW or FIX | Approach (specific) | Files touched |
|-----|-----------|---------------------|---------------|
| INFRA-01 | FIX | Add `incr(key, ttl)` to `CacheService` (ioredis `INCR`+`EXPIRE`); rewrite `checkRateLimit` → `await cache.incr('otp:rl:'+phone, 3600)`; throw at >5. Remove `sendLog` Map. | `cache.service.ts`, `auth.service.ts`, `auth.module.ts` (inject CacheService — needs CacheModule import; it's exported by AppInfraModule) |
| INFRA-02 | FIX | Backend: `cookie-parser` middleware in `main.ts`; `/login`,`/register/complete`,`/refresh` set `res.cookie('refreshToken', t, {httpOnly:true, secure:isProd, sameSite:'lax', maxAge:30d, path:'/api/auth'})`; `/refresh` reads `req.cookies.refreshToken`; remove refresh from JSON body. Frontend: axios `withCredentials:true`; stop persisting `refreshToken` in Zustand `partialize`; `/refresh` call carries cookie automatically. | `main.ts`, `auth.controller.ts`, `auth.service.ts`, `client.ts`, `auth.store.ts` |
| INFRA-03 | FIX | New `@Public()` decorator (`SetMetadata('isPublic',true)`); modify `JwtAuthGuard.canActivate` to read `reflector.getAllAndOverride('isPublic', [handler,class])` and return true if public; register `{provide:APP_GUARD, useClass:JwtAuthGuard}` in `app.module.ts` AFTER ThrottlerGuard; audit all controllers, mark public routes. | `common/decorators/public.decorator.ts` (new), `jwt-auth.guard.ts`, `app.module.ts`, every controller with public routes |
| INFRA-04 | FIX | Add `VAULT_TOKEN`,`VAULT_ADDR` to `_assertEnvVars` list; in `VaultService` ctor remove `?? "dev-root-token"` when prod; in `onModuleInit` `throw` on health fail when `NODE_ENV==='production'`. | `main.ts`, `vault.service.ts` |
| INFRA-05 | FIX | Dockerfile: `RUN apk add --no-cache tzdata` + `ENV TZ=Asia/Tashkent`. Prod compose backend `environment: TZ: Asia/Tashkent`. | `apps/backend/Dockerfile`, `docker-compose.prod.yml` |
| INFRA-06 | FIX | `@@index([userId, calculatedAt])` on `ReadingIndex`; `prisma migrate dev` then hand-edit prod migration to `CREATE INDEX CONCURRENTLY`. | `schema.prisma`, new migration |
| INFRA-07 | FIX | Install `@socket.io/redis-adapter@8`; in `StatsGateway.afterInit(server)` create pub/sub ioredis clients and `server.adapter(createAdapter(pub,sub))`. Add Nginx `ip_hash` note. | `stats.gateway.ts`, `gateway.module.ts`, prod Nginx conf |
| INFRA-08 | NEW | New `KafkaConsumerService` (NestJS `@nestjs/microservices` Kafka transport OR a kafkajs consumer in `onModuleInit`); subscribe to `fraud.detected`,`tuman.ri.dropped`; route to `StatsGateway.emitNewAlert`. No-op when `KAFKA_BROKERS` unset. | new `infra/kafka/kafka-consumer.service.ts`, `kafka.module.ts` |
| INFRA-09 | NEW | `edoburu/pgbouncer:1.22.0` service; prod `DATABASE_URL=...pgbouncer:6432/sifat?pgbouncer=true`; add Prisma `directUrl` for migrations. | `docker-compose.prod.yml`, `schema.prisma` datasource, `.env.prod` |
| INFRA-10 | NEW | Standby `postgres` replica (streaming repl); `DATABASE_REPLICA_URL`; route stats/leaderboard reads via 2nd PrismaClient or `@prisma/extension-read-replicas`. | `docker-compose.prod.yml`, `prisma.service.ts`/new read client |
| AUTH-01 | FIX | Falls out of NOTIF-01 + INFRA-01. Confirm 4-vs-6 digit with user. | (covered above) |
| AUTH-02 | FIX | Set next-intl `localePrefix` strategy so bare `/login`→`/uz-Latn/login`; verify matcher. | `middleware.ts`, possibly `i18n.ts` |
| AUTH-03 | FIX | Reconcile endpoints with actual OneID (`sso.egov.uz` likely) + grant flow; fix state-cookie verification; require real `IDUZ_CLIENT_ID/SECRET`. **Blocked on provider contract.** | `iduz.service.ts`, `iduz.controller.ts` |
| AUTH-04 | (none) | Already implemented. Add a unit test for the cron; ensure SMS (NOTIF-01) + TZ (INFRA-05) land. | test only |
| NOTIF-01 | NEW | Eskiz HTTP client: `POST {base}/api/auth/login` (email+password → token), cache token, `POST {base}/api/message/sms/send` ({mobile_phone, message, from, callback_url}); persist delivery status. | `notification.processor.ts`, new `infra/sms/eskiz.client.ts`, config |
| NOTIF-04 | FIX | Uncomment `@Processor(NOTIFICATION_QUEUE)` + re-import constant; ensure provider registered. | `notification.processor.ts` |

---

## Library & Dependency Recommendations

All packages verified against the npm registry (2026-06-06) and passed slopcheck (`3 OK`).

| Package | Version | Purpose | Status | Provenance |
|---------|---------|---------|--------|-----------|
| `@socket.io/redis-adapter` | 8.3.0 | Multi-replica WebSocket fan-out (INFRA-07) | NEW | [VERIFIED: npm registry] (npm view: 8.3.0, modified 2024-03-13; slopcheck OK; named in STACK.md + socket.io official docs) |
| `@nestjs/microservices` | 10.x (match NestJS 10; 10.0.0 exists) | Kafka consumer transport (INFRA-08) | NEW (optional) | [VERIFIED: npm registry] (slopcheck OK; official NestJS package). **Pin to ^10 to match installed NestJS 10, NOT 11.** |
| `cookie-parser` | 1.4.7 | Read `req.cookies.refreshToken` (INFRA-02) | NEW | [VERIFIED: npm registry] (npm view 1.4.7; slopcheck OK) |
| `@types/cookie-parser` | 1.4.10 | Types for above | NEW (dev) | [VERIFIED: npm registry] |
| `ioredis` | 5.4 (installed) | Redis OTP rate limit + WS adapter pub/sub | EXISTING | [VERIFIED: codebase] already a dependency |
| `kafkajs` | 2.2 (installed) | Kafka consumer (alternative to @nestjs/microservices) | EXISTING | [VERIFIED: codebase] — INFRA-08 can be built on the existing kafkajs client without adding @nestjs/microservices |
| `tzdata` (Alpine apk) | OS pkg | Timezone DB for INFRA-05 | NEW (Docker) | [VERIFIED: Alpine] required for `TZ` to work on alpine |

**Eskiz.uz integration — do NOT add a wrapper package.** The npm package `eskiz-sms` exists but is an unofficial third-party wrapper. Recommend a **direct HTTP client** (native `fetch`, already used in `iduz.service.ts`) against the official Eskiz REST API. This avoids supply-chain risk and matches the codebase's existing pattern. [ASSUMED — Eskiz endpoint paths below need confirmation against the live Eskiz dashboard/Postman docs.]

**Decision: kafkajs vs @nestjs/microservices for INFRA-08.** Recommend building the consumer on the **already-installed kafkajs** client (a simple `consumer.subscribe`+`consumer.run` in a NestJS provider's `onModuleInit`). Reasons: (1) zero new dependency, (2) avoids the `@nestjs/microservices` v10-vs-v11 version-matching footgun, (3) the producer already uses kafkajs so the consumer shares config. Use `@nestjs/microservices` only if the planner prefers the `@EventPattern` decorator ergonomics.

**Installation:**
```bash
cd apps/backend
npm install @socket.io/redis-adapter@^8 cookie-parser
npm install -D @types/cookie-parser
# @nestjs/microservices@^10 ONLY if choosing the decorator-based consumer
cd ../frontend
# no new deps — axios already installed; only config changes
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@socket.io/redis-adapter` | npm | ~6 yrs (8.3.0 2024) | very high | github.com/socketio/socket.io-redis-adapter | [OK] | Approved |
| `@nestjs/microservices` | npm | ~7 yrs | very high | github.com/nestjs/nest | [OK] | Approved (pin ^10) |
| `cookie-parser` | npm | ~12 yrs | ~30M/wk | github.com/expressjs/cookie-parser | [OK] | Approved |
| `@types/cookie-parser` | npm | DefinitelyTyped | high | github.com/DefinitelyTyped/DefinitelyTyped | [OK] (transitively) | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.
**Not recommended (supply-chain caution):** `eskiz-sms` (unofficial wrapper) — use direct HTTP instead. Not installed.

slopcheck v0.6.1 ran successfully and rated all three scanned packages `[OK]`. (Eskiz is not an npm package in this design, so no scan applies.)

---

## Architecture Patterns

### System Architecture Diagram (Phase 1 scope)

```
                         ┌─────────────── Browser (Next.js client) ───────────────┐
  /login (no prefix)     │  Zustand store (access token in memory only)            │
        │                │  axios { withCredentials:true }                         │
        ▼                │     │  Authorization: Bearer <access>                    │
  Next.js middleware ────┼─────┼──── redirect → /uz-Latn/login  (AUTH-02)           │
  (locale redirect)      │     │  refreshToken → HttpOnly cookie (browser-managed)  │
                         └─────┼──────────────────────┬─────────────────────────────┘
                               │ HTTPS                 │ Set-Cookie (INFRA-02)
                               ▼                       ▼
        ┌──────────────────────── NestJS API (3 replicas) ──────────────────────────┐
        │  cookie-parser → global JwtAuthGuard(+@Public) (INFRA-03)                  │
        │     │ public: /auth/*, /health, landing                                    │
        │     ▼                                                                       │
        │  AuthService.sendOtp ── rate limit → Redis INCR otp:rl:{phone} (INFRA-01)   │
        │     │ generate OTP, store OtpCode (2-min)                                   │
        │     ▼                                                                       │
        │  SmsService.sendOtp → BullMQ 'notifications' queue ──────────┐              │
        │                                                              ▼              │
        │  NotificationProcessor @Processor (NOTIF-04) ── sendSms → Eskiz HTTP        │
        │       │ token cache (re-auth on 401)            (NOTIF-01/AUTH-01)          │
        │       ▼                                                                      │
        │  AdminService.autoFallbackPending @Cron 1AM (TZ=Asia/Tashkent, INFRA-05)    │
        │       └─ PENDING→CITIZEN +SMS (AUTH-04, already built)                       │
        │                                                                              │
        │  IduzController/Service ── PKCE → sso.egov.uz (AUTH-03, endpoint fix)        │
        │                                                                              │
        │  KafkaConsumerService (INFRA-08) ◄── Kafka topics ◄── KafkaService producer  │
        │       └─→ StatsGateway.emitNewAlert                                          │
        │  StatsGateway ── @socket.io/redis-adapter (INFRA-07) ─► all replicas         │
        └───────┬──────────────────────────┬───────────────────────┬──────────────────┘
                │ Vault (fail-hard prod)    │ DATABASE_URL          │ Redis (pub/sub + cache + BullMQ)
                ▼ (INFRA-04)                ▼ via PgBouncer (INFRA-09)
           HashiCorp Vault          PgBouncer ─► Postgres primary ──(stream repl)──► Read replica (INFRA-10)
                                                  + @@index([userId,calculatedAt]) (INFRA-06)
```

### Pattern 1: Redis atomic rate limiting (INFRA-01)
**What:** Fixed-window counter via `INCR`+`EXPIRE`. **When:** per-phone OTP throttle that survives restarts and is shared across replicas.
```typescript
// Source: ioredis docs + Redis rate-limit pattern (CacheService extension)
async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const n = await this.client.incr(key);
  if (n === 1) await this.client.expire(key, ttlSeconds); // set TTL only on first hit
  return n;
}
// in AuthService.sendOtp:
const count = await this.cache.incrWithTtl(`otp:rl:${phone}`, 3600);
if (count > OTP_RATE_LIMIT_PER_HOUR) throw new BadRequestException("Juda ko'p so'rov — 1 soatdan so'ng urinib ko'ring");
```

### Pattern 2: Global JwtAuthGuard with @Public() (INFRA-03)
```typescript
// Source: NestJS authentication docs (global guard + metadata bypass)
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

// JwtAuthGuard.canActivate (add at top):
const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
if (isPublic) return true;
// ...existing token verification...
// app.module.ts providers: { provide: APP_GUARD, useClass: JwtAuthGuard }
```

### Pattern 3: Socket.IO Redis adapter (INFRA-07)
```typescript
// Source: socket.io.dev/docs/v4/redis-adapter
import { createAdapter } from '@socket.io/redis-adapter';
afterInit(server: Server) {
  const pub = new Redis(process.env.REDIS_URL!);
  const sub = pub.duplicate();
  server.adapter(createAdapter(pub, sub));
}
```

### Pattern 4: HttpOnly refresh cookie (INFRA-02)
```typescript
// Source: OWASP token-storage guidance
res.cookie('refreshToken', refreshToken, {
  httpOnly: true, secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/api/auth',
});
// /refresh reads: const token = req.cookies?.refreshToken;
```

### Anti-Patterns to Avoid
- **Auth per SMS message** to Eskiz — cache the token (TTL ~30d), re-auth only on 401.
- **`CREATE INDEX` (non-concurrent) on prod ReadingIndex** — locks writes. Use `CONCURRENTLY`.
- **Running Prisma migrations through PgBouncer** transaction-mode — use `directUrl`.
- **Registering global `JwtAuthGuard` without `@Public()` wiring** — instantly 401s login/landing/health.
- **Routing auth/transaction reads to the replica** — replication lag causes read-after-write bugs; analytics only.
- **Setting `TZ` on Alpine without `tzdata`** — silently ignored.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OTP rate limit across replicas | Custom Map/sliding-window in process | Redis `INCR`+`EXPIRE` via `CacheService` | In-memory loses state on deploy + per-replica (the exact bug being fixed) |
| WebSocket multi-replica delivery | Manual Redis pub/sub bridge | `@socket.io/redis-adapter` | Battle-tested, handles rooms/acks/reconnect |
| Cookie parsing | Manual `Cookie:` header split | `cookie-parser` | Edge cases (encoding, multiple cookies, signing) |
| SMS provider auth/retry | Inline fetch in the request path | BullMQ worker (already exists) + cached token | Async retry/DLQ already configured in `queue.module.ts` |
| Connection pooling | App-level pool tuning | PgBouncer | Postgres connection limits (~100) vs 50K users; pooling is an infra concern |
| Kafka consumer plumbing | Raw socket consumer | kafkajs `consumer` (installed) or `@nestjs/microservices` | Offset mgmt, rebalancing, retries |

**Key insight:** Every Phase 1 "fix" replaces a hand-rolled placeholder (in-memory Map, stubbed processor, default in-memory WS adapter, hardcoded dev tokens) with the standard production primitive. Resist re-inventing — the standard tool IS the fix.

---

## Runtime State Inventory

This phase has limited rename/migration surface, but several runtime-state items matter:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `OtpCode` rows (Prisma) — unaffected by rate-limit move. Existing `RefreshToken` rows in DB remain valid after cookie migration (they're DB-backed; only the *transport* changes). | None for OtpCode. For INFRA-02, existing logged-in users keep working (token still in DB) but their localStorage refresh token becomes unused — acceptable; they re-auth naturally. |
| Live service config | Redis keys: new `otp:rl:{phone}` namespace (INFRA-01). No collision with existing `stats:*`, `top100:*`, `reading:*` keys (verified in `CacheService.keys`). | None — additive. |
| OS-registered state | `@nestjs/schedule` crons are in-process (not OS cron). TZ change (INFRA-05) alters when they fire — `autoFallbackPendingUsers` (1AM), `remindPendingUsers` (9AM), `monthlyInventoryAudit` (1st 00:00). After TZ fix they shift from UTC to Tashkent wall-clock. | Verify cron expectations against Tashkent time post-deploy. |
| Secrets/env vars | New required prod env: `VAULT_TOKEN`, `VAULT_ADDR` (INFRA-04, now asserted), `ESKIZ_EMAIL`/`ESKIZ_PASSWORD`/`ESKIZ_FROM` (NOTIF-01), `TZ` (INFRA-05), `DATABASE_REPLICA_URL` (INFRA-10), corrected `IDUZ_*` for `sso.egov.uz` (AUTH-03). `JWT_REFRESH_SECRET` already asserted. | Provision in Vault/`.env.prod` before deploy. Missing Eskiz creds = OTP silently fails again. |
| Build artifacts | Alpine image needs `tzdata` layer (INFRA-05). PgBouncer/replica are new compose services with volumes. Orphaned test artifact `nlq.service.spec.ts.tmp.*` exists (CONCERNS) — unrelated to Phase 1 but safe to delete. | Rebuild backend image after Dockerfile TZ change. |

---

## Common Pitfalls

### Pitfall 1: Global JwtAuthGuard locks everyone out
**What goes wrong:** Registering `JwtAuthGuard` as `APP_GUARD` without first wiring `@Public()` returns 401 on `/auth/login`, `/auth/otp/send`, `/health`, landing pages — nobody can even log in.
**Why:** The guard runs on every route, including the ones used to *obtain* a token.
**Avoid:** Build `@Public()` + reflector bypass in the SAME change; audit every controller; mark all `/auth/*` (except `/auth/logout`), `/health`, public GET landing/top/search, and payment webhooks public. Add an integration test asserting `/auth/login` is reachable unauthenticated and a protected route 401s without a token.
**Warning signs:** 401 on login in dev immediately after the change.

### Pitfall 2: Half-migrated refresh-token cookie
**What goes wrong:** Backend sets the cookie but axios doesn't send `withCredentials`, or the store still persists `refreshToken`, so refresh silently fails and users get logged out on every access-token expiry (15 min).
**Why:** INFRA-02 spans 5 files across two apps; missing any one breaks the loop.
**Avoid:** Treat as one atomic task. Checklist: (1) `cookie-parser` in main.ts, (2) cookie set on login/register/refresh, (3) `/refresh` reads cookie not body, (4) axios `withCredentials:true`, (5) store stops persisting refresh, (6) CORS `credentials:true` (already set). Test the full login→wait→refresh loop.
**Warning signs:** User logged out after exactly 15 minutes.

### Pitfall 3: TZ env ignored on Alpine
**What goes wrong:** `TZ=Asia/Tashkent` set but crons still fire on UTC because Alpine has no tz database.
**Avoid:** `apk add --no-cache tzdata` in the Dockerfile.
**Warning signs:** `date` in-container shows UTC; nightly cron logs timestamped 5 hours off.

### Pitfall 4: Prisma + PgBouncer prepared-statement errors
**What goes wrong:** "prepared statement already exists" errors under load; migrations fail.
**Avoid:** `?pgbouncer=true` + transaction pool mode; `directUrl` for migrations.
**Warning signs:** Intermittent 500s on DB queries only in prod.

### Pitfall 5: Eskiz token re-auth storm
**What goes wrong:** Authenticating to Eskiz per message exhausts the auth endpoint / adds latency to every OTP.
**Avoid:** Cache the bearer token; re-auth only on 401/expiry.
**Warning signs:** Slow OTP delivery; Eskiz auth-rate complaints.

### Pitfall 6: OneID endpoint mismatch (AUTH-03)
**What goes wrong:** The code targets `sso.id.uz`; real OneID is `sso.egov.uz` with a non-standard `.do` grant flow. Integration "works" in unit tests (mocked) but fails against the live provider.
**Avoid:** Confirm the actual provider contract + credentials before marking AUTH-03 done; do not trust the hardcoded URLs.
**Warning signs:** 404/invalid_grant from the token endpoint in staging.

---

## State of the Art

| Old Approach (in code) | Current Approach | Impact |
|------------------------|------------------|--------|
| In-memory `Map` rate limit | Redis `INCR`+`EXPIRE` | Survives restarts, multi-replica safe |
| Refresh token in localStorage | HttpOnly cookie | XSS can't exfiltrate the long-lived token |
| Per-route `@UseGuards(JwtAuthGuard)` | Global guard + `@Public()` | Default-deny; no accidentally-open routes |
| Vault soft-fallback to `.env` | Fail-hard in prod | Secrets actually enforced; passes gov audit |
| In-memory Socket.IO adapter | Redis adapter | Real-time works across 3 replicas |
| Stubbed notification processor | Eskiz HTTP + enabled `@Processor` | Registration flow actually functional |

**Deprecated/outdated:**
- `node-vault@0.12` (last major 2021) — replacement (`@hashicorp/vault-client-node`) deferred past Phase 1.
- `next-pwa` — not relevant to Phase 1 (Phase 7 / Serwist).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Eskiz endpoints are `POST /api/auth/login` (token) and `POST /api/message/sms/send` with `{mobile_phone, message, from, callback_url}` | NOTIF-01 | If the live Eskiz API differs, the SMS client won't send. **Confirm against the project's Eskiz dashboard/Postman docs before coding.** Medium risk. |
| A2 | OneID lives at `sso.egov.uz/sso/oauth/Authorization.do` with `grant_type=one_authorization_code` / `one_access_token_identify`, PINFL in `pin` field | AUTH-03 | Current code uses `sso.id.uz` (likely wrong). If the project genuinely contracted a different `id.uz` provider, the whole AUTH-03 fix premise changes. **High risk — needs the official OneID integration contract.** |
| A3 | OTP should be 4-digit (TZ §2.1) vs current 6-digit code | AUTH-01 | Cosmetic but user-facing; cheap to change either way. Low risk. |
| A4 | INFRA-10 read replica is a scale optimization, deferrable under scope pressure without breaking correctness | INFRA-10 | If a Phase 1 acceptance gate hard-requires it, can't defer. Low-medium. |
| A5 | A NestJS Kafka consumer (not Python) satisfies INFRA-08 for V1.0 | INFRA-08 | Confirmed by STATE.md (Python engine is v2). Low risk. |
| A6 | Eskiz bearer token TTL is ~30 days requiring re-auth-on-401 caching | NOTIF-01 | If TTL is shorter, just means more frequent re-auth; caching pattern still correct. Low risk. |

---

## Open Questions (RESOLVED)

> All five questions are addressed within the Phase 1 plans — code is written against the best-known assumption, and external-dependency unknowns are gated behind `checkpoint:human-verify` tasks that confirm/correct before sign-off.

1. **OneID provider identity (AUTH-03) — BLOCKER for verification.** **(RESOLVED → Plan 06 Task 1 codes the fix against `sso.egov.uz` (Assumption A2) with defensive field handling; Plan 06 Task 2 `checkpoint:human-verify` confirms the live contract + credentials before sign-off.)**
   - Known: code targets `sso.id.uz`; official Uzbekistan OneID is `sso.egov.uz`.
   - Unclear: which provider the project actually has credentials for, and the exact grant flow.
   - Recommendation: obtain the OneID integration spec + `IDUZ_CLIENT_ID/SECRET` from the project owner before implementing; gate AUTH-03 behind a `checkpoint:human-verify`.

2. **Eskiz.uz live API contract (NOTIF-01).** **(RESOLVED → Plan 01 Task 2 codes the client against the documented auth→token→send flow (Assumption A1); Plan 01 Task 3 `checkpoint:human-verify` confirms live delivery + `ESKIZ_EMAIL/PASSWORD/FROM`.)**
   - Known: base flow is auth→token→send (Bearer).
   - Unclear: exact paths/field names for THIS account; the `from` (alphanumeric sender) approval status.
   - Recommendation: confirm against the project's Eskiz dashboard; need `ESKIZ_EMAIL/PASSWORD/FROM`.

3. **OTP length: 4 vs 6 digits (AUTH-01).** **(RESOLVED → Plan 03 Task 1 defaults to keeping 6 digits; the Plan 01 Task 3 checkpoint `resume-signal` lets the user choose "switch to 4", which Plan 03 then applies to `VerifyOtpDto @Length`.)** TZ prose says 4; code does 6.

4. **INFRA-10 scope.** **(RESOLVED → included in Phase 1: Plan 06 Task 4 ships the replica compose service + `DATABASE_REPLICA_URL`; app-level read-routing deferred to Phase 2/5 where heavy read paths are built.)**

5. **Access token storage after INFRA-02.** **(RESOLVED → Plan 04 Task 3: access token in memory/Zustand (non-persisted), refresh token in HttpOnly cookie.)**

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis | INFRA-01, INFRA-07, BullMQ | ✓ (compose) | 7 | none — hard requirement |
| Kafka | INFRA-08 | ✓ (compose) | 7.6 (Confluent) | Consumer no-ops when `KAFKA_BROKERS` unset |
| PostgreSQL | INFRA-06/09/10 | ✓ (compose) | 15 | none |
| HashiCorp Vault | INFRA-04 | ✓ (infra/vault) | — | `.env` in dev only; prod must have it |
| Eskiz.uz account | NOTIF-01, AUTH-01 | ✗ (external) | — | **none — blocks real OTP; dev can stub** |
| OneID/`sso.egov.uz` creds | AUTH-03 | ✗ (external) | — | **none — blocks gov auto-verify** |
| PgBouncer image | INFRA-09 | ✗ (not in compose yet) | edoburu 1.22 | direct Postgres (current) until added |
| Postgres replica | INFRA-10 | ✗ (not in compose yet) | 15 | primary handles reads (current) |
| `tzdata` (Alpine) | INFRA-05 | ✗ (not in image) | apk | pin crons to UTC times manually |

**Missing dependencies with no fallback (BLOCKERS):**
- Eskiz.uz credentials → real OTP delivery (AUTH-01/NOTIF-01) and AUTH-04/admin-approval SMS.
- OneID `sso.egov.uz` integration contract + credentials → AUTH-03.

**Missing dependencies with fallback:**
- PgBouncer/replica → app works on direct Postgres (these are scale hardening).
- Kafka consumer → degrades gracefully without brokers.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 30 + ts-jest (`apps/backend/jest.config.ts`) |
| Config file | `apps/backend/jest.config.ts` (testEnvironment `node`, rootDir `src`, `.spec.ts` regex) |
| Quick run command | `cd apps/backend && npx jest <path> -x` |
| Full suite command | `cd apps/backend && npm test` |
| Coverage gate | 80% lines (controllers/infra/guards excluded from coverage collection) |
| Notable | `@nestjs/schedule` is mocked (`src/__mocks__/@nestjs/schedule.ts`) so crons can be unit-tested by calling the method directly |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | OTP rate limit blocks 6th send/hr via Redis | unit | `npx jest auth.service.spec -x` | ✅ extend existing |
| INFRA-02 | `/refresh` reads cookie, `/login` sets cookie | unit (controller) | `npx jest auth.controller.spec -x` | ❌ Wave 0 (no controller tests exist) |
| INFRA-03 | `@Public()` route bypasses guard; protected route 401s | unit | `npx jest jwt-auth.guard.spec -x` | ❌ Wave 0 (guards excluded from coverage; add test) |
| INFRA-04 | Vault throws in prod when token missing | unit | `npx jest vault.service.spec -x` | ❌ Wave 0 |
| INFRA-06 | Migration adds index (assert via schema/migration presence) | manual/migration | `npx prisma migrate diff` | ❌ Wave 0 |
| INFRA-07 | Adapter wired in afterInit (smoke) | manual | multi-instance staging | n/a automated |
| INFRA-08 | Consumer routes event → gateway emit | unit | `npx jest kafka-consumer.service.spec -x` | ❌ Wave 0 |
| AUTH-03 | PKCE URL + state-cookie verification | unit | `npx jest iduz.service.spec -x` | ✅ exists (`iduz.service.spec.ts`) — extend for endpoint fix |
| AUTH-04 | 14-day PENDING→CITIZEN cron | unit | `npx jest admin.service.spec -x` | ✅ exists (`admin.service.spec.ts`) — add cron test |
| NOTIF-01 | Eskiz client sends + handles 401 re-auth | unit | `npx jest eskiz.client.spec -x` | ❌ Wave 0 |
| NOTIF-04 | Processor enabled processes sms job | unit | `npx jest notification.processor.spec -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx jest <touched-spec> -x` (fast, targeted).
- **Per wave merge:** `cd apps/backend && npm test` (full suite, 80% line gate).
- **Phase gate:** full suite green + manual smoke of registration (OTP→verify→complete) against a real/staging Eskiz before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `auth.controller.spec.ts` — covers INFRA-02 (cookie set/read). No controller tests exist anywhere (CONCERNS test-gap).
- [ ] `jwt-auth.guard.spec.ts` — covers INFRA-03 `@Public()` bypass.
- [ ] `vault.service.spec.ts` — covers INFRA-04 prod fail-hard.
- [ ] `kafka-consumer.service.spec.ts` — covers INFRA-08.
- [ ] `eskiz.client.spec.ts` + `notification.processor.spec.ts` — cover NOTIF-01/NOTIF-04.
- [ ] `admin.service.spec.ts` — add a test for `autoFallbackPendingUsers` (AUTH-04) if not present.
- [ ] CacheService: add test for new `incrWithTtl` (INFRA-01).
- [ ] Frontend has zero tests (CONCERNS) — INFRA-02 store/axios changes are unverified by automation; consider a minimal jsdom test or manual checklist.

---

## Security Domain

`security_enforcement` is not explicitly `false` in config.json → treat as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | JWT HS256 (`@nestjs/jwt`), bcrypt(12), OTP via Eskiz, OneID PKCE. OTP rate limit → Redis (INFRA-01). |
| V3 Session Management | yes | Refresh-token rotation (exists), **refresh in HttpOnly cookie (INFRA-02)**, 15-min access TTL. |
| V4 Access Control | yes | Global `JwtAuthGuard` + `@Public()` (INFRA-03) + `RolesGuard` (default-deny once global guard lands). |
| V5 Input Validation | yes | `class-validator` DTOs + global `ValidationPipe`. Recommend `forbidNonWhitelisted:true` (CONCERNS). |
| V6 Cryptography | yes | bcrypt for passwords, HMAC for QR (later phases), AES-256/TLS1.3 (infra). Secrets via Vault — **enforce in prod (INFRA-04)**. Never hand-roll. |
| V7 Error/Logging | partial | `AllExceptionsFilter` + Sentry exist; audit-log append-only is later phase. |
| V9 Communications | yes | TLS via Nginx; CORS `credentials:true` with explicit origins (`main.ts:47-61`). |

### Known Threat Patterns for NestJS + JWT + SMS OTP

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Refresh-token theft via XSS (localStorage) | Spoofing/Info Disclosure | HttpOnly cookie (INFRA-02) — the central security win of this phase |
| OTP brute-force / SMS-bomb across replicas | DoS / Spoofing | Redis rate limit per-phone (INFRA-01) + throttler per-IP (exists) |
| Unauthenticated route exposure | Elevation of Privilege | Global default-deny guard (INFRA-03) |
| Secrets in plaintext `.env` | Info Disclosure | Vault fail-hard prod (INFRA-04) + gitleaks (CONCERNS rec) |
| CSRF on OneID callback | Spoofing | State param verified against **httpOnly cookie** (AUTH-03 fix), not client body |
| CSRF on cookie-based refresh | Spoofing | `SameSite=lax` cookie + CORS allowlist; refresh only via POST |
| Hardcoded `dev-root-token` / `dev-client` | Spoofing | Remove dev defaults in prod (INFRA-04, AUTH-03) |

---

## Build Order Within Phase

Dependency-driven. Notification fix is the keystone (3 other requirements depend on real SMS).

**Wave A — Foundations (parallel-safe, no external deps):**
1. INFRA-06 (ReadingIndex index) — isolated schema change.
2. INFRA-05 (Docker TZ + tzdata) — isolated config.
3. INFRA-04 (Vault fail-hard) — isolated, 2 files.
4. INFRA-01 (Redis OTP rate limit) — `CacheService.incrWithTtl` + AuthService.
5. INFRA-03 (global guard + `@Public()`) — touches all controllers; do early so later auth work assumes it.

**Wave B — Notification keystone (unblocks AUTH-01, AUTH-04 SMS, admin approval):**
6. NOTIF-04 + NOTIF-01 (enable `@Processor`, build Eskiz client). **Gated on Eskiz credentials.**
7. AUTH-01 falls out (verify OTP delivery end-to-end; settle 4-vs-6 digit).
8. AUTH-04 — add cron test; now its SMS actually sends (no new logic).

**Wave C — Auth transport + locale (after global guard):**
9. INFRA-02 (refresh cookie) — atomic 5-file change; mark `/refresh` `@Public()`.
10. AUTH-02 (locale redirect) — frontend-only, independent.

**Wave D — Real-time + events:**
11. INFRA-07 (WS Redis adapter) — needs Redis (have it).
12. INFRA-08 (Kafka consumer) — needs Kafka (have it); degrades gracefully.

**Wave E — Production infra (ops-heavy, can lag / checkpoint):**
13. INFRA-09 (PgBouncer) — compose + Prisma `directUrl`.
14. INFRA-10 (read replica) — heaviest; deferrable under scope pressure (A4).

**Checkpoint-gated (external dependency):**
- AUTH-03 (OneID) — **blocked on provider contract/credentials**; do not mark done until verified against real `sso.egov.uz`. Gate behind `checkpoint:human-verify`.
- NOTIF-01 live test — gate behind real Eskiz credentials.

---

## Risks & Gotchas (consolidated)

1. **OneID is pointed at the wrong host.** `sso.id.uz` (code) ≠ `sso.egov.uz` (official). AUTH-03 will pass mocked tests but fail live. Highest correctness risk; needs the integration contract. (A2, OQ1)
2. **Global guard lockout.** Ship `@Public()` and the guard together or every route 401s. (Pitfall 1)
3. **Cookie migration is multi-file/multi-app.** Easy to half-do → silent 15-min logouts. (Pitfall 2)
4. **Alpine `TZ` needs `tzdata`.** Otherwise the TZ fix is a no-op. (Pitfall 3)
5. **Prisma+PgBouncer prepared statements.** Needs `pgbouncer=true` + `directUrl`. (Pitfall 4)
6. **CacheService lacks atomic INCR.** INFRA-01 requires adding it — don't reuse `get/set` (race condition). 
7. **Eskiz token caching.** Don't auth per message. (Pitfall 5)
8. **`@nestjs/microservices` version footgun.** If used, pin `^10` to match installed NestJS 10, not the default-latest 11. (Prefer kafkajs — already installed.)
9. **AUTH-04 already exists.** Risk the planner re-builds it. Scope it as test-only + dependency wiring.
10. **Index on live ReadingIndex must be CONCURRENT.** Non-concurrent locks the table that the nightly RI cron writes to.

---

## Sources

### Primary (HIGH confidence)
- Codebase (read directly, file:line evidence throughout): `auth.service.ts`, `auth.controller.ts`, `auth.module.ts`, `iduz.service.ts`, `iduz.controller.ts`, `vault.service.ts`, `notification.processor.ts`, `sms.service.ts`, `queue.module.ts`, `cache.service.ts`, `kafka.service.ts`, `stats.gateway.ts`, `gateway.module.ts`, `app.module.ts`, `main.ts`, `jwt-auth.guard.ts`, `roles.guard.ts`, `admin.service.ts`, `schema.prisma`, `Dockerfile`, `docker-compose.yml`, `docker-compose.prod.yml`, `middleware.ts`, `i18n.ts`, `auth.store.ts`, `client.ts`, `jest.config.ts`, `config.json`.
- `CLAUDE.md` (full TZ — §VIII Security, §X Backend, §SPRINT 2).
- `.planning/research/{PITFALLS,ARCHITECTURE,STACK}.md`, `.planning/codebase/{CONCERNS,STACK}.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`.
- npm registry (`npm view`) for all package versions; slopcheck v0.6.1 (`3 OK`).
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/)

### Secondary (MEDIUM confidence)
- [OneID / egov.uz official](https://id.egov.uz/) and [egov.uz OneID project](https://egov.uz/en/projects/one-id) — confirm `sso.egov.uz` is the official host (vs hardcoded `sso.id.uz`).
- [flask_oneid (Odya-LLC)](https://github.com/Odya-LLC/flask_oneid) — OneID returned-field shape (`pin`, `full_name`, etc.) and `.do` endpoint pattern.
- [Eskiz.uz SMS Gateway (Postman)](https://documenter.getpostman.com/view/663428/TVK5eMco) and [Eskiz SMS service](https://eskiz.uz/en/sms) — SMS API shape.

### Tertiary (LOW confidence — flagged in Assumptions)
- Eskiz exact endpoint paths/field names (A1) — confirm against the project's live Eskiz account.
- OneID exact grant_type strings + parameter set (A2) — confirm against the official integration contract.

---

## Metadata

**Confidence breakdown:**
- Current-state audit (what's broken, where): HIGH — every claim has file:line evidence from direct reads.
- Fix approaches / standard stack: HIGH — standard NestJS/Redis/Socket.IO/Prisma patterns, packages verified + slopchecked.
- External API contracts (Eskiz endpoints, OneID flow): MEDIUM-LOW — real provider docs are behind dashboards/contracts; flagged as assumptions/open questions.

**Research date:** 2026-06-06
**Valid until:** ~2026-07-06 for the codebase audit (stable); ~2026-06-20 for external API details (Eskiz/OneID specifics should be re-confirmed against live provider docs before implementation).
