<!-- refreshed: 2026-06-06 -->
# Architecture

**Analysis Date:** 2026-06-06

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js 14 App Router)                  │
│   SSR Server Components + Client Components + PWA + WebSocket        │
│   `apps/frontend/app/[locale]/`  port :3000                          │
├────────────────┬────────────────┬───────────────┬────────────────────┤
│  Public Pages  │  Auth Pages    │  Dashboard    │  Kitobxon Pages    │
│ `/[locale]/`   │ `/login`       │ `/dashboard/` │ `/profile`         │
│ `/top`         │ `/register`    │ `/stats`      │ `/scan`            │
│ `/donate`      │                │ `/ai`         │ `/library/[code]`  │
└────────────────┴────────────────┴───────────────┴────────────────────┘
         │ HTTP (axios)          │ WebSocket (socket.io-client)
         ▼                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                BACKEND (NestJS 10, TypeScript)                       │
│   `apps/backend/src/`   port :4000                                   │
│   Global prefix: /api/*   |  Swagger: /docs                         │
├──────────────────────────────────────────────────────────────────────┤
│  HTTP Pipeline                                                        │
│  ThrottlerGuard → JwtAuthGuard → RolesGuard                          │
│  → LoggingInterceptor → Controller → Service → PrismaService         │
│  → AllExceptionsFilter (global)                                      │
├──────────────────┬───────────────────────────────────────────────────┤
│  Business Modules│  Infra Modules                                    │
│  `src/modules/`  │  `src/infra/`                                     │
│  auth, users     │  prisma, cache (Redis), elasticsearch             │
│  libraries, books│  kafka, queue (BullMQ), sms                      │
│  transactions    │  vault, pdf, gateway (WebSocket)                  │
│  reading, top    │  monitoring (Prometheus+Sentry)                   │
│  ai, admin       │                                                   │
│  school, club    │                                                   │
│  family, idora   │                                                   │
│  payment, store  │                                                   │
│  otm, geo        │                                                   │
│  badge, donate   │                                                   │
└──────────────────┴───────────────────────────────────────────────────┘
         │ Prisma ORM             │ BullMQ         │ KafkaJS
         ▼                       ▼                ▼
┌──────────────┐   ┌──────────┐  ┌──────────┐  ┌──────────────────┐
│ PostgreSQL 15│   │ Redis 7  │  │ BullMQ   │  │ Apache Kafka     │
│ (Primary DB) │   │ (Cache + │  │ (Email,  │  │ (AI audit stream)│
│              │   │  Session)│  │  SMS q.) │  │                  │
└──────────────┘   └──────────┘  └──────────┘  └──────────────────┘
                                                        │
                                                        ▼
                                              ┌────────────────────┐
                                              │ AI Engine (future) │
                                              │ Python FastAPI     │
                                              └────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ Elasticsearch 8 (Full-text search)  │
│ MinIO (File storage — Uzbekistan)   │
│ HashiCorp Vault (Secrets)           │
└─────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| AppModule | Root module wiring all 20+ feature modules | `apps/backend/src/app.module.ts` |
| AppInfraModule | Bundles all infra services for export | `apps/backend/src/infra/app-infra.module.ts` |
| AuthModule | JWT auth, OTP via SMS, token rotation, ID.UZ OAuth | `apps/backend/src/modules/auth/auth.module.ts` |
| TransactionsModule | Book reserve/borrow/return, roaming, ISBN scan | `apps/backend/src/modules/transactions/` |
| ReadingModule | Reading Index formula, nightly cron, Mutolaa sync | `apps/backend/src/modules/reading/reading.service.ts` |
| AiModule | Fraud detection, NL query, predictions, audit | `apps/backend/src/modules/ai/` |
| AdminModule | Dashboard stats, user approval, Smart Alerts | `apps/backend/src/modules/admin/` |
| StatsGateway | WebSocket rooms: national/viloyat/tuman/alerts/top100 | `apps/backend/src/infra/gateway/stats.gateway.ts` |
| KafkaService | Event streaming: book.borrowed, fraud.detected, ri.updated | `apps/backend/src/infra/kafka/kafka.service.ts` |
| FraudService | Rule-based risk scoring (0–100), daily cron scan | `apps/backend/src/modules/ai/fraud.service.ts` |
| PrismaService | Singleton DB client, lifecycle hooks | `apps/backend/src/infra/prisma/prisma.service.ts` |
| CacheService | Redis wrapper with `remember()` pattern | `apps/backend/src/infra/cache/cache.service.ts` |
| useAuthStore | Zustand persistent store for JWT tokens + user | `apps/frontend/store/auth.store.ts` |
| apiClient | Axios instance with auto-refresh interceptor | `apps/frontend/lib/api/client.ts` |
| useStatsSocket | Socket.io-client hook for real-time dashboard | `apps/frontend/hooks/useStatsSocket.ts` |

## Pattern Overview

**Overall:** Monorepo with two applications — NestJS backend and Next.js 14 frontend — following a clean layered module pattern on the backend and a Server-Component-first pattern on the frontend.

**Key Characteristics:**
- NestJS modules are fully self-contained (controller + service + module file per domain)
- Infrastructure services (Prisma, Redis, Kafka, Elasticsearch, Vault) are grouped in `infra/` and exported via `AppInfraModule`, then imported per-module as needed
- RBAC is enforced at the HTTP layer via `JwtAuthGuard` + `RolesGuard` guards on every protected endpoint
- Background work uses two channels: `@Cron()` decorators for scheduled tasks within services, and BullMQ queues for notifications/emails
- Real-time dashboard updates flow through a dedicated WebSocket namespace `/stats` with typed rooms
- Kafka events are emitted fire-and-forget (failures silently logged) to avoid blocking primary flows
- Frontend uses Next.js App Router: Server Components for SSR/ISR data fetching, Client Components for interactive UI; Zustand for client auth state

## Layers

**Presentation Layer (Frontend):**
- Purpose: SSR pages, client-side interaction, PWA shell
- Location: `apps/frontend/app/[locale]/`
- Contains: Route segments (`page.tsx`, `layout.tsx`), server-fetched data, client components
- Depends on: `lib/api/` (axios), `store/` (Zustand), `hooks/` (custom hooks), `components/`
- Used by: End users via browser

**API Layer (Controllers):**
- Purpose: HTTP request handling, input validation (class-validator DTO), RBAC guards
- Location: `apps/backend/src/modules/*/` — each `*.controller.ts`
- Contains: Route handlers, `@UseGuards()`, `@ApiTags()`, `@Roles()`
- Depends on: Service layer, `common/guards/`, `common/decorators/`
- Used by: Frontend, external integrations (stores, Mutolaa API)

**Service Layer:**
- Purpose: All business logic, cron jobs, event emission
- Location: `apps/backend/src/modules/*/` — each `*.service.ts`
- Contains: Business rules (borrow limits, RI formula, fraud rules), `@Cron()` tasks, Kafka emit calls
- Depends on: Infra layer (PrismaService, CacheService, KafkaService, SmsService)
- Used by: Controllers

**Infrastructure Layer:**
- Purpose: DB, cache, search, queue, messaging, secrets
- Location: `apps/backend/src/infra/`
- Contains: PrismaModule, CacheModule (Redis), SearchModule (Elasticsearch), KafkaModule, QueueModule (BullMQ), SmsModule, VaultModule, PdfModule, GatewayModule (WebSocket)
- Depends on: External services (PostgreSQL, Redis, Kafka, Elasticsearch, MinIO)
- Used by: Service layer via DI

**Data Layer:**
- Purpose: Schema definition, migrations, type generation
- Location: `apps/backend/prisma/schema.prisma`, `apps/backend/prisma/migrations/`
- Contains: 30+ models including User, Library, Book, BookTransaction, ReadingIndex, FraudScore, Subscription, Club, Institution, OrgRating
- Depends on: PostgreSQL
- Used by: PrismaService (generated client)

## Data Flow

### Primary Request Path: Book Borrow via QR

1. Kutubxonachi scans kitobxon QR → `POST /api/transactions/borrow` (`apps/backend/src/modules/transactions/transactions.controller.ts`)
2. `JwtAuthGuard` validates Bearer token → `RolesGuard` checks `KUTUBXONACHI` role
3. `TransactionsService.borrow()` runs: overdue check → borrow limit check → DB transaction (create BookTransaction + decrement Book.availableCount) (`apps/backend/src/modules/transactions/transactions.service.ts`)
4. SMS notification sent via `SmsService` to kitobxon (`apps/backend/src/infra/sms/sms.service.ts`)
5. Kafka event `book.borrowed` emitted via `KafkaService` (`apps/backend/src/infra/kafka/kafka.service.ts`)
6. Controller returns `201` with transaction object
7. Frontend refreshes via React Query cache invalidation

### Nightly Reading Index Recalculation

1. `@Cron(EVERY_DAY_AT_MIDNIGHT)` in `ReadingService.recalculateAll()` fires (`apps/backend/src/modules/reading/reading.service.ts:51`)
2. Fetches all ACTIVE users; for each user: queries BookTransaction (RETURNED, last 1 year) + IsbnScan (confirmed)
3. Computes 5 components: booksCount (30%), consistency (20%), diversity (15%), discipline (15%), activity (20%)
4. Writes new `ReadingIndex` row to PostgreSQL
5. Kafka event `ri.updated` emitted

### Fraud Detection Flow (Daily at 03:00)

1. `@Cron("0 3 * * *")` in `FraudService.dailyFraudScan()` runs (`apps/backend/src/modules/ai/fraud.service.ts:211`)
2. Fetches users active in last 7 days
3. `analyzeUser()` checks 6 rules: HIGH_DAILY_BORROWS, EXCESSIVE_ISBN_SCANS, COMPREHENSION_FAILURES, RI_SPIKE, LOW_TRUST_SCORE, QUICK_RETURNS
4. Results cached in Redis (5 min TTL) + persisted in `FraudScore` table (upsert)
5. Score ≥70 → user.status = BLOCKED + Kafka `fraud.detected` event

### Real-Time Dashboard Update

1. Service emits data change (e.g., new transaction)
2. `StatsGateway.emitNationalStats()` broadcasts to WebSocket room `national` (`apps/backend/src/infra/gateway/stats.gateway.ts`)
3. Frontend `useStatsSocket` hook receives `stats:update` event and triggers React state update (`apps/frontend/hooks/useStatsSocket.ts`)

**State Management:**
- Server state: React Query (TanStack Query) with axios `apiClient`
- Auth state: Zustand persistent store (`sifat-auth` localStorage key)
- Real-time state: Socket.io-client via `useStatsSocket` hook

## Key Abstractions

**Reading Index Engine:**
- Purpose: Weighted composite score (0–100) per user, updated nightly
- Location: `apps/backend/src/modules/reading/reading.service.ts`
- Pattern: Cron + Prisma batch — no queue, direct write per user loop

**Fraud Risk Score:**
- Purpose: Rule-based 0–100 risk score per user; threshold levels SAFE/LOW/REVIEW/BLOCKED
- Location: `apps/backend/src/modules/ai/fraud.service.ts`
- Pattern: `cache.remember()` wrapping DB queries; results persisted via `FraudScore.upsert()`

**Book Transaction State Machine:**
- Purpose: Controls book lifecycle: PENDING → RESERVED → BORROWED → RETURNED/COMPLETED/CANCELLED
- Location: `apps/backend/src/modules/transactions/transactions.service.ts`
- Pattern: Prisma `$transaction` for atomic status + inventory updates

**Geographic Hierarchy:**
- Purpose: Viloyat → Tuman → Mahalla cascade used for IDs, slugs, stats scopes
- Location: `apps/backend/prisma/schema.prisma` (Viloyat, Tuman, Mahalla models), `apps/backend/src/modules/geo/`
- Pattern: Denormalized `tumanId`/`viloyatId` on Library, Family, Institution for fast regional queries

**RBAC Permission System:**
- Purpose: 9 roles (SUPER_ADMIN to KITOBXON) enforced at controller level
- Location: `apps/backend/src/common/guards/roles.guard.ts`, `apps/backend/src/common/decorators/roles.decorator.ts`
- Pattern: `@Roles(UserRole.KUTUBXONACHI)` + `RolesGuard` reads `req.user.role` from JWT payload

**Kafka Topic Registry:**
- Purpose: Typed event bus for AI audit pipeline
- Location: `apps/backend/src/infra/kafka/kafka.service.ts` — `KAFKA_TOPICS` const object
- Pattern: Fire-and-forget with graceful degradation (no Kafka = silent log only)

## Entry Points

**Backend Bootstrap:**
- Location: `apps/backend/src/main.ts`
- Triggers: `npm run start:dev` / Docker CMD
- Responsibilities: Sentry init, global prefix `/api`, Helmet CSP, CORS whitelist, ValidationPipe, AllExceptionsFilter, LoggingInterceptor, Swagger (non-prod), port 4000

**Frontend Root:**
- Location: `apps/frontend/app/layout.tsx` (root), `apps/frontend/app/[locale]/layout.tsx` (locale)
- Triggers: Next.js build/runtime
- Responsibilities: NextIntlClientProvider wrapping, Providers (React Query + Zustand), PWA service worker registration, manifest meta tags

**Landing Page (sifat.uz):**
- Location: `apps/frontend/app/[locale]/page.tsx`
- Triggers: GET `/{locale}/` — Server Component, ISR revalidate 300s
- Responsibilities: Fetches national stats, top-5, donate stats in parallel; renders 9-block landing page

## Architectural Constraints

- **Threading:** Node.js single-threaded event loop; heavy cron tasks (nightly RI recalc for all users) run synchronously in a for-loop — scaling concern for 5M users
- **Global state:** `AuthModule` is decorated `@Global()` so `AuthService` and `JwtModule` are available without re-importing; `AppInfraModule` exports all infra services globally
- **Circular imports:** No circular imports detected; infra modules are imported leaf-first (PrismaModule has no local deps beyond `@prisma/client`)
- **Token storage:** Access and refresh tokens stored in `localStorage` (see `apps/frontend/lib/api/client.ts`), not HttpOnly cookies — deviation from TZ spec which mandates HttpOnly cookie for refresh token
- **Kafka degradation:** Kafka is optional at runtime (no `KAFKA_BROKERS` env = warn + skip). AI audit pipeline is therefore not guaranteed to receive events in dev/staging environments
- **Read replica:** No read replica configured; all queries hit the primary PostgreSQL; stats queries (national aggregates) could be heavy under 5M user load
- **OTP rate limiting:** In-memory `Map` in `AuthService.sendLog` — lost on restart, not horizontally scalable (`apps/backend/src/modules/auth/auth.service.ts:23`)

## Anti-Patterns

### In-Memory OTP Rate Limit

**What happens:** `AuthService` stores per-phone OTP send timestamps in a module-level `Map<string, number[]>`. On every new instance or restart the map is reset.
**Why it's wrong:** Will not work correctly under horizontal scaling (multiple backend instances) or after crash/redeploy.
**Do this instead:** Move rate limit state to Redis with a sorted set or counter key (e.g., `otp:rate:{phone}`) via `CacheService`.

### Tokens in localStorage

**What happens:** `apiClient` interceptor reads `localStorage.getItem("accessToken")` and `useAuthStore` writes refresh token to localStorage (`apps/frontend/lib/api/client.ts:11`, `apps/frontend/store/auth.store.ts:43`).
**Why it's wrong:** Exposes tokens to XSS attacks; TZ spec mandates HttpOnly cookie for refresh token.
**Do this instead:** Store refresh token in an HttpOnly cookie set by the backend `/api/auth/refresh` endpoint; keep access token in memory (Zustand, no persist).

### Nightly RI Cron as Sequential Loop

**What happens:** `ReadingService.recalculateAll()` iterates all ACTIVE users in a single for-loop, computing and writing each RI sequentially (`apps/backend/src/modules/reading/reading.service.ts:51`).
**Why it's wrong:** With 5M+ users, a sequential loop will take hours and block the scheduled runner thread.
**Do this instead:** Batch users by chunk (e.g., 1000 per batch), process batches in parallel with `Promise.all`, or dispatch to BullMQ workers.

## Error Handling

**Strategy:** Global `AllExceptionsFilter` normalizes all errors to a standard JSON shape `{ statusCode, message, error, timestamp, path }`. NestJS `HttpException`, Prisma known errors (P2002, P2025, P2003), and Prisma validation errors each have tailored status codes and messages.

**Patterns:**
- Prisma P2002 → HTTP 409 Conflict ("Bu ma'lumot allaqachon mavjud")
- Prisma P2025 → HTTP 404 Not Found
- Unexpected errors → HTTP 500, full stack logged to Sentry via `Logger.error()`
- Service-layer guard methods throw `NotFoundException`, `ForbiddenException`, `BadRequestException` which propagate through the filter

## Cross-Cutting Concerns

**Logging:** `LoggingInterceptor` logs method + URL + duration for every request (`apps/backend/src/common/interceptors/logging.interceptor.ts`). Each service class has `private readonly logger = new Logger(ServiceName.name)` for domain-specific logging. Sentry integrated via `apps/backend/src/infra/monitoring/sentry.ts`.

**Validation:** Class-validator DTOs enforced by global `ValidationPipe` with `whitelist: true` and `transform: true`. All controller inputs pass through DTO classes before reaching services.

**Authentication:** `JwtAuthGuard` extracts Bearer token from `Authorization` header, verifies with `JWT_SECRET`, and attaches payload to `req.user` (`apps/backend/src/common/guards/jwt-auth.guard.ts`). Refresh tokens are DB-persisted in `RefreshToken` table with revocation support.

---

*Architecture analysis: 2026-06-06*
