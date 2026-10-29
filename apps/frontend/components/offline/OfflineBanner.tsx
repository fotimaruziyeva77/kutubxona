"use client";

// ============================================================================
// Offline Banner — PWA-03
// ============================================================================
// Fixed-top amber banner displayed when navigator.onLine is false.
// Shows "Offline rejim" message with a SyncStatusBadge for pending count.
// When connection is restored, shows a brief green "Qayta ulandi" toast.
// ============================================================================

import { useEffect, useState } from "react";
import { useNetworkStatus } from "@/lib/offline/network-status";
import { SyncStatusBadge } from "./SyncStatusBadge";

export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  // DEBOUNCE: navigator.onLine beqaror tarmoqda qisqa muddatga false bo'lib
  // qaytishi mumkin (DNS/IPv6 blip). Bannerni faqat 3s barqaror offline'dan
  // keyin ko'rsatamiz — aks holda "ayrim payt offline rejim chiqib qoladi".
  const [confirmedOffline, setConfirmedOffline] = useState(false);
  const [showReconnected, setShowReconnected] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (isOnline) {
      setConfirmedOffline(false);
      return;
    }
    const t = setTimeout(() => setConfirmedOffline(true), 3000);
    return () => clearTimeout(t);
  }, [isOnline]);

  useEffect(() => {
    if (confirmedOffline) {
      setWasOffline(true);
    } else if (wasOffline) {
      // Just came back online (after a confirmed offline period)
      setShowReconnected(true);
      const timer = setTimeout(() => {
        setShowReconnected(false);
        setWasOffline(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [confirmedOffline, wasOffline]);

  if (showReconnected) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="w-full z-50 bg-green-600 text-white text-center py-2 px-4 text-sm font-medium shadow-md"
      >
        Qayta ulandi
      </div>
    );
  }

  if (confirmedOffline) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="w-full z-50 bg-amber-500 text-white text-center py-2 px-4 text-sm font-medium shadow-md flex items-center justify-center gap-3"
      >
        <svg
          className="h-4 w-4 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728M8.464 15.536a5 5 0 010-7.072M15.536 8.464a5 5 0 010 7.072"
          />
        </svg>
        <span>
          Offline rejim - Internet aloqasi yo&apos;q. Ma&apos;lumotlar avtomatik
          sinxronlanadi.
        </span>
        <SyncStatusBadge />
      </div>
    );
  }

  return null;
}
