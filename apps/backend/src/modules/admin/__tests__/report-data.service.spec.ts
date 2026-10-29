/**
 * Plan 05-08 Task 1 (RPT-01) — ReportDataService.gatherForScope contract.
 */
import { ReportDataService } from "../report-data.service";
import { AdminService } from "../admin.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { K_ANONYMITY_THRESHOLD } from "../../../common/utils/k-anonymity.const";

describe("ReportDataService (Plan 05-08 RPT-01)", () => {
  const periodStart = new Date("2026-05-01T00:00:00Z");
  const periodEnd = new Date("2026-06-01T00:00:00Z");

  const makeReplica = (overrides: Partial<Record<string, unknown>> = {}): PrismaReplicaService => {
    const base = {
      viloyat: { findUnique: jest.fn().mockResolvedValue({ name: "Navoiy" }) },
      tuman: { findUnique: jest.fn().mockResolvedValue({ name: "Karmana" }) },
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([])),
      ...overrides,
    } as unknown as PrismaReplicaService;
    return base;
  };

  const makeAdmin = (): jest.Mocked<Pick<AdminService, "getNationalStats" | "getViloyatStats" | "getTumanStats" | "getGenderBreakdown" | "getAgeBreakdown">> => ({
    getNationalStats: jest.fn().mockResolvedValue({
      users: { total: 1000, active30d: 800, newThisMonth: 50, byGender: { MALE: 500, FEMALE: 500 } },
      libraries: { total: 100, byType: {} },
      books: { total: 50000, available: 30000 },
      transactions: { thisMonth: 1200, lastMonth: 1100, returned: 900, growth: 9.1 },
      readingIndex: { national: 67.3 },
    }),
    getViloyatStats: jest.fn().mockResolvedValue({
      viloyatId: "UZ-08",
      libraries: 80,
      users: 5000,
      transactions30d: 1200,
      readingIndex: 72.1,
    }),
    getTumanStats: jest.fn().mockResolvedValue({
      tumanId: "UZ-08-012",
      libraries: 12,
      users: 800,
      transactionsThisMonth: 200,
      readingIndex: 65.4,
      activeAlerts: 1,
    }),
    getGenderBreakdown: jest.fn().mockResolvedValue({
      buckets: {
        MALE: { count: 500, readingIndex: 65.1, suppressed: false },
        FEMALE: { count: 480, readingIndex: 68.4, suppressed: false },
        UNKNOWN: { count: 0, readingIndex: 0, suppressed: false },
      },
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed: false,
    }),
    getAgeBreakdown: jest.fn().mockResolvedValue({
      buckets: [
        { ageGroup: "7-14", userCount: 150, readingIndex: 70.2, suppressed: false },
        { ageGroup: "15-30", userCount: 400, readingIndex: 68.5, suppressed: false },
        { ageGroup: "31-60", userCount: 380, readingIndex: 62.1, suppressed: false },
        { ageGroup: "60+", userCount: 50, readingIndex: 58.0, suppressed: false },
      ],
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed: false,
    }),
  });

  it("gatherForScope('national') returns the unified ReportData shape", async () => {
    const admin = makeAdmin();
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("national", null, periodStart, periodEnd);

    expect(data.title).toContain("Respublika");
    expect(data.scopeLabel).toBe("Respublika");
    expect(data.tableRows.length).toBeGreaterThan(0);
    expect(data.genderBuckets).toHaveLength(3); // Erkak/Ayol/Noma'lum
    expect(data.ageBuckets.length).toBeGreaterThan(0);
    expect(admin.getNationalStats).toHaveBeenCalled();
    expect(admin.getGenderBreakdown).toHaveBeenCalledWith("national");
    expect(admin.getAgeBreakdown).toHaveBeenCalledWith("national");
  });

  it("gatherForScope('viloyat', id) uses the viloyat name in scopeLabel", async () => {
    const admin = makeAdmin();
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("viloyat", "UZ-08", periodStart, periodEnd);

    expect(data.scopeLabel).toContain("Navoiy");
    expect(data.title).toContain("Navoiy");
    expect(admin.getViloyatStats).toHaveBeenCalledWith("UZ-08");
    expect(admin.getGenderBreakdown).toHaveBeenCalledWith("viloyat", "UZ-08");
  });

  it("gatherForScope('tuman', id) uses the tuman name in scopeLabel", async () => {
    const admin = makeAdmin();
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("tuman", "UZ-08-012", periodStart, periodEnd);

    expect(data.scopeLabel).toContain("Karmana");
    expect(admin.getTumanStats).toHaveBeenCalledWith("UZ-08-012");
    expect(admin.getAgeBreakdown).toHaveBeenCalledWith("tuman", "UZ-08-012");
  });

  it("k-anonymity: small-cell gender buckets are suppressed", async () => {
    const admin = makeAdmin();
    // Force MALE to drop below K_ANONYMITY_THRESHOLD via a fresh mock.
    admin.getGenderBreakdown.mockResolvedValueOnce({
      buckets: {
        MALE: { count: 2, readingIndex: 80, suppressed: false },
        FEMALE: { count: 100, readingIndex: 70, suppressed: false },
        UNKNOWN: { count: 0, readingIndex: 0, suppressed: false },
      },
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed: false,
    });
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("national", null, periodStart, periodEnd);

    const erkak = data.genderBuckets.find((b) => b.label === "Erkak");
    expect(erkak).toBeDefined();
    expect(erkak!.suppressed).toBe(true);
    expect(erkak!.count).toBe(0);
    expect(erkak!.readingIndex).toBe(0);
  });

  it("k-anonymity: small-cell age buckets are suppressed", async () => {
    const admin = makeAdmin();
    admin.getAgeBreakdown.mockResolvedValueOnce({
      buckets: [
        { ageGroup: "7-14", userCount: 1, readingIndex: 80, suppressed: false },
        { ageGroup: "15-30", userCount: 400, readingIndex: 68, suppressed: false },
      ],
      privacyThreshold: K_ANONYMITY_THRESHOLD,
      anySuppressed: false,
    });
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("national", null, periodStart, periodEnd);

    const minor = data.ageBuckets.find((b) => b.label === "7-14");
    expect(minor).toBeDefined();
    expect(minor!.suppressed).toBe(true);
    expect(minor!.count).toBe(0);
  });

  it("topReaders mask underage names via maskNameIfMinor", async () => {
    const admin = makeAdmin();
    // Top readers fetched via $queryRaw: simulate one minor (dob age <= 14) and
    // one adult.
    const elevenYearsAgo = new Date(Date.now() - 11 * 365.25 * 24 * 60 * 60 * 1000);
    const fortyYearsAgo = new Date(Date.now() - 40 * 365.25 * 24 * 60 * 60 * 1000);

    const replica = makeReplica({
      $queryRaw: jest
        .fn()
        // _topLibraries — empty
        .mockResolvedValueOnce([])
        // _topReaders — child + adult
        .mockResolvedValueOnce([
          { id: "u1", name: "Ali Karim", dob: elevenYearsAgo, score: 95.2 },
          { id: "u2", name: "Aziz Toirov", dob: fortyYearsAgo, score: 92.0 },
        ]),
    });
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("national", null, periodStart, periodEnd);

    expect(data.topReaders).toHaveLength(2);
    // Minor: initials only ("A.K.")
    expect(data.topReaders[0].name).toMatch(/^[A-Z]\.[A-Z]\.$/);
    // Adult: full name preserved
    expect(data.topReaders[1].name).toBe("Aziz Toirov");
  });

  it("title is composed of scopeLabel + period", async () => {
    const admin = makeAdmin();
    const replica = makeReplica();
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("national", null, periodStart, periodEnd);

    expect(data.title).toContain("Respublika");
    expect(data.title).toContain("oylik kitobxonlik hisoboti");
    expect(data.period).toMatch(/2026/);
  });

  it("falls back to scopeId when DB row missing for viloyat", async () => {
    const admin = makeAdmin();
    const replica = makeReplica({
      viloyat: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    const svc = new ReportDataService({} as PrismaService, replica, admin as unknown as AdminService);

    const data = await svc.gatherForScope("viloyat", "UZ-99", periodStart, periodEnd);

    expect(data.scopeLabel).toContain("UZ-99");
  });
});
