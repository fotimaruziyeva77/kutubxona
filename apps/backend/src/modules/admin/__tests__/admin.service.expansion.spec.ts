import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { AdminService } from "../admin.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { K_ANONYMITY_THRESHOLD } from "../../../common/utils/k-anonymity.const";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";

/**
 * Plan 05-03 T1 + T2 — gender/age/genre-trend services + markBookForOrder.
 *
 * Covers:
 *  - getGenderBreakdown / getAgeBreakdown / getGenreTrend scope assert + replica.
 *  - markBookForOrder dedupe (24h), KUTUBXONACHI library scope check, validation.
 */

const makeReplica = () => ({
  user: { count: jest.fn(), groupBy: jest.fn().mockResolvedValue([]) },
  library: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
  book: {
    aggregate: jest.fn().mockResolvedValue({ _sum: { totalCount: 0, availableCount: 0 } }),
    findUnique: jest.fn(),
  },
  bookTransaction: { count: jest.fn().mockResolvedValue(0) },
  readingIndex: { aggregate: jest.fn().mockResolvedValue({ _avg: { score: 0 } }) },
  aiAuditLog: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn().mockResolvedValue(null) },
  mahalla: {
    findUnique: jest.fn().mockResolvedValue({
      tumanId: "UZ-08-012",
      tuman: { viloyatId: "UZ-08" },
    }),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
});

const makeCache = () => ({
  remember: jest.fn().mockImplementation(
    (_k: string, _t: number, fn: () => unknown) => fn(),
  ),
  del: jest.fn(),
  setNx: jest.fn().mockResolvedValue(true),
});

const makeLock = () => ({
  tryAcquire: jest.fn().mockResolvedValue({ first: true }),
  storeResponse: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
});

