---
phase: 6
slug: school-family-organization-university-modules
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-07
updated: 2026-06-08
---

# Phase 6 — Validation Strategy

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 + ts-jest (backend) + Jest 30 jsdom (frontend) |
| **Quick run** | `cd apps/backend && npx jest <path> --bail --forceExit --silent` |
| **Full suite** | `cd apps/backend && npm test` |
| **Estimated runtime** | ~140s (Phase 5 baseline ~1400; Phase 6 target ≥1550) |
| **Coverage gate** | 80% lines |
| **Notable** | Phase 6 extends existing school/family/club/idora/otm modules + 4 new migrations (FamilyMembership, AddressChangeRequest, ClubMemberConsentToken, *Media tables, ReadingHour.status) + MinIO file uploads + bcrypt-token parent consent flow |

## Sampling Rate

- After every task commit: `npx jest <touched-spec> --bail --forceExit --silent`
- After every plan wave: full backend suite + frontend suite
- Max feedback latency: 140s

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 06-01-T0 | 06-01 | 0 | — | T-06-SC | Slopcheck pre-approval marker | checkpoint:human-verify (auto-advance) | n/a | pending |
| 06-01-T1 | 06-01 | 0 | UNI-01, UNI-02 | T-06-03, T-06-06 | OtmService uses universityId + STUDENT_UNIVERSITY; MinioService 1h TTL cap; assertInstitutionInScope fail-CLOSED | unit | `npx jest otm.service.spec admin-scope.util.spec minio.service.spec --bail --forceExit --silent` | pending |
| 06-01-T2 | 06-01 | 0 | ORG-06, UNI-03, SCH-07, ORG-02 | T-06-01, T-06-02, T-06-05 | escapeHtml on PDF DB-strings; R-DUP delete (no SchoolRating/OrgRating create/upsert in school/idora service) | unit | `npx jest idora.service.spec otm.service.spec school.service.spec --bail --forceExit --silent` | pending |
| 06-01-T3 | 06-01 | 0 | FAM-03, FAM-06 | T-06-04 | Interactive $transaction with re-check inside; FamilyMembership backfill; replica routing on RI compute | unit + migration | `npx prisma generate && npx tsc --noEmit && npx jest family.service.spec --bail --forceExit --silent` | pending |
| 06-02-T1 | 06-02 | 1 | SCH-01, SCH-02, SCH-09 | T-06-01, T-06-S1 | Scope-guard before cache; reject endpoint + AiAuditLog; INACTIVE_THRESHOLD_DAYS=30 | unit | `npx jest school.service.spec school.controller.spec club.service.spec --bail --forceExit --silent` | pending |
| 06-02-T2 | 06-02 | 1 | SCH-06, SCH-07, SCH-08 | T-06-02, T-06-03 | 20-book hardcoded; weekly @Cron leader-locked NO writes to SchoolRating; PQ-9 Jadidlar XSS escape | unit | `npx jest school.service.spec club.service.spec pdf.service.spec --bail --forceExit --silent` | pending |
| 06-02-T3 | 06-02 | 1 | SCH-01..09 | T-06-S2 | Frontend renders K-anon suppression; PQ-9 download wired | jsdom | `cd apps/frontend && npx jest dashboard/school --bail --silent` | pending |
| 06-03-T1 | 06-03 | 1 | FAM-01, FAM-03, FAM-04, FAM-05 | T-06-04, T-06-F1 | opt-IN gate; FamilyMembership.joinedAt filter; replica routing; maskNameIfMinor | unit | `npx jest family.service.spec family.controller.spec users.service.spec --bail --forceExit --silent` | pending |
| 06-03-T2 | 06-03 | 1 | FAM-06 | T-06-F2, T-06-F3, T-06-F4 | AddressChangeRequest endpoints + TUMAN_ADMIN scope + atomic addressId swap | unit | `npx jest admin.service.spec address-change.controller.spec --bail --forceExit --silent` | pending |
| 06-03-T3 | 06-03 | 1 | FAM-01..06 | T-06-F1, T-06-F6 | Profile toggle + family inbox + public profile with masked names | jsdom | `cd apps/frontend && npx jest family --bail --silent` | pending |
| 06-04-T1 | 06-04 | 2 | SCH-03, SCH-04 | T-06-05a..e | bcrypt token + 48h TTL + constant-time compare + expiry cron + rate-limit | unit | `npx jest club.service.spec club-consent.service.spec --bail --forceExit --silent` | pending |
| 06-04-T2 | 06-04 | 2 | SCH-05 | T-06-06a..d | MIME sniff via file-type; 50MB+4-file caps; DRAFT→PUBLISHED gate; safe MinIO key | integration | `npx jest debate-media.service.spec club-media.integration.spec --bail --forceExit --silent` | pending |
| 06-04-T3 | 06-04 | 2 | SCH-04, SCH-05 | T-06-05e | Consent SSR page minimum info; debate detail multipart upload | jsdom | `cd apps/frontend && npx jest club --bail --silent` | pending |
| 06-05-T1 | 06-05 | 2 | ORG-01, ORG-02, ORG-07 | T-06-O1, T-06-O2, T-06-O3 | Employees-by-department scope-guard + K-anon; OrgRating read-only (grep gate); ProfBook HR role | unit | `npx jest idora.service.spec idora.controller.spec --bail --forceExit --silent` | pending |
| 06-05-T2 | 06-05 | 2 | ORG-04, ORG-05 | T-06-09, T-06-O4, T-06-O5 | bookCornerReminders cron NOT a STUB; Mukofot taklifi self-nomination flag | unit | `npx jest idora.service.spec mukofot.service.spec alert-dispatch --bail --forceExit --silent` | pending |
| 06-05-T3 | 06-05 | 2 | ORG-06 | T-06-O3, T-06-O6 | Pq9IdoraReport escapeHtml everywhere; subscription gate on download | unit + jsdom | `npx jest pdf.service.spec idora --bail --forceExit --silent` | pending |
| 06-06-T1 | 06-06 | 3 | ORG-03 | T-06-R1, T-06-R3, T-06-R4 | HMAC-rotating QR (5min window); constant-time compare; attendance @@unique + scheduledAt tolerance | unit | `npx jest reading-hour --bail --forceExit --silent` | pending |
| 06-06-T2 | 06-06 | 3 | ORG-03 | T-06-R6 | ReadingHourMedia upload mirrors Plan 06-04 patterns | integration | `npx jest reading-hour-media --bail --forceExit --silent` | pending |
| 06-06-T3 | 06-06 | 3 | ORG-03 | T-06-R2, T-06-R5 | Public scan landing handles 200/409/410/403 with Uzbek copy | jsdom | `cd apps/frontend && npx jest reading-hour --bail --silent` | pending |
| 06-07-T1 | 06-07 | 3 | UNI-01, UNI-02 | T-06-U1, T-06-U2, T-06-U3 | Faculty grouping (schoolClass removed); K-anon; integration test proves seeded OTM students returned | unit + integration | `npx jest otm --bail --forceExit --silent` | pending |
| 06-07-T2 | 06-07 | 3 | UNI-03 | T-06-10, T-06-U4 | Pq9OtmReport per-faculty + checklist + escapeHtml; subscription gate | unit | `npx jest pdf.service.spec otm --bail --forceExit --silent` | pending |
| 06-07-T3 | 06-07 | 3 | UNI-04 | T-06-U2, T-06-U5 | Faculty-admin aggregated view (own faculty); student-self own progress only | unit + jsdom | `npx jest student-progress otm --bail --forceExit --silent` | pending |

