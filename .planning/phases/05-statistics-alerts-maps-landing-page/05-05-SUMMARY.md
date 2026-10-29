# Plan 05-05 SUMMARY — Alert Consolidation Wave (ALERT-01..06)

**Status:** COMPLETE
**Wave:** 5 (depends on 05-01, 05-02, 05-04)
**Requirements closed:** ALERT-01, ALERT-02, ALERT-03, ALERT-04, ALERT-05, ALERT-06

## Five deliverables

### 1. S1 PITFALL closure — `_buildTumanRiMap` SQL GROUP BY

`apps/backend/src/modules/ai/audit.service.ts` `_buildTumanRiMap` previously did:

```ts
await this.prisma.readingIndex.findMany({
  where: { calculatedAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) } },
  include: { user: { select: { address: { select: { tumanId: true } } } } },
  orderBy: { calculatedAt: "desc" },
});
```

At production scale (5M users × ~60 days of RI) that's roughly 300M rows loaded into the Node heap before any aggregation. The cron OOMs.

New impl uses a single `replica.$queryRaw` GROUP BY returning ≤500 summary rows:

```sql
WITH ri_by_tuman AS (
  SELECT a."tumanId" AS tuman_id, ri.score, ri."calculatedAt"
  FROM "ReadingIndex" ri
  JOIN "User" u ON u.id = ri."userId"
  JOIN "Address" a ON a.id = u."addressId"
  WHERE ri."calculatedAt" >= NOW() - INTERVAL '28 days'
    AND a."tumanId" IS NOT NULL
)
SELECT
  r.tuman_id AS "tumanId",
  t.name AS tuman_name,
  AVG(CASE WHEN r."calculatedAt" >= NOW() - INTERVAL '14 days' THEN r.score END)::float AS current_ri,
  AVG(CASE WHEN r."calculatedAt" < NOW() - INTERVAL '14 days' THEN r.score END)::float AS previous_ri
FROM ri_by_tuman r
LEFT JOIN "Tuman" t ON t.id = r.tuman_id
GROUP BY r.tuman_id, t.name
```

Memory ceiling drops by ~6 orders of magnitude (5M user rows → ~200 tuman rows). Test asserts `replica.$queryRaw` was called and `replica.readingIndex.findMany` was NOT called.

### 2. New detectors + threshold fixes (ALERT-01/03/04/05)

| Detector | Status | Trigger |
|---|---|---|
| `_checkInactiveTumans` (ALERT-01) | NEW | Tumans with 0 distinct active readers in last 14 days (HAVING COUNT = 0). Emits `LIBRARY_INACTIVE` / CRITICAL. |
| `_checkFundShortages` (ALERT-03) | THRESHOLD CHANGED | `>= 50` requests AND `availableCount === 0` (was `>= 10` AND `<= 1`). |
| `_checkInactiveClubs` (ALERT-04) | THRESHOLD CHANGED | 30 days since last debate (was 45). |
| `checkTumanRiRises` (ALERT-05) | NEW WEEKLY | Cron `0 9 * * 1` Asia/Tashkent. Emits `RI_RISING` / INFO when `current > previous * 1.15`. AlertDispatchService defers to Monday 09:30 weekly digest. |

All detectors emit through the shared `ALERT_TYPES` constant. Zero string-literal `issueType` emissions remain in `audit.service.ts` (grep gate enforced).

### 3. `AlertDispatchService` + routing matrix

New: `apps/backend/src/modules/ai/alert-dispatch.service.ts`.

| Alert type | Severity | Channels | Recipient roles |
|---|---|---|---|
| `LIBRARY_INACTIVE` | KRITIK | sms + push + email | TUMAN_ADMIN + VILOYAT_ADMIN |
| `RI_DROPPED` | OGOH | push + email | TUMAN_ADMIN |
| `FUND_SHORTAGE` | OGOH | push | KUTUBXONACHI |
| `CLUB_INACTIVE` | OGOH | push | KLUB_RAHBARI |
| `RI_RISING` | AXBOROT | email (weekly digest) | VILOYAT_ADMIN — deferred to `dispatchRiRisingWeeklyDigest` |
| `SYSTEM_DOWN` | KRITIK | sms + email | SUPER_ADMIN (+ ADMIN_NOTIFICATION_EMAILS env fallback) |
| `INVENTORY_DISCREPANCY` | OGOH | push + email | MUASSASA_ADMIN + KUTUBXONACHI |
| `ORDER_REQUEST` | AXBOROT | email | SUPER_ADMIN + TUMAN_ADMIN |

