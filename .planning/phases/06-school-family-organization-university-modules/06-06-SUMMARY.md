---
phase: 06-school-family-organization-university-modules
plan: 06
wave: 3
status: completed
completed_at: 2026-06-08
commits:
  - "feat(reading-hour)(06-06): HMAC-rotating QR + 5min window + attendance unique constraint (ORG-03 part 1)"
  - "feat(reading-hour-media)(06-06): MinIO upload mirror debate-media patterns (ORG-03 part 2)"
  - "feat(frontend)(06-06): QR display + public scan landing (ORG-03 part 3)"
backend_tests: "reading-hour.service.spec 22, reading-hour-media.service.spec 14 — 36 total, all passing"
backend_tsc: clean (no Phase 6 regressions)
frontend_tsc: clean
migrations:
  - 20260608000006_phase6_reading_hour_status (status TEXT + index + PUBLISHED backfill for pre-existing rows)
---

# Plan 06-06 SUMMARY — Wave 3 Reading Hour (Kitob o'qish soati) ORG-03

Wave 3 delivers the QR-attendance + media-evidence + monthly-counts flow that
PQ-9 §9b mandates for every idora. The new piece is the rotating-HMAC QR
primitive (CLAUDE.md §VIII.1 dynamic QR + §XV.R22 screenshot-replay defence);
every other primitive (file-type sniff, 50MB cap, 4-file cap, MinIO key safety,
DRAFT→PUBLISHED gate) is REUSED from Plan 06-04 with model swaps.

## Module split

To keep the rotating-HMAC + media-upload surface isolated from the already-large
`IdoraService`, the entire Reading Hour module landed in a new subdirectory:

```
apps/backend/src/modules/idora/reading-hour/
  ├── reading-hour.service.ts        (CRUD + QR + attendance + monthly summary)
  ├── reading-hour.controller.ts     (10 endpoints — see "Routes" below)
  ├── __tests__/reading-hour.service.spec.ts  (22 specs)
  └── media/
      ├── reading-hour-media.service.ts          (MinIO upload, mirror debate-media)
      └── __tests__/reading-hour-media.service.spec.ts  (14 specs)
```

The legacy ReadingHour methods on `IdoraService` (lines 668-783 — `getReadingHours`,
`createReadingHour`, `markAttendance`, `getReadingHourStats`) are LEFT IN PLACE
for back-compat with existing callers (`getOrgAnalytics` aggregator + the
Plan 06-05 ORG-01 idora controller routes). The new module adds the rotating-QR
+ public scan flow on top — it does NOT replace the existing endpoints.

## T1 — Reading Hour CRUD + HMAC-rotating QR + attendance

### Schema change

`apps/backend/prisma/schema.prisma` — `ReadingHour` gains:

```prisma
// Plan 06-06 ORG-03 — DRAFT (newly created) | PUBLISHED (finalised, ≥1 media)
// | CANCELLED. Monthly summary + PQ-9 PDF only count PUBLISHED.
status        String                @default("DRAFT")
@@index([status])
```

### Migration `20260608000006_phase6_reading_hour_status`

```sql
ALTER TABLE "ReadingHour" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';
CREATE INDEX "ReadingHour_status_idx" ON "ReadingHour"("status");
UPDATE "ReadingHour" SET "status" = 'PUBLISHED' WHERE "createdAt" < CURRENT_TIMESTAMP;
```

Backfill mirrors the Plan 06-04 debate.status pattern — pre-existing dev rows
are marked PUBLISHED so the monthly-summary counts (consumed by Plan 06-05
PQ-9 PDF) don't suddenly collapse.

### HMAC rotation

```typescript
const QR_WINDOW_MS = 5 * 60 * 1000;
private getCurrentWindow(now = Date.now()): number {
  return Math.floor(now / QR_WINDOW_MS) * QR_WINDOW_MS;
}
private signWindow(readingHourId: string, windowStart: number): string {
  return crypto
    .createHmac("sha256", this.qrSecret)
    .update(`${readingHourId}|${windowStart}`)
    .digest("hex");
}
```

`QR_HMAC_SECRET` is read from ConfigService. The dev fallback constant is
`"dev-qr-hmac-secret-rotateMe"` — the service constructor THROWS if NODE_ENV=production
and the env was not overridden, enforcing the Phase 1 INFRA-04 vault contract.

### Token format

```
token = `${base64url(payload)}.${hmacHex}`
where payload = { readingHourId, windowBucket }
```

The payload binds the readingHourId so verify can defend against URL-substitution
attacks (token from event A cannot be replayed against event B).

### Verify

