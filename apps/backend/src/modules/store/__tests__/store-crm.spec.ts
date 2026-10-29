import { ForbiddenException } from "@nestjs/common";
import { StoreService } from "../store.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { KafkaService } from "../../../infra/kafka/kafka.service";
import { ConfigService } from "@nestjs/config";

// Mock the SearchService import to avoid @elastic/elasticsearch resolution
jest.mock("../../../infra/elasticsearch/elasticsearch.service", () => ({
  SearchService: jest.fn(),
}));

// fetch global mock
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({}),
});

const STORE_ID = "store-crm-001";
const OPERATOR_ID = "op-crm-1";
const ADMIN_ID = "admin-crm-1";

const mockPrisma = {
  user: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  isbnScan: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  store: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  storeProduct: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    createMany: jest.fn(),
  },
  institution: { create: jest.fn() },
};

const mockCache = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
};

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

const mockSearch = {
  indexStoreProduct: jest.fn().mockResolvedValue(undefined),
  removeStoreProduct: jest.fn().mockResolvedValue(undefined),
};

const mockImportQueue = {
  add: jest.fn().mockResolvedValue({ id: "job-1" }),
  getJob: jest.fn(),
};

const makeService = () =>
  new StoreService(
    mockPrisma as unknown as PrismaService,
    mockCache as unknown as CacheService,
    mockKafka as unknown as KafkaService,
    mockConfig as unknown as ConfigService,
    mockSearch as any,
    mockImportQueue as any,
  );

