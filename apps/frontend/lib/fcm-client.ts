/**
 * Plan 05-04 Task 4 — Browser FCM helper (NOTIF-02).
 *
 * Three exported helpers:
 *   - getFcmToken()                       — lazy-loads firebase, returns token
 *                                           or null (no env, no permission, SSR)
 *   - registerFcmToken(token, platform?)  — POST /users/me/device-tokens
 *   - requestPushPermissionAndRegister()  — explicit user-initiated flow
 *
 * Privacy-respect (per Q4): we NEVER auto-prompt for Notification permission.
 * The dashboard registrar only acts if permission === 'granted'. The explicit
 * request flow is opt-in only — invoked from a Settings UI in Phase 6/7.
 *
 * Web push service worker integration is DEFERRED to Phase 7 PWA. Without an
 * SW, getToken() may return null in some browsers — we treat that as a silent
 * no-op rather than an error.
 */

// Use the fetch-like wrapper (lib/api-client.ts) — exposes `.ok` + `.json()`
// so this module doesn't bind to axios response semantics.
import { apiClient } from "./api-client";

/**
 * Lazy-load Firebase modules + acquire an FCM registration token for this
 * browser. Returns null in the following cases (all expected, no thrown error):
 *
 *   - Running server-side (typeof window === 'undefined')
 *   - NEXT_PUBLIC_FCM_VAPID_KEY (or any FIREBASE_* env) is unset
 *   - Notification API unavailable (older browser)
 *   - Notification.permission !== 'granted' (user hasn't granted)
 *   - getToken() returns empty (no service worker registered yet, etc.)
 */
export async function getFcmToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (typeof Notification === "undefined") return null;
  if (Notification.permission !== "granted") return null;

  const vapidKey = process.env.NEXT_PUBLIC_FCM_VAPID_KEY;
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

  if (!vapidKey || !apiKey || !projectId || !messagingSenderId || !appId) {
    // No FCM config in this env — silent no-op (dev / staging without push).
    return null;
  }

  try {
    // Lazy import to keep the landing-page bundle slim for users that never
    // visit the dashboard.
    const { initializeApp, getApps } = await import("firebase/app");
    const { getMessaging, getToken, isSupported } = await import("firebase/messaging");

    if (!(await isSupported())) return null;

    const apps = getApps();
    const app =
      apps[0] ??
      initializeApp({
        apiKey,
        projectId,
        messagingSenderId,
        appId,
      });

    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey });
    return token || null;
  } catch (err) {
    // Most common: service worker not yet registered (deferred to Phase 7).
    // Log to console so devs can spot the cause, but never surface to UI.
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[fcm] getFcmToken failed:", err);
    }
    return null;
  }
}

/**
 * Persist the FCM token to the backend so the notification.processor can fan
 * out pushes from a userId. Caches the last-registered token in localStorage
 * to avoid a network round-trip on every dashboard mount.
 */
export async function registerFcmToken(
  token: string,
  platform: "web" | "android" | "ios" = "web",
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!token) return;

  try {
    const cached = window.localStorage.getItem("sifat.fcm.lastToken");
    if (cached === token) return; // Already registered this session.

    const res = await apiClient("/users/me/device-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, platform }),
    });

    if (res.ok) {
      window.localStorage.setItem("sifat.fcm.lastToken", token);
    } else if (typeof console !== "undefined" && console.warn) {
      console.warn(`[fcm] registerFcmToken non-2xx: ${res.status}`);
    }
  } catch (err) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[fcm] registerFcmToken failed:", err);
    }
  }
}

/**
 * Explicit user-initiated flow: ask for permission, then acquire + register
 * the token. Returns the granted state so the caller can show appropriate UI.
 *
 * NOT called automatically. The dashboard registrar (FcmTokenRegistrar) only
 * acts when permission is ALREADY granted. The permission prompt must be
 * driven by a clear user gesture in a future Settings page.
 */
export async function requestPushPermissionAndRegister(): Promise<{
  token: string | null;
  granted: boolean;
}> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return { token: null, granted: false };
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return { token: null, granted: false };
    }
  }

  if (permission !== "granted") return { token: null, granted: false };

  const token = await getFcmToken();
  if (token) await registerFcmToken(token, "web");
  return { token, granted: true };
}
