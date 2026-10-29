import "reflect-metadata";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { PaymentController } from "../payment.controller";
import {
  IpWhitelistGuard,
  IP_WHITELIST_ENV_KEY,
} from "../../../common/guards/ip-whitelist.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

/**
 * Plan 04-02 audit-fix FIX D2 — payment.controller.spec.ts
 *
 * Lightweight wiring assertion for the webhook routes:
 *   1. Each route has @UseGuards(IpWhitelistGuard).
 *   2. Each route's @IpWhitelist(envKey) metadata picks the correct env key
 *      (PAYME_IP_WHITELIST for the Payme route, CLICK_IP_WHITELIST for the
 *      two Click routes).
 *   3. The guard itself, instantiated against the route metadata + a CSV
 *      config, accepts whitelisted IPs and rejects others.
 *
 * We don't boot the Nest HTTP layer here because @nestjs/testing + supertest
 * are not present as dev deps. The guard's internal behaviour is exhaustively
 * covered in ip-whitelist.guard.spec.ts; this spec confirms the controller
 * wires it on the right routes with the right env keys.
 */
describe("PaymentController — webhook guard wiring (FIX D2)", () => {
  const reflector = new Reflector();

  // Tiny helpers to read metadata that the decorators attach to methods.
  function getIpWhitelistKey(handler: Function): string | undefined {
    return reflector.get<string>(IP_WHITELIST_ENV_KEY, handler);
  }

  function getRouteGuards(handler: Function): Function[] | undefined {
    return Reflect.getMetadata("__guards__", handler) as
      | Function[]
      | undefined;
  }

  describe("metadata: @UseGuards(IpWhitelistGuard) + @IpWhitelist(envKey)", () => {
    it("paymeWebhook is guarded by IpWhitelistGuard with PAYME_IP_WHITELIST", () => {
      const handler = PaymentController.prototype.paymeWebhook;
      const guards = getRouteGuards(handler);
      expect(guards).toBeDefined();
      expect(guards!.some((g) => g === IpWhitelistGuard)).toBe(true);
      expect(getIpWhitelistKey(handler)).toBe("PAYME_IP_WHITELIST");
    });

    it("clickPrepare is guarded by IpWhitelistGuard with CLICK_IP_WHITELIST", () => {
      const handler = PaymentController.prototype.clickPrepare;
      const guards = getRouteGuards(handler);
      expect(guards).toBeDefined();
      expect(guards!.some((g) => g === IpWhitelistGuard)).toBe(true);
      expect(getIpWhitelistKey(handler)).toBe("CLICK_IP_WHITELIST");
    });

    it("clickComplete is guarded by IpWhitelistGuard with CLICK_IP_WHITELIST", () => {
      const handler = PaymentController.prototype.clickComplete;
      const guards = getRouteGuards(handler);
      expect(guards).toBeDefined();
      expect(guards!.some((g) => g === IpWhitelistGuard)).toBe(true);
      expect(getIpWhitelistKey(handler)).toBe("CLICK_IP_WHITELIST");
    });
  });

  describe("guard end-to-end against the wired env keys", () => {
    function makeContext(req: {
      ip: string;
    }, handlerFn: Function): ExecutionContext {
      return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => handlerFn,
        getClass: () => PaymentController,
      } as unknown as ExecutionContext;
    }

    function makeConfig(map: Record<string, string>): ConfigService {
      return {
        get: jest.fn((k: string) => map[k]),
      } as unknown as ConfigService;
    }

    it("Payme webhook: whitelisted Payme IP → allowed, non-whitelisted → 403", () => {
      const guard = new IpWhitelistGuard(
        new Reflector(),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      const handler = PaymentController.prototype.paymeWebhook;
      expect(
        guard.canActivate(makeContext({ ip: "203.0.113.5" }, handler)),
      ).toBe(true);
      expect(() =>
        guard.canActivate(makeContext({ ip: "10.0.0.1" }, handler)),
      ).toThrow(ForbiddenException);
    });

    it("Click prepare/complete: whitelisted Click IP allowed (cross-isolation: Payme IP rejected)", () => {
      const guard = new IpWhitelistGuard(
        new Reflector(),
        makeConfig({
          PAYME_IP_WHITELIST: "203.0.113.5",
          CLICK_IP_WHITELIST: "198.51.100.10",
        }),
      );
      const prepareHandler = PaymentController.prototype.clickPrepare;
      const completeHandler = PaymentController.prototype.clickComplete;
      // Whitelisted Click IP works on Click routes
      expect(
        guard.canActivate(
          makeContext({ ip: "198.51.100.10" }, prepareHandler),
        ),
      ).toBe(true);
      expect(
        guard.canActivate(
          makeContext({ ip: "198.51.100.10" }, completeHandler),
        ),
      ).toBe(true);
      // Payme's whitelisted IP must NOT bypass the Click route (different env key).
      expect(() =>
        guard.canActivate(
          makeContext({ ip: "203.0.113.5" }, prepareHandler),
        ),
      ).toThrow(ForbiddenException);
    });
  });
});

