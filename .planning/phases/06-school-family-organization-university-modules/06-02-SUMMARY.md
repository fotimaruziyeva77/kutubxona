---
phase: 06-school-family-organization-university-modules
plan: 02
wave: 1
status: completed
completed_at: 2026-06-08
commits:
  - "feat(school)(06-02): students-by-class + reject + K-anon scope guard (SCH-01/02/09)"
  - "feat(school)(06-02): 20-book monitor + reyting consumer + PQ-9 PDF (SCH-06/07/08)"
  - "feat(frontend)(06-02): school dashboard wiring + PQ-9 download + reject modal (SCH-01..09)"
backend_tests: "school.service.spec.ts 31, school.controller.spec.ts 5, club.service.spec.ts 51, pdf.service.spec.ts 15 — 102 total, all passing"
backend_tsc: clean (no Phase 6 regressions; pre-existing @nestjs/elasticsearch shim errors unchanged)
frontend_tsc: clean
---

# Plan 06-02 SUMMARY — Wave 1 School Module Hardening + PQ-9 PDF

Wave 1 of Phase 6 hardens the school admin dashboard:

1. **SCH-01 + SCH-09 Scope Guards** — `SchoolService.getStudents` /
   `getStudentsByClass` / `getSchoolStats` now resolve the institution row first,
   then call `assertInstitutionInScope` BEFORE `cache.remember` runs. A forbidden
   caller never poisons the cache key. The new `getStudentsByClass` endpoint
   buckets students by class and applies K-anonymity (`avgRi` suppressed to
   `null` + `kAnonymitySuppressed: true` flag when class total < 5).

2. **SCH-02 Reject Endpoint** — new `PATCH /school/institutions/:id/students/:userId/reject`
   accepts `{ reason }`, flips `User.status → BLOCKED`, and writes an
   `AiAuditLog { scope:'USER', issueType:'STUDENT_REJECT', severity:'LOW' }` row
   in a single Prisma `$transaction`. Reason is min 3 chars, max 500 chars
   (trimmed). Endpoint guarded by `@Roles(SUPER_ADMIN, MUASSASA_ADMIN,
   TUMAN_ADMIN, VILOYAT_ADMIN)` + `@Throttle({ limit: 10, ttl: 60_000 })`
   (anti-script abuse, T-06-S2).

3. **SCH-06 + SCH-09 20-Book Monitor + Quarterly Report** — `ClubService.getQuarterlyReport`
   composes per-member 20-book progress (rate + quartile classification),
   PUBLISHED debate count this quarter, and an `inactive` flag (true when
   `daysSinceDebate >= INACTIVE_THRESHOLD_DAYS`). Goal is the hardcoded
   `const GOAL = 20` per CLAUDE.md §VII + D-Q2 (no per-club override).
   `INACTIVE_THRESHOLD_DAYS = 30` (was 45 in `getInactiveClubs` default).

4. **SCH-07 Read-Only Consumer + Weekly Cache Refresh** — `SchoolService` is
   confirmed READ-ONLY against `SchoolRating` (Phase 3 InstitutionalService is
   sole writer per D-OQ-1). New `@Cron('0 2 * * 0', timeZone: 'Asia/Tashkent')`
   `refreshRankingCache` acquires a Redis SETNX leader lock
   (`lock:school-ranking-refresh-weekly`, TTL 30 min) so multi-replica clusters
   do not double-run. The cron INVALIDATES `school:ranking:*` cache keys via
   `delPattern` and NEVER writes `SchoolRating` (R-DUP gate enforced by grep +
   regression spec).

5. **SCH-08 PQ-9 PDF with Jadidlar Izidan Section** — new
   `PdfService.generateSchoolPq9Report` HTML template includes:
   - KPI table (totalStudents, coverageRate, avgRi, 20-book progress, etc.)
   - Per-class table with K-anonymity suppression (renders `—` for small classes)
   - "Jadidlar Izidan" per-club rows (name, members, quarter debates, last debate)
   - Inactive clubs section (30+ day threshold)
   - All DB-sourced strings (`schoolName`, `club.name`, `className`, `inactiveClubs.name`)
     routed through `escapeHtml`; numerics coerced via `Number(...)`.
     XSS payload regression test confirms `<script>` renders as `&lt;script&gt;`.

6. **CLUB_INACTIVE Threshold Already Correct** — `audit.service.ts` already had
   `THRESHOLDS.CLUB_DEBATE_DAYS = 30` from Plan 05-05 ALERT-04. Plan 06-02 verified
   this via the existing `audit.service.alert-consolidation.spec.ts` (11/11 pass).

7. **Frontend SCH-01..09 Wiring** — `apps/frontend/app/[locale]/dashboard/school/page.tsx`
   rewired to the new endpoints with K-anon-aware display and reject UX:
   - Class-bucket widget pulls `/students-by-class` and renders
     `Maxfiylik k<5` placeholder when `kAnonymitySuppressed: true`.
   - PQ-9 download button creates anchor with HttpOnly cookie auth.
   - PENDING student rows expose both Tasdiqlash + Rad etish buttons.
   - Rad etish opens `RejectModal` (textarea, min 3 chars, max 500, chars counter).

## Files modified

