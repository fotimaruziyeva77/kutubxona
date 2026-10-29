import { UserRole } from "@prisma/client";
import { FamilyController } from "../family.controller";
import { FamilyService } from "../family.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

const USER_PAYLOAD = {
  sub: "u1",
  role: UserRole.KITOBXON,
  phone: "+998901234567",
};

describe("FamilyController", () => {
  let controller: FamilyController;
  let service: jest.Mocked<FamilyService>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;

  beforeEach(() => {
    service = {
      createFamily: jest.fn().mockResolvedValue({ id: "fam-1" }),
      getFamily: jest.fn().mockResolvedValue({ id: "fam-1" }),
      detectAndSuggestFamily: jest.fn().mockResolvedValue(null),
      inviteMember: jest.fn().mockResolvedValue({ id: "inv-1" }),
      respondToInvite: jest.fn().mockResolvedValue({ accepted: true }),
      leaveFamily: jest.fn().mockResolvedValue({ left: true }),
      getFamilyRatings: jest.fn().mockResolvedValue([]),
      getFamilyRating: jest.fn().mockResolvedValue(null),
      computeFamilyRatings: jest.fn().mockResolvedValue({ computed: 0, total: 0 }),
      setFamilyDetectionEnabled: jest
        .fn()
        .mockResolvedValue({ familyDetectionEnabled: true, changed: true }),
      getPublicFamilyProfile: jest.fn().mockResolvedValue({
        family: { id: "fam-1", name: "X", avgRi: 50, memberCount: 1 },
        members: [],
      }),
    } as unknown as jest.Mocked<FamilyService>;
    prisma = { user: { findFirst: jest.fn(), findUnique: jest.fn() } };
    controller = new FamilyController(service, prisma as unknown as PrismaService);
  });

  // ── Plan 06-03 FAM-01 — toggle wires to setFamilyDetectionEnabled ──────
  describe("PATCH /family/me/family-detection", () => {
    it("delegates to service.setFamilyDetectionEnabled with user.sub", async () => {
      const res = await controller.setFamilyDetection(USER_PAYLOAD, {
        enabled: true,
      });
      expect(service.setFamilyDetectionEnabled).toHaveBeenCalledWith("u1", true);
      expect(res.changed).toBe(true);
    });

    it("supports disabling", async () => {
      service.setFamilyDetectionEnabled.mockResolvedValueOnce({
        familyDetectionEnabled: false,
        changed: true,
      });
      const res = await controller.setFamilyDetection(USER_PAYLOAD, {
        enabled: false,
      });
      expect(service.setFamilyDetectionEnabled).toHaveBeenCalledWith("u1", false);
      expect(res.familyDetectionEnabled).toBe(false);
    });
  });

  // ── Plan 06-03 FAM-05 — public profile endpoint ───────────────────────
  describe("GET /family/:id/profile", () => {
    it("delegates to service.getPublicFamilyProfile", async () => {
      await controller.getPublicFamilyProfile("fam-1");
      expect(service.getPublicFamilyProfile).toHaveBeenCalledWith("fam-1");
    });
  });

  // ── IDOR-C4 — actor identity comes from the JWT, never the body/params ──
  describe("IDOR-C4 — JWT-bound actor", () => {
    it("POST /family — creator is the JWT sub (forged creatorId is unreachable by construction)", async () => {
      // The handler signature only accepts { name }; a stale client sending
      // creatorId in the body cannot influence the call below.
      await controller.createFamily(USER_PAYLOAD.sub, { name: "Oilam" });
      expect(service.createFamily).toHaveBeenCalledWith("u1", "Oilam");
    });

    it("GET /family/:id — viewer {id, role} forwarded from the JWT", async () => {
      await controller.getFamily("fam-1", USER_PAYLOAD);
      expect(service.getFamily).toHaveBeenCalledWith("fam-1", {
        id: "u1",
        role: UserRole.KITOBXON,
      });
    });

    it("GET /family/suggest — detection target is the JWT sub", async () => {
      await controller.suggestFamily(USER_PAYLOAD.sub);
      expect(service.detectAndSuggestFamily).toHaveBeenCalledWith("u1");
    });

    it("GET /family/suggest/:userId (legacy) — param is ignored, JWT sub used", async () => {
      // The legacy handler binds NO route param — only @CurrentUser("id").
      await controller.suggestFamilyLegacy(USER_PAYLOAD.sub);
      expect(service.detectAndSuggestFamily).toHaveBeenCalledWith("u1");
    });

    it("POST /family/:id/invite — inviter is the JWT sub", async () => {
      await controller.inviteMember("fam-1", USER_PAYLOAD.sub, { inviteeId: "u2" });
      expect(service.inviteMember).toHaveBeenCalledWith("fam-1", "u1", "u2");
    });

    it("POST /family/:id/invite — resolves inviteePhone, inviter still JWT sub", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: "u9" });
      await controller.inviteMember("fam-1", USER_PAYLOAD.sub, {
        inviteePhone: "+998901112233",
      });
      expect(service.inviteMember).toHaveBeenCalledWith("fam-1", "u1", "u9");
    });

    it("POST /family/invites/:inviteId/respond — responder is the JWT sub", async () => {
      await controller.respondToInvite("inv-1", USER_PAYLOAD.sub, { accept: true });
      expect(service.respondToInvite).toHaveBeenCalledWith("inv-1", "u1", true);
    });

    it("DELETE /family/leave — leaver is the JWT sub", async () => {
      await controller.leaveFamily(USER_PAYLOAD.sub);
      expect(service.leaveFamily).toHaveBeenCalledWith("u1");
    });

    it("DELETE /family/leave/:userId (legacy) — param is ignored, JWT sub used", async () => {
      await controller.leaveFamilyLegacy(USER_PAYLOAD.sub);
      expect(service.leaveFamily).toHaveBeenCalledWith("u1");
    });
  });

  // ── Plan 06-03 FAM-05 — top ratings endpoint ──────────────────────────
  describe("GET /family/ratings/top", () => {
    it("forwards filters", async () => {
      await controller.getFamilyRatings(
        "v1",
        "t1",
        "m1",
        "2026-05",
        "20",
      );
      expect(service.getFamilyRatings).toHaveBeenCalledWith({
        viloyatId: "v1",
        tumanId: "t1",
        mahallaId: "m1",
        month: "2026-05",
        limit: 20,
      });
    });
  });

  // ── RBAC geographic scoping (Audit 2026-06) — admin-scoped ratings ─────
  describe("GET /family/ratings/admin (region-clamped)", () => {
    it("SUPER_ADMIN: filters pass through unchanged (national/arbitrary)", async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      await controller.getAdminFamilyRatings(
        { sub: "s1", role: UserRole.SUPER_ADMIN, phone: "+998900000000" },
        "UZ-12",
        "UZ-12-001",
        undefined,
        "2026-05",
        "10",
      );
      expect(service.getFamilyRatings).toHaveBeenCalledWith({
        viloyatId: "UZ-12",
        tumanId: "UZ-12-001",
        mahallaId: undefined,
        month: "2026-05",
        limit: 10,
      });
    });

    it("VILOYAT_ADMIN: viloyatId is FORCED to the caller's own (client filter overridden)", async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      // Client tries to browse a DIFFERENT viloyat — must be overridden.
      await controller.getAdminFamilyRatings(
        { sub: "v1", role: UserRole.VILOYAT_ADMIN, phone: "+998900000001" },
        "UZ-12",
        undefined,
        undefined,
        undefined,
        undefined,
      );
      expect(service.getFamilyRatings).toHaveBeenCalledWith(
        expect.objectContaining({ viloyatId: "UZ-08" }),
      );
    });

    it("TUMAN_ADMIN: tumanId is FORCED to the caller's own and viloyat filter dropped", async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      await controller.getAdminFamilyRatings(
        { sub: "t1", role: UserRole.TUMAN_ADMIN, phone: "+998900000002" },
        "UZ-12",
        "UZ-12-099",
        undefined,
        undefined,
        undefined,
      );
      expect(service.getFamilyRatings).toHaveBeenCalledWith(
        expect.objectContaining({ tumanId: "UZ-08-012", viloyatId: undefined }),
      );
    });

    it("TUMAN_ADMIN with no tuman → empty, service not called (fail-CLOSED)", async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.TUMAN_ADMIN,
        address: null,
      });
      const res = await controller.getAdminFamilyRatings(
        { sub: "t2", role: UserRole.TUMAN_ADMIN, phone: "+998900000003" },
      );
      expect(res).toEqual([]);
      expect(service.getFamilyRatings).not.toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN with no viloyat → empty, service not called (fail-CLOSED)", async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: null, tumanId: null },
      });
      const res = await controller.getAdminFamilyRatings(
        { sub: "v2", role: UserRole.VILOYAT_ADMIN, phone: "+998900000004" },
      );
      expect(res).toEqual([]);
      expect(service.getFamilyRatings).not.toHaveBeenCalled();
    });
  });
});
