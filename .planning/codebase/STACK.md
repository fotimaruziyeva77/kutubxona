# Technology Stack

**Analysis Date:** 2026-06-06

## Languages

**Primary:**
- TypeScript 5.4 - Both backend (`apps/backend/`) and frontend (`apps/frontend/`)

**Secondary:**
- SQL (PostgreSQL dialect) - Database schema via Prisma (`apps/backend/prisma/schema.prisma`)
- YAML - Docker Compose, CI/CD configuration (`docker-compose.yml`, `docker-compose.prod.yml`)
- Shell - Deploy and server-setup scripts (`infra/scripts/deploy.sh`, `infra/scripts/server-setup.sh`)

## Runtime

**Environment:**
- Node.js 20 LTS (enforced in root `package.json` `engines.node >= 20`)

**Package Manager:**
- npm (npm workspaces monorepo)
- Lockfile: `package-lock.json` present at root

## Frameworks

**Backend (apps/backend):**
- NestJS 10 - Primary server framework with modular architecture
- Express (via `@nestjs/platform-express`) - Underlying HTTP adapter
- Prisma 5 - Type-safe ORM for PostgreSQL
- BullMQ 5 + `@nestjs/bullmq` - Job queue for async notifications and reports
- Socket.IO 4 (via `@nestjs/websockets`) - WebSocket real-time gateway
- `@nestjs/schedule` - Cron jobs (Reading Index nightly recalculation at 00:00)
- `@nestjs/swagger` 7 - API documentation at `/docs`
- `@nestjs/throttler` - Global rate limiting (100 req/min default, 10/hour for auth)

**Frontend (apps/frontend):**
- Next.js 14 (App Router, standalone output mode)
- React 18
- Tailwind CSS 4 + PostCSS
- next-intl 4 - Internationalization (4 locales: uz-Latn, uz-Cyrl, ru, kaa)
- Zustand 5 - Client-side state (`apps/frontend/store/auth.store.ts`)
- TanStack React Query 5 - Server state / data fetching
- Recharts 2 - Charts for statistics dashboards
- Leaflet 1.9 - Interactive map (regional Reading Index visualization)
- Socket.IO client 4 - Real-time dashboard updates
- Axios 1 - HTTP client with JWT interceptors (`apps/frontend/lib/api/client.ts`)

**Testing:**
- Jest 30 + ts-jest (backend) — config at `apps/backend/jest.config.ts`
- Jest environment: `node` for backend, `jsdom` for frontend
- `@testing-library/react` 16, `@testing-library/jest-dom` 6 (frontend)
- Coverage threshold: 80% lines enforced on backend (`apps/backend/jest.config.ts`)

**Build/Dev:**
- `ts-node-dev` - Backend hot reload in development
- `tsc` (TypeScript 5.4) - Compilation target ES2021 (`apps/backend/tsconfig.json`)
- Next.js standalone build output (`apps/frontend/next.config.js`)
- `concurrently` - Root monorepo `npm run dev` starts both apps

## Key Dependencies

**Critical (Backend):**
- `@prisma/client` 5.14 - Database access layer; all DB calls go through this
- `kafkajs` 2.2 - Kafka event producer (`apps/backend/src/infra/kafka/kafka.service.ts`)
- `ioredis` 5.4 - Redis client for caching and BullMQ backend
- `@nestjs/elasticsearch` 10 - Elasticsearch full-text search integration
- `bcrypt` 6 - Password hashing (salt rounds 12)
- `jsonwebtoken` (via `@nestjs/jwt` 11) - JWT auth with 15-min access / 30-day refresh
- `qrcode` 1.5 - QR code generation for user IDs and book transactions
- `openai` 4.52 - OpenAI GPT-4o-mini for NLQ enrichment (`apps/backend/src/modules/ai/nlq.service.ts`)
- `puppeteer-core` 22 + `@sparticuz/chromium` 130 - PDF report generation (`apps/backend/src/infra/pdf/pdf.service.ts`)
- `xlsx` 0.18 - Excel import for book fund upload (500+ books at once)
- `zod` 3.23 - Schema validation
- `class-validator` / `class-transformer` - NestJS DTO validation
- `node-vault` 0.12 - HashiCorp Vault secrets integration
- `helmet` 8 - HTTP security headers
- `prom-client` 15 + `@willsoto/nestjs-prometheus` - Prometheus metrics endpoint
- `@sentry/node` 10 + `@sentry/profiling-node` - Backend error tracking and profiling
- `socket.io` 4 - WebSocket server

**Critical (Frontend):**
- `@sentry/nextjs` 10 - Frontend error tracking (`apps/frontend/sentry.client.config.ts`)
- `lucide-react` 1.14 - Icon library
- `class-variance-authority` + `clsx` + `tailwind-merge` - UI component utilities (shadcn/ui pattern)

**Infrastructure:**
- `multer` 1.4 - File upload middleware (book cover images, debate media)

## Configuration

**Environment:**
- Backend reads from `.env` (development) or `.env.prod` (production)
- Secrets stored in HashiCorp Vault (`infra/vault/`); `VaultService` falls back to env vars
- Required production env vars asserted at startup: `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `REDIS_URL`
- Key env vars:
  - `DATABASE_URL` - PostgreSQL connection string
  - `JWT_SECRET` / `JWT_REFRESH_SECRET` - JWT signing keys
  - `REDIS_URL` - Redis connection
  - `KAFKA_BROKERS` - Kafka broker list (comma-separated); optional, degrades gracefully
  - `ELASTICSEARCH_URL` - ES node URL
  - `PAYME_MERCHANT_ID` / `PAYME_SECRET_KEY` / `PAYME_TEST_KEY` - Payme payment
  - `CLICK_MERCHANT_ID` / `CLICK_SECRET_KEY` - Click payment
  - `OPENAI_API_KEY` - GPT-4o-mini for NLQ enrichment (optional)
  - `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` - Error tracking
  - `IDUZ_CLIENT_ID` / `IDUZ_CLIENT_SECRET` / `IDUZ_REDIRECT_URI` - ID.UZ OAuth
  - `VAULT_ADDR` / `VAULT_TOKEN` - HashiCorp Vault
  - `MINIO_USER` / `MINIO_PASSWORD` - Object storage
  - Frontend: `NEXT_PUBLIC_API_URL` - Backend base URL

**Build:**
- `apps/backend/tsconfig.json` - CommonJS, ES2021, strict mode, decorator metadata enabled
- `apps/backend/tsconfig.build.json` - Build-only config
- `apps/frontend/next.config.js` - next-intl plugin, standalone output, security headers, image optimization
- `apps/frontend/postcss.config.js` - Tailwind CSS PostCSS pipeline

## Platform Requirements

**Development:**
- Node.js >= 20
- Docker + Docker Compose (for PostgreSQL, Redis, Elasticsearch, Kafka, MinIO, Vault, monitoring stack)
- `docker-compose up` starts all infra services (`docker-compose.yml`)
- Backend runs on port `4000`; Frontend runs on port `3000`

**Production:**
- Docker Compose (`docker-compose.prod.yml`) with 3 backend replicas, 2 frontend replicas
- Nginx 1.25 Alpine as reverse proxy with SSL (`infra/nginx/`)
- Images published to GitHub Container Registry (`ghcr.io/sifat-library/`)
- Rolling zero-downtime deploy: new containers start before old ones stop
- Data locality requirement: all servers must be located in Uzbekistan (Unicon.uz / TIF DC)
- Cloudflare allowed only as CDN layer
- Daily PostgreSQL backups to `/srv/sifat/backups` via cron at 02:00

---

*Stack analysis: 2026-06-06*
