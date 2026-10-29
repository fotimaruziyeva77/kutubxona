import {
  XP_REWARD,
  LEVEL_THRESHOLDS,
  levelForXp,
  daysBetween,
  startOfUtcDay,
  nextStreak,
} from "../xp-level.util";

describe("xp-level.util", () => {
  // ── levelForXp ──────────────────────────────────────────────────────────────
  describe("levelForXp", () => {
    it("0 XP → 1-level (Yangi kitobxon)", () => {
      const r = levelForXp(0);
      expect(r.level).toBe(1);
      expect(r.name).toBe("Yangi kitobxon");
      expect(r.nextLevelXp).toBe(300);
      expect(r.xpToNextLevel).toBe(300);
      expect(r.progressPct).toBe(0);
    });

    it("chegara qiymatining o'zi keyingi levelni ochadi", () => {
      expect(levelForXp(299).level).toBe(1);
      expect(levelForXp(300).level).toBe(2);
      expect(levelForXp(900).level).toBe(3);
      expect(levelForXp(2000).level).toBe(4);
      expect(levelForXp(4000).level).toBe(5);
    });

    it("level ichidagi progress foizini hisoblaydi", () => {
      // 2-level: 300 → 900, span 600. 600 XP = yarmi.
      const r = levelForXp(600);
      expect(r.level).toBe(2);
      expect(r.progressPct).toBe(50);
      expect(r.xpToNextLevel).toBe(300);
    });

    it("oxirgi levelda nextLevelXp null va progress 100", () => {
      const r = levelForXp(10_000);
      expect(r.level).toBe(5);
      expect(r.name).toBe("Afsona");
      expect(r.nextLevelXp).toBeNull();
      expect(r.xpToNextLevel).toBeNull();
      expect(r.progressPct).toBe(100);
    });

    it("manfiy XP 1-level sifatida ishlanadi (fail-safe)", () => {
      const r = levelForXp(-50);
      expect(r.level).toBe(1);
      expect(r.progressPct).toBe(0);
    });

    it("LEVEL_THRESHOLDS o'suvchi tartibda", () => {
      for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
        expect(LEVEL_THRESHOLDS[i].minXp).toBeGreaterThan(LEVEL_THRESHOLDS[i - 1].minXp);
        expect(LEVEL_THRESHOLDS[i].level).toBe(LEVEL_THRESHOLDS[i - 1].level + 1);
      }
    });
  });

  // ── XP_REWARD ───────────────────────────────────────────────────────────────
  describe("XP_REWARD", () => {
    it("kutubxona kitobi eng ko'p XP beradi (tasdiq zanjiri eng kuchli)", () => {
      expect(XP_REWARD.BOOK_RETURN).toBeGreaterThan(XP_REWARD.COMPREHENSION_PASS);
      expect(XP_REWARD.COMPREHENSION_PASS).toBeGreaterThan(XP_REWARD.STORE_PURCHASE);
    });

    it("barcha qiymatlar musbat", () => {
      for (const v of Object.values(XP_REWARD)) expect(v).toBeGreaterThan(0);
    });
  });

  // ── sana yordamchilari ──────────────────────────────────────────────────────
  describe("startOfUtcDay / daysBetween", () => {
    it("soat/daqiqani tashlab kun boshini qaytaradi", () => {
      const d = new Date("2026-07-31T23:45:12.500Z");
      expect(startOfUtcDay(d).toISOString()).toBe("2026-07-31T00:00:00.000Z");
    });

    it("bir kun ichidagi ikki vaqt orasida 0 kun", () => {
      expect(
        daysBetween(new Date("2026-07-31T01:00:00Z"), new Date("2026-07-31T23:00:00Z")),
      ).toBe(0);
    });

    it("ketma-ket kunlar orasida 1", () => {
      expect(
        daysBetween(new Date("2026-07-31T23:00:00Z"), new Date("2026-08-01T01:00:00Z")),
      ).toBe(1);
    });

    it("oy chegarasidan o'tadi", () => {
      expect(
        daysBetween(new Date("2026-07-30T12:00:00Z"), new Date("2026-08-02T12:00:00Z")),
      ).toBe(3);
    });
  });

  // ── nextStreak ──────────────────────────────────────────────────────────────
  describe("nextStreak", () => {
    const now = new Date("2026-07-31T10:00:00Z");

    it("birinchi hodisa streak ni 1 dan boshlaydi", () => {
      const r = nextStreak(null, 0, 0, now);
      expect(r).toEqual({ currentStreak: 1, longestStreak: 1, sameDay: false });
    });

    it("o'sha kunning ikkinchi hodisasi streak ni oshirmaydi", () => {
      const r = nextStreak(new Date("2026-07-31T02:00:00Z"), 5, 9, now);
      expect(r.currentStreak).toBe(5);
      expect(r.longestStreak).toBe(9);
      expect(r.sameDay).toBe(true);
    });

    it("ertasi kun streak ni +1 qiladi", () => {
      const r = nextStreak(new Date("2026-07-30T22:00:00Z"), 5, 9, now);
      expect(r.currentStreak).toBe(6);
      expect(r.sameDay).toBe(false);
    });

    it("yangi rekord longestStreak ni yangilaydi", () => {
      const r = nextStreak(new Date("2026-07-30T22:00:00Z"), 9, 9, now);
      expect(r.currentStreak).toBe(10);
      expect(r.longestStreak).toBe(10);
    });

    it("2+ kun tanaffus streak ni 1 ga tiklaydi, rekord saqlanadi", () => {
      const r = nextStreak(new Date("2026-07-25T10:00:00Z"), 12, 12, now);
      expect(r.currentStreak).toBe(1);
      expect(r.longestStreak).toBe(12);
      expect(r.sameDay).toBe(false);
    });

    it("kelajakdagi lastActiveDate streak ni noto'g'ri oshirmaydi (fail-safe)", () => {
      const r = nextStreak(new Date("2026-08-05T10:00:00Z"), 3, 7, now);
      expect(r.currentStreak).toBe(3);
      expect(r.longestStreak).toBe(7);
      expect(r.sameDay).toBe(true);
    });
  });
});
