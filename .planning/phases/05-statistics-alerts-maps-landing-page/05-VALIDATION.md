---
phase: 5
slug: statistics-alerts-maps-landing-page
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-07
updated: 2026-06-07
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 + ts-jest (apps/backend/jest.config.ts) + Jest 30 jsdom (apps/frontend/jest.config.js) |
| **Config file** | apps/backend/jest.config.ts, apps/frontend/jest.config.js |
| **Quick run command (backend)** | `cd apps/backend && npx jest <path> --bail --forceExit --silent` |
| **Quick run command (frontend)** | `cd apps/frontend && npx jest <path> --bail --forceExit --silent` |
| **Full suite command** | `cd apps/backend && npm test && cd ../frontend && npm test` |
| **Estimated runtime** | ~120 seconds (Phase 4 baseline 867; Phase 5 target ≥ 927: +60 tests across 9 plans) |
| **Coverage gate** | 80% lines |
| **Notable** | Phase 5 extends existing specs in-place (admin/audit/notification.processor); 4 NEW spec files for new modules (alert-dispatch / report-data / report-email / landing); 4 NEW jsdom specs for frontend components (ViloyatMap / LiveStatsRefresher / useStatsSocket / map-color). Puppeteer monthly PDF tested via fixture HTML snapshot in pdf.service.spec. |

---

## Sampling Rate

