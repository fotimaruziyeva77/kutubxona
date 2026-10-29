# Codebase Structure

**Analysis Date:** 2026-06-06

## Directory Layout

```
Sifatlibrary/                        # Monorepo root
├── apps/
│   ├── backend/                     # NestJS API (Node.js 20, TypeScript)
│   │   ├── src/
│   │   │   ├── main.ts              # Bootstrap: Helmet, CORS, Swagger, port 4000
│   │   │   ├── app.module.ts        # Root module — imports all 20+ feature modules
│   │   │   ├── app.controller.ts    # Health check endpoint GET /health
│   │   │   ├── common/              # Cross-cutting: guards, filters, interceptors, decorators
│   │   │   │   ├── decorators/      # @CurrentUser(), @Roles()
│   │   │   │   ├── filters/         # AllExceptionsFilter (global)
│   │   │   │   ├── guards/          # JwtAuthGuard, RolesGuard
│   │   │   │   └── interceptors/    # LoggingInterceptor (global)
│   │   │   ├── infra/               # Infrastructure adapters (no business logic)
│   │   │   │   ├── app-infra.module.ts  # Bundles + re-exports all infra
│   │   │   │   ├── prisma/          # PrismaService (DB client)
│   │   │   │   ├── cache/           # CacheService (Redis, remember() helper)
│   │   │   │   ├── elasticsearch/   # SearchService + index mappings
│   │   │   │   ├── kafka/           # KafkaService + KAFKA_TOPICS const
│   │   │   │   ├── queue/           # QueueModule (BullMQ) + NotificationProcessor
│   │   │   │   ├── sms/             # SmsService (Eskiz.uz/SMS.uz adapter)
│   │   │   │   ├── vault/           # VaultService (HashiCorp Vault)
│   │   │   │   ├── pdf/             # PdfService (Puppeteer report generation)
│   │   │   │   ├── gateway/         # StatsGateway (Socket.io WebSocket /ws/stats)
│   │   │   │   └── monitoring/      # Prometheus MetricsModule + Sentry init
│   │   │   └── modules/             # Business domain modules
│   │   │       ├── auth/            # Phone OTP, JWT, token rotation, ID.UZ OAuth
│   │   │       ├── users/           # User CRUD, SifatID generation, profile
│   │   │       ├── geo/             # Viloyat/Tuman/Mahalla cascade lookups
│   │   │       ├── libraries/       # Library CRUD, 5-type, 3-step approval flow
│   │   │       ├── books/           # Book CRUD, Excel import, Elasticsearch index
│   │   │       ├── transactions/    # Reserve/borrow/return/roaming/ISBN scan
│   │   │       ├── reading/         # Reading Index formula + nightly cron
│   │   │       ├── top/             # Top-100 ranking, monthly scoring pipeline
│   │   │       ├── admin/           # Dashboard stats, Smart Alerts, user approval
│   │   │       ├── ai/              # Fraud, NLQ, predictions, audit, recommend
│   │   │       ├── school/          # Maktab module — student management
│   │   │       ├── club/            # Jadidlar izidan klub — debates, members
│   │   │       ├── family/          # Family unit, invites, family rating
│   │   │       ├── otm/             # OTM (university) module
│   │   │       ├── idora/           # Government org: book corner, reading hour
│   │   │       ├── payment/         # Payme, Click, invoices, subscriptions
│   │   │       ├── store/           # Book store operator cabinet
│   │   │       ├── badge/           # Gamification badge award logic
│   │   │       └── donate/          # Donation management + public leaderboard
│   │   ├── prisma/
│   │   │   ├── schema.prisma        # Full DB schema — 30+ models + enums
│   │   │   └── migrations/          # Timestamped Prisma migrations
│   │   ├── dist/                    # TypeScript build output (gitignored)
│   │   ├── package.json             # Backend deps (NestJS, Prisma, kafkajs, etc.)
│   │   └── tsconfig.json
│   │
│   └── frontend/                    # Next.js 14 (App Router, TypeScript)
│       ├── app/
│       │   ├── layout.tsx           # Root layout (no locale wrapper)
│       │   ├── page.tsx             # Redirects to default locale
│       │   ├── robots.ts            # SEO robots.txt generation
│       │   ├── sitemap.ts           # Dynamic sitemap.xml
│       │   └── [locale]/            # Locale-prefixed routes (uz-Latn, uz-Cyrl, ru, kaa)
│       │       ├── layout.tsx       # Locale layout: NextIntlProvider + Providers + SW reg
│       │       ├── page.tsx         # Landing page (Server Component, ISR 300s)
│       │       ├── login/           # Phone + password login
│       │       ├── register/        # 5-step registration wizard
│       │       │   └── success/     # Post-registration confirmation
│       │       ├── profile/         # Kitobxon profile, QR, Reading Index
│       │       ├── search/          # Location-based book search results
│       │       ├── top/             # Public Top-100 rankings (SSR + Client split)
│       │       ├── scan/            # QR scanner (PWA camera API)
│       │       ├── donate/          # Donation page + public donor list
│       │       ├── demo-request/    # B2B demo request form
│       │       ├── dokon/           # Book store operator cabinet
│       │       ├── family/          # Family management page
│       │       ├── library/
│       │       │   └── [code]/      # Library public profile (slug-based)
│       │       └── dashboard/       # Admin/staff dashboard (role-gated)
│       │           ├── layout.tsx   # Dashboard shell with sidebar
│       │           ├── page.tsx     # Dashboard home (stats overview)
│       │           ├── ai/          # AI Natural Language Interface
│       │           ├── alerts/      # Smart Alerts management
│       │           ├── books/       # Book fund management
│       │           ├── buxgalter/   # Accountant panel (payments, invoices)
│       │           ├── club/        # Jadidlar izidan club management
│       │           ├── demo-requests/  # B2B lead CRM
│       │           ├── family/      # Family admin view
│       │           ├── idora/       # Government org admin
│       │           ├── libraries/   # Library management
│       │           ├── muassasa/    # Institution admin
│       │           ├── otm/         # University admin
│       │           ├── school/      # School admin
│       │           ├── stats/       # Statistics panels (4-level hierarchy)
│       │           ├── transactions/  # Transaction management
│       │           └── users/       # User management + pending approvals
│       ├── components/
│       │   ├── map/                 # ViloyatMap.tsx (Leaflet.js wrapper)
│       │   ├── offline-banner.tsx   # PWA offline state banner
│       │   ├── providers.tsx        # React Query + Zustand context wrapper
│       │   └── ui/                  # shadcn/ui primitives (button, card, input)
│       ├── hooks/
│       │   ├── use-current-user.ts  # Auth state hook
│       │   └── useStatsSocket.ts    # Socket.io-client real-time stats hook
│       ├── lib/
│       │   ├── api/                 # API layer
│       │   │   ├── client.ts        # Axios instance + auto-refresh interceptor
│       │   │   ├── auth.ts          # Auth API calls (login, register, OTP)
│       │   │   ├── geo.ts           # Viloyat/Tuman/Mahalla fetch helpers
│       │   │   ├── libraries.ts     # Library API calls
│       │   │   ├── users.ts         # User API calls
│       │   │   └── index.ts         # Barrel export
│       │   ├── api-client.ts        # Legacy/alternate client (check for duplication)
│       │   ├── query-client.ts      # React Query client configuration
│       │   └── utils.ts             # cn() classname utility
│       ├── messages/                # i18n translation files (JSON per locale)
│       ├── store/
│       │   └── auth.store.ts        # Zustand auth store (persisted to localStorage)
│       ├── public/                  # Static assets, manifest.json, sw.js, icons
│       └── package.json             # Frontend deps (Next.js, Zustand, React Query, etc.)
│
├── infra/                           # DevOps / deployment configs
│   ├── nginx/                       # Nginx reverse proxy config
│   ├── monitoring/                  # Prometheus + Grafana dashboards
│   ├── vault/                       # HashiCorp Vault policy files
│   └── scripts/                     # Deploy and utility scripts
├── k6/                              # Load testing scripts (k6)
├── docker-compose.yml               # Local dev: PostgreSQL, Redis, Elasticsearch, Kafka, MinIO
├── docker-compose.prod.yml          # Production compose with replicas + SSL
├── .env.example                     # Template for required env vars
├── .env.prod.example                # Production env template
├── .github/                         # GitHub Actions CI/CD + PR template
├── package.json                     # Workspace root (turborepo or npm workspaces)
├── CLAUDE.md                        # Project TZ and sprint plan
└── CHANGELOG.md                     # Version changelog
```