describe("StoreService — CRM Dashboard (SHOP-05)", () => {
  let service: StoreService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();

    // Default store mock
    mockPrisma.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      operatorId: OPERATOR_ID,
      name: "Test Bookmart",
      hmacSecret: "a".repeat(64),
      slug: "test-bookmart",
      lat: null,
      lon: null,
      premiumBadge: false,
    });

    // Default: batch price lookup returns empty (overridden per-test as needed)
    mockPrisma.storeProduct.findMany.mockResolvedValue([]);
  });

  it("returns CRM data for valid store owner", async () => {
    // 5 unique users, 8 confirmed scans (user1 has 3, user2 has 2, user3/4/5 have 1 each)
    const confirmedScans = [
      { userId: "u1" }, { userId: "u1" }, { userId: "u1" },
      { userId: "u2" }, { userId: "u2" },
      { userId: "u3" },
      { userId: "u4" },
      { userId: "u5" },
    ];
    // First findMany: all confirmed scans
    mockPrisma.isbnScan.findMany
      .mockResolvedValueOnce(confirmedScans) // all confirmed
      .mockResolvedValueOnce([ // new this month
        { userId: "u1" }, { userId: "u5" },
      ])
      .mockResolvedValueOnce([ // confirmed with times (for avg confirmation)
        {
          createdAt: new Date("2026-06-01T10:00:00Z"),
          confirmedAt: new Date("2026-06-01T12:00:00Z"), // 2 hours
        },
        {
          createdAt: new Date("2026-06-02T08:00:00Z"),
          confirmedAt: new Date("2026-06-02T14:00:00Z"), // 6 hours
        },
        {
          createdAt: new Date("2026-06-03T09:00:00Z"),
          confirmedAt: new Date("2026-06-03T10:00:00Z"), // 1 hour
        },
      ]);

    // Call order: _crmMonthlyTrend (24 counts) THEN totalScans, confirmedScans, expiredScans, directCount
    // Monthly trend: 12 months, 2 counts each = 24 calls (total, confirmed per month)
    for (let i = 0; i < 12; i++) {
      mockPrisma.isbnScan.count.mockResolvedValueOnce(5); // total for month
      mockPrisma.isbnScan.count.mockResolvedValueOnce(3); // confirmed for month
    }
    // After monthly trend: main count calls
    mockPrisma.isbnScan.count
      .mockResolvedValueOnce(10) // totalScans
      .mockResolvedValueOnce(8)  // confirmedScansCount
      .mockResolvedValueOnce(2)  // expiredScans
      .mockResolvedValueOnce(10); // directCount (STORE_MANUAL)

    // Top books groupBy
    mockPrisma.isbnScan.groupBy.mockResolvedValue([
      { isbn: "978-001", title: "Kitob A", author: "Muallif A", _count: { id: 5 } },
      { isbn: "978-002", title: "Kitob B", author: "Muallif B", _count: { id: 3 } },
    ]);

    // StoreProduct prices (batch lookup via findMany)
    mockPrisma.storeProduct.findMany.mockResolvedValueOnce([
      { isbn: "978-001", price: 45000 },
      { isbn: "978-002", price: 32000 },
    ]);

    const result = await service.getCrmDashboard(STORE_ID, OPERATOR_ID);

    expect(result.totalCustomers).toBe(5);
    expect(result.newThisMonth).toBe(2); // u1 and u5
    expect(result.returningCustomers).toBe(2); // u1 (3 purchases), u2 (2 purchases)
    expect(result.conversionRate).toBe(80); // 8/10 * 100
    expect(result.topBooks).toHaveLength(2);
    expect(result.topBooks[0].isbn).toBe("978-001");
    expect(result.topBooks[0].price).toBe(45000);
    expect(result.monthlyTrend).toHaveLength(12);
    expect(result.trafficSource.direct).toBe(10);
    expect(result.trafficSource.platformSearch).toBe(0);
  });

  it("throws ForbiddenException for non-owner non-admin", async () => {
    // User is not the owner
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "other-user",
      role: "KITOBXON",
    });

    await expect(
      service.getCrmDashboard(STORE_ID, "other-user"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows SUPER_ADMIN regardless of ownership", async () => {
    // Store has a different operator
    mockPrisma.user.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      role: "SUPER_ADMIN",
    });

    // Mock the CRM data calls (minimal)
    mockPrisma.isbnScan.findMany
      .mockResolvedValueOnce([]) // confirmed scans
      .mockResolvedValueOnce([]) // new this month
      .mockResolvedValueOnce([]); // confirmed with times

    mockPrisma.isbnScan.count.mockResolvedValue(0);
    mockPrisma.isbnScan.groupBy.mockResolvedValue([]);

    const result = await service.getCrmDashboard(STORE_ID, ADMIN_ID);

    expect(result.totalCustomers).toBe(0);
    expect(result.conversionRate).toBe(0);
  });

  it("handles empty store (0 scans)", async () => {
    // No scans at all
    mockPrisma.isbnScan.findMany.mockResolvedValue([]);
    mockPrisma.isbnScan.count.mockResolvedValue(0);
    mockPrisma.isbnScan.groupBy.mockResolvedValue([]);

    const result = await service.getCrmDashboard(STORE_ID, OPERATOR_ID);

    expect(result.totalCustomers).toBe(0);
    expect(result.newThisMonth).toBe(0);
    expect(result.returningCustomers).toBe(0);
    expect(result.conversionRate).toBe(0);
    expect(result.avgConfirmationTimeHours).toBe(0);
    expect(result.expiredScans).toBe(0);
    expect(result.topBooks).toEqual([]);
    expect(result.monthlyTrend).toHaveLength(12);
    // All monthly trend entries should be 0
    for (const entry of result.monthlyTrend) {
      expect(entry.total).toBe(0);
      expect(entry.confirmed).toBe(0);
    }
  });

  it("conversion rate calculation is correct (73%)", async () => {
    mockPrisma.isbnScan.findMany
      .mockResolvedValueOnce([]) // confirmed scans (not used for conversion)
      .mockResolvedValueOnce([]) // new this month
      .mockResolvedValueOnce([]); // confirmed with times

    // Call order: monthly trend first (24 counts), then main counts
    for (let i = 0; i < 24; i++) {
      mockPrisma.isbnScan.count.mockResolvedValueOnce(0);
    }
    // totalScans=100, confirmedScansCount=73
    mockPrisma.isbnScan.count
      .mockResolvedValueOnce(100) // totalScans
      .mockResolvedValueOnce(73)  // confirmedScansCount
      .mockResolvedValueOnce(27)  // expiredScans
      .mockResolvedValueOnce(100); // directCount

    mockPrisma.isbnScan.groupBy.mockResolvedValue([]);

    const result = await service.getCrmDashboard(STORE_ID, OPERATOR_ID);

    expect(result.conversionRate).toBe(73);
  });

  it("average confirmation time calculated from confirmedAt - createdAt", async () => {
    mockPrisma.isbnScan.findMany
      .mockResolvedValueOnce([{ userId: "u1" }]) // confirmed scans
      .mockResolvedValueOnce([{ userId: "u1" }]) // new this month
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-06-01T10:00:00Z"),
          confirmedAt: new Date("2026-06-01T13:00:00Z"), // 3 hours
        },
        {
          createdAt: new Date("2026-06-02T08:00:00Z"),
          confirmedAt: new Date("2026-06-02T14:00:00Z"), // 6 hours
        },
        {
          createdAt: new Date("2026-06-03T12:00:00Z"),
          confirmedAt: new Date("2026-06-03T15:00:00Z"), // 3 hours
        },
      ]); // confirmed with times

    mockPrisma.isbnScan.count.mockResolvedValue(0);
    mockPrisma.isbnScan.groupBy.mockResolvedValue([]);

    const result = await service.getCrmDashboard(STORE_ID, OPERATOR_ID);

    // Average = (3 + 6 + 3) / 3 = 4 hours
    expect(result.avgConfirmationTimeHours).toBe(4);
  });
});
