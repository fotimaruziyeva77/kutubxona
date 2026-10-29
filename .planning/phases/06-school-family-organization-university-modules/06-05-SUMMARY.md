---
phase: 06-school-family-organization-university-modules
plan: 05
wave: 2
status: completed
completed_at: 2026-06-08
commits:
  - "feat(idora)(06-05): employees-by-department + HR tasdiq + ProfBook CRUD (ORG-01/02/07)"
  - "feat(idora)(06-05): BookCorner 90-day cron + Mukofot taklifi self-nomination guard (ORG-04/05)"
  - "feat(idora)(06-05): PQ-9 PDF + subscription gate + frontend dashboard (ORG-06)"
backend_tests: "121 passing across idora.service (64) + idora.controller (10) + mukofot.service (8) + pdf.service (27 incl. 8 new Idora) + alert-dispatch (12)"
backend_tsc: clean (pre-existing @nestjs/elasticsearch shim errors unchanged from Wave 0)
frontend_tsc: clean
requirements_done:
  - ORG-01
  - ORG-02
  - ORG-04
  - ORG-05
  - ORG-06
  - ORG-07
---

# Plan 06-05 SUMMARY — Wave 2 Idora HR Module

Wave 2 delivers the entire PQ-9 §9b idora compliance pipeline:
employees-by-department tree with K-anonymity, HR approve/reject with audit
log, BookCorner 90-day reminder cron (no longer a stub), Mukofot taklifi with
self-nomination guard, PQ-9 PDF with subscription gate, and the idora HR
frontend dashboard.

## T1 — ORG-01/02/07 employees-by-department + HR tasdiq + ProfBook CRUD

**Service** (`apps/backend/src/modules/idora/idora.service.ts`):

- `getEmployees(institutionId, filters, user?)` — scope-asserted via
  `assertInstitutionInScope`; reads via replica when injected.
- `getEmployeesByDepartment(institutionId, opts?, user?)` — groups User rows
  by `User.department`. Buckets with `total < K_ANONYMITY_THRESHOLD (5)`
  render `avgRi: null` + `kAnonymitySuppressed: true`. Cached 5 min.
- `approveEmployee(institutionId, userId, user?)` — flips PENDING → ACTIVE in
  a `$transaction` together with `aiAuditLog.create { issueType:
  'EMPLOYEE_APPROVE' }`. Cross-institution target → 400.
- `rejectEmployee(institutionId, userId, reason, user?)` — reason min 3 chars
  trimmed (Phase 4-03 pattern); flips to BLOCKED + audit log with reason.
- `getInternalRating` / `getInternalRatingHistory` — both READ-ONLY against
  `OrgRating`. Phase 3 InstitutionalService is the sole writer (D-OQ-1).
  History returns last-6-months series for the dynamics chart.
- `addProfBook(institutionId, addedById, dto, user?)` — scope-asserted,
  title 1-200 + author required, ISBN-13 checksum validator. The previously
  unconstrained `removeProfBook(id)` is split:
  - `removeProfBook(institutionId, id, user?)` — scope + ownership check
    (`profBook.institutionId === institutionId`) → 403 on mismatch.
  - `removeProfBookById(id)` — legacy 1-arg helper kept for SUPER_ADMIN-only
    tooling; gated at the controller route.

**Controller** (`apps/backend/src/modules/idora/idora.controller.ts`):

- `@UseGuards(JwtAuthGuard, RolesGuard)` applied to the controller.
- New endpoints (all `@Roles(...)` gated, all `resolveScopedUser` then service):
  - `GET /idora/:id/employees-by-department?departmentId=…`
  - `POST /idora/:id/employees/:userId/approve` (HR-only)
  - `POST /idora/:id/employees/:userId/reject` (HR-only)
  - `GET /idora/:id/rating/history` (last-6-months)
  - `POST /idora/:id/prof-books` + `DELETE /idora/:id/prof-books/:id` (HR-only)
  - `POST /idora/:id/book-corner/verify` (multipart) (HR-only)
  - `POST /idora/:id/mukofot/recommend` (HR-only)
  - `GET /idora/:id/mukofot/recent`
  - `GET /idora/:id/report/pq9` (already existed; now scope + subscription)

## T2 — ORG-04 BookCorner 90-day cron + ORG-05 Mukofot taklifi

