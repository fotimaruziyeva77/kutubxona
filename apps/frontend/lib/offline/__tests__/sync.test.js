// ============================================================================
// Offline Sync Engine Tests — PWA-05
// ============================================================================

// ── Mock Dexie syncQueue (must be before imports) ─────────────────────────

const entries = [];

jest.mock("../db", () => ({
  offlineDb: {
    syncQueue: {
      orderBy: jest.fn().mockReturnValue({
        toArray: jest.fn(() => Promise.resolve([...entries])),
      }),
      delete: jest.fn((id) => {
        const idx = entries.findIndex((e) => e.id === id);
        if (idx >= 0) entries.splice(idx, 1);
        return Promise.resolve();
      }),
      update: jest.fn((id, data) => {
        const entry = entries.find((e) => e.id === id);
        if (entry) Object.assign(entry, data);
        return Promise.resolve();
      }),
      add: jest.fn((entry) => {
        entries.push(entry);
        return Promise.resolve();
      }),
      count: jest.fn(() => Promise.resolve(entries.length)),
      clear: jest.fn(() => {
        entries.length = 0;
        return Promise.resolve();
      }),
    },
  },
}));

jest.mock("uuid", () => ({
  v4: jest.fn(() => "test-uuid-1234"),
}));

jest.mock("../conflict-resolver");

// ── Imports (after mocks) ─────────────────────────────────────────────────

const { syncPendingTransactions, queueOfflineTransaction } = require("../sync");
const { offlineDb } = require("../db");
const conflictResolver = require("../conflict-resolver");

// ── Mock global fetch ─────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Test setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  entries.length = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("syncPendingTransactions", () => {
  // M20: entries no longer carry an accessToken — replay always uses the
  // freshly-minted token from /api/auth/refresh.
  const mockEntry = {
    id: "entry-1",
    method: "POST",
    url: "/api/books",
    body: JSON.stringify({ title: "Test" }),
    createdAt: Date.now(),
    retryCount: 0,
  };

  test("calls /api/auth/refresh before replaying queued entries", async () => {
    entries.push({ ...mockEntry });

    mockFetch.mockImplementation((url) => {
      if (url === "/api/auth/refresh") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: "fresh-token" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    await syncPendingTransactions();

    expect(mockFetch).toHaveBeenCalledWith("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/books",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      }),
    );
  });

  test("on 200 response, entry is deleted from syncQueue and synced count increments", async () => {
    entries.push({ ...mockEntry });

    mockFetch.mockImplementation((url) => {
      if (url === "/api/auth/refresh") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: "fresh-token" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });

    const result = await syncPendingTransactions();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(offlineDb.syncQueue.delete).toHaveBeenCalledWith("entry-1");
  });

  test("on 409 response, resolveConflict is called", async () => {
    entries.push({ ...mockEntry });

    const mock409Response = {
      ok: false,
      status: 409,
      json: () => Promise.resolve({ updatedAt: new Date().toISOString() }),
    };

    mockFetch.mockImplementation((url) => {
      if (url === "/api/auth/refresh") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: "fresh-token" }),
        });
      }
      return Promise.resolve(mock409Response);
    });

    conflictResolver.resolveConflict.mockResolvedValue({
      action: "discard",
    });

    await syncPendingTransactions();

    expect(conflictResolver.resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({ id: "entry-1" }),
      mock409Response,
    );
  });

  test("on 401 response (expired refresh token), sync stops and remaining entries stay in queue", async () => {
    const entry2 = { ...mockEntry, id: "entry-2" };
    entries.push({ ...mockEntry }, entry2);

    mockFetch.mockImplementation((url) => {
      if (url === "/api/auth/refresh") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ accessToken: "fresh-token" }),
        });
      }
      return Promise.resolve({ ok: false, status: 401 });
    });

    const result = await syncPendingTransactions();

    expect(result.synced).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(offlineDb.syncQueue.delete).not.toHaveBeenCalled();
  });

  test("queueOfflineTransaction creates entry in syncQueue with uuid id", async () => {
    await queueOfflineTransaction(
      "POST",
      "/api/books",
      JSON.stringify({ title: "New Book" }),
    );

    expect(offlineDb.syncQueue.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "test-uuid-1234",
        method: "POST",
        url: "/api/books",
        body: JSON.stringify({ title: "New Book" }),
        retryCount: 0,
      }),
    );
    // M20: bearer tokens must never be persisted with queued entries —
    // replay re-mints a fresh token via the HttpOnly refresh cookie.
    const queued = offlineDb.syncQueue.add.mock.calls[0][0];
    expect(queued).not.toHaveProperty("accessToken");
  });
});
