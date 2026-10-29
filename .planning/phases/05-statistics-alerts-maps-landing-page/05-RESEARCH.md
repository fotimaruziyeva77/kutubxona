# Phase 5 Research — Statistics, Alerts, Maps & Landing Page

**Researched:** 2026-06-07
**Domain:** Real-time admin analytics surfacing (4-tier hierarchy, choropleth visualization, smart-alert detection + delivery, monthly PDF reports, FCM/email notification expansion, B2B landing CRM)
**Confidence:** HIGH (verified against actual codebase at file:line granularity; Phase 1–4 carry-overs cross-checked against VERIFICATION.md docs)

---

## Executive Summary

Phase 5 is the **highest brownfield-ratio phase in the roadmap**. The audit reveals that 11 of 23 requirements are partially scaffolded today (`STAT-01..07`, `MAP-01..03`, `LAND-01..03`, partial `ALERT-01..02`, partial `RPT-01`) — the actual gap is **wiring, hardening, and replacing simulations with reality**, not building from zero. Specifically:

- **Stats endpoints exist** at `admin.service.ts:200-427` covering national/viloyat/tuman/genre/shortage. They are CACHED via `CacheService.remember` with the exact TTLs the requirement names (5min/15min). They are **NOT yet routed through `PrismaReplicaService`** — and the heaviest aggregate (`_buildTumanRiMap` at `audit.service.ts:307-358`) currently triggers `PITFALLS S1` (loads 5M × 60d ≈ 300M rows into Node memory). This is the single most consequential thing this phase must fix.
- **Smart alert generation lives in TWO places**: `admin.service.checkSmartAlerts` (`@Cron("0 23 * * *")`, lines 430-510) and `ai/audit.service.runAuditCycle` (`@Cron("*/15 * * * *")`, lines 43-61). The two services emit overlapping events with different `issueType` strings ("RI_DROP" vs "RI_CRITICAL_DROP", "INACTIVE_LIBRARY" vs "LIBRARY_INACTIVE"). **Phase 5 must consolidate** to a single source of truth and add the 4 missing alert types (`ALERT-03..06`).
- **Notification delivery is partially wired**: `NotificationProcessor` (`notification.processor.ts:16-80`) routes `sms` → Eskiz (live, NOTIF-04 closed Phase 1), but `push` and `email` are explicit no-op stubs at lines 71-79 with TODO comments pointing at "Phase 5". This is the canonical hand-off.
- **Landing page is ~80% complete**: `apps/frontend/app/[locale]/page.tsx` already calls `/admin/stats/national`, `/top?limit=5`, `/donate/stats` server-side with Next 14 `next.revalidate: 300/3600`. SEO metadata + OpenGraph already declared (lines 4-14). Remaining work: 30s client-side refresh widget, B2B demo CRM wiring (DemoRequest model + endpoint EXIST at `admin.service.ts:540-555`, frontend `/dashboard/demo-requests` page exists, but **no email notification fires when a demo request is created**), structured-data (JSON-LD).
- **Map renders today** at `components/map/ViloyatMap.tsx` but with hardcoded province centroids + circle markers, **not a choropleth from GeoJSON**. Backend `_fetchAllViloyatStats` (admin.service.ts:295-322) returns library counts, but the page injects a SIMULATED RI per viloyat (`stats/page.tsx:453` — `Math.round(42 + (v.id.charCodeAt(3) % 10) * 4.5)`). Real per-viloyat RI aggregation must be added.
- **PDF infrastructure is mature**: `PdfService.generateFromHtml` (puppeteer-core + @sparticuz/chromium, with `escapeHtml` SEC fix from Plan 04-03) and a working monthly report endpoint at `admin.controller.ts:188-219`. Phase 5 expands to scope-specific reports (tuman/viloyat/respublika) and a BullMQ `REPORT_QUEUE` job that fires on the 1st of each month.

**Primary recommendation:** Treat Phase 5 as three concurrent wave-tracks: (Wave 0) test infrastructure + GeoJSON acquisition; (Wave 1) stats hardening — replica routing + pre-aggregation cron — and notification provider procurement; (Wave 2) consolidated alert engine + real-time WebSocket emission + choropleth wiring; (Wave 3) monthly PDF reports + B2B demo CRM email + landing 30s client refresh + SEO/JSON-LD. Total: ~15–18 plans across 4 waves.

---

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| STAT-01 | 4-level statistics hierarchy with real-time data | Endpoints exist `admin.controller.ts:90-120` (national/viloyat/all/viloyat/:id/tuman/:id) — mahalla MISSING; needs new endpoint + cache key |
| STAT-02 | Dashboard stat cards connected to backend (no `—`) | `dashboard/page.tsx:50-115` already wired; "—" only appears when `staleTime: 300_000` is fresh+null; needs initialData fallback + SSR pre-fetch |
| STAT-03 | Stats pre-aggregated to Redis (national/5min, viloyat/5min, tuman/15min) | `CacheService.ttl.stats=5min` (`cache.service.ts:128`); `remember()` PATTERN is in place but currently **lazy** (cache-aside on-demand). Requirement is **proactive** pre-aggregation cron — gap |
| STAT-04 | Gender comparison charts | Backend returns `users.byGender` (admin.service.ts:217-218); frontend has donut on dashboard + stats pages; **needs scope filtering** |
| STAT-05 | Age group analysis (7-14, 15-30, 31-60, 60+) | Backend does NOT yet aggregate by age. `Top100Entry.ageGroup` from Phase 3 provides shape; needs separate query against ReadingIndex × User.dob |
| STAT-06 | Genre analysis with seasonal trends | `getGenreStats` exists `admin.service.ts:357-396` — 30d window only, NO seasonal trend dimension |
| STAT-07 | Book shortage with ordering suggestions | `getBookShortage` exists `admin.service.ts:399-427` — returns top-20 unavailable + most-requested; "ordering suggestion" UI component missing |
| ALERT-01 | KRITIK alert when district has 0 active readers 2 weeks | `checkSmartAlerts` does library-level (not district-level); needs district-rollup query |
| ALERT-02 | OGOHLANTIRISH alert when RI drops 10%+ | `audit.service._checkTumanRiDrops` (`ai/audit.service.ts:65-131`) at threshold 10/20% — but bound to broken `_buildTumanRiMap` |
| ALERT-03 | OGOHLANTIRISH alert when book 50+ requests / fund 0 | `_checkFundShortages` lines 214-253 exists but threshold is 10 (not 50) AND availableCount ≤ 1 (not 0); needs threshold tune |
| ALERT-04 | OGOHLANTIRISH alert when club 30+ days no debate | `_checkInactiveClubs` lines 173-209 exists but threshold is **45 days** (THRESHOLDS.CLUB_DEBATE_DAYS), not 30 — tune to 30 |
| ALERT-05 | AXBOROT alert when RI rises 15%+ weekly | NOT implemented; needs new positive-direction check |
| ALERT-06 | System down SMS to super admin | NOT implemented; needs heartbeat watchdog + Eskiz fallback |
| MAP-01 | Uzbekistan choropleth (Leaflet) with RI color | `ViloyatMap.tsx` uses circleMarkers, NOT choropleth polygons; needs GeoJSON + `L.geoJSON` layer |
| MAP-02 | Click district → detail panel | `MapTab` `selectedViloyat` state already wired (`stats/page.tsx:489-517`); will work once polygons replace markers |
| MAP-03 | GeoJSON boundaries 14 viloyats + 200+ tumans | NOT present; sourced from `akbartus/GeoJSON-Uzbekistan` or `geoBoundaries` |
| RPT-01 | Monthly PDF per scope | `downloadMonthlyReport` (admin.controller.ts:188-219) supports national only; needs tuman/viloyat parameterization |
| RPT-02 | Auto-generate 1st of month + email | NOT implemented; needs `REPORT_QUEUE` BullMQ + cron + email provider |
| NOTIF-02 | FCM push notifications | Stub at `notification.processor.ts:71-74`; needs firebase-admin + DeviceToken model + token registration endpoint |
| NOTIF-03 | Email notifications | Stub at `notification.processor.ts:76-79`; needs nodemailer (recommended) + SMTP creds |
| LAND-01 | Real-time stats counter (30s refresh) | Server-side already with revalidate:300; needs client-side 30s `useEffect` polling component on hero numbers |
| LAND-02 | B2B demo form with CRM email | Form exists `/demo-request/page.tsx`; backend `createDemoRequest` exists; **admin email notification on creation does NOT fire** — gap |
| LAND-03 | SEO OpenGraph/Twitter Card | OpenGraph already declared `page.tsx:8-14`; Twitter Card NOT declared; JSON-LD schema.org Organization NOT declared |

</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Pre-aggregated stats (STAT-03) | API / Backend (BullMQ scheduled job + Redis write) | Database / Storage (read replica reads, Redis writes) | Compute belongs in backend; replica isolates analytics load from primary writes |
| Choropleth map render (MAP-01..03) | Browser / Client (Leaflet + GeoJSON in IndexedDB-cacheable) | CDN / Static (GeoJSON served as static asset gzip) | Map interaction is pure client; geometry data is immutable so CDN delivery is correct tier |
| Smart alert detection (ALERT-01..05) | API / Backend (consolidated cron) | Database / Storage (replica reads) | Periodic scan against historical data; never user-initiated |
| Real-time alert delivery (ALERT-* push) | API / Backend (StatsGateway Redis-adapter emit) | Browser / Client (socket.io-client subscription to `alerts` room) | Server-authoritative emission; clients subscribe |
| FCM push (NOTIF-02) | API / Backend (firebase-admin SDK) | Browser / Client (FCM token registration via web SDK) | Service-account credentials cannot leave server; token roundtrip required |
| Email delivery (NOTIF-03) | API / Backend (nodemailer + BullMQ) | (none) | Pure server-side; recipient receives via mail client |
| Monthly PDF (RPT-01..02) | API / Backend (puppeteer + BullMQ REPORT_QUEUE) | Database / Storage (replica reads, MinIO archival optional) | CPU-heavy render belongs in queue worker, not HTTP handler |
| Landing live counter (LAND-01) | Browser / Client (30s `useQuery` refetchInterval) | API / Backend (cached `/admin/stats/national`) | Client-driven polling; backend serves cached snapshot |
| B2B demo CRM email (LAND-02) | API / Backend (createDemoRequest hook → NOTIFICATION_QUEUE email job) | (none) | Server-only side effect; admin recipient list configured in env |
| SEO/JSON-LD (LAND-03) | Frontend Server (SSR) (Next.js metadata + Script tag) | (none) | Must be in HTML at first byte for crawlers |
| GeoJSON serving (MAP-03) | CDN / Static (`apps/frontend/public/geojson/uzbekistan.geojson`) | Browser / Client (fetch + cache) | Geometry never changes between deploys; serve as static asset |

---

## Current State Audit (per requirement, file:line evidence)

### STAT-01 — 4-level hierarchy

**Current state:**
- `admin.controller.ts:90-120` exposes: `/admin/stats/national`, `/admin/stats/viloyat/all`, `/admin/stats/viloyat/:id`, `/admin/stats/tuman/:id`. NO `/admin/stats/mahalla/:id` endpoint.
- `admin.service.ts:192-355` implements: `getNationalStats`, `getViloyatStats(viloyatId)`, `getAllViloyatStats`, `getTumanStats(tumanId)`. NO `getMahallaStats`.
- All four use the **primary** Prisma client (`this.prisma`). NOT replica.

**Classification:** EXTEND. Add `getMahallaStats(mahallaId)` + endpoint; refactor all four to inject `PrismaReplicaService` from Phase 1.

