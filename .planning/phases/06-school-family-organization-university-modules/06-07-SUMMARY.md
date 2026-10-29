---
phase: 06-school-family-organization-university-modules
plan: 07
wave: 3
status: completed
completed_at: 2026-06-08
commits:
  - "feat(otm)(06-07): faculty grouping + K-anon + student-by-faculty + integration test (UNI-01/02)"
  - "feat(otm)(06-07): akkreditatsiya PDF per-faculty + checklist + subscription gate (UNI-03)"
  - "feat(otm)(06-07): student progress (admin/student-self) + frontend dashboards (UNI-04)"
backend_tests: "91 passing across otm.service (44) + otm.integration (3) + student-progress (12) + pdf.service (35 incl. 9 new UNI-03 Akkreditatsiya)"
backend_tsc: clean (pre-existing @nestjs/elasticsearch shim errors unchanged from Wave 0; no Phase 6 regressions)
frontend_tsc: clean
requirements_done:
  - UNI-01
  - UNI-02
  - UNI-03
  - UNI-04
---

# Plan 06-07 SUMMARY — Wave 3 OTM module (UNI-01..04)

Wave 3 closes the OTM track for Phase 6. Plan 06-01 already shipped the P1
bug fixes (Wave 0). This plan extends from those foundations with three
deliverables:

1. **UNI-01/02 follow-through** — drops the `schoolClass` backward-compat
   shim, exposes `byFaculty` + `byCourse` aggregates with K-anonymity
   (threshold 5), adds the `/:id/faculties/:facultyId/students` endpoint
   for the per-faculty approval queue, introduces the `rejectStudent`
   endpoint with mandatory reason + audit log, and adds an integration
   spec that exercises the Wave 0 fix end-to-end against a seeded
   in-memory shim.
2. **UNI-03 akkreditatsiya PDF** — extracts the akkreditatsiya report into
   `PdfService.generateAkkreditatsiyaReport`, builds a per-faculty section
   (aggregated only per D-Q7 — NO per-student PII), a digital library
   PASS/FAIL checklist auto-computed from real counts, and gates the
   download behind `_assertSubscriptionActive` (SUPER_ADMIN bypass).
   Every DB string flows through `escapeHtml`.
3. **UNI-04 student progress** — a brand-new `StudentProgressService` with
   role-aware visibility: `getProgressForFaculty` (admin-only, aggregated
   by course + month, K-anon for course buckets < 5), and
   `getStudentSelfProgress` (student-self only, userId derived from JWT
   sub — T-06-U5 mitigation). Three frontend pages wire these to the
   real backend.

## T1 — UNI-01 + UNI-02 follow-through

**Service** (`apps/backend/src/modules/otm/otm.service.ts`):

- Constructor takes `@Optional() PrismaReplicaService` (mirrors
  `IdoraService`); `this.r` resolves to replica when injected, primary
  otherwise. Tests that construct with 3 args still pass.
- `_assertScope(institutionId, user?)` private helper looks up the
  institution row and delegates to `assertInstitutionInScope` with the
  resolved `{ viloyatId, tumanId, type }`. SUPER_ADMIN + BUXGALTER
  bypass globally. MUASSASA_ADMIN matched by `user.universityId`.
  Fail-CLOSED on null FK per Plan 06-01 contract.
- `getStudents` + `approveStudent` + `getOtmStats` + new endpoints all
  scope-guarded BEFORE any read/write side-effect (T-05-02 cache-poison
  prevention).
- `approveStudent` now writes `aiAuditLog.create { issueType:
  'OTM_STUDENT_APPROVE' }` after flipping status → ACTIVE.
- `rejectStudent(userId, institutionId, reason, user?)` — NEW. Reason
  trim length < 3 → 400. Cross-institution → 400. Wrong type → 400.
  Flips status → BLOCKED and writes `aiAuditLog.create { issueType:
  'OTM_STUDENT_REJECT', analysis: reason.slice(0,200) }`.
- `getOtmStats` shape change:
  - `byFaculty: [{ faculty, studentCount, avgRi, kAnonymitySuppressed }]`
    — NEW. Grouped by `User.faculty`. Per-faculty `avgRi` computed via a
    second raw-SQL join keyed on faculty (mirrors `school.service.ts`
    K-anon class buckets). Buckets with `studentCount < 5` set
    `avgRi: null` + `kAnonymitySuppressed: true`.
  - `byCourse: [{ course (1..4), count, avgRi, kAnonymitySuppressed }]`
    — NEW. Grouped by `User.studyCourse`. K-anon applied at the bucket
    grain; avgRi deferred to the dedicated student-progress endpoint to
    avoid an extra raw query in the hot stats path.
  - `facultyBuckets` + `courseBuckets` (old shape) retained for
    backward-compat. Plan 06-08 will remove them.
