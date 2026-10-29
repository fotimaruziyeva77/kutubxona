---
phase: 05-statistics-alerts-maps-landing-page
plan: 08
type: summary
wave: 7
requirements:
  - RPT-01
  - RPT-02
  - NOTIF-03
files_modified:
  - apps/backend/src/modules/admin/report-data.service.ts (new)
  - apps/backend/src/modules/admin/__tests__/report-data.service.spec.ts (new)
  - apps/backend/src/modules/admin/report-email.processor.ts (new)
  - apps/backend/src/modules/admin/__tests__/report-email.processor.spec.ts (new)
  - apps/backend/src/modules/admin/__tests__/admin.service.monthly-reports.spec.ts (new)
  - apps/backend/src/modules/admin/admin.service.ts (REPORT_QUEUE injection + generateMonthlyReports cron + recipient resolver)
  - apps/backend/src/modules/admin/admin.controller.ts (parameterized GET /admin/reports/monthly)
  - apps/backend/src/modules/admin/admin.module.ts (register REPORT_QUEUE + new providers)
  - apps/backend/src/infra/pdf/pdf.service.ts (scope-parameterized buildMonthlyReportHtml + generateMonthlyReport + SVG bar chart)
  - apps/backend/src/infra/pdf/__tests__/pdf.service.spec.ts (new)
  - apps/backend/src/infra/queue/queue.module.ts (REPORT_QUEUE defaultJobOptions: attempts 3 + 30s exponential backoff)
---

# Plan 05-08 — Monthly PDF Reports (RPT-01 + RPT-02 + NOTIF-03 carry-over)

## Goal

Close RPT-01 (scope-parameterized PDF) and RPT-02 (auto-monthly + emailed) by
introducing one new service (`ReportDataService`), one new processor
(`ReportEmailProcessor`), one new cron (`AdminService.generateMonthlyReports`),
and parameterizing the existing `GET /admin/reports/monthly` endpoint. Reuses
the Plan 05-04 NOTIFICATION_QUEUE email path so PDF attachments flow through
`MailClient` with `escapeHtml` end-to-end (NOTIF-03 carry-over).

## What was built

### Task 1 — ReportDataService + PdfService scope parameterization

* **`apps/backend/src/modules/admin/report-data.service.ts`** — new
  `ReportDataService.gatherForScope(scope, scopeId, periodStart, periodEnd)`
  returns the unified `ReportData` shape consumed by `PdfService`. Internally
  composes:
  - `AdminService.getNationalStats() | getViloyatStats(id) | getTumanStats(id)`
  - `AdminService.getGenderBreakdown(scope, scopeId)`
  - `AdminService.getAgeBreakdown(scope, scopeId)`
  - `$queryRaw` for top-5 libraries (by transaction count in period) and
    top-5 readers (by Reading Index) — all routed through `PrismaReplicaService`.
  - K-anonymity (`K_ANONYMITY_THRESHOLD = 5`) re-applied to ALL bucket counts
    as defense-in-depth on top of `AdminService.getGenderBreakdown / getAgeBreakdown`.
  - `maskNameIfMinor` (Phase 3 util) on every top-reader name — Plan 05-08 §TOP-06
    carry-over for forwarded PDF attachments.

* **`apps/backend/src/infra/pdf/pdf.service.ts`** — `buildMonthlyReportHtml`
  now accepts the extended `ReportData` shape + scope/scopeId AND keeps the
  legacy signature (backward compat for Plan 04-03 Buxgalter usage).
  - Every DB-sourced string (title, scopeLabel, library/reader names, bucket
    labels, table labels) passes through `escapeHtml` (Plan 05-04 single source
    of truth) — T-05-10 PDF injection mitigation.
  - New `_renderBarChartSvg` helper inlines an SVG bar chart for gender + age
    bucket visualisation. Zero new npm deps — picks SVG per Plan 05-08 D-6
    "single template, no Chart.js dep".
  - New `generateMonthlyReport(data, scope, scopeId?)` convenience wrapper
    composes `buildMonthlyReportHtml` + `generateFromHtml` to return a Buffer.
  - Non-production builds get a `· DEV PREVIEW` watermark suffix.

