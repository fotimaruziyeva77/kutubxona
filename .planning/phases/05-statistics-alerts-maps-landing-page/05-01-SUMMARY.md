---
phase: 05-statistics-alerts-maps-landing-page
plan: 01
status: completed
completed_at: 2026-06-07
commits:
  - 205a82d chore(deps)(05-01): install firebase-admin nodemailer react-leaflet mapshaper
  - e751c13 feat(infra)(05-01): FcmClient + MailClient (NOTIF-02/03 scaffolds)
  - 99f6418 feat(prisma)(05-01): DeviceToken model + ALERT_TYPES + cache/kafka ext
  - f6e1d30 feat(frontend)(05-01): GeoJSON viloyat build script + materialized asset
backend_tests: "1217 passing (baseline 1169, delta +48)"
frontend_tests: "9 passing (new geojson contract spec)"
backend_tsc: clean
frontend_tsc: clean
prisma_validate: clean
migration: 20260607120000_phase5_devicetoken applied
---

# Plan 05-01 SUMMARY — Wave 0 Foundations

Six Wave-0 primitives that every Plan 05-02..05-09 composes. All four T1–T4
tasks completed sequentially; backend full suite green at 1217 tests (+48
from baseline); frontend geojson spec green at 9 tests; backend + frontend
`tsc --noEmit` clean; `npx prisma validate` clean.

## Checkpoint resolutions

- **T1 — Package legitimacy slopcheck (pre-approved)**. The plan-level
  `checkpoint:human-verify` gate was resolved by the user up-front with the
  resume-signal `approved, install all 4` for:
  - `firebase-admin@^13.10.0` (Google official, 100M+ weekly downloads)
  - `nodemailer@^8.0.10` + `@types/nodemailer@^8.0.0` (canonical Node SMTP)
  - `react-leaflet@^4.2.1` (React 18 compatible; `leaflet@^1.9.4` already
    present in the frontend deps from an earlier phase)
  - `mapshaper@^0.7.22` (frontend devDep, GeoJSON simplification)
  - **Deviation**: the plan additionally listed `firebase` (browser SDK) for
    `messaging.getToken({ vapidKey })`. The user pre-approval was for FOUR
    packages and listed `leaflet ^1.9 + react-leaflet ^4` instead. The
    browser-side `firebase` install is therefore deferred to Plan 05-04
    (frontend FCM wiring); current scaffolds are backend-only.
  - **Deviation**: `--legacy-peer-deps` was required to install `react-leaflet`
    because `@types/leaflet` peer ranges don't satisfy strict NPM resolution
    under the workspace.
  - **Topology note**: the repo uses npm workspaces — there is a single root
    `package-lock.json`; backend/frontend do not own their own lockfiles.

## T2 — FcmClient + MailClient + main banners + production env

New infra clients mirroring `EskizSmsClient` lazy-init / dev-no-op /
prod-fail-hard pattern from Phase 1 INFRA-NOTIF.

**FcmClient** (`apps/backend/src/infra/notifications/fcm.client.ts`):
- Reads `FCM_SERVICE_ACCOUNT_KEY_PATH` via `ConfigService` in the constructor;
  `onModuleInit` lazy-loads the JSON file and calls
  `admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })`
- Env unset → logs `[fcm dev no-op] FCM_SERVICE_ACCOUNT_KEY_PATH not set —
  push notifications disabled` and returns without throwing
- `sendToToken({ token, payload })` and `sendToTopic(topic, payload)` short-
  circuit when the app is not initialized
- On `messaging/registration-token-not-registered` /
  `messaging/invalid-registration-token` / `messaging/invalid-argument` →
  throws `InvalidFcmTokenError` so Plan 05-04 processor can prune the dead
  row; other errors rethrow
- Token NEVER logged at info-level — masked as `***<last8>`
- Exports `InvalidFcmTokenError` class

**MailClient** (`apps/backend/src/infra/notifications/mail.client.ts`):
- Reads `SMTP_HOST/PORT/USER/PASS/SECURE/FROM` via `ConfigService`;
  `onModuleInit` lazily creates the `nodemailer.Transporter`
