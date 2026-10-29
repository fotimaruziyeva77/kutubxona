// ============================================================================
// Conflict Resolver Tests — PWA-06
// ============================================================================

const { resolveConflict } = require("../conflict-resolver");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeEntry(overrides) {
  return {
    id: "test-entry-1",
    method: "PUT",
    url: "/api/users/me",
    body: JSON.stringify({
      name: "Updated Name",
      updatedAt: "2026-06-01T10:00:00Z",
    }),
    accessToken: "token-123",
    createdAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

function makeResponse(body) {
  return {
    json: () => Promise.resolve(body),
    status: 409,
    ok: false,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("resolveConflict", () => {
  test("transaction URLs (/api/transactions) always return 'discard' on conflict", async () => {
    const entry = makeEntry({
      url: "/api/transactions/borrow",
    });
    const response = makeResponse({
      updatedAt: "2026-06-01T08:00:00Z",
    });

    const result = await resolveConflict(entry, response);

    expect(result.action).toBe("discard");
    expect(result.updatedBody).toBeUndefined();
  });

  test("non-transaction URLs with newer server updatedAt return 'discard'", async () => {
    const entry = makeEntry({
      url: "/api/users/me",
      body: JSON.stringify({
        name: "Client Name",
        updatedAt: "2026-06-01T08:00:00Z",
      }),
    });
    const response = makeResponse({
      updatedAt: "2026-06-01T12:00:00Z",
    });

    const result = await resolveConflict(entry, response);

    expect(result.action).toBe("discard");
  });

  test("non-transaction URLs with older server updatedAt return 'retry' with merged body", async () => {
    const entry = makeEntry({
      url: "/api/users/me",
      body: JSON.stringify({
        name: "Client Name",
        updatedAt: "2026-06-01T12:00:00Z",
      }),
    });
    const response = makeResponse({
      updatedAt: "2026-06-01T08:00:00Z",
      version: 5,
    });

    const result = await resolveConflict(entry, response);

    expect(result.action).toBe("retry");
    expect(result.updatedBody).toBeDefined();

    const parsed = JSON.parse(result.updatedBody);
    expect(parsed.name).toBe("Client Name");
    expect(parsed.version).toBe(5);
  });
});
