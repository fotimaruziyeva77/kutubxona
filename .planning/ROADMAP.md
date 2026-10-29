# Roadmap: SIFAT Library

## Overview

SIFAT Library is a brownfield platform with 27 frontend pages and 20 backend controllers already scaffolded. The UI layer is largely complete but backend business logic remains stub-level for critical subsystems: Reading Index calculation, fraud detection, payment processing, AI analytics, and offline PWA. This roadmap organizes the remaining work into 7 phases following dependency order -- infrastructure fixes that unblock registration, then the RI engine that powers rankings, then payments that enable revenue, then the monitoring layer (stats/alerts/maps), then PQ-9 compliance modules (school/family/org/university), then AI analytics, and finally production hardening with offline PWA, translations, and security testing.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Infrastructure Hardening & Authentication** - Fix 6 critical bugs, enable real SMS-based registration, secure token storage and Vault (completed 2026-06-08)
- [x] **Phase 2: Reading Index Engine & Core Book Logic** - Batch RI calculation, comprehension tests, book management hardening, store integration (completed 2026-06-08)
- [x] **Phase 3: Rankings, Gamification & Donations** - Top-100 workflow, leaderboards, badge system, donation module (completed 2026-06-06)
- [x] **Phase 4: Payment & Subscriptions** - Payme/Click integration, invoice generation, subscription lifecycle, buxgalter panel (completed 2026-06-08)
- [x] **Phase 5: Statistics, Alerts, Maps & Landing Page** - 4-level dashboards, smart alerts, interactive map, reports, landing page live data (completed 2026-06-08)
- [x] **Phase 6: School, Family, Organization & University Modules** - PQ-9 compliance: Jadidlar izidan clubs, family rankings, idora modules, OTM (completed 2026-06-08)
- [x] **Phase 7: Offline PWA, Internationalization & Production Launch** - Service Worker, translations, security testing, load testing, accessibility
 (completed 2026-06-09)
- [x] **Phase 8: Bookstore Ecosystem** - Store product catalog, CRM dashboard, public profiles, price-aware search, premium badges (completed 2026-06-09)

## Phase Details

### Phase 1: Infrastructure Hardening & Authentication

**Goal**: Platform infrastructure is production-ready and users can register via real SMS OTP with secure token handling
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05, INFRA-06, INFRA-07, INFRA-08, INFRA-09, INFRA-10, AUTH-01, AUTH-02, AUTH-03, AUTH-04, NOTIF-01, NOTIF-04
**Success Criteria** (what must be TRUE):

  1. A new user can register by entering their phone number, receiving a real SMS OTP via Eskiz.uz, and completing the 5-step wizard to get a unique SL-UZ ID
  2. Refresh tokens are stored in HttpOnly cookies (not localStorage), and OTP rate limiting persists across server restarts via Redis
  3. The application fails to start in production mode if VAULT_TOKEN is missing (no silent fallback to dev token)
  4. WebSocket messages are delivered to all connected clients regardless of which server instance they are connected to (Redis adapter configured)
  5. Kafka consumer service is activated and processing events from existing producer topics

**Plans**: 6 plans
Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Notifications & SMS foundation (Eskiz client, enable @Processor, OTP delivery)
- [x] 01-02-PLAN.md — Vault fail-hard, Asia/Tashkent timezone, ReadingIndex index + DB push
- [x] 01-03-PLAN.md — Redis OTP rate limit, OTP length, global JwtAuthGuard + @Public()
- [x] 01-05-PLAN.md — WebSocket Redis adapter + Kafka consumer activation

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-04-PLAN.md — Refresh token to HttpOnly cookie + locale-prefix redirect

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-06-PLAN.md — OneID OAuth fix (checkpoint), AUTH-04 verify, PgBouncer + read replica *(Tasks 1/3/4 code-complete; Task 2 live OneID handshake PENDING IDUZ_CLIENT_ID/SECRET — see 01-06-SUMMARY.md)*

**UI hint**: yes

### Phase 2: Reading Index Engine & Core Book Logic