| Path | Why |
|---|---|
| `apps/backend/src/modules/school/school.service.ts` | Scope guards + K-anon bucket method + rejectStudent + weekly @Cron refresh |
| `apps/backend/src/modules/school/school.controller.ts` | Reject endpoint + students-by-class endpoint + scoped-user resolver + @Throttle |
| `apps/backend/src/modules/school/school.module.ts` | Documentation note — PrismaModule + CacheModule are @Global |
| `apps/backend/src/modules/school/__tests__/school.service.spec.ts` | 31 specs — scope guard matrix, K-anon, reject (7 cases), refresh cron, R-DUP read-only |
| `apps/backend/src/modules/school/__tests__/school.controller.spec.ts` | NEW — RBAC metadata + scope-user resolver + reject body wire |
| `apps/backend/src/modules/club/club.service.ts` | INACTIVE_THRESHOLD_DAYS=30 + GOAL=20 + getQuarterlyReport |
| `apps/backend/src/modules/club/__tests__/club.service.spec.ts` | Added 30d threshold regression + quarterly report (5 cases) + GOAL=20 |
| `apps/backend/src/infra/pdf/pdf.service.ts` | generateSchoolPq9Report HTML template + escape on every DB string |
| `apps/backend/src/infra/pdf/__tests__/pdf.service.spec.ts` | 9 new specs covering XSS in club.name / schoolName / className / inactive clubs |
| `apps/frontend/app/[locale]/dashboard/school/page.tsx` | Real-data wiring + K-anon display + RejectModal + cookie-auth PQ-9 download |

## Test counts

- `school.service.spec.ts` — 31 passing (scope matrix, K-anon, reject, cron leader lock, R-DUP read-only)
- `school.controller.spec.ts` — 5 passing (RBAC metadata + reject wire)
- `club.service.spec.ts` — 51 passing (existing 44 + 7 new SCH-06/09)
- `pdf.service.spec.ts` — 15 passing (existing 9 + 6 new school PQ-9 escapes)
- **Total Phase 6-02 new: ~50 specs** (matches plan target)

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| R-DUP write deletion | `prisma\.schoolRating\.(create|upsert)` | `school.service.ts` | 0 calls (1 comment-only mention) | OK |
| Replica routing | `prismaReplica\|replica` | `school.service.ts` | 6 | OK (>=3 required) |
| Scope guard usage | `assertInstitutionInScope` | `school.service.ts` | 8 | OK (>=2 required) |
| PQ-9 PDF method | `generateSchoolPq9Report` | `pdf.service.ts` | 1 | OK |
| Reject @Throttle | `@Throttle` | `school.controller.ts` | 1 (on rejectStudent) | OK |
| Inactive threshold | `INACTIVE_THRESHOLD_DAYS\s*=\s*30` | `club.service.ts` | 1 | OK |
| Goal constant | `const GOAL\s*=\s*20` | `club.service.ts` | 1 | OK |
| Frontend K-anon | `Maxfiylik` + `k<5` | `dashboard/school/page.tsx` | 2 | OK |

## K-anon evidence (sample bucket with total < 5)

Test `getStudentsByClass groups by class and suppresses avgRi when total < 5`:

```js
// Input: 10B class with total=3 (below K_ANONYMITY_THRESHOLD=5)
mockReplica.user.groupBy.mockResolvedValue([
  { schoolClass: "10B", status: "ACTIVE", _count: { id: 3 } },
  // ...
]);

// Output:
const c10B = result.buckets.find(b => b.className === "10B");
expect(c10B.total).toBe(3);
expect(c10B.avgRi).toBeNull();              // ← suppressed
expect(c10B.kAnonymitySuppressed).toBe(true); // ← K-anon flag set
```

## PQ-9 PDF XSS regression result

Test `escapes XSS payload in club.name (T-06-02)`:

```js
const html = svc.generateSchoolPq9Report({
  ...
  jadidlarSection: {
    clubs: [{ name: "<script>fetch('evil.io')</script>", memberCount: 10, ... }],
    inactiveClubs: [],
  },
});
expect(html).not.toContain("<script>fetch");  // ✓ raw payload absent
expect(html).toContain("&lt;script&gt;");      // ✓ escape applied
```

Additional XSS regressions cover `schoolName`, `title`, `classBuckets[].className`,
`inactiveClubs[].name` — all blocked.

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-01 (cross-school student leak) | `assertInstitutionInScope` runs BEFORE `cache.remember`; MUASSASA_ADMIN/VILOYAT_ADMIN/TUMAN_ADMIN matrix tested |
| T-06-02 (PQ-9 PDF XSS via club name) | `escapeHtml` on every DB string in the new template + 6 XSS regression specs |
| T-06-03 (K-anon violation in small classes) | `K_ANONYMITY_THRESHOLD = 5`; `avgRi` suppressed + `kAnonymitySuppressed: true` flag |
| T-06-S1 (reject without RBAC) | `@Roles` + `@Throttle({ limit: 10/min })` + service-layer scope assert |
| T-06-S2 (reject reason XSS via AiAuditLog UI) | 500-char cap + admin audit-log UI already escapes (Plan 5) — accepted per plan |
| T-06-S3 (weekly cron clock drift / double run) | RedisLockService SETNX with 30-min TTL; no-op when not first acquired |

## Decisions applied

- **D-Q2**: 20-book goal is hardcoded (`const GOAL = 20`); custom per-club goal deferred to V2.
- **D-Q5**: PQ-9 PDF admin-only download — TUMAN/VILOYAT/MUASSASA/SUPER admin per scope.
- **D-OQ-1**: SchoolService is READ-ONLY consumer of SchoolRating; Phase 3 InstitutionalService is sole writer.

## What's NOT in this plan (intentionally)

- Club CRUD + parent consent SMS deep-link → Plan 06-04 (parallel Wave 1 sibling).
- Family detection + AddressChangeRequest endpoints → Plan 06-03 (parallel Wave 1 sibling).
- Debate media upload pipeline (MinIO presigned URLs + thumbnails) → Plan 06-05.
- Phase 3 InstitutionalService write-path audit → Plan 06-07.
- Frontend Jest test infrastructure (no `jest.config` exists in `apps/frontend` yet) — TSC + Next build smoke covered.