- Env unset → `[mail dev no-op] SMTP_HOST not set — email delivery disabled`
- `send({ to, subject, html, attachments? })` rejects CR/LF in `to`/`subject`/
  `from` BEFORE the no-op gate so header-injection (T-05-07) is caught in dev
  too; sanitizes via `_sanitizeHeader` (strips CR/LF) defense-in-depth
- Recipient masked in logs as `local@***`
- Default `SMTP_FROM` = `SIFAT LIBRARY <noreply@sifat.uz>`; `SMTP_PORT` default
  = 587 so `SMTP_PORT` is NOT in `PRODUCTION_REQUIRED_ENV`

**NotificationsModule** (`apps/backend/src/infra/notifications/notifications.module.ts`):
imports `ConfigModule`, provides + exports `FcmClient` and `MailClient`;
registered in `AppInfraModule` alongside `PrismaModule/CacheModule/KafkaModule`.

**`main.ts` banners**:
- `DEV_FCM_STUB ACTIVE` when `FCM_SERVICE_ACCOUNT_KEY_PATH` unset AND
  `isProductionEnv()` returns false (mirrors `DEV_DONATION_PAYMENT_STUB`
  banner shape)
- `DEV_MAIL_STUB ACTIVE` mirrors same pattern for `SMTP_HOST`

**`PRODUCTION_REQUIRED_ENV` additions** (boot fail-hard via `_assertEnvVars`):
- `FCM_SERVICE_ACCOUNT_KEY_PATH`
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `SMTP_PORT` deliberately omitted — has default of 587

**`.env.example` additions**: `FCM_SERVICE_ACCOUNT_KEY_PATH`,
`NEXT_PUBLIC_FCM_VAPID_KEY`, `NEXT_PUBLIC_FIREBASE_API_KEY/AUTH_DOMAIN/
PROJECT_ID/MESSAGING_SENDER_ID/APP_ID`, `SMTP_HOST/PORT/SECURE/USER/PASS/
FROM`, `ADMIN_NOTIFICATION_EMAILS`. Each documented with fail-closed
production semantics and Vault file-projection guidance.

**Specs**: 15 new tests in `fcm.client.spec.ts`, 12 in `mail.client.spec.ts`,
7 new tests appended to `main.spec.ts` asserting `PRODUCTION_REQUIRED_ENV`
gains the FCM + SMTP keys, `SMTP_PORT` is NOT required, and missing
`FCM_SERVICE_ACCOUNT_KEY_PATH` / `SMTP_HOST` / `SMTP_PASS` / `SMTP_FROM` all
throw at boot.

## T3 — DeviceToken migration + ALERT_TYPES + Cache/Kafka extensions

**Prisma DeviceToken model** (`apps/backend/prisma/schema.prisma`):

```prisma
model DeviceToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token     String   @unique
  platform  String   // "web" | "android" | "ios"
  lastSeen  DateTime @default(now())
  createdAt DateTime @default(now())

  @@index([userId])
  @@index([token])
}
```

`User` model gains `deviceTokens DeviceToken[]` back-relation.

**Migration**: `prisma/migrations/20260607120000_phase5_devicetoken/migration.sql`.

**Migration workaround**: `prisma migrate dev --create-only` failed because of
the pre-existing Phase 2 baseline shadow-DB issue (`column "penaltyDays"
does not exist` in `20260607000000_phase2_extended_flag_and_check_constraint`).
This is the same blocker Phase 4 hit. Workaround: created the migration SQL
manually (matching what Prisma would have generated for this model — `CREATE
TABLE`, `CREATE UNIQUE INDEX` on token, `CREATE INDEX` on userId + token,
`ALTER TABLE ... ADD CONSTRAINT FK ON DELETE CASCADE`), then applied via
`npx prisma migrate deploy`. Output:

```
Applying migration `20260607120000_phase5_devicetoken`
The following migration(s) have been applied:
  migrations/
    └─ 20260607120000_phase5_devicetoken/
       └─ migration.sql
All migrations have been successfully applied.
```