**Goal**: Every user's Reading Index is calculated nightly via batch processing, comprehension tests prevent fraud, and book management flows are hardened
**Depends on**: Phase 1
**Requirements**: RI-01, RI-02, RI-03, RI-04, RI-05, FRAUD-01, FRAUD-02, FRAUD-03, FRAUD-04, FRAUD-05, FRAUD-06, BOOK-01, BOOK-02, BOOK-03, BOOK-04, BOOK-05, STORE-01, STORE-02, STORE-03
**Success Criteria** (what must be TRUE):

  1. Reading Index recalculation completes for all active users in under 2 hours nightly (BullMQ batched, not sequential), and users can see their daily/weekly/monthly RI change
  2. Comprehension test randomizes answer positions, enforces minimum response time, and uses FLAGGED status with admin review queue instead of auto-blocking users
  3. A kutubxonachi can process inter-library roaming: a reader from Navoiy can borrow a book in Toshkent and return it in either city with bilateral confirmation
  4. Book availability count remains accurate across all code paths (borrow, return, reserve, cancel, expire) using interactive Prisma transactions with CHECK constraints
  5. Store operators can enter purchases (phone + ISBN) with proper authorization, and readers confirm within 24 hours for RI credit at 0.9x coefficient

**Plans**: 5 plans

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Wave-0 + Wave-1 surgical fixes: exceljs dep + RI_RECALC_QUEUE; comprehension randomization + min-time; store auth; FLAGGED rename; per-source RI coefficient; reserve-time limit

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — Schema migrations (BookTransaction.extended + Book CHECK; BookTransfer model + index capture; ReadingIndex PARTITION BY RANGE); [BLOCKING] prisma migrate; interactive $transaction conversion

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-03-PLAN.md — RI batch engine: PrismaReplicaService; RiRecalcProcessor (concurrency 10) with reading-speed Trust Score signal; addBulk fan-out cron dispatcher

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-04-PLAN.md — Async jobs + admin review: Excel import as BullMQ job (xlsx removal); FRAUD-03 review queue + UI wiring; RI-04 delta endpoint; RI-03 monthly partition cleanup; STORE-01 24h expiry

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 02-05-PLAN.md — Roaming finalize + overdue verify: BOOK-02 confirm endpoint + SMS; BOOK-04 cron rename + verify; FRAUD-05 comprehension pass-rate signal; STORE-02 end-to-end spec

**Waves:**

- Wave 1: 02-01
- Wave 2: 02-02 (depends on 02-01)
- Wave 3: 02-03 (depends on 02-01, 02-02)
- Wave 4: 02-04 (depends on 02-01, 02-02, 02-03)
- Wave 5: 02-05 (depends on 02-01, 02-02, 02-03, 02-04)

### Phase 3: Rankings, Gamification & Donations

**Goal**: Top-100 rankings are published monthly with fraud verification, badges motivate readers, and donations flow transparently
**Depends on**: Phase 2
**Requirements**: TOP-01, TOP-02, TOP-03, TOP-04, TOP-05, TOP-06, TOP-07, TOP-08, FRAUD-07, FRAUD-08, GAME-01, GAME-02, GAME-03, DONAT-01, DONAT-02, DONAT-03
**Success Criteria** (what must be TRUE):

  1. Top-100 monthly workflow executes automatically: auto-rank on 28th, fraud check on 29th, admin review on 30th, publish on 1st -- with children under 14 anonymized in public rankings
  2. Users can filter rankings by gender (male/female), age group (7-14, 15-30, 31-60, 60+), and institution type (schools, universities, organizations, provinces, districts)
  3. Users earn and see badges on their profile ("First 10 books", "Top-100", "30-day streak") with notifications when new badges are earned
  4. Users can donate via Payme/Click with purpose selection, and the public donor list shows transparent allocation tracking

**Plans**: 4 plans
Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Wave 0 utilities: privacy-mask helper, IpWhitelistGuard, DEV_DONATION_PAYMENT_STUB fail-hard, Kafka topic constants, seedBadges wiring

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — Top-100 4-cron state machine (28->29->30->1) + FRAUD-07 multi-layer gate + TOP-08 leaderboard SQL fix + replica-backed compute + anonymization

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-03-PLAN.md — TOP-05 institutional rankings + FRAUD-08 inventory reconciliation (alert-only) + donation hardening (stub flag, idempotency, IP whitelist, spending + admin breakdown)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-04-PLAN.md — TOP-07 real-time WebSocket wire + GAME-01/02/03 badge triggers + Kafka notify + GET /users/me/badges + profile widget + admin review queue UI + admin donations dashboard

