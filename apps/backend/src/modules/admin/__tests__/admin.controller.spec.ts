import {
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminController } from "../admin.controller";
import { AdminService } from "../admin.service";
import { PdfService } from "../../../infra/pdf/pdf.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import type { Queue } from "bullmq";
import type { Response } from "express";

/**
 * Plan 05-04 Task 3 — AdminController.testPush (NOTIF-02).
 *
 * Covers the SUPER_ADMIN-only test-push endpoint:
 *   - 404 when userId is unknown
 *   - Enqueues NOTIFICATION_QUEUE job with the expected payload shape
 */

const mockAdminService = {} as unknown as AdminService;
const mockPdfService = {} as unknown as PdfService;

const makePrisma = () =>
  ({
    user: {
      findUnique: jest.fn(),
    },
  }) as unknown as PrismaService;

const makeQueue = () =>
  ({
    add: jest.fn().mockResolvedValue({ id: "queued-job-1" }),
  }) as unknown as Queue;

describe("AdminController.testPush (Plan 05-04 NOTIF-02)", () => {
  it("enqueues a push job for the target user", async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "u-target" });
    const queue = makeQueue();

    const controller = new AdminController(mockAdminService, mockPdfService, prisma, queue);
    const result = await controller.testPush({
      userId: "u-target",
      title: "QA test",
      message: "Bu sinov bildirishnomasi.",
    });

    expect(result).toEqual({ enqueued: true, jobId: "queued-job-1" });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "test-push",
      expect.objectContaining({
        type: "push",
        userId: "u-target",
        message: "Bu sinov bildirishnomasi.",
        title: "QA test",
        jobType: "test-push",
      }),
    );
  });

  it("defaults title to 'SIFAT LIBRARY' when omitted", async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "u-target" });
    const queue = makeQueue();

    const controller = new AdminController(mockAdminService, mockPdfService, prisma, queue);
    await controller.testPush({ userId: "u-target", message: "hi" });

    expect((queue.add as jest.Mock).mock.calls[0][1]).toMatchObject({
      title: "SIFAT LIBRARY",
    });
  });

  it("throws NotFoundException when target user does not exist", async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const queue = makeQueue();

    const controller = new AdminController(mockAdminService, mockPdfService, prisma, queue);
    await expect(
      controller.testPush({ userId: "missing", message: "x" }),
    ).rejects.toThrow(NotFoundException);

    expect(queue.add).not.toHaveBeenCalled();
  });
});

/**
 * Plan 05-05 T3 — AdminController.systemDownTest (ALERT-06 receive side).
 *
 * Covers:
 *  - 503 when ADMIN_SMS_RECIPIENTS env is empty.
 *  - Enqueues one SMS per recipient + records audit row.
 *  - Trims whitespace, drops empty CSV entries.
 */
