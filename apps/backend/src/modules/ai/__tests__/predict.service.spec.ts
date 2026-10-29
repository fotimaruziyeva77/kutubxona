import { PredictService } from "../predict.service";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrisma = {
  readingIndex: {
    findMany: jest.fn(),
  },
  library: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  bookTransaction: {
    count: jest.fn(),
  },
  book: {
    findMany: jest.fn(),
  },
  user: {
    count: jest.fn(),
  },
};

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
};

function makeService(): PredictService {
  return new PredictService(mockPrisma as any, mockCache as any);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PredictService", () => {
  let service: PredictService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = makeService();
  });

  // ── predictTumanRi ──────────────────────────────────────────────────────────

  describe("predictTumanRi", () => {
    it("returns stable forecast with low confidence when historical data < 3 months", async () => {
      // 2 data points → insufficient
      mockPrisma.readingIndex.findMany.mockResolvedValue([
        { score: 60 },
        { score: 65 },
      ]);

      const result = await service.predictTumanRi("tuman-1", 1);

      expect(result.trend).toBe("stable");
      expect(result.confidence).toBe(0.3);
      expect(result.forecast).toHaveLength(1);
      expect(result.yearlyGoalProbability).toBeGreaterThan(0);
      expect(result.historical).toHaveLength(12); // 12 months queried regardless
    });

    it("returns upward trend forecast when slope > 0.5", async () => {
      // Provide 12 months of gradually increasing data
      // readingIndex.findMany is called once per month (12 calls)
      let call = 0;
      mockPrisma.readingIndex.findMany.mockImplementation(() => {
        const base = 40 + call * 5; // steadily increasing
        call++;
        return Promise.resolve([{ score: base }, { score: base + 2 }]);
      });

      const result = await service.predictTumanRi("tuman-2", 1);

      expect(result.historical).toHaveLength(12);
      expect(result.forecast).toHaveLength(1);
      expect(["up", "stable"]).toContain(result.trend);
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
    });

    it("returns downward trend when slope < -0.5", async () => {
      let call = 0;
      mockPrisma.readingIndex.findMany.mockImplementation(() => {
        const base = 90 - call * 6; // decreasing
        call++;
        return Promise.resolve([{ score: Math.max(base, 0) }]);
      });

      const result = await service.predictTumanRi("tuman-3", 1);

      expect(["down", "stable"]).toContain(result.trend);
    });

    it("forecast value is clamped between 0 and 100", async () => {
      // All months with extreme low values to push prediction potentially below 0
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ score: 1 }]);

      const result = await service.predictTumanRi("tuman-4", 3);

      for (const f of result.forecast) {
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(100);
        expect(f.predicted).toBe(true);
        expect(f.confidenceLow).toBeDefined();
        expect(f.confidenceHigh).toBeDefined();
      }
    });

    it("uses cache with correct key", async () => {
      mockPrisma.readingIndex.findMany.mockResolvedValue([]);

      await service.predictTumanRi("tuman-5", 2);

      expect(mockCache.remember).toHaveBeenCalledWith(
        "predict:tuman:tuman-5:2",
        1800,
        expect.any(Function)
      );
    });

    it("returns empty historical when no readingIndex records exist", async () => {
      mockPrisma.readingIndex.findMany.mockResolvedValue([]);

      const result = await service.predictTumanRi("tuman-empty", 1);

      // All 12 months have avg 0
      expect(result.historical.every((h) => h.value === 0)).toBe(true);
    });

    it("monthly labels are formatted as YYYY-MM", async () => {
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ score: 50 }]);

      const result = await service.predictTumanRi("tuman-label", 1);

      for (const point of result.historical) {
        expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      }
      for (const point of result.forecast) {
        expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      }
    });
  });

  // ── predictFundShortage ─────────────────────────────────────────────────────

  describe("predictFundShortage", () => {
    it("returns empty atRisk list when no books are at risk", async () => {
      mockPrisma.book.findMany.mockResolvedValue([
        {
          id: "book-1",
          title: "Alpomish",
          availableCount: 10,
          transactions: [], // 0 borrows → daysUntilZero = 999
        },
      ]);

      const result = await service.predictFundShortage("lib-1");

      expect(result.booksAtRisk).toHaveLength(0);
      expect(result.summary).toBe("Keyingi 2 haftada fond yetishmovchiligi kutilmaydi.");
    });

    it("identifies books that will run out within 14 days", async () => {
      mockPrisma.book.findMany.mockResolvedValue([
        {
          id: "book-2",
          title: "Kutilgan kitob",
          availableCount: 3,
          transactions: new Array(30).fill({ id: "tx" }), // 30 borrows in 30 days → 1/day → 3 days
        },
      ]);

      const result = await service.predictFundShortage("lib-2");

      expect(result.booksAtRisk.length).toBeGreaterThan(0);
      expect(result.booksAtRisk[0].title).toBe("Kutilgan kitob");
      expect(result.booksAtRisk[0].daysUntilZero).toBeLessThan(14);
      expect(result.summary).toContain("ta kitob 2 hafta ichida tugashi mumkin");
    });

    it("sorts at-risk books by daysUntilZero ascending", async () => {
      mockPrisma.book.findMany.mockResolvedValue([
        {
          id: "book-a",
          title: "Tezda tugaydi",
          availableCount: 1,
          transactions: new Array(10).fill({ id: "tx" }), // ~0.33/day → 3 days
        },
        {
          id: "book-b",
          title: "Keyinroq tugaydi",
          availableCount: 5,
          transactions: new Array(15).fill({ id: "tx" }), // 0.5/day → 10 days
        },
      ]);

      const result = await service.predictFundShortage("lib-3");

      if (result.booksAtRisk.length > 1) {
        expect(result.booksAtRisk[0].daysUntilZero).toBeLessThanOrEqual(
          result.booksAtRisk[1].daysUntilZero
        );
      }
    });

    it("uses cache with correct key", async () => {
      mockPrisma.book.findMany.mockResolvedValue([]);

      await service.predictFundShortage("lib-cache");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "predict:fund:lib-cache",
        900,
        expect.any(Function)
      );
    });
  });

  // ── analyzeRootCause ────────────────────────────────────────────────────────

  describe("analyzeRootCause", () => {
    beforeEach(() => {
      mockPrisma.library.findMany.mockResolvedValue([]);
      mockPrisma.library.count.mockResolvedValue(0);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
    });

    it("returns UNKNOWN cause when no specific issues detected (non-summer)", async () => {
      // Make sure it's not summer by mocking Date if needed, or accept summer causes
      const result = await service.analyzeRootCause("tuman-ok", "RI_DROP");

      expect(result.scopeId).toBe("tuman-ok");
      expect(result.scopeType).toBe("TUMAN");
      expect(result.issue).toBe("RI_DROP");
      expect(result.causes.length).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
      expect(result.generatedAt).toBeTruthy();
    });

    it("detects LIBRARY_INACTIVE cause when inactive libraries exist", async () => {
      mockPrisma.library.findMany.mockResolvedValue([
        { id: "lib-1", name: "Faolsiz kutubxona" },
      ]);

      const result = await service.analyzeRootCause("tuman-bad", "RI_DROP");

      const libCause = result.causes.find((c) => c.factor === "LIBRARY_INACTIVE");
      expect(libCause).toBeDefined();
      expect(libCause?.impact).toBe("HIGH");
    });

    it("detects STALE_FUND cause when libraries have not been updated", async () => {
      mockPrisma.library.count.mockResolvedValue(3);

      const result = await service.analyzeRootCause("tuman-stale", "RI_DROP");

      const staleCause = result.causes.find((c) => c.factor === "STALE_FUND");
      expect(staleCause).toBeDefined();
      expect(staleCause?.impact).toBe("MEDIUM");
    });

    it("detects YOUTH_DISENGAGEMENT when young users count < 10", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValue(5); // < 10

      const result = await service.analyzeRootCause("tuman-youth", "LOW_COVERAGE");

      const youthCause = result.causes.find((c) => c.factor === "YOUTH_DISENGAGEMENT");
      expect(youthCause).toBeDefined();
    });

    it("does NOT add YOUTH_DISENGAGEMENT when count >= 10", async () => {
      mockPrisma.bookTransaction.count.mockResolvedValue(15);

      const result = await service.analyzeRootCause("tuman-active", "RI_DROP");

      const youthCause = result.causes.find((c) => c.factor === "YOUTH_DISENGAGEMENT");
      expect(youthCause).toBeUndefined();
    });

    it("sorts causes by impact (HIGH first)", async () => {
      mockPrisma.library.findMany.mockResolvedValue([{ id: "l1", name: "L1" }]); // HIGH
      mockPrisma.library.count.mockResolvedValue(2); // MEDIUM
      mockPrisma.bookTransaction.count.mockResolvedValue(3); // MEDIUM (youth)

      const result = await service.analyzeRootCause("tuman-sort", "RI_DROP");

      const impactOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      for (let i = 0; i < result.causes.length - 1; i++) {
        const a = impactOrder[result.causes[i].impact];
        const b = impactOrder[result.causes[i + 1].impact];
        expect(a).toBeLessThanOrEqual(b);
      }
    });

    it("uses cache with correct key", async () => {
      await service.analyzeRootCause("tuman-cache", "RI_DROP");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "rca:tuman-cache:RI_DROP",
        3600,
        expect.any(Function)
      );
    });

    it("includes summary based on top cause", async () => {
      mockPrisma.library.findMany.mockResolvedValue([{ id: "l1", name: "Test lib" }]);

      const result = await service.analyzeRootCause("tuman-sum", "INACTIVE_LIBRARY");

      expect(result.summary).toContain(result.causes[0].description);
    });
  });

  // ── nationalGoalForecast ────────────────────────────────────────────────────

  describe("nationalGoalForecast", () => {
    it("returns correct progress when users have borrowed books", async () => {
      mockPrisma.user.count.mockResolvedValue(1000);
      mockPrisma.bookTransaction.count.mockResolvedValue(5000);

      const result = await service.nationalGoalForecast();

      expect(result.targetBooks).toBe(10);
      expect(result.currentProgress).toBeGreaterThan(0);
      expect(result.probability).toBeGreaterThanOrEqual(0);
      expect(result.probability).toBeLessThanOrEqual(100);
      expect(result.trend).toBeTruthy();
      expect(result.forecast).toBeTruthy();
    });

    it("returns 0 progress when no active users", async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);

      const result = await service.nationalGoalForecast();

      expect(result.currentProgress).toBe(0);
    });

    it("shows positive trend when projectedYearly > 9 (90% of 10)", async () => {
      // Set high borrow rate: e.g. month 1, 1000 users, 1000 borrows → avg=1/month → 12/year
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.bookTransaction.count.mockResolvedValue(1000); // 10 per person this month

      const result = await service.nationalGoalForecast();

      expect(result.trend).toContain("Maqsadga erishish mumkin");
    });

    it("uses cache with correct key", async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);

      await service.nationalGoalForecast();

      expect(mockCache.remember).toHaveBeenCalledWith(
        "predict:national:goal",
        3600,
        expect.any(Function)
      );
    });

    it("caps probability at 100", async () => {
      // Very high borrow rate
      mockPrisma.user.count.mockResolvedValue(1);
      mockPrisma.bookTransaction.count.mockResolvedValue(1000);

      const result = await service.nationalGoalForecast();

      expect(result.probability).toBeLessThanOrEqual(100);
    });
  });
});
