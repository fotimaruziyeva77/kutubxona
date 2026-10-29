"use client";

/**
 * Plan 05-04 Task 4 — Dashboard FCM token registrar (NOTIF-02 frontend).
 *
 * Mounted in app/[locale]/dashboard/layout.tsx; renders nothing. On mount,
 * silently registers the user's FCM token if (and ONLY if) the user has
 * already granted Notification permission. NEVER prompts.
 *
 * The explicit permission flow lives in lib/fcm-client.ts as
 * requestPushPermissionAndRegister(); a future Settings page will call it
 * from a user gesture.
 *
 * Service-worker integration is DEFERRED to Phase 7 PWA — getToken() may
 * return null on browsers without an SW registered. We treat that as a
 * silent no-op (the user simply won't receive web push until then).
 */

import { useEffect } from "react";
import { getFcmToken, registerFcmToken } from "@/lib/fcm-client";

export function FcmTokenRegistrar(): null {
  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined") return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    (async () => {
      const token = await getFcmToken();
      if (cancelled || !token) return;
      await registerFcmToken(token, "web");
    })().catch(() => {
      // Errors are intentionally swallowed — lib/fcm-client.ts already logs.
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

export default FcmTokenRegistrar;
