import { UserRole } from "@prisma/client";
import { AlertDispatchService } from "../alert-dispatch.service";
import { ALERT_TYPES } from "../../../common/constants/alert-types.const";

/**
 * Plan 05-05 T2 — AlertDispatchService.
 *
 * Covers:
 *  - Routing matrix: per alertType, correct (channel × recipient role) fan-out.
 *  - Recipient-aware dedup via cache.setNx (24h TTL).
 *  - RI_RISING deferred to weekly digest (NOT dispatched immediately).
 *  - SYSTEM_DOWN recipient resolution falls through to ADMIN_NOTIFICATION_EMAILS.
 *  - Best-effort failure path: enqueue error → logged, dispatch continues.
 */

const makeCache = () => {
  const seen = new Set<string>();
  return {
    seen,
    setNx: jest.fn().mockImplementation(async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    del: jest.fn(),
    remember: jest.fn(),
  };
};

const makeReplica = () => ({
  user: { findMany: jest.fn().mockResolvedValue([]) },
  tuman: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  aiAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
  institution: { findUnique: jest.fn() },
});

const makePrisma = () => ({
  user: { findMany: jest.fn().mockResolvedValue([]) },
  tuman: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  aiAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
  institution: { findUnique: jest.fn() },
});

const makeQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: "queued-1" }),
});

const makeConfig = (envMap: Record<string, string> = {}) => ({
  get: jest.fn().mockImplementation((key: string) => envMap[key]),
});