describe("AdminService — Plan 05-03 expansion (STAT-04..07)", () => {
  let replica: ReturnType<typeof makeReplica>;
  let cache: ReturnType<typeof makeCache>;
  let lock: ReturnType<typeof makeLock>;
  let mockPrisma: { aiAuditLog: { create: jest.Mock } };
  let service: AdminService;

  beforeEach(() => {
    replica = makeReplica();
    cache = makeCache();
    lock = makeLock();
    mockPrisma = {
      aiAuditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
    };
    service = new AdminService(
      mockPrisma as unknown as PrismaService,
      { sendNotification: jest.fn() } as unknown as SmsService,
      cache as unknown as CacheService,
      replica as unknown as PrismaReplicaService,
      undefined,
      lock as unknown as RedisLockService,
    );
    jest.clearAllMocks();
    cache.remember.mockImplementation(
      (_k: string, _t: number, fn: () => unknown) => fn(),
    );
  });

  // ── getGenderBreakdown ────────────────────────────────────────────────────
  describe("getGenderBreakdown (STAT-04)", () => {
    beforeEach(() => {
      replica.user.groupBy.mockResolvedValue([
        { gender: "MALE", _count: { _all: 1200 } },
        { gender: "FEMALE", _count: { _all: 1500 } },
      ]);
      replica.$queryRaw.mockResolvedValue([
        { gender: "MALE", avg_ri: 68.3 },
        { gender: "FEMALE", avg_ri: 71.7 },
      ]);
    });

    it("national scope returns MALE + FEMALE counts and readingIndex (buckets envelope)", async () => {
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.count).toBe(1200);
      expect(out.buckets.FEMALE.count).toBe(1500);
      expect(out.buckets.MALE.readingIndex).toBe(68.3);
      expect(out.buckets.FEMALE.readingIndex).toBe(71.7);
      expect(out.buckets.MALE.suppressed).toBe(false);
      expect(out.buckets.FEMALE.suppressed).toBe(false);
      expect(out.privacyThreshold).toBe(K_ANONYMITY_THRESHOLD);
      expect(out.anySuppressed).toBe(false);
    });

    it("VILOYAT_ADMIN with matching scope is allowed", async () => {
      const result = await service.getGenderBreakdown("viloyat", "UZ-08", {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      expect(result.buckets.MALE.count).toBe(1200);
      expect(replica.user.groupBy).toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN with mismatched scope throws Forbidden (cache not populated)", async () => {
      await expect(
        service.getGenderBreakdown("viloyat", "UZ-08", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-12", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.user.groupBy).not.toHaveBeenCalled();
    });

    it("uses CacheService.keys.genderBreakdown key + stats5min TTL", async () => {
      await service.getGenderBreakdown("viloyat", "UZ-08");
      expect(cache.remember).toHaveBeenCalledWith(
        CacheService.keys.genderBreakdown("viloyat", "UZ-08"),
        CacheService.ttl.stats5min,
        expect.any(Function),
      );
    });
  });

  // ── FIX B — k-anonymity suppression on gender buckets ────────────────────
  describe("getGenderBreakdown k-anonymity (Plan 05-03-fix FIX B)", () => {
    it("bucket count = 1 → suppressed:true, count: 0", async () => {
      replica.user.groupBy.mockResolvedValueOnce([
        { gender: "MALE", _count: { _all: 1 } },
        { gender: "FEMALE", _count: { _all: 100 } },
      ]);
      replica.$queryRaw.mockResolvedValueOnce([
        { gender: "MALE", avg_ri: 70 },
        { gender: "FEMALE", avg_ri: 65 },
      ]);
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.suppressed).toBe(true);
      expect(out.buckets.MALE.count).toBe(0);
      expect(out.buckets.MALE.readingIndex).toBe(0);
      expect(out.buckets.FEMALE.suppressed).toBe(false);
      expect(out.buckets.FEMALE.count).toBe(100);
      expect(out.anySuppressed).toBe(true);
    });

    it("bucket count = 4 → suppressed:true", async () => {
      replica.user.groupBy.mockResolvedValueOnce([
        { gender: "MALE", _count: { _all: 4 } },
        { gender: "FEMALE", _count: { _all: 50 } },
      ]);
      replica.$queryRaw.mockResolvedValueOnce([]);
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.suppressed).toBe(true);
      expect(out.buckets.MALE.count).toBe(0);
    });

    it("bucket count = 5 → suppressed:false, count: 5 (threshold inclusive)", async () => {
      replica.user.groupBy.mockResolvedValueOnce([
        { gender: "MALE", _count: { _all: 5 } },
      ]);
      replica.$queryRaw.mockResolvedValueOnce([]);
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.suppressed).toBe(false);
      expect(out.buckets.MALE.count).toBe(5);
    });

    it("bucket count = 10 → suppressed:false", async () => {
      replica.user.groupBy.mockResolvedValueOnce([
        { gender: "MALE", _count: { _all: 10 } },
      ]);
      replica.$queryRaw.mockResolvedValueOnce([]);
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.suppressed).toBe(false);
      expect(out.buckets.MALE.count).toBe(10);
      expect(out.anySuppressed).toBe(false);
    });

    it("count = 0 → suppressed:false (don't flag empty cells)", async () => {
      replica.user.groupBy.mockResolvedValueOnce([]);
      replica.$queryRaw.mockResolvedValueOnce([]);
      const out = await service.getGenderBreakdown("national");
      expect(out.buckets.MALE.count).toBe(0);
      expect(out.buckets.MALE.suppressed).toBe(false);
      expect(out.anySuppressed).toBe(false);
    });
  });

  // ── getAgeBreakdown ───────────────────────────────────────────────────────
  describe("getAgeBreakdown (STAT-05)", () => {
    beforeEach(() => {
      replica.$queryRaw.mockResolvedValue([
        { age_group: "7-14", user_count: 540n, avg_ri: 62.1 },
        { age_group: "15-30", user_count: 1200n, avg_ri: 71.8 },
        { age_group: "31-60", user_count: 800n, avg_ri: 65.3 },
        { age_group: "60+", user_count: 120n, avg_ri: 58.2 },
        { age_group: "unknown", user_count: 35n, avg_ri: 0 },
      ]);
    });

    it("returns 5 buckets keyed by ageGroup (buckets envelope)", async () => {
      const out = await service.getAgeBreakdown("national");
      expect(out.buckets).toHaveLength(5);
      const seven = out.buckets.find((b) => b.ageGroup === "7-14");
      expect(seven?.userCount).toBe(540);
      expect(seven?.readingIndex).toBe(62.1);
      expect(seven?.suppressed).toBe(false);
      expect(out.buckets.find((b) => b.ageGroup === "60+")?.userCount).toBe(120);
      expect(out.privacyThreshold).toBe(K_ANONYMITY_THRESHOLD);
      expect(out.anySuppressed).toBe(false);
    });

    it("TUMAN_ADMIN with matching tuman is allowed (with resolvedViloyatId)", async () => {
      const result = await service.getAgeBreakdown("tuman", "UZ-08-012", {
        role: UserRole.TUMAN_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
      });
      expect(result.buckets).toHaveLength(5);
      expect(replica.$queryRaw).toHaveBeenCalled();
    });

    it("TUMAN_ADMIN with mismatched tuman throws (cache not populated)", async () => {
      await expect(
        service.getAgeBreakdown("tuman", "UZ-08-012", {
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: "UZ-08-099" },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ── FIX A — scope=mahalla guard on getAgeBreakdown ───────────────────────
  describe("getAgeBreakdown mahalla scope guard (Plan 05-03-fix FIX A)", () => {
    beforeEach(() => {
      replica.$queryRaw.mockResolvedValue([
        { age_group: "15-30", user_count: 100n, avg_ri: 70.0 },
      ]);
    });

    it("VILOYAT_ADMIN at viloyat A requesting mahalla in viloyat B → 403", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-12-001",
        tuman: { viloyatId: "UZ-12" },
      });
      await expect(
        service.getAgeBreakdown("mahalla", "m-otherviloyat", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.$queryRaw).not.toHaveBeenCalled();
    });

    it("TUMAN_ADMIN at tuman A requesting mahalla in tuman B → 403", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-08-099",
        tuman: { viloyatId: "UZ-08" },
      });
      await expect(
        service.getAgeBreakdown("mahalla", "m-othertuman", {
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.$queryRaw).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN can pass any mahalla scope → 200", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-12-001",
        tuman: { viloyatId: "UZ-12" },
      });
      const out = await service.getAgeBreakdown("mahalla", "m-1", {
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      expect(out.buckets.length).toBeGreaterThan(0);
      expect(replica.$queryRaw).toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN with valid scope+id is allowed", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-08-012",
        tuman: { viloyatId: "UZ-08" },
      });
      const out = await service.getAgeBreakdown("mahalla", "m-1", {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      expect(out.buckets.length).toBeGreaterThan(0);
    });

    it("non-existent mahalla → ForbiddenException", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getAgeBreakdown("mahalla", "ghost", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── FIX B — k-anonymity suppression on age buckets ───────────────────────
  describe("getAgeBreakdown k-anonymity (Plan 05-03-fix FIX B)", () => {
    it("bucket count = 1 → suppressed:true, count: 0", async () => {
      replica.$queryRaw.mockResolvedValueOnce([
        { age_group: "7-14", user_count: 1n, avg_ri: 60 },
        { age_group: "15-30", user_count: 100n, avg_ri: 70 },
      ]);
      const out = await service.getAgeBreakdown("national");
      const seven = out.buckets.find((b) => b.ageGroup === "7-14");
      expect(seven?.suppressed).toBe(true);
      expect(seven?.userCount).toBe(0);
      expect(seven?.readingIndex).toBe(0);
      expect(out.buckets.find((b) => b.ageGroup === "15-30")?.suppressed).toBe(false);
      expect(out.anySuppressed).toBe(true);
    });

    it("bucket count = 4 → suppressed:true", async () => {
      replica.$queryRaw.mockResolvedValueOnce([
        { age_group: "60+", user_count: 4n, avg_ri: 58 },
      ]);
      const out = await service.getAgeBreakdown("national");
      const sixty = out.buckets.find((b) => b.ageGroup === "60+");
      expect(sixty?.suppressed).toBe(true);
      expect(sixty?.userCount).toBe(0);
    });

    it("bucket count = 5 → suppressed:false, count: 5 (threshold inclusive)", async () => {
      replica.$queryRaw.mockResolvedValueOnce([
        { age_group: "60+", user_count: 5n, avg_ri: 58 },
      ]);
      const out = await service.getAgeBreakdown("national");
      const sixty = out.buckets.find((b) => b.ageGroup === "60+");
      expect(sixty?.suppressed).toBe(false);
      expect(sixty?.userCount).toBe(5);
    });

    it("bucket count = 10 → suppressed:false", async () => {
      replica.$queryRaw.mockResolvedValueOnce([
        { age_group: "60+", user_count: 10n, avg_ri: 58 },
      ]);
      const out = await service.getAgeBreakdown("national");
      const sixty = out.buckets.find((b) => b.ageGroup === "60+");
      expect(sixty?.suppressed).toBe(false);
      expect(sixty?.userCount).toBe(10);
      expect(out.anySuppressed).toBe(false);
    });
  });

  // ── getGenreTrend ─────────────────────────────────────────────────────────
  describe("getGenreTrend (STAT-06)", () => {
    beforeEach(() => {
      replica.$queryRaw.mockResolvedValue([
        { genre: "Roman", month: "2026-01", cnt: 145n },
        { genre: "Roman", month: "2026-02", cnt: 160n },
        { genre: "Tarix", month: "2026-01", cnt: 80n },
        { genre: "Tarix", month: "2026-02", cnt: 92n },
      ]);
    });

    it("returns array of { genre, monthly: [{month, count}] }", async () => {
      const out = await service.getGenreTrend(12, "national");
      expect(Array.isArray(out)).toBe(true);
      const roman = out.find((g) => g.genre === "Roman");
      expect(roman?.monthly).toEqual([
        { month: "2026-01", count: 145 },
        { month: "2026-02", count: 160 },
      ]);
    });

    it("uses CacheService.keys.genreTrend key + 1h TTL", async () => {
      await service.getGenreTrend(12, "viloyat", "UZ-08");
      expect(cache.remember).toHaveBeenCalledWith(
        CacheService.keys.genreTrend("viloyat", "UZ-08"),
        3600,
        expect.any(Function),
      );
    });

    it("SUPER_ADMIN bypasses scope assert", async () => {
      const out = await service.getGenreTrend(12, "viloyat", "UZ-12", {
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      expect(out.length).toBeGreaterThan(0);
    });
  });

  // ── FIX A — scope=mahalla guard on getGenreTrend ─────────────────────────
  describe("getGenreTrend mahalla scope guard (Plan 05-03-fix FIX A)", () => {
    beforeEach(() => {
      replica.$queryRaw.mockResolvedValue([
        { genre: "Roman", month: "2026-01", cnt: 5n },
      ]);
    });

    it("VILOYAT_ADMIN at viloyat A requesting mahalla in viloyat B → 403", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-12-001",
        tuman: { viloyatId: "UZ-12" },
      });
      await expect(
        service.getGenreTrend(12, "mahalla", "m-otherviloyat", {
          role: UserRole.VILOYAT_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: null },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.$queryRaw).not.toHaveBeenCalled();
    });

    it("TUMAN_ADMIN at tuman A requesting mahalla in tuman B → 403", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-08-099",
        tuman: { viloyatId: "UZ-08" },
      });
      await expect(
        service.getGenreTrend(12, "mahalla", "m-othertuman", {
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(replica.$queryRaw).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN can pass any mahalla scope → 200", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-12-001",
        tuman: { viloyatId: "UZ-12" },
      });
      const out = await service.getGenreTrend(12, "mahalla", "m-1", {
        role: UserRole.SUPER_ADMIN,
        address: null,
      });
      expect(Array.isArray(out)).toBe(true);
    });

    it("VILOYAT_ADMIN with valid scope+id is allowed", async () => {
      replica.mahalla.findUnique.mockResolvedValueOnce({
        tumanId: "UZ-08-012",
        tuman: { viloyatId: "UZ-08" },
      });
      const out = await service.getGenreTrend(12, "mahalla", "m-1", {
        role: UserRole.VILOYAT_ADMIN,
        address: { viloyatId: "UZ-08", tumanId: null },
      });
      expect(Array.isArray(out)).toBe(true);
    });
  });

  // ── markBookForOrder (STAT-07) ────────────────────────────────────────────
  describe("markBookForOrder", () => {
    const SUPER = {
      id: "admin-1",
      role: UserRole.SUPER_ADMIN as UserRole | string,
      libraryId: null as string | null,
    };
    const LIBRARIAN_AT_L1 = {
      id: "lib-1",
      role: UserRole.KUTUBXONACHI as UserRole | string,
      libraryId: "L1",
    };

    beforeEach(() => {
      replica.book.findUnique.mockResolvedValue({
        id: "B1",
        title: "Alpomish",
        libraryId: "L1",
      });
    });

    it("throws BadRequestException on quantity < 1", async () => {
      await expect(
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 0 }, SUPER),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException on quantity > 100", async () => {
      await expect(
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 101 }, SUPER),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when book does not exist", async () => {
      replica.book.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.markBookForOrder({ bookId: "ghost", requestedQuantity: 5 }, SUPER),
      ).rejects.toThrow(NotFoundException);
    });

    it("KUTUBXONACHI from non-matching library throws Forbidden", async () => {
      const otherLibrarian = { ...LIBRARIAN_AT_L1, libraryId: "L2" };
      await expect(
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, otherLibrarian),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("KUTUBXONACHI from matching library is allowed", async () => {
      await service.markBookForOrder(
        { bookId: "B1", requestedQuantity: 5 },
        LIBRARIAN_AT_L1,
      );
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalled();
    });

    it("creates AiAuditLog with ORDER_REQUEST issueType + LIBRARY scope + bookId in recommendation", async () => {
      await service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, SUPER);
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scope: "LIBRARY",
          scopeId: "L1",
          issueType: "ORDER_REQUEST",
          severity: "LOW",
          analysis: expect.stringContaining("Alpomish"),
          recommendation: expect.stringContaining('"bookId":"B1"'),
        }),
      });
      const call = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      const rec = JSON.parse(call.data.recommendation);
      expect(rec).toEqual(
        expect.objectContaining({
          bookId: "B1",
          requestedQuantity: 5,
          requestedBy: "admin-1",
          requestedAt: expect.any(String),
        }),
      );
    });

    it("dedupes within 24h — returns existing row instead of creating new", async () => {
      const existing = {
        id: "audit-old",
        scope: "LIBRARY",
        scopeId: "L1",
        issueType: "ORDER_REQUEST",
        recommendation: JSON.stringify({ bookId: "B1", requestedQuantity: 3 }),
      };
      replica.aiAuditLog.findFirst.mockResolvedValueOnce(existing);

      const out = await service.markBookForOrder(
        { bookId: "B1", requestedQuantity: 5 },
        SUPER,
      );
      expect(out).toEqual(existing);
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    // ── FIX C — RedisLock race protection ─────────────────────────────────
    it("acquires SETNX lock keyed by libraryId+bookId before create", async () => {
      await service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, SUPER);
      expect(lock.tryAcquire).toHaveBeenCalledWith(
        "order-request-lock:L1:B1",
        5,
        "admin-1",
      );
      expect(lock.release).toHaveBeenCalledWith("order-request-lock:L1:B1");
    });

    it("when lock is held by another caller and existing row appears → returns it (no create)", async () => {
      lock.tryAcquire.mockResolvedValueOnce({ first: false });
      const winner = {
        id: "audit-winner",
        scope: "LIBRARY",
        scopeId: "L1",
        issueType: "ORDER_REQUEST",
        recommendation: JSON.stringify({ bookId: "B1" }),
      };
      replica.aiAuditLog.findFirst.mockResolvedValueOnce(winner);

      const out = await service.markBookForOrder(
        { bookId: "B1", requestedQuantity: 5 },
        SUPER,
      );
      expect(out).toEqual(winner);
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
      // lock not acquired → release not called (we never owned it)
      expect(lock.release).not.toHaveBeenCalled();
    });

    it("when lock is held and winner row not yet visible → throws (avoid duplicate insert)", async () => {
      lock.tryAcquire.mockResolvedValueOnce({ first: false });
      replica.aiAuditLog.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, SUPER),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("simulates concurrent calls — only one creates AiAuditLog row", async () => {
      // Two concurrent calls: first acquires lock and creates; second is denied
      // by the lock and sees the (now-committed) row on re-read.
      const created = { id: "audit-new", scope: "LIBRARY", scopeId: "L1" };
      mockPrisma.aiAuditLog.create.mockResolvedValueOnce(created);

      lock.tryAcquire
        .mockResolvedValueOnce({ first: true })
        .mockResolvedValueOnce({ first: false });
      replica.aiAuditLog.findFirst
        .mockResolvedValueOnce(null)   // first call: nothing exists
        .mockResolvedValueOnce(created); // second call: sees the row

      const [a, b] = await Promise.all([
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, SUPER),
        service.markBookForOrder({ bookId: "B1", requestedQuantity: 5 }, SUPER),
      ]);

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledTimes(1);
      expect([a, b]).toContainEqual(created);
    });
  });
});