**Gotcha:** `getNationalStats` does 13 parallel queries via `Promise.all` (admin.service.ts:213-227). Three of them hit ReadingIndex (heavy partition scans). Routing to replica via existing `PrismaReplicaService` is straightforward (Phase 4 PaymentService uses same pattern — `invoice.service.ts` via `this.replica.payment.groupBy`). **Replica lag risk is bounded** (5-min cache TTL already absorbs ~30s lag).

---

### STAT-02 — Dashboard stat cards `—`

**Current state:**
- `dashboard/page.tsx:90-114` renders `stats ? fmt(stats.users.total) : "—"`. The `—` appears only during initial query load (~200ms on a hit, ~1.5s on a miss) or auth failure.
- The page uses `useQuery({ staleTime: 300_000 })` — but **NO** `initialData`, so first render always shows `—` until network resolves.

**Classification:** FIX. Add `initialData` via Next 14 server component prefetch OR add a stronger skeleton (current is just `"Yuklanmoqda…"` text at line 67).

**Gotcha:** Test `Phase 0 audit` finding ("dashboard showing `—`") is REAL but the root cause is loading state, not endpoint failure. The endpoint already works (Phase 1 backend test suite 680/680 includes admin.service tests).

---

### STAT-03 — Pre-aggregation cron

**Current state:**
- `CacheService.remember(key, ttlSeconds, fn)` (`cache.service.ts:104-111`) — cache-aside lazy pattern.
- `CacheService.ttl.stats = 5*60` (line 128) — matches requirement for national/5min and viloyat/5min.
- `CacheService.ttl.alerts = 2*60` — matches alert refresh.
- NO scheduled job currently fires `Promise.all([nationalStats, ...allViloyatStats(), ...allTumanStats()])`. Cache is populated REACTIVELY on first dashboard hit per scope.

**Classification:** NEW. Add `StatsAggregationProcessor` (BullMQ in `AI_QUEUE` or new `STATS_AGGREGATION_QUEUE`) + cron in `AdminService`:

```ts
@Cron("*/5 * * * *") async refreshNationalAndViloyatCache() {
  await this.getNationalStats(); // populates stats:national
  const viloyats = await this.replica.viloyat.findMany({ select: { id: true } });
  await Promise.all(viloyats.map(v => this.getViloyatStats(v.id)));
}

@Cron("*/15 * * * *") async refreshTumanCache() {
  const tumans = await this.replica.tuman.findMany({ select: { id: true } });
  await Promise.all(tumans.map(t => this.getTumanStats(t.id)));
}
```

**Gotcha:** Single-replica naive cron causes thundering-herd on cache eviction. Use BullMQ `addBulk` to spread tuman aggregation across the 15-min window. Also: 200+ tumans × 5 queries each = ~1000 replica queries per refresh — well within budget but document p99 expectation.

**Gotcha 2:** Multi-replica cron deduplication — use `RedisLockService` (already exists in Phase 4 `payment` module) or BullMQ `jobId: 'stats-refresh:national:YYYY-MM-DD-HH-mm'`.

---

### STAT-04, STAT-05 — Gender + Age aggregation

**Current state:**
- Gender: shipped — `users.byGender.MALE/FEMALE` (admin.service.ts:217-218).
- Age groups: NOT shipped. No backend aggregation. The 4 age buckets (7-14, 15-30, 31-60, 60+) DO exist in Phase 3 `top.service.ts:23 getAgeGroup(dob)` but only for `Top100Entry`.

**Classification:** EXTEND (gender scope filter + age aggregation).

**Build approach:**
- Reuse Phase 3 `getAgeGroup` util — promote to `apps/backend/src/common/utils/age-group.util.ts` (currently inlined in top.service).
- Add scoped `getGenderBreakdown(scope, scopeId)` and `getAgeBreakdown(scope, scopeId)` returning `{ ageGroup: "7-14" | ..., readingIndexAvg: number, userCount: number }[]`.
- Use raw SQL with `date_part('year', age(dob))` for performance (Prisma groupBy on computed expression is awkward).

**Gotcha:** `getAgeGroup(dob)` uses `now()` — non-deterministic across timezones. Phase 1 set TZ=Asia/Tashkent globally so this is fine, but document that age boundaries shift overnight.

---

### STAT-06 — Genre seasonal trends

**Current state:**
- `_fetchGenreStats` (admin.service.ts:365-396) — groups BookTransaction by `bookId` over last 30 days, then joins Book.genre via in-memory map. Returns top-15 genres by count.
- NO time-series dimension. NO seasonal comparison.

**Classification:** EXTEND.

**Build approach:** Add a second dimension — `genreTrend(months: 12)` returning `{ genre, monthly: [{ month, count }] }` shape using `date_trunc('month', BookTransaction.createdAt)`. Cache key `stats:genres:trend:${viloyatId}`, TTL 1h.

---

### STAT-07 — Book shortage + ordering

**Current state:**
- `_fetchBookShortage(limit)` lines 407-427 returns top-20 unavailable books with request count. Backend complete.
- Frontend renders table in `ShortageTab` (stats/page.tsx:358-413).
- "Ordering suggestion" UI = empty (TZ §VI.2 says "Buyurtma berish tugmasi"; CLAUDE.md §VI.2 says jadval + alert).

**Classification:** EXTEND. Add: (1) backend `markBookForOrder(bookId, libraryId, quantity)` endpoint writing to a new `BookOrderRequest` model (or reuse AiAuditLog with `issueType: "ORDER_REQUEST"`); (2) frontend "Buyurtma" button in `ShortageTab`.

**Gotcha:** New persistence model = new migration. Cheapest path is to reuse `AiAuditLog` with `issueType: "ORDER_REQUEST"`, severity LOW, `scope: "LIBRARY"`, payload in `recommendation` field.

---

### ALERT-01..05 — Alert detection (consolidation)

**Current state — TWO overlapping alert engines:**

| Engine | File:Line | Cron | Coverage |
|--------|-----------|------|----------|
| `AdminService.checkSmartAlerts` | `admin.service.ts:430-510` | `@Cron("0 23 * * *")` daily | 2 alerts: INACTIVE_LIBRARY (14d), RI_DROP (national 10%) |
| `AuditService.runAuditCycle` | `ai/audit.service.ts:43-61` | `@Cron("*/15 * * * *")` 15-min | 4 alerts: RI_CRITICAL_DROP, RI_WARNING_DROP, LIBRARY_INACTIVE, CLUB_INACTIVE, FUND_SHORTAGE |

Both write to `AiAuditLog`. Both emit via `StatsGateway.emitNewAlert`. They produce **overlapping events with different `issueType` strings**:
- "RI_DROP" (admin) vs "RI_WARNING_DROP" / "RI_CRITICAL_DROP" (audit)
- "INACTIVE_LIBRARY" (admin) vs "LIBRARY_INACTIVE" (audit)

The frontend alert page (`/dashboard/alerts/page.tsx:37-42`) only knows the admin-side strings (`INACTIVE_LIBRARY`, `RI_DROP`, `INVENTORY_DISCREPANCY`, `OVERDUE_SURGE`).

**Classification:** FIX (consolidate) + EXTEND (add ALERT-03 threshold tune, ALERT-04 threshold tune, ALERT-05 rising RI, ALERT-06 system down).

**Build approach:**
1. **Single source of truth** = `ai/audit.service.ts` (15-min cadence matches the requirement spirit better than 23:00 daily). Migrate the two `admin.service.ts` checks into `audit.service.ts`. Delete `admin.service.checkSmartAlerts` cron AFTER migration is verified.
2. **Standardize issueType enum** — define `apps/backend/src/common/constants/alert-types.const.ts`:
   ```ts
   export const ALERT_TYPES = {
     LIBRARY_INACTIVE: "LIBRARY_INACTIVE",     // ALERT-01
     RI_DROPPED: "RI_DROPPED",                  // ALERT-02
     FUND_SHORTAGE: "FUND_SHORTAGE",            // ALERT-03
     CLUB_INACTIVE: "CLUB_INACTIVE",            // ALERT-04
     RI_RISING: "RI_RISING",                    // ALERT-05 (NEW)
     SYSTEM_DOWN: "SYSTEM_DOWN",                // ALERT-06 (NEW)
     INVENTORY_DISCREPANCY: "INVENTORY_DISCREPANCY", // existing Phase 3 FRAUD-08
     ORDER_REQUEST: "ORDER_REQUEST",            // STAT-07
   } as const;
   ```
3. **ALERT-01 threshold fix:** Current `_checkInactiveLibraries` (audit.service.ts:135-169) finds libraries with no transactions in 14 days, severity CRITICAL. Requirement is **district has 0 active READERS in 2 weeks** (different from library inactivity). Add `_checkInactiveTumans` doing `tumanId` GROUP BY ReadingIndex.userId.address.tumanId, filter where COUNT(activeUsers) = 0 in 14d.
4. **ALERT-03 threshold fix:** Currently `having: { bookId: { _count: { gte: 10 } } }, availableCount <= 1` (lines 218-228). Requirement is **50+ requests AND fund 0**. Change to `_count: { gte: 50 }` AND `availableCount: 0`.
5. **ALERT-04 threshold fix:** Currently `CLUB_DEBATE_DAYS=45` (line 25). Requirement is 30 days. Change constant to 30. Phase 6 (SCH-06 debate recording) will reuse this threshold.
6. **ALERT-05 NEW:** Weekly cron `@Cron("0 9 * * MON")` runs `_checkPositiveTumanRi` — if `current > previous * 1.15`, emit `RI_RISING` severity INFO.
7. **ALERT-06 NEW:** Server-side heartbeat is hard (server can't tell user it's down). Two valid approaches:
   - **(a) Outbound watchdog**: cron `*/5 * * * *` writes timestamp to `cache.set("heartbeat:backend", Date.now(), 600)`. A separate monitoring container (or Sentry already wired Phase 1) checks staleness and SMSes super_admin via Eskiz if missing for 10 min.
   - **(b) Inbound watchdog**: external uptime monitor (BetterStack, UptimeRobot, Pingdom) hits `/health` and pages on miss. Recommended: rely on Sentry alerts (already configured Phase 1 `SENTRY_DSN`) + add a `/admin/system-down-test` endpoint that fires Eskiz SMS for QA.
   - Pick (b) — externalize uptime monitoring. Provides true defense-in-depth: if backend crashes, internal watchdog crashes too.

---

### MAP-01..03 — Choropleth & GeoJSON

**Current state:**
- `components/map/ViloyatMap.tsx:78-104` renders `L.circleMarker` per province at hardcoded centroids. NOT a choropleth.
- Backend RI data: `/admin/stats/viloyat/all` returns `{ libraries: Record<viloyatId, number>, avgRI: number }` — single national avg, not per-viloyat (admin.service.ts:316-321 — **bug**: the `_fetchAllViloyatStats` aggregates ALL viloyats into one `avgRI`, not a per-viloyat map; the frontend then SIMULATES per-viloyat RI at stats/page.tsx:453).

**Classification:** FIX (backend per-viloyat RI) + NEW (GeoJSON + choropleth polygons).

**Build approach:**
1. **Backend FIX:** Rewrite `_fetchAllViloyatStats` to GROUP BY viloyatId in a single `$queryRaw`:
   ```ts
   const result = await this.replica.$queryRaw`
     SELECT a."viloyatId", AVG(ri.score)::float AS avg_ri, COUNT(DISTINCT u.id) AS user_count
     FROM "ReadingIndex" ri
     JOIN "User" u ON ri."userId" = u.id
     JOIN "Address" a ON u."addressId" = a.id
     WHERE ri."calculatedAt" >= NOW() - INTERVAL '30 days'
     GROUP BY a."viloyatId"
   `;
   ```
