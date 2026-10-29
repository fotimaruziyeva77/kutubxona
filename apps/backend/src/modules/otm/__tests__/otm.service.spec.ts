import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { UserType, UserRole } from "@prisma/client";
import { OtmService } from "../otm.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PdfService } from "../../../infra/pdf/pdf.service";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
  },
  institution: { findUnique: jest.fn(), findMany: jest.fn() },
  bookTransaction: { count: jest.fn() },
  club: { count: jest.fn() },
  schoolRating: { findMany: jest.fn() },
  profBook: { findMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  subscription: { findFirst: jest.fn() },
  readingIndex: { count: jest.fn() },
  book: { count: jest.fn() },
  aiAuditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
  $queryRaw: jest.fn(),
} as any;

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
};

const mockPdf = {
  generateFromHtml: jest.fn().mockResolvedValue(Buffer.from("PDF")),
  generateAkkreditatsiyaReport: jest.fn().mockReturnValue("<html>akkredit</html>"),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeInstitution = (overrides: object = {}) => ({
  id: "inst-1",
  name: "Toshkent Davlat Universiteti",
  code: "TDU",
  tumanId: "tuman-1",
  viloyatId: "viloyat-1",
  type: "OTM",
  libraryId: null,
  ...overrides,
});

const makeStudent = (overrides: object = {}) => ({
  id: "user-1",
  name: "Alisher Navoiy",
  phone: "+998901234567",
  universityId: "inst-1",
  type: UserType.STUDENT_UNIVERSITY,
  status: "ACTIVE",
  faculty: "Informatika",
  direction: "Dasturiy injiniring",
  studyCourse: 1,
  readingIndex: [{ score: 72.5, calculatedAt: new Date() }],
  ...overrides,
});

const SUPER = { role: UserRole.SUPER_ADMIN, sub: "admin-1" } as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("OtmService", () => {
  let service: OtmService;

  beforeEach(() => {
    // Plan 06-07 — full reset between tests so queued mockResolvedValueOnce
    // queues from a prior test don't leak.
    jest.resetAllMocks();
    mockCache.remember.mockImplementation(
      (_k: string, _t: number, fn: () => unknown) => fn(),
    );
    mockPdf.generateFromHtml.mockResolvedValue(Buffer.from("PDF"));
    mockPdf.generateAkkreditatsiyaReport.mockReturnValue("<html>akk</html>");
    mockPrisma.aiAuditLog.create.mockResolvedValue({ id: "audit-1" });
    service = new OtmService(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as CacheService,
      mockPdf as unknown as PdfService,
    );
  });

  // ── getStudents ────────────────────────────────────────────────────────────

  describe("getStudents", () => {
    it("returns paginated student list", async () => {
      const students = [makeStudent()];
      mockPrisma.user.findMany.mockResolvedValue(students);
      mockPrisma.user.count.mockResolvedValue(1);

      const result = await service.getStudents("inst-1", {});

      expect(result).toEqual({
        data: [expect.objectContaining({ latestRi: { score: 72.5, calculatedAt: expect.any(Date) } })],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it("maps latestRi to null when readingIndex is empty", async () => {
      mockPrisma.user.findMany.mockResolvedValue([makeStudent({ readingIndex: [] })]);
      mockPrisma.user.count.mockResolvedValue(1);

      const result = await service.getStudents("inst-1", {});
      expect(result.data[0].latestRi).toBeNull();
    });

    it("queries with universityId + STUDENT_UNIVERSITY (UNI-01 P1 regression)", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);

      await service.getStudents("inst-1", {});

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            universityId: "inst-1",
            type: UserType.STUDENT_UNIVERSITY,
          }),
        }),
      );
      const callArg = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArg.where.schoolId).toBeUndefined();
      expect(callArg.where.type).not.toBe("STUDENT");
    });

    it("scope-guards via assertInstitutionInScope (calls institution.findUnique with user)", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());

      await service.getStudents("inst-1", {}, SUPER);
      expect(mockPrisma.institution.findUnique).toHaveBeenCalled();
    });

    it("throws when institution not found during scope-resolve", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getStudents("bad-inst", {}, SUPER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── getStudentsByFaculty (UNI-01/02) ───────────────────────────────────────

  describe("getStudentsByFaculty", () => {
    it("returns all students in a faculty (no K-anon at row grain)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      const seed = [
        makeStudent({ id: "u1", faculty: "Inf" }),
        makeStudent({ id: "u2", faculty: "Inf" }),
        makeStudent({ id: "u3", faculty: "Inf" }),
      ];
      mockPrisma.user.findMany.mockResolvedValue(seed);

      const out = await service.getStudentsByFaculty("inst-1", "Inf", SUPER);
      expect(out.total).toBe(3);
      expect(out.data).toHaveLength(3);
      expect(out.faculty).toBe("Inf");
    });

    it("uses STUDENT_UNIVERSITY + universityId + faculty in where clause (Wave 0 regression)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findMany.mockResolvedValue([]);

      await service.getStudentsByFaculty("inst-1", "Matematika", SUPER);

      const callArg = mockPrisma.user.findMany.mock.calls[0][0];
      expect(callArg.where).toEqual(
        expect.objectContaining({
          universityId: "inst-1",
          type: UserType.STUDENT_UNIVERSITY,
          faculty: "Matematika",
        }),
      );
    });
  });

  // ── approveStudent ─────────────────────────────────────────────────────────

  describe("approveStudent", () => {
    it("sets user status to ACTIVE and invalidates cache + writes audit log", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        universityId: "inst-1",
        type: UserType.STUDENT_UNIVERSITY,
      });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1", status: "ACTIVE" });

      const result = await service.approveStudent("user-1", "inst-1", SUPER);

      expect(mockCache.del).toHaveBeenCalledWith("otm:stats:inst-1");
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { status: "ACTIVE" },
      });
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: "OTM_STUDENT_APPROVE",
            scope: "USER",
            scopeId: "user-1",
          }),
        }),
      );
      expect(result.status).toBe("ACTIVE");
    });

    it("throws NotFoundException when user does not exist", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.approveStudent("bad-id", "inst-1", SUPER),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws when user belongs to different OTM (UNI-02 P1 regression)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        universityId: "other-inst",
        type: UserType.STUDENT_UNIVERSITY,
      });
      await expect(
        service.approveStudent("user-1", "inst-1", SUPER),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws when user is not a STUDENT_UNIVERSITY (UNI-02 P1)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        universityId: "inst-1",
        type: UserType.CITIZEN,
      });
      await expect(
        service.approveStudent("user-1", "inst-1", SUPER),
      ).rejects.toThrow(NotFoundException);
    });

    it("MUASSASA_ADMIN with mismatched universityId is rejected by scope guard", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      const wrongScopeUser = {
        role: UserRole.MUASSASA_ADMIN,
        universityId: "different-inst",
        sub: "muassasa-1",
      } as any;
      await expect(
        service.approveStudent("user-1", "inst-1", wrongScopeUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── rejectStudent (UNI-01) ─────────────────────────────────────────────────

  describe("rejectStudent", () => {
    it("flips status to BLOCKED + writes audit log with reason", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        universityId: "inst-1",
        type: UserType.STUDENT_UNIVERSITY,
      });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1", status: "BLOCKED" });

      await service.rejectStudent("user-1", "inst-1", "Hujjat noto'g'ri", SUPER);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { status: "BLOCKED" },
      });
      const auditCall = mockPrisma.aiAuditLog.create.mock.calls.find(
        (c: any) => c[0]?.data?.issueType === "OTM_STUDENT_REJECT",
      );
      expect(auditCall).toBeDefined();
      expect(auditCall[0].data.analysis).toContain("Hujjat noto'g'ri");
    });

    it("rejects empty or too-short reason", async () => {
      await expect(
        service.rejectStudent("user-1", "inst-1", "", SUPER),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.rejectStudent("user-1", "inst-1", "ok", SUPER),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getOtmStats ────────────────────────────────────────────────────────────

  describe("getOtmStats", () => {
    function setupStats(facultyBuckets: Array<{ faculty: string | null; _count: { id: number } }>) {
      mockPrisma.institution.findUnique.mockReset();
      mockPrisma.user.count.mockReset();
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.bookTransaction.count.mockReset();
      mockPrisma.club.count.mockReset();
      mockPrisma.user.groupBy.mockReset();

      // First findUnique for scope-resolve (with super, scope is bypassed but
      // we still need the row), then findUnique inside cache for stats body.
      mockPrisma.institution.findUnique
        .mockResolvedValueOnce(makeInstitution())
        .mockResolvedValueOnce(makeInstitution());
      mockPrisma.user.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(10);
      // avgRi (overall), per-faculty avgRi join, tenBookGoal
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ avg: 65.4 }])
        .mockResolvedValueOnce([{ count: BigInt(42) }])
        .mockResolvedValueOnce(
          facultyBuckets
            .filter((b) => b.faculty)
            .map((b) => ({ faculty: b.faculty as string, avg: 70 })),
        );
      mockPrisma.bookTransaction.count.mockResolvedValue(250);
      mockPrisma.club.count.mockResolvedValue(3);
      mockPrisma.user.groupBy
        .mockResolvedValueOnce(facultyBuckets) // facultyBucketsRaw
        .mockResolvedValueOnce([
          { direction: "Dasturiy injiniring", _count: { id: 18 } },
        ]) // courseBucketsRaw
        .mockResolvedValueOnce([
          { studyCourse: 1, _count: { id: 18 } },
        ]); // byCourseRaw
    }

    it("returns comprehensive OTM statistics with byFaculty + K-anon", async () => {
      setupStats([
        { faculty: "Informatika", _count: { id: 30 } },
        { faculty: "Matematika", _count: { id: 25 } },
      ]);

      const result = await service.getOtmStats("inst-1", SUPER);

      expect(result).toMatchObject({
        institutionId: "inst-1",
        students: { total: 100, active: 80, pending: 10 },
        coverageRate: 80,
      });
      expect(result.byFaculty).toHaveLength(2);
      expect(result.byFaculty[0]).toMatchObject({
        faculty: "Informatika",
        studentCount: 30,
        kAnonymitySuppressed: false,
      });
      expect(result.byCourse).toHaveLength(1);
    });

    it("K-anonymity: faculty with studentCount < 5 suppresses avgRi", async () => {
      setupStats([
        { faculty: "Informatika", _count: { id: 30 } },
        { faculty: "TinyFac", _count: { id: 3 } }, // < 5
      ]);

      const result = await service.getOtmStats("inst-1", SUPER);
      const tiny = result.byFaculty.find((f: any) => f.faculty === "TinyFac");
      expect(tiny).toMatchObject({
        studentCount: 3,
        avgRi: null,
        kAnonymitySuppressed: true,
      });
      const big = result.byFaculty.find((f: any) => f.faculty === "Informatika");
      expect(big?.kAnonymitySuppressed).toBe(false);
    });

    it("uses cache.remember with 300 seconds ttl", async () => {
      setupStats([]);
      // Reset call count for cache
      (mockCache.remember as jest.Mock).mockClear();
      await service.getOtmStats("inst-1", SUPER);
      expect(mockCache.remember).toHaveBeenCalledWith(
        "otm:stats:inst-1",
        300,
        expect.any(Function),
      );
    });

    it("counts students by universityId + STUDENT_UNIVERSITY (UNI-02 P1 regression)", async () => {
      setupStats([]);
      await service.getOtmStats("inst-1", SUPER);
      const countCall = mockPrisma.user.count.mock.calls[0][0];
      expect(countCall.where).toEqual(
        expect.objectContaining({
          universityId: "inst-1",
          type: UserType.STUDENT_UNIVERSITY,
        }),
      );
    });

    it("throws NotFoundException when institution not found (scope-resolve)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.getOtmStats("bad-inst", SUPER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── getProfBooks ───────────────────────────────────────────────────────────

  describe("getProfBooks", () => {
    it("returns paginated professional books", async () => {
      const books = [{ id: "b-1", title: "Algoritmlar", author: "Knuth" }];
      mockPrisma.profBook.findMany.mockResolvedValue(books);
      mockPrisma.profBook.count.mockResolvedValue(1);

      const result = await service.getProfBooks("inst-1", {});
      expect(result).toEqual({ data: books, total: 1, limit: 50, offset: 0 });
    });

    it("applies genre filter", async () => {
      mockPrisma.profBook.findMany.mockResolvedValue([]);
      mockPrisma.profBook.count.mockResolvedValue(0);

      await service.getProfBooks("inst-1", { genre: "Informatika", limit: 5, offset: 10 });

      expect(mockPrisma.profBook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { institutionId: "inst-1", genre: "Informatika" },
          skip: 10,
          take: 5,
        })
      );
    });
  });

  // ── addProfBook ────────────────────────────────────────────────────────────

  describe("addProfBook", () => {
    it("creates a professional book record", async () => {
      const book = { id: "b-1", title: "Algoritmlar", author: "Knuth", institutionId: "inst-1" };
      mockPrisma.profBook.create.mockResolvedValue(book);

      const result = await service.addProfBook("inst-1", {
        title: "Algoritmlar",
        author: "Knuth",
        addedById: "admin-1",
      });

      expect(mockPrisma.profBook.create).toHaveBeenCalledWith({
        data: { institutionId: "inst-1", title: "Algoritmlar", author: "Knuth", addedById: "admin-1" },
      });
      expect(result).toEqual(book);
    });
  });

  // ── getOtmRankings ─────────────────────────────────────────────────────────

  describe("getOtmRankings", () => {
    it("returns rankings with institution details", async () => {
      const rankings = [
        { institutionId: "inst-1", totalScore: 90.5, month: "2026-04", rank: null },
        { institutionId: "inst-2", totalScore: 85.0, month: "2026-04", rank: 2 },
      ];
      mockPrisma.schoolRating.findMany.mockResolvedValue(rankings);
      mockPrisma.institution.findMany.mockResolvedValue([
        makeInstitution({ id: "inst-1" }),
        makeInstitution({ id: "inst-2", name: "Samarqand Universiteti" }),
      ]);

      const result = await service.getOtmRankings({});
      expect(result).toHaveLength(2);
      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
    });

    it("filters by viloyatId", async () => {
      mockPrisma.schoolRating.findMany.mockResolvedValue([]);
      mockPrisma.institution.findMany.mockResolvedValue([]);

      await service.getOtmRankings({ viloyatId: "viloyat-1", limit: 10 });

      expect(mockPrisma.schoolRating.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            institution: { viloyatId: "viloyat-1", type: "OTM" },
          }),
          take: 10,
        })
      );
    });
  });

  // ── composeAccreditationData + generateAccreditationReport ────────────────

  describe("Akkreditatsiya PDF (UNI-03)", () => {
    // The akkreditatsiya flow calls findUnique many times across (1) scope
    // resolve, (2) subscription gate, (3) getOtmStats body, and (4)
    // composeAccreditationData. Using mockResolvedValue (NOT once) returns the
    // same row for every call, which is the cleanest for these aggregate tests.
    function seedStatsAndProfBooks() {
      mockPrisma.institution.findUnique.mockResolvedValue(
        makeInstitution({ libraryId: "lib-1" }),
      );
      mockPrisma.user.count.mockResolvedValue(80);
      mockPrisma.$queryRaw.mockResolvedValue([{ avg: 70.0, count: BigInt(50) }]);
      mockPrisma.bookTransaction.count.mockResolvedValue(300);
      mockPrisma.club.count.mockResolvedValue(5);
      mockPrisma.user.groupBy.mockResolvedValue([]);
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "ACTIVE" });
      mockPrisma.book.count.mockResolvedValue(50);
      mockPrisma.readingIndex.count.mockResolvedValue(80);
      mockPrisma.profBook.findMany.mockResolvedValue([
        { id: "b-1", title: "Algoritmlar", author: "Knuth", genre: "CS", isRequired: true },
      ]);
      mockPrisma.profBook.count.mockResolvedValue(1);
    }

    it("composeAccreditationData returns Pq9OtmReport shape", async () => {
      seedStatsAndProfBooks();
      const data = await (service as any).composeAccreditationData("inst-1", SUPER);
      expect(data.scope).toBe("OTM");
      expect(data.institution.name).toBe("Toshkent Davlat Universiteti");
      expect(Array.isArray(data.byFaculty)).toBe(true);
      expect(Array.isArray(data.digitalLibraryChecklist)).toBe(true);
      expect(Array.isArray(data.profBooks)).toBe(true);
      expect(data.profBooks[0]).toMatchObject({ title: "Algoritmlar", author: "Knuth" });
      // D-Q7: no per-student PII
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain("phone");
    });

    it("digitalLibraryChecklist marks PASS when counts > 0", async () => {
      seedStatsAndProfBooks();
      const data = await (service as any).composeAccreditationData("inst-1", SUPER);
      const catalog = data.digitalLibraryChecklist.find((c: any) =>
        c.criterion.includes("Elektron katalog"),
      );
      expect(catalog.status).toBe("PASS");
    });

    it("subscription gate: FROZEN throws ForbiddenException for non-super", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue(
        makeInstitution({ libraryId: "lib-1" }),
      );
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "FROZEN" });

      const muassasa = {
        role: UserRole.MUASSASA_ADMIN,
        universityId: "inst-1",
        sub: "muassasa-1",
      } as any;

      await expect(
        service.generateAccreditationReport("inst-1", muassasa),
      ).rejects.toThrow(ForbiddenException);
    });

    it("subscription gate: SUPER_ADMIN bypasses FROZEN", async () => {
      seedStatsAndProfBooks();
      mockPrisma.subscription.findFirst.mockResolvedValue({ status: "FROZEN" });
      const result = await service.generateAccreditationReport("inst-1", SUPER);
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("generates a PDF via PdfService.generateAkkreditatsiyaReport + generateFromHtml", async () => {
      seedStatsAndProfBooks();
      const result = await service.generateAccreditationReport("inst-1", SUPER);
      expect(mockPdf.generateAkkreditatsiyaReport).toHaveBeenCalled();
      expect(mockPdf.generateFromHtml).toHaveBeenCalled();
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });
});