```typescript
private verifyQrToken(readingHourId, token): { readingHourId; windowBucket } {
  // split on "." → exactly 2 parts
  // base64url-decode payload, JSON.parse
  // payload.readingHourId === url-bound id (defense in depth)
  // payload.windowBucket === currentWindow OR previousWindow (5min grace)
  // crypto.timingSafeEqual on Buffer-decoded hmac vs signWindow(id, bucket)
  // any failure → GoneException (410). NEVER reveal which check failed.
}
```

The fail-CLOSED + uniform-error pattern prevents an attacker from oracle-probing
which field is wrong. Constant-time compare via `crypto.timingSafeEqual`.

### Token rotation evidence (from `reading-hour.service.spec.ts`)

| Sample | Result |
|---|---|
| current-window token + valid HMAC | resolves → `{attendeeId, markedAt}` |
| token from current window minus 1 (prior window grace) | resolves (graceful clock-drift) |
| token from current window minus 2 (two-window-stale) | throws `GoneException (410)` |
| current-window payload + tampered HMAC (`0×64`) | throws `GoneException (410)` |
| token with payload.readingHourId='rh-1' submitted to '/reading-hours/rh-OTHER/attend' | throws `GoneException (410)` |

### Attendance route binding

```
POST /reading-hours/:eventId/attend
body: { token }
@CurrentUser (any authenticated user)
```

Service flow:
1. `verifyQrToken(eventId, token)` — throws 410 on any HMAC failure
2. Load event — 404 if missing
3. `status === "DRAFT"` → 400 "Tadbir hali tasdiqlanmagan"
4. `status === "CANCELLED"` → 400 "Tadbir bekor qilingan"
5. **Cross-org defence (T-06-R2)** — `user.organizationId !== event.institutionId` (and not SUPER_ADMIN) → 403 "Sizning idoraga tegishli emas"
6. **Backdated/replay defence (T-06-R4)** — `|event.heldAt - now| > 2h` → 400 "Tadbir vaqtidan tashqarida"
7. `readingHourAttendee.create({eventId, userId, markedAt})` — catches `P2002` → `ConflictException (409)` "Allaqachon belgilangan"
8. Audit log row (`READING_HOUR_ATTEND`)

### Attendance unique constraint

Schema already has `@@unique([readingHourId, userId])` on `ReadingHourAttendee`
(from Plan 06-01). The service relies on Prisma's `P2002` error code to map dupe
inserts to a 409 ConflictException — no migration needed.

### Monthly summary (consumed by Plan 06-05 PQ-9 PDF)

```typescript
getReadingHoursSummary(institutionId, user?): {
  thisMonth: number;
  total: number;
  lastEventAt: Date | null;
  byMonth: Array<{ ym: "2026-06", count: 3 }>;  // last 12 months chronological
}
```

- Cache-remember 300s.
- `WHERE status: "PUBLISHED"` filter — DRAFT and CANCELLED rows excluded.
- The byMonth fills missing months with `count: 0` so the PDF always renders 12 columns.

### Sample summary output

```json
{
  "thisMonth": 2,
  "total": 14,
  "lastEventAt": "2026-06-04T14:30:00.000Z",
  "byMonth": [
    {"ym":"2025-07","count":1},{"ym":"2025-08","count":1},
    {"ym":"2025-09","count":2},{"ym":"2025-10","count":1},
    {"ym":"2025-11","count":1},{"ym":"2025-12","count":1},
    {"ym":"2026-01","count":1},{"ym":"2026-02","count":1},
    {"ym":"2026-03","count":1},{"ym":"2026-04","count":1},
    {"ym":"2026-05","count":1},{"ym":"2026-06","count":2}
  ]
}
```

## T2 — Reading Hour media upload (mirrors Plan 06-04 debate-media)

`apps/backend/src/modules/idora/reading-hour/media/reading-hour-media.service.ts`
is a near-verbatim copy of `DebateMediaService` with these substitutions:

| Aspect | Debate (Plan 06-04) | Reading Hour (Plan 06-06) |
|---|---|---|
| Parent model | Debate / DebateMedia | ReadingHour / ReadingHourMedia |
| Bucket | `MinioService.bucketDebates` | `MinioService.bucketReadingHours` |
| Key path | `{instId}/{debateId}/{cuid}.{ext}` | `reading-hours/{instId}/{eventId}/{cuid}.{ext}` |
| Sharp thumbnail | yes (200×200 jpeg) | NO (videos are likely larger than photos here — skipped per plan tradeoff) |
| Whitelist | jpeg/png/webp/mp4/webm/quicktime | identical |
| Caps | 50MB / 4 files | identical |
| File-type sniff | `fileTypeFromBuffer` magic bytes | identical |
| Scope guard | `assertInstitutionInScope` BEFORE buffer touch | identical |

### Sample MinIO putObject call

