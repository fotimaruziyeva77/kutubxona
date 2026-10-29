/**
 * Plan 06-07 UNI-01/02 — INTEGRATION canary that exercises the Wave 0 P1 fix
 * end-to-end with a seeded in-memory dataset.
 *
 * Why this spec exists: the original Plan 06-01 P1 (schoolId + "STUDENT"
 * literal) silently returned EMPTY in production. Unit tests would have
 * matched against schoolId mocks and missed the bug. This integration spec
 * seeds 5 STUDENT_UNIVERSITY users + 1 OTM institution into a stub Prisma,
 * then asserts:
 *   1) getStudents returns 5 (not 0).
 *   2) getOtmStats.byFaculty has 2 buckets, with K-anon suppression on the
 *      small faculty (count<5).
 *   3) approveStudent flips a PENDING user → ACTIVE.
 *
 * No real DB — just a tight in-memory shim driven through the service public
 * API. This catches WHERE-clause / enum / FK regressions that would silently
 * return an empty result set against a real DB too.
 */

import { UserType, UserRole } from "@prisma/client";
import { OtmService } from "../otm.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PdfService } from "../../../infra/pdf/pdf.service";

type Student = {
  id: string;
  name: string;
  universityId: string | null;
  type: UserType;
  status: "PENDING" | "ACTIVE" | "BLOCKED";
  faculty: string | null;
  studyCourse: number | null;
  direction: string | null;
  readingIndex: Array<{ score: number; calculatedAt: Date }>;
};

const SUPER = { role: UserRole.SUPER_ADMIN, sub: "admin-1" } as any;

