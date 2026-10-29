# Phase 7: Offline PWA, Internationalization & Production Launch - Research

**Researched:** 2026-06-09
**Domain:** Service Worker / PWA, i18n, load testing, security testing, accessibility, AI NLP, audit logging
**Confidence:** MEDIUM-HIGH

## Summary

Phase 7 is the final V1.0 phase -- it spans five distinct technical domains: (1) offline PWA with 12-hour transaction queuing and sync, (2) Karakalpak/Russian full UI translations and multi-script Elasticsearch, (3) load and security testing (50K concurrent users, OWASP pentest), (4) AI system enhancements (NLP chat enrichment, real-time audit via Kafka, book recommendations), and (5) privacy/audit compliance (reading history hide option, 2-year append-only log retention).

The codebase already has significant scaffolding in place: a basic `sw.js` service worker with cache strategies and Background Sync stub, all 4 translation files with ~368 lines each covering the full UI string set, a working NLQ service with 7 SQL template query intents + GPT-4 enrichment, collaborative + content-based recommendation engine, predictive analytics with linear regression, root cause analysis, and an audit service running on 15-minute cron cycles with Kafka integration. The Elasticsearch index already has Uzbek-specific analyzers but lacks ICU plugin configuration for Cyrillic/Latin cross-script search.