- **After every task commit:** `cd apps/backend && npx jest <touched-spec> --bail --forceExit --silent` (typical <10s for a single spec file)
- **After every plan wave:** `cd apps/backend && npm test && cd ../frontend && npm test`
- **Before `/gsd-verify-work`:** Full suite green + manual landing live counter check + map render smoke + alert detection dry-run
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01.T1 | 05-01 | 1 | NOTIF-02/03, MAP-03 | T-05-SC | Slopcheck human-verify gate on firebase-admin/nodemailer/firebase/mapshaper | checkpoint:human-verify | (human verifies npm view + npmjs.com) | n/a | ⬜ pending |
| 05-01.T2 | 05-01 | 1 | NOTIF-02/03 | T-05-06, T-05-07, T-05-FCM-ENV, T-05-SMTP-ENV | FcmClient + MailClient dev no-op + prod fail-hard + escapeEmailHeader | unit | `cd apps/backend && npx jest --testPathPattern='fcm.client.spec\|mail.client.spec\|main.spec' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-01.T3 | 05-01 | 1 | ALERT-01..06, STAT-03 | T-05-MIG | DeviceToken migration + ALERT_TYPES + CacheService/KAFKA_TOPICS extensions | unit | `cd apps/backend && npx jest --testPathPattern='alert-types\|cache.service\|kafka.service' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-01.T4 | 05-01 | 1 | MAP-03 | T-05-GEOJSON | GeoJSON viloyat file <100KB; 14 features with code/name | unit (fs) | `cd apps/frontend && npx jest --testPathPattern='geojson.spec' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-02.T1 | 05-02 | 2 | STAT-01 | T-05-01, T-05-01b, T-05-02, T-05-RAW-SQL | PrismaReplicaService routing + assertViloyat/TumanInScope + per-viloyat RI GROUP BY | unit | `cd apps/backend && npx jest --testPathPattern='admin-scope\|admin.service.spec\|admin.service.scope-guard\|admin.controller.spec' --bail --forceExit --silent && npm run lint:replica` | ❌ extend existing | ⬜ pending |
| 05-02.T2 | 05-02 | 2 | STAT-01, STAT-03 | T-05-CRON, T-05-MAHALLA | STATS_AGGREGATION_QUEUE + pre-agg crons + 30min mahalla cache | unit | `cd apps/backend && npx jest --testPathPattern='admin.service.preaggregation\|stats-aggregation.processor' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-02.T3 | 05-02 | 2 | STAT-02 | n/a | Dashboard SSR prefetch eliminates `—`; simulated RI line deleted | build + grep | `cd apps/frontend && npm run build --silent 2>&1 \| tail -10 && grep -c "Math.round(42 +" apps/frontend/app/\[locale\]/dashboard/stats/page.tsx \| grep -q '^0$'` | ❌ build smoke | ⬜ pending |
| 05-03.T1 | 05-03 | 2 | STAT-04, STAT-05, STAT-06 | T-05-SCOPE-STATS, T-05-RAW-SQL, T-05-AGE-TZ | getAgeGroup util promoted; scope-aware gender/age/genre-trend services | unit | `cd apps/backend && npx jest --testPathPattern='age-group\|admin.service.expansion\|top.service.spec' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-03.T2 | 05-03 | 2 | STAT-07 | T-05-01c, T-05-DTO, T-05-DEDUPE | markBookForOrder + DTO + 4 endpoints + KUTUBXONACHI scope | unit | `cd apps/backend && npx jest --testPathPattern='admin.service\|admin.controller' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-03.T3 | 05-03 | 2 | STAT-04..07 | n/a | Frontend chart wiring + ShortageTab "Buyurtma" button | build smoke | `cd apps/frontend && npm run build --silent 2>&1 \| tail -10` | ❌ build smoke | ⬜ pending |
| 05-04.T1 | 05-04 | 2 | NOTIF-02 | T-05-06, T-05-INVALID-TOK, T-05-TOK-FLOOD | sendPush → FcmClient + InvalidFcmTokenError cleanup loop | unit | `cd apps/backend && npx jest --testPathPattern='notification.processor' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-04.T2 | 05-04 | 2 | NOTIF-03 | T-05-07, T-05-EMAIL-HDR | sendEmail → MailClient + escapeHtml default body | unit | `cd apps/backend && npx jest --testPathPattern='escape-html\|notification.processor\|pdf.service' --bail --forceExit --silent` | ❌ new util spec | ⬜ pending |
| 05-04.T3 | 05-04 | 2 | NOTIF-02 | T-05-FCM-TRANSFER, T-05-FCM-DELETE, T-05-TEST-PUSH | FCM endpoints + cross-user transfer audit + 404-hides | unit | `cd apps/backend && npx jest --testPathPattern='users.controller\|users.service\|admin.controller' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-04.T4 | 05-04 | 2 | NOTIF-02 | n/a | Frontend FCM client + dashboard registrar (silent on already-granted) | build smoke | `cd apps/frontend && npm run build --silent 2>&1 \| tail -5` | ❌ build smoke | ⬜ pending |
| 05-05.T1 | 05-05 | 3 | ALERT-01, ALERT-03, ALERT-04 | T-05-S1, T-05-VOCAB | _buildTumanRiMap S1 fix + _checkInactiveTumans + threshold fixes + ALERT_TYPES vocabulary | unit | `cd apps/backend && npx jest --testPathPattern='audit.service.alert-consolidation\|audit.service.spec' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-05.T2 | 05-05 | 3 | ALERT-05 | T-05-03, T-05-DISP-FAIL, T-05-ADMIN-FB | _checkTumanRiRises weekly + AlertDispatchService + recipient-aware dedup | unit | `cd apps/backend && npx jest --testPathPattern='audit.service\|alert-dispatch' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-05.T3 | 05-05 | 3 | ALERT-06 | T-05-04, T-05-WATCHDOG | admin.checkSmartAlerts deleted; POST /admin/system-down-test + frontend filter rewire | unit + build | `cd apps/backend && npx jest --testPathPattern='admin.service\|admin.controller' --bail --forceExit --silent && cd ../frontend && npm run build --silent 2>&1 \| tail -5` | ❌ extend existing | ⬜ pending |
| 05-06.T1 | 05-06 | 3 | MAP-01 | n/a | riColor + riLabel util with boundary cases | unit | `cd apps/frontend && npx jest --testPathPattern='map-color' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-06.T2 | 05-06 | 3 | MAP-01, MAP-03 | T-05-05, T-05-MAP-XSS, T-05-MAP-DDOS | L.geoJSON choropleth replaces circleMarker; tooltip + click + hover | unit (jsdom mock leaflet) | `cd apps/frontend && npx jest --testPathPattern='ViloyatMap' --bail --forceExit --silent && (grep -c "circleMarker" apps/frontend/components/map/ViloyatMap.tsx \| grep -q '^0$')` | ❌ new spec | ⬜ pending |
| 05-06.T3 | 05-06 | 3 | MAP-02 | n/a | stats/page.tsx wiring; real per-viloyat RI; click → detail | build smoke | `cd apps/frontend && npm run build --silent 2>&1 \| tail -10 \| grep -q "Compiled successfully"` | ❌ build smoke | ⬜ pending |
| 05-07.T1 | 05-07 | 3 | STAT-01, STAT-02, ALERT-01, ALERT-02 | T-05-WS-ROOM-INJ, T-05-WS-LEAK | emitStatsRefresh + emitTumanAlerted + STATS_ROOM_KEYS + processor emit | unit | `cd apps/backend && npx jest --testPathPattern='stats.gateway\|stats-aggregation' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-07.T2 | 05-07 | 3 | ALERT-05, ALERT-06 | T-05-KAFKA-MSG | KafkaConsumer routes RI_RISING + SYSTEM_DOWN + ALERT_FIRED | unit | `cd apps/backend && npx jest --testPathPattern='kafka-consumer' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-07.T3 | 05-07 | 3 | STAT-01, STAT-02 | n/a | useStatsSocket hook + dashboard live merge | unit (jsdom + fake timers) | `cd apps/frontend && npx jest --testPathPattern='useStatsSocket' --bail --forceExit --silent && npm run build --silent 2>&1 \| tail -5` | ❌ new spec | ⬜ pending |
| 05-08.T1 | 05-08 | 4 | RPT-01 | T-05-10, T-05-RPT-SCOPE | ReportDataService + PdfService scope param + escapeHtml | unit | `cd apps/backend && npx jest --testPathPattern='report-data.service\|pdf.service' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-08.T2 | 05-08 | 4 | RPT-01, RPT-02 | T-05-OOM, T-05-EMAIL-INJ, T-05-CRON-DUP, T-05-RECIP-NULL, T-05-ATTACH-LEAK | ReportEmailProcessor + monthly cron + parameterized download + ADMIN_NOTIFICATION_EMAILS fallback | unit | `cd apps/backend && npx jest --testPathPattern='report-email\|admin.service\|admin.controller' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-09.T1 | 05-09 | 4 | LAND-01 | T-05-08, T-05-LIVE-DDOS | GET /landing/stats sanitized + 30s cache + defensive fallback | unit | `cd apps/backend && npx jest --testPathPattern='landing' --bail --forceExit --silent` | ❌ new spec | ⬜ pending |
| 05-09.T2 | 05-09 | 4 | LAND-02 | T-05-09, T-05-EMAIL-INJ-B2B, T-05-CRM-FALLBACK | demo-request email side-effect + rate limit incrWithTtl + escapeHtml | unit | `cd apps/backend && npx jest --testPathPattern='admin.service\|admin.controller\|cache.service' --bail --forceExit --silent` | ❌ extend existing | ⬜ pending |
| 05-09.T3 | 05-09 | 4 | LAND-01, LAND-03, LAND-02 | T-05-HYDRATION, T-05-JSONLD-XSS | LiveStatsRefresher + JsonLdStructuredData + Twitter Card + demo-request 429 toast | unit (jsdom + fake timers) | `cd apps/frontend && npx jest --testPathPattern='LiveStatsRefresher' --bail --forceExit --silent && npm run build --silent 2>&1 \| tail -5` | ❌ new spec | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Plan 05-01 ships the Wave 0 prerequisites:

- [ ] firebase-admin + nodemailer + firebase + mapshaper slopcheck human-verify (T1)
- [ ] FcmClient + MailClient infra scaffolds with dev no-op + prod fail-hard (T2)
- [ ] DeviceToken Prisma model + migration (T3)
- [ ] ALERT_TYPES const module — single source of truth for issueType vocabulary (T3)
- [ ] CacheService key extensions: mahallaStats / genreTrend / ageBreakdown / genderBreakdown / landingPublic / alertDedupe (T3)
- [ ] CacheService TTL extensions: stats5min / stats15min / stats30min / landingPublic (T3)
- [ ] KAFKA_TOPICS extensions: RI_RISING / SYSTEM_DOWN / ALERT_FIRED (T3)
- [ ] scripts/build-geojson.sh + simplified uzbekistan-viloyats.geojson (<100KB gzip) (T4)
- [ ] .env.example documents FCM_*, NEXT_PUBLIC_FIREBASE_*, SMTP_*, ADMIN_NOTIFICATION_EMAILS, ADMIN_SMS_RECIPIENTS (T2, T3-tbd)
- [ ] escape-html.util consolidated as single source of truth (Plan 05-04 T2)

---

## Manual-Only Verifications

> Captured as VERIFICATION.md checkboxes at phase close.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Dashboard real-time WebSocket update | STAT-01/02 | Multi-tab live test | Open dashboard in tab A; trigger pre-agg cron in tab B (or wait 5min); verify A receives update within 5s without refresh |
| Map choropleth visual correctness | MAP-01/02 | Visual + interaction check | Open /dashboard/stats map view; confirm 14 viloyats colored green/yellow/red; click → detail panel opens with real per-viloyat RI |
| FCM push delivery | NOTIF-02 | Requires real Firebase credentials | Set FCM_SERVICE_ACCOUNT_KEY_PATH env; POST /admin/test-push; confirm push lands on a registered device |
| Email delivery | NOTIF-03 | Requires real SMTP credentials | Set SMTP_HOST/PORT/USER/PASS env; trigger payment reminder or demo-request; confirm email lands in inbox |
| Smart alert end-to-end | ALERT-01..06 | Multi-day data + cron firing | Seed inactive tuman fixture (0 active 2 weeks); force-trigger audit.runAuditCycle; verify push + email to TUMAN_ADMIN + VILOYAT_ADMIN |
| Monthly PDF report visual | RPT-01/02 | Visual check | Force-trigger monthly cron at 1st-day; open generated PDF; verify charts, stats, signature block, scope-correctness |
| Landing page live counter | LAND-01 | Visual + UX check | Visit `/`; observe counter; wait 30s; verify number updates (or stays current depending on data) |
| B2B demo request CRM | LAND-02 | Multi-step UX | Submit demo request form; confirm DB row + admin email + dashboard appearance |
| Demo-request rate limit | LAND-02 | UX check | Submit 4 requests from same phone within an hour; verify 4th returns 429 toast |
| Social sharing meta render | LAND-03 | External tool check | Visit `/` then check OpenGraph debugger (developers.facebook.com/tools/debug/) and Twitter Card Validator; confirm correct image + title + description |
| ALERT-06 SYSTEM_DOWN external watchdog | ALERT-06 | DevOps setup | Operator configures UptimeRobot/BetterStack hitting /health endpoint; confirm SMS arrives when service stops (post-deploy) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (10 items above)
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready for planner sign-off (commit + handoff to execute-phase)