`npx prisma validate` reports `The schema at prisma\schema.prisma is valid 🚀`.
`npx prisma generate` produces a fresh client with the `deviceToken` model
accessible. (Direct `psql` verification was unavailable in the executor
sandbox; verification path is the successful `migrate deploy` + `validate`.)

**ALERT_TYPES const** (`apps/backend/src/common/constants/alert-types.const.ts`):

```ts
export const ALERT_TYPES = {
  LIBRARY_INACTIVE:      "LIBRARY_INACTIVE",
  RI_DROPPED:            "RI_DROPPED",
  FUND_SHORTAGE:         "FUND_SHORTAGE",
  CLUB_INACTIVE:         "CLUB_INACTIVE",
  RI_RISING:             "RI_RISING",
  SYSTEM_DOWN:           "SYSTEM_DOWN",
  INVENTORY_DISCREPANCY: "INVENTORY_DISCREPANCY",
  ORDER_REQUEST:         "ORDER_REQUEST",
} as const;
export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

export const ALERT_SEVERITY = {
  KRITIK:        "KRITIK",
  OGOHLANTIRISH: "OGOHLANTIRISH",
  AXBOROT:       "AXBOROT",
} as const;
export type AlertSeverity = (typeof ALERT_SEVERITY)[keyof typeof ALERT_SEVERITY];
```

`INVENTORY_DISCREPANCY` preserved verbatim per FRAUD-08 (Plan 03-01) regression
guard. Used by Plan 05-05 to consolidate the dual alert engines.

**CacheService extensions** (`apps/backend/src/infra/cache/cache.service.ts`):

New keys:
- `mahallaStats(id) → "stats:mahalla:${id}"` (STAT-03 per Q3)
- `landingPublic() → "landing:public"` (LAND-01)
- `genreTrend(scope, scopeId) → "stats:genres:trend:${scope}:${scopeId}"` (STAT-06)
- `ageBreakdown(scope, scopeId) → "stats:age:${scope}:${scopeId}"` (STAT-05)
- `genderBreakdown(scope, scopeId) → "stats:gender:${scope}:${scopeId}"` (STAT-04)
- `alertDedupe(alertType, scopeId, day) → "alert:dedupe:${alertType}:${scopeId}:${day}"`
  (ALERT-01..06 per Q3 dedup)

New TTLs:
- `stats5min = 300`, `stats15min = 900`, `stats30min = 1800` (OQ-3 / D-1
  hybrid pre-agg tiers)
- `landingPublic = 30` (high-traffic, near-live)

Existing keys + TTLs preserved (verified by regression tests).

**KAFKA_TOPICS extensions** (`apps/backend/src/infra/kafka/kafka.service.ts`):

```ts
RI_RISING:          "ri.rising",
SYSTEM_DOWN:        "system.down",
ALERT_FIRED:        "alert.fired",
ALERT_ACKNOWLEDGED: "alert.acknowledged",
```

Constants only — no emit helpers added per Plan 03-01 hygiene; Plan 05-05/07
will wire them next to consumer code.

**Specs**: 8 new tests in `alert-types.const.spec.ts`, 16 new tests appended
to `cache.service.spec.ts` (regression + new key/TTL coverage), 6 new tests
in `kafka.service.spec.ts`.

## T4 — GeoJSON viloyat build script + materialized asset

**Build script** (`apps/frontend/scripts/build-geojson.mjs`, Node ESM):
- Fetches `akbartus/GeoJSON-Uzbekistan/geojson/uzbekistan_regional.geojson`
  (per D-4) with a `main` → `master` fallback URL
- The akbartus source uses `{ ADM1_EN, ADM1_RU, ADM1_UZ }` properties — the
  script maps `ADM1_EN` to the `Viloyat.code` shape via a hand-curated
  `VILOYAT_CODE_BY_NAME` lookup so Plan 05-06 can `JOIN Viloyat ON
  Viloyat.code = feature.properties.code` directly
- Drops ADM1_* properties and keeps only `{ code, name, name_ru }` per
  feature to minimize payload
- Runs `mapshaper -simplify 20% keep-shapes` via the Node API
  (`mapshaper.applyCommands`)
- Validates: 14 features, every feature has `code` matching `/^[0-9]{2}$/`
  + non-empty `name`, gzip size ≤ 100KB ceiling
