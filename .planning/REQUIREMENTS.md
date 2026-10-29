# Requirements: SIFAT Library

**Defined:** 2026-06-06
**Core Value:** Hududlar kesimida kitobxonlik indeksini real vaqtda hisoblash va shaffof reyting shakllantirib, davlat darajasida analitik qaror qabul qilishni ta'minlash.

## v1 Requirements

Requirements for V1.0 release. Each maps to roadmap phases.

### Infrastructure Hardening

- [x] **INFRA-01**: OTP rate limiting uses Redis (not in-memory Map) to persist across restarts
- [x] **INFRA-02**: Refresh tokens stored in HttpOnly cookies (not localStorage)
- [x] **INFRA-03**: JwtAuthGuard set as global guard with @Public() decorator for open routes
- [x] **INFRA-04**: Vault integration fails hard in production when VAULT_TOKEN is missing (no dev fallback)
- [x] **INFRA-05**: Docker timezone set to Asia/Tashkent for all scheduled jobs
- [x] **INFRA-06**: ReadingIndex table has composite index on (userId, calculatedAt)
- [x] **INFRA-07**: WebSocket gateway (StatsGateway) uses @socket.io/redis-adapter for multi-instance deployment
- [x] **INFRA-08**: Kafka consumer service activated for real-time event processing
- [x] **INFRA-09**: PgBouncer connection pooling configured for production PostgreSQL
- [x] **INFRA-10**: PostgreSQL read replica configured for heavy read queries (stats, leaderboards)

### Authentication & Registration

- [x] **AUTH-01**: SMS OTP sent via Eskiz.uz API with 2-minute expiry and 5 attempts/hour rate limit
- [x] **AUTH-02**: Auth pages work without locale prefix (middleware redirect to /uz-Latn/login)
- [ ] **AUTH-03**: ID.UZ PKCE OAuth2.0 integration for government employee auto-verification *(code-complete; live OneID handshake PENDING IDUZ_CLIENT_ID/SECRET — see 01-06-SUMMARY.md)*
- [x] **AUTH-04**: PENDING user status auto-converts to regular citizen after 14 days without approval

### Reading Index Engine

- [x] **RI-01**: Reading Index nightly recalculation via BullMQ batched processing (1000-user chunks, completes in <2 hours for 5M users)
- [x] **RI-02**: RI formula calculates 5 components: books count (30%), consistency (20%), genre diversity (15%), return discipline (15%), activity (20%)
- [x] **RI-03**: RI history stored with cleanup job (keep 13 months, archive older records)
- [x] **RI-04**: RI delta tracking shows daily/weekly/monthly change for each user
- [x] **RI-05**: ReadingIndex table partitioned by month to prevent unbounded growth

### Top-100 & Rankings

- [x] **TOP-01**: Top-100 Final Score calculated monthly with 6-component formula (Verified Reading 40%, Consistency 15%, Diversity 10%, Comprehension 15%, Discipline 10%, Trust Score 10%)
- [x] **TOP-02**: Monthly Top-100 workflow: auto-rank (28th) -> AI fraud check (29th) -> admin review (30th) -> publish (1st)
- [x] **TOP-03**: Gender-specific rankings (Top-100 erkaklar, Top-100 ayollar)
- [x] **TOP-04**: Age group rankings (7-14, 15-30, 31-60, 60+)
- [ ] **TOP-05**: Institutional rankings (maktablar, OTMlar, idoralar, viloyatlar, tumanlar)
- [x] **TOP-06**: Children under 14 anonymized in public rankings (show initials + age + region only)
- [x] **TOP-07**: Real-time leaderboard updates via WebSocket
- [x] **TOP-08**: Leaderboard queries use SQL LIMIT/OFFSET (not in-memory sort)

### Fraud Detection & Prevention

