import { DonateService, ClickDonateWebhookBody } from "../donate.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { BadgeService } from "../../badge/badge.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import * as crypto from "crypto";

const thirtyYearsAgo = new Date(new Date().getFullYear() - 30, 0, 1);
const twelveYearsAgo = new Date(new Date().getFullYear() - 12, 0, 1);

// ── SEC FIX C2: provider secrets used by the verification tests ─────────────
const PAYME_SECRET = "donate-payme-secret-key";
const PAYME_TEST = "donate-payme-test-key";
const CLICK_SECRET = "donate-click-secret-key";
const CLICK_SERVICE_ID = "svc-donate-1";

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    PAYME_SECRET_KEY: PAYME_SECRET,
    PAYME_TEST_KEY: PAYME_TEST,
    CLICK_SECRET_KEY: CLICK_SECRET,
    CLICK_SERVICE_ID: CLICK_SERVICE_ID,
    ...overrides,
  };
  return {
    get: jest.fn((key: string, fallback = "") => values[key] ?? fallback),
  } as unknown as ConfigService;
}

function makeBasicAuth(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

// Click helpers — mirror click.service.spec.ts (official md5 formula + fresh
// Tashkent wall-clock sign_time).
function freshSignTime(offsetMs = 0): string {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const d = new Date(Date.now() + offsetMs + TASHKENT_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function clickMd5(raw: string): string {
  return crypto.createHash("md5").update(raw).digest("hex");
}

/** Builds a correctly-signed Click COMPLETE (action="1") body. */
function makeSignedClickComplete(
  overrides: Partial<ClickDonateWebhookBody> = {},
  secret: string = CLICK_SECRET,
): ClickDonateWebhookBody {
  const base: ClickDonateWebhookBody = {
    click_trans_id: "ctr-100",
    service_id: CLICK_SERVICE_ID,
    merchant_trans_id: "pid-click-1",
    merchant_prepare_id: "prep-1",
    amount: "50000",
    action: "1",
    error: 0,
    sign_time: freshSignTime(),
    ...overrides,
  };
  const sign_string = clickMd5(
    `${base.click_trans_id}${base.service_id}${secret}${base.merchant_trans_id}${base.merchant_prepare_id}${base.amount}${base.action}${base.sign_time}`,
  );
  return { ...base, sign_string };
}

/** Builds a correctly-signed Click PREPARE (action="0") body. */
function makeSignedClickPrepare(
  overrides: Partial<ClickDonateWebhookBody> = {},
  secret: string = CLICK_SECRET,
): ClickDonateWebhookBody {
  const base: ClickDonateWebhookBody = {
    click_trans_id: "ctr-100",
    service_id: CLICK_SERVICE_ID,
    merchant_trans_id: "pid-click-1",
    amount: "50000",
    action: "0",
    error: 0,
    sign_time: freshSignTime(),
    ...overrides,
  };
  const sign_string = clickMd5(
    `${base.click_trans_id}${base.service_id}${secret}${base.merchant_trans_id}${base.amount}${base.action}${base.sign_time}`,
  );
  return { ...base, sign_string };
}

const mockPrisma = {
  donate: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  user: {
    findMany: jest.fn(),
  },
};

const mockBadge = {
  checkAfterDonation: jest.fn().mockResolvedValue(undefined),
};

// Stateful cache mock — implements the remember(key, ttl, fn) cache-or-fetch
// pattern so the idempotency test can prove the inner fn runs at most once
// per paymentId.
function buildCacheMock() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    set: jest.fn(async (key: string, val: unknown) => {
      store.set(key, val);
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    remember: jest.fn(
      async <T>(key: string, _ttlSeconds: number, fn: () => Promise<T>): Promise<T> => {
        if (store.has(key)) return store.get(key) as T;
        const fresh = await fn();
        store.set(key, fresh);
        return fresh;
      },
    ),
  };
}

describe("DonateService", () => {
  let service: DonateService;
  let mockCache: ReturnType<typeof buildCacheMock>;
  const ORIGINAL_ENV = { ...process.env };

  function buildService(config: ConfigService = makeConfig()): DonateService {
    return new DonateService(
      mockPrisma as unknown as PrismaService,
      mockBadge as unknown as BadgeService,
      mockCache as unknown as CacheService,
      config,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCache = buildCacheMock();
    service = buildService();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DEV_DONATION_PAYMENT_STUB;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // ── initiateDonation ─────────────────────────────────────────────────────
  describe("initiateDonation", () => {
    const validData = {
      amount: 50_000,
      purpose: "GENERAL" as const,
      method: PaymentMethod.PAYME,
    };

    it("muvaffaqiyatli donat yaratadi va paymentUrl qaytaradi", async () => {
      const donated = { id: "d1", paymentId: "uuid-1", amount: 50_000, status: "PENDING" };
      mockPrisma.donate.create.mockResolvedValue(donated);

      const result = await service.initiateDonation(validData);

      expect(mockPrisma.donate.create).toHaveBeenCalledTimes(1);
      expect(result.donate).toEqual(donated);
      expect(result.paymentUrl).toContain("checkout.paycom.uz");
    });

    it("Click to'lov URL ni to'g'ri shakllantiradi", async () => {
      mockPrisma.donate.create.mockResolvedValue({ id: "d2", paymentId: "uuid-2" });

      const result = await service.initiateDonation({
        ...validData,
        method: PaymentMethod.CLICK,
      });

      expect(result.paymentUrl).toContain("my.click.uz");
    });

    it("1,000 so'mdan kam bo'lsa BadRequestException tashlaydi", async () => {
      await expect(
        service.initiateDonation({ ...validData, amount: 500 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.initiateDonation({ ...validData, amount: 500 }),
      ).rejects.toThrow("1,000 so'm");
    });

    it("100,000,000 so'mdan ko'p bo'lsa BadRequestException tashlaydi", async () => {
      await expect(
        service.initiateDonation({ ...validData, amount: 200_000_000 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("anonim donat ham yaratiladi (userId yo'q)", async () => {
      mockPrisma.donate.create.mockResolvedValue({ id: "d3" });

      await service.initiateDonation({ ...validData, isPublic: false });

      expect(mockPrisma.donate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: null }),
        }),
      );
    });

    // ── DONAT-01: stub flag wiring ─────────────────────────────────────────
    it("DEV_DONATION_PAYMENT_STUB=true + NODE_ENV=development → /donate/stub/success URL", async () => {
      process.env.DEV_DONATION_PAYMENT_STUB = "true";
      process.env.NODE_ENV = "development";
      mockPrisma.donate.create.mockResolvedValue({ id: "d4", paymentId: "pid-stub-1" });

      const result = await service.initiateDonation(validData);

      expect(result.paymentUrl).toMatch(/^\/donate\/stub\/success\?paymentId=/);
      expect(result.paymentUrl).not.toContain("paycom.uz");
    });

    it("stub flag yo'q → odatdagi buildPaymentUrl ishlaydi", async () => {
      process.env.DEV_DONATION_PAYMENT_STUB = "false";
      process.env.NODE_ENV = "development";
      mockPrisma.donate.create.mockResolvedValue({ id: "d5", paymentId: "pid-real-1" });

      const result = await service.initiateDonation(validData);

      expect(result.paymentUrl).toContain("paycom.uz");
    });

    it("stub flag set + NODE_ENV=production → real URL (D-1 guard, no stub)", async () => {
      // Note: at runtime _assertDonationStubGuard in main.ts throws BEFORE the
      // service ever runs in prod with the flag on. Here we simulate the
      // already-booted state where the flag was somehow set live — the
      // service-level allowlist (isDonationStubActive) refuses production.
      process.env.DEV_DONATION_PAYMENT_STUB = "true";
      process.env.NODE_ENV = "production";
      mockPrisma.donate.create.mockResolvedValue({ id: "d6", paymentId: "pid-prod" });

      const result = await service.initiateDonation(validData);

      expect(result.paymentUrl).not.toContain("/donate/stub/success");
      expect(result.paymentUrl).toContain("paycom.uz");
    });
  });

  // ── handlePaymentWebhook ─────────────────────────────────────────────────
  describe("handlePaymentWebhook", () => {
    it("muvaffaqiyatli to'lovni PAID ga o'tkazadi", async () => {
      const donate = { id: "d1", paymentId: "pid1", userId: "u1", amount: 50_000 };
      mockPrisma.donate.findUnique.mockResolvedValue(donate);
      mockPrisma.donate.update.mockResolvedValue({ ...donate, status: "PAID" });

      const result = await service.handlePaymentWebhook("pid1", true);

      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: PaymentStatus.PAID },
        }),
      );
      expect(result.received).toBe(true);
    });

    it("muvaffaqiyatsiz to'lovni FAILED ga o'tkazadi", async () => {
      mockPrisma.donate.findUnique.mockResolvedValue({ id: "d1", paymentId: "pid1" });
      mockPrisma.donate.update.mockResolvedValue({ status: "FAILED" });

      await service.handlePaymentWebhook("pid1", false);

      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: PaymentStatus.FAILED },
        }),
      );
      expect(mockBadge.checkAfterDonation).not.toHaveBeenCalled();
    });

    it("muvaffaqiyatli to'lovda badge tekshiriladi", async () => {
      mockPrisma.donate.findUnique.mockResolvedValue({ id: "d1", paymentId: "pid1", userId: "u1" });
      mockPrisma.donate.update.mockResolvedValue({});

      await service.handlePaymentWebhook("pid1", true);

      await Promise.resolve();
      expect(mockBadge.checkAfterDonation).toHaveBeenCalledWith("u1");
    });

    it("donat topilmasa NotFoundException tashlaydi", async () => {
      mockPrisma.donate.findUnique.mockResolvedValue(null);

      await expect(service.handlePaymentWebhook("notfound", true)).rejects.toThrow(
        NotFoundException,
      );
    });

    // ── DONAT-01: idempotency ──────────────────────────────────────────────
    it("idempotent — bir xil paymentId ikki marta keladi, faqat birinchisi badge chaqiradi", async () => {
      const donate = { id: "d99", paymentId: "pid-idem", userId: "u99", amount: 10_000 };
      mockPrisma.donate.findUnique.mockResolvedValue(donate);
      mockPrisma.donate.update.mockResolvedValue({});

      // First call: runs the inner fn, hits DB, invokes badge
      await service.handlePaymentWebhook("pid-idem", true);
      // Second call: cache.remember returns the cached value without running fn
      await service.handlePaymentWebhook("pid-idem", true);
      // Allow async badge promise to settle
      await Promise.resolve();
      await Promise.resolve();

      // Database mutation happened exactly once
      expect(mockPrisma.donate.update).toHaveBeenCalledTimes(1);
      // Badge service called exactly once
      expect(mockBadge.checkAfterDonation).toHaveBeenCalledTimes(1);
      // cache.remember invoked twice (once per webhook call)
      expect(mockCache.remember).toHaveBeenCalledTimes(2);
      // Verify the cache key shape
      const firstCallArgs = mockCache.remember.mock.calls[0];
      expect(firstCallArgs[0]).toBe("donate:webhook:pid-idem");
      // TTL 7 days = 7 * 24 * 3600 = 604800
      expect(firstCallArgs[1]).toBe(7 * 24 * 3600);
    });

  });

  // ── SEC FIX C2: Payme donate webhook — REAL Basic-auth verification ───────
  describe("handlePaymeCallback", () => {
    const performBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "PerformTransaction",
      params: { id: "payme-tx-1", account: { payment_id: "pid-payme-1" } },
    };

    beforeEach(() => {
      mockPrisma.donate.findUnique.mockResolvedValue({
        id: "d1",
        paymentId: "pid-payme-1",
        userId: "u1",
        amount: 50_000,
      });
      mockPrisma.donate.update.mockResolvedValue({});
    });

    it("Basic auth YO'Q bo'lsa rad etadi — DB ga tegmaydi", async () => {
      await expect(
        service.handlePaymeCallback(undefined, performBody),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("noto'g'ri kalit bilan rad etadi", async () => {
      await expect(
        service.handlePaymeCallback(makeBasicAuth("merchant", "wrong-key"), performBody),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("'Bearer' sarlavha (Basic emas) rad etiladi", async () => {
      await expect(
        service.handlePaymeCallback("Bearer some-token", performBody),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("to'g'ri merchant kaliti + PerformTransaction → PAID", async () => {
      const result = await service.handlePaymeCallback(
        makeBasicAuth("merchant", PAYME_SECRET),
        performBody,
      );
      expect(result).toEqual({ received: true });
      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.PAID } }),
      );
    });

    it("to'g'ri kalit + CancelTransaction → FAILED", async () => {
      await service.handlePaymeCallback(makeBasicAuth("merchant", PAYME_SECRET), {
        ...performBody,
        method: "CancelTransaction",
      });
      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
      );
    });

    it("CheckPerformTransaction holatga ta'sir qilmaydi (ack, DB yozuvsiz)", async () => {
      const result = await service.handlePaymeCallback(
        makeBasicAuth("merchant", PAYME_SECRET),
        { ...performBody, method: "CheckPerformTransaction" },
      );
      expect(result).toEqual({ received: true });
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
      // Ensures the idempotency cache is NOT poisoned before perform arrives.
      expect(mockCache.remember).not.toHaveBeenCalled();
    });

    it("success endi attacker-controlled emas: result.transaction yuborilsa ham auth siz rad", async () => {
      // Pre-fix the controller derived success from !!body.result?.transaction.
      await expect(
        service.handlePaymeCallback(undefined, {
          id: "pid-payme-1",
          result: { transaction: "pid-payme-1" },
        }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("auth o'tgan, lekin result.transaction PAID bera olmaydi — method talab qilinadi", async () => {
      await expect(
        service.handlePaymeCallback(makeBasicAuth("merchant", PAYME_SECRET), {
          id: "pid-payme-1",
          result: { transaction: "pid-payme-1" },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("PerformTransaction account.payment_id siz → BadRequest (DB yozuvsiz)", async () => {
      await expect(
        service.handlePaymeCallback(makeBasicAuth("merchant", PAYME_SECRET), {
          jsonrpc: "2.0",
          id: 2,
          method: "PerformTransaction",
          params: { id: "payme-tx-2" },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("PAYME_SECRET_KEY bo'sh bo'lsa fail-closed (bo'sh parol ham o'tmaydi)", async () => {
      const svc = buildService(makeConfig({ PAYME_SECRET_KEY: "", PAYME_TEST_KEY: "" }));
      await expect(
        svc.handlePaymeCallback(makeBasicAuth("merchant", ""), performBody),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("test kalit (Paycom) dev/test muhitida ishlaydi", async () => {
      const result = await service.handlePaymeCallback(
        makeBasicAuth("Paycom", PAYME_TEST),
        performBody,
      );
      expect(result).toEqual({ received: true });
    });

    it("SEC FIX H2: NODE_ENV=production da Paycom + TEST kalit rad etiladi", async () => {
      process.env.NODE_ENV = "production";
      await expect(
        service.handlePaymeCallback(makeBasicAuth("Paycom", PAYME_TEST), performBody),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("SEC FIX H2: production da merchant kaliti ishlashda davom etadi", async () => {
      process.env.NODE_ENV = "production";
      const result = await service.handlePaymeCallback(
        makeBasicAuth("merchant", PAYME_SECRET),
        performBody,
      );
      expect(result).toEqual({ received: true });
    });

    // ── DONAT-01 dev-stub path (frontend /donate/stub/success page) ─────────
    it("stub faol: sintetik body auth siz PAID qiladi (dev oqimi saqlanadi)", async () => {
      process.env.DEV_DONATION_PAYMENT_STUB = "true";
      process.env.NODE_ENV = "development";
      mockPrisma.donate.findUnique.mockResolvedValue({
        id: "d-stub",
        paymentId: "pid-stub",
        userId: null,
        amount: 5_000,
      });

      const result = await service.handlePaymeCallback(undefined, {
        id: "pid-stub",
        result: { transaction: "pid-stub" },
      });

      expect(result).toEqual({ received: true });
      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.PAID } }),
      );
    });

    it("stub faol, result.transaction yo'q → FAILED (legacy fallback)", async () => {
      process.env.DEV_DONATION_PAYMENT_STUB = "true";
      process.env.NODE_ENV = "development";
      mockPrisma.donate.findUnique.mockResolvedValue({
        id: "d-stub2",
        paymentId: "pid-stub2",
        userId: null,
        amount: 5_000,
      });

      await service.handlePaymeCallback(undefined, { id: "pid-stub2" });

      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
      );
    });

    it("stub flag=true LEKIN NODE_ENV=production → stub yo'li YOPIQ (auth talab)", async () => {
      process.env.DEV_DONATION_PAYMENT_STUB = "true";
      process.env.NODE_ENV = "production";
      await expect(
        service.handlePaymeCallback(undefined, {
          id: "pid-x",
          result: { transaction: "pid-x" },
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── SEC FIX C2: Click donate webhook — REAL md5 imzo tekshiruvi ───────────
  describe("handleClickCallback", () => {
    beforeEach(() => {
      mockPrisma.donate.findUnique.mockResolvedValue({
        id: "dc1",
        paymentId: "pid-click-1",
        userId: "u1",
        amount: 50_000,
      });
      mockPrisma.donate.update.mockResolvedValue({});
    });

    it("to'g'ri imzolangan complete (error=0) → PAID", async () => {
      const body = makeSignedClickComplete();
      const result = await service.handleClickCallback(body);
      expect(result).toEqual({ received: true });
      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.PAID } }),
      );
    });

    it("to'g'ri imzolangan complete (error=-1) → FAILED, PAID emas", async () => {
      const body = makeSignedClickComplete({ error: -1 });
      await service.handleClickCallback(body);
      expect(mockPrisma.donate.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: PaymentStatus.FAILED } }),
      );
    });

    it("FORGED body: error maydoni YO'Q va imzo soxta → rad (pre-fix bu PAID bo'lardi)", async () => {
      // Pre-fix the controller computed success = !body.error → omitting
      // `error` flipped the donation to PAID with zero verification.
      const forged = {
        click_trans_id: "ctr-evil",
        service_id: CLICK_SERVICE_ID,
        merchant_trans_id: "pid-click-1",
        merchant_prepare_id: "prep-1",
        amount: "50000",
        action: "1",
        sign_time: freshSignTime(),
        sign_string: "deadbeefdeadbeefdeadbeefdeadbeef",
        // error intentionally omitted
      };
      await expect(service.handleClickCallback(forged)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("imzosiz/sign_string yo'q body rad etiladi", async () => {
      const body = makeSignedClickComplete();
      delete body.sign_string;
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("imzolangan, lekin error maydoni yo'q complete → BadRequest (fail closed, DB yozuvsiz)", async () => {
      const body = makeSignedClickComplete();
      delete body.error; // signature stays valid — error is not in the formula
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });

    it("amount o'zgartirilsa imzo mos kelmaydi → rad", async () => {
      const body = makeSignedClickComplete();
      body.amount = "999999"; // tamper after signing
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("eskirgan sign_time (10 daqiqa) rad etiladi", async () => {
      const body = makeSignedClickComplete({ sign_time: freshSignTime(-10 * 60 * 1000) });
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("noto'g'ri service_id rad etiladi (CLICK_SERVICE_ID sozlangan)", async () => {
      const body = makeSignedClickComplete({ service_id: "svc-evil" });
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("complete merchant_prepare_id siz rad etiladi (cross-action replay himoya)", async () => {
      const body = makeSignedClickComplete();
      delete body.merchant_prepare_id;
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("noma'lum action (masalan, '2') rad etiladi", async () => {
      const body = makeSignedClickComplete({ action: "2" });
      await expect(service.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("prepare (action=0) to'g'ri imzo bilan ack qaytaradi, holat o'zgarmaydi", async () => {
      const body = makeSignedClickPrepare();
      const result = await service.handleClickCallback(body);
      expect(result).toEqual({ received: true });
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
      expect(mockCache.remember).not.toHaveBeenCalled();
    });

    it("CLICK_SECRET_KEY bo'sh bo'lsa fail-closed — hatto 'to'g'ri' imzo bilan ham", async () => {
      const svc = buildService(makeConfig({ CLICK_SECRET_KEY: "" }));
      // Attacker knows the secret is empty and signs accordingly.
      const body = makeSignedClickComplete({}, "");
      await expect(svc.handleClickCallback(body)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockPrisma.donate.update).not.toHaveBeenCalled();
    });
  });

  // ── getStats ─────────────────────────────────────────────────────────────
  describe("getStats", () => {
    it("statistika raqamlarini to'g'ri hisoblaydi", async () => {
      mockPrisma.donate.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 125_000_000 } })
        .mockResolvedValueOnce({ _sum: { amount: 98_000_000 } });
      mockPrisma.donate.count.mockResolvedValue(340);

      const result = await service.getStats();

      expect(result.totalCollected).toBe(125_000_000);
      expect(result.totalSpent).toBe(98_000_000);
      expect(result.remaining).toBe(27_000_000);
      expect(result.donorCount).toBe(340);
    });

    it("nol donat bo'lganda ham xato bermaydi", async () => {
      mockPrisma.donate.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } });
      mockPrisma.donate.count.mockResolvedValue(0);

      const result = await service.getStats();

      expect(result.totalCollected).toBe(0);
      expect(result.remaining).toBe(0);
    });
  });

  // ── DONAT-02: getSpendingHistory ────────────────────────────────────────
  describe("getSpendingHistory", () => {
    it("PAID + targetId set donatlarni qaytaradi", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([
        {
          id: "sp1",
          amount: 100_000,
          targetName: "8-maktab kutubxonasi",
          purpose: "LIBRARY_BOOKS",
          createdAt: new Date("2026-05-01"),
        },
      ]);

      const result = await service.getSpendingHistory(5);

      expect(mockPrisma.donate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: PaymentStatus.PAID, targetId: { not: null } },
          take: 5,
        }),
      );
      expect(result[0].id).toBe("sp1");
      expect(result[0].amount).toBe(100_000);
      expect(result[0].libraryName).toBe("8-maktab kutubxonasi");
    });

    it("limit default = 20", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([]);
      await service.getSpendingHistory();
      expect(mockPrisma.donate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });

  // ── DONAT-03: getAdminBreakdown ─────────────────────────────────────────
  describe("getAdminBreakdown", () => {
    it("byTarget va byPurpose breakdown qaytaradi", async () => {
      mockPrisma.donate.groupBy
        .mockResolvedValueOnce([
          {
            targetId: "lib1",
            targetName: "Karmana",
            _sum: { amount: 1_000_000 },
            _count: { id: 5 },
          },
        ])
        .mockResolvedValueOnce([
          {
            purpose: "GENERAL",
            _sum: { amount: 500_000 },
            _count: { id: 3 },
          },
        ]);
      mockPrisma.donate.count.mockResolvedValue(8);

      const result = await service.getAdminBreakdown();

      expect(result.byTarget).toHaveLength(1);
      expect(result.byTarget[0].targetName).toBe("Karmana");
      expect(result.byTarget[0].totalAmount).toBe(1_000_000);
      expect(result.byPurpose).toHaveLength(1);
      expect(result.byPurpose[0].purpose).toBe("GENERAL");
      expect(result.totalDonorCount).toBe(8);
    });
  });

  // ── getPublicDonors ──────────────────────────────────────────────────────
  describe("getPublicDonors", () => {
    it("ommaviy donatchilar ro'yhatini qaytaradi", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([
        {
          amount: 50_000,
          purpose: "GENERAL",
          targetName: "Umumiy maqsad",
          donorName: "Ali Valiyev",
          user: { name: "Ali Valiyev", sifatId: "SL-UZ-01-001-0001-00001", dob: thirtyYearsAgo },
          createdAt: new Date(),
        },
      ]);

      const result = await service.getPublicDonors(10);

      expect(result).toHaveLength(1);
      expect(result[0].donorName).toBe("Ali Valiyev");
      expect(result[0].amount).toBe(50_000);
    });

    it("anonim donat 'Anonim' nomi bilan ko'rinadi", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([
        {
          amount: 10_000,
          purpose: "LIBRARY_BOOKS",
          targetName: "Kutubxona uchun kitob",
          donorName: null,
          user: null,
          createdAt: new Date(),
        },
      ]);

      const result = await service.getPublicDonors();

      expect(result[0].donorName).toBe("Anonim");
    });

    // ── TOP-06: minor anonymization ────────────────────────────────────────
    it("12-yoshli donat qiluvchining ismi A.K. shaklida niqoblanadi", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([
        {
          amount: 5_000,
          purpose: "GENERAL",
          targetName: "Umumiy maqsad",
          donorName: "Ali Karimov",
          user: { name: "Ali Karimov", sifatId: "SL-UZ-01-001-0001-00100", dob: twelveYearsAgo },
          createdAt: new Date(),
        },
      ]);

      const result = await service.getPublicDonors();

      expect(result[0].donorName).toBe("A.K.");
      expect(result[0].donorName).not.toBe("Ali Karimov");
    });

    it("anonim donor donorName parent-typed bo'lsa, maskNameIfMinor ishlamaydi", async () => {
      mockPrisma.donate.findMany.mockResolvedValue([
        {
          amount: 20_000,
          purpose: "GENERAL",
          targetName: "Umumiy maqsad",
          donorName: "Otam ismidan",
          user: null, // userId null — anonymous
          createdAt: new Date(),
        },
      ]);

      const result = await service.getPublicDonors();

      // donorName preserved as-is — no user link means we cannot infer minor
      // status. Per D-TOP-06.
      expect(result[0].donorName).toBe("Otam ismidan");
    });
  });

  // ── getTopDonors ─────────────────────────────────────────────────────────
  describe("getTopDonors", () => {
    it("top donatchilarni jami miqdor bo'yicha tartiblaydi", async () => {
      mockPrisma.donate.groupBy.mockResolvedValue([
        { userId: "u1", donorName: null, _sum: { amount: 5_000_000 } },
        { userId: "u2", donorName: "Baxtiyor", _sum: { amount: 2_000_000 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u1", name: "Alisher Navoiy", sifatId: "SL-UZ-08-001-0001-00001", dob: thirtyYearsAgo },
      ]);

      const result = await service.getTopDonors();

      expect(result[0].rank).toBe(1);
      expect(result[0].totalAmount).toBe(5_000_000);
      expect(result[0].donorName).toBe("Alisher Navoiy");
      expect(result[1].donorName).toBe("Baxtiyor");
    });

    it("TOP-06: 12-yoshli top donor ismi niqoblanadi", async () => {
      mockPrisma.donate.groupBy.mockResolvedValue([
        { userId: "u-minor", donorName: null, _sum: { amount: 3_000_000 } },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-minor", name: "Vali Karimov", sifatId: "SL-UZ-08-001-0001-00200", dob: twelveYearsAgo },
      ]);

      const result = await service.getTopDonors();

      expect(result[0].donorName).toBe("V.K.");
    });
  });
});