- `getStudentsByFaculty(institutionId, facultyId, user?)` — NEW. Returns
  individual rows for the per-faculty approval queue (no K-anon at the
  row grain — the faculty admin is the admin of record).

**Controller** (`apps/backend/src/modules/otm/otm.controller.ts`):

- Constructor now takes `StudentProgressService` + `PrismaService` (for
  the `resolveScopedUser` helper). `OtmModule` providers updated.
- `resolveScopedUser(payload)` mirrors `SchoolController` — reads
  `{ role, schoolId, universityId, organizationId, faculty, address }`
  from the User row so service-layer scope checks have everything they
  need without an extra round-trip per call.
- New endpoints (all `@Roles(...)` gated, all `resolveScopedUser` then
  service):
  - `GET /otm/:id/faculties/:facultyId/students` — per-faculty list.
  - `PATCH /otm/:id/students/:userId/approve` — canonical approve route.
  - `POST /otm/:id/students/:userId/approve` — legacy POST kept for
    frontend backward-compat (existing dashboard uses POST).
  - `PATCH /otm/:id/students/:userId/reject` — @Throttle 10/min
    (T-06-S2 mass-reject defense).
  - `GET /otm/:id/faculties/:facultyId/progress` — UNI-04 admin view.
  - `GET /otm/me/progress` — UNI-04 student-self view (JwtAuthGuard only
    — no Roles gate).
  - `GET /otm/:id/report/accreditation` — now subscription-gated, also
    accepts `?year=` query.

**Integration spec** (`__tests__/otm.integration.spec.ts`) — Wave 0 P1
regression canary that:

1. Seeds 1 OTM institution + 10 users (8 STUDENT_UNIVERSITY of inst-1
   split into Informatika x6 + Matematika x2, plus 1 STUDENT_UNIVERSITY
   of a different uni + 1 CITIZEN bogus row).
2. Asserts `getStudents("inst-1", {})` returns 8 (NOT 0 — Wave 0
   regression guard).
3. Asserts `getOtmStats("inst-1").byFaculty` has 2 buckets; Informatika
   (5 ACTIVE) is NOT suppressed, Matematika (2 ACTIVE) IS suppressed
   with `avgRi: null, kAnonymitySuppressed: true`.
4. Asserts `approveStudent("u5", "inst-1")` flips the PENDING row →
   ACTIVE and writes the audit log entry.

## T2 — UNI-03 akkreditatsiya PDF + subscription gate

**Service** (`apps/backend/src/modules/otm/otm.service.ts`):

- `_assertSubscriptionActive(institutionId, user?)` — mirrors
  `IdoraService._assertSubscriptionActive`. Looks up `institution.libraryId`,
  reads the latest `Subscription` row, throws `ForbiddenException` when
  status ∉ {ACTIVE, TRIAL}. SUPER_ADMIN bypasses. Institutions without
  a linked library treated as ACTIVE (state-funded fallback).
- `generateAccreditationReport(institutionId, user?, options?)` — scope +
  subscription gates run first. Then calls `composeAccreditationData` →
  `pdf.generateAkkreditatsiyaReport(html)` → `pdf.generateFromHtml`.
- `composeAccreditationData(institutionId, user?, options?)` — NEW.
  Returns the `Pq9OtmReport` shape:
  - `scope: "OTM"`, `institution: { id, name }`, `academicYear`,
    `quarter`, `generatedAt`.
  - `summary` from `getOtmStats` (aggregates only).
  - `byFaculty` from `getOtmStats.byFaculty` (K-anon already applied).
  - `digitalLibraryChecklist` auto-computed (6 criteria): elektron
    katalog (Book count > 0), Reading Index (RI rows > 0), tranzaksiyalar
    (BookTransaction > 0), ilmiy adabiyotlar (ProfBook > 0), faol obuna
    (Subscription ACTIVE/TRIAL OR no linked library), fakultet qamrov
    (byFaculty.length > 0).
  - `profBooks` (top 20, fields: title, author, genre, isRequired).
  - **NO** per-student PII (D-Q7 contract).

**PDF template** (`apps/backend/src/infra/pdf/pdf.service.ts`):

- `generateAkkreditatsiyaReport(data)` — NEW. Renders the akkreditatsiya
  HTML with sections: KPI grid (6 cards), per-faculty table (K-anon
  suppressed → "—"), digital library checklist (PASS green / FAIL red),
  prof books table.
- EVERY DB string interpolation routed through `escapeHtml`:
  `institution.name`, `byFaculty[].faculty`, `checklist[].criterion`,
  `checklist[].note`, `profBooks[].title`, `profBooks[].author`,
  `profBooks[].genre`.
- Numeric fields coerced via `Number(...)`.
- Watermark gets `· DEV PREVIEW` outside production.

