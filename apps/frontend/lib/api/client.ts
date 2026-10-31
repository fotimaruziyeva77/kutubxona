import axios from "axios";
import { apiBase } from "./base";
import { hasAuthHintCookie } from "../auth-cookie";
import { useAuthStore } from "@/store/auth.store";

// INFRA-02: the refresh token lives ONLY in an HttpOnly cookie set by the
// backend. Browser JS never reads it. The cookie is scoped to /api/auth and
// travels automatically on cross-origin requests because of withCredentials.
//
// H16: the ACCESS token is now in-memory only (Zustand, non-persisted, no
// localStorage). After a hard reload there is no token until the boot
// refresh below re-mints one from the HttpOnly cookie.
export const apiClient = axios.create({
  baseURL: apiBase(),
  headers: { "Content-Type": "application/json" },
  withCredentials: true
});

// ── H15: single-flight refresh ───────────────────────────────────────────────
// All concurrent 401s (and the H16 boot re-mint) share ONE in-flight refresh
// promise. Refresh failure runs the logout path exactly once, guarded by
// `sessionTerminated`.

let refreshInFlight: Promise<string> | null = null;
let sessionTerminated = false;

async function doRefresh(): Promise<string> {
  if (sessionTerminated) {
    throw new Error("Session terminated — refresh suppressed");
  }
  try {
    // Bare axios (not apiClient) so this call skips our interceptors — no
    // recursion, no Authorization header. The HttpOnly refreshToken cookie
    // carries the credential; withCredentials makes it flow cross-origin.
    const { data } = await axios.post(
      `${apiBase()}/auth/refresh`,
      {},
      { withCredentials: true }
    );
    // setTokens stores the access token IN MEMORY (no localStorage — H16)
    // and re-asserts the `sl_auth` middleware hint cookie (C11): a successful
    // silent refresh proves the session is alive and extends its 30-day
    // UX-gating window. Authorization stays on the API.
    useAuthStore.getState().setTokens(data.accessToken);
    return data.accessToken as string;
  } catch (err) {
    // H15: the logout path must run EXACTLY ONCE no matter how many requests
    // were waiting on this refresh. logout() clears the in-memory tokens, the
    // sl_auth hint cookie (C11) and the offline sync queue (M20).
    if (typeof window !== "undefined" && !sessionTerminated) {
      sessionTerminated = true;
      useAuthStore.getState().logout();
      window.location.href = "/login";
    }
    throw err;
  }
}

/**
 * Single-flight access-token refresh. Concurrent callers await the same
 * promise; the slot is freed in `finally` so a later (post-recovery) call can
 * try again — but after a terminal failure `sessionTerminated` keeps the
 * logout/redirect from ever repeating.
 */
export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// ── Request: attach in-memory token; boot re-mint if needed (H16) ───────────
apiClient.interceptors.request.use(async (config) => {
  if (typeof window !== "undefined") {
    let token = useAuthStore.getState().accessToken;
    if (!token && hasAuthHintCookie() && !sessionTerminated) {
      // Hard reload with a live session: no in-memory token but the sl_auth
      // presence cookie says the HttpOnly refresh cookie should still mint.
      // One silent refresh (shared single-flight) re-establishes the token
      // before the first API call leaves — no 401 storm on boot.
      try {
        token = await refreshAccessToken();
      } catch {
        // Refresh failed — doRefresh already ran the logout path once.
        // Let the request proceed unauthenticated; the API's 401 is the
        // correct outcome while the redirect to /login is in flight.
        token = null;
      }
    }
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response: on 401, join the shared refresh and replay once (H15) ─────────
apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    // Autentifikatsiya oqimlari (login / refresh / register / OTP / parol
    // tiklash) — bu yerda 401 "telefon yoki parol noto'g'ri / OTP yaroqsiz"
    // degani, "token eskirgan" EMAS. Shunday 401'da refresh qilsak,
    // refresh ham 401 beradi → logout + /login'ga hard-redirect → foydalanuvchi
    // noto'g'ri parol kiritganda sahifa qayta otib yuboriladi. Shu sabab bu
    // endpointlarni refresh-retry'dan chetlatamiz: 401 to'g'ridan-to'g'ri
    // chaqiruvchiga (login sahifasi) qaytadi va xato matni ko'rsatiladi.
    const reqUrl: string = original?.url ?? "";
    const isAuthFlow = /\/auth\/(login|refresh|register|otp|password\/reset)/.test(reqUrl);
    // Sessiya umuman BO'LMAGAN (anonim) foydalanuvchida 401 — "token eskirgan"
    // emas, shunchaki "kirilmagan". Refresh urinishi baribir 401 beradi va
    // doRefresh logout + /login ga hard-redirect qiladi — ya'ni ochiq sahifada
    // (qidiruv, kutubxona profili) bitta himoyalangan so'rov (masalan
    // ReaderShell'ning /libraries/my-institution) anonim mehmonni login
    // sahifasiga uloqtirardi (2026-10-31, axe auditida topildi). Sessiya
    // belgisi: xotiradagi access token yoki sl_auth hint cookie.
    const hadSession =
      typeof window !== "undefined" &&
      (Boolean(useAuthStore.getState().accessToken) || hasAuthHintCookie());
    if (error.response?.status === 401 && original && !original._retry && !isAuthFlow && hadSession) {
      original._retry = true;
      try {
        const token = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${token}`;
        return apiClient(original);
      } catch {
        // Fall through — reject with the ORIGINAL 401 so callers see the
        // real failure; the logout path already ran exactly once inside
        // doRefresh.
      }
    }
    return Promise.reject(error);
  }
);