// ── Plan 04-03 audit-fix FIX C (SEC HIGH) — admin/owner gating ─────────────
//
// Subscription + invoice routes used to run under JwtAuthGuard alone, so any
// KITOBXON token could fetch billing data for any library. The fix adds
// @Roles(...) on the admin-only routes and an ownership check (via
// assertCallerOwnsLibrary) on the per-library / per-invoice routes. This spec
// confirms the @Roles metadata lands on the right handlers and the new
// /subscriptions/library/me endpoint exists.
describe("PaymentController — RBAC + ownership gating (FIX C)", () => {
  const reflector = new Reflector();

  function getRoles(handler: Function): UserRole[] | undefined {
    return reflector.get<UserRole[]>(ROLES_KEY, handler);
  }

  it("PATCH /subscriptions/:id/status — KITOBXON role rejected (only SUPER_ADMIN/BUXGALTER allowed)", () => {
    const handler = PaymentController.prototype.updateStatus;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).toEqual(
      expect.arrayContaining([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]),
    );
    expect(roles).not.toContain(UserRole.KITOBXON);
  });

  it("POST /subscriptions/:id/renew — KITOBXON role rejected", () => {
    const handler = PaymentController.prototype.renewSubscription;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).not.toContain(UserRole.KITOBXON);
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.BUXGALTER,
        UserRole.MUASSASA_ADMIN,
      ]),
    );
  });

  it("POST /subscriptions/trial — KITOBXON rejected", () => {
    const handler = PaymentController.prototype.createTrial;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).not.toContain(UserRole.KITOBXON);
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.BUXGALTER,
        UserRole.MUASSASA_ADMIN,
      ]),
    );
  });

  it("GET /subscriptions — admin-only", () => {
    const handler = PaymentController.prototype.getAllSubscriptions;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.BUXGALTER,
        UserRole.VILOYAT_ADMIN,
        UserRole.TUMAN_ADMIN,
      ]),
    );
    expect(roles).not.toContain(UserRole.KITOBXON);
  });

  it("GET /subscriptions/stats — financial admin only", () => {
    const handler = PaymentController.prototype.getSubscriptionStats;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).toEqual(
      expect.arrayContaining([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]),
    );
    expect(roles).not.toContain(UserRole.KITOBXON);
    expect(roles).not.toContain(UserRole.MUASSASA_ADMIN);
  });

  it("GET /invoices — admin-only (any of SUPER_ADMIN/BUXGALTER/VILOYAT/TUMAN)", () => {
    const handler = PaymentController.prototype.getInvoices;
    const roles = getRoles(handler);
    expect(roles).toBeDefined();
    expect(roles).not.toContain(UserRole.KITOBXON);
    expect(roles).not.toContain(UserRole.MUASSASA_ADMIN);
  });

  it("GET /invoices/stats + /invoices/export/csv — financial admin only", () => {
    const statsRoles = getRoles(PaymentController.prototype.getPaymentStats);
    expect(statsRoles).toEqual(
      expect.arrayContaining([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]),
    );
    expect(statsRoles).not.toContain(UserRole.MUASSASA_ADMIN);

    const csvRoles = getRoles(PaymentController.prototype.exportCsv);
    expect(csvRoles).toEqual(
      expect.arrayContaining([UserRole.SUPER_ADMIN, UserRole.BUXGALTER]),
    );
  });

  it("GET /subscriptions/library/me exists", () => {
    // Plan 04-03 audit-fix FIX C — new endpoint that resolves the caller's
    // libraryId server-side, so frontend never sends a client-controlled
    // libraryId for self-billing lookups.
    expect(
      typeof PaymentController.prototype.getMyLibrarySubscription,
    ).toBe("function");
  });

  describe("ownership check: GET /subscriptions/library/:libraryId from non-owner non-admin → 403", () => {
    // RBAC FIX: ownership now resolves via the CORRECT forward link
    //   user.(schoolId|universityId|organizationId) → Institution.libraryId
    // and compares the resolved library id against the requested one. The
    // mock therefore needs an `institution.findUnique` delegate; the old
    // `library.findUnique({ institutionId })` comparison is gone (every
    // Library.institutionId is NULL in prod, which is why the old path 403'd
    // every legitimately-linked librarian).
    const mockPrisma = {
      user: { findUnique: jest.fn() },
      institution: { findUnique: jest.fn() },
      library: { findUnique: jest.fn(), findFirst: jest.fn() },
      subscription: { findUnique: jest.fn() },
      invoice: { findUnique: jest.fn() },
    };

    function makeController(): PaymentController {
      return new (PaymentController as any)(
        {}, // PaymeService
        {}, // ClickService
        { getInvoice: jest.fn() }, // InvoiceService
        { getSubscription: jest.fn() }, // SubscriptionService
        mockPrisma, // PrismaService
      );
    }

    beforeEach(() => jest.clearAllMocks());

    it("non-admin caller whose library differs from the target → ForbiddenException", async () => {
      // Caller is linked to school-A → institution school-A → library lib-2.
      mockPrisma.user.findUnique.mockResolvedValue({
        schoolId: "school-A",
        universityId: null,
        organizationId: null,
      });
      mockPrisma.institution.findUnique.mockResolvedValue({
        libraryId: "lib-2", // caller owns lib-2, not the requested lib-1
      });

      const controller = makeController();
      await expect(
        controller.getLibrarySubscription("lib-1", {
          sub: "user-1",
          phone: "+998",
          role: UserRole.MUASSASA_ADMIN,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("non-admin caller WHOSE library matches the target → allowed (no throw)", async () => {
      // Caller is linked to school-A → institution school-A → library lib-1.
      mockPrisma.user.findUnique.mockResolvedValue({
        schoolId: "school-A",
        universityId: null,
        organizationId: null,
      });
      mockPrisma.institution.findUnique.mockResolvedValue({
        libraryId: "lib-1", // matches the requested library
      });

      const controller = makeController();
      await expect(
        controller.getLibrarySubscription("lib-1", {
          sub: "user-1",
          phone: "+998",
          role: UserRole.MUASSASA_ADMIN,
        }),
      ).resolves.toBeUndefined(); // service mock returns undefined
    });

    it("non-admin caller with NO institution link → ForbiddenException", async () => {
      // Regression guard for the Nodira case: a librarian with no
      // school/university/organization link must be refused, not silently
      // granted.
      mockPrisma.user.findUnique.mockResolvedValue({
        schoolId: null,
        universityId: null,
        organizationId: null,
      });

      const controller = makeController();
      await expect(
        controller.getLibrarySubscription("lib-1", {
          sub: "user-1",
          phone: "+998",
          role: UserRole.MUASSASA_ADMIN,
        }),
      ).rejects.toThrow(ForbiddenException);
      // institution lookup never reached — no institutionId to resolve.
      expect(mockPrisma.institution.findUnique).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN bypasses ownership check entirely", async () => {
      // Even with no institution link, admin gets through.
      mockPrisma.user.findUnique.mockResolvedValue({
        schoolId: null,
        universityId: null,
        organizationId: null,
      });

      const controller = makeController();
      await expect(
        controller.getLibrarySubscription("lib-any", {
          sub: "admin-1",
          phone: "+998",
          role: UserRole.SUPER_ADMIN,
        }),
      ).resolves.toBeUndefined();
      // ownership-check helpers should NOT have been called for admin
      expect(mockPrisma.institution.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.library.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ── Plan 04-04 audit-fix FIX D (SEC MEDIUM — cross-scope IDOR) ────────────
//
// Pre-fix: GET /invoices and GET /subscriptions accepted VILOYAT_ADMIN +
// TUMAN_ADMIN tokens but applied no scope filter. A viloyat admin saw every
// invoice in the country; a tuman admin could pass ?libraryId=<sibling> and
// see a neighbour's billing.
//
// Fix: the controller looks up user.address.{viloyatId,tumanId} and either
// injects the scope into the service where clause (no libraryId) OR
// validates the supplied libraryId against the scope (assertLibraryInScope).
// SUPER_ADMIN + BUXGALTER bypass.
describe("PaymentController — FIX D tier-admin scope filter (IDOR defence)", () => {
  const mockInvoiceService = { getInvoices: jest.fn() };
  const mockSubscriptionService = { getAllSubscriptions: jest.fn() };
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    library: { findUnique: jest.fn() },
  };

  function makeController(): PaymentController {
    return new (PaymentController as any)(
      {}, // PaymeService
      {}, // ClickService
      mockInvoiceService,
      mockSubscriptionService,
      mockPrisma,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoiceService.getInvoices.mockResolvedValue({
      invoices: [],
      total: 0,
      page: 1,
      limit: 50,
    });
    mockSubscriptionService.getAllSubscriptions.mockResolvedValue({
      subscriptions: [],
      total: 0,
      page: 1,
      limit: 50,
    });
  });

  it("VILOYAT_ADMIN /invoices listing is scope-filtered to their viloyat", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    const controller = makeController();
    await controller.getInvoices(
      { sub: "user-1", phone: "+998", role: UserRole.VILOYAT_ADMIN },
      undefined, // libraryId
      undefined, // status
      undefined, // from
      undefined, // to
      1, // page
      50, // limit
    );
    const call = mockInvoiceService.getInvoices.mock.calls[0][0];
    expect(call.scopeViloyatId).toBe("vil-A");
    expect(call.scopeTumanId).toBeUndefined();
  });

  it("TUMAN_ADMIN /invoices listing is scope-filtered to their tuman", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    const controller = makeController();
    await controller.getInvoices(
      { sub: "user-1", phone: "+998", role: UserRole.TUMAN_ADMIN },
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      50,
    );
    const call = mockInvoiceService.getInvoices.mock.calls[0][0];
    expect(call.scopeTumanId).toBe("tu-1");
    expect(call.scopeViloyatId).toBeUndefined();
  });

  it("VILOYAT_ADMIN passing out-of-scope libraryId → 403", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    mockPrisma.library.findUnique.mockResolvedValue({
      viloyatId: "vil-B", // different
      tumanId: "tu-2",
    });
    const controller = makeController();
    await expect(
      controller.getInvoices(
        { sub: "user-1", phone: "+998", role: UserRole.VILOYAT_ADMIN },
        "lib-foreign",
        undefined,
        undefined,
        undefined,
        1,
        50,
      ),
    ).rejects.toThrow(ForbiddenException);
    // service must NOT have been called
    expect(mockInvoiceService.getInvoices).not.toHaveBeenCalled();
  });

  it("TUMAN_ADMIN passing in-scope libraryId → allowed", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    mockPrisma.library.findUnique.mockResolvedValue({
      viloyatId: "vil-A",
      tumanId: "tu-1",
    });
    const controller = makeController();
    await expect(
      controller.getInvoices(
        { sub: "user-1", phone: "+998", role: UserRole.TUMAN_ADMIN },
        "lib-mine",
        undefined,
        undefined,
        undefined,
        1,
        50,
      ),
    ).resolves.toBeDefined();
    const call = mockInvoiceService.getInvoices.mock.calls[0][0];
    expect(call.libraryId).toBe("lib-mine");
    expect(call.scopeTumanId).toBe("tu-1");
  });

  it("SUPER_ADMIN /invoices listing bypasses scope filter", async () => {
    const controller = makeController();
    await controller.getInvoices(
      { sub: "admin", phone: "+998", role: UserRole.SUPER_ADMIN },
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      50,
    );
    const call = mockInvoiceService.getInvoices.mock.calls[0][0];
    expect(call.scopeViloyatId).toBeUndefined();
    expect(call.scopeTumanId).toBeUndefined();
    // user.findUnique should not have been consulted for an unrestricted admin
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("BUXGALTER /invoices listing bypasses scope filter", async () => {
    const controller = makeController();
    await controller.getInvoices(
      { sub: "bux", phone: "+998", role: UserRole.BUXGALTER },
      undefined,
      undefined,
      undefined,
      undefined,
      1,
      50,
    );
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("VILOYAT_ADMIN /subscriptions listing scope-filtered", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    const controller = makeController();
    await controller.getAllSubscriptions(
      { sub: "user-1", phone: "+998", role: UserRole.VILOYAT_ADMIN },
      undefined,
      undefined,
      undefined,
      1,
      50,
    );
    const call = mockSubscriptionService.getAllSubscriptions.mock.calls[0][0];
    expect(call.scopeViloyatId).toBe("vil-A");
  });

  it("TUMAN_ADMIN /subscriptions out-of-scope libraryId → 403", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      address: { viloyatId: "vil-A", tumanId: "tu-1" },
    });
    mockPrisma.library.findUnique.mockResolvedValue({
      viloyatId: "vil-B",
      tumanId: "tu-2",
    });
    const controller = makeController();
    await expect(
      controller.getAllSubscriptions(
        { sub: "user-1", phone: "+998", role: UserRole.TUMAN_ADMIN },
        undefined,
        undefined,
        "lib-foreign",
        1,
        50,
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