## Directory Purposes

**`apps/backend/src/common/`:**
- Purpose: HTTP pipeline cross-cutting concerns shared by all modules
- Contains: Guards (`JwtAuthGuard`, `RolesGuard`), filter (`AllExceptionsFilter`), interceptor (`LoggingInterceptor`), decorators (`@CurrentUser`, `@Roles`)
- Key files: `guards/jwt-auth.guard.ts`, `guards/roles.guard.ts`, `filters/all-exceptions.filter.ts`

**`apps/backend/src/infra/`:**
- Purpose: Adapters for all external services — no business logic here
- Contains: Database (Prisma), cache (Redis), search (Elasticsearch), messaging (Kafka, BullMQ), SMS, secrets (Vault), PDF, WebSocket gateway, monitoring
- Key files: `prisma/prisma.service.ts`, `cache/cache.service.ts`, `kafka/kafka.service.ts`, `gateway/stats.gateway.ts`

**`apps/backend/src/modules/`:**
- Purpose: All business domain logic, organized by feature domain
- Contains: For each domain — `*.module.ts`, `*.service.ts`, `*.controller.ts`, `__tests__/*.spec.ts`
- Key files: `transactions/transactions.service.ts` (core book flow), `reading/reading.service.ts` (RI formula), `ai/fraud.service.ts` (fraud detection)

