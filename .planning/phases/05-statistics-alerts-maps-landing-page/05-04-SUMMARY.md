---
phase: 05-statistics-alerts-maps-landing-page
plan: 04
status: completed
completed_at: 2026-06-07
backend_tests: "1371 passing (baseline 1339, delta +32)"
backend_tsc: clean
frontend_tsc: clean
frontend_build: succeeds (dashboard layout emits FcmTokenRegistrar in x4 locales)
notification_processor_stubs: "0 (sendPush + sendEmail wired to live clients)"
escapeHtml_inline_dupes: "0 (single source of truth at common/utils/escape-html.util.ts)"
---

# Plan 05-04 SUMMARY — Notification Wiring Closure (NOTIF-02 + NOTIF-03)

Closes the Wave-0 stub TODOs in `notification.processor.ts` by wiring
`sendPush` to `FcmClient` and `sendEmail` to `MailClient`, lands the FCM
token CRUD endpoints, ships the browser-side FCM registrar, and consolidates
`escapeHtml` into a single source of truth at `common/utils`.

Four feat commits + this SUMMARY commit:
1. `feat(notifications)(05-04): sendPush via FcmClient + InvalidFcmTokenError cleanup (NOTIF-02)`
2. `feat(notifications)(05-04): sendEmail via MailClient + escapeHtml default + ADMIN_NOTIFICATION_EMAILS fallback (NOTIF-03)`
3. `feat(users)(05-04): device-token CRUD + cross-user transfer audit + test-push (NOTIF-02)`
4. `feat(frontend)(05-04): FCM browser registrar + dashboard auto-register (NOTIF-02)`

## T1 — `notification.processor.sendPush` real wiring (NOTIF-02)

### `apps/backend/src/infra/queue/notification.processor.ts`

The TODO stub at lines 71–74 is gone. Constructor now takes `FcmClient`,
`MailClient`, and `PrismaService` in addition to `EskizSmsClient`.

```ts
private async sendPush(data: NotificationJobData): Promise<void> {
  const title = data.title ?? data.subject ?? "SIFAT LIBRARY";
  const body = data.message ?? "";

  if (data.deviceToken) {
    await this._pushToToken(data.deviceToken, title, body);
    return;
  }
  if (!data.userId) {
    this.logger.warn("[notification] push job missing target ...");
    return;
  }

  const tokens = await this.prisma.deviceToken.findMany({
    where: { userId: data.userId },
    orderBy: { lastSeen: "desc" },
    take: 10, // PUSH_PER_USER_TOKEN_CAP
    select: { id: true, token: true },
  });
  for (const row of tokens) {
    await this._pushToToken(row.token, title, body);
  }
}
```

`_pushToToken` catches `InvalidFcmTokenError`, deletes the dead row via
`prisma.deviceToken.deleteMany({ where: { token } })`, swallows the error,
and lets the fan-out loop continue. Other errors re-throw so BullMQ's
exponential-backoff retry policy from Phase 1 NOTIF-04 applies.

`lastSeen` is updated fire-and-forget on success (failure to update never
blocks the actual send).

### Specs (`notification.processor.spec.ts`)

5 new sendPush cases:
- single-target: `deviceToken` → exactly one `fcm.sendToToken` call, no DB read
- fan-out: `userId` only → top-10 by `lastSeen` DESC, push to each
- InvalidFcmTokenError → row deleted, loop continues, total invocations = N
- bug-tolerant: no target → warn + return (no throw)
- generic error → re-throws for BullMQ retry

## T2 — `notification.processor.sendEmail` real wiring + escapeHtml consolidation (NOTIF-03)

### `apps/backend/src/common/utils/escape-html.util.ts` — NEW