- [x] **FRAUD-01**: Comprehension test randomizes answer positions (not always index 0)
- [x] **FRAUD-02**: Comprehension test enforces minimum time per question (prevent instant submission)
- [x] **FRAUD-03**: Fraud scan uses FLAGGED status with admin review queue (not auto-block)
- [x] **FRAUD-04**: Store manual entry endpoint requires proper authorization check
- [x] **FRAUD-05**: Trust Score (0-100) calculated from return discipline, reading speed analysis, location checks
- [x] **FRAUD-06**: Risk Score thresholds: 0-24 safe, 25-49 low, 50-69 review, 70-100 flagged
- [x] **FRAUD-07**: Top-100 candidates undergo multi-layer verification before prize approval
- [ ] **FRAUD-08**: Book inventory reconciliation cron detects 5%+ discrepancy and alerts

### Payment Integration

- [ ] **PAY-01**: Payme JSON-RPC webhook with idempotency keys (Redis SETNX, 24h TTL)
- [ ] **PAY-02**: Click webhook with HMAC signature verification and idempotency
- [ ] **PAY-03**: Payment state changes wrapped in Prisma $transaction() for atomicity
- [ ] **PAY-04**: 12-hour transaction timeout enforcement via BullMQ delayed job
- [ ] **PAY-05**: Invoice PDF generation with organization details, bank requisites, QR payment code
- [ ] **PAY-06**: Subscription lifecycle: TRIAL(30d) -> PENDING -> ACTIVE/FROZEN(admin only)
- [ ] **PAY-07**: Payment reminder notifications at 30, 15, 7, 1 days before due date
- [ ] **PAY-08**: Subscription freeze/delete is admin-only (never automatic)

### Statistics & Dashboard

- [ ] **STAT-01**: 4-level statistics hierarchy (Respublika -> Viloyat -> Tuman -> Mahalla) with real-time data
- [ ] **STAT-02**: Dashboard stat cards connected to backend API (currently showing "-")
- [ ] **STAT-03**: Stats pre-aggregated to Redis (national/5min, viloyat/5min, tuman/15min)
- [ ] **STAT-04**: Gender analysis: male vs female reading levels with comparison charts
- [ ] **STAT-05**: Age group analysis: 7-14, 15-30, 31-60, 60+ reading patterns
- [ ] **STAT-06**: Genre analysis: most/least read genres with seasonal trends
- [ ] **STAT-07**: Book shortage analysis: most requested but unavailable books with ordering suggestions

### Smart Alerts

- [ ] **ALERT-01**: KRITIK alert when district has 0 active readers for 2 weeks (push + email to tuman + viloyat admin)
- [ ] **ALERT-02**: OGOHLANTIRISH alert when RI drops 10%+ (same-day email to tuman admin)
- [ ] **ALERT-03**: OGOHLANTIRISH alert when book requested 50+ times but fund is 0 (notification to librarian)
- [ ] **ALERT-04**: OGOHLANTIRISH alert when club has no debate for 30+ days (push to club leader)
- [ ] **ALERT-05**: AXBOROT alert when RI rises 15%+ (weekly report to viloyat admin)
- [ ] **ALERT-06**: System down alert to super admin via SMS

### Notifications

- [ ] **NOTIF-01**: SMS OTP delivery via Eskiz.uz with delivery status tracking
- [ ] **NOTIF-02**: Firebase FCM push notifications for bron confirmation/rejection, deadline reminders, Top-100 announcements
- [ ] **NOTIF-03**: Email notifications for payment reminders, subscription changes, monthly reports
- [ ] **NOTIF-04**: Notification processor enabled (currently commented out @Processor decorator)

### School Module

- [ ] **SCH-01**: School admin can view students by class with activity monitoring
- [ ] **SCH-02**: School statistics panel: student coverage %, RI by class, 10-book target progress
- [ ] **SCH-03**: Jadidlar izidan club CRUD (name, teacher, classes, goals, activity level)
- [ ] **SCH-04**: Club membership with parent SMS consent for under-18
- [ ] **SCH-05**: Club monitoring: member reading, debates, activity ranking, quarterly top member
- [ ] **SCH-06**: Debate recording: date, topic, participants, photo/video (mandatory), results
- [ ] **SCH-07**: 20-book target monitoring per club member with quarterly reports
- [ ] **SCH-08**: School PQ-9 report: one-button PDF with Jadidlar status, student RI, club debates
- [ ] **SCH-09**: School ranking formula (student coverage + club activity + average RI)

