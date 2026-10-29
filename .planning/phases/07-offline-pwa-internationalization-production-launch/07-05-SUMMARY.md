---
phase: "07"
plan: "05"
subsystem: ai-recommendations-predictions
tags: [ai, recommendations, predictions, frontend, backend]
dependency_graph:
  requires: [07-01]
  provides: [AI-04-frontend, AI-05-endpoints]
  affects: [profile-page, ai-controller, predict-service]
tech_stack:
  added: []
  patterns: [4-strategy-weighted-merge, linear-regression-forecast, scope-based-predict-api]
key_files:
  created:
    - apps/frontend/app/[locale]/profile/recommendations/page.tsx
  modified:
    - apps/backend/src/modules/ai/ai.controller.ts
    - apps/backend/src/modules/ai/recommend.service.ts
    - apps/frontend/messages/uz-Latn.json
    - apps/frontend/messages/uz-Cyrl.json
    - apps/frontend/messages/kaa.json
    - apps/frontend/messages/ru.json
decisions:
  - "Injected RecommendService and PredictService directly into AiController instead of proxying through AiService"
  - "Updated strategy weights from 0.4/0.35/0.15/0.1 to plan-spec 0.35/0.3/0.2/0.15"
  - "Reordered predict routes: specific before generic to prevent NestJS param conflicts"
  - "Kept legacy recommend/user/:userId endpoint for backward compatibility alongside new /recommendations"
metrics:
  duration: "6m"
  completed: "2026-06-09T01:09:09Z"
  tasks: 2
  files_changed: 8
---

# Phase 07 Plan 05: AI Recommendations Frontend + Predictive Analytics Summary

4-strategy book recommendation engine wired to frontend profile page with i18n support; scope-based predict endpoints verified with linear regression and 1.96*stdError confidence intervals

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Recommendations frontend + controller endpoint (AI-04) | 9676163 | New recommendations page, controller endpoints, weight fix, i18n |
| 2 | Predictive analytics endpoint verification + specs (AI-05) | 5c8d0c4 | Route ordering fix, scope-based predict endpoints, verification |

## What Was Built

### Task 1: Recommendations Frontend (AI-04)
- **Controller endpoints**: Added `GET /ai/recommendations` (authenticated user gets own recommendations) and `GET /ai/recommendations/:userId` (admin-only, for oversight). Both call `recommendService.getRecommendations()` directly.
- **Strategy weights updated**: Changed from 0.4/0.35/0.15/0.1 to plan-spec 0.35/0.3/0.2/0.15 (contentBased/collaborative/regional/popular).
- **Frontend page**: Created `app/[locale]/profile/recommendations/page.tsx` -- a client component that fetches `/ai/recommendations`, displays 5 book cards with title, author, genre badge, availability indicator, recommendation reason, and search link.
- **i18n**: Added `recommendations` namespace keys to all 4 locale files (uz-Latn, uz-Cyrl, kaa, ru) to prevent i18n-key-check failures from 07-03.
- **Legacy compatibility**: Kept `recommend/user/:userId` endpoint alongside new `/recommendations` path.

### Task 2: Predictive Analytics Verification (AI-05)
- **Scope-based endpoints**: Added `GET /ai/predict/:scopeType/:scopeId` (RI forecast) and `GET /ai/predict/:scopeType/:scopeId/causes` (Root Cause Analysis). Both admin-only with `@Roles(...ADMIN_ROLES)`.
- **Route ordering fix**: Moved specific routes (national-goal, tuman/:id, fund/:id) before generic `:scopeType/:scopeId` routes to prevent NestJS matching "tuman" as a scopeType param.
- **Service verification**: predict.service.ts confirmed to have:
  - `predictTumanRi()`: 12-month historical + linear regression forecast, `1.96 * stdError` confidence interval, R-squared trend detection
  - `analyzeRootCause()`: 5-factor analysis (library inactive, stale fund, youth disengagement, seasonal effect, unknown fallback), sorted by impact severity
  - `predictFundShortage()`: daily borrow rate extrapolation for 14-day horizon
  - `nationalGoalForecast()`: yearly projection against PQ-9 10-book target

## Test Results

- **recommend.service.spec.ts**: 28 tests passing (content-based, collaborative, regional, popular, club recommendations, caching, deduplication)
- **predict.service.spec.ts**: 24 tests passing (predictTumanRi, predictFundShortage, analyzeRootCause, nationalGoalForecast, caching, edge cases)
- **Total**: 52 tests, all passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed route ordering conflict**
- **Found during:** Task 2
- **Issue:** Generic `predict/:scopeType/:scopeId` routes would shadow specific routes like `predict/tuman/:tumanId` in NestJS
- **Fix:** Moved specific routes before generic ones with a comment explaining the ordering requirement
- **Files modified:** apps/backend/src/modules/ai/ai.controller.ts
- **Commit:** 5c8d0c4

**2. [Rule 2 - Missing critical functionality] Direct service injection**
- **Found during:** Task 1
- **Issue:** ai.controller.ts proxied recommend/predict calls through aiService instead of using the dedicated services directly
- **Fix:** Injected RecommendService and PredictService into AiController constructor, wired endpoints directly
- **Files modified:** apps/backend/src/modules/ai/ai.controller.ts
- **Commit:** 9676163

## Known Stubs

None. All 4 recommendation strategies are fully implemented with real Prisma queries. Prediction service uses real linear regression.

## Self-Check: PASSED