**XSS regression test** (excerpt from `pdf.service.spec.ts`):

```js
it("escapes XSS payload in institution.name (T-06-U4)", () => {
  const html = svc.generateAkkreditatsiyaReport(
    makeAkkData({
      institution: { id: "x", name: "<script>alert(1)</script>" },
    }),
  );
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});
```

## T3 — UNI-04 student progress + frontend

**Service** (`apps/backend/src/modules/otm/student-progress/student-progress.service.ts`):

- `getProgressForFaculty(otmId, facultyId, user)`:
  - Scope-guarded via `assertInstitutionInScope` (institution-level).
  - MUASSASA_ADMIN additionally restricted to OWN faculty (`user.faculty
    === facultyId`). SUPER_ADMIN / TUMAN_ADMIN / VILOYAT_ADMIN bypass
    this narrower gate.
  - Returns `{ institution, facultyName, studentCount, byCourse, byMonth }`.
    `byCourse` grouped by `studyCourse` (1..4) with K-anon suppression.
    `byMonth` is a last-12-months RI sample aggregated by `TO_CHAR(...)`,
    also K-anon suppressed when monthly distinct-userId count < 5.
  - NO per-student PII per D-OQ-3 — only aggregates.
- `getStudentSelfProgress(user)`:
  - userId derived from `user.sub` (JWT) — NEVER request param
    (T-06-U5 mitigation).
  - Looks up the caller's User row; asserts `type === STUDENT_UNIVERSITY`
    else 403.
  - Returns `{ user (own row), currentRi, monthlySeries, booksReadThisYear,
    clubMembershipCount }`.

**K-anonymity sample output for a 3-student faculty bucket**:

```json
{
  "faculty": "Matematika",
  "studentCount": 2,
  "avgRi": null,
  "kAnonymitySuppressed": true
}
```

**XSS regression result** (institution.name = `<script>alert(1)</script>`):
the rendered HTML contains `&lt;script&gt;alert(1)&lt;/script&gt;` and
does NOT contain the raw `<script>` tag — confirmed by Jest spec
`PdfService.generateAkkreditatsiyaReport › escapes XSS payload in
institution.name (T-06-U4)`.

**Frontend** (`apps/frontend/app/[locale]/dashboard/otm/...`):

- `page.tsx` — OTM admin dashboard. Reads `OtmStats.byFaculty` (with
  K-anon `—` rendering on suppressed buckets), `byCourse`, KPI cards,
  prof books, OTM rankings. Akkreditatsiya download button calls the
  subscription-gated backend; 403 surfaces as an inline alert.
- `faculty/[facultyId]/page.tsx` — per-faculty drill-down. Reads
  `/otm/:id/faculties/:facultyId/progress` (course buckets +
  K-anon-aware avgRi + 12-month dynamics) AND
  `/otm/:id/faculties/:facultyId/students` (PENDING approval queue +
  active student roster). Approve mutation hits the PATCH route;
  reject mutation prompts for reason and calls the new reject endpoint.