**`apps/backend/prisma/`:**
- Purpose: Database schema and migration history
- Contains: `schema.prisma` (30+ models), `migrations/` (timestamped SQL migrations)
- Key files: `schema.prisma` — single source of truth for all DB models and enums

**`apps/frontend/app/[locale]/`:**
- Purpose: All user-facing pages under i18n locale prefix
- Contains: Next.js route segments; Server Components for data fetching, Client Components for interactivity
- Key files: `page.tsx` (landing, ISR), `dashboard/layout.tsx` (admin shell), `register/page.tsx` (5-step wizard)

**`apps/frontend/lib/api/`:**
- Purpose: All API communication with the NestJS backend
- Contains: Axios `apiClient` with JWT interceptor, typed API function modules per domain
- Key files: `client.ts` (configured axios instance), `auth.ts`, `libraries.ts`, `geo.ts`

**`apps/frontend/store/`:**
- Purpose: Client-side persistent state
- Contains: Zustand stores
- Key files: `auth.store.ts` — user object, access/refresh tokens, isAuthenticated flag, persisted to `localStorage` under key `sifat-auth`

**`apps/frontend/components/ui/`:**
- Purpose: shadcn/ui primitive components
- Contains: Minimal set currently: `button.tsx`, `card.tsx`, `input.tsx`
- Note: Extend here when adding new UI primitives

**`infra/`:**
- Purpose: Server provisioning, proxy config, and operational tooling
- Contains: Nginx configs, Prometheus/Grafana dashboards, Vault policies, deploy scripts
- Generated: No — these are source-controlled configs

## Key File Locations

**Entry Points:**
- `apps/backend/src/main.ts`: NestJS bootstrap, global middleware, port 4000
- `apps/frontend/app/[locale]/layout.tsx`: Next.js locale root with i18n + providers
- `apps/frontend/app/[locale]/page.tsx`: Landing page (sifat.uz home)

**Configuration:**
- `apps/backend/prisma/schema.prisma`: Complete DB schema with all models
- `docker-compose.yml`: Local service definitions (PostgreSQL :55432, Redis :56379, ES :9200, Kafka :9092)
- `.env.example`: Required environment variables template
- `apps/backend/src/app.module.ts`: Feature module registry and global rate limiting config

**Core Logic:**
- `apps/backend/src/modules/transactions/transactions.service.ts`: Book lifecycle state machine
- `apps/backend/src/modules/reading/reading.service.ts`: Reading Index formula (weights + cron)
- `apps/backend/src/modules/ai/fraud.service.ts`: Fraud detection rules + daily scan
- `apps/backend/src/infra/kafka/kafka.service.ts`: Event topics + typed emit helpers

**Testing:**
- `apps/backend/src/modules/*/__tests__/*.spec.ts`: Unit tests co-located with each module
- `apps/backend/src/common/filters/__tests__/`: Filter unit tests
- `k6/`: Load testing scripts for 50K concurrent user simulation

## Naming Conventions

**Files (Backend):**
- Pattern: `kebab-case.type.ts` where type is `module`, `service`, `controller`, `guard`, `filter`, `interceptor`, `decorator`, `spec`
- Examples: `auth.service.ts`, `jwt-auth.guard.ts`, `all-exceptions.filter.ts`, `auth.service.spec.ts`
- Test files: `__tests__/auth.service.spec.ts` — co-located in `__tests__/` subfolder within each module