```ts
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

JSDoc notes it is NOT idempotent on `&` — callers must escape exactly once.
`PdfService` now imports from here; the inline duplicate at
`pdf.service.ts:9-16` is removed.

### `notification.processor.sendEmail`

Replaces the TODO stub at lines 76–79:

```ts
private async sendEmail(data: NotificationJobData): Promise<void> {
  const subject = data.subject ?? `[SIFAT LIBRARY] ${data.jobType ?? "Notification"}`;
  const html = data.html ?? `<pre>${escapeHtml(data.message ?? "")}</pre>`;

  if (data.email) {
    await this.mail.send({ to: data.email, subject, html, attachments: data.attachments });
    return;
  }
  // Admin-fallback path: env CSV in ADMIN_NOTIFICATION_EMAILS when data.admin === true.
  ...
}
```

Defaults:
- `subject` = `[SIFAT LIBRARY] <jobType ?? "Notification">`
- `html` = `<pre>${escapeHtml(message)}</pre>` — defense-in-depth if caller forgets
- `attachments` + `jobType` passed through unchanged (Plan 05-08 PDF reports)

Admin fallback (Q7): `data.admin === true` + no `email` → broadcast to every
trimmed entry in `ADMIN_NOTIFICATION_EMAILS` env CSV. Unset env → warn + no-op.

### Specs (`escape-html.util.spec.ts` + `notification.processor.spec.ts`)

- 8 escape-html util cases (5 escape rules + nullish + injection neutralization + non-idempotent on `&`)
- 8 sendEmail cases (default body escapes, caller html as-is, subject override,
  jobType default, attachments pass-through, no-target warn, admin CSV
  broadcast, admin CSV unset warn)

## T3 — FCM token CRUD + cross-user transfer audit + admin test-push (NOTIF-02)

### `apps/backend/src/modules/users/dto/register-fcm-token.dto.ts` — NEW

```ts
@IsString @Length(100, 250) @Matches(/^[A-Za-z0-9_:.-]+$/)  token!: string;
@IsIn(["web", "android", "ios"])                            platform!: "web" | "android" | "ios";
```

### `users.service.ts` — added FCM CRUD

- `upsertFcmToken({ userId, token, platform })`:
  - new token → `prisma.deviceToken.create`
  - same userId → `update` (refresh `platform` + `lastSeen`)
  - **cross-user** → write `AiAuditLog` row with `issueType: "DEVICE_TOKEN_TRANSFER"`,
    masked both user ids (`***<last8>`), then move the token to the new owner.
    Audit-row creation is best-effort (`.catch(warn)`) so a logging failure
    never blocks the legitimate device-swap flow.
- `deleteFcmToken(userId, tokenId)`:
  - 404 on not-found AND on `row.userId !== userId` (hides existence per
    T-05-FCM-DELETE / ASVS V4 — NEVER 403).
- `listMyFcmTokens(userId)`:
  - `select { id, platform, lastSeen, createdAt }` — token plaintext NEVER
    leaves the trust boundary.

### `users.controller.ts` — 3 new endpoints

```
POST   /users/me/device-tokens          (JwtAuthGuard, RegisterFcmTokenDto)
DELETE /users/me/device-tokens/:id      (JwtAuthGuard, 204 No Content)
GET    /users/me/device-tokens          (JwtAuthGuard)
```

### `admin.controller.ts` — POST `/admin/test-push`

`@Roles(SUPER_ADMIN)` only. `TestPushDto { userId, title?, message }`.
- 404 if `userId` is unknown.
- Enqueues `NOTIFICATION_QUEUE.add("test-push", { type: "push", userId, message, title, jobType: "test-push" })`.
- `AdminModule` now registers `NOTIFICATION_QUEUE` so `AdminController` can `@InjectQueue`.

Used by ops for FCM live verification AND by the Plan 05-05 ALERT-06
system-down test path.

### Specs

- `users.controller.spec.ts` +3 (POST delegates with sub, DELETE delegates, GET list no-token)
- `users.service.spec.ts` +7 (upsert: new/same/transfer × 3, delete: not-found/wrong-owner/own × 3, list × 1)
- `admin.controller.spec.ts` NEW +3 (enqueue payload, default title, 404 on missing user)

## T4 — Frontend FCM client + dashboard registrar (NOTIF-02)

### `apps/frontend/lib/fcm-client.ts` — NEW

Three exports:
- `getFcmToken(): Promise<string | null>` — lazy-imports `firebase/app` +
  `firebase/messaging`, returns the token or null. Silent no-op when running
  SSR, missing any `NEXT_PUBLIC_FCM_VAPID_KEY` / `NEXT_PUBLIC_FIREBASE_*`
  env, missing `Notification` API, or `permission !== "granted"`.
- `registerFcmToken(token, platform = "web"): Promise<void>` — POSTs to
  `/users/me/device-tokens`. localStorage caches the last-registered token
  under `sifat.fcm.lastToken` so re-mount is a no-op.
- `requestPushPermissionAndRegister(): Promise<{ token, granted }>` —
  explicit user-initiated flow. NEVER called from FcmTokenRegistrar.

### `apps/frontend/components/fcm/FcmTokenRegistrar.tsx` — NEW

`"use client"`, renders `null`. `useEffect` on mount:
1. SSR / no `Notification` API → return
2. `Notification.permission !== "granted"` → return (NEVER prompts)
3. `getFcmToken()` → `registerFcmToken(token, "web")`

Cleanup flips a `cancelled` flag so an unmount mid-flight is safe.

### `apps/frontend/app/[locale]/dashboard/layout.tsx`

Imports `FcmTokenRegistrar` and mounts `<FcmTokenRegistrar />` inside the
authenticated layout boundary — only authenticated dashboard users trigger
the silent registration.

### Build

- `firebase` ^12.14.0 added to `apps/frontend/package.json` (pre-approved
  by user in Plan 05-01 slopcheck spillover).
- `npx tsc --noEmit` clean.
- `npm run build` clean (dashboard layout emits the registrar across the 4
  locales).

### Service worker deferral

Per RESEARCH §NOTIF-02 gotcha + Q4, web push service worker
(`public/firebase-messaging-sw.js`) is intentionally deferred to Phase 7
PWA. Without an SW, some browsers return null from `getToken()` — we
silently no-op rather than surfacing an error. Web push for V1 only
operates while the page is open; native mobile clients in Phase 6+ will
receive pushes via the same backend pipeline correctly.

## Threat model (resolved this plan)

| Threat ID            | Mitigation shipped                                                            |
|----------------------|-------------------------------------------------------------------------------|
| T-05-06              | FcmClient already masks tokens at info level; processor never logs raw token  |
| T-05-FCM-TRANSFER    | Cross-user `upsertFcmToken` writes `DEVICE_TOKEN_TRANSFER` AiAuditLog row    |
| T-05-FCM-DELETE      | DELETE returns 404 for both not-found AND wrong-owner (hides existence)      |
| T-05-07              | `sendEmail` default body wraps message in `<pre>${escapeHtml(...)}</pre>`    |
| T-05-EMAIL-HDR       | MailClient already strips CR/LF — no change here                              |
| T-05-INVALID-TOK     | Dead-token DeviceToken row deleted; fan-out loop continues per-token         |
| T-05-TOK-FLOOD       | `PUSH_PER_USER_TOKEN_CAP = 10` cap on fan-out                                |
| T-05-TEST-PUSH       | `@Roles(SUPER_ADMIN)` on POST /admin/test-push                               |

## Verification

- Backend `npm test` — **1371 passing** (baseline 1339, delta **+32**).
- Backend `npx tsc --noEmit` — clean.
- Frontend `npx tsc --noEmit` — clean.
- Frontend `npm run build` — clean (4 locales, dashboard layout includes registrar).
- Grep gates:
  - `grep -c "fcm\\.send\\|this\\.fcm" notification.processor.ts` → 5 (fcm injected and used)
  - `grep -c "mail\\.send\\|this\\.mail" notification.processor.ts` → 4 (mail injected and used)
  - `grep -c "device-tokens" users.controller.ts` → 3 (POST/DELETE/GET)
  - `find apps/backend -name escape-html.util.ts` → 1 (single source of truth)

## Downstream unblocked

- **Plan 05-05 (alert engine)** — KRITIK email + OGOHLANTIRISH push routes
  now have a live processor sitting on the queue.
- **Plan 05-08 (monthly PDF reports)** — `sendEmail` attachments pass-through
  ready; PDF Buffer goes straight to nodemailer.
- **Plan 05-09 (B2B demo CRM)** — admin-fallback path picks up
  `ADMIN_NOTIFICATION_EMAILS` env for demo-request notifications.

## Files modified / created

### Backend
- `apps/backend/src/infra/queue/notification.processor.ts` — sendPush + sendEmail wired
- `apps/backend/src/infra/queue/notification.processor.spec.ts` — +13 tests
- `apps/backend/src/common/utils/escape-html.util.ts` — NEW (single source of truth)
- `apps/backend/src/common/utils/__tests__/escape-html.util.spec.ts` — NEW (+8 tests)
- `apps/backend/src/infra/pdf/pdf.service.ts` — imports from new util, inline def removed
- `apps/backend/src/modules/users/dto/register-fcm-token.dto.ts` — NEW
- `apps/backend/src/modules/users/users.service.ts` — +3 methods (upsert/delete/list)
- `apps/backend/src/modules/users/users.controller.ts` — +3 endpoints
- `apps/backend/src/modules/users/__tests__/users.controller.spec.ts` — +3 tests
- `apps/backend/src/modules/users/__tests__/users.service.spec.ts` — +7 tests
- `apps/backend/src/modules/admin/dto/test-push.dto.ts` — NEW
- `apps/backend/src/modules/admin/admin.controller.ts` — +1 endpoint + queue injection
- `apps/backend/src/modules/admin/admin.module.ts` — registers NOTIFICATION_QUEUE
- `apps/backend/src/modules/admin/__tests__/admin.controller.spec.ts` — NEW (+3 tests)

### Frontend
- `apps/frontend/lib/fcm-client.ts` — NEW
- `apps/frontend/components/fcm/FcmTokenRegistrar.tsx` — NEW
- `apps/frontend/app/[locale]/dashboard/layout.tsx` — mounts registrar
- `apps/frontend/package.json` — `firebase ^12.14.0`
- `package-lock.json` — workspace lockfile updated
