import { BadgeService, BADGE_CATALOG } from "../badge.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { KafkaService, KAFKA_TOPICS } from "../../../infra/kafka/kafka.service";

const mockPrisma = {
  badge: {
    upsert:     jest.fn(),
    findUnique: jest.fn(),
  },
  userBadge: {
    create:   jest.fn(),
    findMany: jest.fn(),
  },
  bookTransaction: {
    count:     jest.fn(),
    findFirst: jest.fn(),
    findMany:  jest.fn(),
  },
  comprehensionTest: {
    count: jest.fn(),
  },
  isbnScan: {
    count: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  top100Entry: {
    findMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

describe("BadgeService", () => {
  let service: BadgeService;

  beforeEach(() => {
    service = new BadgeService(
      mockPrisma as unknown as PrismaService,
      mockKafka as unknown as KafkaService,
    );
    jest.clearAllMocks();
    // Default: badge topiladi va create muvaffaqiyatli
    mockPrisma.badge.findUnique.mockResolvedValue({ id: "badge-1" });
    mockPrisma.userBadge.create.mockResolvedValue({});
    mockKafka.emit.mockResolvedValue(undefined);
  });

  // ── BADGE_CATALOG ──────────────────────────────────────────────────────────
  describe("BADGE_CATALOG", () => {
    it("18 ta badge mavjud", () => {
      expect(BADGE_CATALOG.length).toBe(18);
    });

    it("FIRST_BOOK badge mavjud", () => {
      const fb = BADGE_CATALOG.find((b) => b.code === "FIRST_BOOK");
      expect(fb).toBeDefined();
      expect(fb?.icon).toBe("📖");
    });
  });

  // ── seedBadges ─────────────────────────────────────────────────────────────
  describe("seedBadges", () => {
    it("barcha badgelarni DB ga upsert qiladi", async () => {
      mockPrisma.badge.upsert.mockResolvedValue({});

      const result = await service.seedBadges();

      expect(mockPrisma.badge.upsert).toHaveBeenCalledTimes(BADGE_CATALOG.length);
      expect(result.seeded).toBe(BADGE_CATALOG.length);
    });
  });

  // ── getUserBadges ──────────────────────────────────────────────────────────
  describe("getUserBadges", () => {
    it("foydalanuvchi badgelarini qaytaradi", async () => {
      const badges = [
        { id: "ub1", badge: { code: "FIRST_BOOK", name: "Birinchi kitob" }, awardedAt: new Date() }
      ];
      mockPrisma.userBadge.findMany.mockResolvedValue(badges);

      const result = await service.getUserBadges("u1");

      expect(mockPrisma.userBadge.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "u1" } })
      );
      expect(result).toHaveLength(1);
    });
  });

  // ── checkAfterReturn ───────────────────────────────────────────────────────
  describe("checkAfterReturn", () => {
    it("birinchi kitob qaytarilganda FIRST_BOOK badge beriladi", async () => {
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(1)  // returnedCount
        .mockResolvedValue(0);     // lateCount fallback
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkAfterReturn("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("5 ta kitob — FIVE_BOOKS badge", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(5).mockResolvedValue(0);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkAfterReturn("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("10 ta kitob vaqtida qaytarilgan — DISCIPLINE badge", async () => {
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(10) // returnedCount
        .mockResolvedValueOnce(0); // lateCount = 0, onTime = 10
      mockPrisma.bookTransaction.findFirst.mockResolvedValue({
        borrowedAt: new Date(Date.now() - 5 * 86400000),
        returnedAt: new Date()
      });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkAfterReturn("u1");

      // TEN_BOOKS + FAST_READER + DISCIPLINE = 3 badge
      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(3);
    });

    it("7 kunda qaytarilgan — FAST_READER badge", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(2).mockResolvedValue(0);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue({
        borrowedAt: new Date(Date.now() - 5 * 86400000), // 5 kun
        returnedAt: new Date()
      });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkAfterReturn("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("5 ta turli janr — DIVERSE_READER badge", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(3).mockResolvedValue(0);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        { book: { genre: "Roman" } },
        { book: { genre: "Tarix" } },
        { book: { genre: "Ilmiy" } },
        { book: { genre: "Badiiy" } },
        { book: { genre: "Fantastika" } },
      ]);

      await service.checkAfterReturn("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("badge topilmasa award qaytmaydi", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(1).mockResolvedValue(0);
      mockPrisma.badge.findUnique.mockResolvedValue(null); // badge yo'q
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkAfterReturn("u1");

      expect(mockPrisma.userBadge.create).not.toHaveBeenCalled();
    });
  });

  // ── checkAfterTest ─────────────────────────────────────────────────────────
  describe("checkAfterTest", () => {
    it("5+ test o'tilganda COMPREHENSION_ACE badge", async () => {
      mockPrisma.comprehensionTest.count.mockResolvedValue(5);

      await service.checkAfterTest("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("5 dan kam test — badge berilmaydi", async () => {
      mockPrisma.comprehensionTest.count.mockResolvedValue(3);

      await service.checkAfterTest("u1");

      expect(mockPrisma.userBadge.create).not.toHaveBeenCalled();
    });
  });

  // ── checkAfterIsbnScan ─────────────────────────────────────────────────────
  describe("checkAfterIsbnScan", () => {
    it("10+ ISBN skan — ISBN_SCANNER badge", async () => {
      mockPrisma.isbnScan.count.mockResolvedValue(10);

      await service.checkAfterIsbnScan("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── checkAfterTrustUpdate ──────────────────────────────────────────────────
  describe("checkAfterTrustUpdate", () => {
    it("trustScore 90+ — TRUST_MASTER badge", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ trustScore: 92 });

      await service.checkAfterTrustUpdate("u1");

      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("trustScore 89 — badge berilmaydi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ trustScore: 89 });

      await service.checkAfterTrustUpdate("u1");

      expect(mockPrisma.userBadge.create).not.toHaveBeenCalled();
    });
  });

  // ── checkAfterDonation ─────────────────────────────────────────────────────
  describe("checkAfterDonation", () => {
    it("donat qilganda DONOR badge beriladi", async () => {
      await service.checkAfterDonation("u1");

      expect(mockPrisma.badge.findUnique).toHaveBeenCalledWith({ where: { code: "DONOR" } });
      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── Plan 03-04 GAME-01: checkAfterReturnForStreak ─────────────────────────
  describe("checkAfterReturnForStreak", () => {
    it("(STREAK_7) 7 ta turli kun → STREAK_7 badge beriladi", async () => {
      const days = Array.from({ length: 7 }, (_, i) => ({
        returnedAt: new Date(Date.now() - i * 86400000),
      }));
      // last30 → 7 entries (distinct days). last60 → same 7 entries (<30 days)
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce(days)
        .mockResolvedValueOnce(days);

      await service.checkAfterReturnForStreak("u1");

      // STREAK_7 awarded, STREAK_30 not (only 7 days)
      const awardedCodes = mockPrisma.badge.findUnique.mock.calls.map(
        (c) => (c[0] as { where: { code: string } }).where.code,
      );
      expect(awardedCodes).toContain("STREAK_7");
      expect(awardedCodes).not.toContain("STREAK_30");
    });

    it("(STREAK_7 negative) 6 ta kun → STREAK_7 berilmaydi", async () => {
      const days = Array.from({ length: 6 }, (_, i) => ({
        returnedAt: new Date(Date.now() - i * 86400000),
      }));
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce(days)
        .mockResolvedValueOnce(days);

      await service.checkAfterReturnForStreak("u1");

      // No award attempted because days30.size < 7
      expect(mockPrisma.badge.findUnique).not.toHaveBeenCalled();
    });

    it("(STREAK_30) 30 ta turli kun in last 60 → STREAK_30 badge beriladi", async () => {
      const days = Array.from({ length: 30 }, (_, i) => ({
        returnedAt: new Date(Date.now() - i * 86400000),
      }));
      // last30 mock: 30 entries (but some > 30 days will be filtered by Prisma where)
      // For Node-side Set logic, all 30 distinct days count.
      const last30 = days.slice(0, 15); // 15 days within last 30
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce(last30) // last30 (size 15 → STREAK_7 yes)
        .mockResolvedValueOnce(days);   // last60 (size 30 → STREAK_30 yes)

      await service.checkAfterReturnForStreak("u1");

      const awardedCodes = mockPrisma.badge.findUnique.mock.calls.map(
        (c) => (c[0] as { where: { code: string } }).where.code,
      );
      expect(awardedCodes).toContain("STREAK_7");
      expect(awardedCodes).toContain("STREAK_30");
    });
  });

  // ── Plan 03-04 GAME-01: checkActiveMonth ───────────────────────────────────
  describe("checkActiveMonth", () => {
    it("top decile (rank 5/100 = 5%) → ACTIVE_MONTH badge beriladi", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { rank: BigInt(4), total: BigInt(100) }, // (4+1)/100 = 0.05 ≤ 0.1
      ]);

      await service.checkActiveMonth("u1", "2026-06");

      expect(mockPrisma.badge.findUnique).toHaveBeenCalledWith({
        where: { code: "ACTIVE_MONTH" },
      });
      expect(mockPrisma.userBadge.create).toHaveBeenCalledTimes(1);
    });

    it("non-top-decile (rank 50/100 = 50%) → badge berilmaydi", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { rank: BigInt(50), total: BigInt(100) },
      ]);

      await service.checkActiveMonth("u1", "2026-06");

      expect(mockPrisma.badge.findUnique).not.toHaveBeenCalled();
    });

    it("zero total (no RI rows) → badge berilmaydi (defensive)", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { rank: BigInt(0), total: BigInt(0) },
      ]);

      await service.checkActiveMonth("u1", "2026-06");

      expect(mockPrisma.badge.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── Plan 03-04 GAME-02: Kafka BADGE_EARNED emit ────────────────────────────
  describe("Kafka BADGE_EARNED emit", () => {
    it("award muvaffaqiyatli bo'lganda BADGE_EARNED event emit qilinadi", async () => {
      mockPrisma.comprehensionTest.count.mockResolvedValue(5);

      await service.checkAfterTest("u1");

      // Allow event-loop microtasks to flush the .catch() chain in award().
      await new Promise((r) => setImmediate(r));

      expect(mockKafka.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: KAFKA_TOPICS.BADGE_EARNED,
          key: "u1",
          value: expect.objectContaining({
            userId: "u1",
            badgeCode: "COMPREHENSION_ACE",
          }),
        })
      );
    });

    it("allaqachon berilgan badge (unique constraint) emit qilmaydi", async () => {
      mockPrisma.comprehensionTest.count.mockResolvedValue(5);
      mockPrisma.userBadge.create.mockRejectedValue(new Error("Unique constraint"));

      await service.checkAfterTest("u1");
      await new Promise((r) => setImmediate(r));

      expect(mockKafka.emit).not.toHaveBeenCalled();
    });
  });
});
