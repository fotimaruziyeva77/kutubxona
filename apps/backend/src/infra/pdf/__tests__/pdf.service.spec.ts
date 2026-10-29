/**
 * Plan 05-08 RPT-01 — PdfService.buildMonthlyReportHtml scope parameterization
 * + escapeHtml regression on DB-sourced strings.
 *
 * NOTE: this spec only covers buildMonthlyReportHtml (a pure string-builder)
 * and NOT generateFromHtml (which launches Puppeteer). Puppeteer is exercised
 * by integration tests in the staging environment.
 */
import { PdfService } from "../pdf.service";
import type { ReportData } from "../../../modules/admin/report-data.service";

describe("PdfService.buildMonthlyReportHtml (Plan 05-08 RPT-01)", () => {
  let svc: PdfService;

  beforeEach(() => {
    svc = new PdfService();
  });

  // ── Legacy shape (Plan 04-03 backward-compat) ─────────────────────────

  it("legacy shape still renders with safe escaping", () => {
    const html = svc.buildMonthlyReportHtml({
      title: "<script>alert('x')</script>",
      period: "May 2026",
      stats: {},
      tableRows: [{ label: "<a>", value: "<b>" }],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;a&gt;");
    expect(html).toContain("&lt;b&gt;");
  });

  // ── Extended ReportData shape ─────────────────────────────────────────

  const makeData = (overrides: Partial<ReportData> = {}): ReportData => ({
    title: "Respublika oylik kitobxonlik hisoboti — May 2026",
    period: "May 2026",
    scopeLabel: "Respublika",
    tableRows: [
      { label: "Foydalanuvchilar", value: "1,000" },
    ],
    genderBuckets: [
      { label: "Erkak", count: 500, readingIndex: 65.1, suppressed: false },
      { label: "Ayol", count: 480, readingIndex: 68.4, suppressed: false },
    ],
    ageBuckets: [
      { label: "7-14", count: 150, readingIndex: 70.2, suppressed: false },
      { label: "15-30", count: 400, readingIndex: 68.5, suppressed: false },
    ],
    topLibraries: [
      { rank: 1, name: "Karmana tuman kutubxonasi", transactions: 320 },
    ],
    topReaders: [
      { rank: 1, name: "Aziz Toirov", score: 92.0 },
    ],
    generatedAt: new Date("2026-06-01T00:00:00Z").toISOString(),
    ...overrides,
  });

  it("extended shape with scope=national renders all sections", () => {
    const data = makeData();
    const html = svc.buildMonthlyReportHtml(data, "national");
    expect(html).toContain("Respublika oylik kitobxonlik hisoboti");
    expect(html).toContain("Asosiy ko'rsatkichlar");
    expect(html).toContain("Gender taqsimoti");
    expect(html).toContain("Yosh guruhi");
    expect(html).toContain("Eng faol kutubxonalar");
    expect(html).toContain("Eng faol kitobxonlar");
    expect(html).toContain("Karmana tuman kutubxonasi");
    expect(html).toContain("Aziz Toirov");
  });

  it("escapes DB-sourced library names (T-05-10)", () => {
    const data = makeData({
      topLibraries: [
        { rank: 1, name: "<script>fetch('evil')</script>", transactions: 1 },
      ],
    });
    const html = svc.buildMonthlyReportHtml(data, "national");
    expect(html).not.toContain("<script>fetch");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes DB-sourced reader names (T-05-10)", () => {
    const data = makeData({
      topReaders: [
        { rank: 1, name: "<img onerror=alert(1)>", score: 100 },
      ],
    });
    const html = svc.buildMonthlyReportHtml(data, "national");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img");
  });

  it("escapes DB-sourced scopeLabel + title (T-05-10)", () => {
    const data = makeData({
      title: "<svg/onload=alert(1)>",
      scopeLabel: "<svg/onload=alert(2)>",
    });
    const html = svc.buildMonthlyReportHtml(data, "viloyat", "UZ-08");
    expect(html).not.toContain("<svg/onload");
    expect(html).toContain("&lt;svg");
  });

  it("renders '—' for suppressed buckets (k-anonymity carry-over)", () => {
    const data = makeData({
      genderBuckets: [
        { label: "Erkak", count: 0, readingIndex: 0, suppressed: true },
        { label: "Ayol", count: 480, readingIndex: 68.4, suppressed: false },
      ],
    });
    const html = svc.buildMonthlyReportHtml(data, "national");
    // The suppressed bucket renders "—" instead of the count.
    expect(html).toMatch(/Erkak[\s\S]+?—/);
  });

  it("renders an SVG bar chart for non-suppressed buckets", () => {
    const data = makeData();
    const html = svc.buildMonthlyReportHtml(data, "national");
    expect(html).toContain("<svg");
    expect(html).toContain("barchart");
  });

  it("scope=viloyat includes the scopeId in the badge", () => {
    const data = makeData({ scopeLabel: "Navoiy viloyati" });
    const html = svc.buildMonthlyReportHtml(data, "viloyat", "UZ-08");
    expect(html).toContain("UZ-08");
    expect(html).toContain("Navoiy viloyati");
  });

  it("dev/non-production watermark contains DEV PREVIEW", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const html = svc.buildMonthlyReportHtml(makeData(), "national");
      expect(html).toContain("DEV PREVIEW");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("production hides DEV PREVIEW from watermark", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const html = svc.buildMonthlyReportHtml(makeData(), "national");
      expect(html).not.toContain("DEV PREVIEW");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ── Plan 06-02 SCH-08 — School PQ-9 report HTML escapes ────────────────────

describe("PdfService.generateSchoolPq9Report (Plan 06-02 SCH-08)", () => {
  let svc: PdfService;

  beforeEach(() => {
    svc = new PdfService();
  });

  const makePq9 = (overrides: Partial<Parameters<PdfService["generateSchoolPq9Report"]>[0]> = {}) => ({
    title: "PQ-9 Hisoboti — 8-maktab",
    period: "2026-yil 2-chorak",
    generatedAt: new Date("2026-06-01T00:00:00Z").toISOString(),
    schoolName: "8-maktab",
    stats: {
      totalStudents: 500,
      activeStudents: 300,
      coverageRate: 60,
      avgRi: 65.5,
      activeClubs: 3,
      monthlyTransactions: 150,
    },
    classBuckets: [
      { className: "9A", total: 30, active: 25, pending: 2, avgRi: 70, kAnonymitySuppressed: false },
      { className: "10B", total: 3, active: 3, pending: 0, avgRi: null, kAnonymitySuppressed: true },
    ],
    jadidlarSection: {
      clubs: [
        { name: "Jadidlar izidan", memberCount: 20, quarterDebates: 4, lastDebateAt: "2026-05-15" },
      ],
      inactiveClubs: [
        { name: "Eski klub", daysSince: 45 },
      ],
    },
    goalAchievement: { target: 20, achieved: 50, rate: 25 },
    ranking: { rank: 12, totalScore: 85.2 },
    ...overrides,
  });

  it("renders Jadidlar Izidan section with per-club rows", () => {
    const html = svc.generateSchoolPq9Report(makePq9());
    expect(html).toContain("Jadidlar Izidan");
    expect(html).toContain("Jadidlar izidan");
    expect(html).toContain("20"); // member count
    expect(html).toContain("4"); // quarter debate count
    expect(html).toContain("2026-05-15");
  });

  it("escapes XSS payload in club.name (T-06-02)", () => {
    const html = svc.generateSchoolPq9Report(makePq9({
      jadidlarSection: {
        clubs: [{
          name: "<script>fetch('evil.io')</script>",
          memberCount: 10,
          quarterDebates: 1,
          lastDebateAt: "2026-05-15",
        }],
        inactiveClubs: [],
      },
    }));
    expect(html).not.toContain("<script>fetch");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes XSS payload in schoolName + title", () => {
    const html = svc.generateSchoolPq9Report(makePq9({
      title: "<svg/onload=alert(1)>",
      schoolName: "<img onerror=alert(2)>",
    }));
    expect(html).not.toContain("<svg/onload");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;svg");
    expect(html).toContain("&lt;img");
  });

  it("escapes XSS in classBuckets[].className", () => {
    const html = svc.generateSchoolPq9Report(makePq9({
      classBuckets: [{
        className: "<script>alert(1)</script>",
        total: 10,
        active: 10,
        pending: 0,
        avgRi: 70,
        kAnonymitySuppressed: false,
      }],
    }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders '—' for K-anon suppressed avgRi (small class < 5)", () => {
    const html = svc.generateSchoolPq9Report(makePq9());
    // 10B is kAnonymitySuppressed: true → avgRi cell should be "—"
    expect(html).toMatch(/10B[\s\S]+?—/);
    expect(html).toContain("Maxfiylik chegarasi");
  });

  it("renders inactive clubs section with days-since", () => {
    const html = svc.generateSchoolPq9Report(makePq9());
    expect(html).toContain("Faolsiz klublar");
    expect(html).toContain("Eski klub");
    expect(html).toContain("45");
  });

  it("escapes XSS in inactiveClubs[].name", () => {
    const html = svc.generateSchoolPq9Report(makePq9({
      jadidlarSection: {
        clubs: [],
        inactiveClubs: [{ name: "<svg/onerror=alert(1)>", daysSince: 60 }],
      },
    }));
    expect(html).not.toContain("<svg/onerror");
    expect(html).toContain("&lt;svg");
  });

  it("renders KPI table with goal achievement (20-book target)", () => {
    const html = svc.generateSchoolPq9Report(makePq9());
    expect(html).toContain("20 kitob maqsadi");
    expect(html).toContain("50 kishi");
  });

  it("ranking 'Hisoblanmagan' fallback when rank is null", () => {
    const html = svc.generateSchoolPq9Report(makePq9({
      ranking: { rank: null, totalScore: 0 },
    }));
    expect(html).toContain("Hisoblanmagan");
  });
});

// ── Plan 06-05 ORG-06 — generateIdoraPq9Report ──────────────────────────────

describe("PdfService.generateIdoraPq9Report (Plan 06-05 ORG-06)", () => {
  let svc: PdfService;

  beforeEach(() => {
    svc = new PdfService();
  });

  const makeIdoraData = (overrides: any = {}) => ({
    title: "PQ-9 Muvofiqlik Hisoboti",
    period: "2026-05",
    generatedAt: "2026-06-01",
    institutionName: "Test Idora",
    bookCorner: {
      isActive: true,
      lastVerifiedAt: new Date("2026-04-15"),
      nextReminderAt: new Date("2026-07-14"),
      photos: [],
    },
    readingHours: {
      thisMonth: 2,
      total: 8,
      lastEventAt: new Date("2026-05-20"),
      daysSinceLastEvent: 12,
    },
    mvp: {
      userName: "Ali Valiyev",
      department: "IT",
      avgRi: 88.5,
      booksRead: 7,
    },
    rankingTop10: [
      { rank: 1, userName: "Ali Valiyev", department: "IT", avgRi: 88.5, booksRead: 7 },
    ],
    profBooks: [
      { title: "Boshqaruv", author: "Drucker", isRequired: true },
    ],
    employeeCount: 50,
    mukofotHistory: [
      { createdAt: new Date("2026-05-01"), analysis: "Avvalgi tavsiya" },
    ],
    ...overrides,
  });

  it("renders institution name and MVP section", () => {
    const html = svc.generateIdoraPq9Report(makeIdoraData());
    expect(html).toContain("Test Idora");
    expect(html).toContain("Ali Valiyev");
    expect(html).toContain("IT");
    expect(html).toContain("88.5");
  });

  it("escapes XSS in institution name", () => {
    const html = svc.generateIdoraPq9Report(
      makeIdoraData({ institutionName: "<script>alert(1)</script>" }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes XSS in profBook title + author", () => {
    const html = svc.generateIdoraPq9Report(
      makeIdoraData({
        profBooks: [{ title: "<img onerror=>", author: "<svg/onload>", isRequired: true }],
      }),
    );
    expect(html).not.toContain("<img onerror=>");
    expect(html).toContain("&lt;img onerror=&gt;");
    expect(html).not.toContain("<svg/onload>");
    expect(html).toContain("&lt;svg/onload&gt;");
  });

  it("escapes XSS in mvp userName + department", () => {
    const html = svc.generateIdoraPq9Report(
      makeIdoraData({
        mvp: {
          userName: "<script>evil()</script>",
          department: "<iframe>",
          avgRi: 80,
          booksRead: 5,
        },
      }),
    );
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
    expect(html).not.toContain("<iframe>");
    expect(html).toContain("&lt;iframe&gt;");
  });

  it("renders empty state when MVP is null", () => {
    const html = svc.generateIdoraPq9Report(makeIdoraData({ mvp: null }));
    expect(html).toContain("Bu oy ma'lumot mavjud emas");
  });

  it("renders book corner active badge when isActive", () => {
    const html = svc.generateIdoraPq9Report(makeIdoraData());
    expect(html).toContain("Faol");
  });

  it("renders book corner inactive badge when stale", () => {
    const html = svc.generateIdoraPq9Report(
      makeIdoraData({ bookCorner: { isActive: false, lastVerifiedAt: null, nextReminderAt: null, photos: [] } }),
    );
    expect(html).toContain("Yangilanishi kerak");
  });

  it("renders mukofotHistory rows when provided", () => {
    const html = svc.generateIdoraPq9Report(makeIdoraData());
    expect(html).toContain("Avvalgi tavsiya");
  });
});

// ── Plan 06-07 UNI-03 — generateAkkreditatsiyaReport ───────────────────────

describe("PdfService.generateAkkreditatsiyaReport (Plan 06-07 UNI-03)", () => {
  let svc: PdfService;

  beforeEach(() => {
    svc = new PdfService();
  });

  const makeAkkData = (overrides: any = {}) => ({
    scope: "OTM" as const,
    institution: { id: "inst-1", name: "Toshkent Davlat Universiteti" },
    academicYear: "2025/2026",
    quarter: "2026-Q2",
    generatedAt: "2026-06-01T00:00:00Z",
    summary: {
      totalStudents: 1000,
      activeStudents: 800,
      pendingStudents: 50,
      coverageRate: 80,
      avgRi: 67.3,
      activeClubs: 5,
      monthlyTransactions: 250,
      goalAchievement: { target: 10, achieved: 350, rate: 35 },
    },
    byFaculty: [
      { faculty: "Informatika", studentCount: 200, avgRi: 70, kAnonymitySuppressed: false },
      { faculty: "TinyFaculty", studentCount: 3, avgRi: null, kAnonymitySuppressed: true },
    ],
    digitalLibraryChecklist: [
      { criterion: "Elektron katalog mavjud", status: "PASS" as const, note: "200 ta kitob" },
      { criterion: "Faol obuna", status: "FAIL" as const, note: "Subscription status: FROZEN" },
    ],
    profBooks: [
      { title: "Algoritmlar", author: "Knuth", genre: "CS", isRequired: true },
    ],
    ...overrides,
  });

  it("renders institution name and faculty breakdown", () => {
    const html = svc.generateAkkreditatsiyaReport(makeAkkData());
    expect(html).toContain("Toshkent Davlat Universiteti");
    expect(html).toContain("Informatika");
    expect(html).toContain("OTM Akkreditatsiya Hisoboti");
  });

  it("escapes XSS payload in institution.name (T-06-U4)", () => {
    const html = svc.generateAkkreditatsiyaReport(
      makeAkkData({
        institution: { id: "x", name: "<script>alert(1)</script>" },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes XSS in byFaculty[].faculty", () => {
    const html = svc.generateAkkreditatsiyaReport(
      makeAkkData({
        byFaculty: [
          { faculty: "<img onerror=alert(1)>", studentCount: 30, avgRi: 70, kAnonymitySuppressed: false },
        ],
      }),
    );
    expect(html).not.toContain("<img onerror=alert(1)>");
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
  });

  it("escapes XSS in checklist criterion + note", () => {
    const html = svc.generateAkkreditatsiyaReport(
      makeAkkData({
        digitalLibraryChecklist: [
          { criterion: "<svg/onload=alert(1)>", status: "PASS" as const, note: "<iframe>nope</iframe>" },
        ],
      }),
    );
    expect(html).not.toContain("<svg/onload");
    expect(html).not.toContain("<iframe>nope");
    expect(html).toContain("&lt;svg");
    expect(html).toContain("&lt;iframe&gt;");
  });

  it("escapes XSS in profBooks title + author + genre", () => {
    const html = svc.generateAkkreditatsiyaReport(
      makeAkkData({
        profBooks: [
          { title: "<script>x()</script>", author: "<img>", genre: "<svg>", isRequired: true },
        ],
      }),
    );
    expect(html).not.toContain("<script>x()</script>");
    expect(html).toContain("&lt;script&gt;x()&lt;/script&gt;");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;img&gt;");
  });

  it("renders '—' for K-anon suppressed avgRi (faculty < 5)", () => {
    const html = svc.generateAkkreditatsiyaReport(makeAkkData());
    // TinyFaculty has kAnonymitySuppressed: true → avgRi cell should be "—"
    expect(html).toMatch(/TinyFaculty[\s\S]+?—/);
    expect(html).toContain("Maxfiylik chegarasi");
  });

  it("colorizes PASS/FAIL badges in checklist", () => {
    const html = svc.generateAkkreditatsiyaReport(makeAkkData());
    expect(html).toContain("akk-badge green");
    expect(html).toContain("akk-badge red");
    expect(html).toContain("PASS");
    expect(html).toContain("FAIL");
  });

  it("does NOT leak per-student PII (D-Q7)", () => {
    const html = svc.generateAkkreditatsiyaReport(makeAkkData());
    // PII-style strings absent.
    expect(html).not.toMatch(/\+998\d{9}/); // no phone numbers
    expect(html).not.toMatch(/SL-UZ-\d+/); // no SifatId
  });
});
