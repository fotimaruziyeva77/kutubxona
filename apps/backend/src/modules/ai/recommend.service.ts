import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";

export interface BookRecommendation {
  bookId: string;
  title: string;
  author: string;
  genre: string;
  coverUrl?: string;
  reason: string;
  score: number;
  libraryName?: string;
  libraryId?: string;
  available: boolean;
}

@Injectable()
export class RecommendService {
  private readonly logger = new Logger(RecommendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ── Asosiy tavsiya metodi ─────────────────────────────────────────────────

  async getRecommendations(
    userId: string,
    limit = 5
  ): Promise<BookRecommendation[]> {
    const cacheKey = `recommend:user:${userId}:${limit}`;
    return this.cache.remember(cacheKey, 1800, async () => {
      const [contentBased, collaborative, regional, popular] = await Promise.all([
        this._contentBased(userId, limit),
        this._collaborative(userId, limit),
        this._regional(userId, limit),
        this._popularInRegion(userId, limit),
      ]);

      // Barcha tavsiyalarni birlashtirish va deduplicate qilish
      const merged = new Map<string, BookRecommendation & { totalScore: number }>();

      for (const [recs, weight] of [
        [contentBased, 0.35],
        [collaborative, 0.3],
        [regional, 0.2],
        [popular, 0.15],
      ] as Array<[BookRecommendation[], number]>) {
        for (const rec of recs) {
          const existing = merged.get(rec.bookId);
          if (existing) {
            existing.totalScore += rec.score * weight;
          } else {
            merged.set(rec.bookId, { ...rec, totalScore: rec.score * weight });
          }
        }
      }

      return Array.from(merged.values())
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, limit)
        .map(({ totalScore, ...rec }) => ({ ...rec, score: Math.round(totalScore * 100) / 100 }));
    });
  }

  // ── Content-based filtering (janr + yosh asosida) ────────────────────────

