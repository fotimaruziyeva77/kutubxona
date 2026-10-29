import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { SmsService } from "../../infra/sms/sms.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { BadgeService } from "../badge/badge.service";
import { XpService } from "../xp/xp.service";
import { Prisma, TransactionStatus, TransactionType, UserStatus } from "@prisma/client";

const BORROW_DAYS = 14;
const EXTEND_DAYS = 7;
const RESERVATION_TTL_HOURS = 24;
// AUDIT-REPORT M14 — RESERVED (tasdiqlangan) bronlar uchun maksimal kutish
// muddati. TZ da bu holat uchun aniq qiymat belgilanmagan; 72 soat (3 kun)
// tanlandi: kutubxonachi tasdiqlagan, lekin kitobxon olib ketmagan bronlar
// shu muddatdan keyin avtomatik bekor qilinadi va nusxa fondga qaytadi.
const RESERVED_EXPIRE_HOURS = 72;
const TRUST_SCORE_BONUS_THRESHOLD = 90;

// BOOK-05 (Plan 02-02 Task 5) — Surface the Book CHECK constraint violation
// (book_availablecount_nonneg) as a clean 400 BadRequestException instead of
// a 500. P2010 is Prisma's catch-all for raw query errors, which includes
// CHECK constraint failures wrapped by the connector. P2002/P2003 cover the
// unique / FK violation cases that a parallel writer might also trigger
// while racing on availableCount.
function isRaceError(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === "P2010") {
    const meta = (e.meta ?? {}) as { message?: string };
    const msg = `${meta.message ?? ""} ${e.message}`.toLowerCase();
    return msg.includes("book_availablecount_nonneg") || msg.includes("check");
  }
  // P2002 unique violation, P2003 FK violation — these can surface when two
  // workers race the same row. Treat as a retryable race condition.
  return e.code === "P2002" || e.code === "P2003";
}

