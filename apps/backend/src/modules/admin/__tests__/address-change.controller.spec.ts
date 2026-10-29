import { UserRole } from "@prisma/client";
import { AddressChangeController } from "../address-change.controller";
import { AddressChangeService } from "../address-change.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

const KITOBXON_PAYLOAD = {
  sub: "u1",
  role: UserRole.KITOBXON,
  phone: "+998901234567",
};
const TUMAN_ADMIN_PAYLOAD = {
  sub: "admin-1",
  role: UserRole.TUMAN_ADMIN,
  phone: "+998901234568",
};

describe("AddressChangeController", () => {
  let controller: AddressChangeController;
  let service: jest.Mocked<AddressChangeService>;
  let prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeEach(() => {
    service = {
      createRequest: jest.fn().mockResolvedValue({ id: "req-1" }),
      listRequests: jest.fn().mockResolvedValue([]),
      approveRequest: jest.fn().mockResolvedValue({ id: "req-1", status: "APPROVED" }),
      rejectRequest: jest.fn().mockResolvedValue({ id: "req-1", status: "REJECTED" }),
    } as unknown as jest.Mocked<AddressChangeService>;
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "v-navoiy", tumanId: "t-karmana" },
        }),
      },
    };
    controller = new AddressChangeController(
      service,
      prisma as unknown as PrismaService,
    );
  });

  describe("POST /family/address-change (create)", () => {
    it("user submits — delegates to service.createRequest with user.sub", async () => {
      const res = await controller.create(KITOBXON_PAYLOAD, {
        toAddressId: "a-new",
        reason: "Manzilim o'zgardi yangi uy",
      });
      expect(service.createRequest).toHaveBeenCalledWith("u1", {
        toAddressId: "a-new",
        reason: "Manzilim o'zgardi yangi uy",
      });
      expect(res.id).toBe("req-1");
    });
  });

  describe("GET /family/address-change (list)", () => {
    it("resolves caller scope and delegates to service.listRequests", async () => {
      await controller.list(TUMAN_ADMIN_PAYLOAD, "PENDING");
      expect(service.listRequests).toHaveBeenCalledWith(
        expect.objectContaining({
          role: UserRole.TUMAN_ADMIN,
          address: { viloyatId: "v-navoiy", tumanId: "t-karmana" },
        }),
        "PENDING",
      );
    });
  });

  describe("PATCH /:id/approve", () => {
    it("delegates to service.approveRequest with caller + reviewerId", async () => {
      const res = await controller.approve(TUMAN_ADMIN_PAYLOAD, "req-1");
      expect(service.approveRequest).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.TUMAN_ADMIN }),
        "req-1",
        "admin-1",
      );
      expect(res.status).toBe("APPROVED");
    });
  });

  describe("PATCH /:id/reject", () => {
    it("delegates to service.rejectRequest with reason", async () => {
      const res = await controller.reject(TUMAN_ADMIN_PAYLOAD, "req-1", {
        reason: "Yaxshi dalil yo'q",
      });
      expect(service.rejectRequest).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.TUMAN_ADMIN }),
        "req-1",
        "admin-1",
        { reason: "Yaxshi dalil yo'q" },
      );
      expect(res.status).toBe("REJECTED");
    });
  });
});