**UI hint**: yes

### Phase 4: Payment & Subscriptions

**Goal**: Libraries can pay for subscriptions via Payme/Click, invoices are generated automatically, and the buxgalter has a full financial panel
**Depends on**: Phase 1
**Requirements**: PAY-01, PAY-02, PAY-03, PAY-04, PAY-05, PAY-06, PAY-07, PAY-08, RPT-03
**Success Criteria** (what must be TRUE):

  1. A library admin can pay a subscription invoice via Payme or Click, and the subscription automatically activates within 30 seconds of confirmed payment
  2. Payment webhooks are idempotent (Redis SETNX), signature-verified, and wrapped in Prisma transactions -- duplicate webhooks return cached responses without double-processing
  3. Subscription lifecycle works end-to-end: TRIAL (30 days) -> PENDING (invoice generated) -> ACTIVE (payment confirmed), with freeze/delete being admin-only actions requiring stated reasons
  4. Buxgalter can view all payments, invoices, monthly/yearly revenue, and export to Excel/PDF/1C format

**Plans**: 4 plans

Plans:
**Wave 1**

- [ ] 04-01-PLAN.md — Wave 0 primitives + critical bug fixes: Click HMAC formula fix (RED->GREEN), Buxgalter UI cookie-auth migration, RedisLockService + CacheService.setNx/getRaw, PAYMENT_TIMEOUT_QUEUE registration, KAFKA_TOPICS additions, DEV_SUBSCRIPTION_PAYMENT_STUB pattern (mirrors Phase 3), main.ts production env asserts

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 04-02-PLAN.md — Webhook hardening + atomicity + 12h timeout: Payme/Click typed DTOs, IpWhitelistGuard wiring, RedisLockService idempotency, interactive $transaction wrapping all state mutations + AiAuditLog, PaymentTimeoutProcessor with deterministic jobId + reason=4 mapping

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 04-03-PLAN.md — Subscription state machine + invoice PDF QR + admin UI: [BLOCKING] schema migration (Subscription frozenReason/frozenAt/frozenBy + deleted-*), invoice PDF QR code embed, 5x5 transition validator with SYSTEM bypass whitelist, admin-only freeze/delete with reason, /dashboard/subscriptions + /dashboard/library/billing pages

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 04-04-PLAN.md — Reminders via NOTIFICATION_QUEUE + Buxgalter panel: consolidated payment-reminder cron (templated, non-blocking), aggregations on PrismaReplicaService + 5-min Redis cache with webhook-side invalidation, real XLSX export (exceljs) + 1C CSV per OQ-3 (blank bank columns per OQ-4), Buxgalter UI 3-button export

**Waves:**

- Wave 1: 04-01
- Wave 2: 04-02 (depends on 04-01)
- Wave 3: 04-03 (depends on 04-01, 04-02)
- Wave 4: 04-04 (depends on 04-01, 04-02, 04-03)

**UI hint**: yes

### Phase 5: Statistics, Alerts, Maps & Landing Page

**Goal**: Admins at every level see real-time statistics with actionable alerts, the interactive map visualizes reading levels, and the landing page shows live data
**Depends on**: Phase 2
**Requirements**: STAT-01, STAT-02, STAT-03, STAT-04, STAT-05, STAT-06, STAT-07, ALERT-01, ALERT-02, ALERT-03, ALERT-04, ALERT-05, ALERT-06, MAP-01, MAP-02, MAP-03, RPT-01, RPT-02, NOTIF-02, NOTIF-03, LAND-01, LAND-02, LAND-03
**Success Criteria** (what must be TRUE):

  1. Dashboard stat cards at all 4 hierarchy levels (Republic, Viloyat, Tuman, Mahalla) show real data from backend API, with stats pre-aggregated to Redis (national/5min, tuman/15min)
  2. Smart alerts fire automatically: a tuman admin gets an email when their district has 0 active readers for 2 weeks, or when RI drops 10%+, and super admin gets SMS when the system goes down
  3. The interactive Leaflet.js map shows Uzbekistan colored by reading index (green/yellow/red), and clicking a district opens its detail statistics panel
  4. Monthly PDF analytics reports are auto-generated on the 1st of each month and emailed to admins at their scope level
  5. Landing page hero section shows real-time statistics (refreshing every 30 seconds), B2B demo requests flow to admin CRM, and social sharing meta tags render correctly