**ALERT_TYPES vocabulary** (`apps/backend/src/common/constants/alert-types.const.ts`):

- Added `BOOK_CORNER_REMINDER`. AlertDispatchService MATRIX entry:
  `{channels:['push','email'], recipientRoles:[MUASSASA_ADMIN], severity:OGOH}`.

**bookCornerReminders cron** (`idora.service.ts`):

- `@Cron('0 9 * * *', { name: 'book-corner-reminders', timeZone: 'Asia/Tashkent' })`.
- Leader-locked: `cache.setNx('cron:book-corner-reminders:<YYYY-MM-DD>', '1',
  22h)` — only one replica fans out per day.
- Reads via replica: `bookCorner.findMany({ isActive: true, lastVerified < now-90d })`.
- Subscription gate: skips institutions with FROZEN/DELETED Subscription so
  paying customers are not spammed (T-06-O5 + non-paying skip).
- 30-day dedup: skips when an `AiAuditLog{issueType:'BOOK_CORNER_REMINDER_SENT'}`
  already exists for the same `scopeId` within the last 30 days.
- For each remaining row: writes `AiAuditLog BOOK_CORNER_REMINDER_SENT` first
  (audit record exists even if dispatch fails for retry), then calls
  `AlertDispatchService.dispatch({ issueType: 'BOOK_CORNER_REMINDER', … })`.
- Test asserts: `mockAlertDispatch.dispatch.toHaveBeenCalledTimes(1)` —
  cron is NOT a stub.

**verifyBookCorner** (`idora.service.ts`):

- `POST /idora/:id/book-corner/verify` (multipart, `FileInterceptor`, 5MB cap).
- MIME sniff via dynamic `import('file-type').fileTypeFromBuffer(buffer)`;
  whitelist: jpeg/png/webp. No client `Content-Type` trust.
- Subscription gate enforced.
- Backend-controlled MinIO key `${institutionId}/${cornerId}/${ts}.${ext}`;
  presigned URL TTL 3600s hard-capped by MinioService.
- `$transaction([bookCorner.update, bookCornerVerification.create])`.
  Most recent 4 photo URLs retained on `BookCorner.photoUrls` (sliding window).

**MukofotService** (`apps/backend/src/modules/idora/mukofot/mukofot.service.ts`):

- `recommendMukofot(institutionId, monthlyTopEmployeeUserId, actor, context)`:
  - Scope-asserted via `assertInstitutionInScope`.
  - **T-06-09 self-nomination guard**: `actor.sub === monthlyTopEmployeeUserId
    && !actor.systemActor` → writes `MUKOFOT_SELF_NOMINATION_FLAG` audit row
    (severity MEDIUM) + throws `ForbiddenException`. System cron path bypasses.
  - Writes `AiAuditLog{ issueType: 'MUKOFOT_TAKLIFI', scope: 'INSTITUTION',
    severity: 'LOW' }` with structured JSON `analysis` (recommendedUserId,
    byHrId, month, monthlyRi, systemActor).
  - Enqueues email to all `MUASSASA_ADMIN` of the institution via
    `NOTIFICATION_QUEUE` (`'mukofot-taklifi'` job). Email body templated with
    `escapeHtml` on every DB string (institutionName, userName, month).
- `@Cron('0 4 1 * *', { timeZone: 'Asia/Tashkent' })` monthly scan:
  - Leader-locked (`cron:mukofot-monthly-scan:<YYYY-MM>`, 22h TTL).
  - Reads `OrgRating where isMvp: true AND month = lastMonth` (Phase 3 owns
    writes).
  - Dedups by checking `AiAuditLog MUKOFOT_TAKLIFI` with the same
    institution + `"month":"YYYY-MM"` substring in `analysis`.
  - **T-06-09**: if MVP `userId === firstHRAdmin.id` → writes
    `MUKOFOT_SELF_NOMINATION_FLAG` instead of recommending.

## T3 — ORG-06 PQ-9 PDF + subscription gate + frontend dashboard

**PdfService** (`apps/backend/src/infra/pdf/pdf.service.ts`):

- New `generateIdoraPq9Report(data)` returns HTML; consumer pipes through
  `generateFromHtml(html)`. EVERY DB string escaped via `escapeHtml`:
  institutionName, mvp.userName, mvp.department, profBooks[].title/.author,
  rankingTop10[].userName/.department, mukofotHistory[].analysis.
