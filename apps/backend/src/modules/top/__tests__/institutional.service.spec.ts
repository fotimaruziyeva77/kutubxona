import { InstitutionalService } from "../institutional.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { InstitutionType } from "@prisma/client";

const thirtyYearsAgo = new Date(new Date().getFullYear() - 30, 0, 1);
const twelveYearsAgo = new Date(new Date().getFullYear() - 12, 0, 1);

function buildMocks() {
  const mockPrisma = {
    schoolRating: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    orgRating: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const mockReplica = {
    institution: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // Audit H8 — cron leader lock; default "acquired" so the cron body runs.
  const mockCache = {
    setNx: jest.fn().mockResolvedValue(true),
  };
  return { mockPrisma, mockReplica, mockCache };
}

describe("InstitutionalService", () => {
  let service: InstitutionalService;
  let mockPrisma: ReturnType<typeof buildMocks>["mockPrisma"];
  let mockReplica: ReturnType<typeof buildMocks>["mockReplica"];
  let mockCache: ReturnType<typeof buildMocks>["mockCache"];

  beforeEach(() => {
    const m = buildMocks();
    mockPrisma = m.mockPrisma;
    mockReplica = m.mockReplica;
    mockCache = m.mockCache;
    service = new InstitutionalService(
      mockPrisma as unknown as PrismaService,
      mockReplica as unknown as PrismaReplicaService,
      mockCache as unknown as CacheService,
    );
    jest.clearAllMocks();
    mockPrisma.schoolRating.upsert.mockResolvedValue({});
    mockPrisma.orgRating.upsert.mockResolvedValue({});
    mockPrisma.aiAuditLog.create.mockResolvedValue({});
    mockReplica.institution.findMany.mockResolvedValue([]);
    mockReplica.user.findMany.mockResolvedValue([]);
    mockCache.setNx.mockResolvedValue(true);
  });

  describe("computeInstitutionalRankings (cron)", () => {
    it("yozadi SchoolRating uchun MAKTAB tipi", async () => {
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.MAKTAB) {
            return [{ id: "sch-1", name: "8-maktab", type: "MAKTAB" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "Ali Valiyev",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 80 }],
          transactions: [{ id: "t1" }, { id: "t2" }],
        },
        {
          id: "u2",
          name: "Vali Aliyev",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 60 }],
          transactions: [{ id: "t3" }],
        },
        {
          id: "u3",
          name: "Karim Karimov",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 40 }],
          transactions: [],
        },
      ]);

      const result = await service.computeInstitutionalRankings();

      expect(mockPrisma.schoolRating.upsert).toHaveBeenCalled();
      const call = mockPrisma.schoolRating.upsert.mock.calls[0][0];
      expect(call.create.institutionId).toBe("sch-1");
      // avg of 80, 60, 40 = 60
      expect(call.create.avgRi).toBe(60);
      expect(result!.totalWritten).toBeGreaterThanOrEqual(1);
    });

    // Audit H8 — multi-replica leader lock: non-leader replicas must no-op.
    it("leader lock held (setNx=false) → cron no-ops, nothing written", async () => {
      mockCache.setNx.mockResolvedValueOnce(false);

      const result = await service.computeInstitutionalRankings();

      expect(result).toBeUndefined();
      expect(mockReplica.institution.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("D-1: replica.user.findMany ishlatadi (write yo'q primary'gacha)", async () => {
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.MAKTAB) {
            return [{ id: "sch-1", name: "1-maktab", type: "MAKTAB" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "X",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 50 }],
          transactions: [],
        },
      ]);

      await service.computeInstitutionalRankings();

      expect(mockReplica.user.findMany).toHaveBeenCalled();
      // SchoolRating mutation happens on primary
      expect(mockPrisma.schoolRating.upsert).toHaveBeenCalled();
    });

    it("OTM ham SchoolRating ga yoziladi (D-6/D-7 schema debt — V2 UniRating)", async () => {
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.OTM) {
            return [{ id: "uni-1", name: "NUU", type: "OTM" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "Talaba",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 70 }],
          transactions: [],
        },
      ]);

      await service.computeInstitutionalRankings();

      // OTM lands in SchoolRating per Plan 03-03 schema-debt decision
      expect(mockPrisma.schoolRating.upsert).toHaveBeenCalled();
      expect(mockPrisma.orgRating.upsert).not.toHaveBeenCalled();
    });

    it("IDORA → OrgRating yoziladi (per-employee + isMvp top scorer)", async () => {
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.IDORA) {
            return [{ id: "org-1", name: "Vazirlik", type: "IDORA" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "Top Reader",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 90 }],
          transactions: [{ id: "t1" }],
        },
        {
          id: "u2",
          name: "Second Reader",
          dob: thirtyYearsAgo,
          readingIndex: [{ score: 70 }],
          transactions: [],
        },
      ]);

      await service.computeInstitutionalRankings();

      expect(mockPrisma.orgRating.upsert).toHaveBeenCalledTimes(2);
      const firstCall = mockPrisma.orgRating.upsert.mock.calls[0][0];
      expect(firstCall.create.userId).toBe("u1");
      expect(firstCall.create.rank).toBe(1);
      expect(firstCall.create.isMvp).toBe(true);
      const secondCall = mockPrisma.orgRating.upsert.mock.calls[1][0];
      expect(secondCall.create.rank).toBe(2);
      expect(secondCall.create.isMvp).toBe(false);
    });

    it("TOP-06: 12-yoshli IDORA xodimi userName ma'lumotini niqoblaydi", async () => {
      // Hypothetical edge case: minor employee — defense in depth.
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.IDORA) {
            return [{ id: "org-1", name: "Org", type: "IDORA" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "Ali Karimov",
          dob: twelveYearsAgo,
          readingIndex: [{ score: 80 }],
          transactions: [],
        },
      ]);

      await service.computeInstitutionalRankings();

      const call = mockPrisma.orgRating.upsert.mock.calls[0][0];
      // 12-year-old gets initialed by maskNameIfMinor
      expect(call.create.userName).toBe("A.K.");
    });

    it("foydalanuvchilar yo'q bo'lgan institution o'tkazib yuboriladi", async () => {
      mockReplica.institution.findMany.mockImplementation(
        async ({ where }: { where: { type: InstitutionType } }) => {
          if (where.type === InstitutionType.MAKTAB) {
            return [{ id: "sch-empty", name: "Empty", type: "MAKTAB" }];
          }
          return [];
        },
      );
      mockReplica.user.findMany.mockResolvedValue([]);

      const result = await service.computeInstitutionalRankings();

      expect(mockPrisma.schoolRating.upsert).not.toHaveBeenCalled();
      expect(result!.totalWritten).toBe(0);
    });

    it("har bir run uchun bitta AiAuditLog STATE_TRANSITION yoziladi", async () => {
      await service.computeInstitutionalRankings();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      expect(call.data.scope).toBe("INSTITUTIONAL");
      expect(call.data.issueType).toBe("STATE_TRANSITION");
    });
  });

  describe("getInstitutionalRanking endpoint", () => {
    it("maktab tipi uchun SchoolRating qaytaradi", async () => {
      mockPrisma.schoolRating.findMany.mockResolvedValue([
        { institutionId: "sch-1", month: "2026-06", avgRi: 75, totalScore: 80 },
      ]);

      const result = (await service.getInstitutionalRanking("maktab", {})) as {
        type: string;
        rows: unknown[];
      };

      expect(result.type).toBe("maktab");
      expect(result.rows).toHaveLength(1);
      expect(mockPrisma.schoolRating.findMany).toHaveBeenCalled();
    });

    it("idora tipi uchun OrgRating qaytaradi", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([
        { institutionId: "org-1", userId: "u1", userName: "X", rank: 1, isMvp: true },
      ]);

      const result = (await service.getInstitutionalRanking("idora", {
        limit: 10,
      })) as { type: string; rows: unknown[] };

      expect(result.type).toBe("idora");
      expect(mockPrisma.orgRating.findMany).toHaveBeenCalled();
    });

    it("viloyat/tuman tipi TopService.getRegionalRanking ga delegate qiladi", async () => {
      const delegate = {
        getRegionalRanking: jest.fn().mockResolvedValue([{ regionId: "v1" }]),
      };

      const result = await service.getInstitutionalRanking(
        "viloyat",
        {},
        delegate,
      );

      expect(delegate.getRegionalRanking).toHaveBeenCalledWith("viloyat");
      expect(result).toEqual([{ regionId: "v1" }]);
    });

    it("mahalla tipi raw SQL aggregate ishlatadi", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { regionId: "m1", avgScore: 60, userCount: 5 },
      ]);

      const result = await service.getInstitutionalRanking("mahalla", {});

      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      expect(result).toEqual([{ regionId: "m1", avgScore: 60, userCount: 5 }]);
    });
  });
});
