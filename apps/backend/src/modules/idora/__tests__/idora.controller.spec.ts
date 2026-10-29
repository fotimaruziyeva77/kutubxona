import { IdoraController } from "../idora.controller";
import { IdoraService } from "../idora.service";
import { MukofotService } from "../mukofot/mukofot.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

const mockPrisma = {
  user: { findUnique: jest.fn() },
  aiAuditLog: { findMany: jest.fn() },
} as any;

const mockIdora = {
  getEmployees: jest.fn(),
  getEmployeesByDepartment: jest.fn(),
  approveEmployee: jest.fn(),
  rejectEmployee: jest.fn(),
  getInternalRating: jest.fn(),
  getInternalRatingHistory: jest.fn(),
  getBookCorner: jest.fn(),
  upsertBookCorner: jest.fn(),
  verifyBookCorner: jest.fn(),
  getReadingHours: jest.fn(),
  getReadingHourStats: jest.fn(),
  createReadingHour: jest.fn(),
  markAttendance: jest.fn(),
  getProfBooks: jest.fn(),
  addProfBook: jest.fn(),
  removeProfBook: jest.fn(),
  removeProfBookById: jest.fn(),
  generatePq9Report: jest.fn(),
  getDepartments: jest.fn(),
  createDepartment: jest.fn(),
  updateDepartment: jest.fn(),
  deleteDepartment: jest.fn(),
  getEmployee: jest.fn(),
} as any;

const mockMukofot = {
  recommendMukofot: jest.fn(),
} as any;