### Family Module

- [ ] **FAM-01**: Family detection by matching address (viloyat + tuman + mahalla + street + house + apartment)
- [ ] **FAM-02**: Family invitation system (system auto-suggests + manual invite by phone/ID)
- [ ] **FAM-03**: Family average RI calculated from all members
- [ ] **FAM-04**: Top-50 families public ranking
- [ ] **FAM-05**: 30-day waiting period before new member counts in family RI
- [ ] **FAM-06**: One user = one family only; address change requires tuman admin approval

### Organization (Idora) Module

- [ ] **ORG-01**: Organization admin can manage employees by department with HR approval flow
- [ ] **ORG-02**: Internal employee RI ranking by department with monthly dynamics
- [ ] **ORG-03**: "Kitob o'qish soati" event module: create event, QR attendance, photo/video, monthly tracking
- [ ] **ORG-04**: "Kitob burchagi" verification: photo upload, location, 90-day refresh monitoring
- [ ] **ORG-05**: Organization PQ-9 report: one-button PDF covering all mandated items
- [ ] **ORG-06**: Professional reading list per department (admin uploads recommended books)
- [ ] **ORG-07**: Auto-suggest top reader for monthly recognition (PQ-9 Band 9b(d))

### University (OTM) Module

- [ ] **UNI-01**: Student verification by OTM admin (faculty, department, year)
- [ ] **UNI-02**: Faculty-level statistics dashboard
- [ ] **UNI-03**: Academic literature section for scholarly works
- [ ] **UNI-04**: Accreditation report PDF with digital library metrics

### Store Integration

- [x] **STORE-01**: Store cabinet: operator enters phone + ISBN, reader confirms within 24 hours
- [x] **STORE-02**: ISBN scan by reader: camera scan -> database check -> comprehension test -> RI update
- [x] **STORE-03**: Store purchases count toward RI with 0.9x coefficient

### Book Management

- [x] **BOOK-01**: Excel import for book fund (500+ books, XLSX parse, validation, progress indicator)
- [x] **BOOK-02**: Library Roaming: borrow at any library, return at any library with bilateral confirmation
- [x] **BOOK-03**: Book limits enforced by user type (citizen:2, student:3/5, official:3) with Trust Score bonus (+1)
- [x] **BOOK-04**: Overdue book handling: SMS/push at 3d, 1d before; block new borrowing when overdue
- [x] **BOOK-05**: Book availability count uses interactive Prisma transactions with CHECK constraint

### Interactive Map

- [ ] **MAP-01**: Uzbekistan choropleth map (Leaflet.js) with RI color coding (green->yellow->red) by district
- [ ] **MAP-02**: Click district -> detail statistics panel
- [ ] **MAP-03**: GeoJSON boundaries for 14 provinces and 200+ districts

### Reports

- [ ] **RPT-01**: Monthly PDF analytics report per scope level (tuman/viloyat/respublika)
- [ ] **RPT-02**: Reports auto-generated on 1st of each month and emailed to admins
- [ ] **RPT-03**: Buxgalter panel: all payments, invoices, monthly/yearly revenue, Export Excel/PDF/1C

### Offline & PWA

- [x] **PWA-01**: Service Worker (Serwist) with production-grade caching strategies
- [x] **PWA-02**: IndexedDB (Dexie.js) for offline catalog, book fund, and transaction queue
- [x] **PWA-03**: Offline mode works for 12 hours with sync status indicator
- [x] **PWA-04**: 2G detection with text-only lite mode (no images)
- [x] **PWA-05**: Offline transactions include auth tokens in replay requests
- [x] **PWA-06**: Sync conflict resolution for concurrent offline transactions

### Internationalization

- [x] **I18N-01**: Karakalpak (kaa) full UI translation
- [x] **I18N-02**: Russian (ru) full UI translation
- [x] **I18N-03**: Multi-script Elasticsearch analyzer for Cyrillic/Latin book search

### Performance & Security

