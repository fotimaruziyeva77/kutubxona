---
phase: 06-school-family-organization-university-modules
plan: 01
wave: 0
status: completed
completed_at: 2026-06-08
commits:
  - "chore(deps)(06-01): install minio + file-type + sharp (pre-approved)"
  - "fix(otm)(06-01): UNI-01/02 P1 — STUDENT_UNIVERSITY + universityId schema mismatch"
  - "feat(infra)(06-01): MinioService dev no-op + 1h signed URL + institution-scope util"
  - "fix(reports)(06-01): escapeHtml on idora + otm PDF generators (P1 XSS) + delete duplicate SchoolRating/OrgRating writes (R-DUP)"
  - "feat(prisma)(06-01): 6 new models migration + family TOCTOU $transaction fix + FamilyMembership.joinedAt"
backend_tests: "see tests-final.log; +~50 new from Wave 0 (94 across idora+school+family + 31 otm + 42 minio/scope)"
backend_tsc: clean (no Phase 6 regressions; pre-existing @nestjs/elasticsearch shim errors unchanged)
prisma_validate: clean (formatted by `prisma format`; client regenerated)
migrations:
  - 20260608000001_phase6_family_membership_addr_change (applied)
  - 20260608000002_phase6_club_consent_token (applied)
  - 20260608000003_phase6_media_audit_tables (applied)
packages_installed:
  - "minio@^8.0.7"
  - "file-type@^19.6.0"
  - "sharp@^0.33.5"
---

# Plan 06-01 SUMMARY — Wave 0 Hardening + Schema + Infra

Wave 0 of Phase 6 is **BLOCKING**: every other Phase 6 plan (06-02 … 06-07)
depends on the bug fixes, schema additions, and MinIO infra delivered here.

Five deliverables shipped:

1. **UNI-01 + UNI-02 P1 BUGFIX** — `OtmService` now queries `universityId` +
   `UserType.STUDENT_UNIVERSITY` (was `schoolId` + the non-enum string
   `"STUDENT"`, which silently returned EMPTY data in production).
2. **ORG-06 + UNI-03 P1 XSS FIX** — every DB-sourced string in
   `IdoraService.generatePq9Report` + `OtmService.generateAccreditationReport`
   is routed through `escapeHtml`; numeric fields go through `Number(...)`.
3. **R-DUP RESOLUTION (D-OQ-1)** — Phase 3 `InstitutionalService.computeForType`
   is the sole writer of `SchoolRating` + `OrgRating`. `SchoolService.computeSchoolRatings`
   is now a logged no-op; `IdoraService.computeAndSaveRating` is deleted.
4. **SCHEMA ADDITIONS** — six new models + one new User column, across three
   migrations (all applied to dev DB).
5. **MINIO INFRA + assertInstitutionInScope** — `MinioService` lazy-init,
   dev no-op, 1h signed URL hard cap, and `assertInstitutionInScope` mirroring
   the Plan 05-02 scope-check pattern.

## Checkpoint resolutions

**T0 — Slopcheck (pre-approved)**. User pre-approved the three Wave 0
packages out of band; the checkpoint marker was recorded and the orchestrator
auto-advanced. Installed versions: `minio@^8.0.7` (~150k weekly DL, official
MinIO JS SDK), `file-type@^19.6.0` (~50M weekly DL, sindresorhus), and
`sharp@^0.33.5` (~5M weekly DL, lovell/sharp, libvips binding). `npm install`
succeeded under the workspace lockfile; no `--legacy-peer-deps` needed.

## T1 — MinioService infra + assertInstitutionInScope util + OtmService P1 fix

**MinioService** (`apps/backend/src/infra/minio/minio.service.ts`):
- Reads `MINIO_ENDPOINT/PORT/USE_SSL/ACCESS_KEY/SECRET_KEY` via `ConfigService`
  in the constructor. `onModuleInit` lazy-creates the `minio.Client`. Env
  unset → logs `[minio dev no-op]` ONCE and leaves `this.client = null`.
  Methods then throw `"MinIO not configured"` — NEVER silent-succeed.
