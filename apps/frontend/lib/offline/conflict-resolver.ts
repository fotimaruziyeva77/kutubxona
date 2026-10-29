// ============================================================================
// Conflict Resolution — PWA-06
// ============================================================================
// Last-write-wins conflict resolution for 409 responses during offline sync
// replay. Transaction URLs (/api/transactions, /api/bookings) always discard
// on conflict because server state wins for book inventory.
// ============================================================================

import type { SyncQueueEntry } from "./db";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConflictAction = "retry" | "discard";

export interface ConflictResolution {
  action: ConflictAction;
  updatedBody?: string;
}

// ── Transaction URL patterns that always discard ───────────────────────────

const TRANSACTION_URL_PATTERNS = [
  "/api/transactions",
  "/api/bookings",
];

function isTransactionUrl(url: string): boolean {
  return TRANSACTION_URL_PATTERNS.some((pattern) => url.includes(pattern));
}

// ── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolves a 409 Conflict response during offline sync replay.
 *
 * Strategy:
 * - Transaction URLs (/api/transactions, /api/bookings) always discard
 *   the client change. Server state wins for book inventory consistency.
 * - For other URLs, compare updatedAt timestamps. If the server has a
 *   newer updatedAt, discard the client change. If the client's data is
 *   newer or equal, merge the server's version field into the body and retry.
 */
export async function resolveConflict(
  entry: SyncQueueEntry,
  response: Response,
): Promise<ConflictResolution> {
  // Transaction URLs always discard — server inventory state is authoritative
  if (isTransactionUrl(entry.url)) {
    return { action: "discard" };
  }

  // Parse server response for version/timestamp info
  let serverData: Record<string, unknown>;
  try {
    serverData = await response.json();
  } catch {
    // Cannot parse server response — discard to be safe
    return { action: "discard" };
  }

  // Parse client body
  let clientData: Record<string, unknown>;
  try {
    clientData = JSON.parse(entry.body);
  } catch {
    return { action: "discard" };
  }

  // Extract timestamps for comparison
  const serverUpdatedAt = serverData.updatedAt
    ? new Date(serverData.updatedAt as string).getTime()
    : null;
  const clientUpdatedAt = clientData.updatedAt
    ? new Date(clientData.updatedAt as string).getTime()
    : null;

  // If server has a newer updatedAt, discard the client change
  if (
    serverUpdatedAt !== null &&
    clientUpdatedAt !== null &&
    serverUpdatedAt > clientUpdatedAt
  ) {
    return { action: "discard" };
  }

  // Client is newer or equal — merge server version into body and retry
  const mergedBody: Record<string, unknown> = {
    ...clientData,
  };

  // Merge server's version field if present
  if (serverData.version !== undefined) {
    mergedBody.version = serverData.version;
  }
  if (serverData.serverVersion !== undefined) {
    mergedBody.version = serverData.serverVersion;
  }

  return {
    action: "retry",
    updatedBody: JSON.stringify(mergedBody),
  };
}
