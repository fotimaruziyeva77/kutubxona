---
phase: 07-offline-pwa-internationalization-production-launch
plan: 04
subsystem: ai
tags: [nlq, kafka, audit, rca, real-time, event-driven]

requires:
  - phase: 07-01
    provides: AI module with NlqService, AuditService, PredictService, FraudService
  - phase: 07-02
    provides: Kafka infrastructure with topics and producer service

provides:
  - 23 NLQ SQL query templates covering all platform modules (AI-01)
  - KafkaAuditConsumer for real-time event-driven audit pipeline (AI-02)
  - RCA wired to Kafka TUMAN_RI_DROPPED events (AI-03)
  - triggerRootCauseForTuman public method on AuditService for cron + Kafka RCA

affects: [ai-dashboard, fraud-detection, admin-nlq-chat, kafka-consumers]

tech-stack:
  added: []
  patterns:
    - NLQ template registry pattern (centralized SQL templates with keyword matching)
    - Kafka consumer with graceful KAFKA_BROKERS no-op degradation
    - Sliding window in-memory rapid borrow detection (1-min bounded)

key-files:
  created:
    - apps/backend/src/modules/ai/nlq-templates.ts
    - apps/backend/src/modules/ai/kafka-audit.consumer.ts
    - apps/backend/src/modules/ai/__tests__/nlq-templates.spec.ts
    - apps/backend/src/modules/ai/__tests__/kafka-audit.consumer.spec.ts
  modified:
    - apps/backend/src/modules/ai/nlq.service.ts
    - apps/backend/src/modules/ai/audit.service.ts
    - apps/backend/src/modules/ai/ai.module.ts

key-decisions:
  - "NLQ templates use substring keyword matching with specificity tie-break for Uzbek stem compatibility"
  - "KafkaAuditConsumer uses separate groupId sifat-ai-audit to avoid conflict with sifat-library-stats consumer"
  - "Rapid borrow detection uses in-memory Map with 1-min sliding window (memory-bounded per T-07-10)"
  - "missing_books keywords changed to multi-word phrases to prevent substring collision with region queries"

patterns-established:
  - "NLQ Template Registry: centralized NlqTemplate[] export with intent/keywords/sqlTemplate/chartType"
  - "Kafka audit consumer: event-to-AiAuditLog routing with severity-based escalation"

requirements-completed: [AI-01, AI-02, AI-03]

duration: 12min
completed: 2026-06-09
---

# Phase 7 Plan 04: AI NLQ Templates + Kafka Audit Consumer Summary

**23 NLQ SQL templates covering schools/families/orgs/universities/donations/payments/fraud/alerts/badges, plus real-time Kafka audit consumer with RCA-to-alert pipeline wiring**

## Performance

- **Duration:** 12 min
- **Started:** 2026-06-09T01:03:19Z
- **Completed:** 2026-06-09T01:15:51Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Expanded NLQ service from 7 to 23 SQL query template intents covering all platform modules (schools, families, organizations, universities, donations, payments, fraud, alerts, badges, map RI, overdue books, store purchases)
- Created real-time Kafka audit consumer subscribing to 8 topics with anomaly detection (fraud, RI drops, rapid borrows)
- Wired Root Cause Analysis to TUMAN_RI_DROPPED events via PredictService (AI-03)
- Added public triggerRootCauseForTuman method to AuditService for dual cron + Kafka invocation
- 10 total specs across 2 test files, all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: NLQ templates expansion to 20+ intents (AI-01)** - `47b30e4` (feat)
2. **Task 2: Kafka real-time audit consumer + RCA pipeline (AI-02/AI-03)** - `cfd65ab` (feat)
3. **Fix: NLQ keyword collision resolution** - `bc866c7` (fix)

## Files Created/Modified
- `apps/backend/src/modules/ai/nlq-templates.ts` - Centralized NLQ template registry with 23 intents
- `apps/backend/src/modules/ai/nlq.service.ts` - Updated to import NLQ_TEMPLATES with keyword matching
- `apps/backend/src/modules/ai/kafka-audit.consumer.ts` - Real-time Kafka consumer for audit pipeline
- `apps/backend/src/modules/ai/audit.service.ts` - Added triggerRootCauseForTuman + PredictService DI
- `apps/backend/src/modules/ai/ai.module.ts` - Registered KafkaAuditConsumer in providers
- `apps/backend/src/modules/ai/__tests__/nlq-templates.spec.ts` - 5 tests for template registry
- `apps/backend/src/modules/ai/__tests__/kafka-audit.consumer.spec.ts` - 5 tests for consumer

## Decisions Made
- Used substring keyword matching with specificity tie-break (fewer keywords = more specific) rather than word-boundary matching, because Uzbek language uses agglutinative stems ("pasaydi" = "pasay" + "di")
- Kept KafkaAuditConsumer in AI module (not infra) since it creates domain-specific AiAuditLog entries
- Used separate Kafka consumer groupId "sifat-ai-audit" to avoid message competition with existing "sifat-library-stats" consumer
- Made PredictService optional in AuditService constructor to preserve backward-compatible test signatures

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed NLQ keyword collision between missing_books and trend_analysis**
- **Found during:** Task 1 verification (nlq.service.spec tests)
- **Issue:** "Kitobxonlik pasaydi" matched missing_books (keyword "kitob" substring in "kitobxonlik") instead of trend_analysis (keyword "pasay" substring in "pasaydi"), because both scored 1 hit and missing_books appeared first in the template array
- **Fix:** Changed missing_books keywords from single-word ["kitob", "yo'q", ...] to multi-word phrases ["kitob yo'q", "yetishmay", ...] to prevent false substring matches. Added specificity tie-break in keyword matching
- **Files modified:** nlq-templates.ts, nlq.service.ts
- **Verification:** nlq.service.spec passes all 75 tests including "pasay" and "osh" routing
- **Committed in:** bc866c7

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Fix was necessary for correct intent routing. No scope creep.

## Issues Encountered
- Pre-existing test failures in alert-types.const.spec.ts (7 failures from BOOK_CORNER_REMINDER addition in a prior plan) -- not related to this plan's changes, out of scope

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- NLQ templates ready for admin dashboard Q&A expansion
- Kafka audit consumer will activate when KAFKA_BROKERS env is set in production
- RCA pipeline fully wired for both cron-based and event-driven triggers

---
*Phase: 07-offline-pwa-internationalization-production-launch*
*Completed: 2026-06-09*
