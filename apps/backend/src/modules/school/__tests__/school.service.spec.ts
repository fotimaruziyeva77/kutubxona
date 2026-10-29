import { NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { SchoolService } from "../school.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";
import { InstitutionType } from "@prisma/client";

const mockPrisma = {
  tuman: { findUnique: jest.fn() },
  institution: {
    create:     jest.fn(),
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    count:      jest.fn(),
    update:     jest.fn(),
  },
  user: {
    count:    jest.fn(),
    groupBy:  jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update:   jest.fn(),
  },
  club: {
    count:    jest.fn(),
    findMany: jest.fn(),
  },
  bookTransaction: {
    count: jest.fn(),
  },
  schoolRating: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    upsert:     jest.fn(),
    create:     jest.fn(),
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
};

const mockReplica = {
  institution: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  user: { count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
  club: { count: jest.fn(), findMany: jest.fn() },
  bookTransaction: { count: jest.fn() },
  schoolRating: { findUnique: jest.fn(), findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

const mockCache = {
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
  del:      jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
};

const mockLock = {
  tryAcquire: jest.fn(),
  storeResponse: jest.fn(),
  release: jest.fn(),
};

const makeService = () =>
  new SchoolService(
    mockPrisma as unknown as PrismaService,
    mockCache as unknown as CacheService,
    mockReplica as unknown as PrismaReplicaService,
    mockLock as unknown as RedisLockService,
  );

describe("SchoolService", () => {
  let service: SchoolService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    // Reset mock implementations (clearAllMocks does NOT clear queued
    // mockResolvedValueOnce, so reset replica $queryRaw + user mocks explicitly
    // to avoid cross-test pollution from unconsumed once-resolves).
    mockReplica.$queryRaw.mockReset();
    mockReplica.user.count.mockReset();
    mockReplica.user.groupBy.mockReset();
    mockReplica.institution.findUnique.mockReset();
    mockReplica.institution.findMany.mockReset();
    mockReplica.schoolRating.findMany.mockReset();
    mockReplica.club.count.mockReset();
    mockReplica.bookTransaction.count.mockReset();
    mockCache.remember.mockImplementation((_k: string, _t: number, fn: () => unknown) => fn());
  });

  // ── createInstitution ──────────────────────────────────────────────────────
  describe("createInstitution", () => {
    it("maktab yaratadi va kodni generatsiya qiladi", async () => {
      mockPrisma.tuman.findUnique.mockResolvedValue({ id: "t1", code: "08-012" });
      mockPrisma.institution.count.mockResolvedValue(2);
      mockPrisma.institution.create.mockResolvedValue({
        id: "inst-1", type: "MAKTAB", name: "8-maktab", code: "MAKTAB-08012-003"
      });

      const result = await service.createInstitution({
        type: InstitutionType.MAKTAB,
        name: "8-maktab",
        tumanId: "t1",
        viloyatId: "v1",
      });

      expect(mockPrisma.institution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: "MAKTAB-08012-003" })
        })
      );
      expect(result.id).toBe("inst-1");
    });

    it("tuman topilmasa NotFoundException", async () => {
      mockPrisma.tuman.findUnique.mockResolvedValue(null);

      await expect(service.createInstitution({
        type: InstitutionType.MAKTAB, name: "Test", tumanId: "notfound", viloyatId: "v1"
      })).rejects.toThrow(NotFoundException);
    });
  });

  // ── getInstitution (uses replica) ─────────────────────────────────────────
  describe("getInstitution", () => {
    it("muassasani klublar bilan qaytaradi (via replica)", async () => {
      const inst = {
        id: "inst-1", name: "8-maktab", type: "MAKTAB",
        clubs: [{ id: "club-1", name: "Jadidlar izidan", leaderId: "teacher-1", _count: { members: 15 } }]
      };
      mockReplica.institution.findUnique.mockResolvedValue(inst);

      const result = await service.getInstitution("inst-1");

      expect(result.id).toBe("inst-1");
      expect(result.clubs).toHaveLength(1);
      expect(mockReplica.institution.findUnique).toHaveBeenCalled();
    });

    it("topilmasa NotFoundException", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(null);
      await expect(service.getInstitution("notfound")).rejects.toThrow(NotFoundException);
    });
  });

  // ── getSchoolStats — Scope guards (SCH-01) ───────────────────────────────
  describe("getSchoolStats with scope guard", () => {
    const inst = { id: "inst-1", name: "8-maktab", type: "MAKTAB", viloyatId: "v1", tumanId: "t1" };

    beforeEach(() => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      // Set up the stats body mocks
      mockReplica.user.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(5);
      mockReplica.$queryRaw
        .mockResolvedValueOnce([{ avg: 65.5 }])
        .mockResolvedValueOnce([{ count: BigInt(30) }]);
      mockReplica.user.groupBy.mockResolvedValue([]);
      mockReplica.club.count.mockResolvedValue(3);
      mockReplica.bookTransaction.count.mockResolvedValue(150);
    });

    it("SUPER_ADMIN bypasses scope check", async () => {
      const user = { role: "SUPER_ADMIN", address: { viloyatId: "v9", tumanId: "t9" } };
      const result = await service.getSchoolStats("inst-1", user as any);
      expect(result.students.total).toBe(100);
    });

    it("MUASSASA_ADMIN with matching schoolId succeeds", async () => {
      const user = { role: "MUASSASA_ADMIN", schoolId: "inst-1", address: {} };
      const result = await service.getSchoolStats("inst-1", user as any);
      expect(result.students.total).toBe(100);
    });

    it("MUASSASA_ADMIN with different schoolId throws ForbiddenException", async () => {
      const user = { role: "MUASSASA_ADMIN", schoolId: "other-school", address: {} };
      await expect(service.getSchoolStats("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
    });

    it("scope guard runs BEFORE cache.remember (cache key not poisoned)", async () => {
      const user = { role: "MUASSASA_ADMIN", schoolId: "other-school", address: {} };
      await expect(service.getSchoolStats("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
      expect(mockCache.remember).not.toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN matching viloyat succeeds", async () => {
      const user = { role: "VILOYAT_ADMIN", address: { viloyatId: "v1" } };
      const result = await service.getSchoolStats("inst-1", user as any);
      expect(result.students.total).toBe(100);
    });

    it("VILOYAT_ADMIN mismatched viloyat throws", async () => {
      const user = { role: "VILOYAT_ADMIN", address: { viloyatId: "v2" } };
      await expect(service.getSchoolStats("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
    });

    it("TUMAN_ADMIN matching tuman succeeds", async () => {
      const user = { role: "TUMAN_ADMIN", address: { tumanId: "t1" } };
      const result = await service.getSchoolStats("inst-1", user as any);
      expect(result.students.total).toBe(100);
    });

    it("TUMAN_ADMIN mismatched tuman throws", async () => {
      const user = { role: "TUMAN_ADMIN", address: { tumanId: "t2" } };
      await expect(service.getSchoolStats("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
    });

    it("muassasa topilmasa NotFoundException", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(null);
      await expect(service.getSchoolStats("notfound")).rejects.toThrow(NotFoundException);
    });
  });

  // ── getStudentsByClass — SCH-01 K-anonymity ──────────────────────────────
  describe("getStudentsByClass (SCH-01 K-anon)", () => {
    const inst = { id: "inst-1", type: "MAKTAB", viloyatId: "v1", tumanId: "t1" };

    it("groups by class and suppresses avgRi when total < 5", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      mockReplica.user.groupBy.mockResolvedValue([
        { schoolClass: "9A", status: "ACTIVE", _count: { id: 10 } },
        { schoolClass: "9A", status: "PENDING", _count: { id: 2 } },
        { schoolClass: "10B", status: "ACTIVE", _count: { id: 3 } }, // K-anon → suppressed
      ]);
      mockReplica.$queryRaw.mockResolvedValue([
        { schoolClass: "9A", avg: 65.5 },
        { schoolClass: "10B", avg: 70.0 },
      ]);

      const result = await service.getStudentsByClass("inst-1");

      const c9A = result.buckets.find((b: any) => b.className === "9A");
      const c10B = result.buckets.find((b: any) => b.className === "10B");
      expect(c9A?.total).toBe(12);
      expect(c9A?.active).toBe(10);
      expect(c9A?.pending).toBe(2);
      expect(c9A?.avgRi).toBeCloseTo(65.5);
      expect(c9A?.kAnonymitySuppressed).toBe(false);
      // 10B has only 3 students — K-anon kicks in, avgRi null
      expect(c10B?.total).toBe(3);
      expect(c10B?.avgRi).toBeNull();
      expect(c10B?.kAnonymitySuppressed).toBe(true);
    });

    it("MUASSASA_ADMIN cross-school throws Forbidden", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      const user = { role: "MUASSASA_ADMIN", schoolId: "different-school", address: {} };
      await expect(service.getStudentsByClass("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
    });

    it("scope guard runs BEFORE cache.remember", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      const user = { role: "MUASSASA_ADMIN", schoolId: "different-school", address: {} };
      await expect(service.getStudentsByClass("inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
      expect(mockCache.remember).not.toHaveBeenCalled();
    });
  });

  // ── rejectStudent (SCH-02) ────────────────────────────────────────────────
  describe("rejectStudent (SCH-02)", () => {
    const inst = { id: "inst-1", type: "MAKTAB", viloyatId: "v1", tumanId: "t1" };

    beforeEach(() => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1", schoolId: "inst-1", status: "PENDING", name: "Aziz",
      });
      mockPrisma.$transaction.mockImplementation(async (ops: any) => {
        // simulate prisma $transaction([op1, op2]) returning the array of results
        if (Array.isArray(ops)) {
          return [{ id: "u-1" }, { id: "audit-1" }];
        }
        // interactive callback
        return ops(mockPrisma);
      });
    });

    it("updates status to BLOCKED + writes AiAuditLog with STUDENT_REJECT", async () => {
      const result = await service.rejectStudent("u-1", "inst-1", "duplicate registration");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toBe("duplicate registration");
    });

    it("throws 400 when reason is missing or too short", async () => {
      await expect(service.rejectStudent("u-1", "inst-1", ""))
        .rejects.toThrow(BadRequestException);
      await expect(service.rejectStudent("u-1", "inst-1", "ab"))
        .rejects.toThrow(BadRequestException);
    });

    it("throws 404 when target user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.rejectStudent("u-x", "inst-1", "spam"))
        .rejects.toThrow(NotFoundException);
    });

    it("throws 400 when target user not PENDING", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1", schoolId: "inst-1", status: "ACTIVE", name: "Aziz",
      });
      await expect(service.rejectStudent("u-1", "inst-1", "fake"))
        .rejects.toThrow(BadRequestException);
    });

    it("throws 400 when target user belongs to a different school", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1", schoolId: "other-school", status: "PENDING", name: "Aziz",
      });
      await expect(service.rejectStudent("u-1", "inst-1", "spam"))
        .rejects.toThrow(BadRequestException);
    });

    it("scope-guarded: MUASSASA_ADMIN of another school is forbidden", async () => {
      const user = { role: "MUASSASA_ADMIN", schoolId: "other-school", address: {} };
      await expect(service.rejectStudent("u-1", "inst-1", "spam", user as any))
        .rejects.toThrow(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("trims reason and caps at 500 chars", async () => {
      const longReason = "x".repeat(600);
      const result = await service.rejectStudent("u-1", "inst-1", longReason);
      expect(result.reason.length).toBe(500);
    });

    it("invalidates students-by-class + stats cache", async () => {
      await service.rejectStudent("u-1", "inst-1", "spam");
      expect(mockCache.del).toHaveBeenCalledWith("school:stats:inst-1");
      expect(mockCache.del).toHaveBeenCalledWith("school:students-by-class:inst-1");
    });
  });

  // ── approveStudent (regression: now scope-guarded) ────────────────────────
  describe("approveStudent (SCH-01 with scope)", () => {
    const inst = { id: "inst-1", type: "MAKTAB", viloyatId: "v1", tumanId: "t1" };

    it("MUASSASA_ADMIN of correct school approves", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1", schoolId: "inst-1", status: "PENDING", name: "Z",
      });
      mockPrisma.user.update.mockResolvedValue({ id: "u-1", status: "ACTIVE" });

      const user = { role: "MUASSASA_ADMIN", schoolId: "inst-1", address: {} };
      const result = await service.approveStudent("u-1", "inst-1", user as any);
      expect(result.status).toBe("ACTIVE");
    });

    it("MUASSASA_ADMIN of different school is forbidden", async () => {
      mockReplica.institution.findUnique.mockResolvedValue(inst);
      const user = { role: "MUASSASA_ADMIN", schoolId: "other", address: {} };
      await expect(service.approveStudent("u-1", "inst-1", user as any))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ── computeSchoolRatings — R-DUP no-op ────────────────────────────────────
  describe("computeSchoolRatings (R-DUP no-op)", () => {
    it("returns deprecated marker without touching SchoolRating", async () => {
      const result = await service.computeSchoolRatings("2026-05");

      expect(result.computed).toBe(0);
      expect(result.note).toMatch(/deprecated/);
      expect(mockPrisma.schoolRating.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.create).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.createMany).not.toHaveBeenCalled();
    });
  });

  // ── refreshRankingCache @Cron (SCH-07) ────────────────────────────────────
  describe("refreshRankingCache (SCH-07)", () => {
    it("acquires leader lock and invalidates cache pattern", async () => {
      mockLock.tryAcquire.mockResolvedValue({ first: true });
      await service.refreshRankingCache();
      expect(mockLock.tryAcquire).toHaveBeenCalledWith(
        "lock:school-ranking-refresh-weekly",
        expect.any(Number),
        expect.any(String),
      );
      expect(mockCache.delPattern).toHaveBeenCalledWith("school:ranking:*");
    });

    it("is a no-op when lock NOT acquired (another replica owns the run)", async () => {
      mockLock.tryAcquire.mockResolvedValue({ first: false });
      await service.refreshRankingCache();
      expect(mockCache.delPattern).not.toHaveBeenCalled();
    });

    it("NEVER writes to SchoolRating (R-DUP gate)", async () => {
      mockLock.tryAcquire.mockResolvedValue({ first: true });
      await service.refreshRankingCache();
      expect(mockPrisma.schoolRating.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.create).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.createMany).not.toHaveBeenCalled();
    });
  });

  // ── getSchoolRankings — READ-only consumer ────────────────────────────────
  describe("getSchoolRankings (SCH-07 read-only consumer)", () => {
    it("reads from SchoolRating via replica, NEVER writes", async () => {
      mockReplica.schoolRating.findMany.mockResolvedValue([
        { institutionId: "inst-1", rank: 1, totalScore: 95, month: "2026-05" },
      ]);
      mockReplica.institution.findMany.mockResolvedValue([
        { id: "inst-1", name: "Maktab 1", code: "MAKTAB-08012-001", tumanId: "t1", viloyatId: "v1" },
      ]);

      const result = await service.getSchoolRankings({ month: "2026-05", limit: 10 });
      expect(result).toHaveLength(1);
      expect(mockPrisma.schoolRating.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.schoolRating.create).not.toHaveBeenCalled();
    });
  });
});