2. **GeoJSON:** Use `akbartus/GeoJSON-Uzbekistan` (CC-licensed, OSM-derived). Bundle simplified file at `apps/frontend/public/geojson/uzbekistan-viloyats.geojson` (target <100KB gzipped). Tuman-level GeoJSON is ~500KB raw — serve as separate file lazy-loaded on zoom.
3. **Choropleth:** Replace `circleMarker` with `L.geoJSON(data, { style: feature => ({ fillColor: riColor(viloyatRi[feature.properties.code]), ... }), onEachFeature: ... })`.
4. **Color scale:** Keep existing `riColor` thresholds (≥70 green, ≥50 yellow, ≥30 orange, else red) — they already match CLAUDE.md §VI.4.

**Gotcha — GeoJSON size:** Raw OSM admin boundaries for UZ are ~2MB. Simplify with `mapshaper` (CLI) to ~80KB while preserving topology. Document the simplify command in the plan.

**Gotcha — Server-side render:** Leaflet requires `window`. Existing pattern works — `dynamic(() => import("@/components/map/ViloyatMap"), { ssr: false })` at stats/page.tsx:10-20. Keep.

**Gotcha — Mobile usability:** Choropleth polygon tap targets are small on phones. Provide a fallback list view (already exists at stats/page.tsx:520-548 as "Viloyatlar reytingi jadval"). Keep both.

---

### RPT-01..02 — Monthly PDF reports

**Current state:**
- `downloadMonthlyReport` (admin.controller.ts:188-219) — synchronous endpoint, national-only, uses `PdfService.buildMonthlyReportHtml` template (pdf.service.ts:86-158).
- `PdfService.generateFromHtml` is mature (puppeteer-core + @sparticuz/chromium fallback + escapeHtml SEC fix). Already production-tested by Phase 4 invoice PDFs.
- NO scheduled job. NO email send. NO scope parameterization.

**Classification:** EXTEND (add scope parameter) + NEW (monthly cron + email dispatch).

**Build approach:**
1. **Parameterize endpoint** — `downloadMonthlyReport(scope: "national"|"viloyat"|"tuman", scopeId?: string)`.
2. **Scope-specific stats** — build a `ReportDataService.gatherForScope(scope, scopeId, periodStart, periodEnd)` returning the unified shape.
3. **Cron + Queue:**
   ```ts
   @Cron("0 6 1 * *") async generateMonthlyReports() {
     const viloyats = await this.replica.viloyat.findMany();
     const tumans = await this.replica.tuman.findMany();
     const recipients = await this.replica.user.findMany({
       where: { role: { in: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] } }
     });
     // enqueue 1 national + 14 viloyat + 200 tuman = 215 PDF jobs to REPORT_QUEUE
     // BullMQ concurrency: 2-3 (PITFALLS M6 — Puppeteer memory)
   }
   ```
4. **Email send** — `ReportEmailProcessor` consumes from REPORT_QUEUE, generates PDF, attaches to nodemailer message, sends to scope-relevant admins.

**Gotcha — PITFALLS M6:** Puppeteer launches headless Chrome per render. 215 simultaneous renders OOM the server. BullMQ concurrency ≤ 3 (or Browser singleton with `newPage()` per job — see PITFALLS M6 mitigation step 2).

**Gotcha — Email recipient scoping:** A TUMAN_ADMIN should only receive the report for THEIR tuman. Look up admin's `address.tumanId` and filter the recipient list.

---

### NOTIF-02 — FCM push notifications

**Current state:**
- `notification.processor.ts:71-74` — explicit stub: `private async sendPush(data: NotificationJobData): Promise<void> { ... this.logger.debug(...); }` with TODO comment "Phase 5 da Firebase FCM ulanganda shu yerda ishlatiladi".
- `NotificationJobData.deviceToken` field already declared (line 11).
- NO `firebase-admin` dep installed (verified in `apps/backend/package.json`).
- NO `DeviceToken` Prisma model.
- NO frontend token registration flow.

**Classification:** NEW (full pipeline) — but reuses existing NOTIFICATION_QUEUE plumbing.