Dedup contract (T-05-03):
```
key = alert:dedupe:{alertType}:{scopeId}:{YYYY-MM-DD}:{recipientUserId}:{channel}
TTL = 24h
```

Recipient-aware — each admin gets at most one delivery per (alert, scope, day, channel). A second admin in the same scope still receives their first delivery. Failure path (queue down, FCM rejects) is best-effort: log + continue; the AiAuditLog row remains intact for retry/manual processing (T-05-DISP-FAIL).

Recipient resolution:
- `TUMAN_ADMIN` for scope=TUMAN: filter by `User.address.tumanId == scopeId`.
- `VILOYAT_ADMIN` for scope=TUMAN: look up `Tuman.viloyatId`, filter by `User.address.viloyatId`.
- `SUPER_ADMIN`: per Q7, `User` schema has no `email` column, so emails route via `ADMIN_NOTIFICATION_EMAILS` env CSV. SMS still goes to per-user `phone`.

### 4. AXBOROT RI_RISING weekly digest cron

`dispatchRiRisingWeeklyDigest`: cron `30 9 * * 1` Asia/Tashkent. Reads the last 7 days of `AiAuditLog` rows with `issueType = RI_RISING`, groups by viloyat (via `Tuman.viloyatId` lookup), and enqueues ONE email per VILOYAT_ADMIN summarizing all rising tumans in their viloyat. Dedup via weekly ISO-week bucket (`alert:dedupe:weekly-digest:<viloyatId>:<adminId>:<yyyy-Www>`).

Per Q3 user decision, AXBOROT alerts are batched into a Monday morning digest rather than fired immediately — keeps inboxes clean while still surfacing positive signal.

### 5. `admin.service.checkSmartAlerts` DELETED + ALERT-06 receive-side

`AdminService.checkSmartAlerts` (legacy 23:00 cron lines 430-510) is removed. The duplicate engine emitted `INACTIVE_LIBRARY` and `RI_DROP` strings — the consolidated `audit.service.ts` is now the single source of truth using `ALERT_TYPES.LIBRARY_INACTIVE` / `ALERT_TYPES.RI_DROPPED`. Regression guard test asserts `service.checkSmartAlerts === undefined`.

New: `POST /admin/system-down-test` (SUPER_ADMIN only).
- Reads `ADMIN_SMS_RECIPIENTS` env CSV.
- 503 ServiceUnavailable when env is empty.
- Enqueues one `NOTIFICATION_QUEUE` SMS job per recipient phone.
- Calls `AdminService.recordSystemDownTestAudit(superAdminId)` which writes an `AiAuditLog` row with `issueType = SYSTEM_DOWN` / `severity = CRITICAL`.
- Returns `{ enqueued, recipients }` (numeric only — never leaks the phone list).

**External watchdog architectural note (operator concern):**

ALERT-06 SYSTEM_DOWN *detection* requires an EXTERNAL watchdog (UptimeRobot / BetterStack / Pingdom hitting `/health`). The server cannot reliably detect its own outage. Phase 5 ships only the *receive* path:

- `ADMIN_SMS_RECIPIENTS` env variable surfaces the operator-supplied phone list.
- `POST /admin/system-down-test` lets the operator verify the path end-to-end.
- `.env.example` documents this as an operator requirement.

This is a Q3/Q4 architectural decision documented in 05-RESEARCH §ALERT-06.

## Frontend filter rewire

