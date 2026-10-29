---
phase: 2
slug: reading-index-engine-core-book-logic
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-06
last_updated: 2026-06-06
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 29 + ts-jest (apps/backend/jest.config.ts; testEnvironment node, rootDir src, .spec.ts) |
| **Config file** | apps/backend/jest.config.ts |
| **Quick run command** | `cd apps/backend && npx jest <path> --bail` |
| **Full suite command** | `cd apps/backend && npm test` |
| **Estimated runtime** | ~75 seconds (current baseline: 680 tests, 38.8s; Phase 2 adds ~55 cases ≈ +20s) |
| **Coverage gate** | 80% lines (controllers/infra/guards excluded from collection) |
| **Notable** | `@nestjs/schedule` is mocked (src/__mocks__/@nestjs/schedule.ts) so crons are unit-testable by direct call. ioredis-mock available. BullMQ queue mocks via in-memory transport. exceljs streaming reader can be mocked at the WorkbookReader level. |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/backend && npx jest <touched-spec> --bail`
- **After every plan wave:** Run `cd apps/backend && npm test`
- **Before `/gsd-verify-work`:** Full suite green + RI batch dry-run against seed data + partitioned table + CHECK-constraint smoke
- **Max feedback latency:** 75 seconds

---

## Per-Task Verification Map

> Each Phase 2 task maps to a requirement, a threat ref (from each plan's <threat_model>), a test type, and an automated command. Plan/Task IDs use the form `02-NN-Task-M`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-Task-1 | 02-01 | 1 | (gate) | T-02-SC | Package legitimacy human-verify checkpoint for exceljs | checkpoint:human-verify | (manual) | n/a | ⬜ pending |
| 02-01-Task-2 | 02-01 | 1 | BOOK-01, RI-01 (prep) | T-02-SC | exceljs in deps; RI_RECALC_QUEUE registered | unit | `cd apps/backend && node -e "const p=require('./package.json');if(!p.dependencies.exceljs)process.exit(1)" && grep -c RI_RECALC_QUEUE src/infra/queue/queue.module.ts` | ✅ extend queue.module | ⬜ pending |
| 02-01-Task-3 | 02-01 | 1 | FRAUD-01, FRAUD-02, BOOK-03, STORE-03, RI-02 | T-02-01, T-02-02, T-02-05, T-02-06 | Comprehension randomized + min-time; reserve enforces limit; per-source coefficient | unit | `cd apps/backend && npx jest --testPathPattern='(transactions.service|reading.service).spec' --bail` | ❌ new spec cases | ⬜ pending |
| 02-01-Task-4 | 02-01 | 1 | FRAUD-04 | T-02-03 | Store endpoint authorization via @CurrentUser | unit | `cd apps/backend && npx jest transactions.service.spec -t "store entry"` | ❌ new spec cases | ⬜ pending |
| 02-01-Task-5 | 02-01 | 1 | FRAUD-06 | T-02-04 | BLOCKED → FLAGGED rename + action='review' | unit | `cd apps/backend && npx jest fraud.service.spec -t "FLAGGED"` | ✅ extend fraud spec | ⬜ pending |
| 02-02-Task-1 | 02-02 | 2 | BOOK-05 (part) | T-02-07, T-02-11 | extended Boolean + CHECK constraint migration | unit + manual | `cd apps/backend && npx jest transactions.service.spec -t "extendDueDate"` + manual psql CHECK smoke (Task 4) | ✅ extend spec; ❌ new migration | ⬜ pending |
| 02-02-Task-2 | 02-02 | 2 | BOOK-02 (schema), INFRA-06 (capture) | T-02-08 | BookTransfer + composite index capture migration | unit + manual | `cd apps/backend && npx jest transactions.service.spec -t "returnRoaming"` + manual psql `\\d+ ReadingIndex` after Task 4 | ❌ new spec + migration | ⬜ pending |
| 02-02-Task-3 | 02-02 | 2 | RI-05 | T-02-09, T-02-10 | Raw-SQL PARTITION BY RANGE + 16 partitions | manual (psql) | `grep -c "PARTITION BY RANGE" prisma/migrations/20260607000002_phase2_ri_partitions/migration.sql` + Task 4 manual smoke | ❌ new migration | ⬜ pending |
| 02-02-Task-4 | 02-02 | 2 | RI-05, BOOK-05, BOOK-02 | T-02-10 | [BLOCKING] prisma migrate review + apply | checkpoint:human-verify | (manual psql + prisma migrate status) | n/a | ⬜ pending |
| 02-02-Task-5 | 02-02 | 2 | BOOK-05 (service) | T-02-07 | 4 array-form → interactive $transaction; P2010 → BadRequestException | unit | `cd apps/backend && npx jest transactions.service.spec -t "(interactive transactions|CHECK constraint surface)"` | ❌ new spec cases | ⬜ pending |
| 02-03-Task-1 | 02-03 | 3 | RI-01 (prep) | T-02-15 | PrismaReplicaService with DATABASE_REPLICA_URL fallback | unit | `cd apps/backend && npx jest prisma-replica.service.spec` | ❌ new spec | ⬜ pending |
| 02-03-Task-2 | 02-03 | 3 | RI-01, FRAUD-05 (signal 2/3) | T-02-12, T-02-13, T-02-16 | RiRecalcProcessor concurrency 10; reading-speed trust delta | unit | `cd apps/backend && npx jest ri-recalc.processor.spec` | ❌ new spec | ⬜ pending |
| 02-03-Task-3 | 02-03 | 3 | RI-01 | T-02-12 | scheduleNightlyRecalculation addBulk fan-out | unit | `cd apps/backend && npx jest reading.service.spec -t "scheduleNightlyRecalculation"` | ✅ extend spec | ⬜ pending |
| 02-04-Task-1 | 02-04 | 4 | BOOK-01 | T-02-17 | Excel import as BullMQ job + exceljs swap + xlsx removal + frontend wiring | unit + manual UI | `cd apps/backend && npx jest --testPathPattern='(books.service|books-import.processor).spec'` + manual upload smoke | ❌ new processor spec; ✅ extend books.service spec | ⬜ pending |
| 02-04-Task-2 | 02-04 | 4 | FRAUD-03 | T-02-18, T-02-19, T-02-20 | Auto-block removed; RI_SPIKE fix; review-queue endpoints; FE wiring | unit + manual UI | `cd apps/backend && npx jest fraud.service.spec` + grep `user\\.update.*BLOCKED` = 0 | ✅ extend fraud spec | ⬜ pending |
| 02-04-Task-3 | 02-04 | 4 | RI-04 | (info) | Delta endpoint with 1h Redis cache | unit | `cd apps/backend && npx jest reading.service.spec -t "delta"` | ❌ new spec cases | ⬜ pending |
| 02-04-Task-4 | 02-04 | 4 | RI-03, STORE-01 | T-02-21, T-02-22 | Monthly partition cleanup + STORE-01 24h expiry | unit | `cd apps/backend && npx jest --testPathPattern='(reading.service\\|store.service).spec' -t "(partition cleanup\\|24 soat)"` | ❌ new spec cases | ⬜ pending |
| 02-05-Task-1 | 02-05 | 5 | BOOK-02 (confirm) | T-02-23, T-02-24, T-02-27 | confirmTransfer endpoint atomic + SMS enqueue on returnRoaming | unit | `cd apps/backend && npx jest --testPathPattern='(libraries.service\\|transactions.service).spec' -t "(confirmTransfer\\|returnRoaming enqueues)"` | ❌ new spec cases | ⬜ pending |
| 02-05-Task-2 | 02-05 | 5 | BOOK-04 | (info) | checkOverdueAlerts survives; rename to recomputeOverdueDays | unit | `cd apps/backend && npx jest transactions.service.spec -t "(checkOverdueAlerts\\|recomputeOverdueDays\\|hasOverdueBooks blocks)"` | ✅ extend spec | ⬜ pending |
| 02-05-Task-3 | 02-05 | 5 | FRAUD-05 (signal 3/3) | T-02-25 | Comprehension pass-rate Trust Score signal | unit | `cd apps/backend && npx jest ri-recalc.processor.spec -t "comprehension pass-rate"` | ✅ extend processor spec | ⬜ pending |
| 02-05-Task-4 | 02-05 | 5 | STORE-02 | (info) | End-to-end cascade verification (no new code) | integration | `cd apps/backend && npx jest --testPathPattern='(transactions.service\\|store.service).spec' -t "(scan\\|store).+(comprehension\\|24)"` | ✅ extend specs | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Package legitimacy human-verify checkpoint for exceljs (Plan 02-01 Task 1)
- [ ] Replace xlsx@0.18.5 with exceljs@4.4.0 in apps/backend/package.json (Plan 02-01 Task 2 — install; Plan 02-04 Task 1 — uninstall after import swap)
- [ ] Register RI_RECALC_QUEUE constant in queue.module.ts (Plan 02-01 Task 2)
- [ ] Create `apps/backend/src/modules/reading/__tests__/ri-recalc.processor.spec.ts` scaffold (Plan 02-03 Task 2)
- [ ] Create `apps/backend/src/modules/books/__tests__/books-import.processor.spec.ts` scaffold (Plan 02-04 Task 1)
- [ ] Create `apps/backend/src/infra/prisma/__tests__/prisma-replica.service.spec.ts` scaffold (Plan 02-03 Task 1)
- [ ] Extend `transactions.service.spec.ts` with new spec cases: comprehension randomization, min-time, store-entry-derives-operator, reserve-enforces-limit, extendDueDate-extended, returnRoaming-bookTransfer, interactive-transactions, CHECK-constraint-surface, returnRoaming-SMS, recomputeOverdueDays
- [ ] Extend `reading.service.spec.ts` with new spec cases: applies-per-source-coefficient, scheduleNightlyRecalculation, delta, monthlyPartitionCleanup
- [ ] Extend `fraud.service.spec.ts` with new spec cases: risk-level-FLAGGED, does-not-auto-block, RI_SPIKE-consecutive-days, review-queue, resolveReview
- [ ] Extend `store.service.spec.ts` with new spec cases: confirmStorePurchase-24h-expiry

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| RI batch wall-clock under 2h at 5M users | RI-01 | Production-scale load test | Run BullMQ batch against staging DB seeded with 5M users; measure wall-clock; target <2h. Defer to Phase 7 PERF-01 if staging not yet provisioned. |
| Partition pruning effective on partition-by-month | RI-05 | Requires real query planner output | After Plan 02-02 Task 4: `EXPLAIN ANALYZE SELECT * FROM "ReadingIndex" WHERE "userId" = ? AND "calculatedAt" >= NOW() - INTERVAL '7 days';` — confirm only the relevant 1-2 partitions are scanned (not all 16) |
| CHECK constraint rejects negative availableCount | BOOK-05 | Requires real PG | After Plan 02-02 Task 4: `psql -c "UPDATE \"Book\" SET \"availableCount\" = -1 WHERE id = 'any-id';"` — must reject with constraint violation |
| Excel import progress UI updates | BOOK-01 | Frontend visual check | After Plan 02-04 Task 1: Upload 500-book XLSX from /dashboard/books; watch progress bar; confirm completion summary shows processed + errors |
| Inter-library roaming end-to-end | BOOK-02 | Multi-actor flow | After Plan 02-05 Task 1: Reader borrows in Toshkent library, returns in Navoiy library; verify SMS log line for Toshkent librarian; Toshkent librarian POSTs to /libraries/.../transfers/.../confirm; verify Toshkent Book.availableCount bumps by 1 and BookTransfer.status='CONFIRMED' |
| Store cabinet → reader confirm flow | STORE-01 + STORE-02 | Multi-actor flow + 24h expiry | After Plan 02-04 + Plan 02-01: Operator enters purchase via /dokon; reader confirms within 24h; RI updates with 0.9x coefficient; second flow: operator enters, reader waits 25 hours, confirm rejected |
| BOOK-04 SMS delivery to overdue users | BOOK-04 | Depends on Eskiz credentials | After Plan 02-05 Task 2: Eskiz dev no-op behavior is documented. Live delivery deferred to Phase 1 carry-over checkpoint (STATE.md line 80 — 01-01 Task 3 PENDING Eskiz creds) |
| Monthly partition cleanup drops correct partition | RI-03 | Cron + real PG | After Plan 02-04 Task 4: At any time, manually invoke monthlyPartitionCleanup() via debug endpoint or NestJS REPL; verify the (current_month - 13) partition is dropped and the (current_month + 3) partition is created |
| Fraud review queue UI | FRAUD-03 | Frontend visual check | After Plan 02-04 Task 2: Open /dashboard/fraud-review as a SUPER_ADMIN; verify list of FLAGGED users; approve one, reject another; verify FraudScore.action transitions |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (checkpoints 02-01-Task-1 and 02-02-Task-4 are gates only; surrounded by automated tasks)
- [x] Wave 0 covers all MISSING references (3 new spec scaffolds + 5 extended specs)
- [x] No watch-mode flags
- [x] Feedback latency < 75s (Phase 1 baseline 38.8s + ~20s for Phase 2 additions)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned — pending execution
