import { UnauthorizedException } from "@nestjs/common";
import { PaymeService } from "../payme.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import type { Queue } from "bullmq";

// ── Constants ─────────────────────────────────────────────────────────────────

const SECRET_KEY  = "payme-secret-key";
const TEST_KEY    = "payme-test-key";
const MERCHANT_ID = "payme-merchant-id";

// ── Auth header helpers ───────────────────────────────────────────────────────

function makeAuthHeader(login: string, password: string): string {
  const encoded = Buffer.from(`${login}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

const validProductionAuth = makeAuthHeader("merchant", SECRET_KEY);
const validTestAuth       = makeAuthHeader("Paycom", TEST_KEY);
const invalidAuth         = makeAuthHeader("Paycom", "wrong-key");

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockConfig = {
  get: jest.fn((key: string, fallback = "") => {
    if (key === "PAYME_MERCHANT_ID") return MERCHANT_ID;
    if (key === "PAYME_SECRET_KEY")  return SECRET_KEY;
    if (key === "PAYME_TEST_KEY")    return TEST_KEY;
    return fallback;
  }),
} as unknown as ConfigService;

// Plan 04-02 PAY-03 — mockPrisma includes $transaction whose default
// implementation invokes the callback with the same proxy. Tests override it
// to verify rollback semantics.
const mockPrisma = {
  invoice: {
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  payment: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany:  jest.fn(),
    create:    jest.fn(),
    update:    jest.fn(),
  },
  subscription: {
    update:     jest.fn(),
    // Plan 04-03 PAY-06: assertSubscriptionTransition pre-fetches subscription
    // inside the webhook tx to validate via the SYSTEM whitelist.
    findUnique: jest.fn().mockResolvedValue({
      id: "sub-1",
      status: "PENDING",
      planType: "SCH_BASIC",
    }),
  },
  aiAuditLog: {
    create:    jest.fn(),
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
} as unknown as PrismaService;

// Plan 04-02 PAY-02 — mock RedisLockService with first-call-wins default.
const mockLock: RedisLockService = {
  tryAcquire: jest.fn(async () => ({ first: true })),
  storeResponse: jest.fn(async () => undefined),
  // Plan 04-02 audit-fix FIX C1 — release the lock so transient errors retry.
  release: jest.fn(async () => undefined),
} as unknown as RedisLockService;

// Plan 04-02 PAY-04 — mock BullMQ Queue used for PAYMENT_TIMEOUT_QUEUE.
const mockQueue: Queue = {
  add: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
} as unknown as Queue;

// Plan 04-04 RPT-03 — CacheService for stats-cache invalidation on webhook
// commit. Default delPattern resolves immediately so existing tests pass.
const mockCache: CacheService = {
  delPattern: jest.fn().mockResolvedValue(undefined),
  remember: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
} as unknown as CacheService;

const makeService = () =>
  new PaymeService(mockConfig, mockPrisma, mockLock, mockQueue, mockCache);

// ── RPC request builder ───────────────────────────────────────────────────────

function rpcRequest(method: string, params: Record<string, any> = {}, id: number | string = 1) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PaymeService", () => {
  let service: PaymeService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    // Plan 04-03 audit-fix — restore the default subscription stub so a
    // prior test's override of findUnique doesn't bleed into the next. The
    // PerformTransaction path validates PENDING→ACTIVE via this fetch.
    (mockPrisma.subscription.findUnique as jest.Mock).mockResolvedValue({
      id: "sub-1",
      status: "PENDING",
      planType: "SCH_BASIC",
    });
    // mockLock.tryAcquire was overridden in a few tests; restore default.
    (mockLock.tryAcquire as jest.Mock).mockResolvedValue({ first: true });
    // mockQueue.remove may have been overridden to reject; restore.
    (mockQueue.remove as jest.Mock).mockResolvedValue(undefined);
  });

  // ── Auth tekshiruvi ───────────────────────────────────────────────────────

  describe("handleWebhook() — auth tekshiruvi", () => {
    it("Auth sarlavhasi yo'q bo'lsa UnauthorizedException chiqaradi", async () => {
      await expect(
        service.handleWebhook("", rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("'Basic ' bilan boshlanmasa UnauthorizedException chiqaradi", async () => {
      await expect(
        service.handleWebhook("Bearer token", rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("noto'g'ri parol bilan UnauthorizedException chiqaradi", async () => {
      await expect(
        service.handleWebhook(invalidAuth, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("test kalit (Paycom) bilan autentifikatsiya muvaffaqiyatli o'tadi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      const req = rpcRequest("CheckPerformTransaction", { account: { invoiceId: "inv-1" } });
      // Should NOT throw — just return an error RPC response for missing invoice
      const result = await service.handleWebhook(validTestAuth, req);
      expect(result.jsonrpc).toBe("2.0");
    });

    it("ishlab chiqarish kaliti bilan autentifikatsiya muvaffaqiyatli o'tadi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      const req = rpcRequest("CheckPerformTransaction", { account: { invoiceId: "inv-1" } });
      const result = await service.handleWebhook(validProductionAuth, req);
      expect(result.jsonrpc).toBe("2.0");
    });

    it("noma'lum method bo'lsa -32601 xato qaytaradi", async () => {
      const result = await service.handleWebhook(validTestAuth, rpcRequest("UnknownMethod"));
      expect(result.error?.code).toBe(-32601);
    });
  });

  // ── Auth bypass through empty env keys (Plan 04-01 audit-fix FIX 3) ────────
  // Without the empty-key reject, an unset PAYME_SECRET_KEY meant
  // `password !== expectedKey` succeeded when password was ALSO empty —
  // anyone could POST `Basic <base64("merchant:")>` and the RPC handler would
  // run with prod creds. Tests assert the empty-key branches all 401.
  describe("auth bypass via empty env keys (FIX 3)", () => {
    function makeServiceWith(empty: { secret?: boolean; test?: boolean }) {
      const cfg = {
        get: jest.fn((key: string, fallback = "") => {
          if (key === "PAYME_MERCHANT_ID") return MERCHANT_ID;
          if (key === "PAYME_SECRET_KEY") return empty.secret ? "" : SECRET_KEY;
          if (key === "PAYME_TEST_KEY")   return empty.test ? "" : TEST_KEY;
          return fallback;
        }),
      } as unknown as ConfigService;
      return new PaymeService(cfg, mockPrisma, mockLock, mockQueue, mockCache);
    }

    it("empty PAYME_SECRET_KEY + Basic merchant: (empty password) → 401", async () => {
      const svc = makeServiceWith({ secret: true });
      const header = makeAuthHeader("merchant", "");
      await expect(
        svc.handleWebhook(header, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("empty PAYME_TEST_KEY + Basic Paycom: (empty password) → 401", async () => {
      const svc = makeServiceWith({ test: true });
      const header = makeAuthHeader("Paycom", "");
      await expect(
        svc.handleWebhook(header, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("empty PAYME_SECRET_KEY + non-empty password → 401 (no expected key to match)", async () => {
      const svc = makeServiceWith({ secret: true });
      const header = makeAuthHeader("merchant", "guessed-key");
      await expect(
        svc.handleWebhook(header, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("non-empty key + wrong-length password still 401 (timingSafeEqual length guard)", async () => {
      const svc = makeServiceWith({});
      const header = makeAuthHeader("Paycom", TEST_KEY + "extra");
      await expect(
        svc.handleWebhook(header, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── SEC FIX H2 — sandbox test-key login MUST NOT authenticate in prod ──────
  // Pre-fix, `login === "Paycom"` selected PAYME_TEST_KEY unconditionally, so
  // an attacker holding only the sandbox key could authenticate PRODUCTION
  // webhooks (and perform/cancel real transactions). The branch is now gated
  // on !isProductionEnv(): under NODE_ENV=production the expected key is
  // ALWAYS the production merchant key, regardless of login.
  describe("SEC FIX H2 — prod-mode test-key login rejected", () => {
    const PREV_NODE_ENV = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = PREV_NODE_ENV;
    });

    it("NODE_ENV=production: Paycom + TEST kalit → 401", async () => {
      process.env.NODE_ENV = "production";
      await expect(
        service.handleWebhook(validTestAuth, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("NODE_ENV=Production (katta harf) ham rad etadi — normalizatsiya", async () => {
      process.env.NODE_ENV = "Production";
      await expect(
        service.handleWebhook(validTestAuth, rpcRequest("CheckPerformTransaction")),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("NODE_ENV=production: merchant + PRODUCTION kaliti ishlaydi", async () => {
      process.env.NODE_ENV = "production";
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await service.handleWebhook(
        validProductionAuth,
        rpcRequest("CheckPerformTransaction", { account: { invoiceId: "inv-1" }, amount: 1 }),
      );
      expect(result.jsonrpc).toBe("2.0");
    });

    it("NODE_ENV=production: Paycom logini + PRODUCTION kaliti o'tadi (kalit tekshiriladi, login emas)", async () => {
      process.env.NODE_ENV = "production";
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      const header = makeAuthHeader("Paycom", SECRET_KEY);
      const result = await service.handleWebhook(
        header,
        rpcRequest("CheckPerformTransaction", { account: { invoiceId: "inv-1" }, amount: 1 }),
      );
      expect(result.jsonrpc).toBe("2.0");
    });

    it("non-prod (test) muhitida Paycom + TEST kalit ishlashda davom etadi", async () => {
      // NODE_ENV is jest's default "test" here.
      const result = await service.handleWebhook(validTestAuth, rpcRequest("UnknownMethod"));
      expect(result.error?.code).toBe(-32601);
    });
  });

  // ── CheckPerformTransaction ──────────────────────────────────────────────

  describe("CheckPerformTransaction", () => {
    it("invoice topilmasa -31050 xato qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", { account: { invoiceId: "inv-none" }, amount: 100000 }),
      );

      expect(result.error?.code).toBe(-31050);
      // P2 M9 — rasmiy spec: -3105x xatolar muammoli account maydonini
      // `data` orqali ko'rsatadi.
      expect(result.error?.data).toBe("invoiceId");
    });

    // P2 M9 — "allaqachon to'langan" endi alohida hisob-xato kodi -31051
    // (rasmiy -31050..-31099 diapazoni) bilan ajratiladi.
    it("invoice to'langan bo'lsa -31051 xato qaytaradi (hisob-xato diapazoni)", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", status: "PAID", amount: 1000,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", {
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );

      expect(result.error?.code).toBe(-31051);
      expect(result.error?.data).toBe("invoiceId");
    });

    it("summa noto'g'ri bo'lsa -31001 xato qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", status: "PENDING", amount: 5000,  // 5000 so'm → 500000 tiyin
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", {
          account: { invoiceId: "inv-1" },
          amount: 100,  // very different from 500000
        }),
      );

      expect(result.error?.code).toBe(-31001);
    });

    it("to'g'ri invoice va summa bo'lsa allow:true qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", status: "PENDING", amount: 1000,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", {
          account: { invoiceId: "inv-1" },
          amount: 100000, // 1000 so'm × 100 = 100000 tiyin
        }),
      );

      expect(result.result?.allow).toBe(true);
    });
  });

  // ── CreateTransaction ─────────────────────────────────────────────────────

  describe("CreateTransaction", () => {
    it("mavjud payment bo'lsa qayta yaratmaydi va state:1 qaytaradi", async () => {
      const existingPayment = {
        id: "pay-existing",
        // P2 M9 — idempotent echo faqat hali PENDING (state 1) tranzaksiya
        // uchun; boshqa holatlar -31008 qaytaradi (quyidagi test).
        status: PaymentStatus.PENDING,
        createdAt: new Date("2026-03-01T00:00:00Z"),
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(existingPayment);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id:      "payme-txn-1",
          account: { invoiceId: "inv-1" },
          amount:  100000,
        }),
      );

      expect(result.result?.state).toBe(1);
      expect(result.result?.transaction).toBe("pay-existing");
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("yangi tranzaksiya uchun payment yaratadi va state:1 qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", amount: 1000,
      });
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({
        id:        "pay-new",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id:      "payme-txn-2",
          account: { invoiceId: "inv-1" },
          amount:  100000,
        }),
      );

      expect(mockPrisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceId:     "inv-1",
            method:        PaymentMethod.PAYME,
            status:        PaymentStatus.PENDING,
            transactionId: "payme-txn-2",
          }),
        }),
      );
      expect(result.result?.state).toBe(1);
      expect(result.result?.transaction).toBe("pay-new");
    });

    it("invoice topilmasa -31050 xato qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id:      "payme-txn-3",
          account: { invoiceId: "inv-none" },
          amount:  100000, // FIX D4 — amount required by inline defensive check
        }),
      );

      expect(result.error?.code).toBe(-31050);
      expect(result.error?.data).toBe("invoiceId");
    });

    // ── P2 M9 — rasmiy sertifikatsiya xato kodlari ────────────────────────
    it("M9: CreateTransaction — to'langan invoice uchun -31051 qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", status: "PAID", amount: 1000,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "payme-txn-paid-inv",
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );

      expect(result.error?.code).toBe(-31051);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("M9: CreateTransaction — summa invoice bilan mos kelmasa -31001 (payment yaratilmaydi)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1", status: "PENDING", amount: 5000, // 500000 tiyin kutiladi
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "payme-txn-wrong-amount",
          account: { invoiceId: "inv-1" },
          amount: 100, // mos emas
        }),
      );

      expect(result.error?.code).toBe(-31001);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("M9: mavjud tranzaksiya PENDING bo'lmasa (bekor qilingan) -31008 qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-cancelled",
        status: PaymentStatus.FAILED,
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "payme-txn-dead",
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );

      expect(result.error?.code).toBe(-31008);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    // ── Plan 04-02 audit-fix FIX D4 — inline defensive checks ─────────────
    it("FIX D4: CreateTransaction without params.id returns -32600", async () => {
      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );
      expect(result.error?.code).toBe(-32600);
    });

    it("FIX D4: CreateTransaction with non-finite amount returns -32600", async () => {
      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "txn-x",
          account: { invoiceId: "inv-1" },
          amount: "not-a-number" as unknown as number,
        }),
      );
      expect(result.error?.code).toBe(-32600);
    });

    // P2 M9 — invoiceId yo'qligi RPC-konvert xatosi EMAS, hisob (account)
    // xatosi: -32600 o'rniga rasmiy -31050 diapazoni qaytariladi.
    it("M9: CheckPerformTransaction without account.invoiceId returns -31050 (account-error, NOT -32600)", async () => {
      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", {
          amount: 100000,
        }),
      );
      expect(result.error?.code).toBe(-31050);
      expect(result.error?.data).toBe("invoiceId");
    });

    it("M9: CreateTransaction without account.invoiceId returns -31050 (account-error, NOT -32600)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "txn-no-account",
          amount: 100000,
        }),
      );
      expect(result.error?.code).toBe(-31050);
      expect(result.error?.data).toBe("invoiceId");
    });
  });

  // ── PerformTransaction ────────────────────────────────────────────────────

  describe("PerformTransaction", () => {
    it("payment topilmasa -31003 xato qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-none" }),
      );

      expect(result.error?.code).toBe(-31003);
    });

    it("allaqachon to'langan bo'lsa perform_time va state:2 qaytaradi", async () => {
      const paidAt = new Date("2026-03-05T10:00:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id:        "pay-1",
        status:    PaymentStatus.PAID,
        invoiceId: "inv-1",
        paidAt,
        invoice:   { subscriptionId: "sub-1" },
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(2);
      expect(result.result?.perform_time).toBe(paidAt.getTime());
      // Should NOT update again
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    // Plan 04-02 audit-fix FIX B2 — PerformTransaction must reject terminal
    // states. Pre-fix, FAILED/REFUNDED payments would fall through to the
    // $transaction below and get demoted back to PAID — losing the prior
    // cancel/refund and corrupting downstream Invoice/Subscription state.
    it("FIX B2: PerformTransaction on FAILED payment returns -31008 (no DB writes)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.FAILED,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
        paidAt: null,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-failed" }),
      );

      expect(result.error?.code).toBe(-31008);
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("FIX B2: PerformTransaction on REFUNDED payment returns -31008 (no DB writes)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.REFUNDED,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
        paidAt: null,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-refunded" }),
      );

      expect(result.error?.code).toBe(-31008);
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    it("PENDING payment ni PAID qiladi va subscription ni ACTIVE qiladi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id:        "pay-1",
        status:    PaymentStatus.PENDING,
        invoiceId: "inv-1",
        amount:    1000,
        invoice:   { subscriptionId: "sub-1", amount: 1000 },
      });
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.invoice.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.subscription.update as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(2);
      expect(result.result?.transaction).toBe("pay-1");

      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data:  expect.objectContaining({ status: PaymentStatus.PAID }),
        }),
      );
      expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data:  expect.objectContaining({
            status:        PaymentStatus.PAID,
            paymentMethod: PaymentMethod.PAYME,
          }),
        }),
      );
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-1" },
          data:  { status: "ACTIVE" },
        }),
      );
    });

    // ── P2 M10 — defense-in-depth: perform oldidan summa qayta tasdiqlash ──
    it("M10: payment.amount invoice.amount bilan mos kelmasa -31001, hech qanday DB yozuvsiz", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        amount: 900, // invoice 1000 so'm — Create va Perform orasida buzilgan
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-tampered" }),
      );

      expect(result.error?.code).toBe(-31001);
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("M10: summa noma'lum (NaN) bo'lsa ham -31001 — NaN tekshiruvdan o'tib ketmaydi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // amount yo'q → Number(undefined) = NaN. NaN > 1 har doim false —
        // himoyasiz variant tekshiruvni "o'tkazib yuborardi".
        invoice: { subscriptionId: "sub-1" },
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-nan" }),
      );

      expect(result.error?.code).toBe(-31001);
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
    });
  });

  // ── CancelTransaction ─────────────────────────────────────────────────────

  describe("CancelTransaction", () => {
    it("payment topilmasa -31003 xato qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-none" }),
      );

      expect(result.error?.code).toBe(-31003);
    });

    // P2 M9 — perform'dan OLDIN bekor qilingan to'lov endi FAILED (state -1):
    // hech qachon bajarilmagan to'lovni REFUNDED deb belgilash -1/-2 farqini
    // yo'qotardi. Bekor qilish metama'lumotlari (cancelledAt + cancelReason)
    // qatorga yoziladi.
    it("PENDING to'lovni FAILED qiladi, state:-1 va cancel metama'lumotlarini saqlaydi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
      });
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(-1);
      expect(result.result?.transaction).toBe("pay-1");
      // cancel_time — haqiqiy ms epoch (0 emas)
      expect(typeof result.result?.cancel_time).toBe("number");
      expect(result.result?.cancel_time).toBeGreaterThan(0);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data: expect.objectContaining({
            status: PaymentStatus.FAILED,
            cancelledAt: expect.any(Date),
            cancelReason: null, // so'rovda reason berilmagan
          }),
        }),
      );
    });

    // ── Plan 04-02 audit-fix FIX B3 — full refund propagation + idempotency ──

    it("FIX D (04-03): cancel on PAID payment routes Subscription transition through validator + audit (ACTIVE→PENDING, NOT FROZEN)", async () => {
      // Plan 04-03 audit-fix FIX D — pre-fix the webhook wrote subscription
      // status=FROZEN directly, bypassing assertSubscriptionTransition. The
      // patched flow walks the subscription back to PENDING via the SYSTEM
      // whitelist and writes a HIGH-severity AiAuditLog row so admin can
      // review the refund before deciding on FROZEN/DELETED.
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PAID,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
      });
      // The pre-validate findUnique inside the tx returns an ACTIVE sub
      (mockPrisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        id: "sub-1",
        status: "ACTIVE",
        planType: "SCH_BASIC",
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-paid", reason: 5 }),
      );

      // P2 M9 — perform'dan KEYIN bekor = rasmiy state -2 (-1 emas)
      expect(result.result?.state).toBe(-2);
      // Payment → REFUNDED + cancel metama'lumotlari saqlanadi
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data: expect.objectContaining({
            status: PaymentStatus.REFUNDED,
            cancelledAt: expect.any(Date),
            cancelReason: 5,
          }),
        }),
      );
      // Invoice → REFUNDED (PaymentStatus enum reused for Invoice.status)
      expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-1" },
          data: { status: PaymentStatus.REFUNDED },
        }),
      );
      // Subscription → PENDING (validator-gated, not FROZEN)
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-1" },
          data: { status: "PENDING" },
        }),
      );
      // Subscription audit row written inside the same tx
      const subAuditRow = (mockPrisma.aiAuditLog.create as jest.Mock).mock.calls
        .find((c: any) => c[0].data.scope === "subscription");
      expect(subAuditRow).toBeDefined();
      const analysis = JSON.parse(subAuditRow[0].data.analysis);
      expect(analysis).toMatchObject({
        from: "ACTIVE",
        to: "PENDING",
        by: "WEBHOOK_PAYME",
        actorRole: "SYSTEM",
      });
      // Single $transaction wrapped all writes
      expect((mockPrisma as any).$transaction).toHaveBeenCalledTimes(1);
    });

    it("FIX B3: cancel on PENDING payment touches Payment only (no Invoice/Subscription propagation)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-pending", reason: 1 }),
      );

      // P2 M9 — perform'dan oldin bekor → FAILED (REFUNDED emas), reason saqlanadi
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data: expect.objectContaining({
            status: PaymentStatus.FAILED,
            cancelReason: 1,
          }),
        }),
      );
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("FIX B3: double-cancel (REFUNDED → REFUNDED) is idempotent — echo without DB writes", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.REFUNDED,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
      });
      // Prior cancel audit row carries the original reason
      (mockPrisma.aiAuditLog.findFirst as jest.Mock).mockResolvedValue({
        issueType: "STATE_TRANSITION",
        analysis: JSON.stringify({
          from: "PAID",
          to: "REFUNDED",
          reason: 5,
        }),
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-refunded", reason: 9 }),
      );

      // P2 M9 — REFUNDED = perform'dan keyin bekor qilingan → echo state -2
      expect(result.result?.state).toBe(-2);
      // Echoes the prior reason (5), not the new caller-supplied (9)
      expect(result.result?.reason).toBe(5);
      // No new DB writes
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    // ── P2 M9 — ustun asosidagi idempotent echo (audit-log fallback'siz) ───
    it("M9: FAILED + cancelledAt to'ldirilgan to'lovga takror Cancel — saqlangan cancel_time/reason echo, DB yozuvsiz", async () => {
      const cancelledAt = new Date("2026-04-01T09:30:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.FAILED,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
        cancelledAt,
        cancelReason: 4,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-failed-cancelled", reason: 9 }),
      );

      expect(result.result?.state).toBe(-1); // perform'dan oldin bekor
      expect(result.result?.cancel_time).toBe(cancelledAt.getTime());
      expect(result.result?.reason).toBe(4); // ustundan, yangi 9 emas
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      // Ustun to'ldirilgan — audit-log fallback so'rovi ham kerak emas
      expect(mockPrisma.aiAuditLog.findFirst).not.toHaveBeenCalled();
    });

    it("M9: REFUNDED + cancelledAt ustunlari bilan takror Cancel — state -2 va saqlangan vaqt echo", async () => {
      const cancelledAt = new Date("2026-04-02T12:00:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-2",
        status: PaymentStatus.REFUNDED,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
        cancelledAt,
        cancelReason: 5,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-refunded-cols" }),
      );

      expect(result.result?.state).toBe(-2);
      expect(result.result?.cancel_time).toBe(cancelledAt.getTime());
      expect(result.result?.reason).toBe(5);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });

  // ── CheckTransaction ──────────────────────────────────────────────────────

  describe("CheckTransaction", () => {
    it("payment topilmasa -31003 xato qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-none" }),
      );

      expect(result.error?.code).toBe(-31003);
    });

    it("PENDING payment uchun state:1 qaytaradi", async () => {
      const createdAt = new Date("2026-03-01T00:00:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "PENDING",
        createdAt,
        paidAt: null,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(1);
      expect(result.result?.create_time).toBe(createdAt.getTime());
      expect(result.result?.perform_time).toBe(0);
    });

    it("PAID payment uchun state:2 va perform_time qaytaradi", async () => {
      const createdAt = new Date("2026-03-01T00:00:00Z");
      const paidAt    = new Date("2026-03-02T10:00:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "PAID",
        createdAt,
        paidAt,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(2);
      expect(result.result?.perform_time).toBe(paidAt.getTime());
    });

    // P2 M9 — REFUNDED = perform'dan KEYIN bekor → rasmiy state -2, saqlangan
    // cancel_time/reason qaytariladi, perform_time esa saqlanib qoladi.
    it("REFUNDED payment uchun state:-2, haqiqiy cancel_time/reason va perform_time qaytaradi", async () => {
      const createdAt   = new Date("2026-03-01T00:00:00Z");
      const paidAt      = new Date("2026-03-02T10:00:00Z");
      const cancelledAt = new Date("2026-03-03T15:45:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "REFUNDED",
        createdAt,
        paidAt,
        cancelledAt,
        cancelReason: 5,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(-2);
      expect(result.result?.perform_time).toBe(paidAt.getTime());
      expect(result.result?.cancel_time).toBe(cancelledAt.getTime());
      expect(result.result?.reason).toBe(5);
    });

    // P2 M9 — FAILED = perform'dan OLDIN bekor → state -1; CancelTransaction
    // saqlagan metama'lumotlar (cancel_time ms epoch + reason) round-trip.
    it("FAILED payment uchun state:-1 va saqlangan cancel metama'lumotlarini qaytaradi", async () => {
      const cancelledAt = new Date("2026-03-04T08:00:00Z");
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "FAILED",
        createdAt: new Date("2026-03-01T00:00:00Z"),
        paidAt: null,
        cancelledAt,
        cancelReason: 4,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(-1);
      expect(result.result?.perform_time).toBe(0);
      expect(result.result?.cancel_time).toBe(cancelledAt.getTime());
      expect(result.result?.reason).toBe(4);
    });

    it("FAILED payment (legacy — cancel ustunlari NULL) uchun cancel_time:0, reason:null", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: "FAILED",
        createdAt: new Date(),
        paidAt: null,
        cancelledAt: null,
        cancelReason: null,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckTransaction", { id: "payme-txn-1" }),
      );

      expect(result.result?.state).toBe(-1);
      expect(result.result?.cancel_time).toBe(0);
      expect(result.result?.reason).toBeNull();
    });
  });

  // ── GetStatement ──────────────────────────────────────────────────────────

  describe("GetStatement", () => {
    it("Payme to'lovlarini qaytaradi", async () => {
      const createdAt = new Date("2026-03-01T00:00:00Z");
      const paidAt    = new Date("2026-03-02T10:00:00Z");
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([
        {
          id:            "pay-1",
          transactionId: "payme-txn-1",
          amount:        1000,
          status:        "PAID",
          createdAt,
          paidAt,
          invoiceId:     "inv-1",
          invoice:       { id: "inv-1" },
        },
      ]);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", {
          from: new Date("2026-03-01").getTime(),
          to:   new Date("2026-03-31").getTime(),
        }),
      );

      expect(result.result?.transactions).toHaveLength(1);
      const txn = result.result?.transactions[0];
      expect(txn.id).toBe("payme-txn-1");
      expect(txn.amount).toBe(100000); // 1000 × 100 tiyin
      expect(txn.state).toBe(2); // PAID
      expect(txn.perform_time).toBe(paidAt.getTime());
      expect(txn.account).toEqual({ invoiceId: "inv-1" });
    });

    it("PENDING payment uchun state:1 va perform_time:0 qaytaradi", async () => {
      const createdAt = new Date("2026-03-05T00:00:00Z");
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([
        {
          id:            "pay-2",
          transactionId: "payme-txn-2",
          amount:        500,
          status:        "PENDING",
          createdAt,
          paidAt:        null,
          invoiceId:     "inv-2",
          invoice:       { id: "inv-2" },
        },
      ]);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", {
          from: new Date("2026-03-01").getTime(),
          to:   new Date("2026-03-31").getTime(),
        }),
      );

      const txn = result.result?.transactions[0];
      expect(txn.state).toBe(1);
      expect(txn.perform_time).toBe(0);
    });

    // P2 M9 — GetStatement ham CheckTransaction bilan bir xil holat/vaqt
    // maydonlarini qaytaradi: -1/-2 ajratiladi, cancel_time/reason saqlangan
    // qiymatlardan olinadi (avval hardcode state 1/2, cancel_time 0 edi).
    it("M9: bekor qilingan to'lovlar uchun -1/-2 holatlar va cancel maydonlari qaytariladi", async () => {
      const createdAt   = new Date("2026-03-01T00:00:00Z");
      const paidAt      = new Date("2026-03-02T10:00:00Z");
      const cancelledAt = new Date("2026-03-05T11:00:00Z");
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([
        {
          id: "pay-failed",
          transactionId: "payme-txn-f",
          amount: 700,
          status: "FAILED", // perform'dan oldin bekor
          createdAt,
          paidAt: null,
          cancelledAt,
          cancelReason: 4,
          invoiceId: "inv-f",
          invoice: { id: "inv-f" },
        },
        {
          id: "pay-refunded",
          transactionId: "payme-txn-r",
          amount: 900,
          status: "REFUNDED", // perform'dan keyin bekor
          createdAt,
          paidAt,
          cancelledAt,
          cancelReason: 5,
          invoiceId: "inv-r",
          invoice: { id: "inv-r" },
        },
      ]);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", {
          from: new Date("2026-03-01").getTime(),
          to:   new Date("2026-03-31").getTime(),
        }),
      );

      const [failed, refunded] = result.result?.transactions;
      expect(failed.state).toBe(-1);
      expect(failed.perform_time).toBe(0);
      expect(failed.cancel_time).toBe(cancelledAt.getTime());
      expect(failed.reason).toBe(4);

      expect(refunded.state).toBe(-2);
      expect(refunded.perform_time).toBe(paidAt.getTime());
      expect(refunded.cancel_time).toBe(cancelledAt.getTime());
      expect(refunded.reason).toBe(5);
    });

    it("payment yo'q bo'lsa bo'sh transactions qaytaradi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", {
          from: new Date("2026-02-01").getTime(),
          to:   new Date("2026-02-28").getTime(),
        }),
      );

      expect(result.result?.transactions).toEqual([]);
    });

    it("to'g'ri sana oralig'ida filtrlash ishlaydi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      const fromMs = new Date("2026-03-01").getTime();
      const toMs   = new Date("2026-03-31").getTime();

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", { from: fromMs, to: toMs }),
      );

      expect(mockPrisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            method: PaymentMethod.PAYME,
            createdAt: {
              gte: new Date(fromMs),
              lte: new Date(toMs),
            },
          }),
        }),
      );
    });
  });

  // ── Plan 04-02 PAY-01: Idempotency ────────────────────────────────────────
  describe("idempotency (PAY-01)", () => {
    it("duplicate handleWebhook with same {id, method} returns cached response without re-running handler", async () => {
      const cachedResponse = {
        jsonrpc: "2.0" as const,
        id: 1,
        result: { allow: true },
      };

      // First call: lock acquired (fresh)
      (mockLock.tryAcquire as jest.Mock)
        .mockResolvedValueOnce({ first: true })
        .mockResolvedValueOnce({ first: false, cachedResponse });

      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1",
        status: "PENDING",
        amount: 1000,
      });

      const req = rpcRequest("CheckPerformTransaction", {
        account: { invoiceId: "inv-1" },
        amount: 100000,
      });

      const r1 = await service.handleWebhook(validTestAuth, req);
      expect(r1.result?.allow).toBe(true);
      expect(mockLock.tryAcquire).toHaveBeenCalledWith(
        expect.stringContaining("webhook:payme:"),
        86400,
        expect.any(String),
      );
      expect(mockLock.storeResponse).toHaveBeenCalledTimes(1);

      // Second identical call → cached response replayed, handler NOT invoked
      (mockPrisma.invoice.findUnique as jest.Mock).mockClear();
      const r2 = await service.handleWebhook(validTestAuth, req);
      expect(r2).toEqual(cachedResponse);
      expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
    });

    it("key includes params.id for transaction-scoped methods (CreateTransaction)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1",
        amount: 1000,
      });
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({
        id: "pay-new",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "payme-txn-X",
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );

      expect(mockLock.tryAcquire).toHaveBeenCalledWith(
        "webhook:payme:payme-txn-X:CreateTransaction",
        86400,
        expect.any(String),
      );
    });
  });

  // ── Plan 04-02 PAY-03: Atomic $transaction + AiAuditLog ───────────────────
  describe("atomic $transaction wrapping (PAY-03)", () => {
    it("_performTransaction wraps Payment+Invoice+Subscription+AiAuditLog in single $transaction", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect((mockPrisma as any).$transaction).toHaveBeenCalledTimes(1);
      expect((mockPrisma as any).$transaction).toHaveBeenCalledWith(
        expect.any(Function),
      );

      // AiAuditLog payload: provider, transactionId, from, to
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "payment",
            scopeId: "pay-1",
            issueType: "STATE_TRANSITION",
            severity: "MEDIUM",
            analysis: expect.stringContaining("PAYME"),
          }),
        }),
      );
      const auditCall = (mockPrisma.aiAuditLog.create as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(auditCall.data.analysis);
      expect(parsed).toMatchObject({
        from: "PENDING",
        to: "PAID",
        provider: "PAYME",
        transactionId: "payme-txn-1",
      });
    });

    it("_performTransaction rolls back on Invoice.update failure (rejects transaction)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });
      // First $transaction callback throws inside Invoice update — Prisma
      // rolls back; our mock contract is that $transaction rejects.
      ((mockPrisma as any).$transaction as jest.Mock).mockImplementationOnce(async () => {
        throw new Error("Invoice update failed");
      });

      const res = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );
      // The catch in handleWebhook maps DB errors to -31001 RPC error
      expect(res.error?.code).toBe(-31001);
      expect(res.error?.message).toContain("Invoice update failed");
    });

    it("_cancelTransaction wraps Payment update + AiAuditLog in $transaction", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-1", reason: 1 }),
      );

      expect((mockPrisma as any).$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "payment",
            scopeId: "pay-1",
            issueType: "STATE_TRANSITION",
          }),
        }),
      );
    });
  });

  // ── Plan 04-02 PAY-04: Timeout enqueue + remove + reason=4 ────────────────
  describe("payment timeout queue (PAY-04)", () => {
    it("CreateTransaction success enqueues 12h-delayed cancel job with deterministic jobId", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-1",
        amount: 1000,
      });
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({
        id: "pay-XYZ",
        createdAt: new Date(),
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("CreateTransaction", {
          id: "payme-txn-X",
          account: { invoiceId: "inv-1" },
          amount: 100000,
        }),
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        "cancel-on-timeout",
        expect.objectContaining({ paymentId: "pay-XYZ", provider: "PAYME" }),
        expect.objectContaining({
          jobId: "payment-timeout-pay-XYZ",
          delay: 12 * 60 * 60 * 1000,
        }),
      );
    });

    it("PerformTransaction success removes the timeout job", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect(mockQueue.remove).toHaveBeenCalledWith("payment-timeout-pay-1");
    });

    it("CancelTransaction also removes the timeout job (swallows missing-job)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
      });
      // BullMQ throws on remove() if the job already fired — .catch must swallow.
      (mockQueue.remove as jest.Mock).mockRejectedValueOnce(
        new Error("job not found"),
      );

      const res = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-1" }),
      );

      // Did NOT throw — the remove().catch swallowed.
      expect(res.result?.state).toBe(-1);
      expect(mockQueue.remove).toHaveBeenCalledWith("payment-timeout-pay-1");
    });

    it("CancelTransaction after our TIMEOUT fired returns reason=4 (Payme docs)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.FAILED,  // already FAILED — timeout already fired
      });
      (mockPrisma.aiAuditLog.findFirst as jest.Mock).mockResolvedValue({
        issueType: "TIMEOUT",
      });

      const res = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-1", reason: 1 }),
      );

      expect(res.result?.state).toBe(-1);
      expect(res.result?.reason).toBe(4);
    });

    it("CancelTransaction WITHOUT prior timeout does not set reason=4", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,  // not FAILED — caller-driven cancel
      });

      const res = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-1", reason: 1 }),
      );

      expect(res.result?.state).toBe(-1);
      expect(res.result?.reason).toBeUndefined();
    });
  });

  // ── Xato holati: ichki xato ───────────────────────────────────────────────

  describe("ichki xatolar", () => {
    it("DB xatosi bo'lsa -31001 RPC xato qaytaradi (exception emas)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockRejectedValue(
        new Error("DB connection failed"),
      );

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect(result.error?.code).toBe(-31001);
      expect(result.error?.message).toContain("DB connection failed");
    });
  });

  // ── Plan 04-02 audit-fix Group C — idempotency contract ──────────────────

  describe("FIX C1 — transient -31001 errors are NOT cached", () => {
    it("DB blip on PerformTransaction releases the lock instead of caching", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockRejectedValue(
        new Error("DB connection blip"),
      );

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-1" }),
      );

      expect(result.error?.code).toBe(-31001);
      // NOT cached
      expect(mockLock.storeResponse).not.toHaveBeenCalled();
      // Lock released so the next retry re-acquires + re-runs
      expect(mockLock.release).toHaveBeenCalledWith(
        "webhook:payme:payme-txn-1:PerformTransaction",
      );
    });

    it("deterministic -31050 (invoice not found) IS cached", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("CheckPerformTransaction", {
          account: { invoiceId: "missing" },
          amount: 100000,
        }),
      );

      expect(result.error?.code).toBe(-31050);
      expect(mockLock.storeResponse).toHaveBeenCalledTimes(1);
      expect(mockLock.release).not.toHaveBeenCalled();
    });

    it("successful PerformTransaction IS cached", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-ok" }),
      );

      expect(mockLock.storeResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe("FIX C2 — in-flight race returns -31008 (retry-after)", () => {
    it("tryAcquire returns first:false + no cached response → -31008", async () => {
      (mockLock.tryAcquire as jest.Mock).mockResolvedValueOnce({
        first: false,
        cachedResponse: undefined,
      });

      const result = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-inflight" }),
      );

      expect(result.error?.code).toBe(-31008);
      expect(result.error?.message).toMatch(/temporarily unavailable/i);
      // Handler never ran
      expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("FIX C3 — GetStatement bypasses idempotency cache", () => {
    it("GetStatement does NOT call tryAcquire/storeResponse", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", {
          from: new Date("2026-03-01").getTime(),
          to: new Date("2026-03-31").getTime(),
        }),
      );

      expect(mockLock.tryAcquire).not.toHaveBeenCalled();
      expect(mockLock.storeResponse).not.toHaveBeenCalled();
    });

    it("two GetStatement calls with different windows both execute (not cached)", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", { from: 1, to: 2 }),
      );
      await service.handleWebhook(
        validTestAuth,
        rpcRequest("GetStatement", { from: 100, to: 200 }),
      );

      // Both invocations hit the DB (no cache short-circuit)
      expect(mockPrisma.payment.findMany).toHaveBeenCalledTimes(2);
    });
  });

  // ── Plan 04-04 RPT-03 — Buxgalter stats cache invalidation ──────────────
  describe("RPT-03 cache invalidation on webhook commit", () => {
    beforeEach(() => {
      (mockCache.delPattern as jest.Mock).mockClear();
    });

    it("_performTransaction (success) calls cache.delPattern('stats:buxgalter:*')", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-c1" }),
      );

      expect(mockCache.delPattern).toHaveBeenCalledWith("stats:buxgalter:*");
    });

    it("_cancelTransaction (refund of PAID) calls cache.delPattern", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-2",
        status: PaymentStatus.PAID,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
      });
      // Subscription must be ACTIVE so ACTIVE→PENDING transition validates
      // through the SYSTEM whitelist (Plan 04-03 FIX D refund propagation).
      (mockPrisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        id: "sub-1",
        status: "ACTIVE",
        planType: "SCH_BASIC",
      });
      (mockPrisma.aiAuditLog.findFirst as jest.Mock).mockResolvedValue(null);

      await service.handleWebhook(
        validTestAuth,
        rpcRequest("CancelTransaction", { id: "payme-txn-c2", reason: 5 }),
      );

      expect(mockCache.delPattern).toHaveBeenCalledWith("stats:buxgalter:*");
    });

    it("Redis outage on delPattern does NOT fail the webhook (catch swallowed)", async () => {
      (mockCache.delPattern as jest.Mock).mockRejectedValueOnce(new Error("redis down"));
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-3",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        // P2 M10 — perform oldidan summa qayta tekshiriladi: payment va
        // invoice summalari (so'm) mock'da mos kelishi shart.
        amount: 1000,
        invoice: { subscriptionId: "sub-1", amount: 1000 },
      });

      const res = await service.handleWebhook(
        validTestAuth,
        rpcRequest("PerformTransaction", { id: "payme-txn-c3" }),
      );

      // Webhook still returned the success state (state: 2)
      expect(res.result?.state).toBe(2);
    });
  });
});
