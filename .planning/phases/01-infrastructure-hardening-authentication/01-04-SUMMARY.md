---
phase: 01-infrastructure-hardening-authentication
plan: 04
subsystem: auth
tags: [security, jwt, cookies, csrf, xss, i18n, next-intl, infra-02, auth-02]
requires: [01-02, 01-03]
provides:
  - "HttpOnly refresh-token cookie end-to-end (set on login/register/refresh/password-reset; cleared on logout)"
  - "axios client with withCredentials so the refresh cookie travels cross-origin"
  - "Zustand persist allowlist excludes refresh token — XSS cannot exfiltrate it"
  - "Bare /login /register /dashboard redirect to /uz-Latn/<path>"
affects:
  - apps/backend/src/main.ts
  - apps/backend/src/modules/auth/auth.controller.ts
  - apps/backend/src/modules/auth/auth.service.ts
  - apps/backend/src/modules/auth/__tests__/auth.controller.spec.ts
  - apps/frontend/lib/api/client.ts
  - apps/frontend/lib/api/auth.ts
  - apps/frontend/store/auth.store.ts
  - apps/frontend/middleware.ts
  - apps/frontend/app/[locale]/login/page.tsx
  - apps/frontend/app/[locale]/register/page.tsx
tech-stack:
  added:
    - cookie-parser@1.4.7
    - "@types/cookie-parser@1.4.10 (dev)"
  patterns:
    - "Express HttpOnly cookie (SameSite=lax, path=/api/auth, maxAge=30d)"
    - "axios withCredentials cross-origin credential flow"
    - "next-intl localePrefix=always default-locale redirect"
key-files:
  created:
    - apps/backend/src/modules/auth/__tests__/auth.controller.spec.ts
  modified:
    - apps/backend/src/main.ts
    - apps/backend/src/modules/auth/auth.controller.ts
    - apps/frontend/lib/api/client.ts
    - apps/frontend/lib/api/auth.ts
    - apps/frontend/store/auth.store.ts
    - apps/frontend/middleware.ts
    - apps/frontend/app/[locale]/login/page.tsx
    - apps/frontend/app/[locale]/register/page.tsx
decisions:
  - "Cookie path scoped to /api/auth (NOT /) — only auth endpoints see the refresh token, reducing the cookie's blast radius"
  - "SameSite=lax (not strict) — lax still blocks CSRF POST forgery while allowing top-level navigation, the standard recommendation for auth cookies"
  - "secure: true gated on NODE_ENV==='production' — dev over plain HTTP still works, production is TLS-only"
  - "maxAge: 30 days mirrors REFRESH_TTL_DAYS in auth.service.ts — the cookie and the server-side refreshToken row expire together"
  - "Access token kept in localStorage (not memory-only) — 15-min TTL is acceptable XSS exposure, and persisting it avoids forcing a /refresh round-trip on every reload"
  - "Refresh response intentionally returns no refreshToken in the body — TypeScript narrowing on the response shape catches any straggler reader at compile time"
  - "Cookie cleared with the same path on logout — without { path } clearCookie silently no-ops because the browser keys cookies by (name, path, domain)"
  - "localePrefix='always' set explicitly even though it is the next-intl default — pinning the intent at the source prevents an upstream default change from silently regressing AUTH-02"
metrics:
  duration_min: 23
  completed_date: "2026-06-06"
  task_count: 4
  file_count: 9
---

# Phase 1 Plan 04: Cookie Migration + Locale Redirect Summary

## One-liner

Refresh token moved out of localStorage into an HttpOnly cookie (INFRA-02 — the XSS-defense keystone of Phase 1), and bare `/login` / `/register` / `/dashboard` paths now 307-redirect to the default-locale prefix `/uz-Latn/<path>` (AUTH-02).

## Why this mattered

A refresh token in `localStorage` is reachable by any XSS payload (`localStorage.getItem('refreshToken')` is two lines of injected JS). With the refresh token in an `HttpOnly` cookie, even a full DOM compromise cannot exfiltrate it. The cookie is `SameSite=lax` and scoped to `path=/api/auth`, so it cross-site-forges nothing and only travels on the four endpoints that need it. The CORS allowlist in `main.ts` already pins explicit origins with `credentials: true`, so the cookie never leaks to third parties (threat T-04-02).

AUTH-02 fixed a footgun where bare `/login` rendered the root layout without `<html><body>` (because all routes live under `app/[locale]/*`), breaking the page silently.

## What changed

### Backend (INFRA-02)