### Task 2 — REPORT_QUEUE + ReportEmailProcessor + monthly cron + parameterized download

* **`apps/backend/src/infra/queue/queue.module.ts`** — REPORT_QUEUE
  `defaultJobOptions` upgraded to `{ attempts: 3, backoff: { type: "exponential",
  delay: 30000 }, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } }`
  per Plan 05-08 PITFALLS M6.

* **`apps/backend/src/modules/admin/report-email.processor.ts`** — new
  `@Processor(REPORT_QUEUE, { concurrency: 2 })` (per PITFALLS M6 to keep 215
  simultaneous Puppeteer renders from OOM-ing the node). Each job:
  1. `ReportDataService.gatherForScope(scope, scopeId, periodStart, periodEnd)`
  2. `PdfService.generateMonthlyReport(data, scope, scopeId)` → Buffer (rendered ONCE per scope, NOT per recipient).
  3. For each recipient: enqueues NOTIFICATION_QUEUE `email` job with
     `attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }]`.
     Deterministic per-recipient jobId
     `monthly-report-email:<scope>:<scopeId>:<YYYY-MM>:<email>` so retries
     don't double-email anyone.
  - Subject `[SIFAT LIBRARY] <Scope> oylik hisobot — YYYY-MM` (server-computed
    period; no DB input enters the subject — T-05-EMAIL-INJ mitigation).
  - HTML body is templated text (no user input) — defense-in-depth.

* **`apps/backend/src/modules/admin/admin.service.ts`** —
  - Added `@InjectQueue(REPORT_QUEUE) reportQueue?` Optional constructor param.
  - New `@Cron('0 5 1 * *', { name: 'monthly-reports', timeZone: 'Asia/Tashkent' })`
    `generateMonthlyReports()` method:
    * Computes `periodStart = first day of LAST month`, `periodEnd = first day of THIS month`.
    * SETNX leader lock `cron:monthly-reports:<YYYY-MM>` with 2h TTL prevents
      double-enqueue on concurrent replicas.
    * Reads all viloyats + tumans via replica.
    * Resolves recipients per scope via `_resolveRecipients` (DB lookup of
      `VILOYAT_ADMIN` / `TUMAN_ADMIN` users in scope → falls through to
      `ADMIN_NOTIFICATION_EMAILS` env CSV per Plan 05-08 Q7 because the current
      User schema has no `email` column).
    * `reportQueue.addBulk(jobs)` with deterministic jobId
      `monthly-report:<scope>:<scopeId ?? UZ>:<YYYY-MM>` for multi-replica dedupe.
    * Enqueues exactly 1 national + N viloyat + M tuman jobs.
  - New `_resolveRecipients(role, scope, scopeId, adminFallback)` private helper
    — falls back gracefully when the User schema lacks `email` (current state)
    or when the role-tier lookup returns zero rows with an email.
  - New `_adminFallbackRecipients()` private helper parses
    `ADMIN_NOTIFICATION_EMAILS` env CSV.

* **`apps/backend/src/modules/admin/admin.controller.ts`** —
  `GET /admin/reports/monthly` parameterized:
  - `?scope=national` → SUPER_ADMIN + BUXGALTER only.
  - `?scope=viloyat&scopeId=...` → adds VILOYAT_ADMIN with `assertViloyatInScope`.
  - `?scope=tuman&scopeId=...` → adds TUMAN_ADMIN with pre-resolved
    `Tuman.viloyatId` for the `assertTumanInScope` VILOYAT_ADMIN cross-check.
  - Synchronous PDF stream via `ReportDataService.gatherForScope` →
    `PdfService.generateMonthlyReport`.
  - 400 on missing scopeId for non-national; 403 on scope mismatch; 503 if
    `ReportDataService` is not wired (older DI signatures).