- [x] **PERF-01**: Load testing with k6: 50,000 concurrent users, API p95 < 200ms
- [x] **PERF-02**: Security penetration testing: OWASP Top 10, no P1 critical vulnerabilities
- [x] **PERF-03**: Lighthouse scores: Performance 90+, Accessibility 90+, SEO 95+
- [x] **PERF-04**: WCAG 2.1 accessibility: keyboard navigation, screen reader, 4.5:1 contrast
- [x] **PERF-05**: Append-only audit log with 2-year retention and archive migration
- [x] **PERF-06**: Data deletion flow for user privacy (reading history hide option)

### Gamification

- [x] **GAME-01**: Badge system with 15+ badges ("First 10 books", "Top-100", "30-day streak")
- [x] **GAME-02**: Badge notifications when earned
- [x] **GAME-03**: Badges displayed on user profile

### Donation Module

- [ ] **DONAT-01**: Donation via Payme/Click with purpose selection
- [ ] **DONAT-02**: Public donor list with transparent allocation tracking
- [ ] **DONAT-03**: Admin panel: total collected, spent, remaining, per-recipient breakdown

### AI System

- [x] **AI-01**: NLP chat backend: 20-30 SQL query templates + GPT-4 enrichment for Uzbek admin Q&A
- [x] **AI-02**: Real-time audit engine: Kafka events -> analysis -> issue detection -> alert
- [x] **AI-03**: Root cause analysis: when RI drops, identify top 3 causes with evidence
- [x] **AI-04**: Book recommendation engine: collaborative + content-based filtering by age, genre, region
- [x] **AI-05**: Predictive analytics: 1-month RI forecast with +/-5% target accuracy

### Landing Page

- [ ] **LAND-01**: Real-time statistics counter on hero section (refreshes every 30 seconds)
- [ ] **LAND-02**: B2B demo request form with CRM pipeline (admin email notification)
- [ ] **LAND-03**: Landing page SEO: OpenGraph, Twitter Card, meta tags for social sharing

### Bookstore Ecosystem (Do'kon Ekotizimi)

- [ ] **SHOP-01**: Store model (StoreProduct) with ISBN, title, author, price, stock, coverUrl — CRUD + Excel import for store operators
- [ ] **SHOP-02**: Store operator can manage their product catalog: add/edit/delete books, update prices and stock quantities
- [x] **SHOP-03**: Public store profile page at /dokon/[slug] showing store info, location on map, working hours, and available books with prices
- [x] **SHOP-04**: Book search results include nearby stores with prices and stock (location-based, sorted by distance)
- [x] **SHOP-05**: Store CRM dashboard: customers via platform, monthly sales analytics, top-selling books, conversion rate, traffic source report
- [x] **SHOP-06**: Store Premium badge system for verified partner stores (visible in search results and store profile)
- [x] **SHOP-07**: Store product sync with Elasticsearch for full-text search across all store catalogs with price/stock filters

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### AI/ML Advanced

- **AI-V2-01**: Python FastAPI AI Engine as separate gRPC + Kafka service
- **AI-V2-02**: XGBoost/Random Forest fraud classification model (requires 3-6 months training data)
- **AI-V2-03**: RAG pipeline with pgvector for semantic search over library data
- **AI-V2-04**: Prophet time-series forecasting with Uzbekistan holiday calendar
- **AI-V2-05**: Model monitoring with automatic retraining triggers (accuracy < 93%)

### Platform Extensions

- **EXT-V2-01**: Mutolaa platform API integration (reading progress sync, 0.85x coefficient)
- **EXT-V2-02**: Store full API integration (HMAC-signed webhooks, real-time sync)
- **EXT-V2-03**: USSD fallback for libraries without smartphone access
- **EXT-V2-04**: Telegram bot for reading status and notifications

### Mobile