**Primary recommendation:** Migrate the hand-written `sw.js` to Serwist (@serwist/next) for production-grade precaching + runtime caching, replace raw IndexedDB with Dexie.js for the offline transaction queue with conflict resolution, add ICU transform analyzer to Elasticsearch for I18N-03, run k6 load tests via Docker (since k6 CLI requires separate install), and add `hideReadingHistory` boolean to User schema for PERF-06 privacy.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PWA-01 | Service Worker (Serwist) with production-grade caching strategies | Serwist @serwist/next replaces hand-written sw.js; precache manifest auto-injected at build |
| PWA-02 | IndexedDB (Dexie.js) for offline catalog, book fund, and transaction queue | Dexie.js v4.4 provides typed schema + syncQueue table pattern |
| PWA-03 | Offline mode works for 12 hours with sync status indicator | SW cache TTL already 12h; Dexie syncQueue + Background Sync tag for replay |
| PWA-04 | 2G detection with text-only lite mode (no images) | navigator.connection.effectiveType + CSS media query prefers-reduced-data |
| PWA-05 | Offline transactions include auth tokens in replay requests | Store JWT access token in Dexie alongside queued transaction; refresh on sync |
| PWA-06 | Sync conflict resolution for concurrent offline transactions | Last-write-wins with server-side 409 Conflict detection; client retries with server version |
| I18N-01 | Karakalpak (kaa) full UI translation | kaa.json exists (368 lines); verify all new Phase 5/6 keys are covered |
| I18N-02 | Russian (ru) full UI translation | ru.json exists (368 lines); verify all new Phase 5/6 keys are covered |
| I18N-03 | Multi-script Elasticsearch analyzer for Cyrillic/Latin book search | Add ICU analysis plugin + icu_transform (Cyrillic-Latin) filter chain |
| PERF-01 | Load testing with k6: 50,000 concurrent users, API p95 < 200ms | k6 via Docker (grafana/k6); distributed execution needed for 50K VUs |
| PERF-02 | Security penetration testing: OWASP Top 10, no P1 critical vulnerabilities | OWASP ZAP Docker baseline scan + manual checklist; existing security headers solid |
| PERF-03 | Lighthouse scores: Performance 90+, Accessibility 90+, SEO 95+ | Lighthouse CI via npm; existing bundle optimization + security headers help |
| PERF-04 | WCAG 2.1 accessibility: keyboard navigation, screen reader, 4.5:1 contrast | axe-core automated scan + manual keyboard/screen-reader audit |
| PERF-05 | Append-only audit log with 2-year retention and archive migration | AiAuditLog monthly partitions (mirrors ReadingIndex pattern) + pg_dump archive cron |
| PERF-06 | Data deletion flow for user privacy (reading history hide option) | Add User.hideReadingHistory boolean; filter public-facing queries |
| AI-01 | NLP chat backend: 20-30 SQL query templates + GPT-4 enrichment | nlq.service.ts has 7 intents; expand to 20+ covering new Phase 5/6 modules |
| AI-02 | Real-time audit engine: Kafka events -> analysis -> issue detection -> alert | audit.service.ts runs 15min cron; add Kafka consumer for real-time event processing |
| AI-03 | Root cause analysis: when RI drops, identify top 3 causes with evidence | predict.service.ts already implements 5-factor RCA; wire to Kafka alert pipeline |
| AI-04 | Book recommendation engine: collaborative + content-based filtering | recommend.service.ts already implements 4-strategy weighted merge; needs frontend UI |
| AI-05 | Predictive analytics: 1-month RI forecast with +/-5% target accuracy | predict.service.ts has linear regression; sufficient for V1 with R2 confidence |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Service Worker / offline caching | Browser / Client | -- | SW runs in browser; intercepts fetch events client-side |
| IndexedDB transaction queue | Browser / Client | API / Backend | Client queues offline; backend processes on sync |
| Background Sync replay | Browser / Client | API / Backend | Browser triggers sync; backend validates + persists |
| 2G detection / lite mode | Browser / Client | -- | navigator.connection is client-only API |
| UI translations (i18n) | Frontend Server (SSR) | Browser / Client | next-intl loads at SSR; client hydrates |
| Elasticsearch multi-script | API / Backend | -- | Index analyzers configured server-side on ES |
| Load testing (k6) | DevOps / CI | API / Backend | k6 scripts target backend APIs |
| Security testing (OWASP ZAP) | DevOps / CI | API / Backend | ZAP scans backend endpoints |
| Lighthouse / WCAG | DevOps / CI | Frontend Server | CI runs Lighthouse against SSR pages |
| AI NLP chat | API / Backend | -- | SQL templates + GPT-4 enrichment on backend |
| Real-time Kafka audit | API / Backend | -- | Kafka consumer + audit.service on backend |
| Book recommendations | API / Backend | Browser / Client | Backend computes; frontend renders |
| Audit log retention | Database / Storage | API / Backend | Partition management on PostgreSQL |
| Privacy (hide history) | API / Backend | Database / Storage | Schema + query filter on backend |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @serwist/next | ^9.5.11 | Service Worker integration for Next.js | Official Workbox successor for Next.js; auto-generates precache manifest [ASSUMED -- discovered via WebSearch, confirmed on npm registry] |
| serwist | ^9.5.11 | Service Worker runtime (dev dependency) | Core SW APIs used by @serwist/next [ASSUMED] |
| dexie | ^4.4.3 | IndexedDB wrapper for offline data store | De facto standard for typed IndexedDB; 45M+ downloads [ASSUMED] |
| next-intl | ^4.13.0 | Internationalization framework | Already installed (^4.11.0); upgrade for latest fixes [VERIFIED: npm registry + already in project] |
| k6 (Docker) | latest | Load testing | Industry standard; run via `docker run grafana/k6` [ASSUMED] |
| axe-core | ^4.10 | Accessibility testing engine | WCAG 2.1 automated checking; Deque standard [ASSUMED] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid | ^11.1.0 | Generate offline transaction IDs | Client-side UUID for Dexie queue entries |
| @lhci/cli | ^0.15 | Lighthouse CI runner | Automated performance/accessibility scoring in CI |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @serwist/next | Hand-written sw.js (current) | Current sw.js lacks precache manifest injection, no build-time asset hashing, no automatic cache invalidation on deploy |
| Dexie.js | Raw IndexedDB (current) | Current openIDB() is ~30 lines with no schema versioning, no typed queries, no migration support |
| k6 | Artillery / Locust | k6 is Go-native (low memory per VU), JS scripting, better Docker support |
| axe-core | pa11y | axe-core has wider WCAG 2.1 coverage and integrates with Jest |

**Installation:**
```bash
# Frontend (PWA + accessibility)
cd apps/frontend && npm install @serwist/next uuid && npm install -D serwist axe-core @lhci/cli

# Backend (no new deps -- all AI/audit/ES features use existing packages)
# k6 runs via Docker, no npm install needed
```

