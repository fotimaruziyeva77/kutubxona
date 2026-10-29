import * as crypto from "crypto";
import { ClickService } from "../click.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";
import { PaymentMethod, PaymentStatus } from "@prisma/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MERCHANT_ID = "test-merchant-id";
const SECRET_KEY  = "test-secret-key";

/**
 * Reproduces the private _makeSign logic — Plan 04-01 PAY-02 official formula
 * including service_id (corrected from pre-04-01 broken version).
 */
function makeSign(
  clickTransId: string,
  serviceId: string,
  secretKey: string,
  merchantTransId: string,
  amount: string,
  action: string | number,
  signTime: string,
  merchantPrepareId?: string,
): string {
  const raw = merchantPrepareId
    ? `${clickTransId}${serviceId}${secretKey}${merchantTransId}${merchantPrepareId}${amount}${action}${signTime}`
    : `${clickTransId}${serviceId}${secretKey}${merchantTransId}${amount}${action}${signTime}`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockConfig = {
  get: jest.fn((key: string, fallback = "") => {
    if (key === "CLICK_MERCHANT_ID") return MERCHANT_ID;
    if (key === "CLICK_SECRET_KEY")  return SECRET_KEY;
    return fallback;
  }),
} as unknown as ConfigService;

// Plan 04-02 PAY-03 — mockPrisma includes $transaction whose default
// implementation invokes the callback with a tx client whose methods proxy to
// the same spies. Individual tests can override $transaction (e.g., to assert
// rollback) by reassigning before the call.
const mockPrisma = {
  invoice: {
    findUnique: jest.fn(),
    update:     jest.fn(),
  },
  payment: {
    findFirst: jest.fn(),
    create:    jest.fn(),
    update:    jest.fn(),
  },
  subscription: {
    update:     jest.fn(),
    // Plan 04-03 PAY-06: assertSubscriptionTransition pre-fetches subscription
    // inside the webhook tx to validate via the SYSTEM whitelist. Default
    // shape: PENDING → ACTIVE (the happy webhook path); spec cases that need
    // a different starting status override on the per-test basis.
    findUnique: jest.fn().mockResolvedValue({
      id: "sub-1",
      status: "PENDING",
      planType: "SCH_BASIC",
    }),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(async (cb: any) => {
    // Default: execute the callback synchronously with a tx that delegates to
    // the same spies. Tests that need rollback semantics reassign $transaction.
    return cb(mockPrisma);
  }),
} as unknown as PrismaService;

// Plan 04-02 PAY-02 — mock RedisLockService that returns `first: true` by
// default (no idempotent replay). Tests that need replay semantics override
// the implementation.
const mockLock: RedisLockService = {
  tryAcquire: jest.fn(async () => ({ first: true })),
  storeResponse: jest.fn(async () => undefined),
  // Plan 04-02 audit-fix FIX C1 — transient errors release the lock.
  release: jest.fn(async () => undefined),
} as unknown as RedisLockService;

// Plan 04-04 RPT-03 — CacheService for stats-cache invalidation on webhook
// commit. Default spy resolves immediately so existing tests pass; the
// per-test cache assertions are in the "RPT-03 cache invalidation" describe.
const mockCache: CacheService = {
  delPattern: jest.fn().mockResolvedValue(undefined),
  remember: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
} as unknown as CacheService;

const makeService = () => new ClickService(mockConfig, mockPrisma, mockLock, mockCache);

// ── Test data ─────────────────────────────────────────────────────────────────

// Format current Asia/Tashkent (UTC+5) wall-clock time as Click's expected
// "YYYY-MM-DD HH:MM:SS". Plan 04-02 audit-fix FIX D1 — Click sends this
// field as Tashkent local time, NOT UTC; the helper now matches the wire
// format. FIX 6's 5-minute skew check still requires the value to be fresh
// at call time, so tests recompute per call.
function freshSignTime(offsetMs = 0): string {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const d = new Date(Date.now() + offsetMs + TASHKENT_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

const BASE_PARAMS = {
  click_trans_id:   "ctr-001",
  service_id:       "svc-1",
  merchant_trans_id: "inv-abc",
  amount:           "100000",
  action:           "0",
  error:            0,
  // sign_time injected per-call via freshSignTime() in prepareBody()/completeBody()
  // — see FIX 6 (5-minute skew).
} as const;

function prepareBody(
  overrides: Partial<
    typeof BASE_PARAMS & { sign_string: string; sign_time: string }
  > = {},
) {
  const params = {
    ...BASE_PARAMS,
    sign_time: overrides.sign_time ?? freshSignTime(),
    ...overrides,
  };
  const sign = makeSign(
    params.click_trans_id,
    params.service_id,
    SECRET_KEY,
    params.merchant_trans_id,
    params.amount,
    params.action,
    params.sign_time,
  );
  return { ...params, sign_string: overrides.sign_string ?? sign };
}

function completeBody(
  overrides: Partial<{
    click_trans_id: string;
    service_id: string;
    merchant_trans_id: string;
    amount: string;
    action: string | number;
    error: number;
    sign_time: string;
    sign_string: string;
    merchant_prepare_id: string;
  }> = {},
) {
  const params = {
    ...BASE_PARAMS,
    action: "1" as string | number,
    merchant_prepare_id: "inv-abc",
    sign_time: overrides.sign_time ?? freshSignTime(),
    ...overrides,
  };
  const sign = makeSign(
    params.click_trans_id,
    params.service_id,
    SECRET_KEY,
    params.merchant_trans_id,
    params.amount,
    params.action,
    params.sign_time,
    params.merchant_prepare_id,
  );
  return { ...params, sign_string: overrides.sign_string ?? sign };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ClickService", () => {
  let service: ClickService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
  });

  // ── HMAC formula (official Click spec) ───────────────────────────────────────
  // Plan 04-01 PAY-02: the existing _makeSign OMITS service_id, which is wrong
  // per https://docs.click.uz/en/click-api-request/. Every real callback gets
  // rejected today. RED-first: these tests fail against the current code, then
  // GREEN once the formula is corrected to include service_id.
  describe("HMAC formula - official Click spec (PAY-02)", () => {
    const FIX_SECRET = "testsecret";
    const FIX_CLICK_TRANS_ID = "12345";
    const FIX_SERVICE_ID = "42";
    const FIX_MERCHANT_TRANS_ID = "INV-ABC";
    const FIX_AMOUNT = "3500000";
    // FIX 6 added a 5-minute skew on sign_time; this fixture must be fresh
    // at call time, not a frozen literal.
    const FIX_SIGN_TIME = freshSignTime();
    const FIX_MERCHANT_PREPARE_ID = "999";

    // Local config returning the fixture secret (overrides MERCHANT_ID/SECRET_KEY)
    const fixConfig = {
      get: jest.fn((key: string, fallback = "") => {
        if (key === "CLICK_MERCHANT_ID") return MERCHANT_ID;
        if (key === "CLICK_SECRET_KEY")  return FIX_SECRET;
        return fallback;
      }),
    } as unknown as ConfigService;

    const fixService = new ClickService(fixConfig, mockPrisma, mockLock, mockCache);

    it("Prepare: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)", async () => {
      const expectedRaw =
        FIX_CLICK_TRANS_ID +
        FIX_SERVICE_ID +
        FIX_SECRET +
        FIX_MERCHANT_TRANS_ID +
        FIX_AMOUNT +
        "0" +
        FIX_SIGN_TIME;
      const expected = crypto.createHash("md5").update(expectedRaw).digest("hex");

      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: FIX_MERCHANT_TRANS_ID,
        status: "PENDING",
        amount: 3500000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-new" });

      const body = {
        click_trans_id:   FIX_CLICK_TRANS_ID,
        service_id:       FIX_SERVICE_ID,
        merchant_trans_id: FIX_MERCHANT_TRANS_ID,
        amount:           FIX_AMOUNT,
        action:           "0" as const,
        error:            0,
        sign_time:        FIX_SIGN_TIME,
        sign_string:      expected,
      };

      const result = await fixService.prepare(body);

      // GREEN expectation: signature is accepted (error: 0) when the body sign
      // is derived from the official formula including service_id.
      expect(result.error).toBe(0);
    });

    it("Complete: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)", async () => {
      const expectedRaw =
        FIX_CLICK_TRANS_ID +
        FIX_SERVICE_ID +
        FIX_SECRET +
        FIX_MERCHANT_TRANS_ID +
        FIX_MERCHANT_PREPARE_ID +
        FIX_AMOUNT +
        "1" +
        FIX_SIGN_TIME;
      const expected = crypto.createHash("md5").update(expectedRaw).digest("hex");

      const mockPayment = {
        id: "pay-1",
        invoiceId: FIX_MERCHANT_TRANS_ID,
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.invoice.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.subscription.update as jest.Mock).mockResolvedValue({});

      const body = {
        click_trans_id:      FIX_CLICK_TRANS_ID,
        service_id:          FIX_SERVICE_ID,
        merchant_trans_id:   FIX_MERCHANT_TRANS_ID,
        merchant_prepare_id: FIX_MERCHANT_PREPARE_ID,
        amount:              FIX_AMOUNT,
        action:              "1" as const,
        error:               0,
        sign_time:           FIX_SIGN_TIME,
        sign_string:         expected,
      };

      const result = await fixService.complete(body);

      // GREEN expectation: signature accepted.
      expect(result.error).toBe(0);
      expect(result.merchant_confirm_id).toBe("pay-1");
    });
  });

  // ── Cross-action replay protection (Plan 04-01 audit-fix FIX 1) ─────────────
  // Without action= and merchant_prepare_id checks, an attacker can replay a
  // captured Prepare body against /complete (the sign falls through to Prepare-
  // format concatenation, verifies, and Subscription flips ACTIVE without payment).
  describe("cross-action signature replay rejection (FIX 1)", () => {
    it("complete() with action='0' + missing merchant_prepare_id (Prepare body replay) returns -1 and does NOT activate Subscription", async () => {
      const sign_time = freshSignTime();
      // Forge a sign for the Prepare-format concatenation (no merchant_prepare_id)
      const sign = makeSign(
        BASE_PARAMS.click_trans_id,
        BASE_PARAMS.service_id,
        SECRET_KEY,
        BASE_PARAMS.merchant_trans_id,
        BASE_PARAMS.amount,
        "0",
        sign_time,
      );

      // Cast through unknown to bypass the merchant_prepare_id required typing —
      // a real attacker POSTs JSON; the runtime guard MUST catch it.
      const body = {
        ...BASE_PARAMS,
        action: "0",
        sign_time,
        sign_string: sign,
      } as unknown as Parameters<ClickService["complete"]>[0];

      const result = await service.complete(body);

      expect(result.error).toBe(-1);
      expect(result.error_note).toMatch(/imzo/i);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("complete() with action='1' but missing merchant_prepare_id returns -1", async () => {
      const body = {
        ...BASE_PARAMS,
        action: "1",
        sign_time: freshSignTime(),
        // merchant_prepare_id intentionally absent
        sign_string: "anything",
      } as unknown as Parameters<ClickService["complete"]>[0];

      const result = await service.complete(body);

      expect(result.error).toBe(-1);
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("prepare() with action='1' (Complete-shaped) returns -1", async () => {
      const body = { ...prepareBody(), action: "1" } as unknown as Parameters<
        ClickService["prepare"]
      >[0];
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
    });

    it("prepare() with action='0' + valid sign passes the action guard (positive control)", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 100000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-new" });

      const body = prepareBody();
      const result = await service.prepare(body);
      expect(result.error).toBe(0);
    });
  });

  // ── Plan 04-02 audit-fix FIX D1 — sign_time Asia/Tashkent timezone ──────
  describe("FIX D1 — sign_time parsed as Asia/Tashkent (UTC+5)", () => {
    it("sign_time at current Tashkent wall-clock passes freshness check (positive control)", async () => {
      // freshSignTime() now generates Tashkent wall-clock.
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 100000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-new" });

      const result = await service.prepare(prepareBody());
      expect(result.error).toBe(0);
    });

    it("sign_time that LOOKS like UTC (5h earlier) is rejected as stale", async () => {
      // Build a wall-clock string equal to current UTC, NOT Tashkent. The
      // service interprets it as Tashkent local — so it's actually 5h before
      // "now" and falls outside the 5-minute skew window.
      const utcNow = new Date(Date.now());
      const pad = (n: number) => String(n).padStart(2, "0");
      const utcAsTashkentString =
        `${utcNow.getUTCFullYear()}-${pad(utcNow.getUTCMonth() + 1)}-${pad(utcNow.getUTCDate())} ` +
        `${pad(utcNow.getUTCHours())}:${pad(utcNow.getUTCMinutes())}:${pad(utcNow.getUTCSeconds())}`;

      const body = prepareBody({ sign_time: utcAsTashkentString });
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
    });
  });

  // ── sign_time skew validation (Plan 04-01 audit-fix FIX 6) ─────────────────
  describe("sign_time 5-minute skew validation (FIX 6)", () => {
    it("prepare() with sign_time 1 hour in the past returns -1", async () => {
      const stale = "2026-01-01 12:00:00"; // far in the past
      const body = prepareBody({ sign_time: stale });
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
    });

    it("complete() with sign_time 1 hour in the past returns -1 (no DB writes)", async () => {
      const body = completeBody({ sign_time: "2026-01-01 12:00:00" });
      const result = await service.complete(body);
      expect(result.error).toBe(-1);
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("prepare() with sign_time far in the future returns -1", async () => {
      const future = freshSignTime(60 * 60 * 1000); // +1 hour
      const body = prepareBody({ sign_time: future });
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
    });

    it("prepare() with malformed sign_time returns -1", async () => {
      const body = prepareBody({ sign_time: "not-a-date" });
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
    });
  });

  // ── prepare ──────────────────────────────────────────────────────────────────

  describe("prepare()", () => {
    it("noto'g'ri imzo bo'lsa -1 qaytaradi", async () => {
      const body = prepareBody({ sign_string: "wrong-sign" });
      const result = await service.prepare(body);
      expect(result.error).toBe(-1);
      expect(result.error_note).toMatch(/imzo/i);
    });

    it("invoice topilmasa -5 qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      const body = prepareBody();
      const result = await service.prepare(body);
      expect(result.error).toBe(-5);
    });

    it("invoice allaqachon to'langan bo'lsa -4 qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PAID",
        amount: 100000,
      });
      const body = prepareBody();
      const result = await service.prepare(body);
      expect(result.error).toBe(-4);
    });

    it("summa noto'g'ri bo'lsa -2 qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 999999, // much bigger than 100000 in body
      });
      const body = prepareBody();
      const result = await service.prepare(body);
      expect(result.error).toBe(-2);
    });

    it("payment mavjud bo'lsa yangi payment yaratmaydi va 0 qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 100000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({ id: "pay-existing" });

      const body = prepareBody();
      const result = await service.prepare(body);

      expect(result.error).toBe(0);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    // ── Plan 04-02 PAY-02: idempotency ───────────────────────────────────────
    it("duplicate prepare() with same {click_trans_id, action} returns cached response", async () => {
      const cachedResponse = {
        click_trans_id: "ctr-001",
        merchant_trans_id: "inv-abc",
        merchant_prepare_id: "inv-abc",
        error: 0,
        error_note: "Success",
      };
      (mockLock.tryAcquire as jest.Mock).mockResolvedValueOnce({
        first: false,
        cachedResponse,
      });
      (mockPrisma.invoice.findUnique as jest.Mock).mockClear();

      const body = prepareBody();
      const result = await service.prepare(body);
      expect(result).toEqual(cachedResponse);
      expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
    });

    it("prepare() idempotency key uses action='0' (differentiates from complete)", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 100000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-new" });

      await service.prepare(prepareBody());

      expect(mockLock.tryAcquire).toHaveBeenCalledWith(
        "webhook:click:ctr-001:0",
        86400,
        expect.any(String),
      );
    });

    it("complete() idempotency key uses action='1' (differentiates from prepare)", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      await service.complete(completeBody({ error: 0 }));

      expect(mockLock.tryAcquire).toHaveBeenCalledWith(
        "webhook:click:ctr-001:1",
        86400,
        expect.any(String),
      );
    });

    it("payment mavjud emas bo'lsa yangi payment yaratadi va 0 qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue({
        id: "inv-abc",
        status: "PENDING",
        amount: 100000,
      });
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.payment.create as jest.Mock).mockResolvedValue({ id: "pay-new" });

      const body = prepareBody();
      const result = await service.prepare(body);

      expect(result.error).toBe(0);
      expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            invoiceId:     "inv-abc",
            method:        PaymentMethod.CLICK,
            status:        PaymentStatus.PENDING,
            transactionId: "ctr-001",
          }),
        }),
      );
      expect(result.merchant_prepare_id).toBe("inv-abc");
    });
  });

  // ── complete ─────────────────────────────────────────────────────────────────

  describe("complete()", () => {
    it("noto'g'ri imzo bo'lsa -1 qaytaradi", async () => {
      const body = completeBody({ sign_string: "bad-sign" });
      const result = await service.complete(body);
      expect(result.error).toBe(-1);
    });

    it("payment topilmasa -6 qaytaradi", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      const body = completeBody();
      const result = await service.complete(body);
      expect(result.error).toBe(-6);
    });

    it("foydalanuvchi bekor qilsa (error < 0) payment FAILED bo'ladi va 0 qaytaradi", async () => {
      const mockPayment = {
        id: "pay-1",
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({ ...mockPayment, status: "FAILED" });

      const body = completeBody({ error: -1 });
      const result = await service.complete(body);

      expect(result.error).toBe(0);
      expect(result.error_note).toBe("Cancelled");
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data:  { status: PaymentStatus.FAILED },
        }),
      );
      // Invoice and subscription should NOT be updated on cancel
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it("muvaffaqiyatli to'lovda payment, invoice va subscription yangilanadi", async () => {
      const mockPayment = {
        id: "pay-1",
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.invoice.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.subscription.update as jest.Mock).mockResolvedValue({});

      const body = completeBody({ error: 0 });
      const result = await service.complete(body);

      expect(result.error).toBe(0);
      expect(result.error_note).toBe("Success");
      expect(result.merchant_confirm_id).toBe("pay-1");

      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "pay-1" },
          data:  expect.objectContaining({ status: PaymentStatus.PAID }),
        }),
      );
      expect(mockPrisma.invoice.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "inv-abc" },
          data:  expect.objectContaining({
            status:        PaymentStatus.PAID,
            paymentMethod: PaymentMethod.CLICK,
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

    // ── Plan 04-02 PAY-02: idempotency ───────────────────────────────────────
    it("duplicate complete() with same {click_trans_id, action} returns cached response", async () => {
      const cachedResponse = {
        click_trans_id: "ctr-001",
        merchant_trans_id: "inv-abc",
        merchant_confirm_id: "pay-1",
        error: 0,
        error_note: "Success",
      };
      (mockLock.tryAcquire as jest.Mock).mockResolvedValueOnce({
        first: false,
        cachedResponse,
      });
      // If handler runs, payment.findFirst would be called; assert it isn't.
      (mockPrisma.payment.findFirst as jest.Mock).mockClear();

      const body = completeBody();
      const result = await service.complete(body);
      expect(result).toEqual(cachedResponse);
      expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    });

    // ── Plan 04-02 PAY-03: atomic $transaction + AiAuditLog ──────────────────
    it("complete() wraps Payment+Invoice+Subscription+AiAuditLog in single $transaction", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      await service.complete(completeBody({ error: 0 }));

      expect((mockPrisma as any).$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "payment",
            scopeId: "pay-1",
            issueType: "STATE_TRANSITION",
            severity: "MEDIUM",
            analysis: expect.stringContaining("CLICK"),
          }),
        }),
      );
      const auditCall = (mockPrisma.aiAuditLog.create as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(auditCall.data.analysis);
      expect(parsed).toMatchObject({
        from: "PENDING",
        to: "PAID",
        provider: "CLICK",
        transactionId: "ctr-001",
      });
    });

    it("complete() user-cancel branch also runs inside $transaction with audit log", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      const r = await service.complete(completeBody({ error: -1 }));
      expect(r.error_note).toBe("Cancelled");
      expect((mockPrisma as any).$transaction).toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scopeId: "pay-1",
            analysis: expect.stringContaining("user_cancelled"),
          }),
        }),
      );
    });

    it("complete() rolls back when $transaction rejects (Invoice.update failure)", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      ((mockPrisma as any).$transaction as jest.Mock).mockImplementationOnce(async () => {
        throw new Error("invoice update failed");
      });

      // Plan 04-02 audit-fix FIX C1 — internal errors are mapped to a
      // transient -8 response (not cached) instead of bubbling, so Click
      // retries on its own schedule rather than seeing a 5xx.
      const result = await service.complete(completeBody({ error: 0 }));
      expect(result.error).toBe(-8);
      expect(result.error_note).toMatch(/invoice update failed/);
    });

    it("muvaffaqiyatli to'lovda click_trans_id va merchant_trans_id qaytariladi", async () => {
      const mockPayment = {
        id: "pay-1",
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.invoice.update as jest.Mock).mockResolvedValue({});
      (mockPrisma.subscription.update as jest.Mock).mockResolvedValue({});

      const body = completeBody();
      const result = await service.complete(body);

      expect(result.click_trans_id).toBe("ctr-001");
      expect(result.merchant_trans_id).toBe("inv-abc");
    });

    // ── Plan 04-02 audit-fix FIX C1 — transient errors release the lock ─────

    it("complete() with thrown handler error returns -8 and releases the lock (NOT cached)", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      ((mockPrisma as any).$transaction as jest.Mock).mockImplementationOnce(
        async () => {
          throw new Error("Redis down");
        },
      );

      const result = await service.complete(completeBody({ error: 0 }));

      expect(result.error).toBe(-8);
      // NOT cached
      expect(mockLock.storeResponse).not.toHaveBeenCalled();
      // Lock released
      expect(mockLock.release).toHaveBeenCalledWith(
        "webhook:click:ctr-001:1",
      );
    });

    it("prepare() with thrown handler error returns -8 and releases the lock", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockRejectedValueOnce(
        new Error("DB connection blip"),
      );

      const result = await service.prepare(prepareBody());

      expect(result.error).toBe(-8);
      expect(mockLock.storeResponse).not.toHaveBeenCalled();
      expect(mockLock.release).toHaveBeenCalled();
    });

    it("deterministic success (error: 0) IS cached", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      await service.complete(completeBody({ error: 0 }));

      expect(mockLock.storeResponse).toHaveBeenCalledTimes(1);
      expect(mockLock.release).not.toHaveBeenCalled();
    });

    // ── Plan 04-02 audit-fix FIX C2 — in-flight race returns -9 retry-after ─

    it("complete() with in-flight first:false + no cached response → -9", async () => {
      (mockLock.tryAcquire as jest.Mock).mockResolvedValueOnce({
        first: false,
        cachedResponse: undefined,
      });

      const result = await service.complete(completeBody());

      expect(result.error).toBe(-9);
      expect(result.error_note).toMatch(/temporarily unavailable/i);
      // Handler never ran
      expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it("prepare() with in-flight first:false + no cached response → -9", async () => {
      (mockLock.tryAcquire as jest.Mock).mockResolvedValueOnce({
        first: false,
        cachedResponse: undefined,
      });

      const result = await service.prepare(prepareBody());

      expect(result.error).toBe(-9);
      expect(mockPrisma.invoice.findUnique).not.toHaveBeenCalled();
    });

    // ── Plan 04-02 audit-fix FIX B1 — already-PAID short-circuit ─────────────

    it("complete() on already-PAID payment short-circuits without DB writes", async () => {
      const mockPayment = {
        id: "pay-1",
        status: PaymentStatus.PAID, // already settled
        invoiceId: "inv-abc",
        invoice: { subscriptionId: "sub-1" },
      };
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.complete(completeBody({ error: 0 }));

      expect(result.error).toBe(0);
      expect(result.error_note).toBe("Success");
      expect(result.merchant_confirm_id).toBe("pay-1");
      // No DB mutations
      expect((mockPrisma as any).$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.invoice.update).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });
  });

  // ── Plan 04-04 RPT-03 — Buxgalter stats cache invalidation ──────────────
  describe("RPT-03 cache invalidation on webhook commit", () => {
    beforeEach(() => {
      (mockCache.delPattern as jest.Mock).mockClear();
    });

    it("complete() success calls cache.delPattern('stats:buxgalter:*')", async () => {
      // Configure a valid signed Complete payload
      const signTime = freshSignTime();
      const params: any = {
        click_trans_id: "ctr-cache-1",
        service_id: "svc-1",
        merchant_trans_id: "inv-1",
        merchant_prepare_id: "999",
        amount: "100",
        action: 1,
        error: 0,
        sign_time: signTime,
      };
      params.sign_string = makeSign(
        params.click_trans_id,
        params.service_id,
        SECRET_KEY,
        params.merchant_trans_id,
        params.amount,
        params.action,
        signTime,
        params.merchant_prepare_id,
      );

      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-cache-1",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
      });

      await service.complete(params);

      expect(mockCache.delPattern).toHaveBeenCalledWith("stats:buxgalter:*");
    });

    it("Redis outage on delPattern does NOT fail Click commit", async () => {
      (mockCache.delPattern as jest.Mock).mockRejectedValueOnce(new Error("redis down"));
      const signTime = freshSignTime();
      const params: any = {
        click_trans_id: "ctr-cache-2",
        service_id: "svc-1",
        merchant_trans_id: "inv-1",
        merchant_prepare_id: "999",
        amount: "100",
        action: 1,
        error: 0,
        sign_time: signTime,
      };
      params.sign_string = makeSign(
        params.click_trans_id,
        params.service_id,
        SECRET_KEY,
        params.merchant_trans_id,
        params.amount,
        params.action,
        signTime,
        params.merchant_prepare_id,
      );
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-cache-2",
        status: PaymentStatus.PENDING,
        invoiceId: "inv-1",
        invoice: { subscriptionId: "sub-1" },
      });

      const result = await service.complete(params);
      expect(result.error).toBe(0); // Webhook still succeeded
    });
  });
});
