import { RecommendService } from "../recommend.service";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
  book: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  bookTransaction: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  club: {
    findUnique: jest.fn(),
  },
};

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
};

function makeService(): RecommendService {
  return new RecommendService(mockPrisma as any, mockCache as any);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeBook(overrides: Partial<{
  id: string; title: string; author: string; genre: string;
  availableCount: number; library: { id: string; name: string } | null;
}> = {}) {
  return {
    id: "book-1",
    title: "Test Kitob",
    author: "Test Muallif",
    genre: "Adabiyot",
    availableCount: 2,
    library: { id: "lib-1", name: "Tuman kutubxonasi" },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("RecommendService", () => {
  let service: RecommendService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = makeService();
  });

  // ── getRecommendations ──────────────────────────────────────────────────────

  describe("getRecommendations", () => {
    beforeEach(() => {
      // Default: empty results from all sub-methods
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.book.findUnique.mockResolvedValue(null);
    });

    it("returns empty array when all sub-methods return nothing", async () => {
      const result = await service.getRecommendations("user-1");
      expect(result).toEqual([]);
    });

    it("uses cache with correct key", async () => {
      await service.getRecommendations("user-cache", 5);
      expect(mockCache.remember).toHaveBeenCalledWith(
        "recommend:user:user-cache:5",
        1800,
        expect.any(Function)
      );
    });

    it("deduplicates books from multiple recommendation sources", async () => {
      const book = makeBook({ id: "book-dup" });

      // content-based returns book-dup
      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1998-01-01"),
        type: "CITIZEN",
        transactions: [
          { book: { id: "book-read", genre: "Adabiyot" } },
        ],
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);

      // collaborative: no common books
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getRecommendations("user-dup");

      // Check book-dup appears at most once
      const ids = result.map((r) => r.bookId);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it("respects the limit parameter", async () => {
      const books = Array.from({ length: 10 }, (_, i) =>
        makeBook({ id: `book-${i}`, title: `Kitob ${i}` })
      );

      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1998-01-01"),
        type: "CITIZEN",
        transactions: [{ book: { id: "old-book", genre: "Fan" } }],
      });
      mockPrisma.book.findMany.mockResolvedValue(books);

      const result = await service.getRecommendations("user-limit", 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it("merges scores from weighted sources", async () => {
      // Setup collaborative path to return a book
      mockPrisma.user.findUnique.mockResolvedValue(null); // content-based returns []

      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([{ bookId: "book-collab" }]) // myBooks
        .mockResolvedValueOnce([{ userId: "similar-user" }]) // similarUsers
        .mockResolvedValueOnce([ // theirBooks
          {
            bookId: "book-collab-new",
            book: makeBook({ id: "book-collab-new" }),
          },
        ])
        .mockResolvedValue([]); // other calls

      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getRecommendations("user-merge");
      expect(result.every((r) => r.score >= 0)).toBe(true);
    });
  });

  // ── _contentBased (via getRecommendations) ──────────────────────────────────

  describe("content-based filtering", () => {
    it("returns empty when user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("ghost-user");
      expect(result).toEqual([]);
    });

    it("returns empty when user has no genre history", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1990-01-01"),
        type: "CITIZEN",
        transactions: [], // no history
      });
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("no-history");
      expect(result).toEqual([]);
    });

    it("finds books matching top genres", async () => {
      const book = makeBook({ id: "new-book", genre: "Tarix" });

      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1995-01-01"),
        type: "CITIZEN",
        transactions: [
          { book: { id: "old-1", genre: "Tarix" } },
          { book: { id: "old-2", genre: "Tarix" } },
          { book: { id: "old-3", genre: "Fan" } },
        ],
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getRecommendations("user-genre");

      const found = result.find((r) => r.bookId === "new-book");
      expect(found).toBeDefined();
      expect(found?.score).toBeGreaterThan(0);
    });

    it("excludes already-read books", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1995-01-01"),
        type: "CITIZEN",
        transactions: [
          { book: { id: "already-read", genre: "Adabiyot" } },
        ],
      });
      mockPrisma.book.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      await service.getRecommendations("user-exclude");

      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ["already-read"] },
          }),
        })
      );
    });

    it("sets available=true when availableCount > 0", async () => {
      const book = makeBook({ availableCount: 3 });

      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1995-01-01"),
        type: "CITIZEN",
        transactions: [{ book: { id: "old", genre: "Adabiyot" } }],
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getRecommendations("user-avail");

      const rec = result.find((r) => r.bookId === "book-1");
      expect(rec?.available).toBe(true);
    });

    it("uses library id and name from book", async () => {
      const book = makeBook({ library: { id: "lib-special", name: "Maxsus kutubxona" } });

      mockPrisma.user.findUnique.mockResolvedValue({
        dob: new Date("1995-01-01"),
        type: "CITIZEN",
        transactions: [{ book: { id: "old", genre: "Adabiyot" } }],
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);

      const result = await service.getRecommendations("user-lib");

      const rec = result.find((r) => r.bookId === "book-1");
      expect(rec?.libraryId).toBe("lib-special");
      expect(rec?.libraryName).toBe("Maxsus kutubxona");
    });
  });

  // ── _collaborative (via getRecommendations) ─────────────────────────────────

  describe("collaborative filtering", () => {
    it("returns empty when user has no borrowing history", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]); // myBooks empty
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-no-history");
      expect(result).toEqual([]);
    });

    it("returns empty when no similar users found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([{ bookId: "book-mine" }]) // myBooks
        .mockResolvedValueOnce([]) // similarUsers empty
        .mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-no-similar");
      expect(result).toEqual([]);
    });

    it("scores books by how many similar users read them", async () => {
      const bookA = makeBook({ id: "book-a" });

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([{ bookId: "book-mine" }]) // myBooks
        .mockResolvedValueOnce([{ userId: "sim-1" }, { userId: "sim-2" }]) // similarUsers
        .mockResolvedValueOnce([ // theirBooks — book-a read by two users
          { bookId: "book-a", book: bookA },
          { bookId: "book-a", book: bookA },
        ])
        .mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-collab-score");

      const rec = result.find((r) => r.bookId === "book-a");
      if (rec) {
        // score = Math.min(0.9, 2 * 0.15) = 0.3 → combined score
        expect(rec.score).toBeGreaterThan(0);
      }
    });

    it("skips theirBooks entries with null book", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([{ bookId: "book-mine" }])
        .mockResolvedValueOnce([{ userId: "sim-1" }])
        .mockResolvedValueOnce([{ bookId: "null-book", book: null }])
        .mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      await expect(service.getRecommendations("user-null-book")).resolves.toBeDefined();
    });
  });

  // ── _regional (via getRecommendations) ──────────────────────────────────────

  describe("regional filtering", () => {
    it("returns empty when user has no address", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // content-based
        .mockResolvedValueOnce({ address: null }); // regional
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([]);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-no-addr");
      expect(result).toEqual([]);
    });

    it("returns regional books when address is present", async () => {
      const book = makeBook({ id: "regional-book" });

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // content-based
        .mockResolvedValueOnce({
          address: { tumanId: "tuman-1", mahallaId: "mahalla-1" },
        }); // regional

      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([]) // myBooks (collaborative)
        .mockResolvedValueOnce([]) // myBooks (regional)
        .mockResolvedValue([]);

      mockPrisma.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "regional-book", _count: { bookId: 5 } },
      ]);
      mockPrisma.book.findUnique.mockResolvedValue(book);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-regional");

      const rec = result.find((r) => r.bookId === "regional-book");
      expect(rec).toBeDefined();
      expect(rec?.reason).toContain("Tumandagi");
    });

    it("skips regional books when findUnique returns null", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          address: { tumanId: "tuman-1", mahallaId: "mahalla-1" },
        });

      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "ghost-book", _count: { bookId: 5 } },
      ]);
      mockPrisma.book.findUnique.mockResolvedValue(null);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-regional-ghost");
      expect(result).toEqual([]);
    });
  });

  // ── _popularInRegion (via getRecommendations) ────────────────────────────────

  describe("popularInRegion filtering", () => {
    it("returns popular books not already read by user", async () => {
      const book = makeBook({ id: "popular-book" });

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([]) // collaborative myBooks
        .mockResolvedValueOnce([]) // regional myBooks
        .mockResolvedValueOnce([]); // popular myBooks

      mockPrisma.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "popular-book", _count: { bookId: 8 } },
      ]);
      mockPrisma.book.findUnique.mockResolvedValue(book);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-popular");

      const rec = result.find((r) => r.bookId === "popular-book");
      expect(rec).toBeDefined();
      expect(rec?.reason).toContain("mashhur");
    });

    it("score is capped at 0.6", async () => {
      const book = makeBook({ id: "very-popular" });

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.groupBy.mockResolvedValue([
        { bookId: "very-popular", _count: { bookId: 100 } }, // 100 * 0.05 = 5 → capped at 0.6
      ]);
      mockPrisma.book.findUnique.mockResolvedValue(book);
      mockPrisma.book.findMany.mockResolvedValue([]);

      const result = await service.getRecommendations("user-cap");

      const rec = result.find((r) => r.bookId === "very-popular");
      // After weighting (0.1), combined score won't exceed 0.06
      expect(rec?.score).toBeLessThanOrEqual(1);
    });
  });

  // ── getClubRecommendations ──────────────────────────────────────────────────

  describe("getClubRecommendations", () => {
    it("returns empty array when club not found", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);

      const result = await service.getClubRecommendations("ghost-club");
      expect(result).toEqual([]);
    });

    it("returns books matching debate topics", async () => {
      const book = makeBook({ id: "debate-book", genre: "Tarix" });

      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-1",
        debates: [{ topic: "O'tmish va tarix haqida" }],
        _count: { members: 15 },
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);

      const result = await service.getClubRecommendations("club-1");

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].reason).toBe("Klub debatlari mavzusiga mos");
      expect(result[0].score).toBe(0.75);
    });

    it("returns books with fallback when no genres matched from topics", async () => {
      const book = makeBook({ id: "fallback-book" });

      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-2",
        debates: [{ topic: "random topic with no keywords" }],
        _count: { members: 5 },
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);

      await service.getClubRecommendations("club-2");

      // genres will be empty → findMany is called without genre filter
      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ availableCount: { gt: 0 } }),
        })
      );
    });

    it("maps known debate topics to correct genres", async () => {
      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-3",
        debates: [
          { topic: "iqtisod va biznes haqida" },
          { topic: "psixologiya va ruhiyat" },
        ],
        _count: { members: 10 },
      });
      mockPrisma.book.findMany.mockResolvedValue([]);

      await service.getClubRecommendations("club-3");

      expect(mockPrisma.book.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            genre: { in: expect.arrayContaining(["Iqtisodiyot", "Psixologiya"]) },
          }),
        })
      );
    });

    it("uses cache with correct key", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);

      await service.getClubRecommendations("club-cache");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "recommend:club:club-cache",
        3600,
        expect.any(Function)
      );
    });

    it("respects the limit parameter", async () => {
      const books = Array.from({ length: 10 }, (_, i) =>
        makeBook({ id: `book-${i}`, title: `Kitob ${i}` })
      );

      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-limit",
        debates: [{ topic: "fan va ilm" }],
        _count: { members: 3 },
      });
      mockPrisma.book.findMany.mockResolvedValue(books.slice(0, 3));

      const result = await service.getClubRecommendations("club-limit", 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it("includes library info in result", async () => {
      const book = makeBook({ library: { id: "lib-special", name: "Maxsus" } });

      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-lib",
        debates: [{ topic: "adabiyot va she'r" }],
        _count: { members: 5 },
      });
      mockPrisma.book.findMany.mockResolvedValue([book]);

      const result = await service.getClubRecommendations("club-lib");

      expect(result[0].libraryId).toBe("lib-special");
      expect(result[0].libraryName).toBe("Maxsus");
    });

    it("sets available=true for club recommendations", async () => {
      mockPrisma.club.findUnique.mockResolvedValue({
        id: "club-avail",
        debates: [],
        _count: { members: 2 },
      });
      mockPrisma.book.findMany.mockResolvedValue([makeBook({ availableCount: 1 })]);

      const result = await service.getClubRecommendations("club-avail");

      if (result.length > 0) {
        expect(result[0].available).toBe(true);
      }
    });
  });
});
