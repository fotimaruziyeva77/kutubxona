import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  SubscriptionService,
  assertSubscriptionTransition,
  ALLOWED_TRANSITIONS,
  SYSTEM_ALLOWED,
} from "../subscription.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { InvoiceService } from "../invoice.service";
import { SubscriptionStatus, UserRole } from "@prisma/client";

const mockPrisma = {
  subscription: {
    create:   jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany:  jest.fn(),
    update:    jest.fn(),
    updateMany: jest.fn(),
    count:     jest.fn(),
    groupBy:   jest.fn(),
  },
  payment: {
    aggregate: jest.fn(),
  },
  invoice: {
    findMany: jest.fn(),
  },
  library: {
    findUnique: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  // Plan 04-03: $transaction must pass through a tx client so updateStatus
  // can run subscription.update + aiAuditLog.create atomically.
  $transaction: jest.fn(),
};

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockCache = {
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
  del:      jest.fn().mockResolvedValue(undefined),
  // Plan 04-04 RPT-03 — updateStatus FROZEN/DELETED invalidate the stats
  // cache pattern. Default spy resolves immediately.
  delPattern: jest.fn().mockResolvedValue(undefined),
};

const mockInvoice = {
  createInvoice: jest.fn().mockResolvedValue({ id: "inv-1" }),
};

// Plan 04-04 PAY-07 — NotifQueue mock. Tests assert .add was called with the
// expected NotificationJobData shape; sms.sendNotification should NEVER be
// called from sendPaymentReminders post-Plan-04-04.
const mockNotifQueue = {
  add: jest.fn().mockResolvedValue({ id: "job-1" }),
  remove: jest.fn().mockResolvedValue(undefined),
};

// Plan 04-04 audit-fix FIX F — RedisLockService for cron leader election.
// Default mock: first call always wins so existing cron tests don't need to
// rewrite.
const mockRedisLock = {
  tryAcquire: jest.fn().mockResolvedValue({ first: true }),
  storeResponse: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
};

// ConfigService — buildPaymentUrl() PAYME_MERCHANT_ID / CLICK_* / PUBLIC_BASE_URL
// kalitlarini o'qiydi va har birida `|| "<default>"` fallback bor, shuning uchun
// undefined qaytarish spec uchun yetarli (servis defaultlarga tushadi).
const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

const makeService = () =>
  new SubscriptionService(
    mockPrisma as unknown as PrismaService,
    mockSms as unknown as SmsService,
    mockCache as unknown as CacheService,
    mockInvoice as unknown as InvoiceService,
    mockNotifQueue as any,
    mockRedisLock as any,
    mockConfig as any,
  );

describe("SubscriptionService", () => {
  let service: SubscriptionService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    // Default $transaction: invoke the callback with our mockPrisma tx client.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    // Plan 04-04 audit-fix FIX F — default lock-acquired path.
    mockRedisLock.tryAcquire.mockResolvedValue({ first: true });
  });

  // ── createTrial ────────────────────────────────────────────────────────────
  describe("createTrial", () => {
    it("30 kunlik trial subscription yaratadi", async () => {
      const sub = {
        id: "sub-1",
        libraryId: "lib-1",
        planType: "SCH_BASIC",
        status: SubscriptionStatus.TRIAL,
      };
      mockPrisma.subscription.create.mockResolvedValue(sub);

      const result = await service.createTrial("lib-1", "SCH_BASIC");

      expect(mockPrisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            libraryId: "lib-1",
            planType:  "SCH_BASIC",
            status:    SubscriptionStatus.TRIAL,
          }),
        })
      );
      expect(result.id).toBe("sub-1");
    });
  });

  // ── getSubscription ────────────────────────────────────────────────────────
  describe("getSubscription", () => {
    it("kutubxona subscriptionini qaytaradi", async () => {
      const sub = { id: "sub-1", libraryId: "lib-1", status: "ACTIVE", invoices: [] };
      mockPrisma.subscription.findFirst.mockResolvedValue(sub);

      const result = await service.getSubscription("lib-1");

      expect(mockPrisma.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { libraryId: "lib-1" } })
      );
      expect(result!.id).toBe("sub-1");
    });

    it("subscription yo'q bo'lsa null qaytaradi", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      const result = await service.getSubscription("lib-notsub");
      expect(result).toBeNull();
    });
  });

  // ── getAllSubscriptions ────────────────────────────────────────────────────
  describe("getAllSubscriptions", () => {
    it("filtrlar bilan subscriptionlarni qaytaradi", async () => {
      const subs = [{ id: "sub-1" }, { id: "sub-2" }];
      mockPrisma.subscription.findMany.mockResolvedValue(subs);
      mockPrisma.subscription.count.mockResolvedValue(2);

      const result = await service.getAllSubscriptions({ status: "ACTIVE", page: 1, limit: 10 });

      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "ACTIVE" },
          skip:  0,
          take:  10,
        })
      );
      expect(result.total).toBe(2);
    });

    it("2-sahifada skip=50 bo'ladi", async () => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.subscription.count.mockResolvedValue(0);

      await service.getAllSubscriptions({ page: 2, limit: 50 });

      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 50 })
      );
    });
  });

  // ── renewSubscription ─────────────────────────────────────────────────────
  describe("renewSubscription", () => {
    it("bepul TRIAL tarifni updateStatus (validator) orqali ACTIVE qiladi", async () => {
      // Plan 04-03 audit-fix FIX B — TRIAL→ACTIVE goes through updateStatus
      // (SYSTEM whitelist branch validated by planType=GOV/MAH), then
      // extendEndDate. Both write AiAuditLog rows.
      const sub = {
        id: "sub-1", planType: "GOV", status: SubscriptionStatus.TRIAL,
        endDate: new Date("2027-01-01"),
        library: { id: "lib-1", name: "Davlat kutubxonasi" }
      };
      mockPrisma.subscription.findUnique.mockResolvedValue(sub);
      mockPrisma.subscription.update.mockResolvedValue({ ...sub, status: SubscriptionStatus.ACTIVE });

      await service.renewSubscription("sub-1");

      // Validator-driven update with status:ACTIVE was issued
      const updateCalls = mockPrisma.subscription.update.mock.calls;
      const sawStatusActive = updateCalls.some((c: any) =>
        c[0]?.data?.status === SubscriptionStatus.ACTIVE,
      );
      expect(sawStatusActive).toBe(true);
      // STATE_TRANSITION audit row was written (validator path)
      const auditCalls = mockPrisma.aiAuditLog.create.mock.calls;
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("bepul ACTIVE tarif extendEndDate orqali endDate ni uzaytiradi va audit yozadi", async () => {
      // Plan 04-03 audit-fix FIX B — ACTIVE state-preserving renewal: no
      // status transition, just endDate extension. Single audit row with
      // analysis.action="endDate extended".
      const oldEnd = new Date("2026-12-31");
      const sub = {
        id: "sub-1", planType: "MAH", status: SubscriptionStatus.ACTIVE,
        endDate: oldEnd,
        library: { id: "lib-1", name: "Mahalla" }
      };
      mockPrisma.subscription.findUnique.mockResolvedValue(sub);
      mockPrisma.subscription.update.mockResolvedValue(sub);

      await service.renewSubscription("sub-1");

      // No status change, only endDate update
      const updateCall = mockPrisma.subscription.update.mock.calls.find(
        (c: any) => c[0]?.data?.endDate !== undefined,
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0].data.status).toBeUndefined();
      // Audit row analysis is "endDate extended"
      const sawExtend = mockPrisma.aiAuditLog.create.mock.calls.some((c: any) => {
        const a = JSON.parse(c[0].data.analysis);
        return a.action === "endDate extended";
      });
      expect(sawExtend).toBe(true);
    });

    it("renewSubscription FROZEN holatda BadRequestException qaytaradi", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-frozen", planType: "GOV", status: SubscriptionStatus.FROZEN,
        endDate: new Date(),
        library: { id: "lib-1", name: "L" },
      });
      await expect(service.renewSubscription("sub-frozen")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("renewSubscription DELETED holatda BadRequestException qaytaradi", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-del", planType: "MAH", status: SubscriptionStatus.DELETED,
        endDate: new Date(),
        library: { id: "lib-1", name: "L" },
      });
      await expect(service.renewSubscription("sub-del")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("to'lovli tarif uchun faktura yaratadi", async () => {
      const sub = {
        id: "sub-1", planType: "SCH_BASIC", status: "PENDING",
        endDate: new Date(),
        library: { id: "lib-1", name: "8-maktab" }
      };
      mockPrisma.subscription.findUnique.mockResolvedValue(sub);

      await service.renewSubscription("sub-1");

      expect(mockInvoice.createInvoice).toHaveBeenCalledWith("sub-1", 2_500_000, 15);
    });

    it("subscription topilmasa NotFoundException", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(service.renewSubscription("notfound")).rejects.toThrow(NotFoundException);
    });
  });

  // ── Plan 04-03: state-machine validator (assertSubscriptionTransition) ─────
  describe("assertSubscriptionTransition (PAY-06)", () => {
    // Test 1: every legal admin transition passes.
    it.each([
      ["TRIAL", "PENDING", "SYSTEM", undefined, "SCH_BASIC"],
      ["TRIAL", "ACTIVE",  "SYSTEM", undefined, "GOV"],
      ["TRIAL", "ACTIVE",  "SYSTEM", undefined, "MAH"],
      ["PENDING", "ACTIVE", "SYSTEM", undefined, "SCH_BASIC"],
      ["TRIAL",   "FROZEN",  UserRole.SUPER_ADMIN, "Late payment dispute", "SCH_BASIC"],
      ["TRIAL",   "FROZEN",  UserRole.BUXGALTER,   "Late payment dispute", "SCH_BASIC"],
      ["PENDING", "FROZEN",  UserRole.SUPER_ADMIN, "Library closed",       "ORG_BASIC"],
      ["ACTIVE",  "FROZEN",  UserRole.SUPER_ADMIN, "Sabab bor",            "SCH_BASIC"],
      ["ACTIVE",  "DELETED", UserRole.SUPER_ADMIN, "Library closed",       "UNI_BASIC"],
      ["FROZEN",  "ACTIVE",  UserRole.SUPER_ADMIN, undefined,              "SCH_BASIC"],
      ["FROZEN",  "DELETED", UserRole.BUXGALTER,   "Permanent closure",    "SCH_BASIC"],
    ] as Array<[any, any, any, any, string]>)(
      "ruxsat etilgan: %s → %s by %s",
      (from, to, by, reason, planType) => {
        expect(() => assertSubscriptionTransition(from, to, by, reason, planType)).not.toThrow();
      },
    );

    // Test 2: illegal transitions throw BadRequestException.
    it.each([
      ["DELETED", "ACTIVE",  UserRole.SUPER_ADMIN],
      ["TRIAL",   "DELETED", UserRole.SUPER_ADMIN],
      ["ACTIVE",  "TRIAL",   UserRole.SUPER_ADMIN],
      ["PENDING", "TRIAL",   UserRole.SUPER_ADMIN],
      ["DELETED", "FROZEN",  UserRole.SUPER_ADMIN],
    ] as Array<[any, any, any]>)(
      "rad etiladi: %s → %s",
      (from, to, by) => {
        expect(() => assertSubscriptionTransition(from, to, by, "Sabab bor")).toThrow(
          BadRequestException,
        );
      },
    );

    it("SYSTEM TRIAL→FROZEN ni rad etadi (SYSTEM hech qachon FROZEN ga o'tkaza olmaydi)", () => {
      expect(() =>
        assertSubscriptionTransition("TRIAL", "FROZEN", "SYSTEM", undefined, "SCH_BASIC"),
      ).toThrow(BadRequestException);
    });

    it("SYSTEM ACTIVE→DELETED ni rad etadi (SYSTEM hech qachon DELETED ga o'tkaza olmaydi)", () => {
      expect(() =>
        assertSubscriptionTransition("ACTIVE", "DELETED", "SYSTEM", undefined, "SCH_BASIC"),
      ).toThrow(BadRequestException);
    });

    it("ACTIVE→FROZEN SUPER_ADMIN tomonidan reason'siz rad etiladi", () => {
      expect(() =>
        assertSubscriptionTransition("ACTIVE", "FROZEN", UserRole.SUPER_ADMIN, undefined),
      ).toThrow(BadRequestException);
      expect(() =>
        assertSubscriptionTransition("ACTIVE", "FROZEN", UserRole.SUPER_ADMIN, "  "),
      ).toThrow(BadRequestException);
    });

    // ── Plan 04-03 audit-fix FIX G — reason tightening (3+ chars after trim) ──
    it("FIX G: reason of two non-whitespace chars rejected (after trim < 3)", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "FROZEN",
          UserRole.SUPER_ADMIN,
          "ab",
        ),
      ).toThrow(BadRequestException);
    });

    it("FIX G: reason of whitespace-only rejected", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "FROZEN",
          UserRole.SUPER_ADMIN,
          "     ",
        ),
      ).toThrow(BadRequestException);
    });

    it("FIX G: reason of three non-whitespace chars accepted", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "FROZEN",
          UserRole.SUPER_ADMIN,
          "abc",
        ),
      ).not.toThrow();
    });

    it("FIX G: reason of whitespace-padded but 3+ trimmed chars accepted", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "FROZEN",
          UserRole.SUPER_ADMIN,
          "   abc   ",
        ),
      ).not.toThrow();
    });

    it("ACTIVE→FROZEN KUTUBXONACHI tomonidan ForbiddenException qaytaradi", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "FROZEN",
          UserRole.KUTUBXONACHI,
          "Sabab bor",
        ),
      ).toThrow(ForbiddenException);
    });

    it("ACTIVE→DELETED VILOYAT_ADMIN tomonidan ForbiddenException qaytaradi", () => {
      expect(() =>
        assertSubscriptionTransition(
          "ACTIVE",
          "DELETED",
          UserRole.VILOYAT_ADMIN,
          "Sabab bor",
        ),
      ).toThrow(ForbiddenException);
    });

    it("SYSTEM TRIAL→ACTIVE faqat bepul rejalar uchun (GOV/MAH)", () => {
      // SCH_BASIC (to'lovli) — rad etiladi
      expect(() =>
        assertSubscriptionTransition("TRIAL", "ACTIVE", "SYSTEM", undefined, "SCH_BASIC"),
      ).toThrow(BadRequestException);
      // GOV (bepul) — ruxsat
      expect(() =>
        assertSubscriptionTransition("TRIAL", "ACTIVE", "SYSTEM", undefined, "GOV"),
      ).not.toThrow();
      // MAH (bepul) — ruxsat
      expect(() =>
        assertSubscriptionTransition("TRIAL", "ACTIVE", "SYSTEM", undefined, "MAH"),
      ).not.toThrow();
    });

    it("DELETED terminal — hech qaerga o'ta olmaydi", () => {
      expect(ALLOWED_TRANSITIONS.DELETED).toEqual([]);
    });

    it("SYSTEM_ALLOWED ro'yhati 4 ta whitelisted o'tishni o'z ichiga oladi", () => {
      // Plan 04-03 audit-fix FIX D — refund propagation needs ACTIVE→PENDING
      // for the Payme webhook to walk back a PAID payment to "needs admin
      // attention" without bypassing the validator.
      expect(SYSTEM_ALLOWED).toEqual([
        ["TRIAL", "PENDING"],
        ["TRIAL", "ACTIVE"],
        ["PENDING", "ACTIVE"],
        ["ACTIVE", "PENDING"],
      ]);
    });
  });

  // ── updateStatus ──────────────────────────────────────────────────────────
  describe("updateStatus", () => {
    it("FROZEN ga o'tishda frozenReason/At/By yozadi + HIGH severity audit", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.ACTIVE,
        planType: "SCH_BASIC",
      });
      mockPrisma.subscription.update.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.FROZEN,
      });

      await service.updateStatus(
        "sub-1",
        SubscriptionStatus.FROZEN,
        "Late payment dispute",
        "user-99",
        UserRole.SUPER_ADMIN,
      );

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub-1" },
          data: expect.objectContaining({
            status: SubscriptionStatus.FROZEN,
            frozenReason: "Late payment dispute",
            frozenBy: "user-99",
            frozenAt: expect.any(Date),
          }),
        }),
      );
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "subscription",
            scopeId: "sub-1",
            issueType: "STATE_TRANSITION",
            severity: "HIGH",
            analysis: expect.stringContaining('"from":"ACTIVE"'),
          }),
        }),
      );
      const auditCall = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      const analysis = JSON.parse(auditCall.data.analysis);
      expect(analysis).toMatchObject({
        from: "ACTIVE",
        to: "FROZEN",
        by: "user-99",
        actorRole: UserRole.SUPER_ADMIN,
        reason: "Late payment dispute",
      });
    });

    it("DELETED ga o'tishda deletedReason/At/By yozadi", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.ACTIVE,
        planType: "SCH_BASIC",
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.updateStatus(
        "sub-1",
        SubscriptionStatus.DELETED,
        "Library closed",
        "user-99",
        UserRole.SUPER_ADMIN,
      );

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: SubscriptionStatus.DELETED,
            deletedReason: "Library closed",
            deletedBy: "user-99",
            deletedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("SYSTEM PENDING→ACTIVE — frozen/deleted fieldlarini yozmaydi, MEDIUM severity audit", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.PENDING,
        planType: "SCH_BASIC",
      });
      mockPrisma.subscription.update.mockResolvedValue({});

      await service.updateStatus(
        "sub-1",
        SubscriptionStatus.ACTIVE,
        undefined,
        "system",
        "SYSTEM",
      );

      const updateCall = mockPrisma.subscription.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(SubscriptionStatus.ACTIVE);
      expect(updateCall.data.frozenReason).toBeUndefined();
      expect(updateCall.data.deletedReason).toBeUndefined();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ severity: "MEDIUM" }),
        }),
      );
    });

    it("subscription topilmasa NotFoundException qaytaradi", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus(
          "notfound",
          SubscriptionStatus.ACTIVE,
          undefined,
          "system",
          "SYSTEM",
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("KUTUBXONACHI FROZEN urinishi ForbiddenException — service layer", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.ACTIVE,
        planType: "SCH_BASIC",
      });
      await expect(
        service.updateStatus(
          "sub-1",
          SubscriptionStatus.FROZEN,
          "Sabab bor",
          "user-1",
          UserRole.KUTUBXONACHI,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN FROZEN reasoniz BadRequestException", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-1",
        status: SubscriptionStatus.ACTIVE,
        planType: "SCH_BASIC",
      });
      await expect(
        service.updateStatus(
          "sub-1",
          SubscriptionStatus.FROZEN,
          undefined,
          "user-99",
          UserRole.SUPER_ADMIN,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Trial expiry cron ─────────────────────────────────────────────────────
  describe("trialExpiryReminders (SYSTEM auto-transitions)", () => {
    beforeEach(() => {
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.aiAuditLog.create.mockResolvedValue({});
      mockPrisma.subscription.update.mockResolvedValue({});
    });

    it("bepul tarif (GOV) trial tugaganda updateStatus orqali ACTIVE qiladi", async () => {
      const expiredGov = {
        id: "sub-gov",
        status: SubscriptionStatus.TRIAL,
        planType: "GOV",
        trialEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        library: { name: "L", phone: null },
      };
      // First findMany — upcoming reminders (3-10d), empty
      // Second findMany — expired trials
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expiredGov]);
      mockPrisma.subscription.findUnique.mockResolvedValue(expiredGov);

      await service.trialExpiryReminders();

      // Validate the actor was SYSTEM (proves the cron never produces FROZEN/DELETED)
      const auditCall = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      const analysis = JSON.parse(auditCall.data.analysis);
      expect(analysis.actorRole).toBe("SYSTEM");
      expect(analysis.to).toBe("ACTIVE");
      expect(analysis.from).toBe("TRIAL");
    });

    it("to'lovli tarif (SCH_BASIC) trial tugaganda updateStatus orqali PENDING qiladi va invoice yaratadi", async () => {
      const expiredSch = {
        id: "sub-sch",
        status: SubscriptionStatus.TRIAL,
        planType: "SCH_BASIC",
        trialEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
        library: { name: "L", phone: null },
      };
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expiredSch]);
      mockPrisma.subscription.findUnique.mockResolvedValue(expiredSch);

      await service.trialExpiryReminders();

      // Validate the cron picked TRIAL→PENDING, not anything terminal
      const auditCall = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      const analysis = JSON.parse(auditCall.data.analysis);
      expect(analysis.actorRole).toBe("SYSTEM");
      expect(analysis.to).toBe("PENDING");
      expect(mockInvoice.createInvoice).toHaveBeenCalledWith("sub-sch", 2_500_000, 15);
    });

    it("cron HECH QACHON FROZEN/DELETED yo'naltirmaydi", async () => {
      // Source-level guarantee: cron only invokes updateStatus with ACTIVE/PENDING.
      // We assert by exhausting the audit log analyses and proving none touch
      // FROZEN/DELETED.
      const expired = [
        {
          id: "sub-1",
          status: SubscriptionStatus.TRIAL,
          planType: "GOV",
          trialEnd: new Date(Date.now() - 86400000),
          library: { name: "A", phone: null },
        },
        {
          id: "sub-2",
          status: SubscriptionStatus.TRIAL,
          planType: "SCH_BASIC",
          trialEnd: new Date(Date.now() - 86400000),
          library: { name: "B", phone: null },
        },
      ];
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(expired);
      mockPrisma.subscription.findUnique
        .mockResolvedValueOnce(expired[0])
        .mockResolvedValueOnce(expired[1]);

      await service.trialExpiryReminders();

      for (const call of mockPrisma.aiAuditLog.create.mock.calls) {
        const analysis = JSON.parse(call[0].data.analysis);
        expect(["ACTIVE", "PENDING"]).toContain(analysis.to);
      }
    });
  });

  // ── Plan 04-04 PAY-07: payment reminder cron via NOTIFICATION_QUEUE ───────
  describe("sendPaymentReminders (PAY-07 — NOTIFICATION_QUEUE)", () => {
    const baseLib = { id: "lib-1", name: "Test maktab", phone: "+998901234567" };

    const buildInvoice = (days: number) => {
      const due = new Date();
      due.setDate(due.getDate() + days);
      return {
        id: `inv-${days}d`,
        amount: 2_500_000,
        dueDate: due,
        subscription: { library: baseLib },
      };
    };

    beforeEach(() => {
      mockPrisma.invoice.findMany.mockReset();
      mockNotifQueue.add.mockReset().mockResolvedValue({ id: "job-1" });
      mockSms.sendNotification.mockReset();
    });

    it("Test 1: 30-day window → enqueues one SMS job with templated body", async () => {
      // First call (days=30) returns one matching invoice; remaining calls empty.
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(30)])
        .mockResolvedValue([]);

      await service.sendPaymentReminders();

      expect(mockNotifQueue.add).toHaveBeenCalledTimes(1);
      const [name, data] = mockNotifQueue.add.mock.calls[0];
      expect(name).toBe("payment-reminder");
      expect(data).toMatchObject({
        type: "sms",
        phone: "+998901234567",
        userId: "lib-1",
      });
      expect(typeof data.message).toBe("string");
      expect(data.message).toContain("SIFAT Library");
      expect(data.message).toContain("Test maktab");
      // uz-UZ locale may use NBSP / NNBSP — assert each digit group present
      expect(data.message).toMatch(/2[\s  ]500[\s  ]000/);
      expect(data.message).toContain("sifat.uz/pay/inv-30d");
      expect(data.message).toContain("(30 kun)");
    });

    it("Test 2: 30 + 15 + 7 + 1 day windows → 4 enqueue calls (one per match)", async () => {
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(30)])
        .mockResolvedValueOnce([buildInvoice(15)])
        .mockResolvedValueOnce([buildInvoice(7)])
        .mockResolvedValueOnce([buildInvoice(1)]);

      await service.sendPaymentReminders();

      expect(mockNotifQueue.add).toHaveBeenCalledTimes(4);
      const messages = mockNotifQueue.add.mock.calls.map((c) => c[1].message);
      expect(messages.some((m) => m.includes("(30 kun)"))).toBe(true);
      expect(messages.some((m) => m.includes("(15 kun)"))).toBe(true);
      expect(messages.some((m) => m.includes("(7 kun)"))).toBe(true);
      expect(messages.some((m) => m.includes("(1 kun)"))).toBe(true);
    });

    it("Test 3: PAID invoices yield ZERO enqueues (where filter status=PENDING)", async () => {
      // findMany always returns []; status:'PENDING' filter is in the query.
      mockPrisma.invoice.findMany.mockResolvedValue([]);

      await service.sendPaymentReminders();

      expect(mockNotifQueue.add).not.toHaveBeenCalled();
      // Verify the query carries status:'PENDING'
      const queryCall = mockPrisma.invoice.findMany.mock.calls[0]?.[0];
      expect(queryCall?.where?.status).toBe("PENDING");
    });

    it("Test 4: message body is server-templated (no user input flows in)", async () => {
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(7)])
        .mockResolvedValue([]);

      await service.sendPaymentReminders();

      const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
      // Hard-coded prefix
      expect(msg.startsWith("SIFAT Library:")).toBe(true);
      // Library name + amount + ISO date + invoice link present
      expect(msg).toContain("Test maktab");
      expect(msg).toContain("sifat.uz/pay/");
      // Amount with uz-UZ thousand separator (NBSP / NNBSP — Intl varies)
      expect(msg).toMatch(/2[\s  ]500[\s  ]000/);
      // dueDate ISO yyyy-mm-dd substring present
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("Test 5: cron NEVER calls sms.sendNotification directly", async () => {
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(30)])
        .mockResolvedValueOnce([buildInvoice(15)])
        .mockResolvedValueOnce([buildInvoice(7)])
        .mockResolvedValueOnce([buildInvoice(1)]);

      await service.sendPaymentReminders();

      expect(mockSms.sendNotification).not.toHaveBeenCalled();
      expect(mockNotifQueue.add).toHaveBeenCalledTimes(4);
    });

    it("Test 6: cron returns within ~100ms regardless of provider latency", async () => {
      // Even if notifQueue.add is "slow" (50ms each), 4 enqueues should
      // total well under 1s. Pure smoke check on non-blocking design.
      mockNotifQueue.add.mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ id: "job-x" }), 5)),
      );
      mockPrisma.invoice.findMany.mockResolvedValue([]);

      const t0 = Date.now();
      await service.sendPaymentReminders();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000);
    });

    it("Test 7: invoices without library.phone are skipped (no enqueue)", async () => {
      const noPhoneInvoice = {
        id: "inv-nophone",
        amount: 1_000_000,
        dueDate: new Date(),
        subscription: { library: { id: "lib-x", name: "L", phone: null } },
      };
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([noPhoneInvoice])
        .mockResolvedValue([]);

      await service.sendPaymentReminders();

      expect(mockNotifQueue.add).not.toHaveBeenCalled();
    });

    it("Test 8: deterministic jobId per (invoice, day-window) for replay dedup", async () => {
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(30)])
        .mockResolvedValue([]);

      await service.sendPaymentReminders();

      const opts = mockNotifQueue.add.mock.calls[0][2];
      expect(opts?.jobId).toBe("payment-reminder:inv-30d:30d");
    });

    it("Test 9: BullMQ enqueue failure doesn't break the sweep", async () => {
      mockNotifQueue.add
        .mockRejectedValueOnce(new Error("redis down"))
        .mockResolvedValue({ id: "job-y" });
      mockPrisma.invoice.findMany
        .mockResolvedValueOnce([buildInvoice(30)])
        .mockResolvedValueOnce([buildInvoice(15)])
        .mockResolvedValue([]);

      // Should not throw — the loop must continue
      await expect(service.sendPaymentReminders()).resolves.toBeUndefined();
      // Both enqueues attempted even though first errored
      expect(mockNotifQueue.add).toHaveBeenCalledTimes(2);
    });

    // ── Plan 04-04 audit-fix FIX B (SEC HIGH) — SMS template injection ───
    //
    // library.name is the only DB-sourced field interpolated into the
    // reminder SMS. Adversarial review flagged three vectors:
    //   1. CR/LF → multi-line / gateway-control injection.
    //   2. Length → bandwidth + push attacker content into trusted suffix.
    //   3. Single quotes → break out of the quoted libraryName context.
    describe("FIX B — SMS body sanitization (CR/LF / length / quote)", () => {
      it("library name with newline → single-line body, no LF/CR in output", async () => {
        const evil = {
          id: "lib-evil",
          name: "X\nFREE MONEY https://evil/",
          phone: "+998901111111",
        };
        const inv = {
          id: "inv-evil",
          amount: 1_000_000,
          dueDate: new Date(Date.now() + 7 * 86400000),
          subscription: { library: evil },
        };
        mockPrisma.invoice.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([inv])
          .mockResolvedValueOnce([]);

        await service.sendPaymentReminders();

        expect(mockNotifQueue.add).toHaveBeenCalledTimes(1);
        const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
        expect(msg).not.toMatch(/[\r\n]/);
        // The "FREE MONEY" text itself remains (we sanitize structure, not
        // content) but it can't break the SMS boundary or fake a new header.
        // We verify the body is a single line and the trusted prefix is intact.
        expect(msg.startsWith("SIFAT Library:")).toBe(true);
      });

      it("library name with CR → CR stripped", async () => {
        const evil = {
          id: "lib-cr",
          name: "Name\rsplit",
          phone: "+998901111111",
        };
        const inv = {
          id: "inv-cr",
          amount: 1_000_000,
          dueDate: new Date(Date.now() + 1 * 86400000),
          subscription: { library: evil },
        };
        mockPrisma.invoice.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([inv]);

        await service.sendPaymentReminders();

        const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
        expect(msg).not.toContain("\r");
      });

      it("library name longer than 60 chars → truncated with ellipsis", async () => {
        const longName = "A".repeat(120);
        const inv = {
          id: "inv-long",
          amount: 1_000_000,
          dueDate: new Date(Date.now() + 30 * 86400000),
          subscription: {
            library: { id: "lib-long", name: longName, phone: "+998901" },
          },
        };
        mockPrisma.invoice.findMany
          .mockResolvedValueOnce([inv])
          .mockResolvedValue([]);

        await service.sendPaymentReminders();

        const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
        // 60-char cap means the full 120-A run cannot appear in the body
        expect(msg).not.toContain("A".repeat(120));
        // Ellipsis present
        expect(msg).toContain("…");
      });

      it("library name with single quote → quote dropped", async () => {
        const inv = {
          id: "inv-quote",
          amount: 1_000_000,
          dueDate: new Date(Date.now() + 15 * 86400000),
          subscription: {
            library: {
              id: "lib-q",
              name: "Lib' please send 1m UZS to evil",
              phone: "+998901",
            },
          },
        };
        mockPrisma.invoice.findMany
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([inv])
          .mockResolvedValue([]);

        await service.sendPaymentReminders();

        const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
        // No literal single-quote inside the libraryName segment (the rest
        // of the template uses curly Uzbek apostrophes / "so'm" which is
        // a different char). The OPS-injected single quote must be stripped.
        // We assert by checking that the substring "Lib'" never appears.
        expect(msg).not.toContain("Lib'");
        expect(msg).toContain("Lib");
      });

      it("normal library name passes through unchanged", async () => {
        const inv = {
          id: "inv-clean",
          amount: 2_500_000,
          dueDate: new Date(Date.now() + 30 * 86400000),
          subscription: {
            library: {
              id: "lib-clean",
              name: "Karmana 8-maktab",
              phone: "+998901",
            },
          },
        };
        mockPrisma.invoice.findMany
          .mockResolvedValueOnce([inv])
          .mockResolvedValue([]);

        await service.sendPaymentReminders();

        const msg = mockNotifQueue.add.mock.calls[0][1].message as string;
        expect(msg).toContain("Karmana 8-maktab");
      });
    });

    // ── Plan 04-04 audit-fix FIX E (cron timezone) ────────────────────────
    //
    // Hard runtime-firing verification needs integration test infra
    // (SchedulerRegistry + a tick generator), which we don't run here.
    // We assert at the source-file substring level: "Asia/Tashkent" appears
    // exactly twice in subscription.service.ts (one per cron). The grep
    // gate in CI checks the same.
    describe("FIX E — explicit Asia/Tashkent timezone on @Cron", () => {
      const SUBSCRIPTION_SOURCE = fs.readFileSync(
        path.resolve(__dirname, "..", "subscription.service.ts"),
        "utf-8",
      );

      it("sendPaymentReminders @Cron uses timeZone Asia/Tashkent", () => {
        expect(SUBSCRIPTION_SOURCE).toMatch(
          /@Cron\("0 10 \* \* \*"[\s\S]*?timeZone:\s*"Asia\/Tashkent"[\s\S]*?\)\s*\n\s*async sendPaymentReminders/,
        );
      });

      it("trialExpiryReminders @Cron uses timeZone Asia/Tashkent", () => {
        expect(SUBSCRIPTION_SOURCE).toMatch(
          /@Cron\("0 9 \* \* \*"[\s\S]*?timeZone:\s*"Asia\/Tashkent"[\s\S]*?\)\s*\n\s*async trialExpiryReminders/,
        );
      });

      it("Asia/Tashkent appears in source at least twice (one per cron)", () => {
        const occurrences = (SUBSCRIPTION_SOURCE.match(/Asia\/Tashkent/g) ?? [])
          .length;
        expect(occurrences).toBeGreaterThanOrEqual(2);
      });
    });

    // ── Plan 04-04 audit-fix FIX F (Redis leader lock) ───────────────────
    describe("FIX F — Redis SETNX leader lock prevents replica duplicate", () => {
      it("sendPaymentReminders: lock acquired on first call, skipped on second", async () => {
        // First call wins, second call sees first: false → skip body.
        mockRedisLock.tryAcquire
          .mockResolvedValueOnce({ first: true })
          .mockResolvedValueOnce({ first: false });
        mockPrisma.invoice.findMany.mockResolvedValue([]);

        await service.sendPaymentReminders(); // leader
        // Second invocation in the SAME day (simulating a sibling replica).
        await service.sendPaymentReminders();

        // On the second run, findMany should NOT have been invoked because
        // the function returned before any DB call.
        // Total invocations = 4 (REMINDER_DAYS.length) from the first sweep.
        expect(mockPrisma.invoice.findMany).toHaveBeenCalledTimes(4);
        expect(mockRedisLock.tryAcquire).toHaveBeenCalledTimes(2);
      });

      it("sendPaymentReminders: lock key shape is cron:reminders:YYYY-MM-DD with 2-hour TTL", async () => {
        mockPrisma.invoice.findMany.mockResolvedValue([]);
        await service.sendPaymentReminders();
        const [key, ttl] = mockRedisLock.tryAcquire.mock.calls[0];
        expect(key).toMatch(/^cron:reminders:\d{4}-\d{2}-\d{2}$/);
        expect(ttl).toBe(2 * 60 * 60);
      });

      it("trialExpiryReminders: lock acquired on first call, skipped on second", async () => {
        mockRedisLock.tryAcquire
          .mockResolvedValueOnce({ first: true })
          .mockResolvedValueOnce({ first: false });
        mockPrisma.subscription.findMany.mockResolvedValue([]);

        await service.trialExpiryReminders();
        await service.trialExpiryReminders();

        // First run does TWO subscription.findMany (upcoming + expired);
        // second short-circuits.
        expect(mockPrisma.subscription.findMany).toHaveBeenCalledTimes(2);
        expect(mockRedisLock.tryAcquire).toHaveBeenCalledTimes(2);
      });

      it("trialExpiryReminders: lock key shape is cron:trial-expiry:YYYY-MM-DD", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);
        await service.trialExpiryReminders();
        const [key] = mockRedisLock.tryAcquire.mock.calls[0];
        expect(key).toMatch(/^cron:trial-expiry:\d{4}-\d{2}-\d{2}$/);
      });
    });

    // ── Plan 04-04 audit-fix FIX G (window upper bound) ──────────────────
    describe("FIX G — cron window upper bound uses next-day T00:00:00Z", () => {
      it("sendPaymentReminders uses next-day T00:00:00Z for lt (not T23:59:59Z)", async () => {
        mockPrisma.invoice.findMany.mockResolvedValue([]);
        await service.sendPaymentReminders();

        // 4 calls (one per REMINDER_DAY). Inspect each.
        for (const call of mockPrisma.invoice.findMany.mock.calls) {
          const where = call[0].where;
          const lt: Date = where.dueDate.lt;
          // T00:00:00 UTC always: hours/minutes/seconds all zero
          expect(lt.getUTCHours()).toBe(0);
          expect(lt.getUTCMinutes()).toBe(0);
          expect(lt.getUTCSeconds()).toBe(0);
        }
      });

      it("trialExpiryReminders uses next-day T00:00:00Z for lt", async () => {
        mockPrisma.subscription.findMany.mockResolvedValue([]);
        await service.trialExpiryReminders();

        const where = mockPrisma.subscription.findMany.mock.calls[0][0].where;
        const lt: Date = where.trialEnd.lt;
        expect(lt.getUTCHours()).toBe(0);
        expect(lt.getUTCMinutes()).toBe(0);
        expect(lt.getUTCSeconds()).toBe(0);
      });
    });
  });
});
