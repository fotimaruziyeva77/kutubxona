import { AdminService } from "../admin.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

const mockPrisma = {
  user: {
    count: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  library: { count: jest.fn() },
  book: { count: jest.fn() },
  bookTransaction: { count: jest.fn() },
  aiAuditLog: { findMany: jest.fn(), update: jest.fn() },
  riskLog: { findMany: jest.fn() },
  demoRequest: {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn()
};

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined)
};

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn().mockResolvedValue(undefined),
  // RBAC alert scoping (Audit 2026-06) — resolveAlert now also clears the
  // per-region scoped alert keys via delPattern.
  delPattern: jest.fn().mockResolvedValue(undefined),
  incrWithTtl: jest.fn().mockResolvedValue(1),
  // Audit H8 — cron leader lock; default "acquired" so cron bodies run.
  setNx: jest.fn().mockResolvedValue(true),
};

const mockNotificationQueue = {
  add: jest.fn().mockResolvedValue({ id: "job-1" }),
};

describe("AdminService", () => {
  let service: AdminService;

  beforeEach(() => {
    service = new AdminService(
      mockPrisma as unknown as PrismaService,
      mockSms as unknown as SmsService,
      mockCache as unknown as CacheService,
      undefined,
      undefined,
      undefined,
      mockNotificationQueue as unknown as import("bullmq").Queue,
    );
    jest.clearAllMocks();
    mockCache.incrWithTtl.mockResolvedValue(1);
    mockNotificationQueue.add.mockResolvedValue({ id: "job-1" });
  });

  // ── getDashboardStats ────────────────────────────────────────────────────
  // Plan 05-02 T1: $transaction was dropped because read-replicas cannot host
  // a write-transaction; now Promise.all routes counts through the replica
  // accessor. The fallback `this.prisma` when no replica is injected ensures
  // tests pass without DI-wiring up PrismaReplicaService.
  describe("getDashboardStats", () => {
    it("barcha statistika raqamlarini qaytaradi", async () => {
      mockPrisma.user.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(5);
      mockPrisma.library.count.mockResolvedValueOnce(50);
      mockPrisma.book.count.mockResolvedValueOnce(5000);
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(1200);

      const result = await service.getDashboardStats();
      expect(result).toEqual({
        totalUsers: 100, activeUsers: 80, pendingUsers: 5,
        totalLibraries: 50, totalBooks: 5000, totalTransactions: 1200
      });
    });
  });

  // ── getPendingUsers ──────────────────────────────────────────────────────
  describe("getPendingUsers", () => {
    it("PENDING statusdagi foydalanuvchilarni qaytaradi", async () => {
      const pending = [{ id: "u1", status: "PENDING" }];
      mockPrisma.user.findMany.mockResolvedValue(pending);
      const result = await service.getPendingUsers();
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: "PENDING" } })
      );
      expect(result).toEqual(pending);
    });
  });

  // ── resolveAlert — M7 append-only kontrakt (2026-06-10) ──────────────────
  // Migration 20260610000020_audit_log_append_only AiAuditLog'ga DB-darajali
  // trigger qo'ydi: UPDATE faqat `resolved` ustuni o'zgarganda o'tadi, boshqa
  // har qanday ustun o'zgarishi RAISE EXCEPTION. Unit testlar mock'langan —
  // bu test ilova qatlami FAQAT ruxsat etilgan maydonni yuborishini qotiradi:
  // data payload'ida `resolved`dan boshqa kalit paydo bo'lsa, trigger prod'da
  // har bir resolve'ni yiqitadi.
  describe("resolveAlert (M7 append-only allowed fields)", () => {
    it("faqat { resolved: true } yuboradi — boshqa hech qanday maydon emas", async () => {
      mockPrisma.aiAuditLog.update.mockResolvedValue({ id: "alert-1", resolved: true });

      const result = await service.resolveAlert("alert-1");

      expect(mockPrisma.aiAuditLog.update).toHaveBeenCalledTimes(1);
      const callArg = mockPrisma.aiAuditLog.update.mock.calls[0][0];
      // Aniq tenglik — objectContaining EMAS: qo'shimcha maydon ham xato.
      expect(callArg).toEqual({
        where: { id: "alert-1" },
        data: { resolved: true },
      });
      expect(Object.keys(callArg.data)).toEqual(["resolved"]);
      expect(result.resolved).toBe(true);
      // Cache invalidatsiyasi saqlangan
      expect(mockCache.del).toHaveBeenCalledWith(CacheService.keys.smartAlerts());
    });
  });

  // ── approveUser ──────────────────────────────────────────────────────────
  describe("approveUser", () => {
    it("ACTIVE ga o'tkazadi va SMS yuboradi", async () => {
      const updated = { id: "u1", status: "ACTIVE", phone: "+998901234567" };
      mockPrisma.user.update.mockResolvedValue(updated);

      const result = await service.approveUser("u1");

      // P2 (passwordHash leak): endpoint endi USER_PUBLIC_SELECT bilan
      // qaytaradi — select shakli emas, muhimi status flip'i saqlangani.
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "u1" },
          data: { status: "ACTIVE" },
        }),
      );
      expect(result.status).toBe("ACTIVE");
      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901234567",
        expect.stringContaining("tasdiqlandi"),
        "u1"
      );
    });
  });

  // ── rejectUser ───────────────────────────────────────────────────────────
  describe("rejectUser", () => {
    it("BLOCKED ga o'tkazadi va SMS yuboradi", async () => {
      mockPrisma.user.update.mockResolvedValue({ id: "u1", status: "BLOCKED", phone: "+998901234567" });

      const result = await service.rejectUser("u1", "Ma'lumotlar noto'g'ri");

      expect(result.status).toBe("BLOCKED");
      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901234567",
        expect.stringContaining("Ma'lumotlar noto'g'ri"),
        "u1"
      );
    });

    it("sabab ko'rsatmasdan ham rad etadi", async () => {
      mockPrisma.user.update.mockResolvedValue({ id: "u1", status: "BLOCKED", phone: "+998901234567" });
      await service.rejectUser("u1");
      expect(mockSms.sendNotification).toHaveBeenCalled();
    });
  });

  // ── autoFallbackPendingUsers (AUTH-04 — verify-only) ──────────────────────
  // RESEARCH AUTH-04: cron already exists in admin.service.ts:77-105.
  // These tests verify the two Plan-01 / Plan-02 dependencies are now satisfied:
  //   (1) NotificationProcessor SMS pathway is live (Plan 01-01, NOTIF-01/04)
  //       — assert sms.sendNotification is invoked on conversion.
  //   (2) Cron wall-clock is Asia/Tashkent (Plan 01-02 INFRA-05)
  //       — the @nestjs/schedule mock makes calling the method directly
  //       sufficient to validate behavior; TZ is verified at the Docker layer.
  // We also assert the time-window filter is correctly inclusive of >14d and
  // exclusive of recent PENDING (the cron's Prisma `where` does this; the
  // test forces a stale user through findMany and inspects the where clause).
  describe("autoFallbackPendingUsers (AUTH-04)", () => {
    it("14 kun o'tgan PENDING foydalanuvchini CITIZEN+ACTIVE ga o'tkazadi", async () => {
      const staleUser = { id: "u1", phone: "+998901234567" };
      mockPrisma.user.findMany.mockResolvedValue([staleUser]);
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });

      await service.autoFallbackPendingUsers();

      // Conversion: status + type both flipped
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["u1"] } },
        data: { status: "ACTIVE", type: "CITIZEN" }
      });
    });

    it("findMany filteri 14 kundan oldingi createdAt va PENDING + sifatId qaytaradi", async () => {
      // Snapshot the where clause the cron passes to Prisma; this is what
      // distinguishes a >14d PENDING from a recent one. The clock is real
      // (Date.now()) so we assert structure, not exact value.
      mockPrisma.user.findMany.mockResolvedValue([]);

      const beforeCall = Date.now();
      await service.autoFallbackPendingUsers();

      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      const [arg] = mockPrisma.user.findMany.mock.calls[0];
      expect(arg.where).toEqual(
        expect.objectContaining({
          status: "PENDING",
          sifatId: { not: null },
          createdAt: expect.objectContaining({ lt: expect.any(Date) })
        })
      );

      // Cutoff must be exactly 14 days before "now" (give a small window for
      // the wall-clock to advance during the call).
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      const cutoff = arg.where.createdAt.lt.getTime();
      expect(cutoff).toBeGreaterThanOrEqual(beforeCall - fourteenDaysMs - 1000);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - fourteenDaysMs + 1000);
    });

    it("conversion paytida har stale foydalanuvchiga SMS notification enqueue qiladi (NOTIF-01)", async () => {
      const stale = [
        { id: "u1", phone: "+998901111111" },
        { id: "u2", phone: "+998902222222" }
      ];
      mockPrisma.user.findMany.mockResolvedValue(stale);
      mockPrisma.user.updateMany.mockResolvedValue({ count: 2 });

      await service.autoFallbackPendingUsers();

      expect(mockSms.sendNotification).toHaveBeenCalledTimes(2);
      expect(mockSms.sendNotification).toHaveBeenNthCalledWith(
        1, "+998901111111", expect.stringContaining("14 kun"), "u1"
      );
      expect(mockSms.sendNotification).toHaveBeenNthCalledWith(
        2, "+998902222222", expect.stringContaining("14 kun"), "u2"
      );
    });

    it("stale user yo'q bo'lsa updateMany ham, SMS ham yuborilmaydi (recent PENDING untouched)", async () => {
      // findMany.where filteri 14 kundan yaqin PENDING ni o'tkazmaydi.
      // Bu test cron'ning idle holatini tekshiradi.
      mockPrisma.user.findMany.mockResolvedValue([]);

      await service.autoFallbackPendingUsers();

      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });
  });

  // ── getAuditLogs ─────────────────────────────────────────────────────────
  describe("getAuditLogs", () => {
    it("limit bilan audit loglarni qaytaradi", async () => {
      mockPrisma.aiAuditLog.findMany.mockResolvedValue([{ id: "l1" }]);
      const result = await service.getAuditLogs(10);
      expect(mockPrisma.aiAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
      expect(result).toHaveLength(1);
    });

    it("default limit 50 ishlatadi", async () => {
      mockPrisma.aiAuditLog.findMany.mockResolvedValue([]);
      await service.getAuditLogs();
      expect(mockPrisma.aiAuditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    });
  });

  // ── getRiskLogs ──────────────────────────────────────────────────────────
  describe("getRiskLogs", () => {
    it("risk loglarni qaytaradi", async () => {
      mockPrisma.riskLog.findMany.mockResolvedValue([{ id: "r1" }]);
      const result = await service.getRiskLogs(5);
      expect(result).toHaveLength(1);
    });
  });

  // ── Plan 05-05 T3: checkSmartAlerts DELETION (regression guard) ─────────
  describe("checkSmartAlerts (Plan 05-05 T3 deletion)", () => {
    it("is removed — audit.service.ts is the single source of truth", () => {
      // Method MUST NOT exist on the service. audit.service.ts now owns all
      // alert detection per Plan 05-05.
      expect(
        (service as unknown as { checkSmartAlerts?: unknown }).checkSmartAlerts,
      ).toBeUndefined();
    });
  });

  // ── Plan 05-05 T3: recordSystemDownTestAudit ────────────────────────────
  describe("recordSystemDownTestAudit (ALERT-06)", () => {
    it("creates an AiAuditLog row with SYSTEM_DOWN issueType + CRITICAL severity", async () => {
      const mockCreate = jest.fn().mockResolvedValue({ id: "audit-row" });
      (mockPrisma.aiAuditLog as unknown as { create: jest.Mock }).create = mockCreate;

      await service.recordSystemDownTestAudit("super-admin-1");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "NATIONAL",
            scopeId: "UZ",
            issueType: "SYSTEM_DOWN",
            severity: "CRITICAL",
          }),
        }),
      );
    });
  });

  // ── Plan 05-09 T2: createDemoRequest (LAND-02) ──────────────────────────
  describe("createDemoRequest (Plan 05-09 LAND-02)", () => {
    const goodPayload = {
      organization: "Navoiy 8-maktab",
      phone: "+998901234567",
      email: "info@navoiy8.uz",
      orgType: "MAKTAB",
      message: "Demo so'rayman",
    };

    beforeEach(() => {
      mockPrisma.demoRequest.create.mockResolvedValue({
        id: "demo-1",
        organization: goodPayload.organization,
        phone: goodPayload.phone,
        email: goodPayload.email,
        orgType: goodPayload.orgType,
        message: goodPayload.message,
        createdAt: new Date("2026-06-07T10:00:00.000Z"),
      });
    });

    it("rate-limits by normalized phone via incrWithTtl 3/hour", async () => {
      mockCache.incrWithTtl.mockResolvedValueOnce(1);
      await service.createDemoRequest(goodPayload);
      expect(mockCache.incrWithTtl).toHaveBeenCalledWith(
        expect.stringMatching(/^demo-rl:\+998/),
        3600,
      );
    });

    it("returns 429 with retryAfterSeconds on the 4th call within an hour", async () => {
      mockCache.incrWithTtl.mockResolvedValueOnce(4);
      await expect(service.createDemoRequest(goodPayload)).rejects.toMatchObject({
        status: 429,
      });
    });

    it("persists the DemoRequest row on success", async () => {
      await service.createDemoRequest(goodPayload);
      expect(mockPrisma.demoRequest.create).toHaveBeenCalledWith({
        data: goodPayload,
      });
    });

    it("enqueues an admin-fallback email job with escaped HTML body", async () => {
      await service.createDemoRequest(goodPayload);
      expect(mockNotificationQueue.add).toHaveBeenCalledWith(
        "demo-request-admin-notification",
        expect.objectContaining({
          type: "email",
          admin: true,
          subject: expect.stringContaining("Navoiy 8-maktab"),
          html: expect.stringContaining("Navoiy 8-maktab"),
          jobType: "demo-request",
        }),
        expect.objectContaining({ jobId: "demo-request-notify-demo-1" }),
      );
    });

    it("escapes HTML in user-controlled fields (T-05-EMAIL-INJ-B2B)", async () => {
      const hostile = {
        ...goodPayload,
        organization: '<script>alert(1)</script>',
        message: "<img src=x onerror=hack()>",
      };
      mockPrisma.demoRequest.create.mockResolvedValueOnce({
        id: "demo-xss",
        organization: hostile.organization,
        phone: hostile.phone,
        email: hostile.email,
        orgType: hostile.orgType,
        message: hostile.message,
        createdAt: new Date(),
      });
      await service.createDemoRequest(hostile);
      const call = mockNotificationQueue.add.mock.calls[0][1];
      expect(call.html).not.toContain("<script>alert(1)</script>");
      expect(call.html).not.toContain("<img src=x");
      expect(call.html).toContain("&lt;script&gt;");
    });

    it("swallows notification queue errors so the DB row is still returned", async () => {
      mockNotificationQueue.add.mockRejectedValueOnce(new Error("redis down"));
      const result = await service.createDemoRequest(goodPayload);
      expect(result.id).toBe("demo-1");
    });
  });
});