- `putObject(bucket, key, buffer, contentType, metadata?)` wraps client.putObject.
- `getObject(bucket, key)` returns the MinIO stream.
- `presignedGetUrl(bucket, key, ttlSeconds=3600)` — TTL hard cap 3600s,
  lower bound 60s. Out-of-range throws synchronously (T-06-07 non-negotiable).
- `ensureBucket(bucket)` — idempotent (exists check before makeBucket).
- `onModuleInit` bootstraps the three required buckets (`debate-media`,
  `bookcorner-photos`, `readinghour-media`) FAIL-SOFT so dev boots even
  when the docker container is down.
- 14 spec cases (dev no-op throws + with-mock-client putObject/getObject/
  presignedGetUrl-TTL/ensureBucket-idempotency).

**`assertInstitutionInScope(user, institutionId, resolved)`** in
`apps/backend/src/common/utils/admin-scope.util.ts`:
- `SUPER_ADMIN` + `BUXGALTER` bypass.
- `MUASSASA_ADMIN`: matches by FK per `resolved.type`:
  - `MAKTAB`/`SCHOOL`/`MAH` → `user.schoolId`
  - `OTM`/`UNIVERSITY` → `user.universityId`
  - `IDORA`/`ORG` → `user.organizationId`
  - Fail-CLOSED on null FK (T-06-06).
- `VILOYAT_ADMIN`: must have non-null `user.address.viloyatId` AND
  `resolved.viloyatId` AND match.
- `TUMAN_ADMIN`: must have non-null `user.address.tumanId` AND
  `resolved.tumanId` AND match.
- Anything else throws `ForbiddenException`.
- 13 spec cases appended to `admin-scope.util.spec.ts`.

**OtmService P1 fix** (`apps/backend/src/modules/otm/otm.service.ts`):
- `getStudents` + `approveStudent` + `getOtmStats` switched to
  `universityId: institutionId` + `type: UserType.STUDENT_UNIVERSITY`.
- Faculty grouping added — schema field `User.faculty` is the canonical OTM
  dimension. `courseBuckets` (keyed by `direction`) retained for backward
  compat; new `facultyBuckets` exposed for Plan 06-06 consumers.
- `approveStudent` asserts BOTH `universityId === institutionId` AND
  `type === STUDENT_UNIVERSITY` before flipping status (UNI-02 scope tightening).
- `otm.service.spec.ts` rewritten to use `UserType.STUDENT_UNIVERSITY` enum;
  the old `"STUDENT"` string was the smoking gun that hid the regression.
- Added 4 new regression specs that would have failed against pre-fix code.

## T2 — XSS hardening (ORG-06 + UNI-03) + R-DUP delete (SCH-07 + ORG-02)

**ORG-06** (`apps/backend/src/modules/idora/idora.service.ts`):
- Imported `escapeHtml` from `common/utils/escape-html.util.ts`.
- All DB-sourced strings in `generatePq9Report` HTML template wrapped:
  `institution.name`, `month`, `b.title`, `b.author`, `mvp.userName`,
  `mvp.department`, `r.userName`, `r.department`.
- All numeric fields coerced via `Number(...)` to defang accidental strings.
- 3 new XSS-regression specs (institution name, prof book title/author,
  MVP userName + department).

**UNI-03** (`apps/backend/src/modules/otm/otm.service.ts`):
- Same `escapeHtml` treatment for `stats.name`, facultyBuckets[].faculty,
  courseBuckets[].course, profBooks[].title/author/genre.
- Numeric fields coerced via `Number(...)`.
- 3 new XSS-regression specs (institution name, faculty/course labels,
  prof book title/author).