**Version verification:** All versions confirmed via `npm view <pkg> version` on 2026-06-09.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| @serwist/next | npm | ~2 yrs | established | github.com/serwist/serwist | [OK] | Approved |
| serwist | npm | ~2 yrs | established | github.com/serwist/serwist | [OK] | Approved |
| dexie | npm | 10+ yrs | 2.5M/wk | github.com/dexie/Dexie.js | [OK] | Approved |
| uuid | npm | 13+ yrs | 80M+/wk | github.com/uuidjs/uuid | [OK] | Approved |
| axe-core | npm | 10+ yrs | 10M+/wk | github.com/dequelabs/axe-core | N/A (dev) | Approved |
| @lhci/cli | npm | 5+ yrs | 200K+/wk | github.com/GoogleChrome/lighthouse-ci | N/A (dev) | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                    +--------------------+
                    |   Rural Librarian  |
                    |   (PWA on phone)   |
                    +--------+-----------+
                             |
                    [offline: Dexie queue]
                    [online:  fetch API ]
                             |
              +--------------+---------------+
              |                              |
     +--------v--------+          +----------v---------+
     | Service Worker   |          | Next.js SSR        |
     | (@serwist/next)  |          | (i18n: next-intl)  |
     | - Precache       |          | - uz-Latn/uz-Cyrl  |
     | - Runtime cache  |          | - kaa / ru          |
     | - Background Sync|          | - Lighthouse 90+    |
     +--------+---------+          +----------+----------+
              |                               |
              |        +-----------+          |
              +------->| NestJS    |<---------+
                       | API       |
                       +-----+-----+
                             |
           +---------+-------+--------+---------+
           |         |                |          |
     +-----v---+ +---v------+  +-----v----+ +---v--------+
     | Prisma  | | Kafka    |  | ES (ICU) | | Redis      |
     | (PG 15) | | (events) |  | (search) | | (cache)    |
     +---------+ +----+-----+  +----------+ +------------+
                      |
               +------v-------+
               | AI Services  |
               | - NLQ (GPT-4)|
               | - Recommend  |
               | - Predict    |
               | - Audit Cron |
               +--------------+
```

### Recommended Project Structure (Phase 7 additions)

```
apps/frontend/
  app/
    sw.ts                    # Serwist service worker source (replaces public/sw.js)
  lib/
    offline/
      db.ts                  # Dexie database schema (books, libraries, syncQueue)
      sync.ts                # Background Sync replay logic with auth token injection
      network-status.ts      # Online/offline detection + 2G detection
      conflict-resolver.ts   # Last-write-wins conflict resolution
    i18n/
      missing-keys-check.ts  # Build-time script to find untranslated keys
  components/
    offline/
      OfflineBanner.tsx       # Offline status indicator
      SyncStatusBadge.tsx     # Pending sync count badge
      LiteModeBanner.tsx      # 2G text-only mode banner
    accessibility/
      SkipNavLink.tsx         # Skip-to-content link
  messages/
    uz-Latn.json             # UPDATE: add any missing Phase 5/6 keys
    uz-Cyrl.json             # UPDATE: sync with uz-Latn
    kaa.json                 # UPDATE: sync with uz-Latn
    ru.json                  # UPDATE: sync with uz-Latn

apps/backend/
  src/
    modules/ai/
      nlq-templates/          # NEW: 20+ SQL query template files
      kafka-audit.consumer.ts  # NEW: real-time Kafka event -> audit pipeline
    modules/users/
      privacy.service.ts       # NEW: PERF-06 hide reading history
  prisma/
    migrations/
      YYYYMMDD_phase7_audit_partition/  # AiAuditLog partitioning
      YYYYMMDD_phase7_privacy/          # User.hideReadingHistory

tests/
  k6/
    load-test.js              # k6 scenario: 50K VUs ramp
    smoke-test.js             # k6 quick sanity (10 VUs)
  accessibility/
    axe-audit.ts              # axe-core page scan
  security/
    owasp-zap-config.yaml     # ZAP baseline scan config
```

### Pattern 1: Serwist Service Worker with Dexie Offline Queue

**What:** Replace hand-written `public/sw.js` with Serwist-managed service worker. The SW source lives at `app/sw.ts`, and `@serwist/next` injects the precache manifest at build time. Dexie provides the IndexedDB schema for offline transaction queuing.

**When to use:** All PWA-01 through PWA-06 requirements.

**Example:**
```typescript
// Source: https://serwist.pages.dev/docs/next/getting-started [CITED]
// app/sw.ts
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
```

### Pattern 2: Dexie Offline Transaction Queue with Auth Token

**What:** Queue offline POST/PUT operations in Dexie with the JWT access token stored alongside the request payload. On Background Sync trigger, replay requests with the stored token.

**When to use:** PWA-02, PWA-05, PWA-06.

**Example:**
```typescript
// Source: Dexie.js sync patterns [CITED: https://dexie.org/docs/Syncable/Dexie.Syncable.js]
import Dexie, { Table } from "dexie";