- Documents tuman regeneration command in a commented section (deferred to
  V2 per Q4)
- npm script: `"build:geojson": "node scripts/build-geojson.mjs"`

**Output (committed)**: `apps/frontend/public/geojson/uzbekistan-viloyats.geojson`
- Source URL: `https://raw.githubusercontent.com/akbartus/GeoJSON-Uzbekistan/main/geojson/uzbekistan_regional.geojson`
- 14 features with codes `01..14` matching `apps/backend/prisma/seed.ts` viloyats
- Polygon / MultiPolygon geometries
- Names in Latin (Toshkent shahar, Navoiy, etc.) + name_ru
- Raw size: 136,852 bytes
- Gzip size: 46,438 bytes (well under 100KB ceiling)

**Spec** (`apps/frontend/public/geojson/__tests__/geojson.spec.js`, 9 tests):
- **Deviation**: spec is `.js` not `.ts` because the frontend jest config
  has no TS preset — it's a static-file contract assertion, no TS-only code
- Asserts FeatureCollection shape, 14 features, code regex, name non-empty,
  unique codes, full 01..14 coverage, geometry types, size

## Verification matrix

| Surface                         | Result                              |
|---------------------------------|-------------------------------------|
| Backend full suite (`npm test`) | 1217 passing (baseline 1169, +48)   |
| Backend `tsc --noEmit`          | clean                               |
| Backend `prisma validate`       | clean                               |
| Migration `20260607120000_phase5_devicetoken` | applied (`migrate deploy`) |
| Frontend `npx jest geojson.spec`| 9 passing                           |
| Frontend `tsc --noEmit`         | clean                               |
| Committed GeoJSON size          | 136KB raw / 46KB gzip               |
| Backend full suite ≥1190 target | exceeded (1217)                     |

## Commit sequence

1. `205a82d chore(deps)(05-01): install firebase-admin nodemailer react-leaflet mapshaper`
2. `e751c13 feat(infra)(05-01): FcmClient + MailClient (NOTIF-02/03 scaffolds)`
3. `99f6418 feat(prisma)(05-01): DeviceToken model + ALERT_TYPES + cache/kafka ext`
4. `f6e1d30 feat(frontend)(05-01): GeoJSON viloyat build script + materialized asset`

## Deviations summary

- The pre-approved package list was `firebase-admin`, `nodemailer`,
  `leaflet`+`react-leaflet`, `mapshaper`. The plan-file checkpoint listed
  the browser `firebase` SDK instead of `leaflet`+`react-leaflet`. Frontend
  `firebase` install is deferred to Plan 05-04 (frontend FCM wiring).
- `npm install react-leaflet` required `--legacy-peer-deps` for workspace
  resolution.
- The DeviceToken migration was generated by hand because of the pre-existing
  Phase 2 baseline shadow-DB column issue, then applied via `migrate deploy`
  (same Phase 4 workaround pattern).
- The GeoJSON spec is `.js` not `.ts` because the frontend jest config has
  no TS preset; the spec is a static-file contract check with zero TS-only
  syntax.
- `psql`-based DeviceToken table verification was not available in the
  executor sandbox; the verification path is the successful `migrate deploy`
  + `prisma validate` + new specs that import generated client types.

## Downstream consumers unblocked

- Plan 05-04 (notification.processor real send) — consumes `FcmClient`,
  `MailClient`, `InvalidFcmTokenError`, `DeviceToken` model
- Plan 05-05 (alert consolidation) — consumes `ALERT_TYPES`, `ALERT_SEVERITY`,
  `cache.keys.alertDedupe`, `KAFKA_TOPICS.ALERT_FIRED/ALERT_ACKNOWLEDGED`
- Plan 05-06 (choropleth) — consumes the committed
  `apps/frontend/public/geojson/uzbekistan-viloyats.geojson`
- Plan 05-07 (StatsGateway live RI broadcast) — consumes
  `KAFKA_TOPICS.RI_RISING/SYSTEM_DOWN`
- Plans 05-02/03/06/09 — consume the new CacheService keys + TTLs
