---
phase: 7
slug: offline-pwa-internationalization-production-launch
status: ready
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-09
updated: 2026-06-09
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Jest 30 (backend) + Jest (frontend) |
| **Config file** | apps/backend/jest.config.ts |
| **Quick run command** | `npm test -w apps/backend -- --testPathPattern="<pattern>" --no-coverage` |
| **Full suite command** | `npm test -w apps/backend` |
| **Estimated runtime** | ~90 seconds |
| **Coverage gate** | 80% lines |

---

## Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PWA-01 | Serwist SW precaches pages | smoke | Lighthouse PWA audit via @lhci/cli | No -- Wave 0 |
| PWA-02 | Dexie stores offline catalog | unit | `jest --testPathPattern=offline-db` | No -- Wave 0 |
| PWA-03 | 12h offline cache + sync indicator | integration | Manual test (requires network simulation) | Manual-only |
| PWA-04 | 2G detection triggers lite mode | unit | `jest --testPathPattern=network-status` | No -- Wave 0 |
| PWA-05 | Auth token included in sync replay | unit | `jest --testPathPattern=sync` | No -- Wave 0 |
| PWA-06 | Sync conflict resolution | unit | `jest --testPathPattern=conflict-resolver` | No -- Wave 0 |
| I18N-01 | Karakalpak full translation | unit | Build-time key-diff script | No -- Wave 0 |
| I18N-02 | Russian full translation | unit | Build-time key-diff script | No -- Wave 0 |
| I18N-03 | Multi-script ES analyzer | integration | `jest --testPathPattern=elasticsearch` | Exists |
| PERF-01 | 50K concurrent users p95<200ms | load | `docker run grafana/k6 run tests/k6/load-test.js` | No -- Wave 0 |
| PERF-02 | OWASP Top 10 no P1 | security | `docker run zaproxy zap-baseline.py` | No -- Wave 0 |
| PERF-03 | Lighthouse 90+ perf/a11y | smoke | `npx @lhci/cli autorun` | No -- Wave 0 |
| PERF-04 | WCAG 2.1 keyboard/contrast | unit + manual | `jest --testPathPattern=axe-audit` + manual | No -- Wave 0 |
| PERF-05 | Audit log 2yr retention | unit | `jest --testPathPattern=audit-partition` | No -- Wave 0 |
| PERF-06 | Hide reading history | unit | `jest --testPathPattern=privacy` | No -- Wave 0 |
| AI-01 | 20+ NLQ templates | unit | `jest --testPathPattern=nlq.service` | Exists |
| AI-02 | Kafka real-time audit | unit | `jest --testPathPattern=kafka-audit` | No -- Wave 0 |
| AI-03 | Root cause analysis | unit | `jest --testPathPattern=predict.service` | Exists |
| AI-04 | Book recommendations | unit | `jest --testPathPattern=recommend.service` | Exists |
| AI-05 | 1-month RI forecast | unit | `jest --testPathPattern=predict.service` | Exists |

---

## Sampling Rate

- **Per task commit:** `npm test -w apps/backend -- --testPathPattern="<changed-module>" --no-coverage`
- **Per wave merge:** `npm test -w apps/backend`
- **Phase gate:** Full backend suite green + Lighthouse 90+ + k6 thresholds pass before `/gsd-verify-work`

---

## Wave 0 Gaps

- [ ] `apps/frontend/lib/offline/__tests__/db.test.ts` -- covers PWA-02
- [ ] `apps/frontend/lib/offline/__tests__/sync.test.ts` -- covers PWA-05, PWA-06
- [ ] `apps/frontend/lib/offline/__tests__/network-status.test.ts` -- covers PWA-04
- [ ] `tests/k6/load-test.js` -- covers PERF-01
- [ ] `tests/accessibility/axe-audit.spec.ts` -- covers PERF-04 (Jest spec, not standalone script)
- [ ] `apps/backend/src/modules/ai/__tests__/kafka-audit.consumer.spec.ts` -- covers AI-02
- [ ] `apps/backend/src/modules/users/__tests__/privacy.service.spec.ts` -- covers PERF-06
- [ ] `scripts/i18n-key-check.ts` -- covers I18N-01, I18N-02
- [ ] Serwist + Dexie.js dev dependency install (frontend)
- [ ] k6 Docker pull: `docker pull grafana/k6`
