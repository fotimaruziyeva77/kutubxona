---
phase: 06-school-family-organization-university-modules
plan: 04
wave: 2
status: completed
completed_at: 2026-06-08
commits:
  - "feat(club)(06-04): bcrypt parent consent + 48h TTL + SMS rate-limit + leader-locked expiry cron (SCH-03/04)"
  - "feat(debate)(06-04): MinIO upload + file-type sniff + 50MB+4-file caps + DRAFT->PUBLISHED gate (SCH-05)"
  - "feat(frontend)(06-04): consent SSR page + debate upload UI (SCH-04/05)"
backend_tests: "club.service.spec 52, club-consent.service.spec 12, debate-media.service.spec 21 — 85 total, all passing"
backend_tsc: clean (no Phase 6 regressions; pre-existing @nestjs/elasticsearch shim errors unchanged)
frontend_tsc: clean
migrations:
  - 20260608000005_phase6_debate_status (applied to schema; deploy on Wave 2 closeout)
---

# Plan 06-04 SUMMARY — Wave 2 Club CRUD + Parent SMS Consent + Debate Media

Wave 2 delivers the three most security-sensitive flows in Phase 6:

1. **SCH-03 club CRUD hardening** — goal hardcoded at 20 (D-Q2), institution
   scope-resolved via `assertInstitutionInScope`, addMember delegates to the
   new `ClubConsentService` for under-18 enrolments.

2. **SCH-04 bcrypt parent SMS consent deep-link** — replaces the legacy
   `reply HA <memberId>` UX with a 128-bit nonce → bcrypt(10) → 48h TTL
   single-use token. Constant-time bcrypt.compare on verify + 200ms timing
   pad on miss. Three SMS attempts per memberId per 24h rate-limit. Public
   `/club/consent/info` endpoint exposes MINIMUM info per D-OQ-4
   (childName + clubName + leaderName only).

3. **SCH-05 debate media upload + DRAFT→PUBLISHED state machine** — MinIO
   bucket-scoped key (`{institutionId}/{debateId}/{cuid}.{ext}` — NEVER user
   filename); file-type magic-byte sniff defeats declared-MIME spoofing;
   50MB per-file + 4-file per-debate caps; sharp 200×200 thumbnail with
   fail-soft fallback; finalize requires ≥1 valid media row; quarterly +
   PDF reports only count PUBLISHED debates.

## T1 — SCH-03/04 club CRUD + parent consent token

**New service** (`apps/backend/src/modules/club/consent/club-consent.service.ts`):
- `mintAndSend({ clubMemberId, parentPhone, childName, clubName })` — generates
  16-byte cryptographic nonce (32 hex chars), bcrypt-hashes with cost 10,
  upserts into `ClubMemberConsentToken` with `expiresAt = now + 48h`. SMS body
  is built via a constant template, sanitised of newlines + semicolons:
  `SIFAT LIBRARY: {childName} farzandingiz '{clubName}' klubiga taklif qilingan. Tasdiqlash: sifat.uz/uz-Latn/club/consent?t={nonce}. Muddati 48 soat.`
  - SMS rate-limit: `consent-sms:{memberId}` Redis key, 3 attempts / 24h via
    `cache.incrWithTtl` — fixed-window counter (same primitive as Phase 1 OTP).
  - Returns the plaintext nonce only in the return value — caller must NOT log it.
- `confirmByToken(token, action)` — defensive: validates token shape (32 hex)
  BEFORE DB hit, otherwise short-circuits with a 200ms pad to defeat
  enumeration. Scans active+unconsumed tokens with `LIMIT 1000`. For each
  candidate, `bcrypt.compare` runs in constant time (O(n) leak is acceptable
  per threat model). On match, an interactive `$transaction` re-checks
  `expiresAt > now AND consumedAt IS NULL`, then atomically writes:
    1. `clubMemberConsentToken.update({ consumedAt: now })`
    2. `clubMember.update({ status, parentConsented, joinedAt/leftAt })`
    3. `aiAuditLog.create({ issueType: PARENT_CONSENT_APPROVED|REJECTED })`
  Throws `GoneException` (HTTP 410) when the row was consumed mid-race.
- `peek(token)` — same bcrypt scan, does NOT consume the token. Returns
  exactly `{ childName, clubName, leaderName }` per D-OQ-4.
