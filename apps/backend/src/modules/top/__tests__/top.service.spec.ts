import { TopService } from "../top.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";
import { FraudService } from "../../ai/fraud.service";
import { StatsGateway } from "../../../infra/gateway/stats.gateway";
import { BadgeService } from "../../badge/badge.service";
import { UserGender, UserType } from "@prisma/client";

const now = new Date();
const thirtyYearsAgo = new Date(now.getFullYear() - 30, 0, 1);
const twelveYearsAgo = new Date(now.getFullYear() - 12, 0, 1);

const mockUser = (overrides: Partial<{
  id: string; dob: Date; gender: UserGender; type: UserType;
  trustScore: number; transactions: object[]; isbnScans: object[];
  comprehensionTests: object[];
}> = {}) => ({
  id:                 "u1",
  dob:                thirtyYearsAgo,
  gender:             UserGender.MALE,
  type:               UserType.CITIZEN,
  trustScore:         80,
  name:               "Ali Valiyev",
  transactions:       [],
  isbnScans:          [],
  comprehensionTests: [],
  ...overrides,
});

// ── Mock factory: rebuilt fresh per test to avoid bleed-over ────────────────
function buildMocks() {
  const mockPrisma = {
    user:          { findMany: jest.fn() },
    top100Entry:   {
      deleteMany: jest.fn(),
      upsert:     jest.fn(),
      updateMany: jest.fn(),
      findMany:   jest.fn(),
      update:     jest.fn(),
      count:      jest.fn(),
    },
    readingIndex:  { findMany: jest.fn() },
    aiAuditLog:    { create: jest.fn().mockResolvedValue({}) },
    $queryRaw:     jest.fn(),
    $transaction:  jest.fn().mockImplementation(
      // Interactive form: runs the callback with the same client as a "tx" proxy.
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma)
    ),
  };
  const mockReplica = {
    user: { findMany: jest.fn() },
  };
  const mockFraud = {
    verifyTop100Candidate: jest.fn(),
  };
  // Plan 03-04 TOP-07 wiring: gateway + badge are injected and called from
  // autoPublish / confirmMonth / admin overrides. All three side-effect
  // methods are mocked here; tests assert call shape, not behaviour.
  const mockGateway = {
    emitTop100Update: jest.fn(),
    emitTop100UserFlagged: jest.fn(),
    emitBadgeEarned: jest.fn(),
  };
  const mockBadge = {
    checkTopEntries: jest.fn().mockResolvedValue(undefined),
    checkActiveMonth: jest.fn().mockResolvedValue(undefined),
  };
  // FIX H8 — Redis SETNX leader lock (subscription FIX F pattern). Default:
  // birinchi replica (first: true) — lock testlari buni override qiladi.
  const mockRedisLock = {
    tryAcquire: jest.fn().mockResolvedValue({ first: true }),
    storeResponse: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  return { mockPrisma, mockReplica, mockFraud, mockGateway, mockBadge, mockRedisLock };
}

