---
phase: 01-infrastructure-hardening-authentication
plan: 02
subsystem: infra
tags: [vault, hashicorp, docker, alpine, timezone, prisma, postgres, nestjs, cron, security]

# Dependency graph
requires: []
provides:
  - "Vault fails hard in production: no dev-root-token fallback, throws on missing VAULT_TOKEN or failed health check"
  - "_assertEnvVars now requires VAULT_TOKEN and VAULT_ADDR in production"
  - "Container timezone set to Asia/Tashkent (tzdata + TZ env) so @nestjs/schedule crons fire on UTC+5 wall-clock"
  - "ReadingIndex composite index @@index([userId, calculatedAt]) in schema AND live database"
affects: [reading-index-engine, admin-crons, production-deploy, payments, monitoring]

# Tech tracking
tech-stack:
  added: [tzdata (Alpine apk package)]
  patterns: ["Production env-var assertions in main.ts _assertEnvVars", "Fail-hard secret enforcement gated on NODE_ENV==='production'"]

key-files:
  created:
    - apps/backend/src/infra/vault/vault.service.spec.ts
  modified:
    - apps/backend/src/infra/vault/vault.service.ts
    - apps/backend/src/main.ts
    - apps/backend/Dockerfile
    - docker-compose.prod.yml
    - apps/backend/prisma/schema.prisma

key-decisions:
  - "Gated dev-root-token fallback behind NODE_ENV !== 'production' instead of removing it (dev startup unchanged)"
  - "Installed tzdata in the runner stage (not builder) since TZ must take effect at runtime; ENV TZ alone is silently ignored on Alpine without tzdata"
  - "Applied the index via 'prisma db push --skip-generate' because prisma generate hit a Windows EPERM file-lock from the running dev server; the DB change is the load-bearing deliverable and was verified directly via psql"

patterns-established:
  - "Production-only fail-hard: secret/config checks throw only when NODE_ENV==='production', leaving dev permissive"
  - "Alpine timezone correctness requires both tzdata package and TZ env, never TZ alone"

requirements-completed: [INFRA-04, INFRA-05, INFRA-06]

# Metrics
duration: 6min
completed: 2026-06-06
---

# Phase 1 Plan 02: Infrastructure Hardening Summary

**Vault fail-hard in production (no dev-token fallback), Asia/Tashkent container timezone via tzdata, and a ReadingIndex composite index applied to the live Postgres.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-06-06T08:45:53Z
- **Completed:** 2026-06-06T08:51:12Z
- **Tasks:** 4
- **Files modified:** 5 (1 created, 4 modified) + 1 live DB index applied

## Accomplishments
- VaultService now throws in production when `VAULT_TOKEN` is missing or the Vault health check fails — eliminating the silent `dev-root-token` fallback (government-audit requirement, PITFALLS H5). Dev behavior is unchanged.
- `main.ts` `_assertEnvVars` asserts `VAULT_TOKEN` + `VAULT_ADDR` in production so the process aborts at boot if Vault config is absent.
- Production container resolves cron schedules on `Asia/Tashkent` (UTC+5): added the mandatory `tzdata` Alpine package + `ENV TZ=Asia/Tashkent` in the Dockerfile and `TZ: Asia/Tashkent` in the prod compose backend service. This prevents the nightly RI / PENDING-fallback crons from firing 5 hours off (PITFALLS UZ5).
- `ReadingIndex` model gained `@@index([userId, calculatedAt])` in the schema, and the index was physically pushed to and verified in the live database (`ReadingIndex_userId_calculatedAt_idx`). Prevents full-table scans as the table grows (PITFALLS C5).
- Full backend test suite green: 31 suites / 634 tests passing after the changes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Vault fail-hard in production (INFRA-04, TDD)** - `5735ef4` (fix) — combined RED+GREEN in one commit (spec + implementation); 5 vault.service.spec tests pass
2. **Task 2: Container timezone Asia/Tashkent (INFRA-05)** - `0300911` (feat)
3. **Task 3: ReadingIndex composite index (INFRA-06)** - `6a3564e` (feat)
4. **Task 4: [BLOCKING] Push schema to database (INFRA-06)** - no source commit (DB-only operation); index verified live via psql

**Plan metadata:** see final docs commit.

## Files Created/Modified
- `apps/backend/src/infra/vault/vault.service.ts` - Throws in prod on missing token / failed health check; dev keeps dev-root-token fallback + warn
- `apps/backend/src/infra/vault/vault.service.spec.ts` - New spec proving prod-throw vs dev-warn divergence (5 tests, node-vault mocked)
- `apps/backend/src/main.ts` - `_assertEnvVars` now lists `VAULT_TOKEN` + `VAULT_ADDR` (production)
- `apps/backend/Dockerfile` - runner stage installs `tzdata` and sets `ENV TZ=Asia/Tashkent`
- `docker-compose.prod.yml` - backend service `environment` gains `TZ: Asia/Tashkent`
- `apps/backend/prisma/schema.prisma` - `ReadingIndex` gains `@@index([userId, calculatedAt])`