  private async _contentBased(userId: string, limit: number): Promise<BookRecommendation[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dob: true,
        type: true,
        transactions: {
          where: { status: "RETURNED", type: "BORROW" },
          orderBy: { borrowedAt: "desc" },
          take: 20,
          select: { book: { select: { id: true, genre: true } } },
        },
      },
    });
    if (!user) return [];

    // Oxirgi o'qilgan janrlar
    const genreCounts: Record<string, number> = {};
    for (const t of user.transactions) {
      const genre = t.book?.genre;
      if (genre) genreCounts[genre] = (genreCounts[genre] ?? 0) + 1;
    }

    const topGenres = Object.entries(genreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g);

    if (topGenres.length === 0) return [];

    // Allaqachon o'qilgan kitoblar
    const readBookIds = user.transactions
      .map((t) => t.book?.id)
      .filter((id): id is string => !!id);

    const books = await this.prisma.book.findMany({
      where: {
        genre: { in: topGenres },
        availableCount: { gt: 0 },
        id: { notIn: readBookIds },
      },
      include: { library: { select: { id: true, name: true } } },
      orderBy: { availableCount: "desc" },
      take: limit * 2,
    });

    return books.slice(0, limit).map((b) => ({
      bookId: b.id,
      title: b.title,
      author: b.author,
      genre: b.genre,
      reason: `Siz ${topGenres[0] ?? b.genre} janrini yaxshi ko'rasiz`,
      score: 0.8,
      libraryName: b.library?.name,
      libraryId: b.library?.id,
      available: b.availableCount > 0,
    }));
  }

  // ── Collaborative filtering (o'xshash kitobxonlar) ──────────────────────

  private async _collaborative(userId: string, limit: number): Promise<BookRecommendation[]> {
    // Foydalanuvchi o'qigan kitoblar
    const myBooks = await this.prisma.bookTransaction.findMany({
      where: { userId, status: "RETURNED", type: "BORROW" },
      select: { bookId: true },
      take: 30,
    });
    const myBookIds = myBooks.map((b) => b.bookId);
    if (myBookIds.length === 0) return [];

    // Bir xil kitoblarni o'qigan boshqa foydalanuvchilar
    const similarUsers = await this.prisma.bookTransaction.findMany({
      where: {
        bookId: { in: myBookIds },
        userId: { not: userId },
        status: "RETURNED",
      },
      distinct: ["userId"],
      select: { userId: true },
      take: 50,
    });
    const similarUserIds = similarUsers.map((u) => u.userId);
    if (similarUserIds.length === 0) return [];

    // O'xshash foydalanuvchilar o'qigan, lekin men o'qimagan kitoblar
    const theirBooks = await this.prisma.bookTransaction.findMany({
      where: {
        userId: { in: similarUserIds },
        bookId: { notIn: myBookIds },
        status: "RETURNED",
        book: { availableCount: { gt: 0 } },
      },
      include: {
        book: { include: { library: { select: { id: true, name: true } } } },
      },
      take: limit * 3,
    });

    // Shu kitob necha o'xshash foydalanuvchi o'qigan → score
    const bookScoreMap = new Map<string, { book: typeof theirBooks[0]["book"]; count: number }>();
    for (const t of theirBooks) {
      if (!t.book) continue;
      const existing = bookScoreMap.get(t.bookId);
      if (existing) existing.count++;
      else bookScoreMap.set(t.bookId, { book: t.book, count: 1 });
    }

    return Array.from(bookScoreMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(({ book, count }) => ({
        bookId: book.id,
        title: book.title,
        author: book.author,
        genre: book.genre,
        reason: `${count} ta o'xshash kitobxon o'qigan`,
        score: Math.min(0.9, count * 0.15),
        libraryName: book.library?.name,
        libraryId: book.library?.id,
        available: book.availableCount > 0,
      }));
  }

  // ── Mahalla/tuman bo'yicha mashhur kitoblar ───────────────────────────────

  private async _regional(userId: string, limit: number): Promise<BookRecommendation[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { address: { select: { tumanId: true, mahallaId: true } } },
    });
    if (!user?.address?.tumanId) return [];

    const myBooks = await this.prisma.bookTransaction.findMany({
      where: { userId },
      select: { bookId: true },
    });
    const myBookIds = myBooks.map((b) => b.bookId);

    const regional = await this.prisma.bookTransaction.groupBy({
      by: ["bookId"],
      where: {
        userId: { not: userId },
        bookId: { notIn: myBookIds },
        type: "BORROW",
        user: { address: { tumanId: user.address.tumanId } },
        borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { bookId: true },
      orderBy: { _count: { bookId: "desc" } },
      take: limit,
    });

    const result: BookRecommendation[] = [];
    for (const { bookId, _count } of regional) {
      const book = await this.prisma.book.findUnique({
        where: { id: bookId },
        include: { library: { select: { id: true, name: true } } },
      });
      if (!book) continue;
      result.push({
        bookId: book.id,
        title: book.title,
        author: book.author,
        genre: book.genre,
        reason: `Tumandagi ${_count.bookId} kitobxon bu oyda o'qidi`,
        score: Math.min(0.7, _count.bookId * 0.1),
        libraryName: book.library?.name,
        libraryId: book.library?.id,
        available: book.availableCount > 0,
      });
    }
    return result;
  }

  // ── Kasb bo'yicha (davlat xizmatchilari uchun) ────────────────────────────

  private async _popularInRegion(userId: string, limit: number): Promise<BookRecommendation[]> {
    const myBooks = await this.prisma.bookTransaction.findMany({
      where: { userId },
      select: { bookId: true },
    });
    const myBookIds = myBooks.map((b) => b.bookId);

    const popular = await this.prisma.bookTransaction.groupBy({
      by: ["bookId"],
      where: {
        type: "BORROW",
        bookId: { notIn: myBookIds },
        borrowedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { bookId: true },
      orderBy: { _count: { bookId: "desc" } },
      take: limit,
    });

    const result: BookRecommendation[] = [];
    for (const { bookId, _count } of popular) {
      const book = await this.prisma.book.findUnique({
        where: { id: bookId },
        include: { library: { select: { id: true, name: true } } },
      });
      if (!book) continue;
      result.push({
        bookId: book.id,
        title: book.title,
        author: book.author,
        genre: book.genre,
        reason: `Bu oy ${_count.bookId} kitobxon o'qidi (mashhur)`,
        score: Math.min(0.6, _count.bookId * 0.05),
        libraryName: book.library?.name,
        libraryId: book.library?.id,
        available: book.availableCount > 0,
      });
    }
    return result;
  }

  // ── Klub debati uchun kitob tavsiyalari ───────────────────────────────────

  async getClubRecommendations(clubId: string, limit = 5): Promise<BookRecommendation[]> {
    const cacheKey = `recommend:club:${clubId}`;
    return this.cache.remember(cacheKey, 3600, async () => {
      const club = await this.prisma.club.findUnique({
        where: { id: clubId },
        include: {
          debates: { orderBy: { heldAt: "desc" }, take: 5, select: { topic: true } },
          _count: { select: { members: true } },
        },
      });
      if (!club) return [];

      // Debat mavzulariga mos kitoblar (oddiy janr matching)
      const debateTopics = club.debates.map((d) => d.topic.toLowerCase());
      const genres = this._inferGenresFromTopics(debateTopics);

      const books = await this.prisma.book.findMany({
        where: {
          genre: { in: genres.length > 0 ? genres : undefined },
          availableCount: { gt: 0 },
        },
        include: { library: { select: { id: true, name: true } } },
        orderBy: { availableCount: "desc" },
        take: limit,
      });

      return books.map((b) => ({
        bookId: b.id,
        title: b.title,
        author: b.author,
        genre: b.genre,
        reason: "Klub debatlari mavzusiga mos",
        score: 0.75,
        libraryName: b.library?.name,
        libraryId: b.library?.id,
        available: true,
      }));
    });
  }

  // ── Janr aniqlash ─────────────────────────────────────────────────────────

  private _inferGenresFromTopics(topics: string[]): string[] {
    const genreKeywords: Record<string, string[]> = {
      "Tarix":         ["tarix", "o'tmish", "davlat", "qadimgi", "amir"],
      "Falsafa":       ["falsafa", "fikr", "hayot", "ma'no", "etika"],
      "Fan":           ["fan", "ilm", "texnologiya", "kompyuter", "fizika"],
      "Adabiyot":      ["adabiyot", "she'r", "roman", "hikoya", "yozuvchi"],
      "Iqtisodiyot":   ["iqtisod", "biznes", "pul", "moliya", "bozor"],
      "Psixologiya":   ["psixologiya", "ruhiyat", "ong", "xulq", "shaxsiyat"],
    };

    const matchedGenres = new Set<string>();
    for (const topic of topics) {
      for (const [genre, keywords] of Object.entries(genreKeywords)) {
        if (keywords.some((kw) => topic.includes(kw))) {
          matchedGenres.add(genre);
        }
      }
    }
    return Array.from(matchedGenres);
  }
}