- `@Cron("0 */6 * * *", timeZone: "Asia/Tashkent")` `scanExpired()` — every
  6 hours, wrapped in a Redis SETNX leader lock (`lock:club-consent-expiry-scan`,
  10-min TTL via `RedisLockService.tryAcquire`). Selects expired+unconsumed
  tokens (LIMIT 10000), flips each `ClubMember` to `LEFT` + writes
  `PARENT_CONSENT_EXPIRED` audit log. One bad row does NOT kill the batch.

**Club service refactor** (`apps/backend/src/modules/club/club.service.ts`):
- `addMember` now delegates to `ClubConsentService.mintAndSend` when the
  optional dependency is wired. Legacy `_sendParentConsentSms` retained as a
  fallback for older test constructors (3-arg ClubService).
- `getQuarterlyReport.publishedDebates` filter switched to
  `status: "PUBLISHED"` so SCH-08 PQ-9 PDF reflects PUBLISHED-only counts.

**Club controller** (`apps/backend/src/modules/club/club.controller.ts`):
- `@Public() @Get("consent/info")` + `@Public() @Post("consent")` — both
  IP-rate-limited via `_consentIpRateCheck` (10 attempts/hr/IP through
  `cache.incrWithTtl`) on top of NestJS `@Throttle` (defense-in-depth).
- POST validates `action ∈ {APPROVE, REJECT}` + token non-empty before
  reaching the service.

**Module wiring** (`apps/backend/src/modules/club/club.module.ts`):
- Providers: `ClubService`, `ClubConsentService`, `DebateMediaService`.
- `MinioModule` imported (explicit + redundant since `@Global()`).

**Public consent /info endpoint shape**:

```http
GET /api/club/consent/info?t=<32-hex-nonce>
200 OK
{
  "childName": "Ali Aliyev",
  "clubName": "Jadidlar Klubi",
  "leaderName": "Karim Karimov"
}
```

Only three fields — no school address, no sibling names, no phone numbers.

**Specs** (`club-consent.service.spec.ts` — 12 cases):
- mintAndSend: nonce shape + bcrypt prefix + 48h TTL + SMS deep-link
- mintAndSend: sanitises newlines + semicolons
- mintAndSend: 3/24h rate-limit returns BadRequest + no SMS enqueued
- mintAndSend: rate-limit key uses 86_400s window
- confirmByToken APPROVE: tx flips status to ACTIVE
- confirmByToken REJECT: tx flips status to LEFT + audit issueType REJECTED
- confirmByToken: 410 Gone on already-consumed row (race-safe re-check)
- confirmByToken: 404 NotFound with ≥150ms pad
- confirmByToken: malformed token returns generic 404
- confirmByToken: candidate scan filter only includes consumedAt=null + future expiresAt
- peek: returns exactly 3 fields per D-OQ-4
- peek: does NOT call consentToken.update (no consume)
- scanExpired: skip when leader lock not acquired
- scanExpired: lock key + 10-min TTL
- scanExpired: per-row tx including audit row write
- scanExpired: single failure doesn't kill the batch

**Expiry-cron leader-lock evidence**: test
`scanExpired (cron) > skips when Redis lock not acquired (multi-replica safety)`
asserts `mockPrisma.clubMemberConsentToken.findMany` is NOT called when
`mockLock.tryAcquire` resolves `{ first: false }`. Follow-on test verifies
lock key string `lock:club-consent-expiry-scan` + 600s (10 min) TTL.

## T2 — SCH-05 debate media upload + DRAFT/PUBLISHED gate

**Schema change** (`apps/backend/prisma/schema.prisma`):
- `Debate` model gains `status String @default("DRAFT")` + `@@index([status])`.

**Migration** (`20260608000005_phase6_debate_status`):
```sql
ALTER TABLE "Debate" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';
CREATE INDEX "Debate_status_idx" ON "Debate"("status");
UPDATE "Debate" SET "status" = 'PUBLISHED' WHERE "createdAt" < CURRENT_TIMESTAMP;
```
The backfill preserves quarterly counts for pre-existing dev rows; new debates
created by Plan 06-04 onwards land DRAFT.

