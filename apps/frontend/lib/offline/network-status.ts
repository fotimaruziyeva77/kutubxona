// ============================================================================
// Network Status Utilities — PWA-04
// ============================================================================
// 2G detection, online/offline status, and a React hook for reactive network
// state. Used by LiteModeBanner and OfflineBanner components (Plan 07-02).
// ============================================================================

"use client";

import { useEffect, useState } from "react";

// ── Extended NetworkInformation type (not yet in lib.dom.d.ts) ──────────────

interface NetworkInformation extends EventTarget {
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  addEventListener(
    type: "change",
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "change",
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

// ── Pure utility functions ──────────────────────────────────────────────────

/**
 * Returns true when the effective connection type is "slow-2g" or "2g".
 * Used to toggle text-only lite mode (no images, minimal CSS).
 */
export function detect2G(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as NavigatorWithConnection).connection;
  if (!conn?.effectiveType) return false;
  return conn.effectiveType === "slow-2g" || conn.effectiveType === "2g";
}

/**
 * Returns true when the browser reports online status.
 * Falls back to true on SSR (no navigator).
 */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

// ── React hook ──────────────────────────────────────────────────────────────

export interface NetworkStatus {
  isOnline: boolean;
  is2G: boolean;
  effectiveType: string | undefined;
}

/**
 * Reactive hook that tracks online/offline transitions and connection type
 * changes. Updates state on "online"/"offline" window events and
 * navigator.connection "change" event.
 *
 * HYDRATION CONTRACT: the initial state is the SSR-safe default (online, not
 * 2G) on BOTH server and client, and the real values are read in the effect —
 * i.e. after hydration has committed. Reading `navigator` in the useState
 * initializer would run on the client's first render too, so a genuinely
 * offline / 2G visitor rendered a banner the server never emitted. React then
 * failed to match the trees and threw the whole route to its error boundary —
 * a blank "Kutilmagan xatolik" page for exactly the users on the worst
 * connections, which is the opposite of what lite mode is for.
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>({
    isOnline: true,
    is2G: false,
    effectiveType: undefined,
  });

  useEffect(() => {
    function update() {
      setStatus({
        isOnline: isOnline(),
        is2G: detect2G(),
        effectiveType: getEffectiveType(),
      });
    }

    // Hidratsiyadan keyingi birinchi haqiqiy o'qish.
    update();

    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    const conn = (navigator as NavigatorWithConnection).connection;
    if (conn) {
      conn.addEventListener("change", update);
    }

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      if (conn) {
        conn.removeEventListener("change", update);
      }
    };
  }, []);

  return status;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function getEffectiveType(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as NavigatorWithConnection).connection?.effectiveType;
}
