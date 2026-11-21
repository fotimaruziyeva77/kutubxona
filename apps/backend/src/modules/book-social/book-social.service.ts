import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { resolveCallerLibraryId } from "../../common/utils/library-scope.util";

export interface ReviewInput {
  rating: number;
  text?: string | null;
}

type Caller = { sub: string; role: UserRole | string };

/**
 * Kitob izohlari (1–5 baho + ixtiyoriy matn) va «Saralanganlar».
 *
 * Book jadvali = kutubxonadagi NUSXA yozuvi: bitta asar bir necha kutubxonada
 * alohida qator. Izohlar ASAR bo'yicha yig'iladi (haqiqiy ISBN, yo'q bo'lsa
 * nom+muallif) — Navoiydagi nusxaga yozilgan izoh Toshkentdagi nusxada ham
 * ko'rinadi. Saralanganlar esa aniq nusxaga (kutubxonaga) bog'lanadi.
 */
@Injectable()
export class BookSocialService {
  constructor(private readonly prisma: PrismaService) {}

  private async getBook(bookId: string) {
    const book = await this.prisma.book.findUnique({
      where: { id: bookId },
      select: { id: true, isbn: true, title: true, author: true, libraryId: true }
    });
    if (!book) throw new NotFoundException("Kitob topilmadi");
    return book;
  }

  /** Ichki kod ("2..." bilan boshlanadigan) ISBN haqiqiy emas — nom+muallif. */
  private workWhere(book: { isbn: string; title: string; author: string }): Prisma.BookWhereInput {
    const realIsbn = book.isbn && !book.isbn.startsWith("2") ? book.isbn : null;
    return realIsbn ? { isbn: realIsbn } : { title: book.title, author: book.author };
  }

  /**
   * Ommaviy ism: "Ism F." — familiya to'liq ko'rsatilmaydi; 14 yoshgacha
   * bolalar faqat bosh harflar bilan (CLAUDE.md §V.4 maxfiylik qoidasi).
   */
  static displayName(name: string, dob: Date | null, now = new Date()): string {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "Kitobxon";
    let age = 99;
    if (dob) {
      age = now.getFullYear() - dob.getFullYear();
      const m = now.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    }
    if (age < 14) return parts.map((p) => `${p[0].toUpperCase()}.`).join("");
    return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
  }

  async listReviews(bookId: string, page = 1, limit = 10) {
    const book = await this.getBook(bookId);
    const where: Prisma.BookReviewWhereInput = { book: this.workWhere(book) };
    const take = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
    const p = Math.max(Math.trunc(page) || 1, 1);
    const [total, agg, groups, rows] = await Promise.all([
      this.prisma.bookReview.count({ where }),
      this.prisma.bookReview.aggregate({ where, _avg: { rating: true } }),
      this.prisma.bookReview.groupBy({ by: ["rating"], where, _count: { _all: true } }),
      this.prisma.bookReview.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (p - 1) * take,
        take,
        select: {
          id: true,
          rating: true,
          text: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { name: true, dob: true } }
        }
      })
    ]);
    const distribution = [1, 2, 3, 4, 5].map(
      (r) => groups.find((g) => g.rating === r)?._count._all ?? 0
    );
    return {
      total,
      average: agg._avg.rating !== null ? Math.round(agg._avg.rating * 10) / 10 : null,
      distribution,
      page: p,
      limit: take,
      data: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        text: r.text,
        createdAt: r.createdAt,
        edited: r.updatedAt.getTime() - r.createdAt.getTime() > 60_000,
        author: BookSocialService.displayName(r.user.name, r.user.dob)
      }))
    };
  }

  async myReview(bookId: string, userId: string) {
    const book = await this.getBook(bookId);
    return this.prisma.bookReview.findFirst({
      where: { userId, book: this.workWhere(book) },
      select: { id: true, rating: true, text: true, createdAt: true }
    });
  }

  /** Bir asarga bitta izoh — qayta yozilsa mavjudi yangilanadi. */
  async upsertReview(bookId: string, userId: string, input: ReviewInput) {
    const book = await this.getBook(bookId);
    const text = input.text?.trim() ? input.text.trim().slice(0, 1000) : null;
    const existing = await this.prisma.bookReview.findFirst({
      where: { userId, book: this.workWhere(book) },
      select: { id: true }
    });
    const select = { id: true, rating: true, text: true, createdAt: true } as const;
    if (existing) {
      return this.prisma.bookReview.update({
        where: { id: existing.id },
        data: { rating: input.rating, text },
        select
      });
    }
    return this.prisma.bookReview.create({
      data: { bookId: book.id, userId, rating: input.rating, text },
      select
    });
  }

  /** O'chirish: muallifning o'zi, super admin yoki shu kitob kutubxonasi xodimi. */
  async deleteReview(reviewId: string, caller: Caller) {
    const review = await this.prisma.bookReview.findUnique({
      where: { id: reviewId },
      select: { id: true, userId: true, book: { select: { libraryId: true } } }
    });
    if (!review) throw new NotFoundException("Izoh topilmadi");
    if (review.userId !== caller.sub && caller.role !== UserRole.SUPER_ADMIN) {
      const staff: string[] = [UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN];
      const own = staff.includes(String(caller.role))
        ? await resolveCallerLibraryId(this.prisma, caller.sub)
        : null;
      if (!own || own !== review.book.libraryId) {
        throw new ForbiddenException("Bu izohni o'chira olmaysiz");
      }
    }
    await this.prisma.bookReview.delete({ where: { id: reviewId } });
  }

  async isFavorite(bookId: string, userId: string) {
    const row = await this.prisma.favoriteBook.findUnique({
      where: { userId_bookId: { userId, bookId } },
      select: { bookId: true }
    });
    return { favorite: !!row };
  }

  async addFavorite(bookId: string, userId: string) {
    await this.getBook(bookId);
    await this.prisma.favoriteBook.upsert({
      where: { userId_bookId: { userId, bookId } },
      create: { userId, bookId },
      update: {}
    });
    return { favorite: true };
  }

  async removeFavorite(bookId: string, userId: string) {
    await this.prisma.favoriteBook.deleteMany({ where: { userId, bookId } });
    return { favorite: false };
  }

  async listFavorites(userId: string) {
    const rows = await this.prisma.favoriteBook.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        createdAt: true,
        book: {
          select: {
            id: true,
            title: true,
            author: true,
            genre: true,
            coverUrl: true,
            availableCount: true,
            totalCount: true,
            library: { select: { name: true, code: true } }
          }
        }
      }
    });
    // Muqova data-URL'i javobga qo'yilmaydi — /books/:id/cover orqali yuklanadi.
    return rows.map(({ createdAt, book: { coverUrl, ...b } }) => ({
      ...b,
      hasCover: !!coverUrl,
      savedAt: createdAt
    }));
  }
}
