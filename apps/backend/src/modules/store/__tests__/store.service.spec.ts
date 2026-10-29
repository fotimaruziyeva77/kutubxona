import * as crypto from "crypto";
import { BadRequestException, UnauthorizedException, NotFoundException, ForbiddenException } from "@nestjs/common";
import { StoreService, PurchasePayload } from "../store.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { KafkaService, KAFKA_TOPICS } from "../../../infra/kafka/kafka.service";
import { ConfigService } from "@nestjs/config";

// Mock the SearchService import to avoid @elastic/elasticsearch resolution
jest.mock("../../../infra/elasticsearch/elasticsearch.service", () => ({
  SearchService: jest.fn(),
}));

// fetch global ni mock qilish
global.fetch = jest.fn();

const STORE_ID  = "store-001";
const HMAC_SECRET = "a".repeat(64); // 32 bytes hex

/** HMAC imzo yaratish (test uchun) — uses the store.hmacSecret from DB */
function makeSignature(body: Omit<PurchasePayload, "signature">, secret = HMAC_SECRET): string {
  const payload = `${body.phone}${body.isbn}${body.order_id}${body.purchase_date}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

const validBody: PurchasePayload = {
  phone:         "+998901234567",
  isbn:          "9789943452787",
  order_id:      "ORD-2026-001",
  purchase_date: "2026-05-01T10:00:00Z",
  store_id:      STORE_ID,
};

const mockPrisma = {
  user:         { findFirst: jest.fn(), findUnique: jest.fn() },
  isbnScan:     {
    findFirst: jest.fn(),
    create:    jest.fn(),
    findMany:  jest.fn(),
    update:    jest.fn(),
    count:     jest.fn(),
    groupBy:   jest.fn(),
  },
  institution:  { create: jest.fn() },
  store:        {
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    findMany:   jest.fn(),
  },
  storeProduct: {
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    findMany:   jest.fn(),
    count:      jest.fn(),
    createMany: jest.fn(),
  },
};

const mockCache = {
  get:      jest.fn().mockResolvedValue(null),
  set:      jest.fn().mockResolvedValue(undefined),
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
};

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

const mockSearch = {
  indexStoreProduct:  jest.fn().mockResolvedValue(undefined),
  removeStoreProduct: jest.fn().mockResolvedValue(undefined),
};

const mockImportQueue = {
  add:    jest.fn().mockResolvedValue({ id: "job-1" }),
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

describe("StoreService", () => {
  let service: StoreService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    // Default: store exists with known HMAC secret
    mockPrisma.store.findUnique.mockResolvedValue({
      id: STORE_ID,
      hmacSecret: HMAC_SECRET,
      operatorId: "op-1",
      name: "Bookmart",
      lat: null,
      lon: null,
      premiumBadge: false,
      slug: "bookmart",
    });
  });

  // ── receivePurchase ────────────────────────────────────────────────────────
  describe("receivePurchase", () => {
    const sig = makeSignature(validBody);

    it("to'g'ri imzo + yangi xarid — accepted qaytaradi, orderId saqlanadi", async () => {
      const user = { id: "u1", name: "Ali", phone: "+998901234567" };
      mockPrisma.user.findFirst.mockResolvedValue(user);
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null);
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-1" });

      const result = await service.receivePurchase(STORE_ID, validBody, sig);

      expect(result.status).toBe("accepted");
      expect(result.scanId).toBe("scan-1");
      // H4: orderId webhook payload dan persist qilinadi
      expect(mockPrisma.isbnScan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orderId: validBody.order_id, storeId: STORE_ID }),
        })
      );
      expect(mockKafka.emit).toHaveBeenCalledWith(
        expect.objectContaining({ topic: KAFKA_TOPICS.ISBN_SCANNED })
      );
    });

    it("foydalanuvchi topilmasa — user_not_found", async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const result = await service.receivePurchase(STORE_ID, validBody, sig);
      expect(result.status).toBe("user_not_found");
      expect(mockKafka.emit).not.toHaveBeenCalled();
    });

    // ── H4: order_id keyed idempotency ──────────────────────────────────────

    it("H4: duplicate (storeId, order_id) — dedup yangi kalit bilan, create chaqirilmaydi", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u1" });
      mockPrisma.isbnScan.findFirst.mockResolvedValue({ id: "existing-scan" });

      const result = await service.receivePurchase(STORE_ID, validBody, sig);
      expect(result.status).toBe("duplicate");
      expect(result.scanId).toBe("existing-scan");
      // Dedup endi (storeId, orderId) bo'yicha — isbn/userId EMAS
      expect(mockPrisma.isbnScan.findFirst).toHaveBeenCalledWith({
        where: { storeId: STORE_ID, orderId: validBody.order_id },
      });
      expect(mockPrisma.isbnScan.create).not.toHaveBeenCalled();
      expect(mockKafka.emit).not.toHaveBeenCalled();
    });

    it("H4: webhook retry — bir xil order_id ikki marta, bitta row + idempotent ack", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u1" });
      // 1-urinish: hali yo'q → create. 2-urinish (retry): mavjud → ack.
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "scan-1" });
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-1" });

      const first = await service.receivePurchase(STORE_ID, validBody, sig);
      const retry = await service.receivePurchase(STORE_ID, validBody, sig);

      expect(first.status).toBe("accepted");
      expect(retry.status).toBe("duplicate"); // idempotent ack, xato emas
      expect(retry.scanId).toBe(first.scanId); // bir xil row
      expect(mockPrisma.isbnScan.create).toHaveBeenCalledTimes(1);
      expect(mockKafka.emit).toHaveBeenCalledTimes(1);
    });

    it("H4: P2002 race — parallel retry yutsa ham idempotent ack, throw yo'q", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u1" });
      // findFirst null deydi, lekin create paytida raqib yozib bo'lgan (race)
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "winner-scan" });
      mockPrisma.isbnScan.create.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed on (storeId, orderId)"), { code: "P2002" })
      );

      const result = await service.receivePurchase(STORE_ID, validBody, sig);

      expect(result.status).toBe("duplicate");
      expect(result.scanId).toBe("winner-scan");
      expect(mockKafka.emit).not.toHaveBeenCalled();
    });

    it("H4: boshqa order_id, bir xil isbn+user — alohida xarid, ikkita row", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u1" });
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null);
      mockPrisma.isbnScan.create
        .mockResolvedValueOnce({ id: "scan-a" })
        .mockResolvedValueOnce({ id: "scan-b" });

      const bodyB: PurchasePayload = { ...validBody, order_id: "ORD-2026-002" };

      const first = await service.receivePurchase(STORE_ID, validBody, makeSignature(validBody));
      const second = await service.receivePurchase(STORE_ID, bodyB, makeSignature(bodyB));

      expect(first.status).toBe("accepted");
      expect(second.status).toBe("accepted");
      expect(first.scanId).not.toBe(second.scanId);
      expect(mockPrisma.isbnScan.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.isbnScan.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orderId: "ORD-2026-002" }),
        })
      );
    });

    it("H4: order_id bo'sh — BadRequestException (idempotency kalitisiz qabul qilinmaydi)", async () => {
      const emptyOrderBody: PurchasePayload = { ...validBody, order_id: "" };
      await expect(
        service.receivePurchase(STORE_ID, emptyOrderBody, makeSignature(emptyOrderBody))
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.isbnScan.create).not.toHaveBeenCalled();
    });

    it("noto'g'ri imzo — UnauthorizedException", async () => {
      await expect(
        service.receivePurchase(STORE_ID, validBody, "wrong-signature")
      ).rejects.toThrow(UnauthorizedException);
    });

    it("Open Library ISBN ma'lumotlarini cache ga saqlaydi", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u1" });
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null);
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-2" });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          "ISBN:9789943452787": {
            title: "Alpomish",
            authors: [{ name: "Xalq dostoni" }],
          },
        }),
      });

      const result = await service.receivePurchase(STORE_ID, validBody, sig);
      expect(result.status).toBe("accepted");
    });
  });

  // ── confirmPurchase ────────────────────────────────────────────────────────
  describe("confirmPurchase", () => {
    it("tasdiqlash muvaffaqiyatli", async () => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue({
        id: "scan-1",
        confirmed: false,
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      });
      mockPrisma.isbnScan.update.mockResolvedValue({ id: "scan-1", confirmed: true });

      const result = await service.confirmPurchase("scan-1", "u1");
      expect(result.confirmed).toBe(true);
      expect(mockPrisma.isbnScan.update).toHaveBeenCalled();
    });

    it("allaqachon tasdiqlangan — ikkinchi update yo'q", async () => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue({
        id: "scan-1",
        confirmed: true,
        createdAt: new Date(),
      });

      const result = await service.confirmPurchase("scan-1", "u1");
      expect(result.confirmed).toBe(true);
      expect(mockPrisma.isbnScan.update).not.toHaveBeenCalled();
    });

    it("topilmasa BadRequestException", async () => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null);
      await expect(service.confirmPurchase("notfound", "u1")).rejects.toThrow(BadRequestException);
    });

    // STORE-01 (Plan 02-04): 24h expiry gate
    it("rejects when scan is older than 24h (24 soat eski)", async () => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue({
        id: "scan-old",
        confirmed: false,
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
      });

      await expect(service.confirmPurchase("scan-old", "u1")).rejects.toThrow(
        /24 soat/
      );
      expect(mockPrisma.isbnScan.update).not.toHaveBeenCalled();
    });

    it("accepts when scan is exactly within 24h window", async () => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue({
        id: "scan-recent",
        confirmed: false,
        createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000), // 23 hours ago
      });
      mockPrisma.isbnScan.update.mockResolvedValue({ id: "scan-recent", confirmed: true });

      const result = await service.confirmPurchase("scan-recent", "u1");
      expect(result.confirmed).toBe(true);
    });
  });

  // ── STORE-02 cascade verification (Plan 02-05 Task 4) ────────────────────
  describe("STORE-02 end-to-end cascade verification", () => {
    const sig = makeSignature(validBody);

    it("scan + confirm flow respects the 24h gate end-to-end", async () => {
      const user = { id: "u1", name: "Ali", phone: "+998901234567" };
      mockPrisma.user.findFirst.mockResolvedValue(user);
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "scan-cascade",
          userId: user.id,
          confirmed: false,
          createdAt: new Date(Date.now() - 60 * 60 * 1000)
        });
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-cascade" });

      const receiveResult = await service.receivePurchase(STORE_ID, validBody, sig);
      expect(receiveResult.status).toBe("accepted");
      expect(receiveResult.scanId).toBe("scan-cascade");

      mockPrisma.isbnScan.update.mockResolvedValue({
        id: "scan-cascade",
        confirmed: true
      });

      const confirmResult = await service.confirmPurchase("scan-cascade", user.id);
      expect(confirmResult.confirmed).toBe(true);
      expect(mockPrisma.isbnScan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "scan-cascade" },
          data: expect.objectContaining({ confirmed: true })
        })
      );
    });

    it("scan + confirm flow rejects stale (>24h) confirmation — cascade halts at gate", async () => {
      const user = { id: "u1", name: "Ali", phone: "+998901234567" };
      mockPrisma.user.findFirst.mockResolvedValue(user);
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "scan-stale",
          userId: user.id,
          confirmed: false,
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
        });
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-stale" });

      await service.receivePurchase(STORE_ID, validBody, sig);

      await expect(service.confirmPurchase("scan-stale", user.id)).rejects.toThrow(
        /24 soat/
      );
      expect(mockPrisma.isbnScan.update).not.toHaveBeenCalled();
    });
  });

  // ── registerStore ──────────────────────────────────────────────────────────
  describe("registerStore", () => {
    it("do'konni ro'yxatdan o'tkazadi va secret qaytaradi", async () => {
      // For slug uniqueness check
      mockPrisma.store.findUnique.mockResolvedValueOnce(null);
      mockPrisma.store.create.mockResolvedValue({
        id: "store-new",
        name: "Bookmart",
        slug: "bookmart",
        hmacSecret: "a".repeat(64),
      });

      const result = await service.registerStore({
        name: "Bookmart",
        phone: "+998901234567",
        address: "Toshkent",
        adminId: "admin-1",
      });

      expect(result.storeId).toBe("store-new");
      expect(result.name).toBe("Bookmart");
      expect(result.slug).toBe("bookmart");
      expect(result.secret).toHaveLength(64);
    });
  });

  // ── getStoreStats ──────────────────────────────────────────────────────────
  describe("getStoreStats", () => {
    it("do'kon statistikasini qaytaradi", async () => {
      mockPrisma.isbnScan.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(25)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(20)
        .mockResolvedValue(0);
      mockPrisma.isbnScan.groupBy.mockResolvedValue([
        { isbn: "9789943452787", title: "Alpomish", author: "Xalq dostoni", _count: { id: 15 } },
      ]);

      const result = await service.getStoreStats(STORE_ID);

      expect(result.total).toBe(100);
      expect(result.confirmed).toBe(80);
      expect(result.confirmRate).toBe(80);
      expect(result.topBooks).toHaveLength(1);
      expect(result.topBooks[0].title).toBe("Alpomish");
    });

    it("jami 0 bo'lganda confirmRate 0 bo'ladi", async () => {
      mockPrisma.isbnScan.count.mockResolvedValue(0);
      mockPrisma.isbnScan.groupBy.mockResolvedValue([]);

      const result = await service.getStoreStats(STORE_ID);
      expect(result.confirmRate).toBe(0);
    });
  });

  // ── getAdminStoreStats ─────────────────────────────────────────────────────
  describe("getAdminStoreStats", () => {
    it("admin uchun umumiy statistika qaytaradi", async () => {
      mockPrisma.isbnScan.count
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(420);
      mockPrisma.isbnScan.groupBy.mockResolvedValue([
        { storeId: "s1", _count: { id: 300 } },
        { storeId: "s2", _count: { id: 200 } },
      ]);

      const result = await service.getAdminStoreStats();

      expect(result.totalPurchases).toBe(500);
      expect(result.confirmed).toBe(420);
      expect(result.confirmRate).toBe(84);
      expect(result.byStore).toHaveLength(2);
    });
  });

  // ── getStorePurchases ──────────────────────────────────────────────────────
  describe("getStorePurchases", () => {
    it("pagination bilan xaridlarni qaytaradi", async () => {
      const items = [{ id: "scan-1", isbn: "9789943452787", user: { name: "Ali" } }];
      mockPrisma.isbnScan.findMany.mockResolvedValue(items);
      mockPrisma.isbnScan.count.mockResolvedValue(1);

      const result = await service.getStorePurchases(STORE_ID, 1, 50);

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(mockPrisma.isbnScan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 50 })
      );
    });

    it("2-sahifada skip=50 bo'ladi", async () => {
      mockPrisma.isbnScan.findMany.mockResolvedValue([]);
      mockPrisma.isbnScan.count.mockResolvedValue(0);

      await service.getStorePurchases(STORE_ID, 2, 50);
      expect(mockPrisma.isbnScan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50 })
      );
    });
  });

  // ── Phase 8 Plan 08-01: Product CRUD ──────────────────────────────────────

  describe("createProduct", () => {
    it("mahsulot yaratadi va ES ga indekslaydi", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        operatorId: "op-1",
        name: "Bookmart",
        lat: 41.31,
        lon: 69.28,
        premiumBadge: false,
      });
      mockPrisma.storeProduct.create.mockResolvedValue({
        id: "prod-1",
        storeId: STORE_ID,
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epos",
        price: 45000,
        stockCount: 10,
        active: true,
        createdAt: new Date(),
      });

      const result = await service.createProduct(STORE_ID, "op-1", {
        isbn: "9789943452787",
        title: "Alpomish",
        author: "Xalq dostoni",
        genre: "Epos",
        price: 45000,
        stockCount: 10,
      });

      expect(result.id).toBe("prod-1");
      expect(mockSearch.indexStoreProduct).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          isbn: "9789943452787",
          premiumBadge: false,
        })
      );
    });

    it("boshqa operator ruxsat yo'q — ForbiddenException", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        operatorId: "op-1",
      });

      await expect(
        service.createProduct(STORE_ID, "wrong-op", {
          isbn: "9789943452787",
          title: "Test",
          author: "Test",
          price: 1000,
          stockCount: 1,
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it("manfiy narx — BadRequestException", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        operatorId: "op-1",
      });

      await expect(
        service.createProduct(STORE_ID, "op-1", {
          isbn: "9789943452787",
          title: "Test",
          author: "Test",
          price: -100,
          stockCount: 1,
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("deleteProduct", () => {
    it("soft delete: active=false, ES dan o'chiriladi", async () => {
      mockPrisma.storeProduct.findUnique.mockResolvedValue({
        id: "prod-1",
        storeId: STORE_ID,
        store: { operatorId: "op-1" },
      });
      mockPrisma.storeProduct.update.mockResolvedValue({ id: "prod-1", active: false });

      const result = await service.deleteProduct("prod-1", "op-1");

      expect(result.message).toContain("o'chirildi");
      expect(mockPrisma.storeProduct.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prod-1" },
          data: { active: false },
        })
      );
      expect(mockSearch.removeStoreProduct).toHaveBeenCalledWith("prod-1");
    });

    it("boshqa operator ruxsat yo'q — ForbiddenException", async () => {
      mockPrisma.storeProduct.findUnique.mockResolvedValue({
        id: "prod-1",
        store: { operatorId: "op-1" },
      });

      await expect(service.deleteProduct("prod-1", "wrong-op")).rejects.toThrow(ForbiddenException);
    });
  });

  describe("getStoreBySlug", () => {
    it("slug bo'yicha do'konni qaytaradi", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        slug: "bookmart",
        name: "Bookmart",
        products: [{ id: "p1", title: "Alpomish", active: true }],
      });
      mockPrisma.storeProduct.count.mockResolvedValue(15);

      const result = await service.getStoreBySlug("bookmart");

      expect(result.slug).toBe("bookmart");
      expect(result.productCount).toBe(15);
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.store.findUnique.mockResolvedValue(null);
      await expect(service.getStoreBySlug("notexist")).rejects.toThrow(NotFoundException);
    });
  });

  describe("setPremiumBadge", () => {
    it("premium badge beradi va barcha mahsulotlarni reindex qiladi", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        premiumBadge: false,
        name: "Bookmart",
        lat: null,
        lon: null,
      });
      mockPrisma.store.update.mockResolvedValue({
        id: STORE_ID,
        premiumBadge: true,
        premiumSince: new Date(),
        name: "Bookmart",
        lat: null,
        lon: null,
      });
      mockPrisma.storeProduct.findMany.mockResolvedValue([
        { id: "p1", isbn: "123", title: "A", author: "B", genre: "G", price: 1000, stockCount: 5, active: true, createdAt: new Date() },
      ]);

      const result = await service.setPremiumBadge(STORE_ID, true);

      expect(result.premiumBadge).toBe(true);
      expect(mockSearch.indexStoreProduct).toHaveBeenCalledWith(
        expect.objectContaining({ premiumBadge: true })
      );
    });

    it("do'kon topilmasa NotFoundException", async () => {
      mockPrisma.store.findUnique.mockResolvedValue(null);
      await expect(service.setPremiumBadge("nope", true)).rejects.toThrow(NotFoundException);
    });
  });

  describe("importProductsFromExcel", () => {
    it("import jobni queue ga qo'shadi", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        operatorId: "op-1",
      });

      const result = await service.importProductsFromExcel(STORE_ID, "op-1", "base64data");

      expect(result.jobId).toBe("job-1");
      expect(result.status).toBe("queued");
      expect(mockImportQueue.add).toHaveBeenCalledWith(
        "store-product-import",
        expect.objectContaining({ storeId: STORE_ID, fileBase64: "base64data" }),
        expect.any(Object),
      );
    });

    it("boshqa operator ruxsat yo'q — ForbiddenException", async () => {
      mockPrisma.store.findUnique.mockResolvedValue({
        id: STORE_ID,
        operatorId: "op-1",
      });

      await expect(
        service.importProductsFromExcel(STORE_ID, "wrong-op", "base64data")
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
