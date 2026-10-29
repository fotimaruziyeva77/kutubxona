import "reflect-metadata";
import { SchoolController } from "../school.controller";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "@prisma/client";

describe("SchoolController (Plan 06-02 SCH-01 / SCH-02 metadata)", () => {
  const reflector = new Reflector();

  it("reject endpoint declares the correct admin roles", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, SchoolController.prototype.rejectStudent);
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.MUASSASA_ADMIN,
        UserRole.TUMAN_ADMIN,
        UserRole.VILOYAT_ADMIN,
      ]),
    );
  });

  it("approve endpoint excludes VILOYAT_ADMIN per existing flow", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, SchoolController.prototype.approveStudent);
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.MUASSASA_ADMIN,
        UserRole.TUMAN_ADMIN,
      ]),
    );
  });

  it("students-by-class endpoint accepts school admins", () => {
    const roles = reflector.get<UserRole[]>(ROLES_KEY, SchoolController.prototype.getStudentsByClass);
    expect(roles).toEqual(
      expect.arrayContaining([
        UserRole.SUPER_ADMIN,
        UserRole.VILOYAT_ADMIN,
        UserRole.TUMAN_ADMIN,
        UserRole.MUASSASA_ADMIN,
      ]),
    );
  });

  it("rejectStudent forwards (userId, institutionId, reason, scopedUser) to service", async () => {
    const mockService = {
      rejectStudent: jest.fn().mockResolvedValue({ userId: "u-1", status: "BLOCKED", reason: "spam", auditId: "a-1" }),
    };
    const mockPrisma = {
      user: { findUnique: jest.fn().mockResolvedValue({
        role: "MUASSASA_ADMIN", schoolId: "inst-1",
        universityId: null, organizationId: null,
        address: { viloyatId: "v1", tumanId: "t1" },
      }) },
    };
    const controller = new SchoolController(mockService as any, {} as any, mockPrisma as any);
    const res = await controller.rejectStudent(
      "inst-1",
      "u-1",
      { reason: "spam" },
      { sub: "admin-1", role: "MUASSASA_ADMIN" } as any,
    );
    expect(mockService.rejectStudent).toHaveBeenCalledWith(
      "u-1",
      "inst-1",
      "spam",
      expect.objectContaining({ role: "MUASSASA_ADMIN", schoolId: "inst-1" }),
    );
    expect(res.status).toBe("BLOCKED");
  });

  it("resolveScopedUser pulls schoolId/universityId/organizationId from DB", async () => {
    const mockService = { getStudentsByClass: jest.fn().mockResolvedValue({ buckets: [] }) };
    const mockPrisma = {
      user: { findUnique: jest.fn().mockResolvedValue({
        role: "VILOYAT_ADMIN",
        schoolId: null,
        universityId: null,
        organizationId: null,
        address: { viloyatId: "v1", tumanId: "t1" },
      }) },
    };
    const controller = new SchoolController(mockService as any, {} as any, mockPrisma as any);
    await controller.getStudentsByClass("inst-1", { sub: "admin-1", role: "VILOYAT_ADMIN" } as any);
    expect(mockService.getStudentsByClass).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({ role: "VILOYAT_ADMIN", address: { viloyatId: "v1", tumanId: "t1" } }),
    );
  });
});