interface SyncQueueEntry {
  id: string;           // UUID v4
  method: "POST" | "PUT" | "PATCH";
  url: string;
  body: string;         // JSON stringified
  accessToken: string;  // JWT at time of queuing
  createdAt: number;    // Date.now()
  retryCount: number;
  lastError?: string;
}

class SifatOfflineDB extends Dexie {
  syncQueue!: Table<SyncQueueEntry>;
  cachedBooks!: Table<{ id: string; [key: string]: unknown }>;
  cachedLibraries!: Table<{ id: string; [key: string]: unknown }>;

  constructor() {
    super("sifat-offline");
    this.version(2).stores({
      syncQueue: "id, createdAt",
      cachedBooks: "id, libraryId",
      cachedLibraries: "id",
    });
  }
}
```

### Pattern 3: Elasticsearch ICU Multi-Script Analyzer

**What:** Add ICU analysis plugin to Elasticsearch and configure a `cyrillic_latin` analyzer that transliterates Cyrillic input to Latin before matching. This allows a query in Cyrillic to match Latin-indexed book titles and vice versa.

**When to use:** I18N-03.

**Example:**
```typescript
// Source: https://www.elastic.co/guide/en/elasticsearch/plugins/current/analysis-icu.html [CITED]
// indices.ts update
export const MULTI_SCRIPT_SETTINGS = {
  analysis: {
    analyzer: {
      multi_script: {
        type: "custom",
        tokenizer: "icu_tokenizer",
        filter: ["lowercase", "icu_folding", "cyrillic_to_latin"]
      }
    },
    filter: {
      cyrillic_to_latin: {
        type: "icu_transform",
        id: "Cyrillic-Latin"
      }
    }
  }
};
```

### Pattern 4: Audit Log Partitioning with 2-Year Retention

**What:** Partition AiAuditLog by month (same pattern as ReadingIndex from Phase 2). Cron job detaches and archives partitions older than 24 months.

**When to use:** PERF-05.

**Example:**
```sql
-- Source: PostgreSQL documentation on native range partitioning [CITED]
-- Migration: partition AiAuditLog by createdAt
CREATE TABLE "AiAuditLog_new" (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "issueType" TEXT NOT NULL,
  severity "Severity" NOT NULL,
  analysis TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Create monthly partitions for 2024-01 through 2028-12
-- Archive cron: DETACH PARTITION older than 24 months, pg_dump, DROP
```

### Anti-Patterns to Avoid

- **Hand-rolling Background Sync replay without auth:** The existing `sw.js` syncPendingTransactions() sends POST without Authorization header. Offline transactions MUST include the stored JWT.
- **Precaching all pages in SW install event:** The current OFFLINE_URLS list tries to cache locale-prefixed pages on install, which fails if those pages require auth. Use Serwist's runtime caching with StaleWhileRevalidate for navigation.
- **Blocking i18n key sync:** Translation files must stay in sync across all 4 locales. A missing key in kaa.json silently falls back to the key string, producing broken UI. Use a build-time script to detect missing keys.
- **Running 50K VUs on a single machine:** k6 needs ~50-250GB RAM for 50K simple VUs. Use distributed k6 via Docker + Kubernetes, or pragmatically test 5K VUs on localhost and extrapolate (document the scaling assumption).
- **Modifying AiAuditLog records after creation:** PERF-05 requires append-only. The existing `resolveAuditLog` method sets `resolved: true` -- this is acceptable (it's a status flag, not content modification), but new requirements must never UPDATE analysis/recommendation/severity fields.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service Worker precaching | Manual OFFLINE_URLS list in install event | @serwist/next build-time manifest injection | Build-hash changes break manual lists; Serwist auto-updates |
| IndexedDB schema | Raw `indexedDB.open()` with manual stores | Dexie.js versioned schema | Dexie handles migrations, typed queries, cursor management |
| Accessibility scanning | Manual WCAG checklist only | axe-core + @lhci/cli | Catches 57% of issues automatically; consistent CI enforcement |
| Load testing | Custom concurrent request script | k6 (Grafana) | VU lifecycle management, percentile reporting, threshold assertions |
| Cyrillic/Latin transliteration | Custom character mapping function | Elasticsearch ICU plugin icu_transform | ICU is Unicode-standard; hand-rolled misses edge cases (combining chars, etc.) |
| PDF audit archive | Custom binary serialization | pg_dump per-partition + gzip | pg_dump is the PostgreSQL standard; guaranteed restore fidelity |

**Key insight:** This phase's 5 domains each have mature ecosystem solutions. The risk is building bespoke versions that miss edge cases (especially SW caching, i18n key sync, and Cyrillic transliteration).

## Common Pitfalls

### Pitfall 1: Service Worker Cache Staleness on Deploy
**What goes wrong:** Users get old cached pages after a new deployment because the SW serves stale precache.
**Why it happens:** Without build-hash-based cache keys, the SW install event caches assets once and never invalidates.
**How to avoid:** Serwist's `__SW_MANIFEST` includes content hashes. Set `skipWaiting: true` + `clientsClaim: true` so new SW takes control immediately.
**Warning signs:** Users report seeing old UI after deploy; clearing browser cache fixes it.

### Pitfall 2: Offline Sync Replay Without Valid Auth Token
**What goes wrong:** Queued transactions fail with 401 when replayed because the stored JWT expired during the offline period.
**Why it happens:** Access tokens have 15-minute expiry. A 12-hour offline session guarantees token expiry.
**How to avoid:** Store the refresh token (from HttpOnly cookie) alongside the queued transaction. On sync, first call `/api/auth/refresh` to get a fresh access token, then replay all queued transactions.
**Warning signs:** Sync attempts return 401; transactions stay in queue indefinitely.

### Pitfall 3: Translation Key Drift Across Locales
**What goes wrong:** New UI features added in Phases 5-6 only have uz-Latn keys. kaa and ru show raw key strings like "school.pq9Report.title".
**Why it happens:** Developers add keys to uz-Latn.json but forget to add to other 3 locale files.
**How to avoid:** Build-time script that diffs all locale files against uz-Latn.json (source of truth). Fail the build if any locale is missing keys.
**Warning signs:** QA sees English-looking key paths in non-default locale UI.

### Pitfall 4: Elasticsearch ICU Plugin Not Installed in Docker
**What goes wrong:** `icu_tokenizer` and `icu_transform` filters fail at index creation time with `unknown tokenizer` error.
**Why it happens:** The ICU analysis plugin is NOT bundled with Elasticsearch by default. It must be installed via `elasticsearch-plugin install analysis-icu`.
**How to avoid:** Add plugin install to Elasticsearch Dockerfile or docker-compose command: `command: sh -c "elasticsearch-plugin install analysis-icu && exec elasticsearch"`.
**Warning signs:** SearchService.ensureIndices() logs "Index yaratishda xato" on startup.

### Pitfall 5: k6 Memory Exhaustion at 50K VUs
**What goes wrong:** k6 process gets OOM-killed trying to simulate 50,000 concurrent users on a single machine.
**Why it happens:** Each VU consumes 1-5MB of RAM. 50K VUs = 50-250GB RAM.
**How to avoid:** Either use k6 Cloud (Grafana) for distributed execution, or test at 5K VUs on a single machine and validate linear scaling. Document the approach.
**Warning signs:** k6 process exits with signal 9 (SIGKILL) mid-test.

### Pitfall 6: AiAuditLog Partition Migration Breaks Prisma
**What goes wrong:** Prisma expects a single `AiAuditLog` table, but partitioning changes the PK to composite `(id, createdAt)`.
**Why it happens:** Same issue solved in Phase 2 for ReadingIndex -- Prisma models a regular table, PG transparently routes.
**How to avoid:** Follow the exact ReadingIndex pattern: raw SQL migration outside Prisma, keep Prisma model unchanged, PG handles partition routing.
**Warning signs:** `prisma migrate dev` generates unexpected diff; Prisma Client throws on `findUnique({ where: { id } })`.

## Code Examples

### Serwist Next.js Configuration
```typescript
// Source: https://serwist.pages.dev/docs/next/getting-started [CITED]
// next.config.js
const withSerwist = require("@serwist/next").default({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});
const withNextIntl = require("next-intl/plugin")("./i18n.ts");

module.exports = withSerwist(withNextIntl({
  reactStrictMode: true,
  output: "standalone",
  // ... existing config
}));
```

### 2G Detection and Lite Mode
```typescript
// Source: Web API navigator.connection [CITED: https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation]
function detect2G(): boolean {
  const conn = (navigator as any).connection;
  if (!conn) return false;
  return conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

// Usage in layout
const isLiteMode = detect2G();
// When isLiteMode: skip <Image /> components, show text-only placeholders
```

### Privacy: Hide Reading History
```typescript
// Backend: users.service.ts
async toggleReadingHistoryVisibility(userId: string, hide: boolean) {
  return this.prisma.user.update({
    where: { id: userId },
    data: { hideReadingHistory: hide },
  });
}

// Filter in public-facing queries (profile, leaderboard detail)
// When user.hideReadingHistory === true, omit transactions/readingIndex from response
```

### k6 Load Test Scenario
```javascript
// Source: https://k6.io/docs/ [CITED]
// tests/k6/load-test.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "2m", target: 1000 },
    { duration: "5m", target: 5000 },
    { duration: "5m", target: 5000 },
    { duration: "2m", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<200"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const res = http.get("http://localhost:3001/api/landing/stats");
  check(res, { "status 200": (r) => r.status === 200 });
  sleep(1);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| next-pwa (Workbox wrapper) | @serwist/next | 2024 | next-pwa is unmaintained; Serwist is the active fork with Next.js 14/15 support |
| workbox-webpack-plugin | serwist | 2024 | Serwist wraps Workbox with better DX and Next.js integration |
| Raw IndexedDB API | Dexie.js v4 | Stable since 2023 | Typed schema, versioned migrations, observable queries |
| Lighthouse CLI manual | @lhci/cli (Lighthouse CI) | 2023+ | CI-integrated with assertions and trend tracking |

**Deprecated/outdated:**
- `next-pwa`: Unmaintained since mid-2023; use @serwist/next instead [ASSUMED]
- Manual `sw.js` precache list: Fragile, no build-hash cache busting

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | @serwist/next is the recommended successor to next-pwa for Next.js 14 | Standard Stack | Would need to find alternative SW integration or stay with hand-written sw.js |
| A2 | Dexie.js v4 is the standard IndexedDB wrapper for offline-first PWAs | Standard Stack | Could use raw IndexedDB (already partially implemented) but lose schema management |
| A3 | ICU analysis plugin for Elasticsearch supports Cyrillic-Latin transformation | Architecture Patterns | Would need custom transliteration middleware before ES indexing |
| A4 | k6 can realistically test 5K VUs on a single developer machine | Common Pitfalls | May need cloud-based load testing; 50K requirement may need scoping discussion |
| A5 | axe-core catches ~57% of WCAG 2.1 issues automatically | Don't Hand-Roll | Manual testing percentage would be higher; automation catches different issues |
| A6 | The existing 4 translation files (368 lines each) cover all current UI strings | Architecture Patterns | If Phase 5/6 added untranslated strings, full i18n audit is needed first |
| A7 | AiAuditLog partitioning can follow the ReadingIndex pattern from Phase 2 | Architecture Patterns | If AiAuditLog has different access patterns (e.g., findUnique by id), PK change may break existing code |

## Open Questions

1. **k6 Load Testing Scale**
   - What we know: 50K VUs requires ~50-250GB RAM, far exceeding a single machine
   - What's unclear: Whether the team has access to k6 Cloud, Kubernetes, or equivalent distributed infrastructure
   - Recommendation: Plan for 5K VU single-machine test with documented scaling extrapolation; flag 50K as aspirational without infrastructure

2. **Elasticsearch ICU Plugin in Production**
   - What we know: Plugin must be installed separately; docker-compose can handle dev
   - What's unclear: Whether the production ES cluster at Unicon.uz/TIF DC already has ICU plugin
   - Recommendation: Plan the migration with a fallback (re-create index with ICU settings; old data re-indexed)

3. **Translation Completeness for Phase 5/6 UI**
   - What we know: All 4 locale files have 368 lines (base set from Phase 1-3)
   - What's unclear: Whether Phase 5/6 execution added new i18n keys to uz-Latn.json without syncing to kaa/ru/uz-Cyrl
   - Recommendation: Run key-diff audit as Wave 0 task before starting I18N-01/02

4. **OWASP ZAP vs Manual Pentest**
   - What we know: PERF-02 requires "penetration testing reveals no P1 critical vulnerabilities"
   - What's unclear: Whether automated ZAP scan is sufficient or external pentest firm is required
   - Recommendation: Plan for automated ZAP baseline + DAST scan; document manual review areas; flag external pentest as out-of-scope for this phase's automated work

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | Yes | v24.14.1 | -- |
| Docker | k6, OWASP ZAP, ES ICU | Yes | 29.4.2 | -- |
| Elasticsearch | I18N-03 | Yes (docker-compose) | 8.x | -- |
| k6 CLI | PERF-01 | No (not installed) | -- | `docker run grafana/k6` |
| Lighthouse CLI | PERF-03 | No | -- | `npx @lhci/cli` or `npm install -D @lhci/cli` |
| OWASP ZAP | PERF-02 | No | -- | `docker run ghcr.io/zaproxy/zaproxy` |
| Kafka | AI-02 | Yes (docker-compose) | -- | Graceful no-op when KAFKA_BROKERS unset |
| OpenAI API key | AI-01 | Env-dependent | -- | NLQ falls back to template-only (no LLM enrichment) |

**Missing dependencies with no fallback:**
- None (all have Docker or npm-based fallbacks)

**Missing dependencies with fallback:**
- k6: Use `docker run grafana/k6 run - < tests/k6/load-test.js`
- Lighthouse: Use `npx @lhci/cli autorun`
- OWASP ZAP: Use `docker run -t ghcr.io/zaproxy/zaproxy zap-baseline.py`

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest 30 (backend) + Jest (frontend) |
| Config file | apps/backend/jest.config.ts |
| Quick run command | `npm test -w apps/backend -- --testPathPattern="<pattern>" --no-coverage` |
| Full suite command | `npm test -w apps/backend` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PWA-01 | Serwist SW precaches pages | smoke | Lighthouse PWA audit via @lhci/cli | No -- Wave 0 |
| PWA-02 | Dexie stores offline catalog | unit | `jest --testPathPattern=offline-db` | No -- Wave 0 |
| PWA-03 | 12h offline cache + sync indicator | integration | Manual test (requires network simulation) | Manual-only |
| PWA-04 | 2G detection triggers lite mode | unit | `jest --testPathPattern=network-status` | No -- Wave 0 |
| PWA-05 | Auth token included in sync replay | unit | `jest --testPathPattern=sync` | No -- Wave 0 |
| PWA-06 | Sync conflict resolution | unit | `jest --testPathPattern=conflict-resolver` | No -- Wave 0 |
| I18N-01 | Karakalpak full translation | unit | Build-time key-diff script | No -- Wave 0 |
| I18N-02 | Russian full translation | unit | Build-time key-diff script | No -- Wave 0 |
| I18N-03 | Multi-script ES analyzer | integration | `jest --testPathPattern=elasticsearch` | Exists (books.service.spec) |
| PERF-01 | 50K concurrent users p95<200ms | load | `docker run grafana/k6 run tests/k6/load-test.js` | No -- Wave 0 |
| PERF-02 | OWASP Top 10 no P1 | security | `docker run zaproxy zap-baseline.py` | No -- Wave 0 |
| PERF-03 | Lighthouse 90+ perf/a11y | smoke | `npx @lhci/cli autorun` | No -- Wave 0 |
| PERF-04 | WCAG 2.1 keyboard/contrast | unit + manual | `jest --testPathPattern=axe-audit` + manual | No -- Wave 0 |
| PERF-05 | Audit log 2yr retention | unit | `jest --testPathPattern=audit-partition` | No -- Wave 0 |
| PERF-06 | Hide reading history | unit | `jest --testPathPattern=privacy` | No -- Wave 0 |
| AI-01 | 20+ NLQ templates | unit | `jest --testPathPattern=nlq.service` | Exists (nlq.service.spec) |
| AI-02 | Kafka real-time audit | unit | `jest --testPathPattern=kafka-audit` | No -- Wave 0 |
| AI-03 | Root cause analysis | unit | `jest --testPathPattern=predict.service` | Exists (predict.service.spec) |
| AI-04 | Book recommendations | unit | `jest --testPathPattern=recommend.service` | Exists (recommend.service.spec) |
| AI-05 | 1-month RI forecast | unit | `jest --testPathPattern=predict.service` | Exists (predict.service.spec) |

### Sampling Rate
- **Per task commit:** `npm test -w apps/backend -- --testPathPattern="<changed-module>" --no-coverage`
- **Per wave merge:** `npm test -w apps/backend`
- **Phase gate:** Full backend suite green + Lighthouse 90+ + k6 thresholds pass before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/frontend/lib/offline/__tests__/db.test.ts` -- covers PWA-02
- [ ] `apps/frontend/lib/offline/__tests__/sync.test.ts` -- covers PWA-05, PWA-06
- [ ] `apps/frontend/lib/offline/__tests__/network-status.test.ts` -- covers PWA-04
- [ ] `tests/k6/load-test.js` -- covers PERF-01
- [ ] `tests/accessibility/axe-audit.ts` -- covers PERF-04
- [ ] `apps/backend/src/modules/ai/__tests__/kafka-audit.consumer.spec.ts` -- covers AI-02
- [ ] `apps/backend/src/modules/users/__tests__/privacy.service.spec.ts` -- covers PERF-06
- [ ] `scripts/i18n-key-check.ts` -- covers I18N-01, I18N-02
- [ ] Serwist + Dexie.js dev dependency install (frontend)
- [ ] k6 Docker pull: `docker pull grafana/k6`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Offline sync must include JWT refresh; no plaintext token storage in IndexedDB |
| V3 Session Management | yes | Refresh token in HttpOnly cookie; offline queue must not expose tokens to JS |
| V4 Access Control | yes | RBAC already enforced; offline replay must pass same guards |
| V5 Input Validation | yes | Zod validation on all API endpoints (existing) |
| V6 Cryptography | no | No new crypto operations in this phase |
| V7 Error Handling | yes | Offline sync errors must not leak stack traces to client |
| V8 Data Protection | yes | PERF-06 hide reading history; PERF-05 audit log immutability |
| V9 Communication | yes | HTTPS-only enforced (existing HSTS header) |

### Known Threat Patterns for PWA + Offline

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Stored JWT in IndexedDB theft | Information Disclosure | Store minimal token; clear on logout; use SW-scoped storage |
| Offline transaction replay attack | Tampering | Server-side idempotency key per transaction (UUID from Dexie) |
| Stale cache serving after revocation | Elevation of Privilege | SW cache TTL 12h (existing); force-clear on auth events |
| XSS via cached API response | Tampering | CSP headers (add to next.config.js); sanitize cached HTML |
| Load test DoS on production | Denial of Service | k6 tests ONLY against staging/dev; never against sifat.uz |

## Sources

### Primary (HIGH confidence)
- Existing codebase: `apps/frontend/public/sw.js`, `apps/backend/src/modules/ai/`, `apps/backend/src/infra/elasticsearch/` -- direct file reads
- Existing i18n: `apps/frontend/messages/*.json`, `apps/frontend/i18n.ts` -- direct file reads
- npm registry: `npm view @serwist/next`, `npm view dexie`, `npm view serwist` -- verified versions

### Secondary (MEDIUM confidence)
- [Serwist docs -- getting started](https://serwist.pages.dev/docs/next/getting-started) -- official documentation
- [Elasticsearch ICU plugin](https://www.elastic.co/guide/en/elasticsearch/plugins/current/analysis-icu.html) -- official Elastic docs
- [k6 docs -- running large tests](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/) -- official Grafana docs
- [Dexie.js sync patterns](https://dexie.org/docs/Syncable/Dexie.Syncable.js) -- official Dexie docs
- [PostgreSQL partitioning for audit](https://appmaster.io/blog/postgresql-partitioning-event-audit-tables) -- community verified

### Tertiary (LOW confidence)
- k6 memory requirements per VU (1-5MB) -- from community blog posts, not official benchmarks
- axe-core 57% WCAG coverage claim -- from Deque marketing materials

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all packages verified on npm, slopcheck passed, well-established libraries
- Architecture: MEDIUM-HIGH - patterns match existing codebase conventions (ReadingIndex partitioning, Kafka no-op, replica routing)
- PWA/Offline: MEDIUM - Serwist is relatively new (~2 years); Dexie is battle-tested
- AI domain: HIGH - all services already implemented; this phase is enhancement/expansion
- Load testing: MEDIUM - 50K VU target may be unrealistic on single machine; Docker fallback works for smaller scale
- Pitfalls: HIGH - documented from direct codebase analysis (sw.js auth gap, ES ICU plugin missing, partition PK pattern)

**Research date:** 2026-06-09
**Valid until:** 2026-07-09 (30 days -- stable domain, mature libraries)