**Plans**: 9 plans

> Note: Sequential waves drive maximum quality -- same-wave plans MUST have zero files_modified overlap per planner protocol. Only Wave 5 (05-05 backend-only + 05-06 frontend-only) is parallelizable.

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Wave 0 foundations: slopcheck human-verify gate, FcmClient + MailClient scaffolds (dev no-op + prod fail-hard), DeviceToken Prisma migration, ALERT_TYPES + CacheService + KAFKA_TOPICS extensions, GeoJSON viloyat build script + simplified asset

**Wave 2** *(depends on 05-01)*

- [x] 05-02-PLAN.md — Stats hardening: PrismaReplicaService routing + per-viloyat RI GROUP BY fix + scope-guard helpers (Q6) + mahalla endpoint (30min, on-demand per Q3) + STATS_AGGREGATION_QUEUE + 5min/15min pre-agg crons + dashboard SSR prefetch + delete simulated RI line

**Wave 3** *(depends on 05-01, 05-02)*

- [x] 05-03-PLAN.md — Stats expansion: getAgeGroup util promotion + gender/age/genre-trend scope-aware services + STAT-07 markBookForOrder via AiAuditLog ORDER_REQUEST + 3 chart components + ShortageTab Buyurtma button

**Wave 4** *(depends on 05-01, 05-03)*

- [x] 05-04-PLAN.md — Notification infra: sendPush -> FcmClient + InvalidFcmTokenError cleanup + sendEmail -> MailClient + escape-html.util consolidation + POST/DELETE /users/me/fcm-token + POST /admin/test-push + frontend FcmTokenRegistrar

**Wave 5** *(parallelizable; 05-05 + 05-06 have zero file overlap; depend on 05-01, 05-02, 05-04)*

- [x] 05-05-PLAN.md — Consolidated alerts: _buildTumanRiMap GROUP BY S1 fix + _checkInactiveTumans (ALERT-01) + threshold fixes (ALERT-03 50/0, ALERT-04 30d) + _checkTumanRiRises weekly (ALERT-05) + AlertDispatchService recipient-aware dedup + POST /admin/system-down-test + delete admin.checkSmartAlerts + frontend ALERT_TYPE_LABELS
- [x] 05-06-PLAN.md — Choropleth map: map-color util + ViloyatMap L.geoJSON polygons (delete circleMarker) + stats/page.tsx wiring real per-viloyat RI + mobile fallback grid preserved

**Wave 6** *(depends on 05-02, 05-05, 05-06)*

- [x] 05-07-PLAN.md — Real-time WebSocket: emitStatsRefresh + emitTumanAlerted + STATS_ROOM_KEYS + StatsAggregationProcessor emit + KafkaConsumer RI_RISING/SYSTEM_DOWN/ALERT_FIRED + useStatsSocket hook + dashboard live merge

**Wave 7** *(depends on 05-02, 05-04, 05-05)*

- [x] 05-08-PLAN.md — Monthly PDF reports: ReportDataService.gatherForScope + PdfService scope-parameterized template (escapeHtml) + ReportEmailProcessor (concurrency 2 per PITFALLS M6) + monthly cron @5am 1st of month + 215 jobs deterministic jobId + ADMIN_NOTIFICATION_EMAILS fallback (Q7)

**Wave 8** *(depends on 05-01, 05-02, 05-04)*

- [x] 05-09-PLAN.md — Landing + B2B + SEO: GET /landing/stats sanitized public endpoint (30s cache) + LiveStatsRefresher 30s polling component + JsonLdStructuredData + Twitter Card metadata + createDemoRequest email side-effect (escapeHtml) + 3/hour rate limit per phone via incrWithTtl

**Waves:**

