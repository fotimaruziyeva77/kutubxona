/**
 * Plan 06-07 UNI-04 — StudentProgressService unit tests.
 *
 * Covers:
 *   - getProgressForFaculty: scope-guarded; faculty admin restricted to OWN
 *     faculty; K-anon byCourse buckets < 5; SUPER_ADMIN bypass.
 *   - getStudentSelfProgress: only STUDENT_UNIVERSITY callers; userId taken
 *     from JWT.sub (never request param — T-06-U5 mitigation).
 */
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { UserType, UserRole } from "@prisma/client";
import { StudentProgressService } from "../student-progress.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";

const mkPrisma = (): any => ({
  user: {
    findUnique: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  institution: { findUnique: jest.fn() },
  readingIndex: { findMany: jest.fn() },
  bookTransaction: { count: jest.fn() },
  clubMember: { count: jest.fn() },
  $queryRaw: jest.fn(),
});

const SUPER = { role: UserRole.SUPER_ADMIN, sub: "admin-1" } as any;
const MUASSASA = (faculty: string | null) => ({
  role: UserRole.MUASSASA_ADMIN,
  universityId: "inst-1",
  sub: "muassasa-1",
  faculty,
} as any);

describe("StudentProgressService", () => {
  let svc: StudentProgressService;
  let prisma: any;

  beforeEach(() => {
    prisma = mkPrisma();
    svc = new StudentProgressService(prisma as unknown as PrismaService);
  });

  // ── getProgressForFaculty ────────────────────────────────────────────────

  describe("getProgressForFaculty (admin view)", () => {
    function seedInst() {
      prisma.institution.findUnique.mockResolvedValueOnce({
        id: "inst-1",
        type: "OTM",
        viloyatId: "v1",
        tumanId: "t1",
        name: "Test University",
      });
    }

    it("rejects empty facultyId", async () => {
      await expect(
        svc.getProgressForFaculty("inst-1", "", SUPER),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFound when institution missing", async () => {
      prisma.institution.findUnique.mockResolvedValueOnce(null);
      await expect(
        svc.getProgressForFaculty("inst-1", "Inf", SUPER),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns aggregated byCourse + byMonth (no per-student PII)", async () => {
      seedInst();
      prisma.user.count.mockResolvedValueOnce(30); // studentCount
      prisma.user.groupBy.mockResolvedValueOnce([
        { studyCourse: 1, _count: { id: 10 } },
        { studyCourse: 2, _count: { id: 8 } },
        { studyCourse: 3, _count: { id: 7 } },
        { studyCourse: 4, _count: { id: 5 } },
      ]);
      // rawAvg per-course
      prisma.$queryRaw.mockResolvedValueOnce([
        { studyCourse: 1, avg: 70 },
        { studyCourse: 2, avg: 72 },
        { studyCourse: 3, avg: 68 },
        { studyCourse: 4, avg: 75 },
      ]);
      // byMonth
      prisma.$queryRaw.mockResolvedValueOnce([
        { ym: "2026-04", avg: 70, n: BigInt(20) },
        { ym: "2026-05", avg: 72, n: BigInt(22) },
      ]);

      const out = await svc.getProgressForFaculty("inst-1", "Informatika", SUPER);
      expect(out.facultyName).toBe("Informatika");
      expect(out.studentCount).toBe(30);
      expect(out.byCourse).toHaveLength(4);
      for (const c of out.byCourse) {
        expect(c.kAnonymitySuppressed).toBe(false);
      }
      const serialized = JSON.stringify(out);
      // D-OQ-3: no per-student names in admin view.
      expect(serialized).not.toContain("phone");
    });

    it("K-anonymity: course bucket with count < 5 suppresses avgRi", async () => {
      seedInst();
      prisma.user.count.mockResolvedValueOnce(8);
      prisma.user.groupBy.mockResolvedValueOnce([
        { studyCourse: 1, _count: { id: 6 } },
        { studyCourse: 2, _count: { id: 2 } }, // < 5
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([
        { studyCourse: 1, avg: 70 },
        { studyCourse: 2, avg: 80 },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const out = await svc.getProgressForFaculty("inst-1", "Informatika", SUPER);
      const big = out.byCourse.find((c: any) => c.course === 1);
      const tiny = out.byCourse.find((c: any) => c.course === 2);
      expect(big?.kAnonymitySuppressed).toBe(false);
      expect(tiny?.kAnonymitySuppressed).toBe(true);
      expect(tiny?.avgRi).toBeNull();
    });

    it("MUASSASA_ADMIN with matching faculty is allowed", async () => {
      seedInst();
      prisma.user.count.mockResolvedValueOnce(10);
      prisma.user.groupBy.mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const muassasa = MUASSASA("Informatika");
      const out = await svc.getProgressForFaculty("inst-1", "Informatika", muassasa);
      expect(out.studentCount).toBe(10);
    });

    it("MUASSASA_ADMIN reading sibling faculty → 403 (T-06-U2)", async () => {
      seedInst();
      const muassasa = MUASSASA("Informatika");
      await expect(
        svc.getProgressForFaculty("inst-1", "Matematika", muassasa),
      ).rejects.toThrow(ForbiddenException);
    });

    it("MUASSASA_ADMIN of different OTM → 403 (institution-level scope)", async () => {
      prisma.institution.findUnique.mockResolvedValueOnce({
        id: "inst-1",
        type: "OTM",
        viloyatId: "v1",
        tumanId: "t1",
        name: "Test University",
      });
      const wrong = { ...MUASSASA("Informatika"), universityId: "other-inst" };
      await expect(
        svc.getProgressForFaculty("inst-1", "Informatika", wrong),
      ).rejects.toThrow(ForbiddenException);
    });

    it("SUPER_ADMIN reads any faculty (no per-faculty restriction)", async () => {
      seedInst();
      prisma.user.count.mockResolvedValueOnce(10);
      prisma.user.groupBy.mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const out = await svc.getProgressForFaculty("inst-1", "any", SUPER);
      expect(out).toBeDefined();
    });
  });

  // ── getStudentSelfProgress ───────────────────────────────────────────────

  describe("getStudentSelfProgress (student-self view)", () => {
    it("returns full personal progress for STUDENT_UNIVERSITY", async () => {
      const now = new Date();
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "stu-1",
        name: "Alisher",
        sifatId: "SL-UZ-08-012-0045-00847",
        type: UserType.STUDENT_UNIVERSITY,
        universityId: "inst-1",
        faculty: "Inf",
        direction: "SE",
        studyCourse: 2,
        status: "ACTIVE",
      });
      prisma.readingIndex.findMany.mockResolvedValueOnce([
        { score: 60, calculatedAt: now },
        { score: 70, calculatedAt: now },
      ]);
      prisma.bookTransaction.count.mockResolvedValueOnce(12);
      prisma.clubMember.count.mockResolvedValueOnce(1);

      const out = await svc.getStudentSelfProgress({
        role: UserRole.KITOBXON,
        sub: "stu-1",
      } as any);
      expect(out.user.id).toBe("stu-1");
      expect(out.currentRi).toBe(70);
      expect(out.monthlySeries).toHaveLength(2);
      expect(out.booksReadThisYear).toBe(12);
      expect(out.clubMembershipCount).toBe(1);
    });

    it("rejects when caller is not STUDENT_UNIVERSITY (T-06-U5)", async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        id: "stu-1",
        type: UserType.CITIZEN,
      });
      await expect(
        svc.getStudentSelfProgress({ role: UserRole.KITOBXON, sub: "stu-1" } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects when sub is missing (no anonymous access)", async () => {
      await expect(
        svc.getStudentSelfProgress({ role: UserRole.KITOBXON } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFound when user missing", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        svc.getStudentSelfProgress({ sub: "ghost", role: UserRole.KITOBXON } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