**Files (Frontend):**
- Route files: Next.js conventions — `page.tsx`, `layout.tsx`
- Client components: PascalCase with `Client` suffix when paired with a server page (`TopClient.tsx`, `LibraryProfileClient.tsx`)
- Hooks: `use-kebab-case.ts` or `useCamelCase.ts` (mixed — prefer `useCamelCase.ts`)
- Stores: `noun.store.ts` (e.g., `auth.store.ts`)

**Directories:**
- Backend modules: `lowercase` single-word domain names (`auth`, `books`, `transactions`, `reading`)
- Frontend routes: Next.js conventions — `[locale]`, `[code]` for dynamic segments; `kebab-case` for static segments

**TypeScript:**
- Interfaces: PascalCase (e.g., `FraudAnalysis`, `KafkaEvent<T>`)
- Enums: PascalCase names, UPPER_SNAKE_CASE values (from Prisma schema: `UserRole.SUPER_ADMIN`)
- Constants: `UPPER_SNAKE_CASE` for config values (`BORROW_DAYS = 14`, `KAFKA_TOPICS`)

## Where to Add New Code

**New Backend Feature Module:**
1. Create directory: `apps/backend/src/modules/<domain>/`
2. Create files: `<domain>.module.ts`, `<domain>.service.ts`, `<domain>.controller.ts`
3. Create test dir: `apps/backend/src/modules/<domain>/__tests__/<domain>.service.spec.ts`
4. Register in: `apps/backend/src/app.module.ts` — add to `imports` array
5. If the module needs DB, Prisma, Redis, Kafka: import `AppInfraModule` (already globally available via `PrismaModule` etc.)

**New Frontend Page (authenticated):**
1. Create: `apps/frontend/app/[locale]/dashboard/<page-name>/page.tsx`
2. If data-heavy on client: create a `*Client.tsx` sibling component with `"use client"`
3. API calls: add typed function to `apps/frontend/lib/api/<domain>.ts`
4. If needs real-time: use `useStatsSocket` hook from `apps/frontend/hooks/useStatsSocket.ts`

**New Frontend Public Page:**
1. Create: `apps/frontend/app/[locale]/<page-name>/page.tsx` as Server Component
2. Fetch data server-side with `fetch(..., { next: { revalidate: N } })` pattern
3. Add i18n strings to `apps/frontend/messages/<locale>.json` files

**New API Endpoint on Existing Module:**
1. Add method to `apps/backend/src/modules/<domain>/<domain>.service.ts`
2. Add route handler to `apps/backend/src/modules/<domain>/<domain>.controller.ts` with appropriate `@UseGuards()` and `@Roles()` decorators
3. Add corresponding test to `apps/backend/src/modules/<domain>/__tests__/<domain>.service.spec.ts`

**New DB Model:**
1. Add model to `apps/backend/prisma/schema.prisma`
2. Run: `npx prisma migrate dev --name <description>` from `apps/backend/`
3. Import generated types from `@prisma/client` in service files

**New Kafka Topic:**
1. Add topic name to `KAFKA_TOPICS` const in `apps/backend/src/infra/kafka/kafka.service.ts`
2. Add typed emit helper method to `KafkaService` following existing pattern

**New Shared UI Component:**
1. Create in: `apps/frontend/components/ui/<component-name>.tsx`
2. Follow shadcn/ui `cn()` pattern for class merging

## Special Directories

**`apps/backend/dist/`:**
- Purpose: TypeScript compilation output
- Generated: Yes (by `tsc` / `nest build`)
- Committed: No (in `.gitignore`)

**`apps/frontend/.next/`:**
- Purpose: Next.js build output and cache
- Generated: Yes
- Committed: No

**`apps/backend/src/coverage/`:**
- Purpose: Jest test coverage reports (lcov format)
- Generated: Yes (by `jest --coverage`)
- Committed: No (should be in `.gitignore`)

**`apps/backend/src/__mocks__/@nestjs/`:**
- Purpose: Manual mocks for NestJS dependencies in unit tests
- Generated: No — hand-written
- Committed: Yes

**`apps/backend/prisma/migrations/`:**
- Purpose: Versioned database migration SQL files
- Generated: Partially (by `prisma migrate dev`)
- Committed: Yes — critical for reproducible deployments

**`infra/`:**
- Purpose: Operational configuration for servers, proxy, monitoring, secrets
- Generated: No
- Committed: Yes

**`k6/`:**
- Purpose: Load testing scripts for verifying 50K concurrent user SLA
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-06*