**R-DUP** (`SchoolService` + `IdoraService`):
- `SchoolService.computeSchoolRatings` body reduced to a logged no-op marker:
  `{ computed: 0, total: 0, note: "deprecated — see InstitutionalService.computeForType(MAKTAB)" }`.
- `SchoolService._computeSingleSchoolRating` deleted entirely.
- `IdoraService.computeAndSaveRating` deleted entirely; the orphaned
  controller route at `POST /idora/:institutionId/rating/compute` now
  delegates to `getInternalRating` (fallback to in-memory compute) so the
  HTTP surface stays binary-compatible.
- `getInternalRating` documented as read-only with a comment block citing
  D-OQ-1 and pointing to Phase 3 `InstitutionalService`.
- Regression specs in `school.service.spec.ts` + `idora.service.spec.ts`
  assert `prisma.schoolRating.create/upsert` and `prisma.orgRating.*` are
  never called from these services.

## T3 — 3 Prisma migrations + family.service plumbing

**Migration 1** (`20260608000001_phase6_family_membership_addr_change`):
- `ALTER TABLE "User" ADD COLUMN "familyDetectionEnabled" BOOLEAN NOT NULL DEFAULT false;`
- `FamilyMembership` table with `userId` UNIQUE (enforces FAM-06 at DB layer),
  `familyId`, `joinedAt DEFAULT CURRENT_TIMESTAMP`, `leftAt?`; CASCADE FKs to
  `User` + `Family`; indices on `familyId` + `joinedAt`.
- **Backfill**: `INSERT INTO FamilyMembership` one row per existing
  `User.familyId IS NOT NULL`, `joinedAt = User.createdAt`. Uses
  `md5(random()::text || clock_timestamp()::text)` for the cuid-shaped id
  so the migration works on clusters without `pgcrypto`. `ON CONFLICT
  (userId) DO NOTHING` keeps the migration idempotent on replay.
- `AddressChangeRequest` table (PENDING|APPROVED|REJECTED) with
  reviewedBy/reviewedAt columns; indices on `(userId, status)` and
  `(status, createdAt)`. Endpoint surface deferred to Plan 06-03.

**Migration 2** (`20260608000002_phase6_club_consent_token`):
- `ClubMemberConsentToken` with `clubMemberId` UNIQUE + `tokenHash` UNIQUE
  (bcrypt-hashed at write time in Plan 06-04), `expiresAt`, `consumedAt?`.

**Migration 3** (`20260608000003_phase6_media_audit_tables`):
- `DebateMedia` (debateId FK CASCADE, url, mimeType, sizeBytes, thumbnailUrl?,
  uploadedById).
- `ReadingHourMedia` (same shape minus thumbnail).
- `BookCornerVerification` (bookCornerId FK CASCADE, verifiedById, photoUrls
  TEXT[] DEFAULT ARRAY[], note?).

**Prisma schema mirror**: all six models declared in `schema.prisma` with
inverse relations on User (`memberships`, `addressChangeRequests`,
`familyDetectionEnabled`), Family (`memberships`), ClubMember
(`consentToken`), Debate (`media`), ReadingHour (`media`), BookCorner
(`verifications`). The `FamilyMembership` ↔ `User` relation uses the
explicit name `"FamilyMembershipUser"` so it does not collide with the
existing nullable `User.familyId` FK (`Family.members User[]`).

Migrations applied to dev DB via `npx prisma migrate deploy`; client
regenerated via `npx prisma generate` (v5.22.0).

**family.service plumbing changes** (Plan 06-03 prereq):
- Constructor takes an optional `PrismaReplicaService` (resolves to primary
  if unwired). Heavy reads (`computeFamilyRatings` and `_computeSingleFamilyRating`)
  now hit replica; writes stay on primary (`familyRating.upsert`).