- Wave 1: 05-01
- Wave 2: 05-02
- Wave 3: 05-03
- Wave 4: 05-04
- Wave 5: 05-05, 05-06 (parallel -- backend vs frontend)
- Wave 6: 05-07
- Wave 7: 05-08
- Wave 8: 05-09

**UI hint**: yes

### Phase 6: School, Family, Organization & University Modules

**Goal**: All PQ-9 compliance modules are operational -- schools track Jadidlar izidan clubs, families compete on reading, organizations report kitob burchagi and reading hours, universities generate accreditation reports
**Depends on**: Phase 2, Phase 3
**Requirements**: SCH-01, SCH-02, SCH-03, SCH-04, SCH-05, SCH-06, SCH-07, SCH-08, SCH-09, FAM-01, FAM-02, FAM-03, FAM-04, FAM-05, FAM-06, ORG-01, ORG-02, ORG-03, ORG-04, ORG-05, ORG-06, ORG-07, UNI-01, UNI-02, UNI-03, UNI-04
**Success Criteria** (what must be TRUE):

  1. A school admin can view students by class, monitor their reading activity, manage a Jadidlar izidan club (with parent SMS consent for under-18), record debates with mandatory photo/video, and generate a one-button PQ-9 PDF report
  2. The system detects families by matching addresses, supports manual invitations, calculates family average RI (with 30-day waiting period for new members), and displays Top-50 families publicly
  3. An organization HR admin can manage employees by department, view internal RI rankings, create "Kitob o'qish soati" events with QR attendance, verify "Kitob burchagi" with photos, and generate a one-button PQ-9 report
  4. OTM admins can verify students by faculty, view faculty-level statistics, manage academic literature, and generate accreditation PDF reports

**Plans**: 7 plans

Plans:
**Wave 0**

- [x] 06-01-PLAN.md — Wave 0 hardening: UNI-01/02 P1 bugfix (universityId + STUDENT_UNIVERSITY) + ORG-06/UNI-03 PDF XSS escapeHtml + R-DUP delete of SchoolService.computeSchoolRatings + IdoraService.computeAndSaveRating + 3 Prisma migrations (FamilyMembership + AddressChangeRequest + User.familyDetectionEnabled; ClubMemberConsentToken; DebateMedia/ReadingHourMedia/BookCornerVerification) + MinIO infra + assertInstitutionInScope util + family.service replica routing + FAM-06 $transaction TOCTOU wrapper

**Wave 1** *(blocked on Wave 0 completion; 06-02 + 06-03 are parallel-safe -- zero files_modified overlap)*

- [x] 06-02-PLAN.md — School module: SCH-01 scope guards + K-anon; SCH-02 reject endpoint + AiAuditLog; SCH-06 20-book goal monitor; SCH-07 weekly leader-locked READ cache refresh; SCH-08 PQ-9 PDF Jadidlar section with escapeHtml; SCH-09 inactive-club threshold = 30 days
- [x] 06-03-PLAN.md — Family module: FAM-01 opt-IN detection; FAM-03 30-day filter via FamilyMembership.joinedAt; FAM-04 replica routing; FAM-05 Top-50 with maskNameIfMinor + public family profile; FAM-06 AddressChangeRequest endpoint set with TUMAN_ADMIN approval

**Wave 2** *(blocked on Wave 1 completion; 06-04 + 06-05 are parallel-safe -- zero files_modified overlap)*

- [x] 06-04-PLAN.md — Club consent + debate media: SCH-03 CRUD + scope guards; SCH-04 bcrypt deep-link parent consent + 48h TTL + expiry cron; SCH-05 MinIO upload + file-type sniff + sharp thumbnail + DRAFT->PUBLISHED state machine
- [x] 06-05-PLAN.md — Idora HR module: ORG-01 employees-by-department + approve/reject; ORG-02 internal-rating read-only; ORG-04 90-day BookCorner reminder cron via AlertDispatchService + verify endpoint with MinIO; ORG-05 Mukofot taklifi audit + HR email + self-nomination flag; ORG-06 PQ-9 PDF composer + subscription gate; ORG-07 Kasb adabiyotlar CRUD

**Wave 3** *(blocked on Wave 2 completion; 06-06 + 06-07 are parallel-safe -- zero files_modified overlap)*