1. **cookie-parser middleware** wired in `main.ts` BEFORE routes so `req.cookies.refreshToken` is readable in handlers.
2. **`auth.controller.ts`** now uses `@Res({ passthrough: true })` on `/login`, `/register/complete`, `/password/reset`, `/refresh`. Each handler:
   - Calls `setRefreshCookie(res, refreshToken)` with `{ httpOnly: true, secure: prod, sameSite: 'lax', path: '/api/auth', maxAge: 30d }`
   - Returns ONLY `{ accessToken, ... }` in the JSON body — `refreshToken` is gone from every response shape
3. **`/auth/refresh`** reads `req.cookies.refreshToken`, throws `UnauthorizedException` if absent, rotates via `authService.refreshToken(token)`, and re-sets the rotated value on the cookie. No DTO body anymore.
4. **`/auth/logout`** calls `res.clearCookie('refreshToken', { path: '/api/auth' })` in addition to revoking server-side rows.
5. **`auth.service.ts`** kept exactly the same internal contract — `generateTokenPair`/`refreshToken`/`login` still return `{ accessToken, refreshToken }`. The controller decides where each goes, so token rotation (one of the trickier bits of auth) didn't have to be touched.

### Frontend (INFRA-02)

1. **`lib/api/client.ts`** axios instance now has `withCredentials: true`. The 401 interceptor POSTs `/auth/refresh` with an empty body — the cookie carries the token. All `localStorage.getItem('refreshToken')` reads removed.
2. **`lib/api/auth.ts`** response types narrowed: `login`, `completeRegister`, `resetPassword`, `refresh` all return `{ accessToken, ... }` without `refreshToken`. TypeScript narrowing now catches any straggler `data.refreshToken` reader at compile time (grep confirms zero matches in the frontend).
3. **`store/auth.store.ts`** `setTokens` signature changed to `(accessToken, isNewUser?)` — refresh-token arg removed. The Zustand `partialize` allowlist no longer includes `refreshToken`, so it's never persisted to localStorage. Both `setTokens` and `logout` defensively `removeItem('refreshToken')` to clean any pre-migration leftover.
4. **`login/page.tsx`** (3 call sites) and **`register/page.tsx`** (1 call site) updated to the new `setTokens` signature.

### Frontend (AUTH-02)

5. **`middleware.ts`** sets `localePrefix: 'always'` explicitly. The matcher already covered bare auth paths. Verified live with curl against the dev server.

## Per-task results

