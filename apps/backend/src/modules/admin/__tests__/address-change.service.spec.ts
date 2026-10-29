import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { AddressChangeService } from "../address-change.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma: any = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  address: { findUnique: jest.fn() },
  addressChangeRequest: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  aiAuditLog: { create: jest.fn() },
  $transaction: jest.fn(),
};
mockPrisma.$transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma),
);

const SUPER_ADMIN = {
  role: UserRole.SUPER_ADMIN,
  address: { viloyatId: null, tumanId: null },
};
const TUMAN_ADMIN_NAVOIY = {
  role: UserRole.TUMAN_ADMIN,
  address: { viloyatId: "v-navoiy", tumanId: "t-karmana" },
};
const TUMAN_ADMIN_TASHKENT = {
  role: UserRole.TUMAN_ADMIN,
  address: { viloyatId: "v-tashkent", tumanId: "t-chilonzor" },
};
const VILOYAT_ADMIN_NAVOIY = {
  role: UserRole.VILOYAT_ADMIN,
  address: { viloyatId: "v-navoiy", tumanId: null },
};
const KITOBXON = {
  role: UserRole.KITOBXON,
  address: { viloyatId: "v-navoiy", tumanId: "t-karmana" },
};

describe("AddressChangeService", () => {
  let service: AddressChangeService;

  beforeEach(() => {
    service = new AddressChangeService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma),
    );
  });

  // ── createRequest ───────────────────────────────────────────────────────
  describe("createRequest", () => {
    it("yangi PENDING so'rov yaratadi + AiAuditLog{ADDRESS_CHANGE_REQUEST}", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", addressId: "a-old" });
      mockPrisma.address.findUnique.mockResolvedValue({ id: "a-new" });
      mockPrisma.addressChangeRequest.findFirst.mockResolvedValue(null);
      mockPrisma.addressChangeRequest.create.mockResolvedValue({
        id: "req-1",
        status: "PENDING",
      });

      const res = await service.createRequest("u1", {
        toAddressId: "a-new",
        reason: "Yangi uy sotib oldim, manzil yangilanishi kerak.",
      });

      expect(mockPrisma.addressChangeRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u1",
          fromAddressId: "a-old",
          toAddressId: "a-new",
          status: "PENDING",
        }),
      });
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          issueType: "ADDRESS_CHANGE_REQUEST",
        }),
      });
      expect(res.id).toBe("req-1");
    });

    it("PENDING mavjud bo'lsa 409 Conflict", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", addressId: "a-old" });
      mockPrisma.address.findUnique.mockResolvedValue({ id: "a-new" });
      mockPrisma.addressChangeRequest.findFirst.mockResolvedValue({ id: "existing" });

      await expect(
        service.createRequest("u1", {
          toAddressId: "a-new",
          reason: "Yana bir so'rov kerak",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("user yo'q → NotFound", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.createRequest("notfound", { toAddressId: "a", reason: "11 chars hi" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("toAddress yo'q → NotFound", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", addressId: "a-old" });
      mockPrisma.address.findUnique.mockResolvedValue(null);
      await expect(
        service.createRequest("u1", { toAddressId: "ghost", reason: "11 chars hi" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── approveRequest ─────────────────────────────────────────────────────
  describe("approveRequest", () => {
    const pendingReq = {
      id: "req-1",
      userId: "u1",
      fromAddressId: "a-old",
      toAddressId: "a-new",
      status: "PENDING",
    };

    it("TUMAN_ADMIN matched tuman approves → atomic swap + audit", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-navoiy",
        tumanId: "t-karmana",
      });
      mockPrisma.addressChangeRequest.update.mockResolvedValue({
        ...pendingReq,
        status: "APPROVED",
      });

      await service.approveRequest(TUMAN_ADMIN_NAVOIY, "req-1", "admin-1");

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.addressChangeRequest.update).toHaveBeenCalledWith({
        where: { id: "req-1" },
        data: expect.objectContaining({
          status: "APPROVED",
          reviewedBy: "admin-1",
        }),
      });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { addressId: "a-new" },
      });
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          issueType: "ADDRESS_CHANGE_APPROVED",
        }),
      });
    });

    it("TUMAN_ADMIN in different tuman → 403", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-navoiy",
        tumanId: "t-karmana",
      });

      await expect(
        service.approveRequest(TUMAN_ADMIN_TASHKENT, "req-1", "admin-2"),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN bypasses scope check", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-navoiy",
        tumanId: "t-karmana",
      });
      mockPrisma.addressChangeRequest.update.mockResolvedValue(pendingReq);

      await service.approveRequest(SUPER_ADMIN, "req-1", "super-1");

      expect(mockPrisma.user.update).toHaveBeenCalled();
    });

    it("VILOYAT_ADMIN cross-viloyat → 403 (T-06-F4)", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-tashkent",
        tumanId: "t-chilonzor",
      });
      await expect(
        service.approveRequest(VILOYAT_ADMIN_NAVOIY, "req-1", "v-admin"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("KITOBXON → 403", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-navoiy",
        tumanId: "t-karmana",
      });
      await expect(
        service.approveRequest(KITOBXON, "req-1", "user-x"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("already-resolved request → 400", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue({
        ...pendingReq,
        status: "APPROVED",
      });
      await expect(
        service.approveRequest(SUPER_ADMIN, "req-1", "admin"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── rejectRequest ──────────────────────────────────────────────────────
  describe("rejectRequest", () => {
    const pendingReq = {
      id: "req-1",
      userId: "u1",
      fromAddressId: "a-old",
      toAddressId: "a-new",
      status: "PENDING",
    };

    it("rejects + AiAuditLog{ADDRESS_CHANGE_REJECTED, analysis=reason}", async () => {
      mockPrisma.addressChangeRequest.findUnique.mockResolvedValue(pendingReq);
      mockPrisma.address.findUnique.mockResolvedValue({
        viloyatId: "v-navoiy",
        tumanId: "t-karmana",
      });
      mockPrisma.addressChangeRequest.update.mockResolvedValue({
        ...pendingReq,
        status: "REJECTED",
      });

      await service.rejectRequest(TUMAN_ADMIN_NAVOIY, "req-1", "admin-1", {
        reason: "Soxta hujjat",
      });

      expect(mockPrisma.addressChangeRequest.update).toHaveBeenCalledWith({
        where: { id: "req-1" },
        data: expect.objectContaining({ status: "REJECTED" }),
      });
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          issueType: "ADDRESS_CHANGE_REJECTED",
          analysis: "Soxta hujjat",
        }),
      });
    });
  });

  // ── listRequests ───────────────────────────────────────────────────────
  describe("listRequests", () => {
    it("TUMAN_ADMIN sees only requests targeting their tuman", async () => {
      mockPrisma.addressChangeRequest.findMany.mockResolvedValue([]);
      await service.listRequests(TUMAN_ADMIN_NAVOIY, "PENDING");
      const args = mockPrisma.addressChangeRequest.findMany.mock.calls[0][0];
      expect(args.where.status).toBe("PENDING");
      expect(args.where.toAddress.tumanId).toBe("t-karmana");
    });

    it("VILOYAT_ADMIN sees requests in their viloyat", async () => {
      mockPrisma.addressChangeRequest.findMany.mockResolvedValue([]);
      await service.listRequests(VILOYAT_ADMIN_NAVOIY);
      const args = mockPrisma.addressChangeRequest.findMany.mock.calls[0][0];
      expect(args.where.toAddress.viloyatId).toBe("v-navoiy");
    });

    it("SUPER_ADMIN sees all (no scope filter)", async () => {
      mockPrisma.addressChangeRequest.findMany.mockResolvedValue([]);
      await service.listRequests(SUPER_ADMIN);
      const args = mockPrisma.addressChangeRequest.findMany.mock.calls[0][0];
      expect(args.where.toAddress).toBeUndefined();
    });

    it("KITOBXON → 403", async () => {
      await expect(service.listRequests(KITOBXON)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