```
putObject(
  "readinghour-media",
  "reading-hours/inst-1/rh-1/{24-hex-cuid}.jpg",
  <Buffer>,
  "image/jpeg",
  { readingHourId: "rh-1", uploadedBy: "user-1" }
)
```

The user's `originalname` is DISCARDED — even path-traversal payloads like
`"../../etc/passwd.jpg"` resolve to `reading-hours/inst-1/rh-1/{cuid}.jpg`
(test asserts `key.includes("passwd")` is false).

### Endpoints

| Verb | Path | Roles | Description |
|---|---|---|---|
| POST | `/idora/:institutionId/reading-hours` | HR_ADMIN | Create DRAFT event |
| GET | `/idora/:institutionId/reading-hours` | VIEWERS | List w/ month + status filter |
| GET | `/idora/:institutionId/reading-hours/summary` | VIEWERS | Monthly counts (Plan 06-05 consumer) |
| GET | `/idora/:institutionId/reading-hours/:eventId` | VIEWERS | Detail + attendees + media |
| POST | `/idora/:institutionId/reading-hours/:eventId/qr` | HR_ADMIN | New rotating QR token |
| POST | `/idora/:institutionId/reading-hours/:eventId/media` | HR_ADMIN | Upload photo/video |
| GET | `/idora/:institutionId/reading-hours/:eventId/media` | VIEWERS | List presigned URLs |
| GET | `/idora/:institutionId/reading-hours/:eventId/media/:mediaId/signed-url` | VIEWERS | Single signed URL |
| PATCH | `/idora/:institutionId/reading-hours/:eventId/finalize` | HR_ADMIN | DRAFT→PUBLISHED (≥1 media) |
| DELETE | `/idora/:institutionId/reading-hours/:eventId` | HR_ADMIN | Soft delete (DRAFT only unless SUPER_ADMIN) |
| POST | `/reading-hours/:eventId/attend` | any auth | Public scan POST |

## T3 — Frontend pages

### `apps/frontend/app/[locale]/dashboard/idora/reading-hour/page.tsx`

HR admin entry point. Lists events with month + status filter; "Yangi tadbir"
modal POSTs to `/idora/:institutionId/reading-hours`. Each row links to the
event detail page.

### `apps/frontend/app/[locale]/dashboard/idora/reading-hour/[id]/page.tsx`

Three sections:

1. **QR display** — polls `POST /idora/:instId/reading-hours/:id/qr` every
   240_000ms (4 minutes — just before the 5-min server-side rotation flips).
   Renders the scan URL as a `<img src="qrserver">` QR + countdown label
   ("{n} soniyadan keyin yangilanadi"). The encoded URL is:
   `${origin}/uz-Latn/scan/reading-hour/${eventId}?t=${urlencode(token)}`

2. **Attendance list** — table of `{userId, markedAt}`.

3. **Media gallery** — file input (multipart via `apiClient` FormData) with
   client-side MIME whitelist; presigned-URL `<img>` / `<video>` tiles.
   "Tasdiqlash" button disabled until media count ≥ 1; PATCHes finalize.

### `apps/frontend/app/[locale]/scan/reading-hour/[id]/page.tsx`

Public employee-facing scan landing. Reads `?t=` query param, POSTs to
`/reading-hours/:id/attend`, handles four states with Uzbek copy:

| HTTP | UI message |
|---|---|
| 200 / 201 | "Tadbirga qatnashganingiz qayd etildi. Rahmat!" + green ✓ |
| 401 | "Tadbirga qatnashish uchun avval tizimga kiring." + login button |
| 403 | "Sizning idoraga tegishli emas." + red ✕ |
| 409 | "Siz allaqachon ushbu tadbirga qatnashgansiz." + blue ℹ |
| 410 | "QR muddati o'tdi. Yangi QR ni so'rang." + yellow ⚠ |

## Module wiring

`apps/backend/src/modules/idora/idora.module.ts`:

```typescript
controllers: [IdoraController, ReadingHourController],
providers: [
  IdoraService,
  MukofotService,
  ReadingHourService,
  ReadingHourMediaService,
],
exports: [IdoraService, MukofotService, ReadingHourService],
```