describe("IdoraController", () => {
  let controller: IdoraController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      role: "MUASSASA_ADMIN",
      schoolId: null,
      universityId: null,
      organizationId: "inst-1",
      address: { viloyatId: "v-1", tumanId: "t-1" },
    });

    controller = new IdoraController(
      mockIdora as IdoraService,
      mockPrisma as PrismaService,
      mockMukofot as MukofotService,
    );
  });

  it("getEmployees forwards scoped user", async () => {
    mockIdora.getEmployees.mockResolvedValue({ employees: [], total: 0, page: 1, limit: 50 });
    await controller.getEmployees("inst-1", { sub: "u-1" } as any, undefined, undefined, 1, 50);
    expect(mockIdora.getEmployees).toHaveBeenCalledWith(
      "inst-1",
      expect.objectContaining({ page: 1, limit: 50 }),
      expect.objectContaining({ role: "MUASSASA_ADMIN", organizationId: "inst-1" }),
    );
  });

  // Plan 06-05-fix FIX A — getEmployee forwards institutionId + scoped user.
  it("getEmployee forwards institutionId + userId + scoped user", async () => {
    mockIdora.getEmployee.mockResolvedValue({ id: "u-2", organizationId: "inst-1" });
    await controller.getEmployee("inst-1", "u-2", { sub: "u-1" } as any);
    expect(mockIdora.getEmployee).toHaveBeenCalledWith(
      "inst-1",
      "u-2",
      expect.objectContaining({ role: "MUASSASA_ADMIN", organizationId: "inst-1" }),
    );
  });

  // Plan 06-05-fix FIX D — body recordedById is IGNORED; JWT sub is used.
  it("createReadingHour reads recordedById from JWT (NOT body)", async () => {
    mockIdora.createReadingHour.mockResolvedValue({ id: "rh-1" });
    await controller.createReadingHour(
      "inst-1",
      // Body even includes a malicious recordedById — must be ignored.
      { heldAt: "2026-04-10T00:00:00Z", recordedById: "ATTACKER" } as any,
      { sub: "real-actor" } as any,
    );
    expect(mockIdora.createReadingHour).toHaveBeenCalledWith(
      "inst-1",
      "real-actor",
      // Note: the data forwarded to the service does not require recordedById
      // be stripped — it is simply ignored because the service signature
      // takes recordedById as a separate positional arg.
      expect.objectContaining({ heldAt: "2026-04-10T00:00:00Z" }),
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
    const passedRecordedById = mockIdora.createReadingHour.mock.calls[0][1];
    expect(passedRecordedById).toBe("real-actor");
    expect(passedRecordedById).not.toBe("ATTACKER");
  });

  // Plan 06-05-fix FIX D — markAttendance now routes by institutionId.
  it("markAttendance forwards institutionId + readingHourId + scoped user", async () => {
    mockIdora.markAttendance.mockResolvedValue({ marked: 2 });
    await controller.markAttendance(
      "inst-1",
      "rh-1",
      { userIds: ["u-1", "u-2"] },
      { sub: "actor" } as any,
    );
    expect(mockIdora.markAttendance).toHaveBeenCalledWith(
      "inst-1",
      "rh-1",
      ["u-1", "u-2"],
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  // Plan 06-05-fix FIX B — department mutations now carry institutionId
  // and forward scoped user.
  it("updateDepartment forwards institutionId + deptId + scoped user", async () => {
    mockIdora.updateDepartment.mockResolvedValue({ id: "dep-1", name: "X" });
    await controller.updateDepartment("inst-1", "dep-1", { name: "X" }, { sub: "actor" } as any);
    expect(mockIdora.updateDepartment).toHaveBeenCalledWith(
      "inst-1",
      "dep-1",
      { name: "X" },
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("deleteDepartment forwards institutionId + deptId + scoped user", async () => {
    mockIdora.deleteDepartment.mockResolvedValue({ id: "dep-1" });
    await controller.deleteDepartment("inst-1", "dep-1", { sub: "actor" } as any);
    expect(mockIdora.deleteDepartment).toHaveBeenCalledWith(
      "inst-1",
      "dep-1",
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("getEmployeesByDepartment forwards filter + scoped user", async () => {
    mockIdora.getEmployeesByDepartment.mockResolvedValue({ buckets: [] });
    await controller.getEmployeesByDepartment("inst-1", { sub: "u-1" } as any, "IT");
    expect(mockIdora.getEmployeesByDepartment).toHaveBeenCalledWith(
      "inst-1",
      { departmentId: "IT" },
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("approveEmployee forwards to service", async () => {
    mockIdora.approveEmployee.mockResolvedValue({ userId: "u-2", status: "ACTIVE" });
    const result = await controller.approveEmployee("inst-1", "u-2", { sub: "u-1" } as any);
    expect(result.status).toBe("ACTIVE");
    expect(mockIdora.approveEmployee).toHaveBeenCalledWith(
      "inst-1",
      "u-2",
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("rejectEmployee forwards reason", async () => {
    mockIdora.rejectEmployee.mockResolvedValue({ userId: "u-2", status: "BLOCKED" });
    await controller.rejectEmployee("inst-1", "u-2", { reason: "Hujjat" }, { sub: "u-1" } as any);
    expect(mockIdora.rejectEmployee).toHaveBeenCalledWith(
      "inst-1",
      "u-2",
      "Hujjat",
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("verifyBookCorner forwards file + scoped user", async () => {
    mockIdora.verifyBookCorner.mockResolvedValue({ verificationId: "v-1", photoUrl: "url" });
    const file = { buffer: Buffer.from("x"), mimetype: "image/png", size: 1 };
    await controller.verifyBookCorner("inst-1", file as any, { sub: "u-1" } as any);
    expect(mockIdora.verifyBookCorner).toHaveBeenCalledWith(
      "inst-1",
      "u-1",
      file,
      expect.objectContaining({ role: "MUASSASA_ADMIN" }),
    );
  });

  it("addProfBook forwards body + actor", async () => {
    mockIdora.addProfBook.mockResolvedValue({ id: "pb-1" });
    await controller.addProfBook(
      "inst-1",
      { sub: "u-1" } as any,
      { title: "T", author: "A" },
    );
    expect(mockIdora.addProfBook).toHaveBeenCalledWith(
      "inst-1",
      "u-1",
      { title: "T", author: "A" },
      expect.any(Object),
    );
  });

  it("removeProfBook scoped forwards to service", async () => {
    mockIdora.removeProfBook.mockResolvedValue({ id: "pb-1" });
    await controller.removeProfBook("inst-1", "pb-1", { sub: "u-1" } as any);
    expect(mockIdora.removeProfBook).toHaveBeenCalledWith(
      "inst-1",
      "pb-1",
      expect.any(Object),
    );
  });

  it("recommendMukofot delegates to MukofotService with HR actor", async () => {
    mockMukofot.recommendMukofot.mockResolvedValue({ auditId: "a-1", flagged: false });
    await controller.recommendMukofot(
      "inst-1",
      { sub: "hr-1" } as any,
      { userId: "u-2", month: "2026-05" },
    );
    expect(mockMukofot.recommendMukofot).toHaveBeenCalledWith(
      "inst-1",
      "u-2",
      expect.objectContaining({ sub: "hr-1", systemActor: false }),
      expect.objectContaining({ month: "2026-05" }),
    );
  });

  it("generatePq9Report streams PDF with correct headers", async () => {
    const buf = Buffer.from("PDF");
    mockIdora.generatePq9Report.mockResolvedValue(buf);
    const res = {
      set: jest.fn(),
      end: jest.fn(),
    };
    await controller.generatePq9Report("inst-1", { sub: "u-1" } as any, res as any);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "application/pdf",
        "Content-Disposition": expect.stringContaining("pq9-inst-1"),
      }),
    );
    expect(res.end).toHaveBeenCalledWith(buf);
  });

  it("recentMukofot reads aiAuditLog MUKOFOT_TAKLIFI for scopeId", async () => {
    mockPrisma.aiAuditLog.findMany.mockResolvedValue([{ id: "a-1" }]);
    const result = await controller.recentMukofot("inst-1");
    expect(mockPrisma.aiAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { issueType: "MUKOFOT_TAKLIFI", scope: "INSTITUTION", scopeId: "inst-1" },
      }),
    );
    expect(result).toEqual([{ id: "a-1" }]);
  });
});