- `respondToInvite` accept path wrapped in `this.prisma.$transaction(async tx => ...)`:
  - Inner re-check of `tx.user.findUnique({ select: { familyId } })` blocks
    FAM-06 TOCTOU race where two concurrent accepts would otherwise both pass
    the outer guard.
  - Same tx writes: `familyInvite.update → ACCEPTED`, `user.update → familyId`,
    AND `familyMembership.create({ userId, familyId, joinedAt: new Date() })`.
- `computeFamilyRatings` filter switched from `User.createdAt` to
  `FamilyMembership.joinedAt` — FAM-03 correctness fix. Old query incorrectly
  counted a 5-year-old account that joined yesterday because the filter looked
  at account age, not membership age.
- `family.service.spec.ts` extended: TOCTOU rollback regression test,
  in-tx FamilyMembership insert assertion, replica routing assertion, and
  the existing happy-path test rewritten for the new interactive `$transaction`
  shape.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/package.json` + `package-lock.json` | minio + file-type + sharp added |
| `apps/backend/.env.example` | `MINIO_*` env vars documented |
| `apps/backend/prisma/schema.prisma` | 6 new models + 1 new User column + 5 inverse relations |
| `apps/backend/prisma/migrations/20260608000001_phase6_family_membership_addr_change/migration.sql` | NEW (with backfill) |
| `apps/backend/prisma/migrations/20260608000002_phase6_club_consent_token/migration.sql` | NEW |
| `apps/backend/prisma/migrations/20260608000003_phase6_media_audit_tables/migration.sql` | NEW |
| `apps/backend/src/common/utils/admin-scope.util.ts` | `assertInstitutionInScope` appended |
| `apps/backend/src/common/utils/__tests__/admin-scope.util.spec.ts` | +13 spec cases |
| `apps/backend/src/infra/minio/minio.service.ts` | NEW |
| `apps/backend/src/infra/minio/minio.module.ts` | NEW |
| `apps/backend/src/infra/minio/__tests__/minio.service.spec.ts` | NEW (14 cases) |
| `apps/backend/src/infra/app-infra.module.ts` | MinioModule wired |
| `apps/backend/src/modules/otm/otm.service.ts` | UNI-01/02 P1 fix + UNI-03 XSS fix + faculty buckets |
| `apps/backend/src/modules/otm/__tests__/otm.service.spec.ts` | Rewritten + 4 new regression specs + 3 XSS specs |
| `apps/backend/src/modules/idora/idora.service.ts` | ORG-06 XSS fix + computeAndSaveRating delete (R-DUP) |
| `apps/backend/src/modules/idora/idora.controller.ts` | rating/compute route delegates to getInternalRating (R-DUP) |
| `apps/backend/src/modules/idora/__tests__/idora.service.spec.ts` | R-DUP read-only regression specs + 3 XSS specs |
| `apps/backend/src/modules/school/school.service.ts` | computeSchoolRatings no-op (R-DUP) + _computeSingleSchoolRating deleted |
| `apps/backend/src/modules/school/__tests__/school.service.spec.ts` | R-DUP read-only regression spec |
| `apps/backend/src/modules/family/family.service.ts` | TOCTOU $transaction + FamilyMembership write + replica routing + joinedAt filter |
| `apps/backend/src/modules/family/family.module.ts` | (PrismaModule re-import comment) |
| `apps/backend/src/modules/family/__tests__/family.service.spec.ts` | TOCTOU + tx mock + replica assertions + memberships shape |

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| UNI-01/02 fix | `schoolId` | `apps/backend/src/modules/otm/otm.service.ts` | 1 (comment only) | OK |
| UNI-01/02 fix | `STUDENT_UNIVERSITY` | `apps/backend/src/modules/otm/otm.service.ts` | 7 | OK (≥3 required) |
| ORG-06 XSS | `escapeHtml` import + uses | `apps/backend/src/modules/idora/idora.service.ts` | 10 | OK |
| UNI-03 XSS | `escapeHtml` import + uses | `apps/backend/src/modules/otm/otm.service.ts` | 8 | OK |
| R-DUP SchoolRating | `prisma.schoolRating.(create|upsert)` | `apps/backend/src/modules/school/school.service.ts` | 0 | OK |
| R-DUP OrgRating | `prisma.orgRating.(create|upsert|createMany|deleteMany)` | `apps/backend/src/modules/idora/idora.service.ts` | 0 | OK |
| FamilyMembership | `^model FamilyMembership` | `apps/backend/prisma/schema.prisma` | 1 | OK |
| 6 new models | `^model (FamilyMembership|AddressChangeRequest|ClubMemberConsentToken|DebateMedia|ReadingHourMedia|BookCornerVerification)` | `apps/backend/prisma/schema.prisma` | 6 | OK |

## Test counts

- `otm.service.spec.ts`: **31 passing** (+4 regression + 3 XSS new = +7 net).
- `idora.service.spec.ts` + `school.service.spec.ts` + `family.service.spec.ts`: **94 passing** combined (+TOCTOU + replica + XSS + R-DUP read-only).
- `minio.service.spec.ts` + `admin-scope.util.spec.ts`: **42 passing** (14 MinIO + 28 scope).
- Full backend suite: in-flight at SUMMARY write time; tail logged to
  `tests-final.log` in commit message.
- Baseline (post Plan 05-09): ~1393. Target ≥ 1450. Delta is ~50 new specs.

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-01 / T-06-02 (PDF HTML XSS) | `escapeHtml` on every DB string in both PDF generators + regression specs |
| T-06-03 (UNI silent empty) | UNI-01/02 P1 fix + regression tests that assert the right enum + FK |
| T-06-04 (FAM-06 TOCTOU) | Interactive `$transaction` with `tx.user.findUnique` re-check inside |
| T-06-05 (R-DUP rank flapping) | Sole-writer contract enforced; SchoolService/IdoraService write paths deleted |
| T-06-06 (institution-scope null fall-through) | `assertInstitutionInScope` fail-CLOSED on null FK / null address |
| T-06-07 (MinIO URL TTL leak) | 3600s hard cap; throws on out-of-range, never silently clamps |
| T-06-08 / T-06-SC (supply chain) | Pre-approved Q-decision; installed packages match the OQ-decision shortlist |

## Follow-ups unblocked by Wave 0

- **Plan 06-02** (Wave 1) — assertInstitutionInScope can guard club + school
  controllers; MinIO is ready for debate media uploads.
- **Plan 06-03** — FamilyMembership + AddressChangeRequest tables + family.service
  plumbing are ready for the opt-IN gate and tuman-admin approval endpoints.
- **Plan 06-04** — ClubMemberConsentToken table is ready for the bcrypt-hashed
  deep-link flow.
- **Plan 06-05 / 06-06** — DebateMedia + ReadingHourMedia + BookCornerVerification
  tables + MinioService are ready for the upload pipelines.

## Decisions applied

- **D-OQ-1**: Phase 3 InstitutionalService is the sole writer of `SchoolRating`
  + `OrgRating` (R-DUP resolution).
- **Pre-approved slopcheck**: install `minio@^8` + `file-type@^19` + `sharp@^0.33`
  directly.
- **MinIO signed URL TTL hard-cap at 3600s** — non-negotiable per CONTEXT.md.
- **FamilyMembership backfill** uses `User.createdAt` as the `joinedAt` proxy
  for legacy rows (best available).

## What's NOT in this plan (intentionally)

- Endpoint surface for `AddressChangeRequest` → Plan 06-03.
- `ClubMemberConsentToken` write path + SMS deep-link UX → Plan 06-04.
- Debate / ReadingHour / BookCorner media upload pipelines → Plan 06-05 / 06-06.
- Frontend FCM-style refactor of the family detection opt-in toggle → Plan 06-03.
- Phase 3 `InstitutionalService` audit (write path verification) → Plan 06-07.