function seedStudents(): Student[] {
  const now = new Date();
  return [
    // Faculty A (Informatika) — 6 students (>= K_ANONYMITY_THRESHOLD=5).
    { id: "u1", name: "A1", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 1, direction: "SE", readingIndex: [{ score: 70, calculatedAt: now }] },
    { id: "u2", name: "A2", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 2, direction: "SE", readingIndex: [{ score: 75, calculatedAt: now }] },
    { id: "u3", name: "A3", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 2, direction: "SE", readingIndex: [{ score: 65, calculatedAt: now }] },
    { id: "u4", name: "A4", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 3, direction: "SE", readingIndex: [{ score: 80, calculatedAt: now }] },
    { id: "u5", name: "A5", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "PENDING", faculty: "Informatika", studyCourse: 1, direction: "SE", readingIndex: [] },
    { id: "u6", name: "A6", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 1, direction: "SE", readingIndex: [{ score: 60, calculatedAt: now }] },
    // Faculty B (Matematika) — 2 students (< K_ANONYMITY_THRESHOLD).
    { id: "u7", name: "B1", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Matematika", studyCourse: 2, direction: "M", readingIndex: [{ score: 50, calculatedAt: now }] },
    { id: "u8", name: "B2", universityId: "inst-1", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Matematika", studyCourse: 3, direction: "M", readingIndex: [{ score: 55, calculatedAt: now }] },
    // Bogus row that should NOT match (different uni).
    { id: "u9", name: "X1", universityId: "other", type: UserType.STUDENT_UNIVERSITY, status: "ACTIVE", faculty: "Informatika", studyCourse: 1, direction: "SE", readingIndex: [] },
    // Bogus row that should NOT match (wrong type).
    { id: "u10", name: "X2", universityId: "inst-1", type: UserType.CITIZEN, status: "ACTIVE", faculty: null, studyCourse: null, direction: null, readingIndex: [] },
  ];
}

function makePrismaShim(students: Student[]): any {
  const matches = (w: any, s: Student) => {
    if (w.universityId && w.universityId !== s.universityId) return false;
    if (w.type && w.type !== s.type) return false;
    if (w.status && w.status !== s.status) return false;
    if (w.faculty) {
      if (typeof w.faculty === "string") {
        if (s.faculty !== w.faculty) return false;
      } else if (w.faculty.not !== undefined) {
        if (s.faculty == null) return false;
      }
    }
    return true;
  };

  return {
    user: {
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(students.find((s) => s.id === where.id) ?? null),
      ),
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(students.filter((s) => matches(where, s))),
      ),
      count: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(students.filter((s) => matches(where, s)).length),
      ),
      groupBy: jest.fn().mockImplementation(({ where, by }: any) => {
        const filtered = students.filter((s) => matches(where, s));
        if (by[0] === "faculty") {
          const counts = new Map<string, number>();
          for (const s of filtered) {
            if (s.faculty) counts.set(s.faculty, (counts.get(s.faculty) ?? 0) + 1);
          }
          return Promise.resolve(
            Array.from(counts.entries()).map(([faculty, n]) => ({
              faculty,
              _count: { id: n },
            })),
          );
        }
        if (by[0] === "studyCourse") {
          const counts = new Map<number, number>();
          for (const s of filtered) {
            if (s.studyCourse) counts.set(s.studyCourse, (counts.get(s.studyCourse) ?? 0) + 1);
          }
          return Promise.resolve(
            Array.from(counts.entries()).map(([studyCourse, n]) => ({
              studyCourse,
              _count: { id: n },
            })),
          );
        }
        if (by[0] === "direction") {
          const counts = new Map<string, number>();
          for (const s of filtered) {
            if (s.direction) counts.set(s.direction, (counts.get(s.direction) ?? 0) + 1);
          }
          return Promise.resolve(
            Array.from(counts.entries()).map(([direction, n]) => ({
              direction,
              _count: { id: n },
            })),
          );
        }
        return Promise.resolve([]);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const i = students.findIndex((s) => s.id === where.id);
        if (i >= 0) {
          students[i] = { ...students[i], ...data };
        }
        return Promise.resolve(students[i]);
      }),
    },
    institution: {
      findUnique: jest.fn().mockResolvedValue({
        id: "inst-1",
        name: "Test University",
        type: "OTM",
        viloyatId: "v1",
        tumanId: "t1",
        libraryId: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    bookTransaction: { count: jest.fn().mockResolvedValue(0) },
    club: { count: jest.fn().mockResolvedValue(0) },
    schoolRating: { findMany: jest.fn().mockResolvedValue([]) },
    profBook: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    readingIndex: { count: jest.fn().mockResolvedValue(0) },
    book: { count: jest.fn().mockResolvedValue(0) },
    aiAuditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
    $queryRaw: jest.fn().mockImplementation(() => {
      // For Reading Index avgRi raw queries — return 0 (we'll exercise byFaculty
      // count K-anon logic, not the rawAvg computation).
      return Promise.resolve([{ avg: 0, count: BigInt(0) }]);
    }),
  };
}

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
};
const mockPdf = {
  generateFromHtml: jest.fn().mockResolvedValue(Buffer.from("PDF")),
  generateAkkreditatsiyaReport: jest.fn().mockReturnValue("<html/>"),
};

describe("OtmService integration — Wave 0 P1 regression canary", () => {
  let service: OtmService;
  let students: Student[];
  let prisma: any;

  beforeEach(() => {
    students = seedStudents();
    prisma = makePrismaShim(students);
    service = new OtmService(
      prisma as unknown as PrismaService,
      mockCache as unknown as CacheService,
      mockPdf as unknown as PdfService,
    );
  });

  it("getStudents returns 8 STUDENT_UNIVERSITY of inst-1 (NOT 0 — Wave 0 regression)", async () => {
    const out = await service.getStudents("inst-1", {}, SUPER);
    // 8 matching: u1..u6 + u7..u8 = 8 (u9 is other uni, u10 is CITIZEN)
    expect(out.total).toBe(8);
    expect(out.data).toHaveLength(8);
    // Every returned row MUST be STUDENT_UNIVERSITY + correct universityId.
    for (const s of out.data) {
      expect(s.universityId).toBe("inst-1");
      expect(s.type).toBe(UserType.STUDENT_UNIVERSITY);
    }
  });

  it("getOtmStats.byFaculty has 2 buckets; Matematika has K-anon suppressed (count=2 < 5)", async () => {
    const stats = await service.getOtmStats("inst-1", SUPER);
    expect(stats.byFaculty).toHaveLength(2);
    const informatika = stats.byFaculty.find((f: any) => f.faculty === "Informatika");
    const matematika = stats.byFaculty.find((f: any) => f.faculty === "Matematika");
    expect(informatika).toBeDefined();
    expect(matematika).toBeDefined();
    // Informatika has 5 ACTIVE (u1, u2, u3, u4, u6) — exactly K_THRESHOLD, not suppressed.
    expect(informatika?.studentCount).toBe(5);
    expect(informatika?.kAnonymitySuppressed).toBe(false);
    // Matematika has 2 ACTIVE (u7, u8) — < 5, suppressed.
    expect(matematika?.studentCount).toBe(2);
    expect(matematika?.kAnonymitySuppressed).toBe(true);
    expect(matematika?.avgRi).toBeNull();
  });

  it("approveStudent flips PENDING u5 → ACTIVE", async () => {
    expect(students.find((s) => s.id === "u5")?.status).toBe("PENDING");
    await service.approveStudent("u5", "inst-1", SUPER);
    expect(students.find((s) => s.id === "u5")?.status).toBe("ACTIVE");
    expect(prisma.aiAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueType: "OTM_STUDENT_APPROVE",
        }),
      }),
    );
  });
});
