import { ForbiddenException } from "@nestjs/common";
import { MukofotService } from "../mukofot.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { CacheService } from "../../../../infra/cache/cache.service";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: { findFirst: jest.fn(), findMany: jest.fn() },
  institution: { findUnique: jest.fn() },
  orgRating: { findMany: jest.fn() },
  aiAuditLog: { create: jest.fn(), findFirst: jest.fn() },
} as any;

const mockCache = {
  setNx: jest.fn().mockResolvedValue(true),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

describe("MukofotService", () => {
  let service: MukofotService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCache.setNx.mockResolvedValue(true);
    mockPrisma.aiAuditLog.create.mockResolvedValue({ id: "audit-1" });
    mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue({ id: "hr-1", name: "HR Admin" });
    mockPrisma.user.findMany.mockResolvedValue([{ id: "hr-1", phone: "+998901234567" }]);
    mockPrisma.institution.findUnique.mockResolvedValue({
      id: "inst-1",
      type: "IDORA",
      viloyatId: "v-1",
      tumanId: "t-1",
      name: "Test Idora",
    });

    service = new MukofotService(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as CacheService,
      undefined, // replica
      mockQueue as any,
    );
  });

  // ── recommendMukofot — HR-initiated path ────────────────────────────────

  describe("recommendMukofot", () => {
    it("writes AiAuditLog MUKOFOT_TAKLIFI and enqueues HR email", async () => {
      const result = await service.recommendMukofot(
        "inst-1",
        "user-1",
        { sub: "hr-1", user: { role: "MUASSASA_ADMIN", organizationId: "inst-1" } as any },
        { month: "2026-05", monthlyRi: 88, userName: "Ali", institutionName: "Test Idora" },
      );

      expect(result.auditId).toBe("audit-1");
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: "MUKOFOT_TAKLIFI", scope: "INSTITUTION" }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "mukofot-taklifi",
        expect.objectContaining({
          type: "email",
          subject: expect.stringContaining("Mukofot"),
          jobType: "MUKOFOT_TAKLIFI",
        }),
      );
    });

    it("BLOCKS HR self-nomination (T-06-09 self-deal guard)", async () => {
      await expect(
        service.recommendMukofot(
          "inst-1",
          "hr-1", // same as actor.sub
          { sub: "hr-1", user: { role: "MUASSASA_ADMIN", organizationId: "inst-1" } as any },
          { month: "2026-05", userName: "HR", institutionName: "Test Idora" },
        ),
      ).rejects.toThrow(ForbiddenException);

      // Flag audit log written instead of email
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: "MUKOFOT_SELF_NOMINATION_FLAG" }),
        }),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("escapes user/institution name in email body (XSS regression)", async () => {
      await service.recommendMukofot(
        "inst-1",
        "user-1",
        { sub: "hr-1" },
        {
          month: "2026-05",
          monthlyRi: 80,
          userName: "<script>x</script>",
          institutionName: "<img onerror=>",
        },
      );

      const body = mockQueue.add.mock.calls[0][1].message;
      expect(body).not.toContain("<script>x</script>");
      expect(body).toContain("&lt;script&gt;");
      expect(body).not.toContain("<img onerror=>");
      expect(body).toContain("&lt;img");
    });

    it("systemActor bypasses self-nomination guard (cron path)", async () => {
      const result = await service.recommendMukofot(
        "inst-1",
        "hr-1",
        { sub: "hr-1", systemActor: true },
        { month: "2026-05", userName: "HR", institutionName: "Test" },
      );
      expect(result.auditId).toBe("audit-1");
    });
  });

  // ── scanForNewMvp — monthly cron ──────────────────────────────────────────

  describe("scanForNewMvp", () => {
    it("skips when leader lock is held", async () => {
      mockCache.setNx.mockResolvedValueOnce(false);
      await service.scanForNewMvp();
      expect(mockPrisma.orgRating.findMany).not.toHaveBeenCalled();
    });

    it("flags MVP equals HR admin (T-06-09)", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([
        { institutionId: "inst-1", userId: "hr-1", userName: "HR Admin", avgRi: 80, isMvp: true, month: "2026-05" },
      ]);
      await service.scanForNewMvp();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: "MUKOFOT_SELF_NOMINATION_FLAG" }),
        }),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("dedups when MUKOFOT_TAKLIFI already exists for institution + month", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([
        { institutionId: "inst-1", userId: "user-1", userName: "Ali", avgRi: 80, isMvp: true, month: "2026-05" },
      ]);
      mockPrisma.aiAuditLog.findFirst.mockResolvedValue({ id: "prev" });
      await service.scanForNewMvp();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("writes MUKOFOT_TAKLIFI + emails HR for new MVP rows", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([
        { institutionId: "inst-1", userId: "user-1", userName: "Ali", avgRi: 80, isMvp: true, month: "2026-05" },
      ]);
      // HR admin is a different person than the MVP
      mockPrisma.user.findFirst.mockResolvedValue({ id: "hr-1", name: "HR" });
      await service.scanForNewMvp();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: "MUKOFOT_TAKLIFI" }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalled();
    });
  });
});
