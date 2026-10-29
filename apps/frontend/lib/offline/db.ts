// ============================================================================
// Dexie Offline Database Schema — PWA-02
// ============================================================================
// Typed IndexedDB wrapper for offline transaction queue, cached books, and
// cached libraries. Replaces the raw IndexedDB open/store pattern from the
// hand-written sw.js.
// ============================================================================

import Dexie, { type Table } from "dexie";

// ── Table interfaces ────────────────────────────────────────────────────────

export interface SyncQueueEntry {
  /** UUID v4 — client-generated for offline idempotency */
  id: string;
  method: "POST" | "PUT" | "PATCH";
  url: string;
  /** JSON-stringified request body */
  body: string;
  // M20: accessToken field removed — replay always re-mints a fresh token
  // via the HttpOnly refresh cookie (sync.ts), so persisting a bearer token
  // in IndexedDB was pure liability. Not an indexed column, so no Dexie
  // schema version bump is needed; stale entries simply carry an ignored
  // extra property.
  /** Date.now() timestamp */
  createdAt: number;
  retryCount: number;
  lastError?: string;
}

export interface CachedBook {
  id: string;
  title: string;
  author: string;
  isbn: string;
  libraryId: string;
  availableCount: number;
  /** Date.now() timestamp of when cached */
  cachedAt: number;
}

export interface CachedLibrary {
  id: string;
  name: string;
  type: string;
  regionId: string;
  /** Date.now() timestamp of when cached */
  cachedAt: number;
}

// ── Database class ──────────────────────────────────────────────────────────

export class SifatOfflineDB extends Dexie {
  syncQueue!: Table<SyncQueueEntry>;
  cachedBooks!: Table<CachedBook>;
  cachedLibraries!: Table<CachedLibrary>;

  constructor() {
    super("sifat-offline");
    this.version(1).stores({
      syncQueue: "id, createdAt",
      cachedBooks: "id, libraryId",
      cachedLibraries: "id",
    });
  }
}

/** Singleton instance shared across the app */
export const offlineDb = new SifatOfflineDB();
