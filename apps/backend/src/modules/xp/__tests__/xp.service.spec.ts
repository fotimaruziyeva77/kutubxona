import { XpService } from "../xp.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { KafkaService, KAFKA_TOPICS } from "../../../infra/kafka/kafka.service";
import { XP_REWARD } from "../xp-level.util";

const mockPrisma = {
  userXp: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  // Interactive $transaction: callbackni bevosita mockPrisma bilan chaqiramiz.
  // Implementatsiya obyektdan KEYIN beriladi — obyekt literali ichida
  // `mockPrisma` ga murojaat qilish o'z-o'ziga havola bo'lib, TS ga tipni
  // chiqarishga imkon bermaydi (TS7022/TS7024).
  $transaction: jest.fn(),
};
mockPrisma.$transaction.mockImplementation((cb: (p: unknown) => unknown) => cb(mockPrisma));

const mockKafka = {
  emit: jest.fn().mockResolvedValue(undefined),
};

describe("XpService", () => {
  let service: XpService;

  beforeEach(() => {
    service = new XpService(
      mockPrisma as unknown as PrismaService,
      mockKafka as unknown as KafkaService,
    );
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((cb: (p: unknown) => unknown) => cb(mockPrisma));
    mockPrisma.userXp.upsert.mockResolvedValue({});
    mockKafka.emit.mockResolvedValue(undefined);
  });

  // ── birinchi hodisa ─────────────────────────────────────────────────────────
  describe("birinchi marta XP berish", () => {
    it("qator yo'q bo'lsa 0 dan boshlab yozadi va streak 1 bo'ladi", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue(null);

      const r = await service.awardForBookReturn("u1");

      expect(r.xp).toBe(XP_REWARD.BOOK_RETURN);
      expect(r.level).toBe(1);
      expect(r.currentStreak).toBe(1);
      expect(r.longestStreak).toBe(1);
      expect(r.streakExtended).toBe(true);

      const arg = mockPrisma.userXp.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ userId: "u1" });
      expect(arg.create.xp).toBe(XP_REWARD.BOOK_RETURN);
    });

    it("lastActiveDate kun boshiga normallashtirib yoziladi", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue(null);

      await service.awardForBookReturn("u1");

      const arg = mockPrisma.userXp.upsert.mock.calls[0][0];
      const stored: Date = arg.create.lastActiveDate;
      expect(stored.getUTCHours()).toBe(0);
      expect(stored.getUTCMinutes()).toBe(0);
      expect(stored.getUTCSeconds()).toBe(0);
      expect(stored.getUTCMilliseconds()).toBe(0);
    });
  });

  // ── hodisa turlari ──────────────────────────────────────────────────────────
  describe("hodisa turi bo'yicha XP miqdori", () => {
    beforeEach(() => mockPrisma.userXp.findUnique.mockResolvedValue(null));

    it("comprehension test", async () => {
      const r = await service.awardForComprehensionPass("u1");
      expect(r.xp).toBe(XP_REWARD.COMPREHENSION_PASS);
    });

    it("do'kon xaridi", async () => {
      const r = await service.awardForStorePurchase("u1");
      expect(r.xp).toBe(XP_REWARD.STORE_PURCHASE);
    });

    it("Mutolaa sinxron", async () => {
      const r = await service.awardForMutolaaSync("u1");
      expect(r.xp).toBe(XP_REWARD.MUTOLAA_SYNC);
    });
  });

  // ── level oshishi ───────────────────────────────────────────────────────────
  describe("level oshishi", () => {
    it("chegaradan o'tganda leveledUp true va Kafka emit qilinadi", async () => {
      // 280 XP = 1-level. +50 = 330 → 2-level (chegara 300).
      mockPrisma.userXp.findUnique.mockResolvedValue({
        userId: "u1", xp: 280, level: 1,
        currentStreak: 2, longestStreak: 4,
        lastActiveDate: new Date(Date.now() - 86_400_000),
      });

      const r = await service.awardForBookReturn("u1");

      expect(r.xp).toBe(330);
      expect(r.level).toBe(2);
      expect(r.leveledUp).toBe(true);
      expect(mockKafka.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: KAFKA_TOPICS.XP_LEVEL_UP,
          key: "u1",
        }),
      );
    });

    it("level oshmasa Kafka emit qilinmaydi (shovqin oldini olish)", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue({
        userId: "u1", xp: 10, level: 1,
        currentStreak: 1, longestStreak: 1,
        lastActiveDate: new Date(Date.now() - 86_400_000),
      });

      const r = await service.awardForBookReturn("u1");

      expect(r.leveledUp).toBe(false);
      expect(mockKafka.emit).not.toHaveBeenCalled();
    });

    it("Kafka yiqilsa ham XP saqlanadi (fire-and-forget)", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue({
        userId: "u1", xp: 280, level: 1,
        currentStreak: 1, longestStreak: 1,
        lastActiveDate: new Date(Date.now() - 86_400_000),
      });
      mockKafka.emit.mockRejectedValue(new Error("kafka down"));

      const r = await service.awardForBookReturn("u1");

      expect(r.xp).toBe(330);
      expect(mockPrisma.userXp.upsert).toHaveBeenCalled();
    });
  });

  // ── streak ──────────────────────────────────────────────────────────────────
  describe("streak", () => {
    it("bir kun ichidagi ikkinchi hodisa XP beradi, streak ni oshirmaydi", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue({
        userId: "u1", xp: 100, level: 1,
        currentStreak: 3, longestStreak: 5,
        lastActiveDate: new Date(),
      });

      const r = await service.awardForBookReturn("u1");

      expect(r.xp).toBe(150);            // XP baribir qo'shildi
      expect(r.currentStreak).toBe(3);   // streak o'zgarmadi
      expect(r.streakExtended).toBe(false);
    });
  });

  // ── getForUser ──────────────────────────────────────────────────────────────
  describe("getForUser", () => {
    it("qatori yo'q foydalanuvchi uchun haqiqiy nol-holat qaytaradi", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue(null);

      const r = await service.getForUser("yangi");

      expect(r.xp).toBe(0);
      expect(r.level).toBe(1);
      expect(r.currentStreak).toBe(0);
      expect(r.longestStreak).toBe(0);
      expect(r.lastActiveDate).toBeNull();
    });

    it("mavjud qator uchun level ma'lumoti bilan qaytaradi", async () => {
      mockPrisma.userXp.findUnique.mockResolvedValue({
        userId: "u1", xp: 950, level: 3,
        currentStreak: 4, longestStreak: 11,
        lastActiveDate: new Date("2026-07-30T00:00:00Z"),
      });

      const r = await service.getForUser("u1");

      expect(r.xp).toBe(950);
      expect(r.level).toBe(3);
      expect(r.levelName).toBe("Bilimdon");
      expect(r.nextLevelXp).toBe(2000);
      expect(r.longestStreak).toBe(11);
    });
  });
});
