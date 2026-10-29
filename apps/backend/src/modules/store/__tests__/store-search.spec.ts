import { StoreService } from "../store.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { KafkaService } from "../../../infra/kafka/kafka.service";
import { ConfigService } from "@nestjs/config";

// Mock the SearchService import to avoid @elastic/elasticsearch resolution
jest.mock("../../../infra/elasticsearch/elasticsearch.service", () => ({
  SearchService: jest.fn(),
}));

global.fetch = jest.fn();

const STORE_ID = "store-001";
const HMAC_SECRET = "a".repeat(64);

const mockPrisma = {
  user: { findFirst: jest.fn() },
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
    createMany: jest.fn(),
  },
};

const mockCache = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
};

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

const mockSearch = {
  // store.service.ts:864 — `if (!this.search.isEnabled) return fallback()`.
  // Bu bayroqsiz butun ES yo'li Prisma fallback'ga tushib ketardi va
  // quyidagi ES query testlari hech qachon haqiqiy so'rovni ko'rmasdi.
  isEnabled: true,
  indexStoreProduct: jest.fn().mockResolvedValue(undefined),
  removeStoreProduct: jest.fn().mockResolvedValue(undefined),
  searchStoreProducts: jest.fn(),
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

describe("StoreService — searchStoreProducts (SHOP-04, SHOP-07)", () => {
  let service: StoreService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({}) });

    mockPrisma.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      hmacSecret: HMAC_SECRET,
      operatorId: "op-1",
      name: "Bookmart",
      lat: 41.31,
      lon: 69.28,
      premiumBadge: false,
      slug: "bookmart",
    });
  });

  // ── Test 1: basic search returns hits ────────────────────────────────────
  it("search with q='Alpomish' returns hits with title, price, stockCount, storeName", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 2, relation: "eq" },
        hits: [
          {
            _id: "p1",
            _source: {
              storeId: STORE_ID,
              storeName: "Bookmart",
              isbn: "9789943452787",
              title: "Alpomish",
              author: "Xalq dostoni",
              price: 45000,
              stockCount: 10,
              active: true,
              premiumBadge: false,
            },
            _score: 5.2,
            sort: [5.2, 0],
          },
          {
            _id: "p2",
            _source: {
              storeId: "store-002",
              storeName: "Yangi Nashr",
              isbn: "9789943452788",
              title: "Alpomish dostonlari",
              author: "Xalq og'zaki ijodi",
              price: 38000,
              stockCount: 5,
              active: true,
              premiumBadge: true,
            },
            _score: 3.1,
            sort: [3.1, 1],
          },
        ],
      },
    });

    const result = await service.searchStoreProducts({ q: "Alpomish" });

    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      id: "p1",
      title: "Alpomish",
      price: 45000,
      stockCount: 10,
      storeName: "Bookmart",
    });

    // Verify ES was called with correct query structure
    expect(mockSearch.searchStoreProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          bool: expect.objectContaining({
            must: expect.arrayContaining([
              expect.objectContaining({
                multi_match: expect.objectContaining({
                  query: "Alpomish",
                  fuzziness: "AUTO",
                }),
              }),
            ]),
            filter: expect.arrayContaining([{ term: { active: true } }]),
          }),
        }),
      }),
    );
  });

  // ── Test 2: geo_distance sort ────────────────────────────────────────────
  it("search with lat/lon adds _geo_distance sort to ES query", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 1, relation: "eq" },
        hits: [
          {
            _id: "p1",
            _source: {
              storeId: STORE_ID,
              storeName: "Bookmart",
              title: "Alpomish",
              price: 45000,
              stockCount: 10,
              active: true,
              premiumBadge: false,
            },
            _score: 5.0,
            sort: [1.2, 5.0, 0], // distance=1.2km, score=5.0, premiumBadge=0
          },
        ],
      },
    });

    const result = await service.searchStoreProducts({
      q: "Alpomish",
      lat: 41.3,
      lon: 69.3,
    });

    expect(result.data[0].distance).toBe(1.2);

    // Verify _geo_distance sort was included
    const callArgs = mockSearch.searchStoreProducts.mock.calls[0][0];
    expect(callArgs.sort[0]).toEqual({
      _geo_distance: { location: { lat: 41.3, lon: 69.3 }, order: "asc", unit: "km" },
    });
  });

  // ── Test 3: price range filters ──────────────────────────────────────────
  it("search with minPrice/maxPrice adds range filters", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 0, relation: "eq" },
        hits: [],
      },
    });

    await service.searchStoreProducts({
      q: "Kitob",
      minPrice: 10000,
      maxPrice: 50000,
    });

    const callArgs = mockSearch.searchStoreProducts.mock.calls[0][0];
    const filters = callArgs.query.bool.filter;

    expect(filters).toEqual(
      expect.arrayContaining([
        { term: { active: true } },
        { range: { price: { gte: 10000 } } },
        { range: { price: { lte: 50000 } } },
      ]),
    );
  });

  // ── Test 4: inStock filter ───────────────────────────────────────────────
  it("search with inStock=true adds stockCount > 0 filter", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 0, relation: "eq" },
        hits: [],
      },
    });

    await service.searchStoreProducts({ q: "Kitob", inStock: true });

    const callArgs = mockSearch.searchStoreProducts.mock.calls[0][0];
    const filters = callArgs.query.bool.filter;

    expect(filters).toEqual(
      expect.arrayContaining([
        { term: { active: true } },
        { range: { stockCount: { gt: 0 } } },
      ]),
    );
  });

  // ── Test 5: premiumBadge sort boost ──────────────────────────────────────
  it("premiumBadge stores appear before non-premium at same relevance", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 2, relation: "eq" },
        hits: [
          {
            _id: "p-premium",
            _source: {
              storeName: "Premium Store",
              title: "Alpomish",
              price: 50000,
              stockCount: 5,
              active: true,
              premiumBadge: true,
            },
            _score: 4.0,
            sort: [4.0, 1], // score, premiumBadge desc (true=1 sorts first)
          },
          {
            _id: "p-regular",
            _source: {
              storeName: "Regular Store",
              title: "Alpomish",
              price: 45000,
              stockCount: 10,
              active: true,
              premiumBadge: false,
            },
            _score: 4.0,
            sort: [4.0, 0],
          },
        ],
      },
    });

    const result = await service.searchStoreProducts({ q: "Alpomish" });

    // Premium store appears first in results
    expect(result.data[0].premiumBadge).toBe(true);
    expect(result.data[1].premiumBadge).toBe(false);

    // Verify sort includes premiumBadge desc
    const callArgs = mockSearch.searchStoreProducts.mock.calls[0][0];
    expect(callArgs.sort).toEqual(
      expect.arrayContaining([{ premiumBadge: { order: "desc" } }]),
    );
  });

  // ── Test 6: ES failure falls back to Prisma ─────────────────────────────
  it("ES failure falls back to Prisma search (no throw)", async () => {
    mockSearch.searchStoreProducts.mockRejectedValue(new Error("ES connection refused"));

    mockPrisma.storeProduct.findMany.mockResolvedValue([
      {
        id: "p1",
        storeId: STORE_ID,
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epos",
        price: 45000,
        stockCount: 10,
        active: true,
        store: {
          name: "Bookmart",
          slug: "bookmart",
          lat: 41.31,
          lon: 69.28,
          premiumBadge: false,
        },
      },
    ]);
    mockPrisma.storeProduct.count.mockResolvedValue(1);

    const result = await service.searchStoreProducts({ q: "Alpomish" });

    // Should not throw — fallback works
    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: "p1",
      title: "Alpomish",
      storeName: "Bookmart",
      price: 45000,
    });
  });

  // ── Test 7: no query returns match_all ───────────────────────────────────
  it("search without q uses match_all and always filters active:true", async () => {
    mockSearch.searchStoreProducts.mockResolvedValue({
      hits: {
        total: { value: 0, relation: "eq" },
        hits: [],
      },
    });

    await service.searchStoreProducts({});

    const callArgs = mockSearch.searchStoreProducts.mock.calls[0][0];
    expect(callArgs.query.bool.must).toEqual([{ match_all: {} }]);
    expect(callArgs.query.bool.filter).toEqual(
      expect.arrayContaining([{ term: { active: true } }]),
    );
  });
});