## Wave 0 Requirements

- [x] OtmService schema-mismatch fix (STUDENT_UNIVERSITY + universityId) — planned in Plan 06-01 Task 1
- [x] escapeHtml carry-over to IdoraService.generatePq9Report + OtmService.generateAccreditationReport — planned in Plan 06-01 Task 2
- [x] Delete duplicate SchoolRating/OrgRating writes from SchoolService/IdoraService — planned in Plan 06-01 Task 2 (Phase 3 owns)
- [x] FamilyMembership Prisma model + backfill — planned in Plan 06-01 Task 3
- [x] AddressChangeRequest Prisma model — planned in Plan 06-01 Task 3
- [x] $transaction wrapper for respondToInvite (FAM-06 TOCTOU) — planned in Plan 06-01 Task 3
- [x] Slopcheck: minio + file-type + sharp (pre-approved by user) — planned in Plan 06-01 Task 0 + Task 1
- [x] ClubMemberConsentToken model + bcrypt nonce plumbing — planned in Plan 06-01 Task 3
- [x] DebateMedia + ReadingHourMedia + BookCornerVerification models — planned in Plan 06-01 Task 3
- [x] MinIO infra wiring (MinioService + ensureBucket + 1h TTL cap) — planned in Plan 06-01 Task 1
- [x] assertInstitutionInScope util — planned in Plan 06-01 Task 1

## Manual-Only Verifications

| Behavior | Why Manual | Test Instructions |
|----------|------------|-------------------|
| Real MinIO upload to bucket | Requires running MinIO container | Upload debate photo via UI; verify object exists in MinIO browser at port 9001 |
| Parent SMS consent flow end-to-end | Requires real Eskiz delivery + clickable link | Trigger club add → SMS received → click link → consent recorded |
| PQ-9 PDF visual correctness | Visual check | Generate report; open PDF; verify charts, photos, school name, no XSS |
| Akkreditatsiya PDF accreditation | Visual + format check | Generate UNI report; verify faculty breakdown matches ministry packet format |
| Family detection real-time | Real address data | Two users opt-IN + register same address+apartment; suggestion appears |
| QR rotating attendance | Camera + 5-min window | Open event page; verify QR refreshes 4 min before expiry; scan with phone; attendance recorded |
| Mukofot email delivery | Requires SMTP + a recipient | Monthly cron runs → HR admin receives email with MVP name + RI; check non-HTML body |
| BookCorner 90-day reminder dispatch | Real cron + AlertDispatchService output | Set BookCorner.lastVerifiedAt=now-91d on a TRIAL institution → cron fires → MUASSASA_ADMIN sees alert in dashboard |

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependency
- [x] No 3 consecutive tasks without automated verify
- [x] Wave 0 covers MISSING references + P1 latent bugs
- [x] `nyquist_compliant: true` set by planner

**Approval:** pending execution
