// ============================================================================
// Offline Sync Replay — PWA-05 / PWA-06
// ============================================================================
// Background Sync replay logic with auth token refresh. Reads pending
// transactions from the Dexie syncQueue, refreshes the JWT access token
// via the HttpOnly refresh cookie, then replays each entry in order.
//
// Conflict resolution delegates to conflict-resolver.ts for 409 responses.
// ============================================================================

import { v4 as uuidv4 } from "uuid";
import { offlineDb, type SyncQueueEntry } from "./db";
import { resolveConflict } from "./conflict-resolver";

// ── Exported function: syncPendingTransactions ──────────────────────────────

export interface SyncResult {
  synced: number;
  failed: number;
}

/**
 * Replays all pending offline transactions from the Dexie syncQueue.
 *
 * 1. Reads all entries ordered by createdAt ascending.
 * 2. Calls /api/auth/refresh to get a fresh access token (PWA-05).
 * 3. For each entry, sends the request with the fresh token.
 * 4. Handles 409 conflicts via resolveConflict (PWA-06).
 * 5. On 401, stops (refresh token expired — user must re-login).
 */
export async function syncPendingTransactions(): Promise<SyncResult> {
  const entries = await offlineDb.syncQueue
    .orderBy("createdAt")
    .toArray();

  if (entries.length === 0) {
    return { synced: 0, failed: 0 };
  }

  // Refresh JWT access token before replaying (PWA-05)
  let freshAccessToken: string;
  try {
    const refreshResponse = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (!refreshResponse.ok) {
      // Refresh token itself expired — cannot replay
      return { synced: 0, failed: entries.length };
    }
    const refreshData = await refreshResponse.json();
    freshAccessToken = refreshData.accessToken;
  } catch {
    // Network error during refresh — keep entries in queue
    return { synced: 0, failed: entries.length };
  }

  let synced = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const response = await fetch(entry.url, {
        method: entry.method,
        body: entry.body,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${freshAccessToken}`,
        },
      });

      if (response.status >= 200 && response.status < 300) {
        // Success — remove from queue
        await offlineDb.syncQueue.delete(entry.id);
        synced++;
      } else if (response.status === 409) {
        // Conflict — delegate to conflict resolver (PWA-06)
        const resolution = await resolveConflict(entry, response);
        if (resolution.action === "discard") {
          await offlineDb.syncQueue.delete(entry.id);
          synced++; // Discard counts as resolved
        } else if (resolution.action === "retry" && resolution.updatedBody) {
          // Update the entry body with merged data and retry once
          const retryResponse = await fetch(entry.url, {
            method: entry.method,
            body: resolution.updatedBody,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${freshAccessToken}`,
            },
          });
          if (retryResponse.ok) {
            await offlineDb.syncQueue.delete(entry.id);
            synced++;
          } else {
            await offlineDb.syncQueue.update(entry.id, {
              retryCount: entry.retryCount + 1,
              lastError: `Retry failed: ${retryResponse.status}`,
            });
            failed++;
          }
        }
      } else if (response.status === 401) {
        // Refresh token expired — stop syncing, keep remaining entries
        failed += entries.length - synced - failed;
        break;
      } else {
        // Other error — increment retry count, keep in queue
        await offlineDb.syncQueue.update(entry.id, {
          retryCount: entry.retryCount + 1,
          lastError: `HTTP ${response.status}`,
        });
        failed++;
      }
    } catch {
      // Network error — increment retry count
      await offlineDb.syncQueue.update(entry.id, {
        retryCount: entry.retryCount + 1,
        lastError: "Network error",
      });
      failed++;
    }
  }

  return { synced, failed };
}

// ── Exported function: queueOfflineTransaction ──────────────────────────────

/**
 * Queues a transaction for offline replay. Creates a SyncQueueEntry with a
 * UUID v4 id and registers Background Sync via the service worker.
 *
 * M20: no accessToken parameter — replay (syncPendingTransactions) always
 * re-mints a fresh token from the HttpOnly refresh cookie, so storing a
 * bearer token per entry was unused risk.
 */
export async function queueOfflineTransaction(
  method: "POST" | "PUT" | "PATCH",
  url: string,
  body: string,
): Promise<void> {
  const entry: SyncQueueEntry = {
    id: uuidv4(),
    method,
    url,
    body,
    createdAt: Date.now(),
    retryCount: 0,
  };

  await offlineDb.syncQueue.add(entry);

  // Request Background Sync registration
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swReg = reg as any;
      if (swReg.sync) {
        await swReg.sync.register("sync-transactions");
      }
    } catch {
      // Background Sync not supported — will sync on next online event
    }
  }
}

// ── Exported function: getPendingSyncCount ──────────────────────────────────

/**
 * Returns the number of pending transactions in the syncQueue.
 */
export async function getPendingSyncCount(): Promise<number> {
  return offlineDb.syncQueue.count();
}

// ── Exported function: clearSyncQueue ──────────────────────────────────────

/**
 * Clears all entries from the syncQueue. Used on logout to prevent
 * replaying transactions from a different user session.
 */
export async function clearSyncQueue(): Promise<void> {
  await offlineDb.syncQueue.clear();
}

// ── Legacy alias for sw.ts compatibility ────────────────────────────────────

/**
 * Alias used by the service worker's Background Sync handler (sw.ts).
 */
export async function replayOfflineQueue(): Promise<void> {
  await syncPendingTransactions();
}
