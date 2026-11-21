import { ForbiddenException } from "@nestjs/common";
import { BookSocialService } from "../book-social.service";

describe("BookSocialService", () => {
  const now = new Date("2026-11-21T00:00:00Z");

  it("displayName: kattalar — 'Ism F.', 14 yoshgacha — faqat bosh harflar", () => {
    expect(BookSocialService.displayName("Aziz Karimov", new Date("1990-01-01"), now)).toBe("Aziz K.");
    expect(BookSocialService.displayName("Aziz Karimov", new Date("2015-01-01"), now)).toBe("A.K.");
    expect(BookSocialService.displayName("Aziz", null, now)).toBe("Aziz");
    expect(BookSocialService.displayName("", null, now)).toBe("Kitobxon");
  });

  it("upsertReview: asarga avvalgi izoh bo'lsa yangilaydi", async () => {
    const prisma: any = {
      book: { findUnique: jest.fn().mockResolvedValue({ id: "b1", isbn: "9789943452787", title: "T", author: "A", libraryId: "l1" }) },
      bookReview: {
        findFirst: jest.fn().mockResolvedValue({ id: "r1" }),
        update: jest.fn().mockResolvedValue({ id: "r1", rating: 4 }),
        create: jest.fn()
      }
    };
    const svc = new BookSocialService(prisma);
    await svc.upsertReview("b1", "u1", { rating: 4, text: "  zo'r  " });
    expect(prisma.bookReview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", book: { isbn: "9789943452787" } } })
    );
    expect(prisma.bookReview.update).toHaveBeenCalledWith(expect.objectContaining({ data: { rating: 4, text: "zo'r" } }));
    expect(prisma.bookReview.create).not.toHaveBeenCalled();
  });

  it("deleteReview: begona kitobxon o'chira olmaydi", async () => {
    const prisma: any = {
      bookReview: { findUnique: jest.fn().mockResolvedValue({ id: "r1", userId: "u1", book: { libraryId: "l1" } }), delete: jest.fn() }
    };
    const svc = new BookSocialService(prisma);
    await expect(svc.deleteReview("r1", { sub: "u2", role: "KITOBXON" })).rejects.toBeInstanceOf(ForbiddenException);
    await svc.deleteReview("r1", { sub: "u1", role: "KITOBXON" });
    expect(prisma.bookReview.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });
});