## Decisions Made
- **Dev-token fallback gated, not deleted:** kept `token ?? "dev-root-token"` reachable only when `NODE_ENV !== 'production'`, so local dev startup is unaffected while production hard-fails.
- **tzdata in runner stage:** the timezone DB must exist in the runtime image; setting `TZ` without `tzdata` on Alpine is silently ignored.
- **db push via `--skip-generate`:** authorized fallback used because `prisma generate` could not complete (see Deviations); the index — the actual deliverable — was applied and independently verified.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Jest `-x` flag unsupported by installed Jest version**
- **Found during:** Task 1 (Vault TDD verification)
- **Issue:** The plan's `<automated>` verify command `npx jest vault.service.spec -x` failed with "Unrecognized option 'x'" — this Jest version does not accept `-x`.
- **Fix:** Used `--bail` (the equivalent "stop on first failure" flag) for the targeted run; full-suite run used plain `npx jest`. No source change.
- **Files modified:** None (command-only).
- **Verification:** `npx jest vault.service.spec --bail` → 5 passed.
- **Committed in:** N/A (no file change).

**2. [Rule 3 - Blocking] `prisma generate` blocked by Windows EPERM file-lock**
- **Found during:** Task 4 ([BLOCKING] schema push)
- **Issue:** `npx prisma generate` repeatedly failed with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node` — the query-engine DLL is held open by the running dev/preview server on Windows. Killing the user's running server was out of scope.
- **Fix:** Followed the plan's documented fallback and ran `npx prisma db push --skip-generate`. Adding an index does not change the generated Prisma Client's TypeScript API, so the existing generated client remains valid; the push (the load-bearing requirement) succeeded.
- **Files modified:** None (DB-only operation).
- **Verification:** `prisma db push` reported "Your database is now in sync with your Prisma schema"; `docker exec sifat-postgres psql ... pg_indexes WHERE tablename='ReadingIndex'` confirms `ReadingIndex_userId_calculatedAt_idx ON ("userId","calculatedAt")` exists in the live DB.
- **Committed in:** N/A (no file change).

**3. [Process note] TDD Task 1 committed RED+GREEN together**
- **Found during:** Task 1
- **Issue:** Standard TDD flow commits a failing `test(...)` then a `feat(...)`. I confirmed RED (2 prod tests failing against the unmodified service) before implementing, but committed the spec and the implementation in a single `fix(...)` commit.
- **Fix:** RED was verified in-session (output captured) prior to implementation; the combined commit keeps the working tree coherent. No functional impact.
- **Files modified:** vault.service.ts, vault.service.spec.ts, main.ts.
- **Verification:** RED output showed 2 failing / 3 passing before the fix; GREEN showed 5/5 after.
- **Committed in:** `5735ef4`.

---

**Total deviations:** 3 (2 blocking-issue workarounds, 1 process note) — all environmental, none altering plan intent.
**Impact on plan:** No scope creep. All three INFRA requirements delivered as specified; the database index is physically present and verified.

## Issues Encountered
- **Windows `prisma generate` EPERM lock:** the running dev server holds the Prisma query-engine DLL, preventing regeneration. Resolved by using `db push --skip-generate` per the plan and verifying the index directly in Postgres. The generated client on disk stays valid because an index addition does not change client types. If the dev server is restarted, a clean `npx prisma generate` will succeed (no code action required).

## User Setup Required
None for dev. For production deploy, the new fail-hard behavior means `VAULT_TOKEN` and `VAULT_ADDR` MUST be present in the prod environment/Vault or the backend will refuse to start (this is the intended INFRA-04 behavior). The prod image must be rebuilt to pick up the `tzdata` + `TZ` Dockerfile changes.

## Next Phase Readiness
- Vault is now audit-compliant in production; downstream plans relying on secrets are unaffected in dev.
- Cron timing is correct for the production container once rebuilt — relevant to the Reading Index engine and admin PENDING-fallback crons.
- ReadingIndex is indexed in the live DB; RI history queries and the nightly cron will use the composite index.
- Remaining Phase 1 plans (notifications/Eskiz, cookie refresh, global guard, Kafka consumer, OneID, PgBouncer/replica) are independent of these fixes.

## Self-Check: PASSED

All created/modified files exist on disk; all task commits (`5735ef4`, `0300911`, `6a3564e`) present in git history; live DB index `ReadingIndex_userId_calculatedAt_idx` verified via psql.

---
*Phase: 01-infrastructure-hardening-authentication*
*Completed: 2026-06-06*