- [x] 06-06-PLAN.md — Reading Hour event (ORG-03): event CRUD + DRAFT/PUBLISHED state + HMAC-rotating QR (5min window) + attendance @@unique + ReadingHourMedia MinIO upload + monthly summary for PQ-9 PDF
- [x] 06-07-PLAN.md — OTM module: UNI-01 approve/reject (continues Wave 0 fix); UNI-02 byFaculty grouping + K-anon; UNI-03 akkreditatsiya PDF composer with byFaculty + checklist + escapeHtml + subscription gate; UNI-04 faculty-admin aggregated view + student-self own progress

**Waves:**

- Wave 0: 06-01 (BLOCKING -- schema + bug fixes + MinIO infra)
- Wave 1: 06-02 (School) + 06-03 (Family) -- parallel
- Wave 2: 06-04 (Club + debate media; consumes 06-02 club.service) + 06-05 (Idora HR; consumes 06-01 MinIO + R-DUP fix) -- parallel
- Wave 3: 06-06 (Reading Hour; consumes 06-05 idora.service) + 06-07 (OTM; consumes 06-05 pdf.service) -- parallel

**UI hint**: yes

### Phase 7: Offline PWA, Internationalization & Production Launch

**Goal**: The platform works offline for 12 hours in rural areas, supports all 4 languages, passes security and load testing, and is deployed to production at sifat.uz
**Depends on**: Phase 5, Phase 6
**Requirements**: PWA-01, PWA-02, PWA-03, PWA-04, PWA-05, PWA-06, I18N-01, I18N-02, I18N-03, PERF-01, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, AI-01, AI-02, AI-03, AI-04, AI-05
**Success Criteria** (what must be TRUE):

  1. A rural kutubxonachi can scan QR codes, lend/return books, and browse the library catalog for 12 hours without internet -- all transactions sync automatically when connectivity returns, with auth tokens included in replay requests
  2. The platform UI is fully translated into Karakalpak and Russian, and Elasticsearch returns search results across Latin/Cyrillic scripts
  3. Load testing confirms 50,000 concurrent users with API p95 < 200ms, penetration testing reveals no P1 critical vulnerabilities, and Lighthouse scores exceed 90 for Performance and Accessibility
  4. AI NLP chat answers admin questions in Uzbek using SQL templates enriched by GPT-4, real-time audit detects anomalies via Kafka, and book recommendations use collaborative + content-based filtering
  5. Users can hide their reading history (privacy option), and append-only audit logs are retained for 2 years with archive migration

**Plans**: 7 plans

Plans:
**Wave 1**

- [x] 07-01-PLAN.md — Wave 0 foundations: install @serwist/next + dexie + uuid, replace hand-written sw.js with Serwist SW source, create Dexie offline DB schema, add 2G detection utility, Prisma migration (User.hideReadingHistory + AiAuditLog partitioning), ES ICU plugin in docker-compose

**Wave 2** *(blocked on Wave 1; 07-02 + 07-03 are parallel-safe -- zero files_modified overlap)*

- [x] 07-02-PLAN.md — Offline sync engine: Background Sync replay with auth token refresh, conflict resolver (last-write-wins), OfflineBanner + SyncStatusBadge + LiteModeBanner components, privacy service (PERF-06), audit partition cleanup cron (PERF-05)
- [x] 07-03-PLAN.md — Internationalization: sync kaa/ru/uz-Cyrl translations to uz-Latn keys, build-time i18n key checker, Elasticsearch ICU multi-script analyzer with Cyrillic-Latin transliteration

**Wave 3** *(blocked on Wave 1, Wave 2; 07-04 + 07-05 are parallel-safe -- zero files_modified overlap)*

- [x] 07-04-PLAN.md — AI NLQ + Kafka audit: expand NLQ to 20+ SQL templates, real-time Kafka audit consumer (event-driven anomaly detection), root cause analysis wired to alert pipeline
- [x] 07-05-PLAN.md — AI recommendations + predictions: wire recommendation engine to frontend profile page, verify prediction endpoint with RI forecast + confidence interval

**Wave 4** *(blocked on Wave 1, 07-02, 07-03)*