- **MOB-V2-01**: Native iOS app
- **MOB-V2-02**: Native Android app

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Native mobile app | PWA covers 95% of use cases; native adds 6+ months. V2.0+ |
| Audiokitob integration | Streaming infrastructure needed, not core to reading index |
| Real-time user chat | Not a social platform, moderation burden |
| Blockchain/NFT verification | Unnecessary complexity, Trust Score + fraud rules sufficient |
| Video streaming for debates | Bandwidth prohibitive in 2G rural areas; photo + text summary |
| Custom ML training UI | Data scientists use notebooks; not user-facing |
| Automated book purchasing | SIFAT is monitoring platform, not procurement |
| Multi-language AI fine-tuning | GPT-4 handles Uzbek adequately for V1.0 via prompt engineering |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |
| INFRA-05 | Phase 1 | Complete |
| INFRA-06 | Phase 1 | Complete |
| INFRA-07 | Phase 1 | Complete |
| INFRA-08 | Phase 1 | Complete |
| INFRA-09 | Phase 1 | Complete |
| INFRA-10 | Phase 1 | Complete |
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Code-complete (live verify pending) |
| AUTH-04 | Phase 1 | Complete |
| NOTIF-01 | Phase 1 | Pending |
| NOTIF-04 | Phase 1 | Pending |
| RI-01 | Phase 2 | Complete |
| RI-02 | Phase 2 | Complete |
| RI-03 | Phase 2 | Complete |
| RI-04 | Phase 2 | Complete |
| RI-05 | Phase 2 | Complete |
| FRAUD-01 | Phase 2 | Complete |
| FRAUD-02 | Phase 2 | Complete |
| FRAUD-03 | Phase 2 | Complete |
| FRAUD-04 | Phase 2 | Complete |
| FRAUD-05 | Phase 2 | Complete (V1 signals 1+2+3: discipline + reading-speed + comprehension pass-rate; location signal 4 DEFERRED to v2) |
| FRAUD-06 | Phase 2 | Complete |
| BOOK-01 | Phase 2 | Complete |
| BOOK-02 | Phase 2 | Complete |
| BOOK-03 | Phase 2 | Complete |
| BOOK-04 | Phase 2 | Complete |
| BOOK-05 | Phase 2 | Complete |
| STORE-01 | Phase 2 | Complete |
| STORE-02 | Phase 2 | Complete |
| STORE-03 | Phase 2 | Complete |
| TOP-01 | Phase 3 | Complete |
| TOP-02 | Phase 3 | Complete |
| TOP-03 | Phase 3 | Complete |
| TOP-04 | Phase 3 | Complete |
| TOP-05 | Phase 3 | Pending |
| TOP-06 | Phase 3 | Complete |
| TOP-07 | Phase 3 | Complete |
| TOP-08 | Phase 3 | Complete |
| FRAUD-07 | Phase 3 | Complete |
| FRAUD-08 | Phase 3 | Pending |
| GAME-01 | Phase 3 | Complete |
| GAME-02 | Phase 3 | Complete |
| GAME-03 | Phase 3 | Complete |
| DONAT-01 | Phase 3 | Pending |
| DONAT-02 | Phase 3 | Pending |
| DONAT-03 | Phase 3 | Pending |
| PAY-01 | Phase 4 | Pending |
| PAY-02 | Phase 4 | Pending |
| PAY-03 | Phase 4 | Pending |
| PAY-04 | Phase 4 | Pending |
| PAY-05 | Phase 4 | Pending |
| PAY-06 | Phase 4 | Pending |
| PAY-07 | Phase 4 | Pending |
| PAY-08 | Phase 4 | Pending |
| RPT-03 | Phase 4 | Pending |
| STAT-01 | Phase 5 | Pending |
| STAT-02 | Phase 5 | Pending |
| STAT-03 | Phase 5 | Pending |
| STAT-04 | Phase 5 | Pending |
| STAT-05 | Phase 5 | Pending |
| STAT-06 | Phase 5 | Pending |
| STAT-07 | Phase 5 | Pending |
| ALERT-01 | Phase 5 | Pending |
| ALERT-02 | Phase 5 | Pending |
| ALERT-03 | Phase 5 | Pending |
| ALERT-04 | Phase 5 | Pending |
| ALERT-05 | Phase 5 | Pending |
| ALERT-06 | Phase 5 | Pending |
| MAP-01 | Phase 5 | Pending |
| MAP-02 | Phase 5 | Pending |
| MAP-03 | Phase 5 | Pending |
| RPT-01 | Phase 5 | Pending |
| RPT-02 | Phase 5 | Pending |
| NOTIF-02 | Phase 5 | Pending |
| NOTIF-03 | Phase 5 | Pending |
| LAND-01 | Phase 5 | Pending |
| LAND-02 | Phase 5 | Pending |
| LAND-03 | Phase 5 | Pending |
| SCH-01 | Phase 6 | Pending |
| SCH-02 | Phase 6 | Pending |
| SCH-03 | Phase 6 | Pending |
| SCH-04 | Phase 6 | Pending |
| SCH-05 | Phase 6 | Pending |
| SCH-06 | Phase 6 | Pending |
| SCH-07 | Phase 6 | Pending |
| SCH-08 | Phase 6 | Pending |
| SCH-09 | Phase 6 | Pending |
| FAM-01 | Phase 6 | Pending |
| FAM-02 | Phase 6 | Pending |
| FAM-03 | Phase 6 | Pending |
| FAM-04 | Phase 6 | Pending |
| FAM-05 | Phase 6 | Pending |
| FAM-06 | Phase 6 | Pending |
| ORG-01 | Phase 6 | Pending |
| ORG-02 | Phase 6 | Pending |
| ORG-03 | Phase 6 | Pending |
| ORG-04 | Phase 6 | Pending |
| ORG-05 | Phase 6 | Pending |
| ORG-06 | Phase 6 | Pending |
| ORG-07 | Phase 6 | Pending |
| UNI-01 | Phase 6 | Pending |
| UNI-02 | Phase 6 | Pending |
| UNI-03 | Phase 6 | Pending |
| UNI-04 | Phase 6 | Pending |
| PWA-01 | Phase 7 | Complete |
| PWA-02 | Phase 7 | Complete |
| PWA-03 | Phase 7 | Complete |
| PWA-04 | Phase 7 | Complete |
| PWA-05 | Phase 7 | Complete |
| PWA-06 | Phase 7 | Complete |
| I18N-01 | Phase 7 | Complete |
| I18N-02 | Phase 7 | Complete |
| I18N-03 | Phase 7 | Complete |
| PERF-01 | Phase 7 | Complete |
| PERF-02 | Phase 7 | Complete |
| PERF-03 | Phase 7 | Complete |
| PERF-04 | Phase 7 | Complete |
| PERF-05 | Phase 7 | Complete |
| PERF-06 | Phase 7 | Complete |
| AI-01 | Phase 7 | Complete |
| AI-02 | Phase 7 | Complete |
| AI-03 | Phase 7 | Complete |
| AI-04 | Phase 7 | Complete |
| AI-05 | Phase 7 | Complete |
| SHOP-01 | Phase 8 | Pending |
| SHOP-02 | Phase 8 | Pending |
| SHOP-03 | Phase 8 | Complete |
| SHOP-04 | Phase 8 | Complete |
| SHOP-05 | Phase 8 | Complete |
| SHOP-06 | Phase 8 | Complete |
| SHOP-07 | Phase 8 | Complete |

**Coverage:**
- v1 requirements: 136 total
- Mapped to phases: 136
- Unmapped: 0

**By Phase:**
- Phase 1 (Infrastructure Hardening & Authentication): 16 requirements
- Phase 2 (Reading Index Engine & Core Book Logic): 19 requirements
- Phase 3 (Rankings, Gamification & Donations): 16 requirements
- Phase 4 (Payment & Subscriptions): 9 requirements
- Phase 5 (Statistics, Alerts, Maps & Landing Page): 23 requirements
- Phase 6 (School, Family, Organization & University): 26 requirements
- Phase 7 (Offline PWA, Internationalization & Production Launch): 20 requirements
- Phase 8 (Bookstore Ecosystem): 7 requirements

---
*Requirements defined: 2026-06-06*
*Last updated: 2026-06-06 after roadmap creation (all 129 v1 requirements mapped to 7 phases)*