- Sections: KPI row (employees, this-month reading hours, total, prof books),
  BookCorner status badge + dates, ReadingHours stats, profBooks (top 10),
  MVP block with PQ-9 §9b(d) tag, rankingTop10, mukofotHistory.
- Inline style namespace `.idora-badge.{green,red}` so it does not collide
  with the shared `.badge` rule (which is reused by school PDF).

**IdoraService.composePq9Data + generatePq9Report**:

- `composePq9Data(institutionId)` collects 6 sources in parallel
  (institution, bookCorner, readingHourStats, internal rating, profBooks,
  employee count) plus the last-5 `MUKOFOT_TAKLIFI` audit history for the
  PDF and dashboard inbox.
- `generatePq9Report(institutionId, user?)`:
  - `_assertScope(institutionId, user)` — fail-CLOSED via `assertInstitutionInScope`.
  - `_assertSubscriptionActive(institutionId, user)` — looks up the linked
    library Subscription; throws `ForbiddenException("Idora obunasi
    muzlatilgan/o'chirilgan — to'lov amalga oshiring")` if status is not
    ACTIVE/TRIAL. `SUPER_ADMIN` bypass.
  - Returns the puppeteer-rendered PDF Buffer.

**Frontend** (`apps/frontend/app/[locale]/dashboard/idora/page.tsx`):

- Extended the existing client page with two new tabs:
  - **Bo'lim bo'yicha (employees-by-department)** — collapsible tree per
    department, K-anonymity hint when bucket < 5, inline Tasdiqlash/Rad etish
    buttons on PENDING rows. Rad etish opens a modal with a reason textarea
    (min 3 chars required client-side, matches server).
  - **Mukofot taklifi inbox** — lists recent `MUKOFOT_TAKLIFI` audit rows
    with a non-action notice that mukofot is executed outside the platform
    (D-Q6).
- `BookCornerForm` extended with a `BookCornerVerifyUpload` component:
  file input (image-only `accept`, 5 MB client cap), POSTs `multipart/form-data`
  to `/idora/:id/book-corner/verify`. Surfaces server errors (MIME, size,
  subscription, scope) inline.