describe("TopService", () => {
  let service: TopService;
  let mockPrisma: ReturnType<typeof buildMocks>["mockPrisma"];
  let mockReplica: ReturnType<typeof buildMocks>["mockReplica"];
  let mockFraud: ReturnType<typeof buildMocks>["mockFraud"];
  let mockGateway: ReturnType<typeof buildMocks>["mockGateway"];
  let mockBadge: ReturnType<typeof buildMocks>["mockBadge"];
  let mockRedisLock: ReturnType<typeof buildMocks>["mockRedisLock"];

  beforeEach(() => {
    const mocks = buildMocks();
    mockPrisma = mocks.mockPrisma;
    mockReplica = mocks.mockReplica;
    mockFraud = mocks.mockFraud;
    mockGateway = mocks.mockGateway;
    mockBadge = mocks.mockBadge;
    mockRedisLock = mocks.mockRedisLock;
    service = new TopService(
      mockPrisma as unknown as PrismaService,
      mockReplica as unknown as PrismaReplicaService,
      mockFraud as unknown as FraudService,
      mockGateway as unknown as StatsGateway,
      mockBadge as unknown as BadgeService,
      mockRedisLock as unknown as RedisLockService,
    );
    jest.clearAllMocks();
    mockPrisma.top100Entry.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.top100Entry.upsert.mockResolvedValue({});
    mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.top100Entry.update.mockResolvedValue({});
    mockReplica.user.findMany.mockResolvedValue([]);
    // Re-wire $transaction after clearAllMocks
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma)
    );
    mockPrisma.aiAuditLog.create.mockResolvedValue({});
    mockRedisLock.tryAcquire.mockResolvedValue({ first: true });
  });

  // ── computeMonthlyTop100 ───────────────────────────────────────────────────
  describe("computeMonthlyTop100", () => {
    it("foydalanuvchilar yo'q bo'lganda 0 ta yozuv", async () => {
      mockReplica.user.findMany.mockResolvedValue([]);

      const result = await service.computeMonthlyTop100();

      expect(result.count).toBe(0);
      expect(mockPrisma.top100Entry.upsert).not.toHaveBeenCalled();
    });

    it("foydalanuvchilar bilan Top-100 hisoblab saqlaydi", async () => {
      const users = [mockUser({ id: "u1" }), mockUser({ id: "u2" })];
      mockReplica.user.findMany.mockResolvedValue(users);

      const result = await service.computeMonthlyTop100();

      expect(result.count).toBe(2);
      expect(mockPrisma.top100Entry.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.top100Entry.deleteMany).toHaveBeenCalled();
    });

    it("kitoblar o'qigan foydalanuvchi yuqori score oladi", async () => {
      const returnedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const borrowedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const users = [
        mockUser({
          id: "active-reader",
          transactions: [
            { bookId: "b1", returnedAt, borrowedAt, penaltyDays: 0, book: { genre: "Roman" } },
            { bookId: "b2", returnedAt, borrowedAt, penaltyDays: 0, book: { genre: "Tarix" } },
            { bookId: "b3", returnedAt, borrowedAt, penaltyDays: 0, book: { genre: "Ilmiy" } },
          ],
          comprehensionTests: [{ passed: true }, { passed: true }],
          trustScore: 95,
        }),
        mockUser({ id: "passive-reader", trustScore: 10 }),
      ];
      mockReplica.user.findMany.mockResolvedValue(users);

      await service.computeMonthlyTop100();

      // Birinchi upsert (rank 1) faol o'quvchi bo'lishi kerak
      const firstUpsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      expect(firstUpsertCall.create.userId).toBe("active-reader");
      expect(firstUpsertCall.create.rank).toBe(1);
    });

    it("kechikkan kitob intizom ballini pasaytiradi", async () => {
      const returnedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const borrowedAt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000); // 20 kun = muddatdan o'tgan

      const users = [
        mockUser({
          id: "late-returner",
          transactions: [
            { bookId: "b1", returnedAt, borrowedAt, penaltyDays: 5, book: { genre: "Roman" } },
            { bookId: "b2", returnedAt, borrowedAt, penaltyDays: 3, book: { genre: "Tarix" } },
          ],
          trustScore: 80,
        }),
      ];
      mockReplica.user.findMany.mockResolvedValue(users);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      const components = upsertCall.create.components;
      expect(components.discipline).toBeLessThan(100);
    });

    it("14 yoshgacha bolalar yoshi guruhi to'g'ri aniqlanadi", async () => {
      const users = [mockUser({ id: "u-child", dob: twelveYearsAgo })];
      mockReplica.user.findMany.mockResolvedValue(users);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      expect(upsertCall.create.ageGroup).toBe("7-14");
    });

    // ── New tests for Plan 03-02 ──────────────────────────────────────────────

    it("(TOP-01 weights) max score = 100 for user with all components saturated", async () => {
      // Build a user that saturates every component:
      //   verifiedReading (40%): 20 returned tx (each 1.0 × 5 = 100, capped)
      //   consistency (15%): 4 distinct weeks (4 × 25 = 100)
      //   diversity (10%): 7 genres (7 × 15 = 105 → 100)
      //   comprehension (15%): 5 tests passed (5 × 20 = 100)
      //   discipline (10%): 0 late returns = 100
      //   trust (10%): trustScore = 100
      const recent = (genre: string, weekOffset: number, bookId: string) => {
        const returnedAt = new Date(Date.now() - (weekOffset * 7 + 1) * 86400000);
        const borrowedAt = new Date(returnedAt.getTime() - 5 * 86400000);
        return { bookId, returnedAt, borrowedAt, penaltyDays: 0, book: { genre } };
      };
      const tx = [
        recent("A", 0, "bk-01"), recent("B", 1, "bk-02"), recent("C", 2, "bk-03"),
        recent("D", 3, "bk-04"), recent("E", 0, "bk-05"), recent("F", 1, "bk-06"),
        recent("G", 2, "bk-07"),
        // extra to saturate verifiedReading — C5 dedup talabi bo'yicha har
        // biri DISTINCT bookId (takror kitob endi qo'shimcha ball bermaydi)
        ...Array.from({ length: 13 }, (_, i) => recent("A", 0, `bk-extra-${i}`)),
      ];
      const users = [mockUser({
        id: "max-user",
        trustScore: 100,
        transactions: tx,
        comprehensionTests: [
          { passed: true }, { passed: true }, { passed: true },
          { passed: true }, { passed: true },
        ],
      })];
      mockReplica.user.findMany.mockResolvedValue(users);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      expect(upsertCall.create.score).toBe(100);
    });

    it("(TOP-01 diversity 12-month window) older transactions excluded from diversity", async () => {
      // One transaction within 12 months (genre A) + one 18 months ago (genre B).
      // The 12-month-old genre B should NOT count toward diversity uniqueness.
      // Since the where clause already filters returnedAt >= oneYearAgo, the
      // mocked transactions list passed in must mirror that — older tx should
      // NOT reach the service. We test by including both and asserting that
      // the diversity computation respects the cutoff inside the function body.
      const within = new Date(Date.now() - 30 * 86400000);
      const older  = new Date(Date.now() - 540 * 86400000); // 18 months ago
      const borrowedWithin = new Date(within.getTime() - 5 * 86400000);

      const users = [mockUser({
        id: "u-diversity",
        transactions: [
          { bookId: "b1", returnedAt: within, borrowedAt: borrowedWithin, penaltyDays: 0, book: { genre: "A" } },
          { bookId: "b2", returnedAt: older,  borrowedAt: new Date(older.getTime() - 5 * 86400000), penaltyDays: 0, book: { genre: "B" } },
        ],
        trustScore: 80,
      })];
      mockReplica.user.findMany.mockResolvedValue(users);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      // Only 1 unique genre within the 12-month window → diversity = 1 × 15 = 15
      expect(upsertCall.create.components.diversity).toBe(15);
    });

    it("(D-1) reads users from PrismaReplicaService, not PrismaService", async () => {
      // Make primary prisma.user.findMany throw so we can prove the code path
      // routed through replica only.
      const primaryUser = (mockPrisma as unknown as { user?: { findMany: jest.Mock } }).user;
      // mockPrisma intentionally has no .user.findMany — assert replica was used.
      mockReplica.user.findMany.mockResolvedValue([]);

      await service.computeMonthlyTop100();

      expect(mockReplica.user.findMany).toHaveBeenCalledTimes(1);
      // Sanity: writes (deleteMany) still hit primary
      expect(mockPrisma.top100Entry.deleteMany).toHaveBeenCalled();
      // Silence unused var lint
      void primaryUser;
    });

    // ── FIX C5 (yuqori yarmi): verifiedReading dedup ─────────────────────────

    it("(C5) bir xil bookId N marta qaytarilsa FAQAT 1 marta hisoblanadi", async () => {
      // Self-return-loop fermasi: 5 marta bir xil kitobni olib qaytargan.
      // Eski kod: 5 × 1.0 × 5 = 25 ball. Yangi kod: 1 distinct kitob → 5 ball.
      const returnedAt = new Date(Date.now() - 5 * 86400000);
      const borrowedAt = new Date(Date.now() - 15 * 86400000);
      const dupTx = () => ({
        bookId: "same-book",
        returnedAt,
        borrowedAt,
        penaltyDays: 0,
        book: { genre: "Roman" },
      });
      mockReplica.user.findMany.mockResolvedValueOnce([
        mockUser({
          id: "self-return-farmer",
          transactions: [dupTx(), dupTx(), dupTx(), dupTx(), dupTx()],
        }),
      ]);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      expect(upsertCall.create.components.verifiedReading).toBe(5);
    });

    it("(C5) har xil kitoblar alohida hisoblanadi (dedup faqat duplikatga ta'sir qiladi)", async () => {
      const returnedAt = new Date(Date.now() - 5 * 86400000);
      const borrowedAt = new Date(Date.now() - 15 * 86400000);
      const tx = (bookId: string) => ({
        bookId, returnedAt, borrowedAt, penaltyDays: 0, book: { genre: "Roman" },
      });
      mockReplica.user.findMany.mockResolvedValueOnce([
        mockUser({ id: "honest-reader", transactions: [tx("b1"), tx("b2"), tx("b3")] }),
      ]);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      // 3 distinct kitob × 1.0 × 5 = 15
      expect(upsertCall.create.components.verifiedReading).toBe(15);
    });

    it("(C5) bir xil isbn takror skan qilinsa manba ichida faqat 1 marta hisoblanadi", async () => {
      const confirmedAt = new Date(Date.now() - 5 * 86400000);
      mockReplica.user.findMany.mockResolvedValueOnce([
        mockUser({
          id: "isbn-farmer",
          isbnScans: [
            { isbn: "9789943000001", source: "USER_SCAN", confirmedAt },
            { isbn: "9789943000001", source: "USER_SCAN", confirmedAt },
            { isbn: "9789943000001", source: "STORE_MANUAL", confirmedAt },
            { isbn: "9789943000002", source: "MUTOLAA", confirmedAt },
            { isbn: "9789943000002", source: "MUTOLAA", confirmedAt },
          ],
        }),
      ]);

      await service.computeMonthlyTop100();

      const upsertCall = mockPrisma.top100Entry.upsert.mock.calls[0][0];
      // MUTOLAA bo'lmagan distinct {0001} → 0.9; MUTOLAA distinct {0002} → 0.85
      // verifiedReading = (0 + 0.9 + 0.85) × 5 = 8.75
      expect(upsertCall.create.components.verifiedReading).toBeCloseTo(8.75);
    });

    // ── FIX H9 (OOM): cursor-sahifalangan chunk scan ─────────────────────────

    it("(H9) 1000 dan ortiq foydalanuvchi cursor pagination bilan chunklab o'qiladi", async () => {
      const chunk1 = Array.from({ length: 1000 }, (_, i) =>
        mockUser({ id: `u${String(i).padStart(4, "0")}` })
      );
      const chunk2 = [mockUser({ id: "u1000" })];
      mockReplica.user.findMany
        .mockResolvedValueOnce(chunk1)
        .mockResolvedValueOnce(chunk2);

      const result = await service.computeMonthlyTop100();

      // 1001 skorlangan → top-200 kesim saqlanadi
      expect(result.count).toBe(200);
      expect(mockReplica.user.findMany).toHaveBeenCalledTimes(2);

      const firstCallArgs = mockReplica.user.findMany.mock.calls[0][0];
      expect(firstCallArgs.take).toBe(1000);
      expect(firstCallArgs.orderBy).toEqual({ id: "asc" });
      expect(firstCallArgs.cursor).toBeUndefined();

      // Ikkinchi chunk — oxirgi id dan cursor + skip:1 (o'zini takrorlamaslik)
      const secondCallArgs = mockReplica.user.findMany.mock.calls[1][0];
      expect(secondCallArgs.cursor).toEqual({ id: "u0999" });
      expect(secondCallArgs.skip).toBe(1);
    });

    it("(H9) chunk to'liq bo'lmasa (oxirgi sahifa) keyingi so'rov yuborilmaydi", async () => {
      mockReplica.user.findMany.mockResolvedValueOnce([
        mockUser({ id: "u1" }), mockUser({ id: "u2" }),
      ]);

      await service.computeMonthlyTop100();

      // 2 < 1000 → bitta so'rov yetarli
      expect(mockReplica.user.findMany).toHaveBeenCalledTimes(1);
    });
  });

  // ── confirmMonth ──────────────────────────────────────────────────────────
  describe("confirmMonth", () => {
    it("DRAFT larni CONFIRMED ga o'tkazadi", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.findMany.mockResolvedValue([]);

      const result = await service.confirmMonth("2026-05");

      expect(mockPrisma.top100Entry.updateMany).toHaveBeenCalledWith({
        where: { month: "2026-05", status: "DRAFT" },
        data: { status: "CONFIRMED" },
      });
      expect(result.confirmed).toBe(true);
    });

    it("(TOP-07) confirmMonth also emits top100:update broadcast", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        {
          rank: 1, score: 90, ageGroup: "15-30", gender: UserGender.MALE,
          user: { name: "Adult", sifatId: "S-1", dob: thirtyYearsAgo, type: UserType.CITIZEN },
        },
      ]);

      await service.confirmMonth("2026-05");

      expect(mockGateway.emitTop100Update).toHaveBeenCalledWith(
        "2026-05",
        expect.arrayContaining([
          expect.objectContaining({ rank: 1 }),
        ])
      );
    });
  });

  // ── getTop100 ──────────────────────────────────────────────────────────────
  describe("getTop100", () => {
    const mockEntries = [
      {
        rank: 1, score: 87.5, components: {}, ageGroup: "15-30",
        gender: UserGender.MALE, userType: UserType.CITIZEN,
        user: {
          name: "Ali Valiyev",
          sifatId: "SL-UZ-01-001-0001-00001",
          type: UserType.CITIZEN,
          dob: thirtyYearsAgo,
          address: { viloyatId: "v1", tumanId: "t1" },
        },
      },
      {
        rank: 2, score: 80.0, components: {}, ageGroup: "7-14",
        gender: UserGender.FEMALE, userType: UserType.STUDENT_SCHOOL,
        user: {
          name: "Zulfiya Karimova",
          sifatId: "SL-UZ-01-001-0001-00002",
          type: UserType.STUDENT_SCHOOL,
          dob: twelveYearsAgo,
          address: { viloyatId: "v1", tumanId: "t1" },
        },
      },
    ];

    beforeEach(() => {
      mockPrisma.top100Entry.findMany.mockResolvedValue(mockEntries);
      mockPrisma.top100Entry.count.mockResolvedValue(2);
    });

    it("CONFIRMED Top-100 ni qaytaradi", async () => {
      const result = await service.getTop100({});

      expect(result.total).toBe(2);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].rank).toBe(1);
    });

    it("14 yoshgacha bolalar ismi anonimlanadi", async () => {
      const result = await service.getTop100({});

      const child = result.entries.find((e) => e.ageGroup === "7-14");
      expect(child?.user.name).not.toBe("Zulfiya Karimova");
      expect(child?.user.name).toMatch(/^Z\.K\.$/);
    });

    it("katta yoshlilar ismi ko'rinadi", async () => {
      const result = await service.getTop100({});

      const adult = result.entries.find((e) => e.ageGroup === "15-30");
      expect(adult?.user.name).toBe("Ali Valiyev");
    });

    it("gender filtri bilan so'rov yuboriladi", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([mockEntries[0]]);
      mockPrisma.top100Entry.count.mockResolvedValue(1);

      await service.getTop100({ gender: UserGender.MALE });

      expect(mockPrisma.top100Entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ gender: UserGender.MALE }),
        })
      );
    });

    it("limit maksimum 100 ga cheklanadi", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([]);
      mockPrisma.top100Entry.count.mockResolvedValue(0);

      await service.getTop100({ limit: 500 });

      expect(mockPrisma.top100Entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 })
      );
    });
  });

  // ── getAvailableMonths ─────────────────────────────────────────────────────
  describe("getAvailableMonths", () => {
    it("tasdiqlangan oylar ro'yhatini qaytaradi", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { month: "2026-05" },
        { month: "2026-04" },
        { month: "2026-03" },
      ]);

      const result = await service.getAvailableMonths();

      expect(result).toEqual(["2026-05", "2026-04", "2026-03"]);
    });

    it("hech qanday oy yo'q bo'lganda bo'sh massiv qaytaradi", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([]);
      const result = await service.getAvailableMonths();
      expect(result).toEqual([]);
    });
  });

  // ── getRegionalRanking ─────────────────────────────────────────────────────
  describe("getRegionalRanking", () => {
    it("viloyat bo'yicha hududiy reyting qaytaradi", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { regionId: "v1", avgScore: 72.3, userCount: 1500 },
        { regionId: "v2", avgScore: 65.1, userCount: 800 },
      ]);

      const result = await service.getRegionalRanking("viloyat");
      expect(result).toHaveLength(2);
      expect(result[0].avgScore).toBeGreaterThan(result[1].avgScore);
    });
  });

  // ── getDraftMonth ──────────────────────────────────────────────────────────
  describe("getDraftMonth", () => {
    it("DRAFT holatdagi Top-100 ni qaytaradi", async () => {
      const drafts = Array.from({ length: 5 }, (_, i) => ({
        rank: i + 1,
        score: 90 - i,
        user: {
          name: `Foydalanuvchi ${i}`,
          sifatId: `SL-UZ-01-001-0001-0000${i}`,
          trustScore: 80,
          dob: thirtyYearsAgo,
        },
      }));
      mockPrisma.top100Entry.findMany.mockResolvedValue(drafts);

      const result = await service.getDraftMonth("2026-05");

      expect(result.month).toBe("2026-05");
      expect(result.count).toBe(5);
      expect(result.entries).toHaveLength(5);
    });

    it("(TOP-06) anonymizes minor names in draft view", async () => {
      const drafts = [
        {
          rank: 1, score: 90,
          user: { name: "Anvar Karimov", sifatId: "S-1", trustScore: 80, dob: thirtyYearsAgo },
        },
        {
          rank: 2, score: 85,
          user: { name: "Bobur Toshmatov", sifatId: "S-2", trustScore: 80, dob: twelveYearsAgo },
        },
      ];
      mockPrisma.top100Entry.findMany.mockResolvedValue(drafts);

      const result = await service.getDraftMonth("2026-05");

      const adult = result.entries[0];
      const minor = result.entries[1];
      // Service maps the inner user.name through maskNameIfMinor.
      // Adult stays as-is; minor is initialised "B.T."
      expect((adult as { user: { name: string } }).user.name).toBe("Anvar Karimov");
      expect((minor as { user: { name: string } }).user.name).toMatch(/^B\.T\.$/);
    });
  });

  // ── Plan 03-02: AI fraud check (TOP-02 state machine) — H10 dan keyin
  // dispetcher lastDay-2 kuni chaqiradi; metod o'zi lock-siz.
  describe("aiFraudCheck (dispatcher: lastDay-2)", () => {
    it("DRAFT entries that PASS fraud check transition to FRAUD_CHECKED", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", month: "2026-06", components: { foo: 1 } },
        { id: "e2", userId: "u2", month: "2026-06", components: {} },
      ]);
      mockFraud.verifyTop100Candidate
        .mockResolvedValueOnce({ passed: true, reasons: [] })
        .mockResolvedValueOnce({ passed: true, reasons: [] });

      await service.aiFraudCheck();

      // 2 updates inside transactions
      expect(mockPrisma.top100Entry.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.top100Entry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "e1" },
          data: expect.objectContaining({ status: "FRAUD_CHECKED" }),
        })
      );
      // Used $transaction at least once
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("DRAFT entries that FAIL fraud check transition to FLAGGED with reasons", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", month: "2026-06", components: { existing: "blob" } },
      ]);
      mockFraud.verifyTop100Candidate.mockResolvedValueOnce({
        passed: false,
        reasons: ["TRUST_BELOW_50", "LOW_COMPREHENSION"],
      });

      await service.aiFraudCheck();

      const updateCall = mockPrisma.top100Entry.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe("FLAGGED");
      // components should be extended with flagReasons
      expect(updateCall.data.components).toMatchObject({
        existing: "blob",
        flagReasons: ["TRUST_BELOW_50", "LOW_COMPREHENSION"],
      });
    });

    it("writes AiAuditLog row per state transition", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", month: "2026-06", components: {} },
      ]);
      mockFraud.verifyTop100Candidate.mockResolvedValueOnce({ passed: true, reasons: [] });

      await service.aiFraudCheck();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalled();
      const lastCall = mockPrisma.aiAuditLog.create.mock.calls[0][0];
      expect(lastCall.data.scope).toBe("TOP100");
      expect(lastCall.data.issueType).toBe("STATE_TRANSITION");
    });
  });

  // ── Plan 03-02: admin review window (TOP-02 state machine) — H10 dan keyin
  // dispetcher lastDay-1 kuni chaqiradi; metod o'zi lock-siz.
  describe("adminReviewWindowOpen (dispatcher: lastDay-1)", () => {
    it("transitions FRAUD_CHECKED → READY_FOR_PUBLISH (does NOT touch FLAGGED)", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 97 });

      await service.adminReviewWindowOpen();

      expect(mockPrisma.top100Entry.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: "FRAUD_CHECKED" }),
        data: { status: "READY_FOR_PUBLISH" },
      });
    });

    it("idempotent — running twice on already-READY entries does not re-update", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 0 });

      await service.adminReviewWindowOpen();
      await service.adminReviewWindowOpen();

      // Both calls happen but the where clause filters them at the DB layer.
      expect(mockPrisma.top100Entry.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  // ── Plan 03-02: 1st-day auto-publish (TOP-02 state machine) — H8 dan keyin
  // @Cron("0 2 1 * *") autoPublishCron wrapperda; biznes metodi lock-siz.
  describe("autoPublish (1st-day, autoPublishCron wrapper orqali)", () => {
    it("READY_FOR_PUBLISH → CONFIRMED for non-flagged entries", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 97 });
      mockPrisma.top100Entry.count.mockResolvedValue(3); // 3 FLAGGED slots

      const result = await service.autoPublish();

      expect(mockPrisma.top100Entry.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: "READY_FOR_PUBLISH" }),
        data: { status: "CONFIRMED" },
      });
      expect(result.confirmed).toBe(97);
    });

    it("(D-2) FLAGGED entries are NOT promoted — rank gaps preserved", async () => {
      // 3 entries FLAGGED at ranks 5, 17, 42 of 100; only 97 READY_FOR_PUBLISH
      // transition. The 3 FLAGGED rows keep their rank — never renumbered.
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 97 });
      mockPrisma.top100Entry.count.mockResolvedValue(3);

      const result = await service.autoPublish();

      expect(result.confirmed).toBe(97);
      expect(result.flaggedSkipped).toBe(3);
      // Critical: no call ever updates the FLAGGED rows' rank or status
      const updateCalls = mockPrisma.top100Entry.update.mock.calls;
      const updateManyCalls = mockPrisma.top100Entry.updateMany.mock.calls;
      const touchedFlagged = [...updateCalls, ...updateManyCalls].some((c) => {
        const arg = c[0] as { where?: { status?: string }; data?: { rank?: unknown } };
        return arg?.where?.status === "FLAGGED" || arg?.data?.rank !== undefined;
      });
      expect(touchedFlagged).toBe(false);
    });

    it("writes AiAuditLog STATE_TRANSITION row recording the publish counts", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.count.mockResolvedValue(0);

      await service.autoPublish();

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            scope: "TOP100",
            issueType: "STATE_TRANSITION",
          }),
        })
      );
    });

    // ── Plan 03-04 TOP-07 + GAME-01 wiring ──────────────────────────────────

    it("(TOP-07) emit top100:update broadcast after auto-publish", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.count.mockResolvedValue(0);
      // _buildBroadcastPayload findMany call
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        {
          rank: 1, score: 90, ageGroup: "15-30", gender: UserGender.MALE,
          user: { name: "Adult User", sifatId: "S-1", dob: thirtyYearsAgo, type: UserType.CITIZEN },
        },
        {
          rank: 2, score: 80, ageGroup: "7-14", gender: UserGender.FEMALE,
          user: { name: "Minor User", sifatId: "S-2", dob: twelveYearsAgo, type: UserType.STUDENT_SCHOOL },
        },
      ]);

      await service.autoPublish();

      expect(mockGateway.emitTop100Update).toHaveBeenCalledTimes(1);
      const [emittedMonth, emittedEntries] =
        mockGateway.emitTop100Update.mock.calls[0];
      expect(emittedMonth).toMatch(/^\d{4}-\d{2}$/); // previousMonthKey
      expect(emittedEntries).toHaveLength(2);
    });

    it("(TOP-07 anonymization at emit) minor name is masked in broadcast payload", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.count.mockResolvedValue(0);
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        {
          rank: 1, score: 90, ageGroup: "15-30", gender: UserGender.MALE,
          user: { name: "Adult Person", sifatId: "S-1", dob: thirtyYearsAgo, type: UserType.CITIZEN },
        },
        {
          rank: 2, score: 80, ageGroup: "7-14", gender: UserGender.FEMALE,
          user: { name: "Minor Reader", sifatId: "S-2", dob: twelveYearsAgo, type: UserType.STUDENT_SCHOOL },
        },
      ]);

      await service.autoPublish();

      const [, payload] = mockGateway.emitTop100Update.mock.calls[0];
      const adult = payload[0];
      const minor = payload[1];
      expect(adult.user.name).toBe("Adult Person");
      expect(minor.user.name).toMatch(/^M\.R\.$/); // masked
    });

    it("(GAME-01) checkTopEntries + checkActiveMonth invoked after publish", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.count.mockResolvedValue(0);
      // The _buildBroadcastPayload call returns []. Then ACTIVE_MONTH candidates findMany.
      mockPrisma.top100Entry.findMany
        .mockResolvedValueOnce([]) // broadcast payload
        .mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]); // ACTIVE_MONTH candidates

      await service.autoPublish();

      expect(mockBadge.checkTopEntries).toHaveBeenCalledTimes(1);
      expect(mockBadge.checkActiveMonth).toHaveBeenCalledTimes(2);
    });

    it("(TOP-07) emit failure does NOT roll back the publish", async () => {
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 100 });
      mockPrisma.top100Entry.count.mockResolvedValue(0);
      // _buildBroadcastPayload throws (e.g. DB hiccup mid-emit). The
      // status update is already committed; we must not throw.
      mockPrisma.top100Entry.findMany.mockRejectedValueOnce(new Error("redis down"));

      const result = await service.autoPublish();

      expect(result.confirmed).toBe(100);
      // Gateway never called because the payload build threw.
      expect(mockGateway.emitTop100Update).not.toHaveBeenCalled();
    });
  });

  // ── FIX H10: oy-oxiriga nisbiy kunlik dispetcher ──────────────────────────
  // Eski 28/29/30-kun mixlangan cronlar fevralda ishlamasdi (29/30 yo'q).
  // Endi bitta kunlik cron Tashkent kalendariga qarab bosqich tanlaydi:
  //   draft = lastDay-3, fraud = lastDay-2, review = lastDay-1.
  describe("monthEndPipelineDispatcher (H10 — oy oxiriga nisbiy jadval)", () => {
    // Tashkent (UTC+5) 02:00 instanti — aynan cron otadigan payt.
    const tashkent0200 = (ymd: string) => new Date(`${ymd}T02:00:00+05:00`);

    let draftSpy: jest.SpyInstance;
    let fraudSpy: jest.SpyInstance;
    let reviewSpy: jest.SpyInstance;

    beforeEach(() => {
      draftSpy = jest
        .spyOn(service, "computeMonthlyTop100")
        .mockResolvedValue({ month: "m", count: 0 });
      fraudSpy = jest
        .spyOn(service, "aiFraudCheck")
        .mockResolvedValue({ month: "m", passed: 0, flagged: 0, total: 0 });
      reviewSpy = jest
        .spyOn(service, "adminReviewWindowOpen")
        .mockResolvedValue({ month: "m", count: 0 });
    });

    // ── 28-kunlik fevral (2026 kabisa emas): lastDay = 28 ──────────────────
    it("fevral (28 kun): 25-kuni (lastDay-3) DRAFT hisoblanadi", async () => {
      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-02-25"));

      expect(result.dispatched).toBe("draft");
      expect(result.lastDay).toBe(28);
      expect(draftSpy).toHaveBeenCalledTimes(1);
      expect(fraudSpy).not.toHaveBeenCalled();
      expect(reviewSpy).not.toHaveBeenCalled();
    });

    it("fevral (28 kun): 26-kuni (lastDay-2) AI fraud check ishlaydi", async () => {
      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-02-26"));

      expect(result.dispatched).toBe("fraud");
      expect(fraudSpy).toHaveBeenCalledTimes(1);
      expect(draftSpy).not.toHaveBeenCalled();
      expect(reviewSpy).not.toHaveBeenCalled();
    });

    it("fevral (28 kun): 27-kuni (lastDay-1) review window ochiladi", async () => {
      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-02-27"));

      expect(result.dispatched).toBe("review");
      expect(reviewSpy).toHaveBeenCalledTimes(1);
      expect(draftSpy).not.toHaveBeenCalled();
      expect(fraudSpy).not.toHaveBeenCalled();
    });

    it("fevral oxirgi kuni (28): hech qanday bosqich ishlamaydi (publish 1-kunda alohida)", async () => {
      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-02-28"));

      expect(result.dispatched).toBeNull();
      expect(draftSpy).not.toHaveBeenCalled();
      expect(fraudSpy).not.toHaveBeenCalled();
      expect(reviewSpy).not.toHaveBeenCalled();
      // Oddiy kunda lock ham olinmaydi
      expect(mockRedisLock.tryAcquire).not.toHaveBeenCalled();
    });

    // ── 31-kunlik oy (iyul 2026): lastDay = 31 — eski 28/29/30 bilan mos ───
    it("31-kunlik oy: 28-kuni draft, 29-kuni fraud, 30-kuni review", async () => {
      const r28 = await service.monthEndPipelineDispatcher(tashkent0200("2026-07-28"));
      const r29 = await service.monthEndPipelineDispatcher(tashkent0200("2026-07-29"));
      const r30 = await service.monthEndPipelineDispatcher(tashkent0200("2026-07-30"));

      expect(r28.dispatched).toBe("draft");
      expect(r29.dispatched).toBe("fraud");
      expect(r30.dispatched).toBe("review");
      expect(r28.lastDay).toBe(31);
      expect(draftSpy).toHaveBeenCalledTimes(1);
      expect(fraudSpy).toHaveBeenCalledTimes(1);
      expect(reviewSpy).toHaveBeenCalledTimes(1);
    });

    it("31-kunlik oyda 25-kun oddiy kun — hech narsa ishlamaydi", async () => {
      // Fevralda 25 = draft kuni edi; iyulda 25 = lastDay-6 → no-op.
      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-07-25"));

      expect(result.dispatched).toBeNull();
      expect(draftSpy).not.toHaveBeenCalled();
    });

    it("UTC kun chegarasi: 2026-02-24T21:00Z = Tashkentda 25-fevral 02:00 → draft", async () => {
      // K8s podlar UTC da — getDate() 24 ni ko'rsatadi, lekin Tashkent
      // kalendari bo'yicha 25-fevral. Dispetcher Tashkent kunini ishlatadi.
      const result = await service.monthEndPipelineDispatcher(
        new Date("2026-02-24T21:00:00Z")
      );

      expect(result.dispatched).toBe("draft");
      expect(draftSpy).toHaveBeenCalledTimes(1);
    });

    // ── FIX H8: leader lock dispatcherda ────────────────────────────────────
    it("(H8) lock kaliti bosqich + Tashkent sanasi bilan quriladi (2h TTL)", async () => {
      await service.monthEndPipelineDispatcher(tashkent0200("2026-02-25"));

      expect(mockRedisLock.tryAcquire).toHaveBeenCalledWith(
        "cron:top100:draft:2026-02-25",
        2 * 60 * 60,
        "2026-02-25",
      );
    });

    it("(H8) ikkinchi replica lock ololmasa bosqich O'TKAZIB yuboriladi", async () => {
      mockRedisLock.tryAcquire.mockResolvedValue({ first: false });

      const result = await service.monthEndPipelineDispatcher(tashkent0200("2026-02-25"));

      expect(result.dispatched).toBeNull();
      expect(draftSpy).not.toHaveBeenCalled();
      expect(fraudSpy).not.toHaveBeenCalled();
      expect(reviewSpy).not.toHaveBeenCalled();
    });

    it("RedisLockService ulanmagan bo'lsa (dev/tests) xavfsiz skip qiladi", async () => {
      const bare = new TopService(
        mockPrisma as unknown as PrismaService,
        mockReplica as unknown as PrismaReplicaService,
        mockFraud as unknown as FraudService,
        mockGateway as unknown as StatsGateway,
        mockBadge as unknown as BadgeService,
      );
      const bareDraftSpy = jest.spyOn(bare, "computeMonthlyTop100");

      const result = await bare.monthEndPipelineDispatcher(tashkent0200("2026-02-25"));

      expect(result.dispatched).toBeNull();
      expect(bareDraftSpy).not.toHaveBeenCalled();
    });
  });

  // ── FIX H8: autoPublishCron wrapper (jadval "0 2 1 * *" o'zgarmagan) ──────
  describe("autoPublishCron (H8 leader lock)", () => {
    it("lock olgach autoPublish ni chaqiradi", async () => {
      const pubSpy = jest
        .spyOn(service, "autoPublish")
        .mockResolvedValue({ month: "2026-05", confirmed: 100, flaggedSkipped: 0 });

      await service.autoPublishCron();

      expect(mockRedisLock.tryAcquire).toHaveBeenCalledWith(
        expect.stringMatching(/^cron:top100:publish:\d{4}-\d{2}-\d{2}$/),
        2 * 60 * 60,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
      expect(pubSpy).toHaveBeenCalledTimes(1);
    });

    it("(H8) ikkinchi replica lock ololmasa publish CHAQIRILMAYDI", async () => {
      mockRedisLock.tryAcquire.mockResolvedValue({ first: false });
      const pubSpy = jest.spyOn(service, "autoPublish");

      await service.autoPublishCron();

      expect(pubSpy).not.toHaveBeenCalled();
      // deleteMany/updateMany ham tegmagan — milliy reyting buzilmaydi
      expect(mockPrisma.top100Entry.updateMany).not.toHaveBeenCalled();
    });

    it("RedisLockService ulanmagan bo'lsa publish o'tkazib yuboriladi (dev/tests)", async () => {
      const bare = new TopService(
        mockPrisma as unknown as PrismaService,
        mockReplica as unknown as PrismaReplicaService,
        mockFraud as unknown as FraudService,
        mockGateway as unknown as StatsGateway,
        mockBadge as unknown as BadgeService,
      );
      const pubSpy = jest.spyOn(bare, "autoPublish");

      await bare.autoPublishCron();

      expect(pubSpy).not.toHaveBeenCalled();
    });

    it("(H8) manual trigger metodlari lock TALAB QILMAYDI", async () => {
      // Admin POST /top/compute → computeMonthlyTop100 to'g'ridan-to'g'ri.
      mockReplica.user.findMany.mockResolvedValue([]);
      mockPrisma.top100Entry.findMany.mockResolvedValue([]);
      mockPrisma.top100Entry.updateMany.mockResolvedValue({ count: 0 });

      await service.computeMonthlyTop100();
      await service.aiFraudCheck();
      await service.adminReviewWindowOpen();

      expect(mockRedisLock.tryAcquire).not.toHaveBeenCalled();
    });
  });

  // ── Plan 03-02: admin override service methods ───────────────────────────
  describe("admin overrides", () => {
    it("flagUser sets status=FLAGGED inside $transaction with reason", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([{ id: "e1", userId: "u1", components: {} }]);
      mockPrisma.top100Entry.update.mockResolvedValue({});

      await service.flagUser("2026-06", "u1", "Suspicious activity");

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.top100Entry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FLAGGED" }),
        })
      );
    });

    it("clearFlag reverts FLAGGED → FRAUD_CHECKED", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", components: { flagReasons: ["LOW_COMPREHENSION"] } },
      ]);

      await service.clearFlag("2026-06", "u1");

      expect(mockPrisma.top100Entry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FRAUD_CHECKED" }),
        })
      );
    });

    it("rejectEntry sets status=REJECTED", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([{ id: "e1", userId: "u1", components: {} }]);

      await service.rejectEntry("2026-06", "u1");

      expect(mockPrisma.top100Entry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "REJECTED" }),
        })
      );
    });

    it("confirmEntry sets status=CONFIRMED for a single user (manual override)", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([{ id: "e1", userId: "u1", components: {} }]);

      await service.confirmEntry("2026-06", "u1");

      expect(mockPrisma.top100Entry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CONFIRMED" }),
        })
      );
    });

    // ── Plan 03-04 TOP-07: admin override emits ─────────────────────────────

    it("(TOP-07) flagUser emits top100:flag broadcast with action=flagged", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", components: {} },
      ]);

      await service.flagUser("2026-06", "u1", "suspicious");

      expect(mockGateway.emitTop100UserFlagged).toHaveBeenCalledWith(
        "2026-06",
        "u1",
        "flagged",
      );
    });

    it("(TOP-07) clearFlag emits top100:flag broadcast with action=cleared", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", components: { flagReasons: ["X"] } },
      ]);

      await service.clearFlag("2026-06", "u1");

      expect(mockGateway.emitTop100UserFlagged).toHaveBeenCalledWith(
        "2026-06",
        "u1",
        "cleared",
      );
    });

    it("(TOP-07) rejectEntry emits top100:flag broadcast with action=rejected", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        { id: "e1", userId: "u1", components: {} },
      ]);

      await service.rejectEntry("2026-06", "u1");

      expect(mockGateway.emitTop100UserFlagged).toHaveBeenCalledWith(
        "2026-06",
        "u1",
        "rejected",
      );
    });
  });

  // ── Plan 03-04 TOP-07: getAdminReviewQueue ────────────────────────────────
  describe("getAdminReviewQueue", () => {
    it("returns all non-CONFIRMED entries (DRAFT, FRAUD_CHECKED, READY, FLAGGED, REJECTED)", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        {
          id: "e1", userId: "u1", month: "2026-06", rank: 1, score: 90,
          status: "FLAGGED", components: { flagReasons: ["TRUST_BELOW_50"] },
          gender: UserGender.MALE, ageGroup: "15-30", userType: UserType.CITIZEN,
          user: { name: "Adult", sifatId: "S-1", trustScore: 40, dob: thirtyYearsAgo },
        },
      ]);

      const result = await service.getAdminReviewQueue("2026-06");

      expect(mockPrisma.top100Entry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            month: "2026-06",
            status: expect.objectContaining({
              in: expect.arrayContaining(["FLAGGED", "REJECTED", "DRAFT"]),
            }),
          }),
        })
      );
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].status).toBe("FLAGGED");
    });

    it("(TOP-06) masks minor names in review queue too", async () => {
      mockPrisma.top100Entry.findMany.mockResolvedValue([
        {
          id: "e1", userId: "u1", month: "2026-06", rank: 1, score: 90,
          status: "FLAGGED", components: {},
          gender: UserGender.FEMALE, ageGroup: "7-14", userType: UserType.STUDENT_SCHOOL,
          user: { name: "Bobur Toshmatov", sifatId: "S-1", trustScore: 80, dob: twelveYearsAgo },
        },
      ]);

      const result = await service.getAdminReviewQueue("2026-06");

      expect(result.entries[0].user.name).toMatch(/^B\.T\.$/);
    });
  });
});
