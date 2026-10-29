import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { AdminService } from "../admin.service";
import { AdminController } from "../admin.controller";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

const makeReplica = () => ({
  user: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
  library: {
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
    findMany: jest.fn().mockResolvedValue([]),
  },
  book: { aggregate: jest.fn().mockResolvedValue({ _sum: { totalCount: 0, availableCount: 0 } }) },
  bookTransaction: { count: jest.fn().mockResolvedValue(0) },
  readingIndex: { aggregate: jest.fn().mockResolvedValue({ _avg: { score: 65.5 } }) },
  aiAuditLog: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
  // RBAC alert scoping (Audit 2026-06) — region-resolution lookups.
  tuman: { findMany: jest.fn().mockResolvedValue([]) },
  institution: { findMany: jest.fn().mockResolvedValue([]) },
  club: { findMany: jest.fn().mockResolvedValue([]) },
  mahalla: {
    findUnique: jest.fn().mockResolvedValue({
      id: "m1",
      tumanId: "UZ-08-012",
      tuman: { viloyatId: "UZ-08" },
    }),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
});

const mockPrisma = {} as PrismaService;
const mockSms = { sendNotification: jest.fn() } as unknown as SmsService;
const mockCache = {
  remember: jest.fn().mockImplementation(
    (_k: string, _t: number, fn: () => unknown) => fn(),
  ),
  del: jest.fn(),
  delPattern: jest.fn(),
  setNx: jest.fn().mockResolvedValue(true),
} as unknown as CacheService;

describe("AdminService scope guards (Plan 05-02 T1, OQ-6 Q6)", () => {
  let replica: ReturnType<typeof makeReplica>;
  let service: AdminService;

  beforeEach(() => {
    replica = makeReplica();
    service = new AdminService(
      mockPrisma,
      mockSms,
      mockCache,
      replica as unknown as PrismaReplicaService,
    );
    jest.clearAllMocks();
    (mockCache.remember as jest.Mock).mockImplementation(
      (_k: string, _t: number, fn: () => unknown) => fn(),
    );
  });

  // ── getViloyatStats ─────────────────────────────────────────────────────
  describe("getViloyatStats scope assertion", () => {
    it("VILOYAT_ADMIN with matching viloyatId is allowed", async () => {
      const result = await service.getViloyatStats("UZ-08", {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      expect(result.viloyatId).toBe("UZ-08");
      // replica was hit (proves scope assert ran BEFORE cache.remember and let fetch through)
      expect(replica.library.count).toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN with mismatched viloyatId throws ForbiddenException", async () => {
      await expect(
        service.getViloyatStats("UZ-08", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-12", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
      // T-05-02: cache MUST NOT be populated on forbidden access
      expect(replica.library.count).not.toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN with null viloyatId throws (fail-CLOSED)", async () => {
      await expect(
        service.getViloyatStats("UZ-08", {
          role: UserRole.VILOYAT_ADMIN,
          address: null,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("KITOBXON role throws (regression guard)", async () => {
      await expect(
        service.getViloyatStats("UZ-08", {
          role: UserRole.KITOBXON,
          address: { viloyatId: "UZ-08", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("SUPER_ADMIN bypasses scope assert (regression guard)", async () => {
      const result = await service.getViloyatStats("UZ-12", {
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      expect(result.viloyatId).toBe("UZ-12");
    });

    it("getViloyatStats(viloyatId) without user arg skips assert (cron-safe)", async () => {
      const result = await service.getViloyatStats("UZ-08");
      expect(result.viloyatId).toBe("UZ-08");
      expect(replica.library.count).toHaveBeenCalled();
    });
  });

  // ── getTumanStats ───────────────────────────────────────────────────────
  describe("getTumanStats scope assertion", () => {
    it("TUMAN_ADMIN with matching tumanId is allowed", async () => {
      const result = await service.getTumanStats(
        "UZ-08-012",
        { role: UserRole.TUMAN_ADMIN, address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" } },
        "UZ-08",
      );
      expect(result.tumanId).toBe("UZ-08-012");
    });

    it("TUMAN_ADMIN with mismatched tumanId throws", async () => {
      await expect(
        service.getTumanStats(
          "UZ-08-012",
          { role: UserRole.TUMAN_ADMIN, address: { viloyatId: "UZ-08", tumanId: "UZ-08-015" } },
          "UZ-08",
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.library.count).not.toHaveBeenCalled();
    });

    it("TUMAN_ADMIN with null tumanId throws (fail-CLOSED)", async () => {
      await expect(
        service.getTumanStats(
          "UZ-08-012",
          { role: UserRole.TUMAN_ADMIN, address: null },
          "UZ-08",
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN with matching viloyatId (resolvedViloyatId) is allowed", async () => {
      const result = await service.getTumanStats(
        "UZ-08-012",
        { role: UserRole.VILOYAT_ADMIN, address: { viloyatId: "UZ-08", tumanId: null } },
        "UZ-08",
      );
      expect(result.tumanId).toBe("UZ-08-012");
    });

    it("VILOYAT_ADMIN with mismatched resolvedViloyatId throws", async () => {
      await expect(
        service.getTumanStats(
          "UZ-08-012",
          { role: UserRole.VILOYAT_ADMIN, address: { viloyatId: "UZ-08", tumanId: null } },
          "UZ-12",
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("SUPER_ADMIN bypasses (regression guard)", async () => {
      const result = await service.getTumanStats(
        "UZ-08-012",
        { role: UserRole.SUPER_ADMIN, address: null },
        null,
      );
      expect(result.tumanId).toBe("UZ-08-012");
    });
  });

  // ── getMahallaStats ─────────────────────────────────────────────────────
  describe("getMahallaStats scope assertion", () => {
    it("TUMAN_ADMIN whose tuman owns the mahalla is allowed", async () => {
      const result = await service.getMahallaStats("m1", {
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      expect(result.mahallaId).toBe("m1");
    });

    it("TUMAN_ADMIN whose tuman does NOT own the mahalla throws", async () => {
      await expect(
        service.getMahallaStats("m1", {
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: "UZ-08-099" },
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("VILOYAT_ADMIN whose viloyat owns the mahalla's tuman is allowed", async () => {
      const result = await service.getMahallaStats("m1", {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      expect(result.mahallaId).toBe("m1");
    });

    it("VILOYAT_ADMIN from different viloyat throws", async () => {
      await expect(
        service.getMahallaStats("m1", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-12", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("Non-existent mahalla returns Forbidden (don't leak existence)", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getMahallaStats("ghost", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── _fetchAllViloyatStats per-viloyat RI fix ─────────────────────────────
  describe("_fetchAllViloyatStats returns per-viloyat RI", () => {
    it("returns distinct readingIndex per viloyat (NOT a global avg)", async () => {
      replica.library.groupBy.mockResolvedValueOnce([
        { viloyatId: "UZ-08", _count: 12 },
        { viloyatId: "UZ-12", _count: 7 },
        { viloyatId: "UZ-14", _count: 19 },
      ]);
      replica.$queryRaw.mockResolvedValueOnce([
        { viloyatId: "UZ-08", user_count: 1500, avg_ri: 72.4 },
        { viloyatId: "UZ-12", user_count: 800, avg_ri: 58.1 },
        { viloyatId: "UZ-14", user_count: 2100, avg_ri: 81.3 },
      ]);
      const out = await service.getAllViloyatStats();
      expect(out).toEqual({
        libraries: { "UZ-08": 12, "UZ-12": 7, "UZ-14": 19 },
        viloyats: {
          "UZ-08": { readingIndex: 72.4, userCount: 1500 },
          "UZ-12": { readingIndex: 58.1, userCount: 800 },
          "UZ-14": { readingIndex: 81.3, userCount: 2100 },
        },
      });
      // Distinct values prove this is per-viloyat, not a single global average
      const ris = Object.values(out.viloyats).map((v) => v.readingIndex);
      expect(new Set(ris).size).toBe(3);
      // raw SQL groupBy was used (the fix), NOT readingIndex.groupBy on userId
      expect(replica.$queryRaw).toHaveBeenCalled();
    });
  });

  // ── Controller @Roles metadata (Plan 05-02-fix FIX A) ────────────────────
  // Verifies that national / all-viloyat / monthly-report endpoints are
  // locked to SUPER_ADMIN + BUXGALTER, NOT tier admins. RolesGuard reads
  // ROLES_KEY metadata from the handler; checking the reflector output is
  // the same source-of-truth the runtime guard uses, so this catches any
  // future decorator drift.
  describe("Controller @Roles metadata for national/all/monthly", () => {
    const reflector = new Reflector();
    const proto = AdminController.prototype;

    it("GET /admin/stats/national is locked to SUPER_ADMIN + BUXGALTER only", () => {
      const roles = reflector.get<UserRole[]>(ROLES_KEY, proto.getNationalStats);
      expect(roles).toEqual([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]);
      expect(roles).not.toContain(UserRole.VILOYAT_ADMIN);
      expect(roles).not.toContain(UserRole.TUMAN_ADMIN);
    });

    it("GET /admin/stats/viloyat/all is locked to SUPER_ADMIN + BUXGALTER only", () => {
      const roles = reflector.get<UserRole[]>(ROLES_KEY, proto.getAllViloyatStats);
      expect(roles).toEqual([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]);
      expect(roles).not.toContain(UserRole.VILOYAT_ADMIN);
      expect(roles).not.toContain(UserRole.TUMAN_ADMIN);
    });

    // Plan 05-08 RPT-01: monthly report is NOW scope-parameterized
    // (?scope=national|viloyat|tuman). Tier admins MAY hit the endpoint,
    // but the service-layer assertViloyatInScope / assertTumanInScope
    // enforces ownership. This metadata check verifies the broadened roles
    // list; the actual scope assert is exercised by the integration tests.
    it("GET /admin/reports/monthly accepts SUPER_ADMIN + BUXGALTER + VILOYAT_ADMIN + TUMAN_ADMIN", () => {
      const roles = reflector.get<UserRole[]>(ROLES_KEY, proto.downloadMonthlyReport);
      expect(roles).toEqual(
        expect.arrayContaining([
          UserRole.SUPER_ADMIN,
          UserRole.BUXGALTER,
          UserRole.VILOYAT_ADMIN,
          UserRole.TUMAN_ADMIN,
        ]),
      );
    });
  });

  // ── replica routing (verifies the lint:replica gate has spec coverage too) ─
  describe("replica routing", () => {
    it("getViloyatStats calls replica.library.count (NOT primary)", async () => {
      await service.getViloyatStats("UZ-08");
      expect(replica.library.count).toHaveBeenCalled();
    });

    it("getTumanStats calls replica.bookTransaction.count", async () => {
      await service.getTumanStats("UZ-08-012");
      expect(replica.bookTransaction.count).toHaveBeenCalled();
    });

    it("getNationalStats calls replica.readingIndex.aggregate", async () => {
      // dashboard/getNationalStats fetch path
      await service.getNationalStats();
      expect(replica.readingIndex.aggregate).toHaveBeenCalled();
    });
  });

  // ── getSmartAlerts RBAC geographic scoping (Audit 2026-06) ────────────────
  //
  // BEFORE: every admin saw EVERY unresolved AiAuditLog row (cross-region
  // leak). Now SUPER_ADMIN/BUXGALTER see all; tier admins see only alerts
  // whose scope-typed scopeId resolves to their region.
  describe("getSmartAlerts geographic scoping", () => {
    const ALERTS = [
      // TUMAN scope — scopeId IS the tumanId.
      { id: "a1", scope: "TUMAN", scopeId: "UZ-08-012", severity: "HIGH", resolved: false },
      { id: "a2", scope: "TUMAN", scopeId: "UZ-08-099", severity: "HIGH", resolved: false },
      { id: "a3", scope: "TUMAN", scopeId: "UZ-12-001", severity: "HIGH", resolved: false },
      // LIBRARY scope — resolve via Library.tumanId/viloyatId.
      { id: "a4", scope: "LIBRARY", scopeId: "lib-A", severity: "MEDIUM", resolved: false },
      { id: "a5", scope: "KUTUBXONA", scopeId: "lib-B", severity: "MEDIUM", resolved: false },
      // KLUB scope — resolve via Club.institution geo.
      { id: "a6", scope: "KLUB", scopeId: "club-A", severity: "LOW", resolved: false },
      // USER scope — resolve via User.address geo.
      { id: "a7", scope: "USER", scopeId: "user-A", severity: "MEDIUM", resolved: false },
      // NATIONAL — non-regional, hidden from tier admins.
      { id: "a8", scope: "NATIONAL", scopeId: "UZ", severity: "CRITICAL", resolved: false },
    ];

    const wireRegionLookups = () => {
      // Tuman rows for the TUMAN-scoped alerts (so VILOYAT_ADMIN can match).
      replica.tuman.findMany.mockResolvedValue([
        { id: "UZ-08-012", viloyatId: "UZ-08" },
        { id: "UZ-08-099", viloyatId: "UZ-08" },
        { id: "UZ-12-001", viloyatId: "UZ-12" },
      ]);
      // lib-A in tuman UZ-08-012 (viloyat UZ-08); lib-B in tuman UZ-12-001.
      replica.library.findMany.mockResolvedValue([
        { id: "lib-A", viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        { id: "lib-B", viloyatId: "UZ-12", tumanId: "UZ-12-001" },
      ]);
      // club-A's institution is in tuman UZ-08-099 (viloyat UZ-08).
      replica.club.findMany.mockResolvedValue([
        { id: "club-A", institution: { viloyatId: "UZ-08", tumanId: "UZ-08-099" } },
      ]);
      // user-A lives in tuman UZ-08-012 (viloyat UZ-08).
      replica.user.findMany.mockResolvedValue([
        { id: "user-A", address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" } },
      ]);
    };

    beforeEach(() => {
      replica.aiAuditLog.findMany.mockResolvedValue(ALERTS);
      wireRegionLookups();
    });

    it("SUPER_ADMIN gets ALL unresolved alerts (no region filter)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      expect(result).toHaveLength(ALERTS.length);
      // Region-resolution lookups MUST NOT run for the global path.
      expect(replica.tuman.findMany).not.toHaveBeenCalled();
      expect(replica.library.findMany).not.toHaveBeenCalled();
    });

    it("BUXGALTER gets ALL unresolved alerts (global financial monitoring)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.BUXGALTER,
        address: null,
      });
      expect(result).toHaveLength(ALERTS.length);
    });

    it("no user arg → global behavior (cron/legacy safe)", async () => {
      const result = await service.getSmartAlerts(50);
      expect(result).toHaveLength(ALERTS.length);
    });

    it("TUMAN_ADMIN sees ONLY alerts in their tuman (tuman/library/user scopes)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      const ids = (result as Array<{ id: string }>).map((a) => a.id).sort();
      // a1 (TUMAN UZ-08-012), a4 (lib-A in UZ-08-012), a7 (user-A in UZ-08-012).
      expect(ids).toEqual(["a1", "a4", "a7"]);
      // Sibling-tuman (a2 club, a3, a5, a6) and NATIONAL (a8) excluded.
      expect(ids).not.toContain("a2");
      expect(ids).not.toContain("a8");
    });

    it("VILOYAT_ADMIN sees ALL alerts in their viloyat (across its tumans)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      const ids = (result as Array<{ id: string }>).map((a) => a.id).sort();
      // a1 (UZ-08-012), a2 (UZ-08-099), a4 (lib-A UZ-08), a6 (club UZ-08), a7 (user UZ-08).
      expect(ids).toEqual(["a1", "a2", "a4", "a6", "a7"]);
      // Other viloyat (a3 tuman, a5 lib-B) and NATIONAL (a8) excluded.
      expect(ids).not.toContain("a3");
      expect(ids).not.toContain("a5");
      expect(ids).not.toContain("a8");
    });

    it("VILOYAT_ADMIN in a different viloyat sees only its own", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-12", tumanId: null },
      });
      const ids = (result as Array<{ id: string }>).map((a) => a.id).sort();
      // a3 (TUMAN UZ-12-001) + a5 (lib-B in UZ-12-001).
      expect(ids).toEqual(["a3", "a5"]);
    });

    it("TUMAN_ADMIN with null tuman → empty (fail-CLOSED)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.TUMAN_ADMIN,
        address: null,
      });
      expect(result).toEqual([]);
    });

    it("VILOYAT_ADMIN with null viloyat → empty (fail-CLOSED)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: null, tumanId: null },
      });
      expect(result).toEqual([]);
    });

    it("excludes a library-scoped alert whose scopeId is not a Library id (FUND_SHORTAGE fail-CLOSED)", async () => {
      // FUND_SHORTAGE writes scopeId = library NAME, which misses the Library
      // lookup → excluded for a regional admin.
      replica.aiAuditLog.findMany.mockResolvedValue([
        { id: "fs", scope: "KUTUBXONA", scopeId: "Karmana tuman kutubxonasi", severity: "MEDIUM", resolved: false },
      ]);
      replica.library.findMany.mockResolvedValue([]); // name doesn't resolve to a row
      const result = await service.getSmartAlerts(50, {
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      expect(result).toEqual([]);
    });

    it("uses a region-scoped cache key for tier admins (no cross-admin bleed)", async () => {
      await service.getSmartAlerts(50, {
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      const keys = (mockCache.remember as jest.Mock).mock.calls.map((c) => c[0]);
      expect(keys.some((k: string) => k.startsWith("admin:alerts:TUMAN_ADMIN:"))).toBe(true);
      // The plain global key is NOT used for a tier admin.
      expect(keys).not.toContain("admin:alerts");
    });

    it("MUASSASA_ADMIN (non-geo tier) gets an empty regional view (fail-CLOSED)", async () => {
      const result = await service.getSmartAlerts(50, {
        role: UserRole.MUASSASA_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      expect(result).toEqual([]);
    });
  });
});
