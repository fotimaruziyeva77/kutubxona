"use client";

// ============================================================================
// Sync Status Badge — PWA-03
// ============================================================================
// Small badge showing the count of pending offline transactions from the
// Dexie syncQueue. Polls every 5s when offline, every 30s when online.
// Shows "Barchasi sinxronlandi" briefly when count transitions to 0.
// ============================================================================

import { useEffect, useState, useRef } from "react";
import { useNetworkStatus } from "@/lib/offline/network-status";
import { getPendingSyncCount } from "@/lib/offline/sync";

export function SyncStatusBadge() {
  const { isOnline } = useNetworkStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [showSynced, setShowSynced] = useState(false);
  const previousCount = useRef(0);

  useEffect(() => {

    async function poll() {
      try {
        const count = await getPendingSyncCount();

        // Detect transition from >0 to 0
        if (previousCount.current > 0 && count === 0) {
          setShowSynced(true);
          setTimeout(() => setShowSynced(false), 3000);
        }

        previousCount.current = count;
        setPendingCount(count);
      } catch {
        // Dexie not available (e.g., SSR) — ignore
      }
    }

    // Initial poll
    poll();

    // Poll interval: 5s when offline, 30s when online
    const interval = isOnline ? 30_000 : 5_000;
    const intervalId = setInterval(poll, interval);

    return () => clearInterval(intervalId);
  }, [isOnline]);

  if (showSynced) {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
        Barchasi sinxronlandi
      </span>
    );
  }

  if (pendingCount > 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        {pendingCount} ta kutmoqda
      </span>
    );
  }

  return null;
}
