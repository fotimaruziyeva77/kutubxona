# External Integrations

**Analysis Date:** 2026-06-06

## APIs & External Services

**SMS Gateway (Uzbekistan):**
- Eskiz.uz / SMS.uz - OTP delivery and push notifications
  - SDK/Client: Custom HTTP call inside `apps/backend/src/infra/queue/notification.processor.ts` (`sendSms` method — provider stub, wired in Sprint 2)
  - Auth: API key (expected via env var, not yet named in code — stub implementation)
  - Queue: Messages go through BullMQ `NOTIFICATION_QUEUE` with priority 1 for OTP

**OpenAI:**
- GPT-4o-mini - NLQ (Natural Language Query) answer enrichment
  - SDK/Client: `openai` npm package (also native `fetch` call to `https://api.openai.com/v1/chat/completions` in `apps/backend/src/modules/ai/nlq.service.ts`)
  - Auth: `OPENAI_API_KEY` env var
  - Usage: Only invoked when rule-based confidence < 0.8; optional — system degrades to rule-based answers without it
  - Model: `gpt-4o-mini`, max 500 tokens, temperature 0.3, Uzbek language system prompt

**Open Library / Google Books:**
- ISBN auto-fill for book metadata (title, author, cover)
  - SDK/Client: Referenced in CLAUDE.md Sprint 3; implementation in `apps/backend/src/modules/books/books.service.ts` (ISBN validation)
  - Auth: Not required (Open Library is public)

**Firebase Cloud Messaging (FCM):**
- Push notifications to mobile and web browsers
  - SDK/Client: Stub in `notification.processor.ts` `sendPush` method — wired in Sprint 4
  - Auth: Firebase service account (env var not yet defined — planned)

**Mutolaa Platform:**
- External e-reading platform; reading progress sync
  - SDK/Client: API integration (referenced in system design; dedicated module `apps/backend/src/modules/reading/`)
  - Auth: API key (planned)
  - Coefficient: 0.85x applied to reading index for e-reads

**Book Store API:**
- Third-party bookstore POS/order systems
  - SDK/Client: Webhook endpoint at `POST /api/v1/purchases`; HMAC-SHA256 signature verification
  - Auth: `HMAC-SHA256` per-store secret; `store_id` + `signature` in payload
  - Implemented in `apps/backend/src/modules/store/`

## Data Storage

**Databases:**
- PostgreSQL 15 (primary relational database)
  - Connection: `DATABASE_URL` env var
  - Client: Prisma 5 ORM (`apps/backend/src/infra/prisma/`)
  - Schema: 30+ models in `apps/backend/prisma/schema.prisma`
  - Production: health-checked, port unexposed externally, daily backup via `infra/postgres/backup.sh`

- Elasticsearch 8.13 (full-text search + aggregations)
  - Connection: `ELASTICSEARCH_URL` env var
  - Client: `@nestjs/elasticsearch` wrapping official `@elastic/elasticsearch`
  - Service: `apps/backend/src/infra/elasticsearch/elasticsearch.service.ts`
  - Indices: `books` (title, author, genre, fuzzy search, completion suggest) and `users`
  - Security: xpack disabled in dev; `ELASTIC_PASSWORD` enforced in production

**Message Queue / Streaming:**
- Redis 7 (cache + BullMQ job queue backend)
  - Connection: `REDIS_URL` env var
  - Client: `ioredis` 5 (direct cache) + BullMQ (job queue)
  - Service: `apps/backend/src/infra/cache/cache.service.ts`
  - Caching: regional stats 5 min, Top-100 1 hour, book search 10 min, AI recommendations 30 min
  - Queue: `NOTIFICATION_QUEUE` for SMS/push/email; priority queuing for OTP

- Apache Kafka (Confluent 7.6) - real-time event streaming to AI audit engine
  - Connection: `KAFKA_BROKERS` env var (comma-separated)
  - Client: `kafkajs` 2.2 (`apps/backend/src/infra/kafka/kafka.service.ts`)
  - Topics: `user.registered`, `book.borrowed`, `book.returned`, `book.reserved`, `reading.progress`, `isbn.scanned`, `fraud.detected`, `ri.updated`, `club.debate.added`, `library.inactive`, `tuman.ri.dropped`
  - Degradation: graceful — events are logged only when Kafka is unavailable