- `progress/page.tsx` — student-self view. Calls `/otm/me/progress`,
  renders a 12-month inline SVG RI line chart, current RI badge,
  10-book yearly goal progress bar, faculty/direction/course profile
  card. Error state explicitly tells non-students this is the wrong
  page.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/src/modules/otm/otm.service.ts` | UNI-01/02 follow-through: scope + audit + reject + byFaculty K-anon + subscription gate + composeAccreditationData |
| `apps/backend/src/modules/otm/otm.controller.ts` | resolveScopedUser + 6 new endpoints (faculty/students, PATCH approve, reject, faculty progress, me/progress, year-param on accreditation) |
| `apps/backend/src/modules/otm/otm.module.ts` | `StudentProgressService` registered as provider/exports |
| `apps/backend/src/modules/otm/student-progress/student-progress.service.ts` | NEW — UNI-04 admin + student-self services |
| `apps/backend/src/modules/otm/student-progress/__tests__/student-progress.service.spec.ts` | NEW — 12 specs (scope, K-anon, role isolation, T-06-U5 self) |
| `apps/backend/src/modules/otm/__tests__/otm.service.spec.ts` | Rewritten — 44 specs (resetAllMocks; +reject + scope + K-anon + composeAccreditationData + subscription gate) |
| `apps/backend/src/modules/otm/__tests__/otm.integration.spec.ts` | NEW — 3 integration specs proving Wave 0 fix end-to-end against seeded shim |
| `apps/backend/src/infra/pdf/pdf.service.ts` | `generateAkkreditatsiyaReport` added; escapeHtml on every DB string |
| `apps/backend/src/infra/pdf/__tests__/pdf.service.spec.ts` | +9 specs for the new akkreditatsiya HTML template (XSS, K-anon, PASS/FAIL badges, D-Q7 PII absence) |
| `apps/frontend/app/[locale]/dashboard/otm/page.tsx` | Faculty tree + K-anon badges + subscription-aware PDF download + universityId resolution |
| `apps/frontend/app/[locale]/dashboard/otm/faculty/[facultyId]/page.tsx` | NEW — per-faculty drill-down + approval queue + reject prompt |
| `apps/frontend/app/[locale]/dashboard/otm/progress/page.tsx` | NEW — student-self progress chart + 10-book progress bar |

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| UNI-01/02 enum | `STUDENT_UNIVERSITY` | `apps/backend/src/modules/otm/otm.service.ts` | 12 | OK (≥ 3) |
| UNI-01/02 FK | `universityId` | `apps/backend/src/modules/otm/otm.service.ts` | 12 | OK (≥ 3) |
| UNI-01/02 scope | `assertInstitutionInScope` | `apps/backend/src/modules/otm/otm.service.ts` | 3 | OK (≥ 3) |
| UNI-02 schoolClass | `schoolClass` (non-comment) | `apps/backend/src/modules/otm/otm.service.ts` | 0 | OK (Wave 0 shim removed; 1 comment-only mention) |
| UNI-03 PDF | `generateAkkreditatsiyaReport` | `apps/backend/src/infra/pdf/pdf.service.ts` | 1 | OK (≥ 1) |
| UNI-03 sub gate | `subscription` | `apps/backend/src/modules/otm/otm.controller.ts` | 2 | OK (≥ 1) |

## Test counts

- `otm.service.spec.ts`: **44 passing** (+13 net vs. Wave 0 31 baseline:
  +faculty K-anon, +reject, +scope guard MUASSASA mismatch,
  +composeAccreditationData, +sub gate FROZEN + SUPER bypass,
  +studentsByFaculty).
- `otm.integration.spec.ts`: **3 passing** (NEW — Wave 0 P1 canary).
- `student-progress.service.spec.ts`: **12 passing** (NEW — UNI-04
  admin + student-self + K-anon + T-06-U2 + T-06-U5).
- `pdf.service.spec.ts`: **35 passing** (+9 vs. Plan 06-05 26 baseline:
  Akkreditatsiya XSS + K-anon + PASS/FAIL + D-Q7 PII absence).
- Backend tsc: clean (pre-existing `@nestjs/elasticsearch` shim errors
  unchanged from Wave 0; no Phase 6 regressions).
- Frontend tsc: clean.

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-10 | Akkreditatsiya PDF aggregates only by faculty; `composeAccreditationData` test asserts no `phone` / per-student PII in the serialized output. |
| T-06-U1 | `assertInstitutionInScope` runs on every OTM endpoint; resolved.type='OTM'; fail-CLOSED null FK. |
| T-06-U2 | `getProgressForFaculty` adds per-faculty assert for MUASSASA_ADMIN; spec covers sibling-faculty 403. |
| T-06-U3 | K_ANONYMITY_THRESHOLD=5 on byFaculty + byCourse + byMonth; tested. |
| T-06-U4 | `escapeHtml` on every DB string in the new akkreditatsiya template; 4 XSS regression specs (institution.name, byFaculty.faculty, checklist criterion/note, profBooks title/author/genre). |
| T-06-U5 | `getStudentSelfProgress` derives userId from `user.sub`; rejects when type !== STUDENT_UNIVERSITY; rejects on missing sub. |
| T-06-U6 | `_assertSubscriptionActive` enforced on the akkreditatsiya download endpoint; SUPER_ADMIN bypass; spec covers FROZEN→403 and SUPER bypass. |

## Decisions applied

- **D-OQ-3**: UNI-04 split into faculty-admin (aggregated, no PII) +
  student-self (own data, JWT-derived userId).
- **D-Q7**: Akkreditatsiya PDF is faculty-aggregated; no per-student
  PII in any row of the PDF body. JSON shape asserted in
  `composeAccreditationData` spec.
- **K-anonymity threshold 5** applied to faculty + course + monthly
  buckets.

## What's NOT in this plan (intentionally)

- Mahalla kutubxonalari module (Phase 6 milestone Wave 4 / Plan 06-08).
- `facultyBuckets` + `courseBuckets` (old shape) removal — kept for
  backward-compat in this plan; Plan 06-08 will drop them after the
  frontend has migrated to `byFaculty` + `byCourse` for two releases.
- ID.UZ integration for STUDENT_UNIVERSITY auto-verification — Phase 7.

## Follow-ups unblocked by Wave 3

- Plan 06-08 (Mahalla kutubxonalari) — the scope-guarded composer
  pattern + K-anon util usage is the template for mahalla aggregates.
- Phase 7 OTM mobile flow — `/otm/me/progress` is ready to be consumed
  by the student PWA / mobile app dashboard.
