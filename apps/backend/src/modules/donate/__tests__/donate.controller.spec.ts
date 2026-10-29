import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { PaymentMethod } from "@prisma/client";
import { DonateController } from "../donate.controller";
import { DonateService } from "../donate.service";
import { IpWhitelistGuard } from "../../../common/guards/ip-whitelist.guard";

describe("DonateController", () => {
  let controller: DonateController;
  let svc: jest.Mocked<
    Pick<
      DonateService,
      | "handlePaymeCallback"
      | "handleClickCallback"
      | "initiateDonation"
      | "getAdminBreakdown"
      | "getSpendingHistory"
    >
  >;
  let jwt: { verify: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(() => {
    svc = {
      handlePaymeCallback: jest.fn().mockResolvedValue({ received: true }),
      handleClickCallback: jest.fn().mockResolvedValue({ received: true }),
      initiateDonation: jest
        .fn()
        .mockResolvedValue({ donate: { id: "d1" }, paymentUrl: "url" }),
      getAdminBreakdown: jest
        .fn()
        .mockResolvedValue({ byTarget: [], byPurpose: [], totalDonorCount: 0 }),
      getSpendingHistory: jest.fn().mockResolvedValue([]),
    };
    jwt = { verify: jest.fn() };
    config = { get: jest.fn().mockReturnValue("test-jwt-secret") };
    controller = new DonateController(
      svc as unknown as DonateService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
    );
  });

  describe("webhook routing (SEC FIX C2 — verified service entry points)", () => {
    it("paymeWebhook forwards authHeader + raw body to handlePaymeCallback", async () => {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "PerformTransaction",
        params: { account: { payment_id: "pid-1" } },
      };
      await controller.paymeWebhook(body, "Basic abc");
      expect(svc.handlePaymeCallback).toHaveBeenCalledWith("Basic abc", body);
    });

    it("paymeWebhook auth sarlavhasiz ham service ga yetkazadi (service rad etadi)", async () => {
      svc.handlePaymeCallback.mockRejectedValue(
        new UnauthorizedException("Noto'g'ri Payme kalit"),
      );
      await expect(
        controller.paymeWebhook({ id: "x" }, undefined),
      ).rejects.toThrow(UnauthorizedException);
      expect(svc.handlePaymeCallback).toHaveBeenCalledWith(undefined, { id: "x" });
    });

    it("clickWebhook forwards the raw signed body to handleClickCallback", async () => {
      const body = {
        click_trans_id: "ctr-1",
        merchant_trans_id: "pid-2",
        action: "1",
        error: 0,
        sign_time: "2026-06-10 12:00:00",
        sign_string: "abc",
      };
      await controller.clickWebhook(body);
      expect(svc.handleClickCallback).toHaveBeenCalledWith(body);
    });
  });

  // ── SEC FIX M11: initiate — userId faqat tasdiqlangan JWT dan ────────────
  describe("initiate (M11 — no client-supplied userId)", () => {
    const body = {
      amount: 50_000,
      purpose: "GENERAL" as const,
      method: PaymentMethod.PAYME,
    };

    it("auth header yo'q → anonim (userId undefined)", async () => {
      await controller.initiate(body, undefined);
      expect(svc.initiateDonation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined, amount: 50_000 }),
      );
      expect(jwt.verify).not.toHaveBeenCalled();
    });

    it("to'g'ri Bearer token → userId = payload.sub", async () => {
      jwt.verify.mockReturnValue({ sub: "user-77", phone: "+998", role: "KITOBXON" });
      await controller.initiate(body, "Bearer good-token");
      expect(jwt.verify).toHaveBeenCalledWith("good-token", {
        secret: "test-jwt-secret",
      });
      expect(svc.initiateDonation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-77" }),
      );
    });

    it("yaroqsiz Bearer token → 401 (jim anonimlashtirilmaydi)", async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error("jwt expired");
      });
      expect(() => controller.initiate(body, "Bearer bad-token")).toThrow(
        UnauthorizedException,
      );
      expect(svc.initiateDonation).not.toHaveBeenCalled();
    });

    it("body.userId YUBORILSA HAM e'tiborga olinmaydi (attacker attribution yopiq)", async () => {
      const attackerBody = {
        ...body,
        userId: "victim-user-id",
      } as typeof body & { userId: string };
      await controller.initiate(attackerBody, undefined);
      expect(svc.initiateDonation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined }),
      );
      const passed = svc.initiateDonation.mock.calls[0][0];
      expect(passed.userId).not.toBe("victim-user-id");
    });

    it("Basic sarlavha Bearer emas → anonim", async () => {
      await controller.initiate(body, "Basic abc123");
      expect(jwt.verify).not.toHaveBeenCalled();
      expect(svc.initiateDonation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined }),
      );
    });

    it("payload.sub bo'lmasa → anonim", async () => {
      jwt.verify.mockReturnValue({ phone: "+998" });
      await controller.initiate(body, "Bearer token-without-sub");
      expect(svc.initiateDonation).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined }),
      );
    });
  });

  describe("admin breakdown", () => {
    it("getAdminBreakdown delegates to service", async () => {
      await controller.getAdminBreakdown();
      expect(svc.getAdminBreakdown).toHaveBeenCalled();
    });
  });

  describe("getSpending", () => {
    it("forwards parsed limit", async () => {
      await controller.getSpending("5");
      expect(svc.getSpendingHistory).toHaveBeenCalledWith(5);
    });

    it("default limit = 20 when query missing", async () => {
      await controller.getSpending(undefined);
      expect(svc.getSpendingHistory).toHaveBeenCalledWith(20);
    });
  });
});

// ── IpWhitelistGuard integration check (unit-level) ─────────────────────────
// Verifies the controller's webhook routes are protected: the guard rejects
// non-whitelisted IPs and the @IpWhitelist decorator routes to the correct
// env key. This confirms the donate controller correctly wires the Plan
// 03-01 IpWhitelistGuard onto /donate/webhook/{payme,click}.
describe("IpWhitelistGuard on donate webhook routes", () => {
  let guard: IpWhitelistGuard;
  let reflector: Reflector;
  let config: jest.Mocked<Pick<ConfigService, "get">>;

  function makeCtx(opts: {
    headers?: Record<string, string>;
    ip?: string;
  }): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: opts.headers ?? {},
          ip: opts.ip,
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = new Reflector();
    config = { get: jest.fn() };
    guard = new IpWhitelistGuard(reflector, config as unknown as ConfigService);
  });

  // Plan 04-02 audit-fix FIX A2 — guard now reads req.ip exclusively
  // (Express derives it from `app.set('trust proxy', N)`); the manual
  // X-Forwarded-For peek was removed as a spoof surface.

  it("whitelisted IP allowed (PAYME_IP_WHITELIST scope)", () => {
    config.get.mockReturnValue("1.2.3.4,5.6.7.8");
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue("PAYME_IP_WHITELIST");

    const ctx = makeCtx({ ip: "1.2.3.4" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("non-whitelisted IP raises ForbiddenException", () => {
    config.get.mockReturnValue("1.2.3.4");
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue("PAYME_IP_WHITELIST");

    const ctx = makeCtx({ ip: "9.9.9.9" });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(/IP whitelist rejected/);
  });

  it("CLICK_IP_WHITELIST env key honored on Click webhook route", () => {
    config.get.mockImplementation((key: string) =>
      key === "CLICK_IP_WHITELIST" ? "10.0.0.1" : undefined,
    );
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue("CLICK_IP_WHITELIST");

    const ctx = makeCtx({ ip: "10.0.0.1" });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
