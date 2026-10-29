---
phase: 06-school-family-organization-university-modules
plan: 03
wave: 1
status: completed
completed_at: 2026-06-08
commits:
  - "feat(family)(06-03): opt-IN detection + 30-day waiting + anonymized Top-50 (FAM-01/03/04/05)"
  - "feat(family)(06-03): AddressChangeRequest endpoints + TUMAN_ADMIN scope + atomic approval (FAM-06)"
  - "feat(frontend)(06-03): family detection toggle + public profile + AddressChange form (FAM-01/05/06)"
backend_tests:
  family.service.spec: "48 passing (+6 new specs)"
  family.controller.spec: "4 passing (NEW)"
  address-change.service.spec: "15 passing (NEW)"
  address-change.controller.spec: "4 passing (NEW)"
  total_focused: "71 passing"
backend_tsc: clean (pre-existing elasticsearch shim errors unchanged)
frontend_tsc: clean
frontend_build: "exit 0"
requirements:
  - "FAM-01 — opt-IN detection (default OFF) + same-household 6-tuple address gate"
  - "FAM-02 — manual invite (unchanged from Plan 06-01; manual path bypasses opt-IN gate)"
  - "FAM-03 — 30-day waiting period sourced from FamilyMembership.joinedAt (Plan 06-01 plumbing) and verified-in-spec"
  - "FAM-04 — replica routing on RI compute + new public profile read path"
  - "FAM-05 — Top-50 + public profile with maskNameIfMinor + escapeHtml on family.name"
  - "FAM-06 — AddressChangeRequest endpoints (POST create + GET list + PATCH approve/reject) with TUMAN_ADMIN scope guard + atomic addressId swap"

ai_audit_log_event_types_emitted:
  - "FAMILY_DETECTION_TOGGLED  — analysis: 'enabled' | 'disabled'"
  - "ADDRESS_CHANGE_REQUEST    — analysis: 'Address change request <id> submitted'"
  - "ADDRESS_CHANGE_APPROVED   — analysis: 'Address change <id> approved by <reviewerId>'"
  - "ADDRESS_CHANGE_REJECTED   — analysis: reviewer reason"
---

# Plan 06-03 SUMMARY — Family Module (FAM-01 … FAM-06)

Wave 1 sibling of Plan 06-02 (school module). Builds the user-facing
behavior of the family module on top of the Plan 06-01 prereqs
(FamilyMembership.joinedAt, AddressChangeRequest schema, family.service
TOCTOU + replica plumbing).

## Highlights

1. **FAM-01 opt-IN gate.** `detectAndSuggestFamily` is now a no-op when
   the caller has `familyDetectionEnabled = false`. The candidate WHERE
   clause additionally gates on the matched users' own
   `familyDetectionEnabled = true` so detection is mutual.
2. **FAM-01 toggle endpoint.** `PATCH /family/me/family-detection`
   flips the flag inside a `$transaction` that also writes
   `AiAuditLog{FAMILY_DETECTION_TOGGLED}`. No-op short-circuit when
   state unchanged (no audit pollution).
3. **FAM-03 30-day waiting period.** Verified by Plan 06-01 prereq;
   spec asserts `family.service` queries `FamilyMembership.joinedAt`
   (not `User.createdAt`).
4. **FAM-04 replica routing.** Spy in family.service.spec asserts that
   `prisma.user.findMany` is **never called** inside the RI-compute
   path. All reads land on `this.replica` (PrismaReplicaService).
5. **FAM-05 Top-50 + public profile.**
   - `getFamilyRatings` returns `familyName` already escaped via
     `escapeHtml` (defense-in-depth XSS).
   - `getPublicFamilyProfile` (`GET /family/:id/profile`, no auth)
     returns aggregated avgRi + memberCount + member list. Each
     member runs through `maskNameIfMinor(name, dob)` so under-14
     names emerge as initials (e.g. `K.V.`).
6. **FAM-06 AddressChange endpoints.** New
   `apps/backend/src/modules/admin/address-change.{controller,service}.ts`:
   - `POST /family/address-change` — user submits, 409 Conflict on
     existing PENDING (T-06-F3).
   - `GET /family/address-change` — scope-filtered list.
   - `PATCH /family/address-change/:id/approve` — atomic
     `$transaction(addressChangeRequest.update + user.update +
     aiAuditLog.create)`. `assertTumanInScope(toAddress.tumanId,
     resolvedViloyatId: toAddress.viloyatId)` gates VILOYAT/TUMAN
     admins (T-06-F2/F4).
   - `PATCH /family/address-change/:id/reject` — same RBAC; reason
     required.

## Files modified