- [x] 07-06-PLAN.md — Testing infrastructure: k6 load test scripts (5K VU ramp), OWASP ZAP baseline config, axe-core accessibility audit, SkipNavLink component, Lighthouse CI config

**Wave 5** *(blocked on all previous waves)*

- [x] 07-07-PLAN.md — Final integration + human verify: wire offline + accessibility components into layout, full backend test suite verification, production-readiness checkpoint (offline, i18n, privacy, recommendations, accessibility)

**Waves:**

- Wave 1: 07-01
- Wave 2: 07-02 + 07-03 (parallel -- offline vs i18n, zero file overlap)
- Wave 3: 07-04 + 07-05 (parallel -- AI NLQ/audit vs recommendations/predict, zero file overlap; blocked on Wave 1 + Wave 2)
- Wave 4: 07-06 (depends on 07-01, 07-02, 07-03)
- Wave 5: 07-07 (depends on all)

**UI hint**: yes

### Phase 8: Bookstore Ecosystem

**Goal**: Bookstore operators can manage their product catalog with prices, readers find nearby affordable books through search, and stores have CRM analytics to track platform-driven traffic
**Depends on**: Phase 2 (store integration), Phase 7 (Elasticsearch multi-script)
**Requirements**: SHOP-01, SHOP-02, SHOP-03, SHOP-04, SHOP-05, SHOP-06, SHOP-07
**Success Criteria** (what must be TRUE):

  1. A store operator can add books to their catalog (manually or via Excel import) with ISBN, price, stock count, and the catalog is searchable by readers
  2. Each store has a public profile page (/dokon/[slug]) showing location on map, working hours, available books with prices, and reviews
  3. When a reader searches for a book, results show nearby stores with prices and stock alongside library availability (sorted by distance)
  4. Store operators have a CRM dashboard showing platform-driven customers, monthly sales trends, top-selling books, and conversion metrics
  5. Verified partner stores display a Premium badge in search results and on their profile page

**Plans**: 4 plans

Plans:
**Wave 1**

- [x] 08-01-PLAN.md — Schema + data layer: Store + StoreProduct Prisma models, ES sifat_store_products index mapping, DTOs, STORE_PRODUCT_IMPORT_QUEUE, product CRUD API + Excel import processor, premium badge endpoint, [BLOCKING] prisma db push

**Wave 2** *(blocked on Wave 1; 08-02 + 08-03 are parallel-safe -- zero files_modified overlap)*

- [x] 08-02-PLAN.md — Search integration: store product search with geo_distance sort + price/stock filters, extend book search to return storeResults[] alongside library books
- [x] 08-03-PLAN.md — CRM dashboard backend: platform-driven customer analytics, monthly sales trends, top-selling books, conversion metrics, ownership-scoped access

**Wave 3** *(blocked on Wave 1, Wave 2)*

- [x] 08-04-PLAN.md — Frontend pages: public store profile (/dokon/[slug]) with map + products + premium badge, CRM dashboard (/dokon/[slug]/dashboard) with charts + metrics, updated operator home

**Waves:**

- Wave 1: 08-01
- Wave 2: 08-02 + 08-03 (parallel -- search vs CRM, zero file overlap)
- Wave 3: 08-04 (depends on 08-01, 08-02, 08-03)

**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8
Note: Phase 4 depends only on Phase 1 and can execute in parallel with Phase 2/3 if resources allow.

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 1. Infrastructure Hardening & Authentication | 6/6 | Complete   | 2026-06-08 |
| 2. Reading Index Engine & Core Book Logic | 5/5 | Complete   | 2026-06-08 |
| 3. Rankings, Gamification & Donations | 4/4 | Complete   | 2026-06-06 |
| 4. Payment & Subscriptions | 4/4 | Complete   | 2026-06-08 |
| 5. Statistics, Alerts, Maps & Landing Page | 9/9 | Complete   | 2026-06-08 |
| 6. School, Family, Organization & University Modules | 7/7 | Complete   | 2026-06-08 |
| 7. Offline PWA, Internationalization & Production Launch | 7/7 | Complete   | 2026-06-09 |
| 8. Bookstore Ecosystem | 4/4 | Complete   | 2026-06-09 |