describe("AdminController.systemDownTest (Plan 05-05 ALERT-06)", () => {
  const makeAdmin = () =>
    ({
      recordSystemDownTestAudit: jest.fn().mockResolvedValue(undefined),
    }) as unknown as AdminService;

  const makeConfig = (csv?: string) =>
    ({
      get: jest.fn().mockImplementation((key: string) =>
        key === "ADMIN_SMS_RECIPIENTS" ? csv : undefined,
      ),
    }) as unknown as ConfigService;

  beforeEach(() => {
    delete process.env.ADMIN_SMS_RECIPIENTS;
  });

  it("throws ServiceUnavailable when ADMIN_SMS_RECIPIENTS is empty", async () => {
    const prisma = makePrisma();
    const queue = makeQueue();
    const admin = makeAdmin();
    const config = makeConfig("");

    const controller = new AdminController(admin, mockPdfService, prisma, queue, config);
    await expect(
      controller.systemDownTest({ sub: "super-1", role: "SUPER_ADMIN" } as any),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("enqueues one SMS per recipient + records audit row", async () => {
    const prisma = makePrisma();
    const queue = makeQueue();
    const admin = makeAdmin();
    const config = makeConfig("+998901111111, +998902222222 ,+998903333333");

    const controller = new AdminController(admin, mockPdfService, prisma, queue, config);
    const result = await controller.systemDownTest({
      sub: "super-1",
      role: "SUPER_ADMIN",
    } as any);

    expect(result).toEqual({ enqueued: 3, recipients: 3 });
    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(queue.add).toHaveBeenCalledWith(
      "system-down-test",
      expect.objectContaining({
        type: "sms",
        phone: "+998901111111",
        jobType: "system-down-test",
      }),
    );
    expect(admin.recordSystemDownTestAudit).toHaveBeenCalledWith("super-1");
  });

  it("drops empty CSV entries (e.g. trailing comma)", async () => {
    const prisma = makePrisma();
    const queue = makeQueue();
    const admin = makeAdmin();
    const config = makeConfig("+998901111111,,, +998902222222 ,");

    const controller = new AdminController(admin, mockPdfService, prisma, queue, config);
    const result = await controller.systemDownTest({
      sub: "super-1",
      role: "SUPER_ADMIN",
    } as any);

    expect(result.enqueued).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});

/**
 * RBAC alert scoping (Audit 2026-06) — AdminController.getSmartAlerts.
 *
 * Verifies the controller resolves the caller's geo scope from their address
 * row and forwards it (with the limit) to AdminService.getSmartAlerts, so the
 * service can filter AiAuditLog by region. Without this wiring tier admins saw
 * every alert in the country.
 */
describe("AdminController.getSmartAlerts RBAC scoping (Audit 2026-06)", () => {
  const makeAdmin = () =>
    ({
      getSmartAlerts: jest.fn().mockResolvedValue([]),
    }) as unknown as AdminService;

  it("resolves caller scope and forwards { role, address } + limit to the service", async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "TUMAN_ADMIN",
      address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
    });
    const admin = makeAdmin();
    const controller = new AdminController(admin, mockPdfService, prisma, makeQueue());

    await controller.getSmartAlerts("25", {
      sub: "tuman-admin-1",
      phone: "+998900000000",
      role: "TUMAN_ADMIN",
    });

    expect(admin.getSmartAlerts).toHaveBeenCalledWith(25, {
      role: "TUMAN_ADMIN",
      address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
    });
  });

  it("defaults limit to 50 when omitted", async () => {
    const prisma = makePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      role: "SUPER_ADMIN",
      address: null,
    });
    const admin = makeAdmin();
    const controller = new AdminController(admin, mockPdfService, prisma, makeQueue());

    await controller.getSmartAlerts(undefined, {
      sub: "super-1",
      phone: "+998900000001",
      role: "SUPER_ADMIN",
    });

    expect(admin.getSmartAlerts).toHaveBeenCalledWith(
      50,
      expect.objectContaining({ role: "SUPER_ADMIN" }),
    );
  });
});

/**
 * Plan 05-09 Task 2 — createDemoRequest controller path (LAND-02 + T-05-09).
 *
 * Verifies the controller-level glue: when the service throws 429 we set the
 * Retry-After response header before re-throwing so the client gets a clean
 * "too many requests" signal.
 */
describe("AdminController.createDemoRequest (Plan 05-09 LAND-02)", () => {
  const makeAdmin = () =>
    ({
      createDemoRequest: jest.fn(),
    }) as unknown as AdminService;

  const makeRes = () => {
    const headers: Record<string, string> = {};
    return {
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      headers,
    } as unknown as Response & { setHeader: jest.Mock; headers: Record<string, string> };
  };

  it("delegates to AdminService.createDemoRequest on success", async () => {
    const admin = makeAdmin();
    (admin.createDemoRequest as jest.Mock).mockResolvedValue({ id: "demo-1" });
    const controller = new AdminController(admin, mockPdfService, makePrisma(), makeQueue());
    const res = makeRes();

    const result = await controller.createDemoRequest(
      {
        organization: "Navoiy 8-maktab",
        phone: "+998901234567",
        orgType: "MAKTAB",
      },
      res,
    );

    expect(result).toEqual({ id: "demo-1" });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("sets Retry-After header when service throws 429", async () => {
    const admin = makeAdmin();
    (admin.createDemoRequest as jest.Mock).mockRejectedValue(
      new HttpException(
        { statusCode: 429, message: "rate-limited", retryAfterSeconds: 3600 },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    const controller = new AdminController(admin, mockPdfService, makePrisma(), makeQueue());
    const res = makeRes();

    await expect(
      controller.createDemoRequest(
        { organization: "x", phone: "+998901234567", orgType: "MAKTAB" },
        res,
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "3600");
  });

  it("re-throws non-429 errors without setting Retry-After", async () => {
    const admin = makeAdmin();
    (admin.createDemoRequest as jest.Mock).mockRejectedValue(
      new HttpException("db down", 500),
    );
    const controller = new AdminController(admin, mockPdfService, makePrisma(), makeQueue());
    const res = makeRes();

    await expect(
      controller.createDemoRequest(
        { organization: "x", phone: "+998901234567", orgType: "MAKTAB" },
        res,
      ),
    ).rejects.toBeInstanceOf(HttpException);

    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