`ReadingHourService` is exported so Plan 06-05 PQ-9 PDF composer can call
`readingHourService.getReadingHoursSummary(institutionId)` directly when it
needs the chronological 12-month breakdown.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/prisma/schema.prisma` | ReadingHour.status column + @@index |
| `apps/backend/prisma/migrations/20260608000006_phase6_reading_hour_status/migration.sql` | NEW |
| `apps/backend/.env.example` | + QR_HMAC_SECRET block |
| `apps/backend/.env` | + QR_HMAC_SECRET dev value |
| `apps/backend/src/modules/idora/reading-hour/reading-hour.service.ts` | NEW — CRUD + HMAC QR + attendance + summary |
| `apps/backend/src/modules/idora/reading-hour/reading-hour.controller.ts` | NEW — 10 endpoints + public scan POST |
| `apps/backend/src/modules/idora/reading-hour/__tests__/reading-hour.service.spec.ts` | NEW — 22 specs |
| `apps/backend/src/modules/idora/reading-hour/media/reading-hour-media.service.ts` | NEW — MinIO + sniff + caps |
| `apps/backend/src/modules/idora/reading-hour/media/__tests__/reading-hour-media.service.spec.ts` | NEW — ~16 specs |
| `apps/backend/src/modules/idora/idora.module.ts` | + ReadingHourController + 2 providers |
| `apps/frontend/app/[locale]/dashboard/idora/reading-hour/page.tsx` | NEW — HR admin list + create modal |
| `apps/frontend/app/[locale]/dashboard/idora/reading-hour/[id]/page.tsx` | NEW — QR + attendance + media |
| `apps/frontend/app/[locale]/scan/reading-hour/[id]/page.tsx` | NEW — public scan landing |

## Grep gate results

| Gate | Pattern | Path | Count | Status |
|---|---|---|---|---|
| HMAC compare | `timingSafeEqual` | `reading-hour.service.ts` | 3 | OK (≥1 required) |
| 5min window const | `5 \* 60 \* 1000` / `300000` | `reading-hour.service.ts` | 1 | OK (≥1 required) |
| Scope guard | `assertInstitutionInScope` | `reading-hour.service.ts` | 3 | OK (≥2 required) |
| File-type sniff | `fileTypeFromBuffer` | `reading-hour-media.service.ts` | 2 | OK (≥1 required) |
| Attendee unique | `@@unique([readingHourId, userId])` | `schema.prisma` line 824 | 1 | OK (pre-existing from Plan 06-01) |

## Threat model — what shipped

| Threat | Mitigation in this plan |
|---|---|
| T-06-R1 (screenshot replay) | 5-min rotating HMAC + 1-window grace; `timingSafeEqual` constant-time |
| T-06-R2 (cross-org scan) | `user.organizationId !== event.institutionId` → 403 (SUPER_ADMIN bypass) |
| T-06-R3 (dupe attendance) | Prisma `P2002` on `@@unique([readingHourId, userId])` → 409 |
| T-06-R4 (backdated event) | `\|event.heldAt - now\| > 2h` → 400 |
| T-06-R5 (HMAC secret leak) | Vault storage in prod; throw at boot when prod sees the dev fallback string |
| T-06-R6 (file MIME spoof) | `fileTypeFromBuffer` whitelist + declared-vs-detected mismatch reject |
| T-06-R6b (path traversal) | MinIO key always `reading-hours/{inst}/{event}/{cuid}.{ext}` |
| T-06-R6c (DoS via large upload) | `FileInterceptor({ fileSize: 50_000_000 })` middleware + service re-check |
| T-06-R6d (DoS via many files) | `count(readingHourId)` ≥ 4 → 400 |
| T-06-R7 (URL TTL leak) | `MinioService.presignedGetUrl` hard-cap 3600s |
| T-06-R8 (subscription gate bypass) | `assertSubscriptionActive` on `createReadingHour` (SUPER_ADMIN bypass for ops support) |

## Decisions applied

- **D-Q1 reused**: 50MB per file + 4 files per event; whitelist MIME via `file-type` magic-byte sniff.
- **D-OQ-1 reused**: This module does NOT write `OrgRating` rows — Phase 3
  InstitutionalService remains the sole writer.
- **QR rotation per CLAUDE.md §VIII.1**: 5-minute window with 1-window
  clock-drift grace — same primitive as the TOTP-style rotating QR pattern
  in CLAUDE.md §XV.R22.

## What's NOT in this plan (intentionally)

- Sharp thumbnail for reading-hour media — videos dominate; client renders
  with HTML5 `<video>` poster placeholder.
- O(1) WebSocket attendance stream — V2; HR admin polls the detail page every
  ~10s via React Query default `staleTime`.
- Multi-day events — `heldAt` is a single timestamp; multi-session events use
  separate ReadingHour rows.
- Soft-delete for PUBLISHED events without SUPER_ADMIN — Plan 06-05 audit
  workflow already covers the "wrong event date" correction flow.

## Follow-ups unblocked by Wave 3

- Plan 06-05 PQ-9 PDF can now call `ReadingHourService.getReadingHoursSummary`
  for the monthly-breakdown widget (was previously stubbed with the legacy
  `IdoraService.getReadingHourStats` 3-field shape).
- Phase 6 closeout — the public `/reading-hours/:id/attend` route is the
  template for the BookCorner verification scan flow (Plan 06-07-future).