**File Storage:**
- MinIO (S3-compatible, self-hosted in Uzbekistan)
  - Connection: `MINIO_USER` / `MINIO_PASSWORD` env vars
  - Usage: book cover images, debate photos/videos (`mediaUrls` in `Debate` model), book corner photos (`BookCorner.photoUrls`), reading hour media, PDF reports
  - Compliance: data locality requirement — hosted on Uzbekistan servers

**Caching:**
- Redis 7 (see above)

## Authentication & Identity

**Primary Auth:**
- SMS OTP via Eskiz.uz / SMS.uz → custom JWT
  - Flow: Phone → 4-digit OTP (2 min TTL, max 5 attempts/hour) → JWT access (15 min) + refresh (30 days, HttpOnly cookie)
  - Token rotation on every refresh; old tokens immediately invalidated
  - Implementation: `apps/backend/src/modules/auth/auth.service.ts`

**Government SSO:**
- ID.UZ — O'zbekiston davlat identifikatsiya tizimi
  - Protocol: OAuth 2.0 with PKCE (S256 code challenge)
  - Endpoints: `https://sso.id.uz/auth/oauth2/v1/authorize`, `.../token`, `.../userinfo`
  - Scopes: `openid profile phone pinfl`
  - Auth: `IDUZ_CLIENT_ID` / `IDUZ_CLIENT_SECRET` env vars
  - Implementation: `apps/backend/src/modules/auth/iduz.service.ts`, `apps/backend/src/modules/auth/iduz.controller.ts`
  - Usage: Government employees auto-verified; PINFL used for identity matching

**Authorization:**
- RBAC via NestJS Guards; 9 roles (SUPER_ADMIN, BUXGALTER, VILOYAT_ADMIN, TUMAN_ADMIN, MUASSASA_ADMIN, KUTUBXONACHI, KLUB_RAHBARI, DOKON_OPERATOR, KITOBXON)
- Defined in `apps/backend/prisma/schema.prisma` `UserRole` enum

## Monitoring & Observability

**Error Tracking:**
- Sentry (self-hosted or cloud)
  - Backend: `@sentry/node` + `@sentry/profiling-node`; initialized in `apps/backend/src/infra/monitoring/sentry.ts`
  - Frontend: `@sentry/nextjs`; configured in `apps/frontend/sentry.client.config.ts` and `apps/frontend/sentry.server.config.ts`
  - Auth: `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` env vars
  - Traces: 10% sample rate in production, 100% in development
  - Session replay: 5% sampling, 100% on error

**Metrics:**
- Prometheus (via `prom-client` + `@willsoto/nestjs-prometheus`)
  - Metrics exposed at `/metrics` endpoint on backend
  - Config: `infra/monitoring/prometheus/prometheus.yml`

**Logs:**
- Grafana Loki 3.0 + Promtail for log aggregation
  - Config: `infra/monitoring/promtail.yml`

**Dashboards:**
- Grafana 11 - metrics visualization; dashboards provisioned from `infra/monitoring/grafana/`
  - Admin UI: `grafana.sifat.uz` in production
  - SMTP configured for alert emails via `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD`

## CI/CD & Deployment

**Hosting:**
- Self-hosted Linux servers in Uzbekistan (Unicon.uz or TIF Data Center — legal requirement)
- Environments: `localhost` (dev), `dev.sifat.uz`, `staging.sifat.uz`, `sifat.uz` (production)

**Container Registry:**
- GitHub Container Registry (`ghcr.io/sifat-library/backend` and `.../frontend`)

