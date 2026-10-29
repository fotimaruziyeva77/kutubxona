/**
 * C11 — `sl_auth` auth-presence hint cookie.
 *
 * The real credentials are invisible to the middleware:
 *   - refresh token = HttpOnly cookie scoped to /api/auth (JS + middleware
 *     can't read it),
 *   - access token  = Zustand/localStorage (server can't read it).
 *
 * So the middleware needs a lightweight, NON-HttpOnly presence cookie to do
 * route gating. IMPORTANT: this cookie is UX gating ONLY — it carries no
 * secret, proves nothing, and can be forged by anyone in DevTools. Real
 * authorization stays on the API (JWT Bearer + RBAC guards); a forged
 * sl_auth just shows an empty shell page whose every API call returns
 * 401/403.
 *
 * Lifetime mirrors the refresh-token TTL (30 days): while the HttpOnly
 * refresh cookie can still mint new access tokens, the user is effectively
 * logged in and should not be bounced to /login by the middleware.
 */
export const AUTH_HINT_COOKIE = "sl_auth";

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

export function setAuthHintCookie(): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${AUTH_HINT_COOKIE}=1; Path=/; Max-Age=${THIRTY_DAYS_S}; SameSite=Lax${secure}`;
}

export function clearAuthHintCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${AUTH_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * H16 boot check: is the `sl_auth` presence cookie set? Used to decide
 * whether a hard-reloaded tab should attempt ONE silent refresh to re-mint
 * the in-memory access token. Like everything about this cookie it is a
 * HINT, not proof — the refresh call itself is the arbiter.
 */
export function hasAuthHintCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${AUTH_HINT_COOKIE}=`));
}