- PQ-9 download button surfaces the 403 subscription message via `alert(…)`.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/src/common/constants/alert-types.const.ts` | `BOOK_CORNER_REMINDER` added |
| `apps/backend/src/modules/ai/alert-dispatch.service.ts` | MATRIX entry for `BOOK_CORNER_REMINDER` |
| `apps/backend/src/modules/idora/idora.service.ts` | Rewritten — scope guard + employees-by-department + approve/reject + ProfBook ownership + ISBN-13 validator + BookCorner verify (MinIO) + cron with leader lock / dedup / subscription filter + composePq9Data + subscription gate |
| `apps/backend/src/modules/idora/idora.controller.ts` | Rewritten — `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)` per endpoint + resolveScopedUser pattern + new endpoints |
| `apps/backend/src/modules/idora/idora.module.ts` | Added `MinioModule`, `AiModule`, `NOTIFICATION_QUEUE`, MukofotService provider |
| `apps/backend/src/modules/idora/mukofot/mukofot.service.ts` | NEW — recommendMukofot with self-nomination guard + monthly cron with leader lock + email enqueue |
| `apps/backend/src/modules/idora/mukofot/__tests__/mukofot.service.spec.ts` | NEW — 8 specs |
| `apps/backend/src/modules/idora/__tests__/idora.service.spec.ts` | Extended — 64 specs (incl. K-anon, scope, approve/reject, ProfBook ownership, ISBN, BookCorner cron dispatch/leader/dedup/subscription, PQ-9 subscription gate) |
| `apps/backend/src/modules/idora/__tests__/idora.controller.spec.ts` | NEW — 10 specs |
| `apps/backend/src/infra/pdf/pdf.service.ts` | Added `generateIdoraPq9Report` |
| `apps/backend/src/infra/pdf/__tests__/pdf.service.spec.ts` | +8 Idora PDF specs (XSS regression + section render) |
| `apps/frontend/app/[locale]/dashboard/idora/page.tsx` | Two new tabs + BookCornerVerifyUpload + 403 subscription handling |

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| R-DUP regression | `prisma\.orgRating\.(create|upsert|createMany|deleteMany)` | `idora.service.ts` | 0 | OK |
| Scope guard usage | `assertInstitutionInScope` | `idora.service.ts` | 3 | OK (≥ 2) |
| PDF generator | `generateIdoraPq9Report` | `pdf.service.ts` | 1 | OK (≥ 1) |
| Self-nomination guard | `monthlyTopEmployeeUserId\|MUKOFOT_SELF_NOMINATION` | `mukofot.service.ts` | 10 | OK (≥ 1) |
| Subscription gate | `subscription.*status\|sub\.status` | `idora.{service,controller}.ts` | 3 | OK (≥ 1) |
| Leader lock | `setNx.*lock\|setNx.*book-corner\|setNx.*mukofot` | `idora/` | 2 | OK (BookCorner + Mukofot) |
| BOOK_CORNER_REMINDER alert | `BOOK_CORNER_REMINDER` | `alert-dispatch + idora.service` | 5 | OK (≥ 2) |

## AiAuditLog issueTypes emitted

- `EMPLOYEE_APPROVE` — HR approve flow (severity LOW)
- `EMPLOYEE_REJECT` — HR reject flow with `analysis: "HR admin rejected: <reason>"`
- `BOOK_CORNER_REMINDER_SENT` — cron pre-dispatch audit + dedup window (OGOH)
- `MUKOFOT_TAKLIFI` — recommendMukofot + scanForNewMvp (LOW)
- `MUKOFOT_SELF_NOMINATION_FLAG` — T-06-09 violation (MEDIUM)

## AlertDispatchService.dispatch call counts in cron-test run

The bookCornerReminders specs assert:

- 0 calls when no overdue rows
- 0 calls when leader lock is held
- 1 call when 1 overdue row is found (NOT a stub regression)
- 0 calls when institution has FROZEN subscription
- 0 calls when dedup window holds
- audit log written **before** dispatch attempt (retry-friendly)

## Test counts

- `idora.service.spec.ts`: **64 passing** (was 31 pre-Wave 2)
- `idora.controller.spec.ts`: **10 passing** (NEW)
- `mukofot.service.spec.ts`: **8 passing** (NEW)
- `pdf.service.spec.ts`: **27 passing** (+8 Idora specs)
- `alert-dispatch.service.spec.ts`: **12 passing** (unchanged + MATRIX entry compatible)
- Wave 2 delta: **+59 new specs**

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-09 (Mukofot self-nomination) | `actor.sub === monthlyTopEmployeeUserId` guard + cron-side `mvp.userId === HR admin.id` flag; never executed silently |
| T-06-O1 (cross-institution employee leak) | `assertInstitutionInScope` runs BEFORE `cache.remember` and BEFORE any read |
| T-06-O2 (K-anonymity in small departments) | `K_ANONYMITY_THRESHOLD = 5`; suppressed buckets render `null + kAnonymitySuppressed:true` |
| T-06-O3 (ProfBook XSS in PDF) | Every DB string through `escapeHtml` in `generateIdoraPq9Report` + regression specs |
| T-06-O5 (cron spam) | 30-day dedup via `BOOK_CORNER_REMINDER_SENT` audit + Redis SETNX leader lock |
| T-06-O6 (subscription bypass) | `_assertSubscriptionActive` runs before puppeteer + before MinIO upload |
| Scope-leak on cache key | Scope-assert BEFORE `cache.remember` (matches Plan 05-05 FIX A pattern) |
| MIME spoofing on book corner upload | `file-type.fileTypeFromBuffer` sniff with image-only whitelist; client `Content-Type` ignored |

## Decisions applied

- **D-OQ-1**: Phase 3 InstitutionalService is sole writer of OrgRating (verified
  via R-DUP grep gate: 0 writes from idora service).
- **D-Q5**: PQ-9 PDF admin-only; subscription gate on download.
- **D-Q6**: Mukofot is AiAuditLog + HR email; admin executes manually; no
  auto-disbursement.

## Follow-ups deferred

- **ORG-03** (Reading Hour event + QR attendance + media upload) → Plan 06-06.
- **Frontend monthly dynamics chart** for the internal-rating-history endpoint
  (Recharts wiring) → Plan 06-07 or polish wave.
- **Two-stage subscription badge** on the PQ-9 button (currently surfaces 403
  via `alert`; could be a tooltip when subscription is FROZEN) → polish wave.