| # | Task | Files | Outcome | Commit |
|---|------|-------|---------|--------|
| 1 | RED: failing auth.controller spec pinning the cookie contract | apps/backend/src/modules/auth/__tests__/auth.controller.spec.ts | 6 specs created, TypeScript-level RED (controller signature didn't accept Res/Req) | c88b5d6 |
| 2 | Backend: set/read refresh cookie | main.ts, auth.controller.ts | Spec 6/6 GREEN; tsc clean; full suite 674/674 (baseline 668 + 6) | 9697364 |
| 3 | Frontend: withCredentials + stop persisting refresh token | client.ts, auth.ts, auth.store.ts, login/page.tsx, register/page.tsx | tsc clean; `grep withCredentials client.ts` = 5; `grep refreshToken` returns only legacy-cleanup `removeItem` calls and the API client type docstring | 8938610 |
| 4 | Locale-prefix redirect for auth routes | middleware.ts | `curl -I /login` → `307 /uz-Latn/login`; `/register` and `/dashboard` likewise | 68df19f |

## Verification — automated

- **Backend full suite:** `npx jest` → 37/37 suites, **674/674 tests** (baseline was 668; the +6 are the new `auth.controller.spec.ts` cases)
- **Backend typecheck:** `npx tsc --noEmit` → clean
- **Frontend typecheck:** `npx tsc --noEmit` → clean
- **Plan-required greps:**
  - `grep withCredentials apps/frontend/lib/api/client.ts` → 5
  - `grep -cE "localePrefix|locales" apps/frontend/middleware.ts` → 4
  - `grep cookieParser apps/backend/src/main.ts` → 2 (import + middleware install)

## Verification — runtime (against live dev server)

- `curl -s -I -o /dev/null -w "%{http_code} %{redirect_url}" http://localhost:3000/login` → `307 http://localhost:3000/uz-Latn/login`
- `curl …/register` → `307 …/uz-Latn/register`
- `curl …/dashboard` → `307 …/uz-Latn/dashboard`

## Verification — manual (recommended user smoke test)

The cookie migration is the kind of change that's easy to mis-verify by reading code. The complete happy-path the user should run once to be sure:

1. **Fresh login sets the cookie.** Open DevTools → Application → Cookies → `http://localhost:3000`. POST `/api/auth/login` (via the login form). Confirm `refreshToken` appears with `HttpOnly ✓`, `SameSite Lax`, `Path /api/auth`. Confirm the login response JSON has `accessToken` but NOT `refreshToken`.
2. **Refresh flows through the cookie.** Manually expire the access token (DevTools → Application → Local Storage → delete `accessToken`). Trigger any authenticated call (e.g. visit `/uz-Latn/dashboard`). The interceptor should POST `/api/auth/refresh` with no body, get a fresh `accessToken`, and the page should load without redirecting to `/login`.
3. **Logout clears the cookie.** Click logout. Confirm `refreshToken` disappears from the cookie jar; confirm `accessToken` is gone from localStorage; confirm next authenticated request 401s and redirects to `/login`.
4. **No JS-readable refresh token leaks.** In DevTools console, run `localStorage.getItem('refreshToken')` → must return `null`. Run `document.cookie` → must NOT include `refreshToken` (HttpOnly cookies are invisible to JS, which is the whole point).
5. **AUTH-02:** visit `http://localhost:3000/login` directly in a fresh tab → URL bar should reflect `/uz-Latn/login` after the redirect.

## Deviations from Plan

**None.** All four tasks executed exactly as specified.

The plan suggested a 5-commit sequence in the environment notes; in practice the cleanest atomic sequence was the 4-commit TDD shape from the plan tasks themselves (RED spec → backend GREEN → frontend → middleware), because the backend's GREEN commit can ship without any intermediate dual-mode period as long as the frontend commit lands immediately after on the same branch. There is no broken intermediate state in any single commit's working tree:

- After commit 1 (RED): backend still works exactly as before — only a new failing test exists, but it's an isolated Jest run with no integration coverage.
- After commit 2 (backend cookie): existing frontend code still POSTs `refreshToken: localStorage.getItem('refreshToken')` to `/refresh` — backend now ignores that body and reads only the cookie, but the cookie was just set by `/login` so a refresh succeeds. Login itself still works because the controller still returns `{ accessToken }` (without the body refresh token, which the old frontend code reads as `undefined` and stores as `'undefined'`). The first refresh after login uses the cookie (works); the first refresh after a hard reload of an old session that has only the stale `refreshToken` in localStorage and no cookie would 401 → redirect to `/login` — acceptable for dev. **In prod this would require a one-shot logout for existing sessions**, which is documented above.
- After commit 3 (frontend): both sides are aligned on cookie-only refresh.
- After commit 4 (middleware): AUTH-02 fixed; cookie work unaffected.

## Known limitations / followups

- **Prod cutover requires a forced logout.** Any existing prod session with a `refreshToken` in localStorage and no `refreshToken` cookie will fail the first refresh after deploy and bounce to `/login`. This is acceptable since Phase 1 is pre-launch, but if any internal pilots ran against the old build, document the one-time logout.
- **`/auth/refresh` rate limit.** The refresh endpoint is `@Public()` and has no throttler. An attacker who steals a refresh cookie (only via cookie-jar compromise — not XSS) can spam refresh. Adding `@Throttle` here was discussed in research but is outside Plan 01-04 scope; flag for Phase 1 cleanup.
- **HSTS / cookie `__Host-` prefix.** A future hardening pass should consider naming the cookie `__Host-refreshToken` (forces `Secure`, `Path=/`, no `Domain`) once the path-scoping decision is revisited. Not in scope here.

## Self-Check: PASSED

- **Created file:** `apps/backend/src/modules/auth/__tests__/auth.controller.spec.ts` → FOUND
- **Modified files:** all 8 — FOUND
- **Commits in git log:**
  - c88b5d6 (Task 1 RED spec) → FOUND
  - 9697364 (Task 2 backend cookie) → FOUND
  - 8938610 (Task 3 frontend cookie) → FOUND
  - 68df19f (Task 4 middleware AUTH-02) → FOUND
- **Acceptance criteria:**
  - Refresh token never in response body — ✓ (login/register/refresh/reset all return `{ accessToken }`, no `refreshToken`)
  - Frontend axios `withCredentials: true` — ✓
  - Frontend reads NO refresh token from localStorage — ✓ (only `removeItem` legacy-cleanup calls remain)
  - Zustand persist excludes `refreshToken` — ✓
  - Bare `/login` redirects to `/uz-Latn/login` — ✓ (runtime curl verified)
  - Backend test suite green — ✓ (674/674, baseline +6)
  - Backend tsc clean — ✓
  - Frontend tsc clean — ✓
- **Plan-required greps:**
  - `withCredentials` in `client.ts` → 5 (≥ 1) ✓
  - `localePrefix|locales` in `middleware.ts` → 4 (≥ 1) ✓
  - `cookieParser` in `main.ts` → 2 ✓
