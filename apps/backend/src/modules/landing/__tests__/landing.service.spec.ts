import { LANDING_REGIONS_CACHE_KEY, LandingService } from "../landing.service";
import { AdminService } from "../../admin/admin.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";

describe("LandingService", () => {
  let service: LandingService;
  let admin: jest.Mocked<Pick<AdminService, "getNationalStats">>;
  let cache: jest.Mocked<Pick<CacheService, "remember">>;

  beforeEach(() => {
    admin = {
      getNationalStats: jest.fn().mockResolvedValue({
        users: { total: 5_000_000, active30d: 1_000_000, newThisMonth: 50_000 },
        libraries: { total: 11_000, byType: { GOV: 1_000, SCH: 6_000 } },
        books: { total: 2_500_000, available: 1_800_000 },
        transactions: {
          thisMonth: 120_000,
          lastMonth: 100_000,
          returned: 80_000,
          growth: 20,
        },
        readingIndex: { national: 67.3 },
      }),
    };
    // remember() forwards the loader so we exercise the projection logic.
    cache = {
      remember: jest.fn().mockImplementation((_key, _ttl, fn: () => Promise<unknown>) => fn()),
    };
    service = new LandingService(
      admin as unknown as AdminService,
      cache as unknown as CacheService,
    );
  });

  it("uses CacheService.keys.landingPublic with the landingPublic TTL", async () => {
    await service.getLandingStats();
    expect(cache.remember).toHaveBeenCalledWith(
      CacheService.keys.landingPublic(),
      CacheService.ttl.landingPublic,
      expect.any(Function),
    );
  });

  it("projects only the whitelisted public-safe fields", async () => {
    const result = await service.getLandingStats();
    expect(result).toEqual({
      libraries: 11_000,
      users: 5_000_000,
      books: 2_500_000,
      transactionsThisMonth: 120_000,
      readingIndex: 67.3,
      lastUpdated: expect.any(String),
    });
    // T-05-08 — explicit whitelist; nothing else may sneak through.
    expect(Object.keys(result).sort()).toEqual([
      "books",
      "lastUpdated",
      "libraries",
      "readingIndex",
      "transactionsThisMonth",
      "users",
    ]);
    // Defense-in-depth: ensure none of the admin-only fields appear.
    expect(JSON.stringify(result)).not.toMatch(/byGender|byType|growth|pendingUsers/);
  });

  it("falls back to 0 when the national stats fields are missing", async () => {
    admin.getNationalStats.mockResolvedValueOnce({} as unknown as Awaited<ReturnType<AdminService["getNationalStats"]>>);
    const result = await service.getLandingStats();
    expect(result.libraries).toBe(0);
    expect(result.users).toBe(0);
    expect(result.books).toBe(0);
    expect(result.transactionsThisMonth).toBe(0);
    expect(result.readingIndex).toBe(0);
  });

  it("emits an ISO 8601 lastUpdated timestamp", async () => {
    const result = await service.getLandingStats();
    expect(() => new Date(result.lastUpdated).toISOString()).not.toThrow();
    expect(result.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── H17 — getLandingRegions ─────────────────────────────────────────────
  describe("getLandingRegions", () => {
    let adminRegions: jest.Mocked<
      Pick<AdminService, "getNationalStats" | "getAllViloyatStats">
    >;
    let replica: { viloyat: { findMany: jest.Mock } };

    const VILOYAT_ROWS = [
      { id: "v-navoiy", name: "Navoiy", slug: "navoiy" },
      { id: "v-toshkent", name: "Toshkent shahar", slug: "toshkent" },
      { id: "v-jizzax", name: "Jizzax", slug: "jizzax" },
      { id: "v-xorazm", name: "Xorazm", slug: "xorazm" },
    ];

    beforeEach(() => {
      adminRegions = {
        getNationalStats: jest.fn(),
        getAllViloyatStats: jest.fn().mockResolvedValue({
          libraries: { "v-navoiy": 12 },
          viloyats: {
            "v-navoiy": { readingIndex: 58.13, userCount: 120 },
            "v-toshkent": { readingIndex: 78.3, userCount: 4_000 },
            // Below K_ANONYMITY_THRESHOLD (5) — must be suppressed.
            "v-jizzax": { readingIndex: 91.0, userCount: 3 },
            // v-xorazm intentionally absent — no RI rows at all.
          },
        }),
      };
      replica = {
        viloyat: { findMany: jest.fn().mockResolvedValue(VILOYAT_ROWS) },
      };
      service = new LandingService(
        adminRegions as unknown as AdminService,
        cache as unknown as CacheService,
        replica as unknown as PrismaReplicaService,
      );
    });

    it("caches under landing:regions with the landingPublic TTL", async () => {
      await service.getLandingRegions();
      expect(cache.remember).toHaveBeenCalledWith(
        LANDING_REGIONS_CACHE_KEY,
        CacheService.ttl.landingPublic,
        expect.any(Function),
      );
    });

    it("joins viloyat slugs with real RI aggregates and ranks by RI desc", async () => {
      const out = await service.getLandingRegions();
      expect(out[0]).toEqual({
        slug: "toshkent",
        name: "Toshkent shahar",
        ri: 78.3,
        rank: 1,
      });
      expect(out[1]).toEqual({
        slug: "navoiy",
        name: "Navoiy",
        ri: 58.1, // 58.13 rounded to 1 decimal
        rank: 2,
      });
    });

    it("suppresses viloyats below the k-anonymity threshold and missing data as null (never fabricated)", async () => {
      const out = await service.getLandingRegions();
      const jizzax = out.find((r) => r.slug === "jizzax");
      const xorazm = out.find((r) => r.slug === "xorazm");
      expect(jizzax).toEqual({
        slug: "jizzax",
        name: "Jizzax",
        ri: null,
        rank: null,
      });
      expect(xorazm).toEqual({
        slug: "xorazm",
        name: "Xorazm",
        ri: null,
        rank: null,
      });
      // Ranked entries first, null-data entries after (alphabetical).
      expect(out.map((r) => r.slug)).toEqual([
        "toshkent",
        "navoiy",
        "jizzax",
        "xorazm",
      ]);
    });

    it("projects ONLY the whitelisted public fields (no userCount leak)", async () => {
      const out = await service.getLandingRegions();
      for (const row of out) {
        expect(Object.keys(row).sort()).toEqual(["name", "rank", "ri", "slug"]);
      }
      expect(JSON.stringify(out)).not.toMatch(/userCount|libraries/);
    });

    it("queries the read replica, never a primary client", async () => {
      await service.getLandingRegions();
      expect(replica.viloyat.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, slug: true },
        orderBy: { code: "asc" },
      });
    });

    it("returns [] when constructed without a replica (legacy 2-arg form)", async () => {
      const legacy = new LandingService(
        adminRegions as unknown as AdminService,
        cache as unknown as CacheService,
      );
      await expect(legacy.getLandingRegions()).resolves.toEqual([]);
    });
  });
});