New: `apps/frontend/lib/alert-types.const.ts` mirrors the backend `ALERT_TYPES` constant. Exports `ALERT_TYPE_LABELS` with Uzbek display strings + severity buckets (KRITIK / OGOH / AXBOROT).

`apps/frontend/app/[locale]/dashboard/alerts/page.tsx`:
- Drops the inline `ISSUE_LABELS` literal map.
- Adds a second filter row that surfaces all 8 alert types using `ALERT_TYPE_LABELS`.
- Alert cards consume `ALERT_TYPE_LABELS[issueType]?.uz` for the type badge.

Result: backend and frontend share a single vocabulary; mismatches like `"INACTIVE_LIBRARY"` vs `LIBRARY_INACTIVE` cannot recur.

## Files touched

| File | Change |
|---|---|
| `apps/backend/src/modules/ai/audit.service.ts` | Replica routing + S1 SQL fix + `_checkInactiveTumans` + `checkTumanRiRises` + thresholds + ALERT_TYPES vocabulary + dispatch delegation |
| `apps/backend/src/modules/ai/alert-dispatch.service.ts` | NEW — routing matrix + recipient-aware dedup + weekly digest |
| `apps/backend/src/modules/ai/ai.module.ts` | Register `AlertDispatchService` + `NOTIFICATION_QUEUE` |
| `apps/backend/src/modules/admin/admin.service.ts` | DELETE `checkSmartAlerts`; add `recordSystemDownTestAudit` |
| `apps/backend/src/modules/admin/admin.controller.ts` | NEW `POST /admin/system-down-test` |
| `apps/backend/.env.example` | NEW `ADMIN_SMS_RECIPIENTS` + watchdog architectural note |
| `apps/frontend/lib/alert-types.const.ts` | NEW mirrored vocabulary |
| `apps/frontend/app/[locale]/dashboard/alerts/page.tsx` | Filter rewire — consumes `ALERT_TYPE_LABELS` |
| Tests | 11 alert-consolidation + 12 alert-dispatch + 2 admin service + 3 admin controller; existing audit.service.spec.ts rewritten for new SQL-driven path |

## Verification

- `npx tsc --noEmit` clean (backend + frontend).
- `npm run lint:replica` — 0 heavy reads on primary.
- `npx jest --testPathPatterns="audit.service|alert-dispatch|admin.service|admin.controller"` — **138 tests pass**.
- Grep gates:
  - `issueType: "[A-Z_]+"` in audit.service.ts — 0 matches.
  - `RI_CRITICAL_DROP` in audit.service.ts — 0 matches.
  - `INACTIVE_LIBRARY` literal in alerts/page.tsx — 0 matches (only inside a documentation comment).
  - `alert-dispatch.service.ts` — exists, ≥100 lines.
- Full backend suite: 1393/1409 pass. The 16 failures are in `books-import.processor.spec.ts` — pre-existing test-isolation flake (passes in isolation; jszip/JSZip parser race when many suites run concurrently). Unrelated to this plan.

## Threat model closure

| Threat | Status | Mitigation |
|---|---|---|
| T-05-03 (alert spam) | Mitigated | Recipient-aware dedup via `cache.setNx`, 24h TTL |
| T-05-S1 (memory bomb) | Mitigated | Single `$queryRaw` GROUP BY replaces 300M-row in-memory aggregation |
| T-05-04 (anonymous SYSTEM_DOWN abuse) | Mitigated | `@Roles(SUPER_ADMIN)` + 503 when env empty + audit row records actor |
| T-05-DISP-FAIL (dispatch failure) | Accepted | Best-effort side effect — log + continue; audit row remains |
| T-05-VOCAB (vocabulary drift) | Mitigated | Single ALERT_TYPES backend + ALERT_TYPE_LABELS frontend; grep gate prevents inline literals |
| T-05-WATCHDOG (no internal heartbeat) | Accepted + documented | External UptimeRobot/BetterStack is the operator concern; .env.example + this SUMMARY document it |
| T-05-ADMIN-FB (env exposure) | Mitigated | Endpoint response `{ enqueued, recipients }` is numeric only — never returns the phone list |