**Build approach:**
1. **Install:** `firebase-admin` (verify via `npm view firebase-admin version` — current 13.x as of 2026). Tag `[ASSUMED]` until slopcheck-verified per Package Legitimacy Audit below.
2. **Service account credentials:** Read JSON file path from `FCM_SERVICE_ACCOUNT_KEY_PATH` env. In production, mount via Vault secret + file projection. Documentation: [Firebase Admin Setup](https://firebase.google.com/docs/admin/setup#initialize-sdk).
3. **`FcmClient` infra service** — mirrors `EskizSmsClient` pattern: lazy init, graceful dev no-op when env unset, structured delivery log without exposing token.
4. **`DeviceToken` Prisma model:**
   ```prisma
   model DeviceToken {
     id        String   @id @default(cuid())
     userId    String
     user      User     @relation(fields: [userId], references: [id])
     token     String   @unique // FCM token (250-char max)
     platform  String   // "web" | "android" | "ios"
     lastSeen  DateTime @default(now())
     createdAt DateTime @default(now())
     @@index([userId])
   }
   ```
5. **Token registration endpoint:** `POST /users/me/fcm-token { token, platform }` — authenticated, upserts by `token` unique key.
6. **Frontend SDK:** `firebase` (browser SDK) — `messaging.getToken({ vapidKey: VITE_FIREBASE_VAPID_KEY })`.
7. **Processor wire-up:** Replace `sendPush` stub:
   ```ts
   private async sendPush(data: NotificationJobData): Promise<void> {
     const tokens = data.deviceToken
       ? [data.deviceToken]
       : await this._lookupTokensForUser(data.userId);
     for (const token of tokens) {
       try { await this.fcm.send({ token, notification: { title: ..., body: data.message } }); }
       catch (err) {
         if (this._isInvalidToken(err)) await this.prisma.deviceToken.delete({ where: { token } });
         else throw err; // BullMQ retry
       }
     }
   }
   ```

**Gotcha — FCM invalid token cleanup:** FCM returns `messaging/registration-token-not-registered` for revoked tokens. Must delete from DB else queue accumulates dead jobs.

**Gotcha — VAPID key for web push:** Web FCM requires VAPID public key (browser-side, env `NEXT_PUBLIC_FCM_VAPID_KEY`) + service worker registration. PWA Phase 7 will integrate further — for Phase 5 ship server-side push targeting native mobile (and any web clients with FCM-compatible service worker).

**Gotcha — Topic-based broadcasts:** Top-100 announcements should go to a topic, not individual tokens. `messaging.sendToTopic("top-100-announcements", payload)`. Mobile clients subscribe to the topic on first launch.

---

### NOTIF-03 — Email notifications

**Current state:**
- `notification.processor.ts:76-79` — explicit stub for `sendEmail`.
- `NotificationJobData.email` field already declared (line 10).
- NO `nodemailer` dep installed.

**Classification:** NEW. Mirror Eskiz pattern.

**Build approach:**
1. **Provider decision:** nodemailer + SMTP. Rationale: (a) provider-agnostic, (b) UZ-resident MX servers (e.g., Unicon.uz mail relay) satisfy data localization, (c) trivial swap if upgrading to Resend/SendGrid later. Reference: [nodemailer 8.x](https://www.npmjs.com/package/nodemailer) — most-downloaded SMTP lib (~5M/week).
2. **Env vars:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Production-required via `_assertEnvVars` (mirror Phase 1 VAULT_TOKEN/Eskiz pattern).
3. **`MailClient` infra service:**
   ```ts
   @Injectable()
   export class MailClient {
     private transporter?: Transporter;
     constructor(private config: ConfigService) {}
     onModuleInit() {
       const host = this.config.get("SMTP_HOST");
       if (!host) { this.logger.warn("[mail dev no-op] SMTP_HOST not set"); return; }
       this.transporter = nodemailer.createTransport({ host, port, secure, auth });
     }
     async sendMail(to: string, subject: string, html: string, attachments?: Attachment[]) {
       if (!this.transporter) { this.logger.warn(`[mail dev no-op] to=${this._maskEmail(to)}`); return; }
       await this.transporter.sendMail({ from, to, subject, html, attachments });
     }
   }
   ```
4. **Processor wire-up:** `sendEmail` calls `this.mail.sendMail(data.email, subject, html)`. Subject and HTML built per job type (payment reminder, monthly report, demo confirmation).

**Gotcha — Email-injection via library.name / user.name:** PITFALLS C3-adjacent. Use `_sanitizeForSms` pattern from Plan 04-04 (subscription.service.ts:585-600) — strip CR/LF, escape HTML. Reuse the existing `escapeHtml` from PdfService.

**Gotcha — Templating:** Don't hand-build HTML per type. Add a `MailTemplateService` with 4 templates: `paymentReminder`, `subscriptionChange`, `monthlyReport`, `demoConfirmation`. Use the same Puppeteer HTML pattern from `PdfService.buildMonthlyReportHtml` with `escapeHtml` everywhere.

---

### LAND-01 — Real-time landing counter

**Current state:**
- `app/[locale]/page.tsx:18-26` server-side fetches `/admin/stats/national` with `next.revalidate: 300` (5-min ISR cache).
- Hero numbers render server-side (HeroStat at line 88-105) — good SEO.
- NO client-side polling. The "30 sek yangilanish" requirement is not met for users who keep the page open.

**Classification:** EXTEND. Add a `<LiveStatsRefresher />` client component:

```tsx
"use client";
export function LiveStatsRefresher({ initialStats }: { initialStats: NationalStats }) {
  const { data } = useQuery({
    queryKey: ["landing-live-stats"],
    queryFn: () => fetch("/api/admin/stats/national").then(r => r.json()),
    initialData: initialStats,
    refetchInterval: 30_000,
  });
  return <div>{/* render data.transactions.thisMonth etc */}</div>;
}
```

**Gotcha — Hydration mismatch:** Pass server-rendered `initialStats` as prop so first client render matches HTML. `initialData` prevents the `useQuery` empty state flash.

**Gotcha — Public access:** `/admin/stats/national` requires SUPER_ADMIN OR VILOYAT_ADMIN role (admin.controller.ts:91). Landing page is public. Need an unauthenticated `/api/public/landing-stats` endpoint that returns a SANITIZED subset (totals only, no fraud flags, no PII). Apply Phase 3 `maskNameIfMinor` defense-in-depth where any name is involved.

---

### LAND-02 — B2B demo CRM email

**Current state:**
- `DemoRequest` model exists (schema.prisma:558-572).
- `POST /admin/demo-request` @Public endpoint (admin.controller.ts:160-175).
- `AdminService.createDemoRequest` (lines 540-543) writes the row. **NO side-effect** — admin is not notified.
- Frontend dashboard page `/dashboard/demo-requests` exists for triage.

**Classification:** EXTEND. Add post-creation hook:

```ts
async createDemoRequest(data: {...}) {
  const created = await this.prisma.demoRequest.create({ data });
  await this.notifyAdmins(created); // NEW
  return created;
}

private async notifyAdmins(req: DemoRequest) {
  const admins = await this.prisma.user.findMany({
    where: { role: "SUPER_ADMIN" },
    select: { email: true }
  });
  for (const admin of admins) {
    if (!admin.email) continue;
    await this.notificationQueue.add("demo-request-email", {
      type: "email",
      email: admin.email,
      message: `New B2B demo request from ${escapeHtml(req.organization)} (${req.orgType}). Phone: ${req.phone}.`,
    });
  }
}
```

**Gotcha — User.email is currently nullable** (need to verify) and may not be populated for super admins registered via phone-OTP only. Need an `ADMIN_NOTIFICATION_EMAILS` CSV env as fallback: `ADMIN_NOTIFICATION_EMAILS=admin@sifat.uz,manager@sifat.uz`.

**Gotcha — Spam vector:** `@Public` endpoint with email side effect = spammable. Add `incrWithTtl("demo-rl:${phone}", 3600)` rate limit (3/hour per phone) using Phase 1 `CacheService` primitive.

---

### LAND-03 — SEO / OpenGraph / Twitter Card

**Current state:**
- OpenGraph declared in `app/[locale]/page.tsx:8-14`: title, description, type=website, og:image.
- NO Twitter Card metadata.
- NO JSON-LD schema.org Organization.
- `app/sitemap.ts` and `app/robots.ts` exist (good).

**Classification:** EXTEND.

**Build approach:**
```ts
export const metadata: Metadata = {
  ...existing,
  twitter: {
    card: "summary_large_image",
    title: "SIFAT LIBRARY",
    description: "Milliy kitobxonlik indeksi platformasi",
    images: ["/icons/og-main.png"],
  },
};

// Plus a JSON-LD <Script> in body:
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "GovernmentOrganization",
  name: "SIFAT LIBRARY",
  url: "https://sifat.uz",
  // ...
};
<Script type="application/ld+json" id="ld-org">{JSON.stringify(jsonLd)}</Script>
```

---

## Load-Bearing Decisions (7)

### D-1: Stats aggregation — pre-compute vs on-demand
**Decision:** Hybrid. Keep `CacheService.remember` cache-aside as the request path (it already works), ADD a 5-min cron that proactively warms `stats:national` + all 14 viloyat keys, AND a 15-min cron that warms all 200 tuman keys. The cron uses the same `remember(key, ttl, fn)` codepath — no parallel logic.
**Rationale:** Lazy alone causes 1.5s p99 on cache miss (first hit after eviction). Pre-warm guarantees <100ms p99. Hybrid means a failed cron doesn't break the dashboard; lazy backfills.
**Owner:** `AdminService` (cron annotations) + `PrismaReplicaService` injection (existing infra).

### D-2: Smart alert detection — cron vs event-driven
**Decision:** Keep cron for periodic scans (RI drops, inactive libraries — these are "absence of events" which event-driven cannot detect natively). Use Kafka `tuman.ri.dropped` and `library.inactive` events ONLY for downstream alert FAN-OUT to admin dashboards via the existing `KafkaConsumerService` (Phase 1 INFRA-08, already routing `TUMAN_RI_DROPPED → emitNewAlert`).
**Rationale:** PITFALLS S4 — events were emitted but unconsumed; Phase 1 closed that loop. Phase 5 must not re-add a parallel event-driven detector. One detection path (cron) + one emission path (Kafka → WebSocket).
**Owner:** `AuditService` (consolidated cron) + `KafkaConsumerService` (existing pass-through).

### D-3: Real-time delivery — WebSocket vs SSE vs polling
**Decision:** WebSocket only. The StatsGateway Redis-adapter (Phase 1 INFRA-07) is production-ready, multi-replica safe, and already routing 3 event types (alerts, top100, badges). Add 3 more emit methods (`emitStatsRefresh(scope, scopeId, stats)`, `emitTumanAlerted(...)`, `emitMapDataRefresh()`).
**Rationale:** Polling at 30s adds 5M users × 2 req/min × 30 days = 4.3B requests/month — unsustainable. SSE has worse multi-replica story than socket.io Redis-adapter. WebSocket subscription + cache-warming push is the production-grade pattern.
**Owner:** `StatsGateway` (extend) + frontend `useEffect` subscribers (mirror `TopClient.tsx:107` pattern).

### D-4: GeoJSON serving strategy
**Decision:** Bundle simplified province-level GeoJSON (~80KB gzip) at `apps/frontend/public/geojson/uzbekistan-viloyats.geojson`. Serve tuman-level GeoJSON (~500KB) from same static path but lazy-load only when user zooms in. Document `mapshaper -simplify 20%` command in Wave 0.
**Rationale:** Static file = browser-cacheable via Cache-Control: 1y immutable. No API endpoint needed (boundaries never change). CDN delivery if `next/static` is fronted by Cloudflare in production.
**Owner:** Frontend + ops (CDN headers).

### D-5: Email provider
**Decision:** `nodemailer` (8.x latest) with SMTP transport. Document Unicon.uz / TIF DC SMTP relay as production target. Dev no-op when `SMTP_HOST` unset (mirror Eskiz pattern). NOT Resend/SendGrid — UZ data residency favors local SMTP. [CITED: nodemailer.com]
**Rationale:** Battle-tested (~5M weekly downloads), SMTP works with any provider including UZ-resident relays, swap-out cost is low if Resend becomes attractive later. Per PkgPulse Guides 2026: "Nodemailer + SES is the cheapest for high volume; nodemailer + UZ SMTP relay satisfies localization."
**Owner:** `MailClient` infra service (new).

### D-6: Monthly PDF templating
**Decision:** Reuse `PdfService.buildMonthlyReportHtml` template (pdf.service.ts:86-158) with `escapeHtml` already applied (Plan 04-03 FIX A). Parameterize via a `ReportDataService.gatherForScope(scope, scopeId)` that returns the unified `{ tableRows, period, title }` shape. Single template = single security review surface.
**Rationale:** Don't add a templating engine (Handlebars/EJS) for 1 report type. The existing inline template is HTML-escape-safe per the Phase 4 fix. Plan-checker for any new template additions must verify `escapeHtml` coverage.
**Owner:** `ReportDataService` (new) + `PdfService` (extend with scope-specific titles).

### D-7: B2B demo CRM
**Decision:** MVP = email notification to admins on `createDemoRequest`. Persist in `DemoRequest` table (exists). Surface in `/dashboard/demo-requests` (exists). NO third-party CRM (HubSpot, Pipedrive) integration in V1.0 — out of scope per CLAUDE.md §VI.3 line "9 marketing fields → form + email is enough".
**Rationale:** Per CLAUDE.md §VI.3, B2B demo block says "Demo so'rash formi + admin email + Google Sheets / oddiy CRM". Phase 5 ships email + admin dashboard. Sheets/HubSpot is post-V1 polish.
**Owner:** `AdminService.createDemoRequest` (add hook).

---

## Library & Dependency Recommendations

| Package | Ecosystem | Recommended Version | Purpose | Source | Status |
|---------|-----------|---------------------|---------|--------|--------|
| firebase-admin | npm | ^13.x | NOTIF-02 FCM server SDK | [CITED: firebase.google.com] | [ASSUMED — verify with slopcheck + `npm view firebase-admin version`] |
| nodemailer | npm | ^8.x (current 8.0.7 per pkgpulse 2026) | NOTIF-03 SMTP email | [CITED: nodemailer.com] | [ASSUMED — verify with slopcheck + `npm view nodemailer version`] |
| mapshaper | npm (devDep / CLI only) | ^0.6.x | GeoJSON simplification in Wave 0 build script | [CITED: github.com/mbloch/mapshaper] | [ASSUMED — devDependency only, no runtime risk] |
| leaflet | npm | ^1.9.4 (installed) | MAP-01 already in package.json | already shipped Phase 5 baseline | [VERIFIED: package.json] |
| @types/leaflet | npm | ^1.9.14 (installed) | leaflet types | already shipped | [VERIFIED: package.json] |
| react-leaflet | npm | (NOT NEEDED — vanilla Leaflet wrapper already in ViloyatMap.tsx pattern) | — | — | declined — existing dynamic-import pattern works |
| firebase | npm (frontend) | ^10.x | NOTIF-02 client FCM token registration + service worker | [CITED: firebase.google.com] | [ASSUMED — verify with slopcheck + `npm view firebase version`] |
| socket.io-client | npm (frontend) | ^4.7.5 (installed) | WebSocket subscriber | already shipped | [VERIFIED: package.json] |
| recharts | npm (frontend) | ^2.12.7 (installed) | STAT-04..06 charts (already used Phase 3 donations) | already shipped | [VERIFIED: package.json] |

**Alternatives considered:**

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| nodemailer | Resend / SendGrid / Mailgun | Modern API; React Email integration; **fails UZ data localization** (servers abroad). Reject for V1.0. |
| firebase-admin | `node-pushnotifications` | Wraps APNS/FCM both; **doesn't handle FCM topic broadcasts elegantly** and Apple cert lifecycle is extra ops. Reject. |
| Leaflet | MapLibre GL / Mapbox GL | WebGL choropleths; **heavier (~200KB), requires tile-server commitment** vs Leaflet's CDN OSM tiles. For static UZ boundaries with ~14+200 polygons, Leaflet is sufficient. |
| akbartus/GeoJSON-Uzbekistan | geoBoundaries.org ADM2 | Both work; akbartus has Latin name properties out of box; geoBoundaries has international stable IDs. Pick akbartus, augment with viloyat code mapping. |

---

## Package Legitimacy Audit

> **Required** — Phase 5 installs new packages (firebase-admin, nodemailer, frontend firebase). Slopcheck must run before final dependency selection.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| firebase-admin | npm | 9+ years | ~3M/week | github.com/firebase/firebase-admin-node | NOT RUN AT RESEARCH TIME | Pending verification — gate with `checkpoint:human-verify` before install |
| nodemailer | npm | 14+ years | ~5M/week | github.com/nodemailer/nodemailer | NOT RUN AT RESEARCH TIME | Pending verification — gate with `checkpoint:human-verify` before install |
| firebase (browser SDK) | npm | 9+ years | ~2M/week | github.com/firebase/firebase-js-sdk | NOT RUN AT RESEARCH TIME | Pending verification — gate with `checkpoint:human-verify` before install |
| mapshaper | npm (devDep) | 8+ years | ~12K/week | github.com/mbloch/mapshaper | NOT RUN AT RESEARCH TIME | Pending verification — devDep only, lower risk |
| leaflet | npm | already installed | — | — | already in package.json (Phase 0 baseline) | OK |
| recharts | npm | already installed | — | — | already in package.json | OK |

**Packages removed due to slopcheck [SLOP] verdict:** none yet (audit deferred to Wave 0 first-install task)
**Packages flagged as suspicious [SUS]:** none yet

**Mitigation:** Since slopcheck is not available at research time, the planner MUST insert a `checkpoint:human-verify` task before each install with the command:
```bash
pip install slopcheck --break-system-packages 2>/dev/null || true
slopcheck install firebase-admin nodemailer firebase mapshaper --json
npm view firebase-admin version && npm view nodemailer version && npm view firebase version && npm view mapshaper version
```

---

## Phase 1+2+3+4 Carry-overs Respected

This phase consumes the following primitives without re-implementing:

| Primitive | Source | How Phase 5 Uses It |
|-----------|--------|---------------------|
| `PrismaReplicaService` | Phase 1 INFRA-10 / Phase 2 Plan 02-03 | All heavy STAT-* and ALERT-* read queries route through replica. Constructor inject in `AdminService` + `AuditService`. |
| `CacheService.remember(key, ttl, fn)` | Phase 1 (cache.service.ts:104-111) | All pre-aggregated stats reuse this. TTL constants already match requirement (`ttl.stats=5min`, `ttl.alerts=2min`). |
| `CacheService.keys.{nationalStats, viloyatStats, tumanStats, smartAlerts}` | Phase 1 (cache.service.ts:114-124) | Reused as-is. ADD `keys.mahallaStats(id)` and `keys.ageBreakdown(scope,id)`. |
| `NOTIFICATION_QUEUE` (BullMQ) | Phase 1 NOTIF-04 / queue.module.ts:33 | Phase 5 extends `NotificationProcessor` to handle `push` (via FcmClient) and `email` (via MailClient) — same processor file. |
| `StatsGateway.emit*` (WebSocket) | Phase 1 INFRA-07 / Phase 3 TOP-07 | New methods: `emitStatsRefresh(scope, scopeId)`, `emitTumanAlerted(...)`. Existing `emitNewAlert`, `emitAlertResolved` already drive `/dashboard/alerts` page. |
| `@socket.io/redis-adapter` | Phase 1 INFRA-07 (stats.gateway.ts:81) | Used automatically — phase 5 gateway extensions inherit multi-replica fan-out. |
| `KafkaConsumerService` | Phase 1 INFRA-08 (kafka-consumer.service.ts) | Already routes `TUMAN_RI_DROPPED`, `FRAUD_DETECTED`, `LIBRARY_INACTIVE`, `BADGE_EARNED` to gateway. Phase 5 may add `RI_RISING` and `SYSTEM_DOWN` topics if needed. |
| `JwtAuthGuard` global + `@Public()` decorator | Phase 1 INFRA-03 | LAND-* endpoints stay `@Public()`. Stats endpoints stay role-guarded. |
| `escapeHtml` (PdfService + invoice.service) | Plan 04-03 FIX A | Reused for monthly PDF reports + email HTML bodies. |
| `_escapeFormulaCell` | Plan 04-04 FIX A | Reused if Phase 5 adds Excel exports for stats. |
| `PrivacyMask.maskNameIfMinor` | Phase 3 TOP-06 (common/utils/privacy-mask.util.ts) | Applied to public landing stats if any individual user names ever leak through (defensive). |
| `IpWhitelistGuard` + `@IpWhitelist(envKey)` | Phase 3 Plan 03-01 | Available if Phase 5 adds webhook-style endpoints for FCM delivery status callbacks (optional). |
| `DEV_OTP_BYPASS` fail-closed pattern | Phase 1 Plan 01-03 | Mirror for `DEV_FCM_PUSH_STUB` and `DEV_EMAIL_STUB` if needed. |
| `EskizSmsClient` dev-no-op pattern | Phase 1 (eskiz.client.ts) | Direct template for `FcmClient` and `MailClient` dev no-op when env unset. |
| `PdfService.generateFromHtml` | Phase 4 Plan 04-03 (puppeteer + sparticuz/chromium + escapeHtml) | Direct reuse for RPT-01 monthly reports. |
| `RedisLockService` | Phase 4 Plan 04-01 | Reuse for multi-replica STATS_AGGREGATION_QUEUE deduplication (if cron runs on 3 replicas). |
| `@Cron` + Asia/Tashkent TZ | Phase 1 INFRA-05 | All Phase 5 crons respect Tashkent wall-clock — no UTC math needed. |
| `RolesGuard` + `@Roles(...)` | Phase 1 INFRA-03 | All admin stats endpoints continue to use existing role tiers (SUPER_ADMIN / VILOYAT_ADMIN / TUMAN_ADMIN / MUASSASA_ADMIN). |

---

## Smart Alert Detection Design

### Consolidated detection table

| Alert ID | Trigger Condition | Cron Cadence | Detection File | New Emission |
|----------|-------------------|--------------|----------------|--------------|
| ALERT-01 | `district.activeReaders(14d) == 0` | `*/15 * * * *` | `audit.service._checkInactiveTumans` (NEW) | `KAFKA_TOPICS.TUMAN_RI_DROPPED` (reuse) + push to TUMAN_ADMIN + VILOYAT_ADMIN |
| ALERT-02 | `tuman.riDelta(14d, 14d) < -0.10` | `*/15 * * * *` | `audit.service._checkTumanRiDrops` (FIX threshold for 10%) | `tuman.ri.dropped` Kafka + email TUMAN_ADMIN |
| ALERT-03 | `book.requestCount(30d) >= 50 AND availableCount == 0` | `*/15 * * * *` | `audit.service._checkFundShortages` (FIX threshold 10→50, availableCount ≤1→==0) | push to KUTUBXONACHI |
| ALERT-04 | `club.lastDebateAt < now - 30d` | `*/15 * * * *` | `audit.service._checkInactiveClubs` (FIX threshold 45→30) | push to KLUB_RAHBARI |
| ALERT-05 | `tuman.riDelta(14d, 14d) > +0.15` weekly | `0 9 * * MON` | `audit.service._checkTumanRiRises` (NEW) | email VILOYAT_ADMIN weekly digest |
| ALERT-06 | external watchdog detects backend silent >10 min | external Sentry/UptimeRobot | (off-platform) | direct Eskiz SMS to SUPER_ADMIN |

### Deduplication strategy (existing)

`audit.service._persistAndNotify` (lines 257-303) already does dedup: checks for `existing` `AiAuditLog` with same `scope+scopeId+issueType+resolved=false+createdAt>=24h ago`. Keep as-is. Phase 5 alerts inherit dedup automatically.

### Notification routing matrix (NEW for Phase 5)

| Alert | SMS? | Push? | Email? | Recipients |
|-------|------|-------|--------|------------|
| ALERT-01 KRITIK | YES | YES | YES | TUMAN_ADMIN + VILOYAT_ADMIN |
| ALERT-02 OGOH | NO | YES | YES | TUMAN_ADMIN |
| ALERT-03 OGOH | NO | YES | NO | KUTUBXONACHI of affected library |
| ALERT-04 OGOH | NO | YES | NO | KLUB_RAHBARI |
| ALERT-05 AXBOROT | NO | NO | YES (weekly) | VILOYAT_ADMIN |
| ALERT-06 SYSTEM_DOWN | YES | NO | YES | SUPER_ADMIN (via env CSV) |

**Implementation:** New `AlertDispatchService` queried by `_persistAndNotify` after WebSocket emit. Enqueues to NOTIFICATION_QUEUE one job per (alert, recipient, channel).

---

## GeoJSON Sourcing Strategy

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Source | `akbartus/GeoJSON-Uzbekistan` (OSM-derived, CC license) | Free, complete, includes both Latin and Cyrillic name properties |
| Boundaries level | Viloyat (14) + Tuman (200+) only; NO mahalla (would be ~10MB) | Mahalla-level requires server-rendered tiles (out of scope V1.0) |
| Simplification | `mapshaper -simplify 20% -o format=geojson` | Reduces 2MB → ~80KB while preserving topology (Visvalingam-Whyatt algorithm) |
| Storage location | `apps/frontend/public/geojson/uzbekistan-viloyats.geojson` (~80KB), `uzbekistan-tumans.geojson` (~500KB) | Static asset, browser-cacheable, no API roundtrip |
| Code-DB mapping | GeoJSON `properties.code` ↔ Prisma `Viloyat.code` / `Tuman.code` (format `"08"`, `"08-012"`) | Verified geo model at schema.prisma:113-132 — both use string codes |
| Coordinate system | EPSG:4326 (WGS84 lon/lat) | Leaflet default, no projection step needed |
| Update cadence | Manual on admin redistricting event (rare; last UZ redistricting was 2017) | Bake into deploy; no live refresh |

**Wave 0 task:** Write a `scripts/build-geojson.sh` script that downloads the source, simplifies, and outputs to `apps/frontend/public/geojson/`. Commit the simplified files (not the source) into the repo. Document the regeneration command in `README.md`.

---

## Email Provider Decision

| Provider | Cost (UZ) | Data Locality | Setup Complexity | V1.0 Recommendation |
|----------|-----------|---------------|------------------|----|
| nodemailer + SMTP (Unicon.uz / TIF DC relay) | ~free (bundled with hosting) | ✓ on-soil | LOW (host:port + auth) | **CHOSEN** |
| nodemailer + AWS SES | ~$0.10/1K emails | ✗ US/EU regions | LOW | Reject for UZ-hosted requirement |
| Resend + React Email | $0 free tier (3K/mo) | ✗ US-only | LOW (modern API) | Defer to V2 polish if SMTP relay proves flaky |
| SendGrid | Free tier 100/day | ✗ US/EU | MEDIUM (template management) | Reject for UZ-hosted requirement |

**Production env vars (to document in `.env.example`):**
```ini
SMTP_HOST=mail.unicon.uz       # or TIF DC relay endpoint
SMTP_PORT=587                   # STARTTLS
SMTP_SECURE=false               # true for port 465 implicit TLS
SMTP_USER=notifications@sifat.uz
SMTP_PASS=...                   # via Vault
SMTP_FROM="SIFAT LIBRARY <noreply@sifat.uz>"
ADMIN_NOTIFICATION_EMAILS=admin@sifat.uz,manager@sifat.uz  # CSV fallback for super-admin notifications
```

**Dev no-op behavior:** When `SMTP_HOST` is unset, `MailClient.sendMail` logs `[mail dev no-op] to=admin@***` and returns. Boots fine without creds, mirroring Eskiz/Vault.

---

## FCM Procurement

### Prerequisites (operator must provide before NOTIF-02 plan executes)

1. **Firebase project created** at console.firebase.google.com under sifat.uz Google Workspace account
2. **Service account JSON downloaded** — store in Vault at `vault/secrets/sifat/fcm-service-account.json`, mount as file in container, set `FCM_SERVICE_ACCOUNT_KEY_PATH=/etc/secrets/fcm-service-account.json`
3. **VAPID key pair generated** (for web push) — public key into `NEXT_PUBLIC_FCM_VAPID_KEY`, private key in Vault
4. **Firebase config object** for web SDK init — into `NEXT_PUBLIC_FIREBASE_*` env vars (apiKey, authDomain, projectId, messagingSenderId, appId)
5. **APNS certificate** for iOS push (deferred to V2 native app phase — web/Android only in V1.0)

### Test plan for live verification

1. Register a test FCM token via authenticated `POST /users/me/fcm-token`
2. Trigger `POST /admin/test-push/{userId}` (super-admin-only test endpoint)
3. Verify device receives notification
4. Verify `DeviceToken.lastSeen` updated
5. Send to revoked token → verify cleanup deletes the row

### Production fail-hard

Mirror Phase 1 Vault pattern: in production, `FcmClient.onModuleInit()` throws if `FCM_SERVICE_ACCOUNT_KEY_PATH` is unset or unreadable. Dev allows missing.

---

## Build Order (Waves)

### Wave 0 — Foundations (1 plan)

- **Plan 05-00:** Test infrastructure + GeoJSON + slopcheck (Wave 0 prep)
  - Add test files for stats aggregation (admin.service.spec extensions for replica routing)
  - Run slopcheck on firebase-admin, nodemailer, firebase, mapshaper (block on [SLOP], document [SUS])
  - Build script `scripts/build-geojson.sh` (mapshaper simplify, output to `apps/frontend/public/geojson/`)
  - Commit simplified `uzbekistan-viloyats.geojson` + `uzbekistan-tumans.geojson`
  - Backend feature flag scaffolds: `DEV_FCM_PUSH_STUB` and `DEV_EMAIL_STUB` env vars (NOT for prod) — mirror DEV_OTP_BYPASS pattern with NODE_ENV allowlist

### Wave 1 — Stats hardening (3 plans, parallel-able)

- **Plan 05-01:** STAT-01..03 — Replica routing + pre-aggregation cron + mahalla endpoint
  - Inject `PrismaReplicaService` into `AdminService`
  - Add `getMahallaStats` + endpoint
  - Add 5-min and 15-min crons with BullMQ jobId dedup
  - Fix `_fetchAllViloyatStats` to return per-viloyat RI (bug)
- **Plan 05-02:** STAT-04..07 — Gender filter + age aggregation + genre trend + book shortage UI
  - Promote `getAgeGroup` to shared util
  - Add `getAgeBreakdown` + `getGenderBreakdown` (scoped)
  - Add `getGenreTrend(months=12)`
  - Frontend "Buyurtma" button + `AiAuditLog` ORDER_REQUEST write
- **Plan 05-03:** Notification infra — FcmClient + MailClient + DeviceToken model
  - Install firebase-admin, nodemailer (slopcheck-verified)
  - Create `FcmClient` infra service + `MailClient` infra service
  - Add `DeviceToken` Prisma model + migration
  - Wire `NotificationProcessor.sendPush` and `sendEmail` to real clients
  - Add `POST /users/me/fcm-token` + frontend registration flow (basic — service worker integration deferred to Phase 7 PWA)

### Wave 2 — Alerts + Real-time + Map (3 plans, sequential)

- **Plan 05-04:** ALERT-01..05 — Consolidated detection engine
  - Migrate `admin.service.checkSmartAlerts` logic into `audit.service`
  - Add `ALERT_TYPES` constants
  - Fix thresholds: ALERT-03 (50+/0), ALERT-04 (30d), add ALERT-05 RI_RISING weekly
  - Replace `_buildTumanRiMap` with GROUP BY $queryRaw (closes PITFALLS S1)
  - Add `AlertDispatchService` routing matrix (sms/push/email per alert type and recipient role)
  - ALERT-06 SYSTEM_DOWN: add `/admin/system-down-test` endpoint + document UptimeRobot/BetterStack external watchdog setup
- **Plan 05-05:** Real-time delivery — gateway extensions + frontend subscribers
  - Add `StatsGateway.emitStatsRefresh(scope, scopeId, stats)` and emit from pre-aggregation cron
  - Frontend `/dashboard/page.tsx` + `/dashboard/stats/page.tsx` subscribe to `stats:national`, `stats:viloyat:{id}` rooms
  - Reuse `TopClient.tsx:107` pattern for socket lifecycle
- **Plan 05-06:** MAP-01..03 — Choropleth conversion
  - Replace circleMarker with `L.geoJSON(viloyatsGeoJSON, { style, onEachFeature })`
  - Wire to real per-viloyat RI from Plan 05-01 backend fix
  - Lazy-load tuman-level GeoJSON on zoom > 7
  - Keep grid-list fallback for mobile (already exists at stats/page.tsx:520-548)

### Wave 3 — Reports + Landing (3 plans, parallel-able)

- **Plan 05-07:** RPT-01..02 — Monthly PDF reports + email dispatch
  - Add `ReportDataService.gatherForScope(scope, scopeId, monthStart, monthEnd)`
  - Parameterize `downloadMonthlyReport` (controller + service)
  - Add `@Cron("0 6 1 * *") generateMonthlyReports` enqueueing 1+14+200=215 jobs to REPORT_QUEUE
  - Add `ReportEmailProcessor` consuming REPORT_QUEUE — generates PDF, attaches, sends via MailClient
  - BullMQ concurrency 2 (PITFALLS M6)
- **Plan 05-08:** LAND-01..03 — Live counter + B2B CRM + SEO
  - Public `/api/public/landing-stats` endpoint (subset of national stats, sanitized)
  - `<LiveStatsRefresher />` client component with 30s refetchInterval
  - `AdminService.createDemoRequest` notifies admins via email + rate-limit via `incrWithTtl("demo-rl:${phone}", 3600)`
  - Twitter Card metadata + JSON-LD `<Script>` in `app/[locale]/page.tsx` head
- **Plan 05-09:** Phase 5 closeout — consolidated documentation + VERIFICATION prep
  - Update `.env.example` with all new env vars
  - Update CLAUDE.md §VI footers (no narrative change, just status checkmarks)
  - Document operator-supplied secrets checklist (FCM, SMTP, UptimeRobot)

---

## Validation Architecture (Nyquist)

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest 30.3.0 (backend) + Jest 30 (frontend, jsdom env) |
| Config file | `apps/backend/jest.config.js`, `apps/frontend/jest.config.js` |
| Quick run command | `cd apps/backend && npm test -- --testPathPattern='admin\|ai/audit\|landing\|stats'` |
| Full suite command | `cd apps/backend && npm test && cd ../frontend && npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| STAT-01 | `/admin/stats/mahalla/:id` returns correct shape | unit | `pytest`-equivalent: `npm test -- --testPathPattern=admin.service.spec` | ❌ Wave 0 — extend existing `admin.service.spec.ts` |
| STAT-01 | All 4 stats endpoints route through replica | unit | `npm test -- --testPathPattern=admin.service.spec -t "replica"` | ❌ Wave 1 |
| STAT-02 | Dashboard initial render shows real numbers (no `—`) | integration (jsdom) | `npm test -- --testPathPattern=dashboard.spec` | ❌ Wave 1 |
| STAT-03 | Pre-aggregation cron warms 14 viloyat keys in <30s | unit | `npm test -- --testPathPattern=admin.service.spec -t "preaggregation"` | ❌ Wave 1 |
| STAT-04 | Gender breakdown filterable by viloyat | unit | `npm test -- --testPathPattern=admin.service.spec -t "gender"` | ❌ Wave 1 |
| STAT-05 | Age groups categorize ReadingIndex by user.dob correctly | unit | `npm test -- --testPathPattern=admin.service.spec -t "ageGroup"` | ❌ Wave 1 |
| STAT-06 | Genre trend returns 12 monthly buckets | unit | `npm test -- --testPathPattern=admin.service.spec -t "genreTrend"` | ❌ Wave 1 |
| STAT-07 | Book shortage marks order request via AiAuditLog | unit | `npm test -- --testPathPattern=admin.service.spec -t "orderRequest"` | ❌ Wave 1 |
| ALERT-01 | District with 0 readers 14d emits LIBRARY_INACTIVE alert | unit | `npm test -- --testPathPattern=audit.service.spec -t "inactiveTuman"` | ❌ Wave 2 |
| ALERT-02 | 10%+ RI drop triggers RI_DROPPED alert + Kafka event | unit | `npm test -- --testPathPattern=audit.service.spec -t "riDrop"` | ❌ Wave 2 — extend existing `audit.service.spec.ts` |
| ALERT-03 | 50+ requests + availableCount=0 triggers FUND_SHORTAGE | unit | `npm test -- --testPathPattern=audit.service.spec -t "fundShortage"` | ❌ Wave 2 |
| ALERT-04 | 30d no debate triggers CLUB_INACTIVE | unit | `npm test -- --testPathPattern=audit.service.spec -t "clubInactive"` | ❌ Wave 2 |
| ALERT-05 | 15%+ RI rise triggers RI_RISING (weekly cron only) | unit | `npm test -- --testPathPattern=audit.service.spec -t "riRising"` | ❌ Wave 2 |
| ALERT-06 | `/admin/system-down-test` sends Eskiz SMS to super_admin CSV | integration | `npm test -- --testPathPattern=admin.controller.spec -t "systemDownTest"` | ❌ Wave 2 |
| MAP-01 | ViloyatMap renders L.geoJSON polygons (not circleMarkers) | integration (jsdom + mock leaflet) | `npm test -- --testPathPattern=ViloyatMap.spec` | ❌ Wave 2 |
| MAP-02 | onSelect fires when polygon clicked | integration | (same as MAP-01) | ❌ Wave 2 |
| MAP-03 | GeoJSON file present + valid + <100KB | unit (fs check) | `npm test -- --testPathPattern=geojson.spec` | ❌ Wave 0 |
| RPT-01 | `downloadMonthlyReport(scope, scopeId)` returns PDF | integration | `npm test -- --testPathPattern=admin.controller.spec -t "monthlyReport"` | ❌ Wave 3 — extend |
| RPT-02 | Monthly cron enqueues 215 jobs to REPORT_QUEUE | unit | `npm test -- --testPathPattern=report-email.processor.spec` | ❌ Wave 3 |
| NOTIF-02 | FCM send invoked on push job | unit | `npm test -- --testPathPattern=notification.processor.spec -t "sendPush"` | ❌ Wave 1 — extend existing |
| NOTIF-02 | DeviceToken cleanup on FCM "not-registered" error | unit | (same as above) | ❌ Wave 1 |
| NOTIF-03 | SMTP send invoked on email job | unit | `npm test -- --testPathPattern=notification.processor.spec -t "sendEmail"` | ❌ Wave 1 |
| LAND-01 | `<LiveStatsRefresher />` polls every 30s | integration (jsdom + fake timers) | `npm test -- --testPathPattern=LiveStatsRefresher.spec` | ❌ Wave 3 |
| LAND-02 | createDemoRequest enqueues email to admin | unit | `npm test -- --testPathPattern=admin.service.spec -t "demoRequestEmail"` | ❌ Wave 3 |
| LAND-02 | demo-request rate limit blocks 4th request/hour | unit | `npm test -- --testPathPattern=admin.service.spec -t "demoRequestRateLimit"` | ❌ Wave 3 |
| LAND-03 | Twitter Card + JSON-LD present in HTML | integration | `npm test -- --testPathPattern=landing-page.spec` | ❌ Wave 3 |

### Sampling Rate

- **Per task commit:** `cd apps/backend && npx jest --testPathPattern='<plan-specific-pattern>' --silent`
- **Per wave merge:** `cd apps/backend && npm test && cd ../frontend && npm test`
- **Phase gate:** Full suite green; admin module test count growth ≥ +60 (Phase 4 baseline 1169 → Phase 5 target ≥1229)

### Wave 0 Gaps

- [ ] `apps/backend/src/modules/admin/__tests__/admin.service.preaggregation.spec.ts` — covers STAT-03 cron behavior
- [ ] `apps/backend/src/modules/ai/__tests__/audit.service.alert-consolidation.spec.ts` — covers ALERT-01..05 unified detection
- [ ] `apps/backend/src/infra/notifications/__tests__/fcm.client.spec.ts` — covers FcmClient lazy init + dev no-op
- [ ] `apps/backend/src/infra/notifications/__tests__/mail.client.spec.ts` — covers MailClient lazy init + dev no-op
- [ ] `apps/backend/src/modules/admin/__tests__/report-data.service.spec.ts` — covers ReportDataService.gatherForScope
- [ ] `apps/frontend/components/map/__tests__/ViloyatMap.spec.tsx` — covers choropleth rendering + onSelect
- [ ] `apps/frontend/components/__tests__/LiveStatsRefresher.spec.tsx` — covers 30s polling lifecycle
- [ ] `apps/frontend/__tests__/landing-page.spec.tsx` — covers Twitter Card + JSON-LD metadata
- [ ] `scripts/build-geojson.sh` — Wave 0 GeoJSON build script
- [ ] `apps/frontend/public/geojson/__tests__/geojson.spec.ts` — Node fs check (<100KB viloyat file present)

---

## Security Domain

> `security_enforcement` is enabled (absent from config = enabled).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes | Phase 1 INFRA-03 global JwtAuthGuard; STAT-* endpoints @Roles, LAND-* @Public |
| V3 Session Management | yes | Phase 1 INFRA-02 HttpOnly refresh cookie; sockets use auth from connection (TopClient pattern) |
| V4 Access Control | yes | RolesGuard tier-scoping for stats/alerts; scope filters in queries |
| V5 Input Validation | yes | class-validator DTOs on every new endpoint; FCM token format check; email validation; GeoJSON scopeId regex |
| V6 Cryptography | yes (light) | nodemailer SMTPS / STARTTLS; FCM service-account JSON in Vault; no hand-rolled crypto |
| V7 Error Handling & Logging | yes | dev no-op log lines never include PII (masked phone, email); MailClient masks recipient |
| V8 Data Protection | yes | Per Phase 3 TOP-06 maskNameIfMinor applied at LAND-01 if user names ever leak (defense-in-depth) |
| V9 Communication | yes | TLS for SMTP, HTTPS for FCM API |
| V11 Business Logic | yes | demo-request rate limit (LAND-02), report scope authorization (TUMAN_ADMIN can't email-trigger national report) |
| V12 Files & Resources | yes | GeoJSON served as static asset with correct Cache-Control; PDF buffer never written to disk |
| V13 API & Web Service | yes | Public landing endpoint sanitization (no fraud signals, no individual user records) |
| V14 Configuration | yes | NODE_ENV-gated dev flags fail-closed in prod (mirror Plan 01-03 / 03-01 / 04-01 patterns) |

### Known Threat Patterns for SIFAT V1.0 (Phase 5 surface)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| HTML/PDF injection via library.name in monthly report | Tampering | Reuse Phase 4 `escapeHtml` (already in PdfService) |
| Email-injection via demo-request.organization | Tampering | Apply `_sanitizeForSms`-like pattern (strip CR/LF, escape HTML) before email body |
| FCM token leakage in logs | Information Disclosure | Mask token in logs — only log last 8 chars |
| SMTP credential leak via .env.prod | Information Disclosure | Mount via Vault file, never log SMTP_PASS |
| Demo-request spam → admin email DoS | Denial of Service | Phase 1 `incrWithTtl` rate limit (3/hour/phone) |
| Stats endpoint role bypass (TUMAN_ADMIN reading SUPER_ADMIN scope) | Elevation of Privilege | Existing RolesGuard + add explicit scope assertion in service layer |
| Map endpoint exposes user PII via tuman drilldown | Information Disclosure | Aggregate counts only; never include user list in /stats/tuman response |
| Public landing endpoint reveals fraud/alert info | Information Disclosure | Whitelist allowed fields in `/api/public/landing-stats` (don't auto-passthrough all from `getNationalStats`) |
| LiveStatsRefresher endpoint becomes DDoS target | Denial of Service | Cache served from Redis with 30s+ TTL (already 5min); rate-limit per IP if abused |
| Choropleth GeoJSON file tampering (supply chain) | Tampering | Commit checked-in file with SHA in git; verify integrity at build time |

---

## Code Examples

### Pre-aggregation cron

```ts
// apps/backend/src/modules/admin/admin.service.ts (extension)
// Source: synthesized from CacheService.remember (cache.service.ts:104-111) and
// Phase 2 BullMQ addBulk pattern (reading.service.ts:106)
@Cron("*/5 * * * *", { name: "stats-preagg-national-viloyat" })
async preaggregateNationalAndViloyat() {
  await this.getNationalStats(); // populates stats:national, 5min TTL
  const viloyats = await this.replica.viloyat.findMany({ select: { id: true } });
  await Promise.all(viloyats.map(v => this.getViloyatStats(v.id))); // 14 keys
  this.gateway.emitStatsRefresh("national", "UZ", null);
}
```

### FcmClient lazy init (mirror Eskiz)

```ts
// apps/backend/src/infra/notifications/fcm.client.ts (NEW)
// Source: Phase 1 eskiz.client.ts:19-75 pattern + firebase.google.com/docs/admin/setup
@Injectable()
export class FcmClient implements OnModuleInit {
  private readonly logger = new Logger(FcmClient.name);
  private app?: admin.app.App;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const keyPath = this.config.get<string>("FCM_SERVICE_ACCOUNT_KEY_PATH");
    if (!keyPath) {
      this.logger.warn("[fcm dev no-op] FCM_SERVICE_ACCOUNT_KEY_PATH not set");
      return;
    }
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    this.app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  async send({ token, notification }: { token: string; notification: { title: string; body: string } }) {
    if (!this.app) { this.logger.warn(`[fcm dev no-op] would push to ${token.slice(-8)}`); return; }
    try {
      await this.app.messaging().send({ token, notification });
      this.logger.log({ token: `***${token.slice(-8)}`, status: "success" });
    } catch (err: any) {
      const code = err.errorInfo?.code;
      if (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token") {
        throw new InvalidFcmTokenError(token);
      }
      throw err;
    }
  }
}
```

### Choropleth wiring

```tsx
// apps/frontend/components/map/ViloyatMap.tsx (REWRITE of marker section)
// Source: leafletjs.com/examples/choropleth/
const geojson = await fetch("/geojson/uzbekistan-viloyats.geojson").then(r => r.json());
const geoLayer = L.geoJSON(geojson, {
  style: (feature) => {
    const code = feature?.properties.code; // e.g., "08"
    const ri = data.find(d => d.viloyatId === code)?.readingIndex ?? 0;
    return {
      fillColor: riColor(ri),
      weight: 1.5,
      opacity: 1,
      color: "white",
      fillOpacity: 0.75,
    };
  },
  onEachFeature: (feature, layer) => {
    layer.on({
      click: () => {
        const code = feature.properties.code;
        const v = data.find(d => d.viloyatId === code);
        if (v) onSelect?.(v);
      },
      mouseover: (e) => e.target.setStyle({ weight: 3, color: "#666" }),
      mouseout: (e) => geoLayer.resetStyle(e.target),
    });
    layer.bindTooltip(`<b>${feature.properties.name}</b><br/>RI: ${...}`);
  },
}).addTo(map);
```

### Live stats refresher

```tsx
// apps/frontend/components/landing/LiveStatsRefresher.tsx (NEW)
// Source: socket.io how-to-use-with-react + TopClient.tsx:107 pattern
"use client";
import { useQuery } from "@tanstack/react-query";

export function LiveStatsRefresher({ initialStats }: { initialStats: PublicLandingStats }) {
  const { data } = useQuery({
    queryKey: ["landing-live"],
    queryFn: async () => (await fetch("/api/public/landing-stats")).json(),
    initialData: initialStats,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false, // don't burn battery on hidden tabs
  });
  return <HeroNumbers stats={data} />;
}
```

---

## State of the Art

| Old Approach (current) | Current Approach (Phase 5 target) | When Changed | Impact |
|------------------------|-----------------------------------|--------------|--------|
| circleMarker per viloyat with simulated RI | Choropleth GeoJSON polygons with real per-viloyat aggregation | Phase 5 Plan 05-06 | Map matches CLAUDE.md §VI.4 "interaktiv xarita (Leaflet.js) hududlar bo'yicha rang xarita" |
| Two parallel alert engines (admin + audit) | Single consolidated engine in AuditService | Phase 5 Plan 05-04 | Eliminates dual write to AiAuditLog; one issueType vocabulary |
| Stats served from primary DB | Stats served from PrismaReplicaService (replica) | Phase 5 Plan 05-01 | Closes PITFALLS S1 (S1's 60d findMany bug also addressed via GROUP BY) |
| Lazy cache-aside only | Lazy cache-aside + proactive 5min/15min cron warm | Phase 5 Plan 05-01 | <100ms p99 vs 1.5s on cache miss |
| push/email notifications = log stubs | push via firebase-admin, email via nodemailer | Phase 5 Plan 05-03 | NOTIF-02 + NOTIF-03 closed |

**Deprecated/outdated:**
- `admin.service.checkSmartAlerts` cron (lines 430-510): superseded by consolidated `audit.service.runAuditCycle`. Deleted after Plan 05-04 cuts over.
- Frontend `/dashboard/stats/page.tsx:453` simulated RI line: replaced by real backend per-viloyat RI in Plan 05-01.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | firebase-admin@^13 is current (npm view at plan time will confirm) | Library Recommendations | Low — verify via `npm view firebase-admin version` in Wave 0 |
| A2 | nodemailer@^8 (8.0.7) is current per pkgpulse 2026 | Library Recommendations | Low — `npm view nodemailer version` to confirm |
| A3 | akbartus/GeoJSON-Uzbekistan is the best Uzbek province GeoJSON source (CC license, complete) | GeoJSON Sourcing | Medium — verify Latin name property and tuman coverage in Wave 0; geoBoundaries is fallback |
| A4 | Unicon.uz / TIF DC provides SMTP relay endpoint | Email Provider | High — operator must confirm SMTP_HOST availability; otherwise pivot to nodemailer + AWS SES with documented data-locality risk |
| A5 | Phase 4's `PrismaReplicaService` works for STAT-* queries without modification | Phase 1+2+3+4 Carry-overs | Low — Phase 4 uses identical pattern for invoice stats, 1169/1169 tests green |
| A6 | `User.email` field exists on the User model (for B2B demo CRM admin lookup) | LAND-02 | Medium — must verify in schema; if nullable/missing, use `ADMIN_NOTIFICATION_EMAILS` env CSV as primary fallback |
| A7 | External UptimeRobot/BetterStack is acceptable for ALERT-06 (operator-supplied) | Alert Detection | Low — alternative is internal cron heartbeat which is weaker |
| A8 | 200+ tuman count is current — actual `Tuman` table count must be verified | STAT-03 cron sizing | Low — even 1000 tumans @ 5 queries each = 5K replica queries/15min is acceptable |
| A9 | mapshaper -simplify 20% produces a usable file (~80KB) | GeoJSON sizing | Low — fallback is no simplification (200KB acceptable for first-load on dashboard, not landing) |
| A10 | Firebase project + service account JSON will be procured by operator before Plan 05-03 executes | FCM Procurement | High — blocks Plan 05-03 live verification; ship with dev-no-op until creds arrive (mirror Eskiz pattern) |

**Action for planner:** Each of A1–A4, A6 should become a Wave 0 `checkpoint:human-verify` task or a Plan 05-00 verification step.

---

## Open Questions (RESOLVED)

> All 7 questions were resolved via user pre-approval of the researcher's recommended defaults. Each question is annotated with the resolution and the plan that implements it.

**Q1 RESOLVED** (Plan 05-01 Task 2 + 05-04 Task 2): nodemailer + SMTP, config-driven via SMTP_HOST/PORT/USER/PASS, dev no-op when env unset (mirrors Phase 1 Eskiz pattern). Vault prod fail-hard for SMTP_PASS.
**Q2 RESOLVED** (Plan 05-02 Task 2): Mahalla statistics on-demand with 30-min Redis TTL — NOT included in pre-aggregation cron (10K records too high-volume).
**Q3 RESOLVED** (Plan 05-05 Task 2): Per-alert immediate email/push for KRITIK + OGOHLANTIRISH; weekly digest cron for AXBOROT.
**Q4 RESOLVED** (Plan 05-01 Task 4 + 05-06 Task 2): V1 ships viloyat-only choropleth; tuman GeoJSON deferred to V2 (boundary data unavailable in clean form). Zoom > 7 logs deferred message.
**Q5 RESOLVED** (Plan 05-09 Task 2): V1 B2B = admin email + DB row + /dashboard/demo-requests page; no external CRM integration.
**Q6 RESOLVED** (Plan 05-02 Task 1): Defense-in-depth service-layer assertViloyatInScope + assertTumanInScope guards (mirrors Phase 4-04-fix-followup tier-admin scope pattern).
**Q7 RESOLVED** (Plan 05-08 Task 2 + 05-09 Task 2): ADMIN_NOTIFICATION_EMAILS env CSV fallback when User.email is null (most super-admins registered via phone OTP only).

---

### Original question detail (preserved for traceability)

1. **Email provider concrete: which SMTP relay?**
   - What we know: nodemailer + SMTP is the architecture. UZ data localization wants UZ-hosted MX.
   - What's unclear: Whether Unicon.uz / TIF DC actually exposes an SMTP relay to tenants, or if SIFAT must run its own postfix container.
   - Recommendation: Plan 05-00 includes a `checkpoint:human-verify` step asking operator: (a) is there a tenant SMTP relay available? (b) if not, do we deploy our own postfix sidecar or use AWS SES with explicit data-locality waiver?

2. **GeoJSON: viloyat-only or viloyat + tuman?**
   - What we know: viloyat file ~80KB, tuman file ~500KB. Both are achievable.
   - What's unclear: Whether tuman-level drilldown is V1.0 or V2.0.
   - Recommendation: Ship viloyat-only choropleth in Plan 05-06. Tuman-level deferred to V2 unless plan-checker flags otherwise.

3. **Mahalla-level statistics (10,000+ records)?**
   - What we know: CLAUDE.md §VI.1 says "4 darajali ierarxiya" including mahalla.
   - What's unclear: Whether mahalla statistics need pre-aggregation or are acceptable to compute on-demand (200+ tumans × 50 mahallas each = 10K mahallas; pre-aggregating all is 10K queries / 15min).
   - Recommendation: On-demand only for mahalla. Cache with 30-min TTL via existing `remember`. Skip from STAT-03 pre-aggregation cron.

4. **FCM web SDK setup with PWA (Phase 7)?**
   - What we know: NOTIF-02 says "push notifications". V1.0 doesn't require PWA full offline (Phase 7 PWA-01..06).
   - What's unclear: Whether Phase 5 ships web push (requires service worker + VAPID) or defers web to Phase 7.
   - Recommendation: Phase 5 ships FCM server-side and provides token registration endpoint. Frontend web SDK + service worker for receiving push is wired in Phase 7 PWA. V1.0 mobile (Phase 6 or V2) can subscribe to topics.

5. **Alert email digest format (daily summary vs per-alert)?**
   - What we know: ALERT-05 says "weekly report". ALERT-02 says "same-day email". Different cadences mixed.
   - What's unclear: Whether each alert generates an immediate email OR alerts batch into a daily digest.
   - Recommendation: Per-alert immediate for KRITIK + per-alert immediate for OGOHLANTIRISH; AXBOROT batched weekly. Document this in Plan 05-04 decisions.

6. **B2B demo CRM beyond email?**
   - What we know: CLAUDE.md §VI.3 says "admin email + Google Sheets / oddiy CRM".
   - What's unclear: Whether ops wants Google Sheets append (Apps Script webhook) in V1.0.
   - Recommendation: V1.0 = email + dashboard table. Google Sheets / HubSpot is post-V1.

7. **Stats endpoint scope assertion: who sees what?**
   - What we know: RolesGuard tiers roles. AdminController routes use `Roles(...REGION_ADMINS)`.
   - What's unclear: Whether `getViloyatStats(viloyatId)` validates that a `VILOYAT_ADMIN` is querying THEIR viloyatId (not a sibling viloyat's data).
   - Recommendation: Plan 05-01 includes service-layer scope assertion (mirrors Plan 04-04 `assertLibraryInScope`).

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| PostgreSQL primary | Stats writes, AuditLog | ✓ (Phase 1) | 15 | — |
| PostgreSQL replica | All STAT-* aggregation | ✓ (Phase 1 docker-compose.prod.yml provisioned) | 15 streaming standby | Falls back to primary if `DATABASE_REPLICA_URL` unset (PrismaReplicaService design) |
| Redis | All cache.* and BullMQ | ✓ (Phase 1) | 7 | — |
| BullMQ queues (`notifications`, `reports`) | NOTIF-02/03, RPT-02 | ✓ (Phase 1 NOTIFICATION_QUEUE, REPORT_QUEUE) | bullmq@^5.8 | — |
| Kafka | Alert event fan-out | ✓ (Phase 1 INFRA-08 consumer wired, degrades to no-op when KAFKA_BROKERS unset) | kafkajs@^2.2 | Graceful no-op |
| StatsGateway WebSocket | Real-time stat/alert push | ✓ (Phase 1 INFRA-07 Redis adapter) | socket.io@^4.7 | — |
| PdfService (puppeteer) | RPT-01 monthly PDFs | ✓ (Phase 4) | puppeteer-core@^22.15 + @sparticuz/chromium@^130 | — |
| firebase-admin SDK | NOTIF-02 | ✗ | — | Dev no-op until env supplied (mirror Eskiz pattern) |
| nodemailer | NOTIF-03 + RPT-02 email | ✗ | — | Dev no-op until env supplied |
| Firebase project / service account | NOTIF-02 live | ✗ (operator-supplied) | — | Code ships with dev no-op; activation = env var only |
| SMTP relay (Unicon.uz or other UZ-resident) | NOTIF-03 + RPT-02 live | ✗ (operator-supplied) | — | Code ships with dev no-op; activation = env var only |
| UptimeRobot / BetterStack (external watchdog) | ALERT-06 | ✗ (operator-supplied) | — | Code ships internal heartbeat cron + `/admin/system-down-test` endpoint that ops can hit |
| `mapshaper` CLI | Wave 0 GeoJSON build | ✗ | npm | Optional — operator can run on local dev machine and commit output |
| GeoJSON source (akbartus/GeoJSON-Uzbekistan) | MAP-03 | ✗ (Wave 0 download) | — | Fallback: geoBoundaries.org ADM2 |

**Missing dependencies with no fallback:**
- None — every missing dep has either a graceful dev no-op or operator-supplied activation path

**Missing dependencies with fallback:**
- firebase-admin live: dev no-op acceptable for V1.0 ship; push notifications won't fire until env supplied
- SMTP: dev no-op acceptable; email won't fire until env supplied
- Both follow the established Phase 1 Eskiz/IDUZ pattern: code-complete, credentials are an env-var change away

---

## Sources

### Primary (HIGH confidence)
- [Codebase Phase 1 verification](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/phases/01-infrastructure-hardening-authentication/01-VERIFICATION.md) — INFRA-07/08/10 wiring of WS Redis adapter, Kafka consumer, replica
- [Codebase Phase 2 verification](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/phases/02-reading-index-engine-core-book-logic/02-VERIFICATION.md) — PrismaReplicaService established pattern
- [Codebase Phase 3 verification](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/phases/03-rankings-gamification-donations/03-VERIFICATION.md) — TOP-07 WebSocket emit, TOP-06 anonymization
- [Codebase Phase 4 verification](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/phases/04-payment-subscriptions/04-VERIFICATION.md) — PdfService + escapeHtml + cache.remember stat pattern
- [PITFALLS.md S1, M6, S4, C3](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/research/PITFALLS.md) — pre-aggregation, Puppeteer memory, Kafka consumer, notification stub
- [ARCHITECTURE.md Real-Time Data Pipeline](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/.planning/research/ARCHITECTURE.md) — gRPC/Kafka/WebSocket separation
- [CLAUDE.md §VI Statistika va Landing Page](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/CLAUDE.md) — 4-darajali ierarxiya, Smart Alert tizimi, Landing Page bloklar
- [admin.service.ts](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/apps/backend/src/modules/admin/admin.service.ts) — existing stats + alert + demo-request implementation
- [ai/audit.service.ts](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/apps/backend/src/modules/ai/audit.service.ts) — existing audit cron + S1 pitfall location
- [notification.processor.ts](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/apps/backend/src/infra/queue/notification.processor.ts) — push/email stub location
- [stats.gateway.ts](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/apps/backend/src/infra/gateway/stats.gateway.ts) — emit methods, Redis adapter
- [pdf.service.ts](C:/Users/hayda/OneDrive/Рабочий%20стол/Sifatlibrary/apps/backend/src/infra/pdf/pdf.service.ts) — puppeteer template with escapeHtml

### Secondary (MEDIUM confidence — web research)
- [Firebase Admin SDK setup](https://firebase.google.com/docs/admin/setup) — service-account init, messaging.send
- [Firebase Admin npm](https://www.npmjs.com/package/firebase-admin) — current version range
- [Nodemailer 8.x npm](https://www.npmjs.com/package/nodemailer) — SMTP transport, ~5M weekly downloads
- [Best Email Libraries for Node.js 2026 (PkgPulse)](https://www.pkgpulse.com/guides/best-email-libraries-nodejs-2026) — nodemailer remains the SMTP standard
- [Leaflet Choropleth example](https://leafletjs.com/examples/choropleth/) — L.geoJSON style/onEachFeature pattern
- [Leaflet GeoJSON examples](https://leafletjs.com/examples/geojson/) — onEachFeature, bindTooltip patterns
- [Socket.IO use with React](https://socket.io/how-to/use-with-react) — useEffect lifecycle, cleanup on unmount
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/) — already confirmed in Phase 1
- [PostgreSQL REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html) — CONCURRENTLY semantics (not used in Phase 5, but evaluated as alternative)
- [akbartus/GeoJSON-Uzbekistan](https://github.com/akbartus/GeoJSON-Uzbekistan) — UZ admin boundaries, CC license
- [dirixtt/GeoJSON-Uzbekistan](https://github.com/dirixtt/GeoJSON-Uzbekistan) — alternative source
- [geoBoundaries Uzbekistan ADM2](https://data.humdata.org/dataset/geoboundaries-admin-boundaries-for-uzbekistan) — fallback humanitarian source

### Tertiary (LOW confidence — flagged for validation)
- A4: SMTP relay availability via Unicon.uz / TIF DC — operator must confirm
- A10: Firebase project creation timeline — depends on operator procurement schedule

---

## Project Constraints (from CLAUDE.md)

| Constraint | Source | Phase 5 honors |
|------------|--------|----------------|
| All data on UZ servers (Unicon.uz / TIF DC) | §VIII.3 | Email provider = SMTP-via-UZ-relay (nodemailer); FCM service-account-JSON in Vault (no cross-border for our auth data, only push payloads transit Google) |
| Append-only audit log | §VIII.4 | AiAuditLog is the existing pattern; Phase 5 alerts inherit (no PUT/PATCH on log rows) |
| Children under 14 anonymized in public rankings | §V.4 | Defense-in-depth: apply `maskNameIfMinor` to any landing/public stats that surface user names (none planned, but defensive) |
| OWASP Top-10 compliance | §VIII.2 | Plan checker enforces escapeHtml, role guards, rate limits |
| Asia/Tashkent TZ for all crons | Phase 1 INFRA-05 | Phase 5 crons inherit container TZ — no UTC math |
| `commit_docs: true` | .planning/config.json | Auto-commit RESEARCH.md to git after write |

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — packages chosen are widely used and verified against current ecosystem trends
- Architecture: HIGH — direct reuse of Phase 1–4 primitives, minimal new infra
- Pitfalls: HIGH — codebase audit at file:line caught the live S1 issue and the dual-alert-engine inconsistency
- Library names: MEDIUM — npm view + slopcheck verification deferred to Wave 0 plan execution (planner adds checkpoint task)
- GeoJSON source: MEDIUM — akbartus is the front-runner but tuman-property completeness should be Wave 0 verified
- Email provider: MEDIUM — SMTP architecture decided; specific relay endpoint (Unicon.uz vs operator-supplied) requires operator confirmation

**Research date:** 2026-06-07
**Valid until:** 2026-07-07 (30 days for stable npm versions; refresh if Firebase Admin or nodemailer major versions ship)