function rethrowRace(e: unknown): never {
  if (isRaceError(e)) {
    throw new BadRequestException("Inventory race condition — retry");
  }
  throw e;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly badge: BadgeService,
    private readonly xp: XpService,
    // AUDIT-REPORT H8 (FIX 4) — distributed leader lock for the @Cron handlers.
    // Three backend replicas would each fire autoExpireReservations /
    // checkOverdueAlerts; Redis SETNX gates so only one replica wins (same
    // Plan 04-04 FIX F pattern as payment/subscription.service.ts).
    private readonly redisLock: RedisLockService
  ) {}

  // ── Yordamchi: foydalanuvchi turi bo'yicha limit ─────────────────────────
  private getBorrowLimit(type: string, trustScore: number): number {
    const base: Record<string, number> = {
      CITIZEN: 2,
      STUDENT_SCHOOL: 3,
      STUDENT_UNIVERSITY: 5,
      GOVERNMENT_EMPLOYEE: 3,
      TEACHER: 3
    };
    const limit = base[type] ?? 2;
    return trustScore >= TRUST_SCORE_BONUS_THRESHOLD ? limit + 1 : limit;
  }

  // ── Yordamchi: muddati o'tgan kitob bormi (blok tekshiruvi) ──────────────
  private async hasOverdueBooks(userId: string): Promise<boolean> {
    const now = new Date();
    const overdue = await this.prisma.bookTransaction.count({
      where: {
        userId,
        status: TransactionStatus.BORROWED,
        dueDate: { lt: now }
      }
    });
    return overdue > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. BRON QILISH (Kitobxon → PENDING, kutubxonachi → RESERVED)
  // ─────────────────────────────────────────────────────────────────────────

  async reserve(userId: string, bookId: string) {
    const [user, book] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.book.findUnique({ where: { id: bookId }, include: { library: true } })
    ]);

    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException("Foydalanuvchi faol emas");
    if (!book) throw new NotFoundException("Kitob topilmadi");
    if (book.availableCount <= 0) throw new BadRequestException("Kitob mavjud emas");

    // Mavjud bron bormi?
    const existing = await this.prisma.bookTransaction.findFirst({
      where: { userId, bookId, status: { in: [TransactionStatus.PENDING, TransactionStatus.RESERVED] } }
    });
    if (existing) throw new BadRequestException("Bu kitob allaqachon bron qilingan");

    // Muddati o'tgan kitob bormi?
    if (await this.hasOverdueBooks(userId)) {
      throw new ForbiddenException("Muddati o'tgan kitoblarni qaytaring");
    }

    // BOOK-03: reserve-time borrow limit (PENDING + RESERVED + BORROWED) ─────
    // Previously the limit was only enforced inside borrow(), letting users
    // queue reservations beyond their cap and hold scarce copies hostage.
    const activeCount = await this.prisma.bookTransaction.count({
      where: {
        userId,
        status: {
          in: [
            TransactionStatus.BORROWED,
            TransactionStatus.RESERVED,
            TransactionStatus.PENDING
          ]
        }
      }
    });
    const limit = this.getBorrowLimit(user.type, user.trustScore);
    if (activeCount >= limit) {
      throw new ForbiddenException(
        `Kitob olish limitiga yetdingiz (${limit} ta). Avval bir nechta kitobni qaytaring.`
      );
    }

    const reservationExpiresAt = new Date(Date.now() + RESERVATION_TTL_HOURS * 60 * 60 * 1000);

    // AUDIT-REPORT M13 — borrow() bilan bir xil himoya: parallel so'nggi-nusxa
    // bronlarida Book CHECK constraint (book_availablecount_nonneg) buzilishi
    // 500 emas, toza 400 BadRequestException bo'lib qaytadi.
    try {
      const tx = await this.prisma.$transaction(async (p) => {
        const transaction = await p.bookTransaction.create({
          data: {
            userId,
            bookId,
            type: TransactionType.RESERVE,
            status: TransactionStatus.PENDING,
            reservationExpiresAt
          }
        });
        // Nusxani vaqtincha ajratib qo'yamiz
        await p.book.update({
          where: { id: bookId },
          data: { availableCount: { decrement: 1 } }
        });
        return transaction;
      });

      // Kutubxonachiga SMS (kutubxona telefon raqami bo'lsa)
      if (book.library.phone) {
        await this.sms.sendNotification(
          book.library.phone,
          `SIFAT: "${book.title}" kitobiga bron. Kitobxon: ${user.name} (${user.sifatId ?? user.phone}). 24 soat ichida tasdiqlang.`,
          userId
        );
      }

      return tx;
    } catch (e) {
      rethrowRace(e);
    }
  }

  // Kutubxonachi bronni tasdiqlaydi: PENDING → RESERVED
  async confirmReservation(transactionId: string) {
    const tx = await this.prisma.bookTransaction.findUnique({
      where: { id: transactionId },
      include: { user: true, book: true }
    });
    if (!tx) throw new NotFoundException("Bron topilmadi");
    if (tx.status !== TransactionStatus.PENDING) {
      throw new BadRequestException("Bron kutilayotgan holatda emas");
    }

    const updated = await this.prisma.bookTransaction.update({
      where: { id: transactionId },
      data: { status: TransactionStatus.RESERVED }
    });

    await this.sms.sendNotification(
      tx.user.phone,
      `SIFAT: "${tx.book.title}" broniz tasdiqlandi! Kutubxonaga kelib oling.`,
      tx.userId
    );

    return updated;
  }

  // Bron bekor qilish
  async cancelReservation(transactionId: string, requesterId: string, isLibrarian = false) {
    const tx = await this.prisma.bookTransaction.findUnique({
      where: { id: transactionId },
      include: { user: true, book: true }
    });
    if (!tx) throw new NotFoundException("Bron topilmadi");
    if (!isLibrarian && tx.userId !== requesterId) {
      throw new ForbiddenException("Bu bron sizga tegishli emas");
    }
    if (tx.status !== TransactionStatus.PENDING && tx.status !== TransactionStatus.RESERVED) {
      throw new BadRequestException("Bekor qilib bo'lmaydigan holat");
    }

    try {
      await this.prisma.$transaction(async (p) => {
        await p.bookTransaction.update({
          where: { id: transactionId },
          data: { status: TransactionStatus.CANCELLED }
        });
        await p.book.update({
          where: { id: tx.bookId },
          data: { availableCount: { increment: 1 } }
        });
      });
    } catch (e) {
      rethrowRace(e);
    }

    if (!isLibrarian) {
      await this.sms.sendNotification(
        tx.user.phone,
        `SIFAT: "${tx.book.title}" broniz bekor qilindi.`,
        tx.userId
      );
    }

    return { cancelled: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. KITOB BERISH (QR skan, kutubxonachi)
  // ─────────────────────────────────────────────────────────────────────────

  // Qaytarish muddatini hisoblash — kutubxonachi bergan sana (ixtiyoriy), aks
  // holda standart 14 kun. Sana kelajakda va max 90 kun ichida bo'lishi shart.
  private resolveDueDate(iso?: string): Date {
    const def = new Date(Date.now() + BORROW_DAYS * 24 * 60 * 60 * 1000);
    if (!iso) return def;
    // Sana-only (yyyy-mm-dd) bo'lsa, o'sha kun oxiriga (23:59) o'rnatamiz.
    const raw = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T23:59:59` : iso;
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
      throw new BadRequestException("Qaytarish muddati noto'g'ri");
    }
    const now = Date.now();
    if (d.getTime() <= now) {
      throw new BadRequestException("Qaytarish muddati kelajakda bo'lishi kerak");
    }
    if (d.getTime() > now + 90 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException("Qaytarish muddati 90 kundan oshmasligi kerak");
    }
    return d;
  }

  async borrow(userId: string, bookId: string, reservationId?: string, dueDateIso?: string) {
    const [user, book] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.book.findUnique({ where: { id: bookId } })
    ]);

    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (!book) throw new NotFoundException("Kitob topilmadi");
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException("Foydalanuvchi faol emas");

    // Muddati o'tgan kitob bloki
    if (await this.hasOverdueBooks(userId)) {
      throw new ForbiddenException("Muddati o'tgan kitoblar bor. Avval qaytaring.");
    }

    // Aktiv brondan berish
    if (reservationId) {
      const reservation = await this.prisma.bookTransaction.findUnique({
        where: { id: reservationId }
      });
      if (!reservation || reservation.userId !== userId || reservation.bookId !== bookId) {
        throw new BadRequestException("Bron mos kelmadi");
      }
      if (reservation.status !== TransactionStatus.RESERVED) {
        throw new BadRequestException("Bron tasdiqlanmagan");
      }
      // Bronni BORROWED ga o'tkazamiz (availableCount allaqachon decrementlangan)
      const dueDate = this.resolveDueDate(dueDateIso);
      return this.prisma.bookTransaction.update({
        where: { id: reservationId },
        data: {
          type: TransactionType.BORROW,
          status: TransactionStatus.BORROWED,
          borrowedAt: new Date(),
          dueDate
        }
      });
    }

    // To'g'ridan-to'g'ri berish (bron yo'q)
    if (book.availableCount <= 0) throw new BadRequestException("Kitob mavjud emas");

    const activeBorrows = await this.prisma.bookTransaction.count({
      where: { userId, status: TransactionStatus.BORROWED }
    });
    const limit = this.getBorrowLimit(user.type, user.trustScore);
    if (activeBorrows >= limit) {
      throw new BadRequestException(`Limit: ${limit} ta. Hozir ${activeBorrows} ta kitob qo'lda.`);
    }

    const dueDate = this.resolveDueDate(dueDateIso);

    try {
      // Decrement availableCount BEFORE creating the BookTransaction row so
      // the CHECK constraint fires on the race-loser as early as possible.
      // The interactive callback form gives Prisma a single Postgres
      // transaction with row-level locking semantics — array-form was a
      // sequence of separate auto-commit operations.
      const transaction = await this.prisma.$transaction(async (p) => {
        await p.book.update({
          where: { id: bookId },
          data: { availableCount: { decrement: 1 } }
        });
        return p.bookTransaction.create({
          data: {
            userId,
            bookId,
            type: TransactionType.BORROW,
            status: TransactionStatus.BORROWED,
            borrowedAt: new Date(),
            dueDate
          }
        });
      });
      return transaction;
    } catch (e) {
      rethrowRace(e);
    }
  }

  // Muddat uzaytirish (1 marta, 7 kun)
  // H6 fix — uses the dedicated `extended Boolean` column added in migration
  // 20260607000000 instead of the legacy `penaltyDays = -1` sentinel.
  async extendDueDate(transactionId: string, userId: string) {
    const tx = await this.prisma.bookTransaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException("Tranzaksiya topilmadi");
    if (tx.userId !== userId) throw new ForbiddenException("Ruxsat yo'q");
    if (tx.status !== TransactionStatus.BORROWED) throw new BadRequestException("Berilgan kitob emas");
    // AUDIT-REPORT M15 — muddati o'tganlik to'g'ridan-to'g'ri dueDate < now
    // bilan tekshiriladi. Avvalgi penaltyDays > 0 sharti yetarli emas edi:
    // penaltyDays faqat tungi cron (recomputeOverdueDays, 23:59) da yoziladi,
    // shu sabab kun davomida muddati o'tgan kitobni hali ham uzaytirish
    // mumkin bo'lib qolardi.
    if (tx.dueDate && tx.dueDate < new Date()) {
      throw new BadRequestException("Muddati o'tgan kitobni uzaytirish mumkin emas");
    }
    // Second-extension guard — the new column carries the intent that
    // penaltyDays = -1 used to imply.
    if (tx.extended === true) {
      throw new BadRequestException("Muddati allaqachon uzaytirilgan (bir marta limit)");
    }

    // Bir marta uzaytirish: dueDate dan +7 kun
    const originalDue = tx.dueDate ?? new Date();
    const newDue = new Date(originalDue.getTime() + EXTEND_DAYS * 24 * 60 * 60 * 1000);

    return this.prisma.bookTransaction.update({
      where: { id: transactionId },
      data: { dueDate: newDue, extended: true }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. KITOB QAYTARISH (intizom balli hisoblash)
  // ─────────────────────────────────────────────────────────────────────────

  async returnBook(transactionId: string, returnLibraryId?: string) {
    const tx = await this.prisma.bookTransaction.findUnique({
      where: { id: transactionId },
      include: { user: true, book: true }
    });
    if (!tx) throw new NotFoundException("Tranzaksiya topilmadi");
    if (tx.status !== TransactionStatus.BORROWED) {
      throw new BadRequestException("Bu kitob qaytarilishi kerak emas");
    }

    const now = new Date();
    const dueDate = tx.dueDate ?? now;
    const penaltyDays = now > dueDate
      ? Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    await this.prisma.$transaction(async (p) => {
      await p.bookTransaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.RETURNED,
          returnedAt: now,
          penaltyDays,
          returnLibraryId: returnLibraryId ?? null
        }
      });
      await p.book.update({
        where: { id: tx.bookId },
        data: { availableCount: { increment: 1 } }
      });
      // Kechiksa trust score pasayadi
      if (penaltyDays > 0) {
        await p.user.update({
          where: { id: tx.userId },
          data: { trustScore: { decrement: Math.min(penaltyDays * 2, 10) } }
        });
      } else {
        // Vaqtida qaytarsa trust score oshadi (max 100)
        const user = await p.user.findUnique({ where: { id: tx.userId }, select: { trustScore: true } });
        if (user && user.trustScore < 100) {
          await p.user.update({
            where: { id: tx.userId },
            data: { trustScore: { increment: 1 } }
          });
        }
      }
    });

    // Badge tekshiruvi (async, xato bo'lsa asosiy flow ta'sirlanmaydi)
    this.badge.checkAfterReturn(tx.userId).catch(() => {});
    this.xp.awardForBookReturn(tx.userId).catch(() => {});

    return { returned: true, penaltyDays };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. ROAMING — Boshqa kutubxonada qaytarish
  // ─────────────────────────────────────────────────────────────────────────
  // BOOK-02 (Plan 02-02 Task 2) — Roaming returns no longer silently bump
  // the SOURCE library's availableCount. Instead, we record a BookTransfer
  // {status: PENDING} that the source-library librarian must confirm via
  // the confirm endpoint (lands in Plan 02-05). The book physically stays
  // at the return library until manual transit; the data model now tracks
  // the inter-library inventory debt.
  //
  // What we DO update inside the interactive $transaction:
  //   - BookTransaction.status = RETURNED + returnedAt + returnLibraryId
  //   - BookTransaction.penaltyDays (late-return calc)
  //   - User.trustScore (on-time bonus / late-return ding)
  //   - BookTransfer{PENDING, from = book.libraryId, to = returnLibraryId}
  // What we do NOT touch:
  //   - Book.availableCount on EITHER library. The source library's count is
  //     only bumped when the BookTransfer is CONFIRMED (Plan 02-05).
  async returnRoaming(transactionId: string, returnLibraryId: string) {
    const tx = await this.prisma.bookTransaction.findUnique({
      where: { id: transactionId },
      include: { book: { include: { library: true } }, user: true }
    });
    if (!tx) throw new NotFoundException("Tranzaksiya topilmadi");
    if (tx.status !== TransactionStatus.BORROWED) {
      throw new BadRequestException("Bu kitob qaytarilishi kerak emas");
    }

    const now = new Date();
    const dueDate = tx.dueDate ?? now;
    const penaltyDays = now > dueDate
      ? Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    await this.prisma.$transaction(async (p) => {
      await p.bookTransaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.RETURNED,
          returnedAt: now,
          penaltyDays,
          returnLibraryId
        }
      });
      // Trust score adjustments (same shape as returnBook)
      if (penaltyDays > 0) {
        await p.user.update({
          where: { id: tx.userId },
          data: { trustScore: { decrement: Math.min(penaltyDays * 2, 10) } }
        });
      } else {
        const u = await p.user.findUnique({
          where: { id: tx.userId },
          select: { trustScore: true }
        });
        if (u && u.trustScore < 100) {
          await p.user.update({
            where: { id: tx.userId },
            data: { trustScore: { increment: 1 } }
          });
        }
      }
      // BookTransfer ledger entry — source librarian must confirm.
      if (tx.book.libraryId !== returnLibraryId) {
        await p.bookTransfer.create({
          data: {
            transactionId,
            fromLibraryId: tx.book.libraryId,
            toLibraryId: returnLibraryId,
            status: "PENDING"
          }
        });
      }
    });

    // Asl kutubxonaga xabar (out-of-band; failure does not roll back the txn)
    if (tx.book.library.phone && tx.book.libraryId !== returnLibraryId) {
      const returnLib = await this.prisma.library.findUnique({ where: { id: returnLibraryId } });
      await this.sms.sendNotification(
        tx.book.library.phone,
        `SIFAT Roaming: "${tx.book.title}" boshqa kutubxonada qaytarildi (${returnLib?.name ?? returnLibraryId}). Inter-library transfer (BookTransfer PENDING) tasdiqlash kerak.`,
        tx.userId
      );
    }

    // Badge tekshiruvi (async, xato bo'lsa asosiy flow ta'sirlanmaydi)
    this.badge.checkAfterReturn(tx.userId).catch(() => {});
    this.xp.awardForBookReturn(tx.userId).catch(() => {});

    return { returned: true, penaltyDays };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ISBN SCAN — Sotib olingan kitob
  // ─────────────────────────────────────────────────────────────────────────

  // AUDIT-REPORT C6 — the TZ originally specified a 1-in-5 test cadence, but
  // the approved audit fix plan mandates gating RI credit behind a passing
  // comprehension test on EVERY user scan: scans 1-4 used to auto-confirm with
  // zero verification, which made the unverified path the dominant one.
  // New flow: scanIsbn creates the IsbnScan UNCONFIRMED + stores server-side
  // questions → client fetches questions (GET isbn-scan/:id/test — never
  // exposes answerIdx) → client submits answers → only a passing
  // submitComprehensionTest sets confirmed=true (which is what the RI engine
  // counts).
  async scanIsbn(userId: string, isbn: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    // AUDIT-REPORT C6 — duplicate guard: the same (userId, isbn) must never be
    // credited twice. App-level check (no schema change); any source counts —
    // a store-recorded purchase of the same book also blocks a re-scan.
    const confirmedDuplicate = await this.prisma.isbnScan.findFirst({
      where: { userId, isbn, confirmed: true }
    });
    if (confirmedDuplicate) {
      throw new BadRequestException("Bu kitob allaqachon hisobga olingan");
    }

    // Unconfirmed USER_SCAN duplicate: resume instead of stacking rows — a new
    // row would also reset the 3-attempt cap on the comprehension test.
    const pendingDuplicate = await this.prisma.isbnScan.findFirst({
      where: { userId, isbn, confirmed: false, source: "USER_SCAN" },
      include: { comprehensionTest: true },
      orderBy: { createdAt: "desc" }
    });
    if (pendingDuplicate?.comprehensionTest) {
      if (pendingDuplicate.comprehensionTest.attempts >= 3) {
        throw new BadRequestException(
          "Bu kitob bo'yicha test urinishlari tugagan (max 3) — kitob hisobga olinmaydi"
        );
      }
      // Test hali ochiq — mavjud skanga qaytamiz (yangi yozuv yaratilmaydi).
      const { comprehensionTest: _test, ...scan } = pendingDuplicate;
      return {
        scan,
        requiresTest: true,
        resumed: true,
        message: "Comprehension test talab qilinadi"
      };
    }

    // Bazada kitob ma'lumotini qidiramiz
    const book = await this.prisma.book.findFirst({
      where: { isbn },
      orderBy: { createdAt: "desc" }
    });

    const title = book?.title ?? "Nomi aniqlanmagan";
    const author = book?.author ?? "Muallif aniqlanmagan";

    // AUDIT-REPORT C6 — EVERY scan stays UNCONFIRMED until the test is passed
    // (no more 1-in-5 auto-confirm). Scan + test land in one transaction so a
    // crash can't leave a testless pending scan.
    const questions = this.generateQuestions(title, author);
    const scan = await this.prisma.$transaction(async (p) => {
      const created = await p.isbnScan.create({
        data: { userId, isbn, title, author, source: "USER_SCAN" }
      });
      await p.comprehensionTest.create({
        data: { userId, isbnScanId: created.id, questions }
      });
      return created;
    });

    return { scan, requiresTest: true, message: "Comprehension test talab qilinadi" };
  }

  // AUDIT-REPORT C6 — the client-facing question feed. Returns ONLY
  // {question, options[]} per question; answerIdx NEVER leaves the server
  // (the pre-fix frontend fabricated its own questions with the correct
  // answer always at options[0] precisely because this endpoint was missing).
  async getComprehensionTest(userId: string, isbnScanId: string) {
    const scan = await this.prisma.isbnScan.findUnique({
      where: { id: isbnScanId },
      include: { comprehensionTest: true }
    });
    if (!scan) throw new NotFoundException("Skan topilmadi");
    if (scan.userId !== userId) throw new ForbiddenException("Ruxsat yo'q");

    const base = { title: scan.title, author: scan.author };

    if (scan.confirmed || scan.comprehensionTest?.passed) {
      // Allaqachon hisobga olingan — UI "done" holatini ko'rsatadi.
      return { ...base, status: "CONFIRMED" as const, attemptsLeft: 0, questions: [] };
    }

    const test = scan.comprehensionTest;
    if (!test) throw new NotFoundException("Test topilmadi");

    if (test.attempts >= 3) {
      return { ...base, status: "ATTEMPTS_EXHAUSTED" as const, attemptsLeft: 0, questions: [] };
    }

    const stored = test.questions as { q: string; options: string[]; answerIdx: number }[];
    return {
      ...base,
      status: "PENDING" as const,
      attemptsLeft: 3 - test.attempts,
      // answerIdx intentionally stripped — faqat savol va variantlar.
      questions: stored.map(({ q, options }) => ({ question: q, options }))
    };
  }

  // Comprehension test javoblarini tekshirish
  // FRAUD-02: server-side min-time gates — reject anyone who blasts through
  // the test faster than a human could read the prompts.
  // - Whole-test gate: now - test.createdAt < 5_000ms * questions.length → reject.
  // - Per-question gate: any answerTimingsMs[i] < 3_000ms → reject.
  async submitComprehensionTest(
    userId: string,
    isbnScanId: string,
    answers: number[],
    answerTimingsMs?: number[]
  ) {
    const test = await this.prisma.comprehensionTest.findUnique({
      where: { isbnScanId },
      include: { isbnScan: true }
    });
    if (!test) throw new NotFoundException("Test topilmadi");
    if (test.userId !== userId) throw new ForbiddenException("Ruxsat yo'q");
    if (test.passed) throw new BadRequestException("Test allaqachon o'tilgan");
    if (test.attempts >= 3) throw new BadRequestException("Urinishlar tugadi (max 3)");

    const questions = test.questions as { q: string; options: string[]; answerIdx: number }[];

    // ── FRAUD-02: whole-test min-time gate ──────────────────────────────────
    const elapsedMs = Date.now() - test.createdAt.getTime();
    const minMs = questions.length * 5_000;
    if (elapsedMs < minMs) {
      throw new BadRequestException(
        `Test juda tez topshirildi (${elapsedMs}ms). Har savol uchun kamida 5 soniya o'qish kerak.`
      );
    }

    // ── FRAUD-02: per-question min-time gate ────────────────────────────────
    if (Array.isArray(answerTimingsMs)) {
      const tooFast = answerTimingsMs.some((ms) => typeof ms === "number" && ms < 3_000);
      if (tooFast) {
        throw new BadRequestException(
          "Savollarga juda tez javob berildi (har biri kamida 3 soniya)."
        );
      }
    }

    const correct = answers.filter((a, i) => a === questions[i]?.answerIdx).length;
    const passed = correct >= Math.ceil(questions.length * 0.7); // 70% to'g'ri = o'tdi

    await this.prisma.$transaction(async (p) => {
      await p.comprehensionTest.update({
        where: { id: test.id },
        data: {
          passed,
          attempts: { increment: 1 },
          completedAt: passed ? new Date() : undefined
        }
      });
      if (passed) {
        await p.isbnScan.update({
          where: { id: isbnScanId },
          data: { confirmed: true, confirmedAt: new Date() }
        });
      }
    });

    if (passed) {
      this.badge.checkAfterTest(userId).catch(() => {});
      this.xp.awardForComprehensionPass(userId).catch(() => {});
    }

    return { passed, correct, total: questions.length, attemptsLeft: passed ? 0 : 2 - test.attempts };
  }

  // Do'kon operatori manual kiritishi
  // FRAUD-04: operatorId is NOT taken from the request body — it is the
  // authenticated user's id. We additionally verify the auth user is a
  // DOKON_OPERATOR (with a matching Institution.directorId) or SUPER_ADMIN.
  // The frontend may still send operatorId in the body; we silently ignore
  // it (no 400) so the client continues to work during the migration window.
  async storeManualEntry(authUserId: string, phone: string, isbn: string) {
    // 1. Verify the caller is allowed to record store purchases.
    const authUser = await this.prisma.user.findUnique({
      where: { id: authUserId },
      select: { id: true, role: true }
    });
    if (!authUser) throw new ForbiddenException("Avtorizatsiya talab qilinadi");
    if (authUser.role !== "DOKON_OPERATOR" && authUser.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Bu amal faqat do'kon operatori yoki admin uchun");
    }
    if (authUser.role === "DOKON_OPERATOR") {
      // Do'kon — bu Store (operatorId orqali bog'langan), Institution EMAS.
      // Avval xato tarzda Institution.directorId tekshirilardi — dokon operatori
      // uchun u hech qachon topilmasdi va har doim 403 berardi. To'g'ri tekshiruv
      // decrementStoreStock bilan bir xil: Store.operatorId.
      const store = await this.prisma.store.findFirst({
        where: { operatorId: authUserId }
      });
      if (!store) {
        throw new ForbiddenException("Sizning do'koningiz topilmadi");
      }
    }

    // 2. Resolve the reader by phone.
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new NotFoundException("Telefon raqam topilmadi");

    const book = await this.prisma.book.findFirst({ where: { isbn } });
    const title = book?.title ?? isbn;
    const author = book?.author ?? "—";

    // 3. Persist storeId from the authenticated user — never from the body.
    const scan = await this.prisma.isbnScan.create({
      data: {
        userId: user.id,
        isbn,
        title,
        author,
        source: "STORE_MANUAL",
        storeId: authUserId
      }
    });

    // Do'kon omboridan kamaytirish (agar bu kitob do'kon katalogida bo'lsa).
    const stock = await this.decrementStoreStock(authUserId, isbn);

    // Kitobxonga SMS — tasdiqlash so'rovi
    await this.sms.sendNotification(
      phone,
      `SIFAT: Do'kon "${title}" kitobini sotib olganingizni qayd qildi. Tasdiqlash uchun ilovaga kiring.`,
      user.id
    );

    return { ...scan, stock };
  }

  // ── QR-skan orqali xarid (mijoz QR'i ko'rsatdi) ───────────────────────────
  // Operator mijoz QR'ini skanlaydi → frontend uni sifatId ga yechadi → shu
  // metodga sifatId + ISBN keladi. Telefon shart emas. Xarid IsbnScan sifatida
  // qayd qilinadi (mijoz keyin ilovada tasdiqlaydi → Reading Index) VA do'kon
  // ombori avtomat 1 dona kamayadi.
  async storeQrEntry(authUserId: string, sifatId: string, isbn: string) {
    const authUser = await this.prisma.user.findUnique({
      where: { id: authUserId },
      select: { id: true, role: true },
    });
    if (!authUser) throw new ForbiddenException("Avtorizatsiya talab qilinadi");
    if (authUser.role !== "DOKON_OPERATOR" && authUser.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Bu amal faqat do'kon operatori yoki admin uchun");
    }

    const user = await this.prisma.user.findUnique({ where: { sifatId } });
    if (!user) throw new NotFoundException("Mijoz topilmadi (QR)");

    const cleanIsbn = isbn.replace(/[-\s]/g, "");
    const book = await this.prisma.book.findFirst({ where: { isbn: cleanIsbn } });
    const title = book?.title ?? cleanIsbn;
    const author = book?.author ?? "—";

    const scan = await this.prisma.isbnScan.create({
      data: {
        userId: user.id,
        isbn: cleanIsbn,
        title,
        author,
        source: "STORE_QR",
        storeId: authUserId,
      },
    });

    const stock = await this.decrementStoreStock(authUserId, cleanIsbn);

    if (user.phone) {
      await this.sms.sendNotification(
        user.phone,
        `SIFAT: "${title}" xaridi qayd qilindi. Reading Indexingizga qo'shilishi uchun ilovada tasdiqlang.`,
        user.id,
      );
    }

    return {
      scan,
      customer: { name: user.name, sifatId: user.sifatId },
      stock,
    };
  }

  // Do'kon omboridan 1 dona kamaytirish — operator do'koni (Store.operatorId)
  // + ISBN bo'yicha StoreProduct topilsa va zaxira > 0 bo'lsa. Katalogda
  // bo'lmasa/zaxira 0 bo'lsa — xarid qayd qilinadi, ombor o'zgarmaydi.
  private async decrementStoreStock(operatorId: string, isbn: string) {
    const cleanIsbn = isbn.replace(/[-\s]/g, "");
    const store = await this.prisma.store.findFirst({ where: { operatorId } });
    if (!store) {
      return { decremented: false, stockCount: null as number | null, title: null as string | null };
    }
    const product = await this.prisma.storeProduct.findFirst({
      where: { storeId: store.id, isbn: cleanIsbn },
    });
    if (!product) return { decremented: false, stockCount: null as number | null, title: null as string | null };
    if (product.stockCount <= 0) {
      return { decremented: false, stockCount: 0, title: product.title };
    }
    const updated = await this.prisma.storeProduct.update({
      where: { id: product.id },
      data: { stockCount: { decrement: 1 } },
    });
    return { decremented: true, stockCount: updated.stockCount, title: product.title };
  }

  // Kitobxon do'kon yozuvini tasdiqlaydi
  async confirmStorePurchase(userId: string, isbnScanId: string) {
    const scan = await this.prisma.isbnScan.findUnique({ where: { id: isbnScanId } });
    if (!scan) throw new NotFoundException("Yozuv topilmadi");
    if (scan.userId !== userId) throw new ForbiddenException("Ruxsat yo'q");
    if (scan.source !== "STORE_MANUAL" && scan.source !== "STORE_QR") throw new BadRequestException("Bu yozuv do'kon tomonidan kiritilmagan");
    if (scan.confirmed) throw new BadRequestException("Allaqachon tasdiqlangan");

    await this.prisma.isbnScan.update({
      where: { id: isbnScanId },
      data: { confirmed: true, confirmedAt: new Date() }
    });

    this.badge.checkAfterIsbnScan(userId).catch(() => {});
    this.xp.awardForStorePurchase(userId).catch(() => {});

    return { confirmed: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. O'QISH TARIXI VA AKTIV BRONLAR
  // ─────────────────────────────────────────────────────────────────────────

  async getUserHistory(userId: string) {
    const [transactions, isbnScans, pendingPurchases, activeBorrows, pendingBrons] =
      await Promise.all([
        this.prisma.bookTransaction.findMany({
          where: { userId },
          include: { book: { include: { library: { select: { name: true, code: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 50
        }),
        this.prisma.isbnScan.findMany({
          where: { userId, confirmed: true },
          orderBy: { confirmedAt: "desc" },
          take: 20
        }),
        // Do'kon kiritgan, hali kitobxon TASDIQLAMAGAN xaridlar. Profilda
        // "tasdiqlash kutilmoqda" sifatida ko'rsatiladi — kitobxon tasdiqlasa
        // confirmed:true bo'lib Reading Index'ga qo'shiladi (fraud himoyasi).
        this.prisma.isbnScan.findMany({
          where: {
            userId,
            confirmed: false,
            source: { in: ["STORE_MANUAL", "STORE_QR"] }
          },
          orderBy: { createdAt: "desc" },
          take: 20
        }),
        this.prisma.bookTransaction.count({ where: { userId, status: TransactionStatus.BORROWED } }),
        this.prisma.bookTransaction.count({
          where: { userId, status: { in: [TransactionStatus.PENDING, TransactionStatus.RESERVED] } }
        })
      ]);

    return { transactions, isbnScans, pendingPurchases, activeBorrows, pendingBrons };
  }

  async findAll(userId?: string, status?: TransactionStatus) {
    return this.prisma.bookTransaction.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(status ? { status } : {})
      },
      include: {
        book: { select: { title: true, author: true, isbn: true, coverUrl: true } },
        user: { select: { name: true, phone: true, sifatId: true } },
        returnLibrary: { select: { name: true, code: true } }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  // Kutubxonadagi aktiv bronlar (kutubxonachi uchun)
  async getLibraryBrons(libraryId: string) {
    return this.prisma.bookTransaction.findMany({
      where: {
        book: { libraryId },
        status: { in: [TransactionStatus.PENDING, TransactionStatus.RESERVED] }
      },
      include: {
        // FIX: borrow() expects DB cuid ids (not sifatId/isbn). The bron list
        // is the source of those ids for the "Kitob berish" action, so include
        // book.id and user.id — without them the UI sent sifatId/isbn and
        // borrow() threw NotFound (404).
        book: { select: { id: true, title: true, author: true, isbn: true } },
        user: { select: { id: true, name: true, phone: true, sifatId: true } }
      },
      orderBy: { createdAt: "asc" }
    });
  }

  // Kutubxonadagi faol berilgan kitoblar
  async getLibraryBorrowed(libraryId: string) {
    return this.prisma.bookTransaction.findMany({
      where: {
        book: { libraryId },
        status: TransactionStatus.BORROWED
      },
      include: {
        book: { select: { title: true, author: true, isbn: true } },
        user: { select: { name: true, phone: true, sifatId: true } }
      },
      orderBy: { dueDate: "asc" }
    });
  }

  // Kutubxonadagi muddati o'tgan kitoblar
  async getOverdueByLibrary(libraryId: string) {
    const now = new Date();
    return this.prisma.bookTransaction.findMany({
      where: {
        book: { libraryId },
        status: TransactionStatus.BORROWED,
        dueDate: { lt: now }
      },
      include: {
        book: { select: { title: true, author: true } },
        user: { select: { name: true, phone: true, sifatId: true } }
      },
      orderBy: { dueDate: "asc" }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CRON TASKLAR
  // ─────────────────────────────────────────────────────────────────────────

  // Har soatda: 24 soat o'tgan PENDING bronlarni CANCELLED ga o'tkazish
  //
  // AUDIT-REPORT H8 (FIX 4) — Redis SETNX leader lock (Plan 04-04 FIX F
  // pattern, see payment/subscription.service.ts). Three replicas would each
  // fire this @Cron → triple availableCount increments + triple SMS;
  // tryAcquire wins only on the first replica and the others log + return.
  @Cron(CronExpression.EVERY_HOUR)
  async autoExpireReservations() {
    const now = new Date();

    // AUDIT-REPORT H8 (FIX 4) — single-leader gate. Hourly cron → the lock
    // bucket is the UTC hour ("YYYY-MM-DDTHH"), so each hourly run gets a
    // fresh key while replicas racing the SAME run collide on it.
    const lockHourStr = now.toISOString().slice(0, 13);
    const lockKey = `cron:auto-expire-reservations:${lockHourStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, 2 * 60 * 60, lockHourStr);
    if (!lock.first) {
      this.logger.log(
        `autoExpireReservations: leader lock not acquired (${lockKey}) — another replica is sweeping. Skipping.`
      );
      return;
    }

    // AUDIT-REPORT M14 — RESERVED bronlar uchun kesim nuqtasi: yaratilganidan
    // 72 soat o'tgan bo'lsa bekor qilinadi (PENDING 24 soatda allaqachon
    // bekor bo'ladi; tasdiqlangach kitobxonga olib ketish uchun yana ~2 kun
    // qoladi).
    const reservedCutoff = new Date(now.getTime() - RESERVED_EXPIRE_HOURS * 60 * 60 * 1000);

    const expired = await this.prisma.bookTransaction.findMany({
      where: {
        OR: [
          // Kutubxonachi 24 soat ichida tasdiqlamagan bronlar
          { status: TransactionStatus.PENDING, reservationExpiresAt: { lt: now } },
          // AUDIT-REPORT M14 — tasdiqlangan, lekin kitobxon olib ketmagan
          // bronlar (avval bu holat HECH QACHON muddati o'tmasdi va nusxa
          // abadiy band bo'lib qolardi)
          { status: TransactionStatus.RESERVED, createdAt: { lt: reservedCutoff } }
        ]
      },
      include: { book: true, user: true }
    });

    if (expired.length === 0) return;

    for (const tx of expired) {
      try {
        await this.prisma.$transaction(async (p) => {
          await p.bookTransaction.update({
            where: { id: tx.id },
            data: { status: TransactionStatus.CANCELLED }
          });
          await p.book.update({
            where: { id: tx.bookId },
            data: { availableCount: { increment: 1 } }
          });
        });
      } catch (e) {
        // Auto-expire is a best-effort cron; a race on availableCount means
        // another writer already touched the book — log and continue rather
        // than aborting the whole batch.
        if (isRaceError(e)) {
          this.logger.warn(`Auto-expire race on tx ${tx.id}: ${(e as Error).message}`);
          continue;
        }
        throw e;
      }

      // M14 — RESERVED va PENDING uchun mos xabar matni tanlanadi (ikkalasi
      // ham mavjud sms.sendNotification kanali orqali yuboriladi).
      const expireMessage =
        tx.status === TransactionStatus.RESERVED
          ? `SIFAT: "${tx.book.title}" broniz bekor qilindi — ${RESERVED_EXPIRE_HOURS} soat ichida olib ketilmadi. Qaytadan bron qilishingiz mumkin.`
          : `SIFAT: "${tx.book.title}" broniz muddati o'tdi (24 soat). Qaytadan bron qilishingiz mumkin.`;

      await this.sms.sendNotification(tx.user.phone, expireMessage, tx.userId);
    }

    this.logger.log(`Auto-expire: ${expired.length} ta bron bekor qilindi`);
  }

  // Har kuni soat 10:00 — 3 kun va 1 kun oldin eslatma
  //
  // BOOK-04 (Plan 02-05 verify): the queue path → EskizSmsClient is fully
  // wired. SMS delivery itself depends on ESKIZ_EMAIL / ESKIZ_PASSWORD env;
  // in dev (no creds) the client no-ops cleanly with a warn log. This is
  // the documented Phase 1 carry-over from AUTH-01 — closing it requires
  // Eskiz credentials, not code changes.
  //
  // AUDIT-REPORT H8 (FIX 4) — Redis SETNX leader lock (Plan 04-04 FIX F
  // pattern). Without it, replicas=3 means every reminder SMS goes out 3×.
  @Cron("0 10 * * *")
  async checkOverdueAlerts() {
    const now = new Date();

    // AUDIT-REPORT H8 (FIX 4) — single-leader gate (day bucket: daily cron).
    const lockDayStr = now.toISOString().slice(0, 10);
    const lockKey = `cron:overdue-alerts:${lockDayStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, 2 * 60 * 60, lockDayStr);
    if (!lock.first) {
      this.logger.log(
        `checkOverdueAlerts: leader lock not acquired (${lockKey}) — another replica is sweeping. Skipping.`
      );
      return;
    }

    // 3 kun qolganlar
    const threeDayTarget = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const threeDayStart = new Date(threeDayTarget.getTime() - 60 * 60 * 1000);
    const threeDayEnd = new Date(threeDayTarget.getTime() + 60 * 60 * 1000);

    const threeDayBefore = await this.prisma.bookTransaction.findMany({
      where: {
        status: TransactionStatus.BORROWED,
        dueDate: { gte: threeDayStart, lt: threeDayEnd }
      },
      include: { user: true, book: true }
    });

    for (const tx of threeDayBefore) {
      await this.sms.sendNotification(
        tx.user.phone,
        `SIFAT: "${tx.book.title}" qaytarish muddatiga 3 kun qoldi. Iltimos vaqtida qaytaring.`,
        tx.userId
      );
    }

    // 1 kun qolganlar
    const oneDayTarget = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    const oneDayStart = new Date(oneDayTarget.getTime() - 60 * 60 * 1000);
    const oneDayEnd = new Date(oneDayTarget.getTime() + 60 * 60 * 1000);

    const oneDayBefore = await this.prisma.bookTransaction.findMany({
      where: {
        status: TransactionStatus.BORROWED,
        dueDate: { gte: oneDayStart, lt: oneDayEnd }
      },
      include: { user: true, book: true }
    });

    for (const tx of oneDayBefore) {
      await this.sms.sendNotification(
        tx.user.phone,
        `SIFAT ESLATMA: "${tx.book.title}" kitobini ERTAGA qaytarish kerak. Kechiksa trust score pasayadi.`,
        tx.userId
      );
    }

    if (threeDayBefore.length + oneDayBefore.length > 0) {
      this.logger.log(
        `Overdue alerts: 3 kun=${threeDayBefore.length}, 1 kun=${oneDayBefore.length}`
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Har kecha soat 23:59 — muddati o'tgan kitoblar uchun penaltyDays hisoblash
  // ─────────────────────────────────────────────────────────────────────────
  //
  // BOOK-04 (Plan 02-05 Task 2 rename): the prior name (block-overdue-users)
  // was misleading because this cron NEVER changed user.status (no
  // `prisma.user.update` call exists in the body). It only recomputes
  // BookTransaction.penaltyDays for BORROWED rows whose dueDate has passed.
  //
  // The actual borrow-time block lives in `hasOverdueBooks()` above, which
  // throws ForbiddenException from `reserve()` and `borrow()` when the user
  // has any BORROWED transaction with dueDate < now.
  //
  // SMS delivery on the related `checkOverdueAlerts` cron depends on Eskiz
  // credentials (ESKIZ_EMAIL / ESKIZ_PASSWORD). In dev the EskizSmsClient
  // no-ops cleanly (warn log emitted, no SMS sent). This is the documented
  // Phase 1 carry-over from AUTH-01 — the queue path itself is fully wired.
  @Cron("59 23 * * *")
  async recomputeOverdueDays() {
    const now = new Date();
    const overdueTransactions = await this.prisma.bookTransaction.findMany({
      where: {
        status: TransactionStatus.BORROWED,
        dueDate: { lt: now },
        penaltyDays: { gte: 0 }
      },
      include: { user: true, book: true }
    });

    // penaltyDays yangilanadi (User.status NEVER touched here — see header).
    for (const tx of overdueTransactions) {
      const days = Math.ceil((now.getTime() - (tx.dueDate?.getTime() ?? now.getTime())) / (1000 * 60 * 60 * 24));
      if (days > 0 && days !== tx.penaltyDays) {
        await this.prisma.bookTransaction.update({
          where: { id: tx.id },
          data: { penaltyDays: days }
        });
      }
    }

    this.logger.log(`Overdue penaltyDays recompute: ${overdueTransactions.length} ta muddati o'tgan kitob`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COMPREHENSION TEST SAVOL GENERATSIYASI (FRAUD-01 — randomized)
  // ─────────────────────────────────────────────────────────────────────────
  // Fisher-Yates shuffle on the options array, then record answerIdx as the
  // post-shuffle position of `correct`. This blocks the trivial [0,0,0]
  // exploit that worked when the correct answer was always at index 0.
  private shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private buildQuestion(q: string, correct: string, distractors: string[]) {
    const options = this.shuffle([correct, ...distractors]);
    return { q, options, answerIdx: options.indexOf(correct) };
  }

  private generateQuestions(title: string, author: string) {
    return [
      this.buildQuestion(
        `Bu kitobning muallifi kim?`,
        author,
        ["Abdulla Qahhor", "O'tkir Hoshimov", "Erkin Vohidov"]
      ),
      this.buildQuestion(
        `Siz o'qigan kitobning nomi nima?`,
        title,
        ["Mehrobdan chayon", "O'tkan kunlar", "Sarob"]
      ),
      this.buildQuestion(
        `Kitobni qachon o'qib tugatdingiz?`,
        "Oxirgi 30 kun ichida",
        ["Bir necha yil oldin", "Hech o'qimadim", "Bilmayman"]
      )
    ];
  }
}