* **`apps/backend/src/modules/admin/admin.module.ts`** — registers
  `BullModule.registerQueue({ name: REPORT_QUEUE })` so AdminService can
  `@InjectQueue` it; adds `ReportDataService` + `ReportEmailProcessor` as
  providers and exports `ReportDataService`.

## Decision log

* **D-6 (single template)** — extended the existing
  `PdfService.buildMonthlyReportHtml` rather than adding a separate
  `report-pdf.template.ts` file. Both shapes (legacy + extended `ReportData`)
  share the same internals (`_reportStyles`, `escapeHtml`), avoiding a
  templating engine and keeping the diff minimal.
* **D-Q7 (ADMIN_NOTIFICATION_EMAILS fallback)** — current `User` schema has no
  `email` column; the recipient resolver always falls through to the env CSV.
  `_resolveRecipients` is written to auto-detect a future migration that adds
  `User.email` without code changes.
* **PITFALLS M6 (concurrency 2)** — REPORT_QUEUE worker concurrency capped at
  2 even though 215 jobs land per month. BullMQ throttles naturally; 30s
  exponential backoff covers transient SMTP / Puppeteer flakes.

## Tests

* `report-data.service.spec.ts` — 8 cases covering scope resolution, k-anonymity
  carry-over for both gender + age buckets, `maskNameIfMinor` on top readers,
  title composition, and fallback when DB row is missing.
* `report-email.processor.spec.ts` — 4 cases covering the gather → render →
  fan-out pipeline, empty recipients short-circuit, scope-specific subject +
  filename, and deterministic per-recipient jobId.
* `pdf.service.spec.ts` (new) — 10 cases covering legacy shape backward
  compat, extended shape rendering, escapeHtml regressions on library/reader
  names and scopeLabel/title (T-05-10), `—` rendering for suppressed buckets,
  SVG chart presence, scopeId in badge, and DEV PREVIEW watermark switch.
* `admin.service.monthly-reports.spec.ts` — 4 cases covering 215-jobs
  addBulk shape + deterministic jobId, SETNX leader lock multi-replica
  dedupe, no-op when reportQueue not wired, and `ADMIN_NOTIFICATION_EMAILS`
  fallback.

Total: ~26 new tests across 4 spec files.

## Trust boundaries

| Boundary | Mitigation |
|---|---|
| DB strings → PDF template | `escapeHtml` on every interpolation in `buildMonthlyReportHtml` (T-05-10) |
| Cron → REPORT_QUEUE | Deterministic jobId + SETNX leader lock (T-05-CRON-DUP) |
| REPORT_QUEUE → NOTIFICATION_QUEUE | Per-recipient jobId so retries don't double-email |
| Tier admin scope on /admin/reports/monthly | `assertViloyatInScope` / `assertTumanInScope` before render (T-05-RPT-SCOPE) |
| Puppeteer fan-out | Worker concurrency 2 (T-05-OOM) |
| PDF attachment in queue | `removeOnComplete: 50` purges old jobs (T-05-ATTACH-LEAK) |
| Email subject injection | Server-computed period string; no DB input (T-05-EMAIL-INJ) |

## Success criteria

- [x] ReportDataService.gatherForScope returns scope-parameterized data shape
- [x] PdfService.buildMonthlyReportHtml escapes DB strings; SVG charts inlined
- [x] ReportEmailProcessor consumes REPORT_QUEUE with concurrency 2
- [x] generateMonthlyReports cron at `0 5 1 * *` Asia/Tashkent
- [x] Deterministic jobId `monthly-report:<scope>:<scopeId>:<YYYY-MM>`
- [x] Parameterized GET /admin/reports/monthly with scope assert
- [x] ADMIN_NOTIFICATION_EMAILS env CSV fallback honored
- [x] REPORT_QUEUE defaultJobOptions: attempts 3 + 30s exponential backoff
- [x] mail.client.ts accepts attachments param (verified — Plan 05-04 already wired)
- [x] Backend tsc clean