**CI Pipeline:**
- GitHub Actions (inferred from CLAUDE.md Sprint 1 + deploy script `infra/scripts/deploy.sh`)
- Steps per PR: Lint → TypeScript check → Unit tests (coverage > 80%) → Integration tests → Security scan (Snyk + npm audit) → Docker build → Code review
- Develop merge: E2E tests (Playwright) → Lighthouse CI → staging deploy → smoke test
- Main merge: PM + Tech Lead approval required → DB migration → rolling deploy → smoke test

**Deploy:**
- Rolling zero-downtime: `start-first` order in `docker-compose.prod.yml`
- Backend: 3 replicas; Frontend: 2 replicas
- Reverse proxy: Nginx 1.25 Alpine with SSL (`infra/nginx/nginx.prod.conf`)
- Deploy script: `infra/scripts/deploy.sh` — rsync artifacts then remote `prisma migrate deploy` + systemctl restart

**Load Testing:**
- k6 (`k6/load-test.js`) — 50,000 concurrent users target

## Environment Configuration

**Required env vars (production startup fails without these):**
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `REDIS_URL`

**Other key env vars:**
- `KAFKA_BROKERS` - Kafka brokers (optional; degrades gracefully)
- `ELASTICSEARCH_URL` - Elasticsearch node
- `PAYME_MERCHANT_ID`, `PAYME_SECRET_KEY`, `PAYME_TEST_KEY` - Payme payment gateway
- `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` - Click payment gateway
- `OPENAI_API_KEY` - GPT-4o-mini (optional; NLQ falls back to rule-based)
- `SENTRY_DSN` - Backend Sentry (optional; skipped if absent)
- `NEXT_PUBLIC_SENTRY_DSN` - Frontend Sentry
- `NEXT_PUBLIC_API_URL` - Frontend → backend URL (default `http://localhost:4000`)
- `IDUZ_CLIENT_ID`, `IDUZ_CLIENT_SECRET`, `IDUZ_REDIRECT_URI` - ID.UZ OAuth
- `VAULT_ADDR`, `VAULT_TOKEN` - HashiCorp Vault
- `MINIO_USER`, `MINIO_PASSWORD` - File storage
- `DB_PASSWORD`, `REDIS_PASSWORD`, `ELASTIC_PASSWORD` - Service passwords (prod)
- `GRAFANA_PASSWORD` - Monitoring admin
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` - Email (Grafana alerts)

**Secrets location:**
- HashiCorp Vault 1.17 (`infra/vault/`, path prefix `sifat/data/`)
- `VaultService` at `apps/backend/src/infra/vault/vault.service.ts` fetches secrets at startup; falls back to env vars if Vault is unreachable

## Webhooks & Callbacks

**Incoming:**
- Payme webhook: `POST /api/payment/payme` — JSON-RPC 2.0; auth via Basic header with merchant key; handles `CheckPerformTransaction`, `CreateTransaction`, `PerformTransaction`, `CancelTransaction`, `CheckTransaction`, `GetStatement` (`apps/backend/src/modules/payment/payme.service.ts`)
- Click webhook: `POST /api/payment/click/prepare` and `POST /api/payment/click/complete` — HMAC-MD5 signature; `prepare` + `complete` two-step flow (`apps/backend/src/modules/payment/click.service.ts`)
- ID.UZ OAuth callback: `GET /api/auth/iduz/callback` — receives authorization code + state (`apps/backend/src/modules/auth/iduz.controller.ts`)
- Book store purchase: `POST /api/v1/purchases` — HMAC-SHA256 signed; `store_id` + `order_id` + `isbn` + `phone` (`apps/backend/src/modules/store/`)

**Outgoing:**
- OpenAI API: `POST https://api.openai.com/v1/chat/completions` (NLQ enrichment)
- ID.UZ token exchange: `POST https://sso.id.uz/auth/oauth2/v1/token`
- ID.UZ userinfo: `GET https://sso.id.uz/auth/oauth2/v1/userinfo`
- SMS gateway (Eskiz.uz / SMS.uz): HTTP to provider API (stub, Sprint 2 integration)
- Firebase FCM: Push notification delivery (stub, Sprint 4 integration)

---

*Integration audit: 2026-06-06*