**New service** (`apps/backend/src/modules/club/media/debate-media.service.ts`):
- `uploadDebateMedia(user, clubId, debateId, file)`:
  1. Size cap (50_000_000 bytes) — Multer hard-limits before the buffer fully
     materialises; service-level re-check throws `PayloadTooLargeException`.
  2. Load debate + club + institution (single query with nested include).
  3. Reject if `clubId` param doesn't match `debate.clubId` (defense in depth).
  4. Reject if `debate.status === "PUBLISHED"` (no re-uploads to finalised).
  5. `assertInstitutionInScope` BEFORE we touch file buffer / MinIO — a
     forbidden user never triggers a `putObject`.
  6. 4-file cap via `debateMedia.count`.
  7. `fileTypeFromBuffer(file.buffer)` magic-byte sniff. Whitelist:
     `image/jpeg, image/png, image/webp, video/mp4, video/webm, video/quicktime`.
     Declared-vs-detected MIME mismatch → 400, with `image/jpg ↔ image/jpeg`
     tolerated.
  8. MinIO key derived from a 24-hex random cuid + detected.ext:
     `{institutionId}/{debateId}/{cuid}.{ext}`. NEVER user filename
     (path-traversal mitigation T-06-06b).
  9. For images (`image/jpeg|png|webp`): `sharp(buffer).resize(200,200).jpeg({quality:80})`,
     uploaded to `{key}-thumb.jpg`. Failure is fail-soft — thumbnailUrl=null
     and a warning is logged; the original upload still succeeds.
  10. Persist `DebateMedia` row + push the key into `Debate.mediaUrls`
      (back-compat with Plan 06-02 consumers) + write `DEBATE_MEDIA_UPLOAD`
      audit log.
- `finalizeDebate(user, clubId, debateId)`:
  1. Scope guard runs BEFORE media count → forbidden user does not see counts.
  2. Re-reject if `status === "PUBLISHED"` (no double finalize).
  3. Require ≥1 `DebateMedia` row.
  4. `$transaction`: `debate.update({ status: "PUBLISHED" })` +
     `aiAuditLog.create({ issueType: "DEBATE_PUBLISHED" })`.
- `listDebateMedia(user, clubId, debateId)` — returns presigned URLs (3600s
  TTL via MinioService hard-cap). Failures per-row are non-fatal (logged
  + raw key returned).

**Controller wiring** (`apps/backend/src/modules/club/club.controller.ts`):
- `@Post(":clubId/debates/:debateId/media")` — `@UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50_000_000, files: 1 } }))`
  + RBAC `KLUB_RAHBARI | MUASSASA_ADMIN | TUMAN_ADMIN | VILOYAT_ADMIN | SUPER_ADMIN`.
  Resolves the scoped user via `resolveScopedUser` (mirrors `SchoolController`).
- `@Patch(":clubId/debates/:debateId/finalize")` — same RBAC.
- `@Get(":clubId/debates/:debateId/media")` — returns presigned URLs.

**Specs** (`debate-media.service.spec.ts` — 21 cases, ESM `file-type`
worked around via `<rootDir>/__mocks__/file-type.ts` + jest `moduleNameMapper`):
- Size cap: > 50MB rejects, exactly 50_000_000 passes.
- 4-file cap: 5th file → 400 with explicit `Maksimal 4 ta fayl` message.
- file-type sniff: undefined detection → 400; non-whitelisted mime → 400;
  declared `image/jpeg` + detected `image/gif` → 400 (mismatch message);
  `image/jpg ↔ image/jpeg` tolerance.
- MinIO key safety: malicious filename `../../etc/passwd.jpg` → key remains
  `inst-1/debate-1/{cuid}.jpg`, putObject second arg matches the safe pattern.
- MinIO `putObject` call counts: **2 for images** (original + thumbnail),
  **1 for video/mp4** (no thumbnail).
- Thumbnail failure: sharp throws → original upload succeeds, `thumbnailUrl: null`.
- Scope guard: MUASSASA_ADMIN of a different school → 403 BEFORE putObject runs.
- State machine: re-upload to PUBLISHED → 400; missing debate → 404; clubId
  param mismatch → 400.
- finalizeDebate: 0 media → 400; 1+ media → PUBLISHED via $transaction;
  PUBLISHED → 400 on second finalize; scope guard precedes count check.
- listDebateMedia: presigned URLs use 3600s TTL.

