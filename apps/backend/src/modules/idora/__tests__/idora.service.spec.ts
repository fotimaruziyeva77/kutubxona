import { NotFoundException } from "@nestjs/common";
import { IdoraService } from "../idora.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PdfService } from "../../../infra/pdf/pdf.service";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  institution: { findUnique: jest.fn() },
  department: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  orgRating: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  bookCorner: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  bookCornerVerification: { create: jest.fn() },
  readingHour: {
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  readingHourAttendee: { createMany: jest.fn() },
  profBook: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
  aiAuditLog: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  subscription: { findFirst: jest.fn() },
  $transaction: jest.fn().mockImplementation(async (ops: any) => {
    if (Array.isArray(ops)) return Promise.all(ops);
    return ops;
  }),
} as any;

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
  setNx: jest.fn().mockResolvedValue(true),
};

const mockMinio = {
  bucketBookCorners: "bookcorner-photos",
  putObject: jest.fn().mockResolvedValue(undefined),
  presignedGetUrl: jest.fn().mockResolvedValue("https://minio/sig/photo.jpg"),
};

const mockAlertDispatch = {
  dispatch: jest.fn().mockResolvedValue(undefined),
};

const mockPdf = {
  generateFromHtml: jest.fn().mockResolvedValue(Buffer.from("PDF")),
  generateIdoraPq9Report: jest.fn().mockImplementation((data: any) => {
    // Real escape behavior so XSS regressions catch real bugs.
    const { escapeHtml } = require("../../../common/utils/escape-html.util");
    const inst = escapeHtml(data?.institutionName ?? "");
    const mvp = data?.mvp ? escapeHtml(data.mvp.userName) + " | " + escapeHtml(data.mvp.department ?? "") : "";
    const profBooks = (data?.profBooks ?? []).map((b: any) => escapeHtml(b.title) + " by " + escapeHtml(b.author)).join("\n");
    return `<html><body>${inst} ${mvp} ${profBooks}</body></html>`;
  }),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeUser = (overrides: object = {}) => ({
  id: "user-1",
  name: "Sardor Toshmatov",
  phone: "+998901234567",
  sifatId: "SL-01-001-0001-00001",
  department: "IT bo'limi",
  position: "Dasturchi",
  organizationId: "inst-1",
  status: "ACTIVE",
  trustScore: 85,
  createdAt: new Date("2026-01-01"),
  readingIndex: [{ score: 78.5, calculatedAt: new Date() }],
  fraudScore: { riskScore: 5, action: "NONE" },
  transactions: [],
  ...overrides,
});

const makeInstitution = (overrides: object = {}) => ({
  id: "inst-1",
  name: "Moliya Vazirligi",
  type: "IDORA",
  viloyatId: "v-1",
  tumanId: "t-1",
  libraryId: null,
  ...overrides,
});

const makeDepartment = (overrides: object = {}) => ({
  id: "dep-1",
  institutionId: "inst-1",
  name: "IT bo'limi",
  code: "IT",
  headId: null,
  ...overrides,
});

const makeBookCorner = (overrides: object = {}) => ({
  id: "bc-1",
  institutionId: "inst-1",
  name: "Kitob burchagi",
  floor: "1-qavat",
  photoUrls: [],
  latitude: null,
  longitude: null,
  adminNote: null,
  isActive: true,
  lastVerified: new Date(),
  nextReminderAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  ...overrides,
});

const makeReadingHour = (overrides: object = {}) => ({
  id: "rh-1",
  institutionId: "inst-1",
  recordedById: "admin-1",
  title: "Kitob o'qish soati",
  heldAt: new Date("2026-04-10"),
  venue: "Konferents zal",
  durationMin: 60,
  mediaUrls: [],
  notes: null,
  attendances: [{ userId: "user-1" }],
  ...overrides,
});

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("IdoraService", () => {
  let service: IdoraService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCache.setNx.mockResolvedValue(true);
    mockCache.remember.mockImplementation((_k: string, _t: number, fn: () => unknown) => fn());
    // Restore implementations cleared by jest.clearAllMocks().
    mockPdf.generateFromHtml.mockResolvedValue(Buffer.from("PDF"));
    mockPdf.generateIdoraPq9Report.mockImplementation((data: any) => {
      const { escapeHtml } = require("../../../common/utils/escape-html.util");
      const inst = escapeHtml(data?.institutionName ?? "");
      const mvp = data?.mvp
        ? escapeHtml(data.mvp.userName) + " | " + escapeHtml(data.mvp.department ?? "")
        : "";
      const profBooks = (data?.profBooks ?? [])
        .map((b: any) => escapeHtml(b.title) + " by " + escapeHtml(b.author))
        .join("\n");
      return `<html><body>${inst} ${mvp} ${profBooks}</body></html>`;
    });
    mockPrisma.$transaction.mockImplementation(async (ops: any) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      return ops;
    });
    service = new IdoraService(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as CacheService,
      mockPdf as unknown as PdfService,
      undefined, // replica (falls back to primary)
      mockMinio as any,
      mockAlertDispatch as any,
    );
  });

  // ── getEmployees ──────────────────────────────────────────────────────────

  describe("getEmployees", () => {
    it("returns paginated employees", async () => {
      const users = [makeUser()];
      mockPrisma.user.findMany.mockResolvedValue(users);
      mockPrisma.user.count.mockResolvedValue(1);

      const result = await service.getEmployees("inst-1", {});

      expect(result).toEqual({ employees: users, total: 1, page: 1, limit: 50 });
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: "inst-1" },
          skip: 0,
          take: 50,
        })
      );
    });

    it("applies department filter", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await service.getEmployees("inst-1", { department: "IT bo'limi" });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ department: "IT bo'limi" }),
        })
      );
    });

    it("applies search filter with OR conditions", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await service.getEmployees("inst-1", { search: "Sardor" });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ name: expect.objectContaining({ contains: "Sardor" }) }),
              expect.objectContaining({ phone: expect.objectContaining({ contains: "Sardor" }) }),
            ]),
          }),
        })
      );
    });

    it("uses custom page and limit for pagination skip", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await service.getEmployees("inst-1", { page: 3, limit: 10 });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 })
      );
    });
  });

  // ── getEmployee ────────────────────────────────────────────────────────────

  describe("getEmployee", () => {
    it("returns full employee profile", async () => {
      const user = makeUser();
      mockPrisma.user.findUnique.mockResolvedValue(user);

      const result = await service.getEmployee("inst-1", "user-1");
      expect(result).toEqual(user);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1" } })
      );
    });

    it("throws NotFoundException when employee not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getEmployee("inst-1", "bad-id")).rejects.toThrow(NotFoundException);
    });

    // Plan 06-05-fix FIX A — cross-org id-enumeration: 404 (not 403).
    it("throws NotFoundException (404) when target belongs to another institution", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ organizationId: "OTHER-INST" }));
      await expect(service.getEmployee("inst-1", "user-1")).rejects.toThrow(NotFoundException);
    });

    it("scope-asserts via _assertScope before fetching the target", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: "inst-1",
        type: "IDORA",
        viloyatId: "v-1",
        tumanId: "t-1",
      });
      const scoped: any = {
        role: "MUASSASA_ADMIN",
        organizationId: "OTHER-INST",
        address: { viloyatId: "v-1", tumanId: "t-1" },
      };
      await expect(service.getEmployee("inst-1", "user-1", scoped)).rejects.toThrow(
        /Scope mismatch/i,
      );
    });
  });

  // ── getDepartments ────────────────────────────────────────────────────────

  describe("getDepartments", () => {
    it("returns departments with employee counts via cache", async () => {
      const deps = [makeDepartment(), makeDepartment({ id: "dep-2", name: "HR bo'limi" })];
      mockPrisma.department.findMany.mockResolvedValue(deps);
      mockPrisma.user.count.mockResolvedValue(15);

      const result = await service.getDepartments("inst-1");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "idora:departments:inst-1",
        600,
        expect.any(Function)
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty("employeeCount", 15);
    });

    it("returns empty array when no departments", async () => {
      mockPrisma.department.findMany.mockResolvedValue([]);
      const result = await service.getDepartments("inst-1");
      expect(result).toEqual([]);
    });
  });

  // ── createDepartment ──────────────────────────────────────────────────────

  describe("createDepartment", () => {
    it("creates department and invalidates cache", async () => {
      const dep = makeDepartment();
      mockPrisma.department.create.mockResolvedValue(dep);

      const result = await service.createDepartment("inst-1", { name: "IT bo'limi", code: "IT" });

      expect(mockCache.del).toHaveBeenCalledWith("idora:departments:inst-1");
      expect(mockPrisma.department.create).toHaveBeenCalledWith({
        data: { institutionId: "inst-1", name: "IT bo'limi", code: "IT" },
      });
      expect(result).toEqual(dep);
    });
  });

  // ── updateDepartment ──────────────────────────────────────────────────────

  describe("updateDepartment", () => {
    it("updates department when scope + ownership match", async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ institutionId: "inst-1" });
      const updated = makeDepartment({ name: "Yangi nom" });
      mockPrisma.department.update.mockResolvedValue(updated);

      const result = await service.updateDepartment("inst-1", "dep-1", { name: "Yangi nom" });

      expect(mockPrisma.department.update).toHaveBeenCalledWith({
        where: { id: "dep-1" },
        data: { name: "Yangi nom" },
      });
      expect(result).toEqual(updated);
    });

    // Plan 06-05-fix FIX B — 404 on cross-org department id.
    it("throws NotFoundException when department belongs to another institution", async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ institutionId: "OTHER-INST" });
      await expect(
        service.updateDepartment("inst-1", "dep-1", { name: "x" }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.department.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when department does not exist", async () => {
      mockPrisma.department.findUnique.mockResolvedValue(null);
      await expect(
        service.updateDepartment("inst-1", "dep-1", { name: "x" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteDepartment ──────────────────────────────────────────────────────

  describe("deleteDepartment", () => {
    it("deletes department when scope + ownership match", async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ institutionId: "inst-1" });
      mockPrisma.department.delete.mockResolvedValue(makeDepartment());

      await service.deleteDepartment("inst-1", "dep-1");

      expect(mockPrisma.department.delete).toHaveBeenCalledWith({ where: { id: "dep-1" } });
    });

    // Plan 06-05-fix FIX B — 404 on cross-org department id.
    it("throws NotFoundException when department belongs to another institution", async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ institutionId: "OTHER-INST" });
      await expect(service.deleteDepartment("inst-1", "dep-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.department.delete).not.toHaveBeenCalled();
    });
  });

  // ── getInternalRating ─────────────────────────────────────────────────────

  describe("getInternalRating", () => {
    it("returns cached rating when already computed", async () => {
      const existingRating = [
        { userId: "user-1", userName: "Sardor", rank: 1, isMvp: true, avgRi: 78.5, booksRead: 5 },
      ];
      mockPrisma.orgRating.findMany.mockResolvedValue(existingRating);

      const result = await service.getInternalRating("inst-1");

      expect(result).toEqual(existingRating);
      // _computeRating should NOT be called since existing records found
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it("computes rating live when no existing records", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          name: "Sardor",
          department: "IT",
          readingIndex: [{ score: 78.5 }],
          transactions: [{ id: "t-1" }, { id: "t-2" }],
        },
      ]);

      const result = await service.getInternalRating("inst-1");

      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(result[0]).toMatchObject({ userId: "user-1", rank: 1, isMvp: true, booksRead: 2 });
    });

    it("uses provided month in cache key", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([{ userId: "user-1", rank: 1 }]);

      await service.getInternalRating("inst-1", "2026-03");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "idora:rating:inst-1:2026-03",
        300,
        expect.any(Function)
      );
    });

    it("uses current month when month not provided", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);

      await service.getInternalRating("inst-1");

      expect(mockCache.remember).toHaveBeenCalledWith(
        `idora:rating:inst-1:${currentMonth()}`,
        300,
        expect.any(Function)
      );
    });
  });

  // ── R-DUP: IdoraService is READ-ONLY for OrgRating (Plan 06-01) ──────────
  //
  // Phase 3 InstitutionalService is the sole writer of OrgRating. The old
  // computeAndSaveRating method was deleted. These specs guard the read-only
  // contract — any future re-introduction of orgRating.create/upsert/createMany
  // from IdoraService will fail.

  describe("R-DUP: never writes OrgRating from IdoraService", () => {
    it("getInternalRating only reads OrgRating", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([
        { userId: "u-1", rank: 1, isMvp: true, avgRi: 80, booksRead: 5 },
      ]);

      await service.getInternalRating("inst-1");

      expect(mockPrisma.orgRating.findMany).toHaveBeenCalled();
      expect(mockPrisma.orgRating.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.orgRating.createMany).not.toHaveBeenCalled();
    });

    it("fallback computeRating path stays in-memory (no persist)", async () => {
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Sardor", department: "IT", readingIndex: [{ score: 80 }], transactions: [{ id: "t-1" }] },
      ]);

      const result = await service.getInternalRating("inst-1");

      expect(result[0]).toMatchObject({ userId: "u-1", rank: 1, isMvp: true });
      expect(mockPrisma.orgRating.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.orgRating.deleteMany).not.toHaveBeenCalled();
    });

    it("public API does not expose computeAndSaveRating", () => {
      expect((service as any).computeAndSaveRating).toBeUndefined();
    });
  });

  // ── getBookCorner ─────────────────────────────────────────────────────────

  describe("getBookCorner", () => {
    it("returns the latest book corner for institution", async () => {
      const corner = makeBookCorner();
      mockPrisma.bookCorner.findFirst.mockResolvedValue(corner);

      const result = await service.getBookCorner("inst-1");
      expect(result).toEqual(corner);
      expect(mockPrisma.bookCorner.findFirst).toHaveBeenCalledWith({
        where: { institutionId: "inst-1" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("returns null when no book corner exists", async () => {
      mockPrisma.bookCorner.findFirst.mockResolvedValue(null);
      const result = await service.getBookCorner("inst-1");
      expect(result).toBeNull();
    });
  });

  // ── upsertBookCorner ──────────────────────────────────────────────────────

  describe("upsertBookCorner", () => {
    it("updates existing book corner", async () => {
      const existing = makeBookCorner();
      mockPrisma.bookCorner.findFirst.mockResolvedValue(existing);
      const updated = makeBookCorner({ adminNote: "Yangilandi" });
      mockPrisma.bookCorner.update.mockResolvedValue(updated);

      const result = await service.upsertBookCorner("inst-1", { adminNote: "Yangilandi" });

      expect(mockPrisma.bookCorner.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bc-1" },
          data: expect.objectContaining({ isActive: true, adminNote: "Yangilandi" }),
        })
      );
      expect(result).toEqual(updated);
    });

    it("creates new book corner when none exists", async () => {
      mockPrisma.bookCorner.findFirst.mockResolvedValue(null);
      const created = makeBookCorner();
      mockPrisma.bookCorner.create.mockResolvedValue(created);

      const result = await service.upsertBookCorner("inst-1", {
        name: "Kitob burchagi",
        floor: "1-qavat",
      });

      expect(mockPrisma.bookCorner.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            institutionId: "inst-1",
            name: "Kitob burchagi",
            floor: "1-qavat",
          }),
        })
      );
      expect(result).toEqual(created);
    });

    it("sets nextReminderAt to 90 days from now", async () => {
      mockPrisma.bookCorner.findFirst.mockResolvedValue(null);
      mockPrisma.bookCorner.create.mockResolvedValue(makeBookCorner());

      const before = Date.now();
      await service.upsertBookCorner("inst-1", {});
      const after = Date.now();

      const createCall = mockPrisma.bookCorner.create.mock.calls[0][0];
      const nextReminder: Date = createCall.data.nextReminderAt;
      const expectedMs = 90 * 24 * 60 * 60 * 1000;
      expect(nextReminder.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 1000);
      expect(nextReminder.getTime()).toBeLessThanOrEqual(after + expectedMs + 1000);
    });
  });

  // ── getReadingHours ───────────────────────────────────────────────────────

  describe("getReadingHours", () => {
    it("returns paginated reading hours with attendances", async () => {
      const items = [makeReadingHour()];
      mockPrisma.readingHour.findMany.mockResolvedValue(items);
      mockPrisma.readingHour.count.mockResolvedValue(1);

      const result = await service.getReadingHours("inst-1");

      expect(result).toEqual({ items, total: 1, page: 1, limit: 20 });
      expect(mockPrisma.readingHour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 })
      );
    });

    it("uses custom page and limit", async () => {
      mockPrisma.readingHour.findMany.mockResolvedValue([]);
      mockPrisma.readingHour.count.mockResolvedValue(0);

      await service.getReadingHours("inst-1", 2, 5);

      expect(mockPrisma.readingHour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 })
      );
    });
  });

  // ── createReadingHour ─────────────────────────────────────────────────────

  describe("createReadingHour", () => {
    it("creates a reading hour event with default title and duration", async () => {
      const rh = makeReadingHour();
      mockPrisma.readingHour.create.mockResolvedValue(rh);

      const result = await service.createReadingHour("inst-1", "admin-1", {
        heldAt: "2026-04-10T10:00:00Z",
      });

      expect(mockPrisma.readingHour.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          institutionId: "inst-1",
          recordedById: "admin-1",
          title: "Kitob o'qish soati",
          durationMin: 60,
          mediaUrls: [],
          heldAt: new Date("2026-04-10T10:00:00Z"),
        }),
      });
      expect(result).toEqual(rh);
    });

    it("uses provided title, venue, durationMin, mediaUrls, notes", async () => {
      mockPrisma.readingHour.create.mockResolvedValue(makeReadingHour());

      await service.createReadingHour("inst-1", "admin-1", {
        title: "Maxsus sessiya",
        heldAt: "2026-04-15T14:00:00Z",
        venue: "Akt zal",
        durationMin: 90,
        mediaUrls: ["http://example.com/photo.jpg"],
        notes: "Muhim eslatma",
      });

      expect(mockPrisma.readingHour.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          title: "Maxsus sessiya",
          venue: "Akt zal",
          durationMin: 90,
          mediaUrls: ["http://example.com/photo.jpg"],
          notes: "Muhim eslatma",
        }),
      });
    });
  });

  // ── markAttendance ────────────────────────────────────────────────────────

  describe("markAttendance", () => {
    it("creates attendance records for valid in-org userIds", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue({ institutionId: "inst-1" });
      mockPrisma.user.findMany.mockResolvedValue([{ id: "u-1" }, { id: "u-2" }, { id: "u-3" }]);
      mockPrisma.readingHourAttendee.createMany.mockResolvedValue({ count: 3 });

      const result = await service.markAttendance("inst-1", "rh-1", ["u-1", "u-2", "u-3"]);

      expect(mockPrisma.readingHourAttendee.createMany).toHaveBeenCalledWith({
        data: [
          { readingHourId: "rh-1", userId: "u-1" },
          { readingHourId: "rh-1", userId: "u-2" },
          { readingHourId: "rh-1", userId: "u-3" },
        ],
        skipDuplicates: true,
      });
      expect(result).toEqual({ marked: 3 });
    });

    it("handles empty userIds array (short-circuit)", async () => {
      const result = await service.markAttendance("inst-1", "rh-1", []);
      expect(result).toEqual({ marked: 0 });
      expect(mockPrisma.readingHourAttendee.createMany).not.toHaveBeenCalled();
    });

    // Plan 06-05-fix FIX D — cross-org attendance forgery defence.
    it("throws BadRequestException when any userId belongs to another institution", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue({ institutionId: "inst-1" });
      // Caller provides 3 IDs but only 2 belong to inst-1 (the 3rd is cross-org).
      mockPrisma.user.findMany.mockResolvedValue([{ id: "u-1" }, { id: "u-2" }]);

      await expect(
        service.markAttendance("inst-1", "rh-1", ["u-1", "u-2", "u-cross"]),
      ).rejects.toThrow(/tegishli emas/i);
      expect(mockPrisma.readingHourAttendee.createMany).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when readingHour belongs to another institution", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue({ institutionId: "OTHER-INST" });
      await expect(
        service.markAttendance("inst-1", "rh-1", ["u-1"]),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── getReadingHourStats ───────────────────────────────────────────────────

  describe("getReadingHourStats", () => {
    it("returns stats including daysSinceLastEvent", async () => {
      mockPrisma.readingHour.count
        .mockResolvedValueOnce(10)  // total
        .mockResolvedValueOnce(2);  // thisMonthCount
      const lastHeldAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
      mockPrisma.readingHour.findFirst.mockResolvedValue({ heldAt: lastHeldAt });

      const result = await service.getReadingHourStats("inst-1");

      expect(result.total).toBe(10);
      expect(result.thisMonthCount).toBe(2);
      expect(result.daysSinceLastEvent).toBe(5);
      expect(result.lastEvent).toEqual(lastHeldAt);
    });

    it("returns null daysSinceLastEvent when no events exist", async () => {
      mockPrisma.readingHour.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      mockPrisma.readingHour.findFirst.mockResolvedValue(null);

      const result = await service.getReadingHourStats("inst-1");
      expect(result.daysSinceLastEvent).toBeNull();
      expect(result.lastEvent).toBeUndefined();
    });
  });

  // ── getProfBooks ──────────────────────────────────────────────────────────

  describe("getProfBooks", () => {
    it("returns all prof books for institution", async () => {
      const books = [{ id: "pb-1", title: "Boshqaruv", author: "Drucker", isRequired: true }];
      mockPrisma.profBook.findMany.mockResolvedValue(books);

      const result = await service.getProfBooks("inst-1");

      expect(result).toEqual(books);
      expect(mockPrisma.profBook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { institutionId: "inst-1" } })
      );
    });

    it("filters by departmentId when provided", async () => {
      mockPrisma.profBook.findMany.mockResolvedValue([]);

      await service.getProfBooks("inst-1", "dep-1");

      expect(mockPrisma.profBook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { institutionId: "inst-1", departmentId: "dep-1" },
        })
      );
    });
  });

  // ── addProfBook ───────────────────────────────────────────────────────────

  describe("addProfBook", () => {
    it("creates a professional book", async () => {
      const book = { id: "pb-1", title: "Boshqaruv", author: "Drucker" };
      mockPrisma.profBook.create.mockResolvedValue(book);

      const result = await service.addProfBook("inst-1", "admin-1", {
        title: "Boshqaruv",
        author: "Drucker",
      });

      expect(mockPrisma.profBook.create).toHaveBeenCalledWith({
        data: {
          institutionId: "inst-1",
          addedById: "admin-1",
          title: "Boshqaruv",
          author: "Drucker",
        },
      });
      expect(result).toEqual(book);
    });

    it("passes optional departmentId, isbn, genre, isRequired", async () => {
      mockPrisma.profBook.create.mockResolvedValue({ id: "pb-2" });

      await service.addProfBook("inst-1", "admin-1", {
        departmentId: "dep-1",
        isbn: "9780000000002",
        title: "Iqtisodiyot",
        author: "Keynes",
        genre: "Iqtisod",
        isRequired: true,
      });

      expect(mockPrisma.profBook.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          departmentId: "dep-1",
          isbn: "9780000000002",
          genre: "Iqtisod",
          isRequired: true,
        }),
      });
    });
  });

  // ── removeProfBook ────────────────────────────────────────────────────────

  describe("removeProfBook", () => {
    it("deletes a professional book by id via legacy helper", async () => {
      mockPrisma.profBook.delete.mockResolvedValue({ id: "pb-1" });

      await service.removeProfBookById("pb-1");

      expect(mockPrisma.profBook.delete).toHaveBeenCalledWith({ where: { id: "pb-1" } });
    });
  });

  // ── generatePq9Report ─────────────────────────────────────────────────────

  describe("generatePq9Report", () => {
    beforeEach(() => {
      mockPrisma.institution.findUnique.mockResolvedValue(makeInstitution());

      // getBookCorner
      mockPrisma.bookCorner.findFirst.mockResolvedValue(makeBookCorner());

      // getReadingHourStats — two count calls + findFirst
      mockPrisma.readingHour.count
        .mockResolvedValueOnce(8)   // total
        .mockResolvedValueOnce(2);  // thisMonthCount
      mockPrisma.readingHour.findFirst.mockResolvedValue({
        heldAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });

      // getInternalRating → _computeRating
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Sardor", department: "IT", readingIndex: [{ score: 82 }], transactions: [{ id: "t1" }] },
      ]);

      // getProfBooks
      mockPrisma.profBook.findMany.mockResolvedValue([
        { id: "pb-1", title: "Boshqaruv", author: "Drucker", isRequired: true, department: { name: "IT" } },
      ]);

      // employees count
      mockPrisma.user.count.mockResolvedValue(50);

      // Mukofot history + subscription open
      mockPrisma.aiAuditLog.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
    });

    it("returns a PDF buffer", async () => {
      const result = await service.generatePq9Report("inst-1");
      expect(mockPdf.generateFromHtml).toHaveBeenCalledTimes(1);
      expect(mockPdf.generateIdoraPq9Report).toHaveBeenCalledTimes(1);
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("includes institution name in generated HTML", async () => {
      await service.generatePq9Report("inst-1");
      const html: string = mockPdf.generateFromHtml.mock.calls[0][0];
      expect(html).toContain("Moliya Vazirligi");
    });

    it("includes MVP section when rating has entries", async () => {
      await service.generatePq9Report("inst-1");
      const html: string = mockPdf.generateFromHtml.mock.calls[0][0];
      expect(html).toContain("Sardor");
    });

    it("throws NotFoundException when institution not found", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue(null);
      await expect(service.generatePq9Report("bad-inst")).rejects.toThrow(NotFoundException);
    });

    // Plan 06-01 ORG-06 P1 XSS regressions — every DB string flows through
    // escapeHtml so script payloads cannot execute under Puppeteer.

    it("escapes institution.name (ORG-06 XSS regression)", async () => {
      mockPrisma.institution.findUnique.mockReset();
      mockPrisma.institution.findUnique.mockResolvedValue(
        makeInstitution({ name: "<script>alert(1)</script>" }),
      );

      await service.generatePq9Report("inst-1");
      const html: string = mockPdf.generateFromHtml.mock.calls[0][0];

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("escapes prof book title + author (ORG-06 XSS regression)", async () => {
      mockPrisma.profBook.findMany.mockResolvedValueOnce([
        {
          id: "pb-1",
          title: "<img onerror=fetch>",
          author: "<svg/onload>",
          isRequired: true,
          department: { name: "IT" },
        },
      ]);

      await service.generatePq9Report("inst-1");
      const html: string = mockPdf.generateFromHtml.mock.calls[0][0];

      expect(html).not.toContain("<img onerror=fetch>");
      expect(html).toContain("&lt;img onerror=fetch&gt;");
      expect(html).not.toContain("<svg/onload>");
      expect(html).toContain("&lt;svg/onload&gt;");
    });

    it("escapes MVP userName + department (ORG-06 XSS regression)", async () => {
      // Force the in-memory _computeRating path so we control userName
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValueOnce([
        {
          id: "u-1",
          name: "<script>evil()</script>",
          department: "<iframe src=javascript:>",
          readingIndex: [{ score: 82 }],
          transactions: [{ id: "t1" }],
        },
      ]);

      await service.generatePq9Report("inst-1");
      const html: string = mockPdf.generateFromHtml.mock.calls[0][0];

      expect(html).not.toContain("<script>evil()</script>");
      expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
      expect(html).not.toContain("<iframe src=javascript:>");
      expect(html).toContain("&lt;iframe src=javascript:&gt;");
    });
  });

  // ── bookCornerReminders (cron) ────────────────────────────────────────────

  describe("bookCornerReminders", () => {
    beforeEach(() => {
      mockCache.setNx.mockResolvedValue(true);
      mockPrisma.bookCorner.findMany.mockResolvedValue([]);
      mockPrisma.aiAuditLog.findFirst.mockResolvedValue(null);
      mockPrisma.aiAuditLog.create.mockResolvedValue({
        id: "audit-1",
        scope: "INSTITUTION",
        scopeId: "inst-1",
        issueType: "BOOK_CORNER_REMINDER_SENT",
        severity: "OGOHLANTIRISH",
        analysis: "test",
        recommendation: "test",
        createdAt: new Date(),
      });
      mockPrisma.institution.findUnique.mockResolvedValue({
        libraryId: "lib-1",
        name: "Test Idora",
      });
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "ACTIVE" });
    });

    it("does nothing when no overdue book corners", async () => {
      await service.bookCornerReminders();
      expect(mockAlertDispatch.dispatch).not.toHaveBeenCalled();
    });

    it("skips when leader lock is held", async () => {
      mockCache.setNx.mockResolvedValueOnce(false);
      mockPrisma.bookCorner.findMany.mockResolvedValue([
        { id: "bc-1", institutionId: "inst-1", lastVerified: new Date("2025-01-01") },
      ]);
      await service.bookCornerReminders();
      expect(mockPrisma.bookCorner.findMany).not.toHaveBeenCalled();
      expect(mockAlertDispatch.dispatch).not.toHaveBeenCalled();
    });

    it("fires AlertDispatchService.dispatch for overdue corners (NOT a stub)", async () => {
      mockPrisma.bookCorner.findMany.mockResolvedValue([
        { id: "bc-1", institutionId: "inst-1", lastVerified: new Date("2025-01-01") },
      ]);
      await service.bookCornerReminders();
      expect(mockAlertDispatch.dispatch).toHaveBeenCalledTimes(1);
      const callArg = mockAlertDispatch.dispatch.mock.calls[0][0];
      expect(callArg.issueType).toBe("BOOK_CORNER_REMINDER");
      expect(callArg.scope).toBe("INSTITUTION");
      expect(callArg.scopeId).toBe("inst-1");
    });

    it("skips when institution has FROZEN subscription", async () => {
      mockPrisma.bookCorner.findMany.mockResolvedValue([
        { id: "bc-1", institutionId: "inst-1", lastVerified: new Date("2025-01-01") },
      ]);
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "FROZEN" });
      await service.bookCornerReminders();
      expect(mockAlertDispatch.dispatch).not.toHaveBeenCalled();
    });

    it("dedups via existing BOOK_CORNER_REMINDER_SENT audit row (30d window)", async () => {
      mockPrisma.bookCorner.findMany.mockResolvedValue([
        { id: "bc-1", institutionId: "inst-1", lastVerified: new Date("2025-01-01") },
      ]);
      mockPrisma.aiAuditLog.findFirst.mockResolvedValue({ id: "prev-audit" });
      await service.bookCornerReminders();
      expect(mockAlertDispatch.dispatch).not.toHaveBeenCalled();
    });

    it("writes AiAuditLog BOOK_CORNER_REMINDER_SENT before dispatch", async () => {
      mockPrisma.bookCorner.findMany.mockResolvedValue([
        { id: "bc-1", institutionId: "inst-1", lastVerified: new Date("2025-01-01") },
      ]);
      await service.bookCornerReminders();
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: "BOOK_CORNER_REMINDER_SENT",
            scope: "INSTITUTION",
            scopeId: "inst-1",
          }),
        }),
      );
    });
  });

  // ── Plan 06-05 ORG-01 — employees-by-department ───────────────────────────

  describe("getEmployeesByDepartment", () => {
    it("groups employees by department + K-anonymity suppression for n<5", async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "A", position: "P", department: "IT", status: "ACTIVE", readingIndex: [{ score: 70 }], transactions: [{ id: "t1" }] },
        { id: "u-2", name: "B", position: "P", department: "IT", status: "ACTIVE", readingIndex: [{ score: 60 }], transactions: [] },
      ]);
      const result: any = await service.getEmployeesByDepartment("inst-1", {});
      const itBucket = result.buckets.find((b: any) => b.departmentName === "IT");
      expect(itBucket.total).toBe(2);
      expect(itBucket.kAnonymitySuppressed).toBe(true);
      expect(itBucket.avgRi).toBeNull();
    });

    it("returns avgRi when bucket >= 5 employees", async () => {
      const rows = Array.from({ length: 5 }).map((_, i) => ({
        id: `u-${i}`,
        name: `Emp${i}`,
        position: "P",
        department: "Big",
        status: "ACTIVE",
        readingIndex: [{ score: 70 }],
        transactions: [],
      }));
      mockPrisma.user.findMany.mockResolvedValue(rows);
      const result: any = await service.getEmployeesByDepartment("inst-1", {});
      const big = result.buckets.find((b: any) => b.departmentName === "Big");
      expect(big.kAnonymitySuppressed).toBe(false);
      expect(big.avgRi).toBe(70);
    });

    it("scope guards via assertInstitutionInScope (resolves institution)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: "inst-1",
        type: "IDORA",
        viloyatId: "v-1",
        tumanId: "t-1",
      });
      mockPrisma.user.findMany.mockResolvedValue([]);
      const scoped: any = {
        role: "MUASSASA_ADMIN",
        organizationId: "OTHER-INST",
        address: { viloyatId: "v-1", tumanId: "t-1" },
      };
      await expect(service.getEmployeesByDepartment("inst-1", {}, scoped)).rejects.toThrow(
        /Scope mismatch/i,
      );
    });
  });

  // ── Plan 06-05 ORG-01 — approve/reject ────────────────────────────────────

  describe("approveEmployee", () => {
    it("flips PENDING → ACTIVE + audit log", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1",
        name: "Ali",
        organizationId: "inst-1",
        status: "PENDING",
      });
      mockPrisma.user.update.mockResolvedValue({ id: "u-1", status: "ACTIVE" });
      mockPrisma.aiAuditLog.create.mockResolvedValue({ id: "audit-1" });
      const result = await service.approveEmployee("inst-1", "u-1");
      expect(result.status).toBe("ACTIVE");
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issueType: "EMPLOYEE_APPROVE" }),
        }),
      );
    });

    it("rejects when target belongs to another institution", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1",
        organizationId: "OTHER",
        status: "PENDING",
      });
      await expect(service.approveEmployee("inst-1", "u-1")).rejects.toThrow(
        /tegishli emas/i,
      );
    });
  });

  describe("rejectEmployee", () => {
    it("requires reason >= 3 chars", async () => {
      await expect(service.rejectEmployee("inst-1", "u-1", "  ")).rejects.toThrow(
        /sababi/i,
      );
    });

    it("flips PENDING → BLOCKED + audit log with reason", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u-1",
        name: "Bek",
        organizationId: "inst-1",
        status: "PENDING",
      });
      mockPrisma.user.update.mockResolvedValue({ id: "u-1", status: "BLOCKED" });
      mockPrisma.aiAuditLog.create.mockResolvedValue({ id: "audit-1" });
      const result = await service.rejectEmployee("inst-1", "u-1", "Hujjat yo'q");
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toBe("Hujjat yo'q");
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: "EMPLOYEE_REJECT",
            analysis: expect.stringContaining("Hujjat yo'q"),
          }),
        }),
      );
    });
  });

  // ── Plan 06-05 ORG-07 — ProfBook ownership + ISBN validation ─────────────

  describe("addProfBook validation", () => {
    it("rejects empty title", async () => {
      await expect(
        service.addProfBook("inst-1", "admin-1", { title: "", author: "X" }),
      ).rejects.toThrow(/nomi/i);
    });

    it("rejects bad ISBN-13", async () => {
      await expect(
        service.addProfBook("inst-1", "admin-1", {
          title: "T",
          author: "A",
          isbn: "1234567890123",
        }),
      ).rejects.toThrow(/ISBN/i);
    });

    it("accepts valid ISBN-13", async () => {
      mockPrisma.profBook.create.mockResolvedValue({ id: "pb-1" });
      await service.addProfBook("inst-1", "admin-1", {
        title: "T",
        author: "A",
        isbn: "9780000000002",
      });
      expect(mockPrisma.profBook.create).toHaveBeenCalled();
    });
  });

  describe("removeProfBook scoped", () => {
    it("blocks cross-institution deletion", async () => {
      mockPrisma.profBook.findUnique.mockResolvedValue({
        id: "pb-1",
        institutionId: "OTHER",
      });
      await expect(service.removeProfBook("inst-1", "pb-1")).rejects.toThrow(
        /boshqa muassasaga/i,
      );
    });

    it("deletes when ownership matches", async () => {
      mockPrisma.profBook.findUnique.mockResolvedValue({
        id: "pb-1",
        institutionId: "inst-1",
      });
      mockPrisma.profBook.delete.mockResolvedValue({ id: "pb-1" });
      await service.removeProfBook("inst-1", "pb-1");
      expect(mockPrisma.profBook.delete).toHaveBeenCalledWith({ where: { id: "pb-1" } });
    });
  });

  // ── Plan 06-05 ORG-06 — subscription gate on PQ-9 PDF ────────────────────

  // ── Plan 06-05-fix FIX B — systemic _assertScope cross-org regressions ───
  //
  // MUASSASA_ADMIN of inst-1 attempting to access inst-2 via institutionId
  // MUST throw ForbiddenException on every institutionId-keyed method.

  describe("FIX B: systemic cross-org rejection (ForbiddenException)", () => {
    const scopedOther: any = {
      role: "MUASSASA_ADMIN",
      organizationId: "OTHER-INST",
      address: { viloyatId: "v-1", tumanId: "t-1" },
    };

    beforeEach(() => {
      mockPrisma.institution.findUnique.mockResolvedValue({
        id: "inst-1",
        type: "IDORA",
        viloyatId: "v-1",
        tumanId: "t-1",
      });
    });

    it("getInternalRating throws on cross-org caller", async () => {
      await expect(
        service.getInternalRating("inst-1", undefined, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("getBookCorner throws on cross-org caller", async () => {
      await expect(
        service.getBookCorner("inst-1", scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("upsertBookCorner throws on cross-org caller", async () => {
      await expect(
        service.upsertBookCorner("inst-1", {}, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("getReadingHours throws on cross-org caller", async () => {
      await expect(
        service.getReadingHours("inst-1", 1, 20, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("createReadingHour throws on cross-org caller", async () => {
      await expect(
        service.createReadingHour("inst-1", "admin-1", { heldAt: "2026-01-01" }, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("markAttendance throws on cross-org caller", async () => {
      await expect(
        service.markAttendance("inst-1", "rh-1", ["u-1"], scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("getReadingHourStats throws on cross-org caller", async () => {
      await expect(
        service.getReadingHourStats("inst-1", scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("getProfBooks throws on cross-org caller", async () => {
      await expect(
        service.getProfBooks("inst-1", undefined, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("getDepartments throws on cross-org caller", async () => {
      await expect(
        service.getDepartments("inst-1", scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("createDepartment throws on cross-org caller", async () => {
      await expect(
        service.createDepartment("inst-1", { name: "X" }, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("updateDepartment throws on cross-org caller (scope guard, before ownership check)", async () => {
      await expect(
        service.updateDepartment("inst-1", "dep-1", { name: "X" }, scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("deleteDepartment throws on cross-org caller", async () => {
      await expect(
        service.deleteDepartment("inst-1", "dep-1", scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });

    it("composePq9Data throws on cross-org caller", async () => {
      await expect(
        service.composePq9Data("inst-1", scopedOther),
      ).rejects.toThrow(/Scope mismatch/i);
    });
  });

  describe("generatePq9Report subscription gate", () => {
    beforeEach(() => {
      mockPrisma.institution.findUnique.mockResolvedValue(makeInstitution({ libraryId: "lib-1" }));
      mockPrisma.bookCorner.findFirst.mockResolvedValue(makeBookCorner());
      mockPrisma.readingHour.count.mockResolvedValueOnce(8).mockResolvedValueOnce(2);
      mockPrisma.readingHour.findFirst.mockResolvedValue({ heldAt: new Date() });
      mockPrisma.orgRating.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.profBook.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.aiAuditLog.findMany.mockResolvedValue([]);
    });

    it("throws ForbiddenException when subscription is FROZEN", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "FROZEN" });
      const scoped: any = { role: "MUASSASA_ADMIN", organizationId: "inst-1" };
      await expect(service.generatePq9Report("inst-1", scoped)).rejects.toThrow(
        /muzlatilgan|o'chirilgan/i,
      );
    });

    it("allows TRIAL subscription", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "TRIAL" });
      const scoped: any = { role: "MUASSASA_ADMIN", organizationId: "inst-1" };
      const result = await service.generatePq9Report("inst-1", scoped);
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("SUPER_ADMIN bypasses subscription gate", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "FROZEN" });
      const scoped: any = { role: "SUPER_ADMIN" };
      const result = await service.generatePq9Report("inst-1", scoped);
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });
});
