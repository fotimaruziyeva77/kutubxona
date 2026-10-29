import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { locales, defaultLocale } from "./i18n";

// AUTH-02: All app routes live under app/[locale]/* (login, register,
// dashboard, profile, search, top, etc.). A bare URL like /login has no
// locale segment and therefore falls outside the [locale] segment — Next
// would render the root layout with no html/body and break the page.
//
// Fix: configure next-intl with localePrefix='always'. In this mode the
// middleware actively redirects bare paths to the default-locale prefixed
// form, so:
//   /login    → 307 /uz-Latn/login
//   /register → 307 /uz-Latn/register
//   /         → 307 /uz-Latn
//
// 'always' is also the next-intl default, but we set it explicitly so the
// intent is visible at the source and so an upstream default change cannot
// silently regress AUTH-02.
const intlMiddleware = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: "always",
  // Milliy O'zbek platformasi — brauzer tilidan (Accept-Language) qat'i nazar
  // doim uz-Latn'da ochiladi. localeDetection:false bo'lmasa, rus tilli brauzer
  // bare "/" ni /ru ga yo'naltirardi. Til endi faqat almashtirgich (yoki URL
  // prefiksi) orqali o'zgaradi.
  localeDetection: false
});

// ─── C11: auth route gating ──────────────────────────────────────────────────
//
// The middleware cannot see the real credentials: the refresh token is an
// HttpOnly cookie path-scoped to /api/auth, and the access token lives in
// Zustand/localStorage. Instead we gate on the non-HttpOnly `sl_auth`
// presence cookie set by the auth store on login/refresh and cleared on
// logout (see lib/auth-cookie.ts).
//
// THIS IS UX GATING ONLY. The cookie carries no secret and can be forged in
// DevTools — real authorization stays on the API (JWT Bearer + RBAC guards).
// The gate exists so anonymous visitors never see authed shells (dashboard
// sidebar, scan terminal, …) and instead land on /login with a `next` param.
const AUTH_HINT_COOKIE = "sl_auth";

// Matchers run against the LOCALE-STRIPPED pathname.
//
// Protected subtrees (the section and everything under it):
//   /dashboard — admin panel (all roles' back office)
//   /profile   — the reader's own data (history, QR, settings)
//   /scan      — librarian QR/ISBN terminal (+ /scan/reading-hour/[id])
//
// Protected exact paths (children are PUBLIC pages):
//   /family — family management page; /family/[familyId] is the public
//             Top-50 profile (FAM-05) and must stay open
//   /dokon  — OMMAVIY do'konlar ro'yxati (katalog); /dokon/[slug] — ommaviy
//             do'kon profili. Ikkalasi ham ochiq.
//
// Protected pattern (operator-only store subpages):
//   /dokon/[slug]/(dashboard|sell|settings|products)
const PROTECTED_SUBTREES = ["/dashboard", "/profile", "/scan"];
const PROTECTED_EXACT = ["/family"];
const STORE_CRM_RE = /^\/dokon\/[^/]+\/(dashboard|sell|settings|products)(\/|$)/;

function isProtectedPath(pathname: string): boolean {
  if (
    PROTECTED_SUBTREES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`)
    )
  ) {
    return true;
  }
  if (PROTECTED_EXACT.some((p) => pathname === p || pathname === `${p}/`)) {
    return true;
  }
  return STORE_CRM_RE.test(pathname);
}

export default function middleware(request: NextRequest) {
  const response = intlMiddleware(request);

  // If next-intl issued a redirect (e.g. bare /dashboard → /uz-Latn/dashboard)
  // return it untouched: the browser re-requests the locale-prefixed URL and
  // the auth gate below runs on that second pass. This preserves every
  // existing intl behavior (AUTH-02 included).
  if (response.status >= 300 && response.status < 400) {
    return response;
  }

  const { pathname, search } = request.nextUrl;
  const segments = pathname.split("/"); // "/uz-Latn/dashboard" → ["", "uz-Latn", "dashboard"]
  const maybeLocale = segments[1];
  const hasLocale = (locales as readonly string[]).includes(maybeLocale);
  const locale = hasLocale ? maybeLocale : defaultLocale;
  const pathWithoutLocale = hasLocale
    ? `/${segments.slice(2).join("/")}`
    : pathname;

  if (
    isProtectedPath(pathWithoutLocale) &&
    !request.cookies.has(AUTH_HINT_COOKIE)
  ) {
    const loginUrl = new URL(`/${locale}/login`, request.url);
    // Send the user back where they were headed after login. The login page
    // validates this as a same-origin relative path before following it.
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

// The matcher must include bare /login, /register, and every other bare
// auth/app path. We exclude only:
//   - /api    — backend reverse-proxied API
//   - /_next  — Next internals (chunks, hot reload)
//   - /_vercel — Vercel internals
//   - any path with a literal dot (static files: .ico, .png, .css, etc.)
// /login, /register, /dashboard, ... all match because they contain none of
// the above excluded substrings.
export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"]
};