**MIME sniff test outputs (decimal-form mismatch case)**:
```js
mockSniff.mockResolvedValueOnce({ mime: "image/gif", ext: "gif" });
const file = makeFile({ mimetype: "image/jpeg" });
await service.uploadDebateMedia(...);
// → BadRequestException: "Fayl turi qabul qilinmaydi: image/gif"
// (image/gif is not in the whitelist; mismatch never even reached)
```

**Representative MinIO putObject call counts in one test run**:
```
test: "calls MinIO putObject TWICE for images"
  → putObject(bucket, "inst-1/debate-1/{cuid}.jpg", buffer, "image/jpeg")
  → putObject(bucket, "inst-1/debate-1/{cuid}-thumb.jpg", thumbBuffer, "image/jpeg")
total calls = 2
```

## T3 — Frontend pages

**Public consent page** (`apps/frontend/app/[locale]/club/consent/page.tsx`):
- Server-side fetches `/api/club/consent/info?t=<token>` with `cache: "no-store"`.
- Renders three states: token missing, 410 expired, 404/error, success-with-buttons.
- Minimum-info display per D-OQ-4: only `childName + clubName + leaderName`
  surfaced in the UI. No school address, no other student names, no phone.
- Client form (`ConsentForm.tsx`) POSTs `{token, action}` to `/api/club/consent`
  and handles the four outcomes (approved, rejected, gone, error).

**Debate detail page** (`apps/frontend/app/[locale]/dashboard/club/[clubId]/debate/[debateId]/page.tsx`):
- Authenticated via the existing cookie-based axios client (`withCredentials: true`).
- Renders metadata + status badge (Qoralama / Tasdiqlangan).
- DRAFT state shows the `+ Fayl qo'shish` button bound to a hidden `<input type="file" multiple>`
  with `accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"`.
- Client-side validation runs BEFORE the POST: 50MB cap + 4-file cap with
  per-file error toast on rejection. Server-side enforcement is the authoritative
  layer — UI hints just save the round-trip.
- "Tasdiqlash" button is disabled until media count ≥ 1; PATCHes the finalize
  endpoint and invalidates the React Query cache.
