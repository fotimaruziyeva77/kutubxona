---
phase: 07-offline-pwa-internationalization-production-launch
plan: 06
subsystem: testing
tags: [k6, owasp-zap, axe-core, lighthouse-ci, wcag, accessibility, load-testing, security-scan]

requires:
  - phase: 07-01
    provides: "axe-core and @lhci/cli dev dependencies, Serwist PWA setup"
  - phase: 07-02
    provides: "Offline sync infrastructure, service worker"
  - phase: 07-03
    provides: "i18n locale files for all 4 languages"
provides:
  - "k6 load test scripts for 5K VU single-machine and 50K distributed scaling"
  - "OWASP ZAP baseline scan config for API security testing"
  - "axe-core WCAG 2.1 audit spec (Jest + JSDOM)"
  - "SkipNavLink component for keyboard bypass navigation"
  - "Lighthouse CI config with Performance 90+, Accessibility 90+, SEO 95+"
  - "main-content landmark ID in layout for skip navigation"
affects: [07-07, production-launch, ci-cd-pipeline]

tech-stack:
  added: []
  patterns:
    - "axe-core JSDOM audit pattern for WCAG testing"
    - "k6 staged VU ramp pattern for load testing"
    - "SkipNavLink sr-only focus pattern for WCAG 2.4.1"

key-files:
  created:
    - tests/k6/load-test.js
    - tests/k6/smoke-test.js
    - tests/security/owasp-zap-config.yaml
    - tests/accessibility/axe-audit.spec.ts
    - tests/accessibility/jest.config.ts
    - tests/accessibility/tsconfig.json
    - apps/frontend/components/accessibility/SkipNavLink.tsx
    - lighthouserc.js
  modified:
    - apps/frontend/app/[locale]/layout.tsx
    - apps/frontend/messages/uz-Latn.json
    - apps/frontend/messages/uz-Cyrl.json
    - apps/frontend/messages/kaa.json
    - apps/frontend/messages/ru.json

key-decisions:
  - "axe-audit uses HTML fixtures (not live fetch) for deterministic JSDOM testing"
  - "k6 defaults to localhost:3001 with documented 50K distributed scaling path"
  - "SkipNavLink wraps children in main#main-content inside Providers"

patterns-established:
  - "sr-only focus:not-sr-only pattern for skip links"
  - "Separate jest.config.ts + tsconfig.json for standalone test suites outside app dirs"

requirements-completed: [PERF-01, PERF-02, PERF-03, PERF-04]

duration: 5min
completed: 2026-06-09
---

# Phase 7 Plan 6: Testing Infrastructure Summary

**k6 load tests (5K VU ramp), OWASP ZAP security config, axe-core WCAG 2.1 audit, SkipNavLink keyboard navigation, and Lighthouse CI with 90+/90+/95+ score thresholds**

## Performance

- **Duration:** 5 min
- **Started:** 2026-06-09T01:20:33Z
- **Completed:** 2026-06-09T01:25:48Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- k6 load-test.js with 5K VU staged ramp testing 5 critical API endpoints (p95 < 200ms threshold)
- k6 smoke-test.js for pre-deploy 10 VU sanity checks (30s duration)
- OWASP ZAP baseline scan config with API context filtering, spider/active scan limits, false-positive rule suppression
- axe-core WCAG 2.1 audit spec (6 passing tests across 3 page fixtures, critical/serious violation detection)
- SkipNavLink component with i18n support across all 4 locales (WCAG 2.4.1 Bypass Blocks)
- Lighthouse CI config enforcing Performance 90+, Accessibility 90+, SEO 95+, Best Practices 85+
- Layout updated with SkipNavLink as first body child and main#main-content landmark

## Task Commits

Each task was committed atomically:

1. **Task 1: k6 load tests + OWASP ZAP config** - `c18179d` (test)
2. **Task 2: Accessibility audit + SkipNavLink + Lighthouse CI** - `79156a4` (feat)

## Files Created/Modified
- `tests/k6/load-test.js` - 5K VU load test with 5 API endpoints and p95 < 200ms threshold
- `tests/k6/smoke-test.js` - 10 VU / 30s pre-deploy sanity check
- `tests/security/owasp-zap-config.yaml` - ZAP baseline scan with API context, spider 5min/depth 5
- `tests/accessibility/axe-audit.spec.ts` - Jest WCAG 2.1 audit with auditPage/assertNoA11yViolations helpers
- `tests/accessibility/jest.config.ts` - Standalone jest config for accessibility tests
- `tests/accessibility/tsconfig.json` - TS config with esModuleInterop for axe-core
- `apps/frontend/components/accessibility/SkipNavLink.tsx` - Skip-to-content link component
- `lighthouserc.js` - Lighthouse CI with score assertions for 3 URLs
- `apps/frontend/app/[locale]/layout.tsx` - Added SkipNavLink + main#main-content
- `apps/frontend/messages/uz-Latn.json` - Added accessibility.skipToContent key
- `apps/frontend/messages/uz-Cyrl.json` - Added accessibility.skipToContent key
- `apps/frontend/messages/kaa.json` - Added accessibility.skipToContent key
- `apps/frontend/messages/ru.json` - Added accessibility.skipToContent key

## Decisions Made
- axe-audit uses HTML fixtures rather than live HTTP fetch for deterministic JSDOM testing without requiring a running server
- k6 load test defaults to localhost:3001 (backend port) with documented Docker commands for both dev and staging
- SkipNavLink is rendered as first child inside body/NextIntlClientProvider (before Providers) so it gets i18n context
- Separate jest.config.ts with its own tsconfig.json for accessibility tests (esModuleInterop needed for axe-core default import)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created tsconfig.json for axe-core esModuleInterop**
- **Found during:** Task 2 (axe-audit spec)
- **Issue:** axe-core uses `export =` which requires esModuleInterop for default import
- **Fix:** Created tests/accessibility/tsconfig.json with esModuleInterop: true and pointed jest.config.ts to it
- **Files modified:** tests/accessibility/tsconfig.json, tests/accessibility/jest.config.ts
- **Verification:** All 6 axe-audit tests pass
- **Committed in:** 79156a4 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for axe-core import compatibility. No scope creep.

## Issues Encountered
- Pre-existing TypeScript error in apps/frontend/app/[locale]/profile/recommendations/page.tsx (isLiteMode property) not introduced by this plan, not in scope

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Testing infrastructure complete for CI/CD pipeline integration
- k6 and ZAP scripts ready for Docker-based execution in GitHub Actions
- Lighthouse CI autorun configured for 3 URLs with score thresholds
- Plan 07-07 (final wave) can proceed

---
*Phase: 07-offline-pwa-internationalization-production-launch*
*Completed: 2026-06-09*