describe("AlertDispatchService — Plan 05-05 T2", () => {
  let cache: ReturnType<typeof makeCache>;
  let replica: ReturnType<typeof makeReplica>;
  let prisma: ReturnType<typeof makePrisma>;
  let queue: ReturnType<typeof makeQueue>;
  let config: ReturnType<typeof makeConfig>;
  let service: AlertDispatchService;

  beforeEach(() => {
    cache = makeCache();
    replica = makeReplica();
    prisma = makePrisma();
    queue = makeQueue();
    config = makeConfig();
    service = new AlertDispatchService(
      prisma as any,
      cache as any,
      replica as any,
      config as any,
      queue as any,
    );
    jest.clearAllMocks();
    cache.setNx.mockImplementation(async (key: string) => {
      if (cache.seen.has(key)) return false;
      cache.seen.add(key);
      return true;
    });
  });

  // ── Routing matrix ───────────────────────────────────────────────────────

  describe("LIBRARY_INACTIVE routing (KRITIK matrix)", () => {
    it("dispatches sms+push+email × {TUMAN_ADMIN + VILOYAT_ADMIN}", async () => {
      replica.tuman.findUnique.mockResolvedValue({ viloyatId: "UZ-08" });
      replica.user.findMany.mockResolvedValueOnce([
        { id: "tuman-admin-1", phone: "+998901111111" },
      ]);
      replica.user.findMany.mockResolvedValueOnce([
        { id: "viloyat-admin-1", phone: "+998902222222" },
      ]);

      await service.dispatch({
        id: "log-1",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.LIBRARY_INACTIVE,
        severity: "CRITICAL" as any,
        analysis: "Inactive",
        recommendation: "Ko'rib chiqing",
        createdAt: new Date(),
      });

      // 2 recipients × 3 channels = up to 6 jobs (sms only goes if phone set;
      // push only if non-env id; email requires recipient.email which is null
      // for non-SUPER_ADMIN — only sms + push fire). So 2 × 2 = 4 expected.
      const calls = queue.add.mock.calls;
      const channels = calls.map((c) => c[1].type).sort();
      expect(channels).toEqual(["push", "push", "sms", "sms"]);
    });
  });

  describe("RI_DROPPED routing (OGOHLANTIRISH matrix)", () => {
    it("dispatches push+email to TUMAN_ADMIN", async () => {
      replica.tuman.findUnique.mockResolvedValue({ viloyatId: "UZ-08" });
      replica.user.findMany.mockResolvedValue([
        { id: "tuman-admin-1", phone: "+998901111111" },
      ]);

      await service.dispatch({
        id: "log-2",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.RI_DROPPED,
        severity: "MEDIUM" as any,
        analysis: "RI drop",
        recommendation: "Tekshiring",
        createdAt: new Date(),
      });

      // push fires (userId), email is dropped (recipient.email null).
      const types = queue.add.mock.calls.map((c) => c[1].type).sort();
      expect(types).toEqual(["push"]);
    });
  });

  describe("FUND_SHORTAGE routing", () => {
    it("dispatches push to KUTUBXONACHI of affected library", async () => {
      replica.user.findMany.mockResolvedValue([
        { id: "librarian-1", phone: "+998900000001" },
      ]);

      await service.dispatch({
        id: "log-3",
        scope: "KUTUBXONA",
        scopeId: "library-1",
        issueType: ALERT_TYPES.FUND_SHORTAGE,
        severity: "MEDIUM" as any,
        analysis: "Shortage",
        recommendation: "Buyurtma bering",
        createdAt: new Date(),
      });

      const types = queue.add.mock.calls.map((c) => c[1].type);
      expect(types).toEqual(["push"]);
      expect(queue.add.mock.calls[0][1].userId).toBe("librarian-1");
    });
  });

  describe("CLUB_INACTIVE routing", () => {
    it("dispatches push to KLUB_RAHBARI", async () => {
      replica.user.findMany.mockResolvedValue([
        { id: "klub-leader-1", phone: "+998900000003" },
      ]);

      await service.dispatch({
        id: "log-4",
        scope: "KLUB",
        scopeId: "club-1",
        issueType: ALERT_TYPES.CLUB_INACTIVE,
        severity: "MEDIUM" as any,
        analysis: "Klub faolsiz",
        recommendation: "Debat reja",
        createdAt: new Date(),
      });

      const types = queue.add.mock.calls.map((c) => c[1].type);
      expect(types).toEqual(["push"]);
    });
  });

  // ── RI_RISING deferred ───────────────────────────────────────────────────

  describe("RI_RISING (AXBOROT) — deferred to weekly digest", () => {
    it("does NOT dispatch immediately; returns silently", async () => {
      await service.dispatch({
        id: "log-rising",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.RI_RISING,
        severity: "LOW" as any,
        analysis: "RI rose",
        recommendation: "Davom etsin",
        createdAt: new Date(),
      });

      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  // ── SYSTEM_DOWN ──────────────────────────────────────────────────────────

  describe("SYSTEM_DOWN routing with ADMIN_NOTIFICATION_EMAILS fallback (Q7)", () => {
    it("includes env-CSV emails when SUPER_ADMIN has null email", async () => {
      config.get.mockImplementation((key: string) =>
        key === "ADMIN_NOTIFICATION_EMAILS"
          ? "ops1@example.com,ops2@example.com"
          : undefined,
      );
      replica.user.findMany.mockResolvedValue([
        { id: "super-1", phone: "+998900000099" }, // no email column on User
      ]);

      await service.dispatch({
        id: "log-down",
        scope: "NATIONAL" as any,
        scopeId: "UZ",
        issueType: ALERT_TYPES.SYSTEM_DOWN,
        severity: "CRITICAL" as any,
        analysis: "down",
        recommendation: "fix",
        createdAt: new Date(),
      });

      // SUPER_ADMIN (user-1) — sms via phone + 0 email (no email column);
      // env-CSV (ops1, ops2) — each gets email channel.
      const types = queue.add.mock.calls.map((c) => c[1].type).sort();
      expect(types).toEqual(["email", "email", "sms"]);

      const emails = queue.add.mock.calls
        .filter((c) => c[1].type === "email")
        .map((c) => c[1].email)
        .sort();
      expect(emails).toEqual(["ops1@example.com", "ops2@example.com"]);
    });
  });

  // ── Dedup ────────────────────────────────────────────────────────────────

  describe("Recipient-aware dedup (cache.setNx)", () => {
    it("skips 2nd dispatch for same (alertType, scopeId, recipient, channel, day)", async () => {
      replica.tuman.findUnique.mockResolvedValue({ viloyatId: "UZ-08" });
      replica.user.findMany.mockResolvedValue([
        { id: "tuman-admin-1", phone: "+998901111111" },
      ]);

      const alert = {
        id: "log-x",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.RI_DROPPED,
        severity: "MEDIUM" as any,
        analysis: "drop",
        recommendation: "fix",
        createdAt: new Date(),
      };

      await service.dispatch(alert);
      const firstCallCount = queue.add.mock.calls.length;

      // Second dispatch: same alert + same day → all setNx return false → no jobs.
      await service.dispatch(alert);
      const secondCallCount = queue.add.mock.calls.length;

      expect(firstCallCount).toBeGreaterThan(0);
      expect(secondCallCount).toBe(firstCallCount);
    });

    it("different recipient gets independent dedup", async () => {
      replica.tuman.findUnique.mockResolvedValue({ viloyatId: "UZ-08" });

      // First call: tuman_admin_1 ← only one TUMAN_ADMIN
      replica.user.findMany.mockResolvedValueOnce([
        { id: "tuman-admin-1", phone: "+998901111111" },
      ]);
      await service.dispatch({
        id: "log-y1",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.RI_DROPPED,
        severity: "MEDIUM" as any,
        analysis: "drop",
        recommendation: "fix",
        createdAt: new Date(),
      });

      const before = queue.add.mock.calls.length;

      // Different recipient (tuman_admin_2) for same scopeId — should NOT dedup.
      replica.user.findMany.mockResolvedValueOnce([
        { id: "tuman-admin-2", phone: "+998902222222" },
      ]);
      await service.dispatch({
        id: "log-y2",
        scope: "TUMAN",
        scopeId: "UZ-08-012",
        issueType: ALERT_TYPES.RI_DROPPED,
        severity: "MEDIUM" as any,
        analysis: "drop",
        recommendation: "fix",
        createdAt: new Date(),
      });

      // Second dispatch's recipient is fresh — dedup key changes → enqueues.
      expect(queue.add.mock.calls.length).toBeGreaterThan(before);
    });
  });

  // ── Failure path ─────────────────────────────────────────────────────────

  describe("Best-effort failure (T-05-DISP-FAIL)", () => {
    it("logs and continues when queue.add throws", async () => {
      replica.tuman.findUnique.mockResolvedValue({ viloyatId: "UZ-08" });
      replica.user.findMany.mockResolvedValue([
        { id: "tuman-admin-1", phone: "+998901111111" },
      ]);
      // 1st enqueue fails, 2nd succeeds.
      queue.add
        .mockRejectedValueOnce(new Error("queue down"))
        .mockResolvedValueOnce({ id: "ok" });

      await expect(
        service.dispatch({
          id: "log-fail",
          scope: "TUMAN",
          scopeId: "UZ-08-012",
          issueType: ALERT_TYPES.RI_DROPPED,
          severity: "MEDIUM" as any,
          analysis: "drop",
          recommendation: "fix",
          createdAt: new Date(),
        }),
      ).resolves.toBeUndefined();

      // Dispatch did NOT throw despite one enqueue failing.
      expect(queue.add).toHaveBeenCalled();
    });
  });

  // ── Plan 06-05-fix FIX C — BOOK_CORNER_REMINDER INSTITUTION narrowing ────

  describe("BOOK_CORNER_REMINDER routing (INSTITUTION scope narrowing)", () => {
    it("narrows MUASSASA_ADMIN fan-out to admins of the SAME institution (ORG)", async () => {
      replica.institution.findUnique.mockResolvedValue({ type: "ORG" });
      // Capture the where clause we call findMany with.
      replica.user.findMany.mockImplementation(async ({ where }: any) => {
        if (where.organizationId === "ORG-X") {
          return [{ id: "muassasa-admin-x", phone: "+998901111111" }];
        }
        return [];
      });

      await service.dispatch({
        id: "log-bc",
        scope: "INSTITUTION" as any,
        scopeId: "ORG-X",
        issueType: "BOOK_CORNER_REMINDER" as any,
        severity: "MEDIUM" as any,
        analysis: "kitob burchagi 95 kun",
        recommendation: "Yangi foto yuklash",
        createdAt: new Date(),
      });

      // findMany should have been called with organizationId filter
      const calls = replica.user.findMany.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const lastWhere = calls[calls.length - 1][0].where;
      expect(lastWhere.organizationId).toBe("ORG-X");
      expect(lastWhere.role).toBe(UserRole.MUASSASA_ADMIN);

      // One recipient → push channel only (no email column).
      const userIds = queue.add.mock.calls.map((c) => c[1].userId).filter(Boolean);
      expect(userIds).toEqual(["muassasa-admin-x"]);
    });

    it("uses schoolId filter for SCH institution type", async () => {
      replica.institution.findUnique.mockResolvedValue({ type: "SCH" });
      replica.user.findMany.mockResolvedValue([
        { id: "school-admin-1", phone: "+998901111112" },
      ]);

      await service.dispatch({
        id: "log-bc2",
        scope: "INSTITUTION" as any,
        scopeId: "SCH-1",
        issueType: "BOOK_CORNER_REMINDER" as any,
        severity: "MEDIUM" as any,
        analysis: "kitob burchagi",
        recommendation: "Yangi foto yuklash",
        createdAt: new Date(),
      });

      const calls = replica.user.findMany.mock.calls;
      expect(calls[calls.length - 1][0].where.schoolId).toBe("SCH-1");
    });

    it("skips dispatch when institution is not resolvable (no unscoped fan-out)", async () => {
      replica.institution.findUnique.mockResolvedValue(null);
      replica.user.findMany.mockResolvedValue([
        { id: "would-fan-out", phone: "+998901111199" },
      ]);

      await service.dispatch({
        id: "log-bc3",
        scope: "INSTITUTION" as any,
        scopeId: "missing-inst",
        issueType: "BOOK_CORNER_REMINDER" as any,
        severity: "MEDIUM" as any,
        analysis: "x",
        recommendation: "y",
        createdAt: new Date(),
      });

      // No queue.add — narrowing failed safe-closed.
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  // ── Unknown alertType ────────────────────────────────────────────────────

  describe("Unknown issueType", () => {
    it("returns silently when alertType is not in matrix", async () => {
      await service.dispatch({
        id: "log-unk",
        scope: "TUMAN" as any,
        scopeId: "x",
        issueType: "UNKNOWN_TYPE" as any,
        severity: "LOW" as any,
        analysis: "",
        recommendation: "",
        createdAt: new Date(),
      });

      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  // ── Weekly digest ────────────────────────────────────────────────────────

  describe("dispatchRiRisingWeeklyDigest (Q3 — Monday 09:30)", () => {
    it("returns early when no RI_RISING events in last 7 days", async () => {
      replica.aiAuditLog.findMany.mockResolvedValue([]);
      await service.dispatchRiRisingWeeklyDigest();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("enqueues ONE email per VILOYAT_ADMIN summarizing all rising tumans", async () => {
      const now = new Date();
      replica.aiAuditLog.findMany.mockResolvedValue([
        {
          id: "ri-1",
          scopeId: "tuman-A",
          issueType: ALERT_TYPES.RI_RISING,
          analysis: "Tuman A o'sdi 18%",
          createdAt: now,
        },
        {
          id: "ri-2",
          scopeId: "tuman-B",
          issueType: ALERT_TYPES.RI_RISING,
          analysis: "Tuman B o'sdi 22%",
          createdAt: now,
        },
      ]);
      replica.tuman.findMany.mockResolvedValue([
        { id: "tuman-A", viloyatId: "UZ-08", name: "A" },
        { id: "tuman-B", viloyatId: "UZ-08", name: "B" },
      ]);
      replica.user.findMany.mockResolvedValue([
        { id: "viloyat-admin-1", phone: "+998901111111" },
      ]);

      await service.dispatchRiRisingWeeklyDigest();

      expect(queue.add).toHaveBeenCalledTimes(1);
      const payload = queue.add.mock.calls[0][1];
      expect(payload.type).toBe("email");
      expect(payload.admin).toBe(true);
      expect(payload.message).toContain("Tuman A");
      expect(payload.message).toContain("Tuman B");
    });
  });
});