| Path | Why |
|---|---|
| `apps/backend/src/modules/family/family.service.ts` | FAM-01 opt-IN gate, setFamilyDetectionEnabled toggle, getPublicFamilyProfile, escapeHtml on family.name in getFamilyRatings, maskNameIfMinor import |
| `apps/backend/src/modules/family/family.controller.ts` | PATCH /family/me/family-detection (auth), @Public GET /family/ratings/top + GET /family/:id/profile |
| `apps/backend/src/modules/family/__tests__/family.service.spec.ts` | +6 specs: opt-IN OFF, candidate WHERE, toggle ON/OFF, no-op short-circuit, public profile mask, FAM-04 spy |
| `apps/backend/src/modules/family/__tests__/family.controller.spec.ts` | **NEW** — 4 specs covering toggle + public profile delegation |
| `apps/backend/src/modules/admin/address-change.service.ts` | **NEW** — createRequest, approveRequest, rejectRequest, listRequests with assertTumanInScope |
| `apps/backend/src/modules/admin/address-change.controller.ts` | **NEW** — 4 routes scoped per role |
| `apps/backend/src/modules/admin/dto/address-change.dto.ts` | **NEW** — CreateAddressChangeDto (reason 10-500), RejectAddressChangeDto (reason min 3) |
| `apps/backend/src/modules/admin/admin.module.ts` | Wire AddressChangeController + AddressChangeService |
| `apps/backend/src/modules/admin/__tests__/address-change.service.spec.ts` | **NEW** — 15 specs covering full RBAC matrix |
| `apps/backend/src/modules/admin/__tests__/address-change.controller.spec.ts` | **NEW** — 4 specs covering delegation |
| `apps/frontend/app/[locale]/profile/page.tsx` | Privacy settings card with FAM-01 toggle + FAM-06 address-change submit panel |
| `apps/frontend/app/[locale]/family/[familyId]/page.tsx` | **NEW** — public family profile SSR page with OpenGraph + Twitter Card |

## Sample masked-name output

For a 12-year-old member named `Karim Valiyev` with `dob =
today - 12 years`:

```json
{
  "id": "u2",
  "name": "K.V.",
  "isMinor": true,
  "avgRi": 65
}
```

For an adult member named `Ali Valiyev`:

```json
{
  "id": "u1",
  "name": "Ali Valiyev",
  "isMinor": false,
  "avgRi": 78
}
```

For a family name `Valiyev "oilasi"` (contains a stray quote):

```json
{
  "name": "Valiyev &quot;oilasi&quot;"
}
```

## Evidence: FAM-04 replica routing

The new `FAM-04 replica routing` describe block in
`family.service.spec.ts` arms `mockReplica.family.findMany` and
`mockReplica.readingIndex.findFirst`, calls
`computeFamilyRatings("2026-05")`, and asserts:

```typescript
expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
expect(mockReplica.readingIndex.findFirst).toHaveBeenCalled();
```

The test passes — read-path traffic does not leak to the primary.

## Grep gates

| Gate | Pattern | Path | Count |
|---|---|---|---|
| FAM-01 opt-IN flag | `familyDetectionEnabled` | family.service.ts | 10 |
| FAM-03 30-day filter | `joinedAt` | family.service.ts | 6 |
| FAM-06 leftAt filter | `leftAt` | family.service.ts | 8 |
| FAM-04 replica routing | `this\.replica` | family.service.ts | 6 |
| FAM-06 admin RBAC | `@Roles` | address-change.controller.ts | 3 |
| FAM-05 public route | `@Public` | family.controller.ts | 2 |

## Threat model — what shipped

| Threat | Mitigation |
|---|---|
| T-06-04 same-address surveillance | opt-IN gate (default-OFF); audit-logged toggle |
| T-06-08 / T-06-F4 cross-viloyat address tamper | `assertTumanInScope` resolves `toAddress.viloyatId` |
| T-06-F1 under-14 name leak via public profile | `maskNameIfMinor` server-side in `getPublicFamilyProfile` |
| T-06-F3 second PENDING address-change | service check → 409 Conflict |
| T-06-F6 family.name XSS | `escapeHtml` at API boundary; frontend re-escapes |

## Decisions applied

- **D-Q3** — Family detection is opt-IN; default FALSE; explicit toggle.
- **D-Q4** — 30-day waiting period uses `FamilyMembership.joinedAt`.
- **D-OQ-2** — AddressChangeRequest free-text reason V1 (10-500 chars).
- **D-OQ-5** — Family profile photo deferred to V2; V1 shows aggregated
  metrics + masked member names.

## Follow-ups

- Frontend address-change panel currently expects a raw `Address ID`; a
  proper cascade Viloyat→Tuman→Mahalla picker (mirroring registration)
  should land in a Phase 6 polish wave or Plan 06-07.
- Cool-down period between address-change toggles (T-06-F5 accept'd risk)
  is forensic-grade-only in V1; revisit if abuse patterns appear.
- Family inbox of PENDING invites is rendered by the existing Plan 06-01
  family page; no new work in this plan.