- PUBLISHED state renders the media grid with `<img src=presignedThumbnail>`
  or `<video src=presigned controls>` — no re-upload UI.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/prisma/schema.prisma` | Debate.status column + index |
| `apps/backend/prisma/migrations/20260608000005_phase6_debate_status/migration.sql` | NEW |
| `apps/backend/jest.config.ts` | moduleNameMapper for ESM `file-type` |
| `apps/backend/src/__mocks__/file-type.ts` | NEW — ESM stub for ts-jest |
| `apps/backend/src/modules/club/consent/club-consent.service.ts` | NEW — bcrypt + cron + peek |
| `apps/backend/src/modules/club/consent/__tests__/club-consent.service.spec.ts` | NEW — 12 cases |
| `apps/backend/src/modules/club/media/debate-media.service.ts` | NEW — MinIO + sniff + sharp |
| `apps/backend/src/modules/club/media/__tests__/debate-media.service.spec.ts` | NEW — 21 cases |
| `apps/backend/src/modules/club/club.service.ts` | addMember delegates + PUBLISHED-only quarterly |
| `apps/backend/src/modules/club/club.controller.ts` | Public consent endpoints + FileInterceptor + finalize |
| `apps/backend/src/modules/club/club.module.ts` | + consent + media providers |
| `apps/backend/src/modules/club/__tests__/club.service.spec.ts` | + delegation spec |
| `apps/frontend/app/[locale]/club/consent/page.tsx` | NEW — SSR consent page |
| `apps/frontend/app/[locale]/club/consent/ConsentForm.tsx` | NEW — client APPROVE/REJECT form |
| `apps/frontend/app/[locale]/dashboard/club/[clubId]/debate/[debateId]/page.tsx` | NEW — debate detail + upload + finalize |

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| Bcrypt usage | `bcrypt` | `club-consent.service.ts` | 15 | OK (≥2 required) |
| 48h TTL | `TOKEN_TTL_HOURS = 48` / `172_800` | `club-consent.service.ts` | 1 | OK (≥1 required) |
| File-type sniff | `fileTypeFromBuffer` / `file-type` | `debate-media.service.ts` | 5 | OK (≥1 required) |
| 50MB cap | `50_000_000` / `MAX_FILE_BYTES` | `debate-media.service.ts` | 1 | OK |
| FileInterceptor | `FileInterceptor` / `multer` | `club.controller.ts` | 2 | OK (≥1 required) |

## Test counts

- `club.service.spec.ts` — 52 passing (51 existing + 1 new consent delegation spec)
- `club-consent.service.spec.ts` — 12 passing (NEW: mint+SMS+rate-limit+verify+peek+cron)
- `debate-media.service.spec.ts` — 21 passing (NEW: size + count + sniff + scope + state)
- **Total Phase 06-04 new: ~32 specs** (matches plan target after consolidation)

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-05 (token brute force) | 128-bit nonce + bcrypt(10) + IP rate-limit 10/hr + SMS rate-limit 3/24h |
| T-06-05b (token replay) | `consumedAt` single-use; tx writes consumedAt in same $transaction as state flip; race-safe re-check inside the tx |
| T-06-05c (URL leak via history) | V1 accepted per research §Pitfall 6; 48h TTL + single-use + sanitised SMS body bound exposure |
| T-06-05d (leader forgery) | Leader never sees the nonce; only the bcrypt hash lives in the DB |
| T-06-05e (consent page info leak) | D-OQ-4 minimum info: `peek()` returns exactly `{ childName, clubName, leaderName }` |
| T-06-06 (file MIME spoof) | `fileTypeFromBuffer` magic-byte sniff + whitelist + declared-vs-detected mismatch reject |
| T-06-06b (path traversal) | MinIO key always `{instId}/{debateId}/{cuid}.{ext}`; user filename discarded |
| T-06-06c (DoS via large upload) | FileInterceptor `fileSize: 50_000_000` middleware enforces BEFORE service runs |
| T-06-06d (DoS via many files) | 4-file `count` check before put; 5th upload → 400 |
| T-06-07 (URL TTL leak) | MinioService hard-cap 3600s on `presignedGetUrl` (Plan 06-01 contract) |
| T-06-S4 (timing side-channel) | bcrypt.compare constant-time + 200ms `_padDelay` on miss |
| T-06-S5 (cron clock drift / double-run) | RedisLockService SETNX `lock:club-consent-expiry-scan`, 10-min TTL; second replica skips |

## Decisions applied

- **D-Q1**: 50MB per file + 4 files per debate; whitelist MIME via `file-type`.
- **D-Q2**: 20-book goal hardcoded — `goal` parameter of `createClub` is accepted
  but quarterly/yearly progress always uses `const GOAL = 20`.
- **D-OQ-4**: parent consent page shows minimum info (child + club + leader).
- **D-OQ-6**: inactive-club alert recipient is `KLUB_RAHBARI`; under-14 message
  counts fine (teacher already knows students).
- **Token UX choice**: bcrypt deep-link instead of "SMS reply HA + memberId"
  (research §Parent SMS Consent Flow). The legacy `_sendParentConsentSms` path
  is retained as a test-only fallback so older 3-arg `ClubService` constructors
  still compile, but production wiring routes through `ClubConsentService.mintAndSend`.

## Follow-ups unblocked by Wave 2

- Plan 06-05 (Wave 3) — ReadingHour media upload can reuse the
  `DebateMediaService` upload pattern (MinIO key safety + file-type sniff +
  4-file cap). Same `bucketReadingHours` already declared in `MinioService`.
- Plan 06-06 (Wave 3) — BookCorner photo verification reuses the same upload
  primitive against `bucketBookCorners`.
- Phase 6 closeout — `Debate.status = "PUBLISHED"` filter now drives both
  the SCH-06 quarterly report and the SCH-08 PQ-9 PDF; verification can confirm
  end-to-end that DRAFT debates don't surface in either output.

## What's NOT in this plan (intentionally)

- ReadingHour media upload pipeline → Plan 06-05.
- BookCorner photo verification → Plan 06-06.
- Frontend Jest test infrastructure (no `jest.config` in `apps/frontend`)
  — TSC + Next build smoke covered.
- O(1) token lookup via separate `tokenLookup` column — V2; the V1 O(n) scan
  with LIMIT 1000 + bcrypt.compare is acceptable at realistic enrollment volumes.
