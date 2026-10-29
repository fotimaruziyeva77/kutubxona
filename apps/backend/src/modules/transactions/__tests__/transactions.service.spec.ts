import { TransactionsService } from "../transactions.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";
import { BadgeService } from "../../badge/badge.service";
import { XpService } from "../../xp/xp.service";
import {
  BadRequestException, ForbiddenException, NotFoundException
} from "@nestjs/common";
import { TransactionStatus, TransactionType } from "@prisma/client";

const mockPrisma = {
  book: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  library: { findUnique: jest.fn() },
  institution: { findFirst: jest.fn() },
  // Do'kon operatorining egaligi Institution.directorId emas, Store.operatorId
  // orqali tekshiriladi (transactions.service.ts:730) — spec eski shartnomada
  // qolgan edi va storeManualEntry testlari TypeError bilan yiqilardi.
  store: { findFirst: jest.fn() },
  storeProduct: { findFirst: jest.fn(), update: jest.fn() },
  isbnScan: {
    findUnique: jest.fn(),
    findFirst:  jest.fn(),
    findMany:   jest.fn(),
    count:      jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  comprehensionTest: {
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  bookTransaction: {
    findMany:   jest.fn(),
    findFirst:  jest.fn(),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
    count:      jest.fn(),
  },
  bookTransfer: {
    create:     jest.fn(),
    findFirst:  jest.fn(),
    findMany:   jest.fn(),
    update:     jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockBadge = {
  checkAfterReturn:   jest.fn().mockResolvedValue(undefined),
  checkAfterTest:     jest.fn().mockResolvedValue(undefined),
  checkAfterIsbnScan: jest.fn().mockResolvedValue(undefined),
};

const mockXp = {
  awardForBookReturn:        jest.fn().mockResolvedValue(undefined),
  awardForComprehensionPass: jest.fn().mockResolvedValue(undefined),
  awardForStorePurchase:     jest.fn().mockResolvedValue(undefined),
};

// AUDIT-REPORT H8 (FIX 4) — cron leader lock (FIX F pattern).
const mockRedisLock = {
  tryAcquire: jest.fn().mockResolvedValue({ first: true }),
  storeResponse: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
};

const activeUser = { id: "u1", type: "CITIZEN", status: "ACTIVE", trustScore: 80, name: "Ali", phone: "+998901234567", sifatId: "SL-01" };
const availableBook = { id: "b1", availableCount: 3, title: "Alpomish", isbn: "9789943452787", author: "Mualif", libraryId: "lib-1", library: { phone: null } };

describe("TransactionsService", () => {
  let service: TransactionsService;

  beforeEach(() => {
    service = new TransactionsService(
      mockPrisma as unknown as PrismaService,
      mockSms as unknown as SmsService,
      mockBadge as unknown as BadgeService,
      mockXp as unknown as XpService,
      mockRedisLock as unknown as RedisLockService,
    );
    jest.clearAllMocks();
    // Default: this replica wins the cron leader lock.
    mockRedisLock.tryAcquire.mockResolvedValue({ first: true });
  });

  // ── findAll ────────────────────────────────────────────────────────────────
  describe("findAll", () => {
    it("userId filtri bilan tranzaksiyalarni qaytaradi", async () => {
      const txs = [{ id: "tx1", userId: "u1" }];
      mockPrisma.bookTransaction.findMany.mockResolvedValue(txs);

      const result = await service.findAll("u1");

      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "u1" } })
      );
      expect(result).toEqual(txs);
    });

    it("userId yo'q bo'lsa hammani qaytaradi", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      await service.findAll();
      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} })
      );
    });

    it("status filtri bilan qaytaradi", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);
      await service.findAll(undefined, TransactionStatus.BORROWED);
      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: TransactionStatus.BORROWED } })
      );
    });
  });

  // ── borrow ─────────────────────────────────────────────────────────────────
  describe("borrow", () => {
    it("muvaffaqiyatli kitob beradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0) // hasOverdueBooks
        .mockResolvedValueOnce(0); // activeBorrows
      const newTx = { id: "tx1", userId: "u1", bookId: "b1", status: "BORROWED" };
      mockPrisma.book.update.mockResolvedValue({});
      mockPrisma.bookTransaction.create.mockResolvedValue(newTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );

      const result = await service.borrow("u1", "b1");
      expect(result).toEqual(newTx);
    });

    it("kitob topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(null);
      await expect(service.borrow("u1", "b1")).rejects.toThrow(NotFoundException);
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      await expect(service.borrow("u1", "b1")).rejects.toThrow(NotFoundException);
    });

    it("kitob mavjud bo'lmasa BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue({ ...availableBook, availableCount: 0 });
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(0); // no overdue
      await expect(service.borrow("u1", "b1")).rejects.toThrow(BadRequestException);
    });

    it("muddati o'tgan kitob bor — ForbiddenException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(1); // has overdue
      await expect(service.borrow("u1", "b1")).rejects.toThrow(ForbiddenException);
    });

    it("faol emas foydalanuvchi — ForbiddenException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, status: "BLOCKED" });
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      await expect(service.borrow("u1", "b1")).rejects.toThrow(ForbiddenException);
    });

    it("CITIZEN uchun limit 2, oshganda BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0) // no overdue
        .mockResolvedValueOnce(2); // activeBorrows = limit
      await expect(service.borrow("u1", "b1")).rejects.toThrow(BadRequestException);
    });

    it("STUDENT_UNIVERSITY uchun limit 5", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, type: "STUDENT_UNIVERSITY" });
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(5); // at limit
      await expect(service.borrow("u1", "b1")).rejects.toThrow(BadRequestException);
    });

    it("Trust Score 90+ uchun +1 bonus limit", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, trustScore: 90 });
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0) // no overdue
        .mockResolvedValueOnce(2); // 2 books, limit is now 3 (2+1)
      const newTx = { id: "tx1", status: "BORROWED" };
      mockPrisma.book.update.mockResolvedValue({});
      mockPrisma.bookTransaction.create.mockResolvedValue(newTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );

      // Should NOT throw because limit is 3 for trustScore 90
      const result = await service.borrow("u1", "b1");
      expect(result).toEqual(newTx);
    });

    it("brondan berish — RESERVED bronni BORROWED ga o'tkazadi", async () => {
      const reservation = { id: "res-1", userId: "u1", bookId: "b1", status: TransactionStatus.RESERVED };
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(0); // no overdue
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(reservation);
      mockPrisma.bookTransaction.update.mockResolvedValue({ ...reservation, status: "BORROWED" });

      await service.borrow("u1", "b1", "res-1");

      expect(mockPrisma.bookTransaction.update).toHaveBeenCalled();
    });
  });

  // ── returnBook ─────────────────────────────────────────────────────────────
  describe("returnBook", () => {
    const baseTx = {
      id: "tx1", bookId: "b1", userId: "u1",
      status: TransactionStatus.BORROWED,
      dueDate: new Date(Date.now() + 5 * 86400000),
      user: { phone: "+998901234567" },
      book: { title: "Alpomish" },
    };

    it("kitobni muvaffaqiyatli qaytaradi", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(baseTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          ...mockPrisma,
          user: { ...mockPrisma.user, findUnique: jest.fn().mockResolvedValue({ trustScore: 80 }) },
        } as unknown as typeof mockPrisma);
      });

      const result = await service.returnBook("tx1");

      expect(result.returned).toBe(true);
      expect(result.penaltyDays).toBe(0);
      expect(mockBadge.checkAfterReturn).toHaveBeenCalledWith("u1");
    });

    it("muddati o'tgan kitob — penaltyDays > 0", async () => {
      const overdueTx = { ...baseTx, dueDate: new Date(Date.now() - 3 * 86400000) };
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(overdueTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );

      const result = await service.returnBook("tx1");

      expect(result.returned).toBe(true);
      expect(result.penaltyDays).toBeGreaterThan(0);
    });

    it("returnLibraryId bilan roaming qaytarish ishlaydi", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(baseTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) => {
        return fn({
          ...mockPrisma,
          user: { ...mockPrisma.user, findUnique: jest.fn().mockResolvedValue({ trustScore: 80 }) },
        } as unknown as typeof mockPrisma);
      });

      const result = await service.returnBook("tx1", "lib-tashkent");
      expect(result.returned).toBe(true);
    });

    it("tranzaksiya topilmasa NotFoundException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(null);
      await expect(service.returnBook("notfound")).rejects.toThrow(NotFoundException);
    });

    it("BORROWED bo'lmagan tranzaksiyani qaytarishda BadRequestException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        ...baseTx,
        status: TransactionStatus.RETURNED
      });
      await expect(service.returnBook("tx1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── BOOK-05 (Plan 02-02 Task 5): interactive transactions + CHECK surface ──
  describe("uses interactive transactions (BOOK-05)", () => {
    it("borrow uses the interactive $transaction(async (p) => ...) callback form", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0) // hasOverdueBooks
        .mockResolvedValueOnce(0); // activeBorrows
      const newTx = { id: "tx-int", status: "BORROWED" };
      mockPrisma.book.update.mockResolvedValue({});
      mockPrisma.bookTransaction.create.mockResolvedValue(newTx);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );

      await service.borrow("u1", "b1");

      // The first $transaction arg must be a function (interactive form) —
      // NOT an array (legacy array form).
      const firstArg = mockPrisma.$transaction.mock.calls[0][0];
      expect(typeof firstArg).toBe("function");
      expect(Array.isArray(firstArg)).toBe(false);
    });

    it("cancelReservation uses the interactive callback form", async () => {
      const reservation = {
        id: "tx-cancel",
        userId: "u1",
        bookId: "b1",
        status: TransactionStatus.PENDING,
        user: { phone: "+998901234567" },
        book: { title: "Alpomish" }
      };
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(reservation);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.update.mockResolvedValue({});
      mockPrisma.book.update.mockResolvedValue({});

      await service.cancelReservation("tx-cancel", "u1", false);

      const firstArg = mockPrisma.$transaction.mock.calls[0][0];
      expect(typeof firstArg).toBe("function");
    });

    it("autoExpireReservations uses the interactive callback form", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        {
          id: "tx-expired",
          bookId: "b1",
          userId: "u1",
          user: { phone: "+998901234567" },
          book: { title: "Alpomish" }
        }
      ]);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.update.mockResolvedValue({});
      mockPrisma.book.update.mockResolvedValue({});

      await service.autoExpireReservations();

      const firstArg = mockPrisma.$transaction.mock.calls[0][0];
      expect(typeof firstArg).toBe("function");
    });
  });

  describe("CHECK constraint surface (BOOK-05)", () => {
    // Simulate the Book CHECK constraint firing inside the borrow path.
    // The service must catch the P2010 (and the meta.message containing the
    // CHECK name) and rethrow BadRequestException("Inventory race ...").
    it("borrow surfaces a CHECK constraint violation as BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(0) // no overdue
        .mockResolvedValueOnce(0); // activeBorrows

      // Build a fake Prisma known-request error with code P2010 + CHECK meta.
      const { Prisma } = jest.requireActual("@prisma/client") as typeof import("@prisma/client");
      const raceErr = new Prisma.PrismaClientKnownRequestError(
        "violates check constraint book_availablecount_nonneg",
        { code: "P2010", clientVersion: "5.22.0", meta: { message: "violates check constraint book_availablecount_nonneg" } }
      );
      mockPrisma.$transaction.mockRejectedValue(raceErr);

      const err = await service.borrow("u1", "b1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/race/i);
    });

    it("cancelReservation surfaces a CHECK constraint violation as BadRequestException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx-x",
        userId: "u1",
        bookId: "b1",
        status: TransactionStatus.PENDING,
        user: { phone: "+998901234567" },
        book: { title: "Alpomish" }
      });
      const { Prisma } = jest.requireActual("@prisma/client") as typeof import("@prisma/client");
      const raceErr = new Prisma.PrismaClientKnownRequestError(
        "violates check constraint book_availablecount_nonneg",
        { code: "P2010", clientVersion: "5.22.0", meta: { message: "violates check constraint book_availablecount_nonneg" } }
      );
      mockPrisma.$transaction.mockRejectedValue(raceErr);

      const err = await service.cancelReservation("tx-x", "u1", false).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/race/i);
    });

    // AUDIT-REPORT M13 — reserve() ham borrow() kabi himoyalangan: parallel
    // so'nggi-nusxa bronida CHECK buzilishi 500 emas, toza 400 qaytaradi.
    it("reserve surfaces a CHECK constraint violation as BadRequestException (M13)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockResolvedValue(0); // overdue ham, limit ham 0

      const { Prisma } = jest.requireActual("@prisma/client") as typeof import("@prisma/client");
      const raceErr = new Prisma.PrismaClientKnownRequestError(
        "violates check constraint book_availablecount_nonneg",
        { code: "P2010", clientVersion: "5.22.0", meta: { message: "violates check constraint book_availablecount_nonneg" } }
      );
      mockPrisma.$transaction.mockRejectedValue(raceErr);

      const err = await service.reserve("u1", "b1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/race/i);
      // Race yo'lida SMS yuborilmaydi (transaction muvaffaqiyatsiz).
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });

    it("reserve race bo'lmagan xatolarni o'zgartirmasdan qayta otadi (M13)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);

      const genericErr = new Error("DB down");
      mockPrisma.$transaction.mockRejectedValue(genericErr);

      await expect(service.reserve("u1", "b1")).rejects.toThrow("DB down");
    });
  });

  // ── BOOK-02: returnRoaming creates PENDING BookTransfer ────────────────────
  describe("returnRoaming (BOOK-02)", () => {
    const sourceLibraryId = "lib-navoiy";
    const returnLibraryId = "lib-tashkent";
    const roamingTx = {
      id: "tx-roam",
      bookId: "b1",
      userId: "u1",
      status: TransactionStatus.BORROWED,
      dueDate: new Date(Date.now() + 5 * 86400000),
      book: {
        title: "Alpomish",
        libraryId: sourceLibraryId,
        library: { phone: "+998999999999" }
      },
      user: { id: "u1", phone: "+998901234567" }
    };

    it("returnRoaming creates a PENDING BookTransfer and does not bump source availableCount", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(roamingTx);
      mockPrisma.library.findUnique.mockResolvedValue({ id: returnLibraryId, name: "Toshkent MK" });

      // Capture all writes that flow through the interactive transaction.
      const txCalls: Array<{ model: string; method: string; args: unknown }> = [];
      const txClient = {
        bookTransaction: {
          update: jest.fn().mockImplementation((args: unknown) => {
            txCalls.push({ model: "bookTransaction", method: "update", args });
            return Promise.resolve({});
          })
        },
        book: {
          update: jest.fn().mockImplementation((args: unknown) => {
            txCalls.push({ model: "book", method: "update", args });
            return Promise.resolve({});
          })
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({ trustScore: 80 }),
          update: jest.fn().mockImplementation((args: unknown) => {
            txCalls.push({ model: "user", method: "update", args });
            return Promise.resolve({});
          })
        },
        bookTransfer: {
          create: jest.fn().mockImplementation((args: unknown) => {
            txCalls.push({ model: "bookTransfer", method: "create", args });
            return Promise.resolve({ id: "transfer-1", ...(args as { data: object }).data });
          })
        }
      };
      mockPrisma.$transaction.mockImplementation(
        async (fn: (p: typeof txClient) => Promise<unknown>) => fn(txClient)
      );

      const result = await service.returnRoaming("tx-roam", returnLibraryId);

      // Result is { returned: true, penaltyDays: 0 }
      expect(result).toEqual({ returned: true, penaltyDays: 0 });

      // A BookTransfer was created with the correct shape.
      const transferCall = txCalls.find(
        (c) => c.model === "bookTransfer" && c.method === "create"
      );
      expect(transferCall).toBeDefined();
      const transferArgs = transferCall!.args as {
        data: { transactionId: string; fromLibraryId: string; toLibraryId: string; status: string };
      };
      expect(transferArgs.data.transactionId).toBe("tx-roam");
      expect(transferArgs.data.fromLibraryId).toBe(sourceLibraryId);
      expect(transferArgs.data.toLibraryId).toBe(returnLibraryId);
      expect(transferArgs.data.status).toBe("PENDING");

      // The source library's Book.availableCount was NOT incremented.
      const bookUpdate = txCalls.find((c) => c.model === "book" && c.method === "update");
      expect(bookUpdate).toBeUndefined();
    });

    it("returnRoaming rejects non-BORROWED transactions with BadRequestException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        ...roamingTx,
        status: TransactionStatus.RETURNED
      });
      await expect(
        service.returnRoaming("tx-roam", returnLibraryId)
      ).rejects.toThrow(BadRequestException);
    });

    // ── Plan 02-05 Task 1: SMS enqueued to source librarian on roaming creation
    it("returnRoaming enqueues SMS to source library when contact phone exists", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(roamingTx);
      mockPrisma.library.findUnique.mockResolvedValue({ id: returnLibraryId, name: "Toshkent MK" });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (p: typeof mockPrisma) => Promise<unknown>) => {
          return fn({
            ...mockPrisma,
            user: {
              ...mockPrisma.user,
              findUnique: jest.fn().mockResolvedValue({ trustScore: 80 })
            }
          } as unknown as typeof mockPrisma);
        }
      );

      await service.returnRoaming("tx-roam", returnLibraryId);

      // sms.sendNotification was called with the source library's phone and
      // a message that references the return library (so the source
      // librarian knows where the book physically is and that a
      // BookTransfer is awaiting confirmation).
      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        roamingTx.book.library.phone,
        expect.stringMatching(/Toshkent MK|Roaming|tasdiqlash/i),
        roamingTx.userId
      );
    });

    it("returnRoaming skips SMS enqueue when source library phone is missing", async () => {
      const noPhoneTx = {
        ...roamingTx,
        book: { ...roamingTx.book, library: { phone: null } }
      };
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(noPhoneTx);
      mockPrisma.library.findUnique.mockResolvedValue({ id: returnLibraryId, name: "Toshkent MK" });
      mockPrisma.$transaction.mockImplementation(
        async (fn: (p: typeof mockPrisma) => Promise<unknown>) => {
          return fn({
            ...mockPrisma,
            user: {
              ...mockPrisma.user,
              findUnique: jest.fn().mockResolvedValue({ trustScore: 80 })
            }
          } as unknown as typeof mockPrisma);
        }
      );

      await service.returnRoaming("tx-roam", returnLibraryId);

      // No SMS should fire when source library has no contact number.
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });
  });

  // ── reserve ────────────────────────────────────────────────────────────────
  describe("reserve", () => {
    it("kitobni bron qiladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockResolvedValue(0); // no overdue
      const reserved = { id: "tx1", type: TransactionType.RESERVE, status: TransactionStatus.PENDING };
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.create.mockResolvedValue(reserved);
      mockPrisma.book.update.mockResolvedValue({});

      const result = await service.reserve("u1", "b1");
      expect(result).toEqual(reserved);
    });

    it("allaqachon bron qilingan — BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue({ id: "existing" });
      await expect(service.reserve("u1", "b1")).rejects.toThrow("Bu kitob allaqachon bron qilingan");
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      await expect(service.reserve("u1", "b1")).rejects.toThrow(NotFoundException);
    });

    it("kitob mavjud emas — BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue({ ...availableBook, availableCount: 0 });
      await expect(service.reserve("u1", "b1")).rejects.toThrow(BadRequestException);
    });

    it("muddati o'tgan kitob bor — ForbiddenException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockResolvedValue(1); // has overdue
      await expect(service.reserve("u1", "b1")).rejects.toThrow(ForbiddenException);
    });

    it("kitob topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(null);
      await expect(service.reserve("u1", "b1")).rejects.toThrow(NotFoundException);
    });

    it("kutubxona telefoni bor bo'lsa SMS yuboriladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue({
        ...availableBook, library: { phone: "+998991234567" }
      });
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.create.mockResolvedValue({ id: "tx1" });
      mockPrisma.book.update.mockResolvedValue({});

      await service.reserve("u1", "b1");

      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998991234567",
        expect.stringContaining("bron"),
        "u1"
      );
    });
  });

  // ── scanIsbn (AUDIT-REPORT C6) ─────────────────────────────────────────────
  describe("scanIsbn (C6 — har skan testdan o'tadi)", () => {
    beforeEach(() => {
      // Default: no duplicates (both findFirst calls — confirmed dup check,
      // then pending USER_SCAN dup check — return null).
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-1", confirmed: false });
      mockPrisma.comprehensionTest.create.mockResolvedValue({});
    });

    it("HAR skan UNCONFIRMED yaratiladi va test talab qilinadi (avtotasdiq yo'q)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findFirst.mockResolvedValue({ title: "Alpomish", author: "Mualif" });

      const result = await service.scanIsbn("u1", "9789943452787");

      expect(result.requiresTest).toBe(true);
      expect(mockPrisma.comprehensionTest.create).toHaveBeenCalled();
      // The scan row is created WITHOUT confirmed=true and never auto-updated.
      expect(mockPrisma.isbnScan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ confirmed: true })
        })
      );
      expect(mockPrisma.isbnScan.update).not.toHaveBeenCalled();
    });

    it("duplicate ISBN (confirmed mavjud) — 400 BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      // First findFirst (confirmed dup check) hits.
      mockPrisma.isbnScan.findFirst.mockResolvedValueOnce({
        id: "scan-old", userId: "u1", isbn: "9789943452787", confirmed: true
      });

      const err = await service.scanIsbn("u1", "9789943452787").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/allaqachon hisobga olingan/i);
      // No new scan row, no new test.
      expect(mockPrisma.isbnScan.create).not.toHaveBeenCalled();
      expect(mockPrisma.comprehensionTest.create).not.toHaveBeenCalled();
    });

    it("pending duplicate (test ochiq) — mavjud skanga resume, yangi yozuv yo'q", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null) // confirmed dup — yo'q
        .mockResolvedValueOnce({    // pending USER_SCAN dup — bor, 1 urinish
          id: "scan-pending", userId: "u1", isbn: "9789943452787",
          confirmed: false, source: "USER_SCAN",
          comprehensionTest: { id: "test-p", attempts: 1, passed: false }
        });

      const result = await service.scanIsbn("u1", "9789943452787");

      expect(result.requiresTest).toBe(true);
      expect((result as { resumed?: boolean }).resumed).toBe(true);
      expect((result.scan as { id: string }).id).toBe("scan-pending");
      expect(mockPrisma.isbnScan.create).not.toHaveBeenCalled();
      expect(mockPrisma.comprehensionTest.create).not.toHaveBeenCalled();
    });

    it("pending duplicate urinishlari tugagan — 400 (rescan bilan cap reset bo'lmaydi)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.isbnScan.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "scan-failed", userId: "u1", isbn: "9789943452787",
          confirmed: false, source: "USER_SCAN",
          comprehensionTest: { id: "test-f", attempts: 3, passed: false }
        });

      const err = await service.scanIsbn("u1", "9789943452787").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/urinishlari tugagan/i);
      expect(mockPrisma.isbnScan.create).not.toHaveBeenCalled();
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.scanIsbn("u1", "isbn")).rejects.toThrow(NotFoundException);
    });

    it("kitob bazada yo'q bo'lsa nomi noma'lum saqlanadi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findFirst.mockResolvedValue(null);

      await service.scanIsbn("u1", "unknown-isbn");

      expect(mockPrisma.isbnScan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: "Nomi aniqlanmagan" })
        })
      );
    });
  });

  // ── getComprehensionTest (AUDIT-REPORT C6 — savollar endpointi) ────────────
  describe("getComprehensionTest (C6)", () => {
    const storedQuestions = [
      { q: "Kim?", options: ["A", "B", "C", "D"], answerIdx: 2 },
      { q: "Nima?", options: ["A", "B", "C", "D"], answerIdx: 0 },
      { q: "Qachon?", options: ["A", "B", "C", "D"], answerIdx: 3 },
    ];
    const baseScan = {
      id: "scan-1", userId: "u1", isbn: "9789943452787",
      title: "Alpomish", author: "Fozil Yo'ldosh", confirmed: false,
      comprehensionTest: {
        id: "test-1", attempts: 0, passed: false, questions: storedQuestions
      }
    };

    it("savollarni qaytaradi — answerIdx HECH QACHON oqib chiqmaydi", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue(baseScan);

      const result = await service.getComprehensionTest("u1", "scan-1");

      expect(result.status).toBe("PENDING");
      expect(result.attemptsLeft).toBe(3);
      expect(result.questions).toHaveLength(3);
      for (const [i, q] of result.questions.entries()) {
        // Exact response shape: ONLY {question, options} — nothing else.
        expect(Object.keys(q).sort()).toEqual(["options", "question"]);
        expect(q.question).toBe(storedQuestions[i].q);
        expect(q.options).toEqual(storedQuestions[i].options);
      }
      // Belt-and-braces: the serialized payload never contains the answer key.
      expect(JSON.stringify(result)).not.toContain("answerIdx");
    });

    it("begona skan — ForbiddenException (403)", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({ ...baseScan, userId: "u2" });
      await expect(service.getComprehensionTest("u1", "scan-1")).rejects.toThrow(ForbiddenException);
    });

    it("skan topilmasa NotFoundException (404)", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue(null);
      await expect(service.getComprehensionTest("u1", "nope")).rejects.toThrow(NotFoundException);
    });

    it("allaqachon tasdiqlangan skan — CONFIRMED holat, savollarsiz", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({ ...baseScan, confirmed: true });

      const result = await service.getComprehensionTest("u1", "scan-1");
      expect(result.status).toBe("CONFIRMED");
      expect(result.questions).toEqual([]);
    });

    it("urinishlar tugagan — ATTEMPTS_EXHAUSTED holat, savollarsiz", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        ...baseScan,
        comprehensionTest: { ...baseScan.comprehensionTest, attempts: 3 }
      });

      const result = await service.getComprehensionTest("u1", "scan-1");
      expect(result.status).toBe("ATTEMPTS_EXHAUSTED");
      expect(result.attemptsLeft).toBe(0);
      expect(result.questions).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("answerIdx");
    });

    it("attemptsLeft urinishlar sonidan kelib chiqadi", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        ...baseScan,
        comprehensionTest: { ...baseScan.comprehensionTest, attempts: 2 }
      });

      const result = await service.getComprehensionTest("u1", "scan-1");
      expect(result.status).toBe("PENDING");
      expect(result.attemptsLeft).toBe(1);
    });
  });

  // ── submitComprehensionTest ────────────────────────────────────────────────
  describe("submitComprehensionTest", () => {
    const questions = [
      { q: "Kim?", options: ["A", "B", "C", "D"], answerIdx: 0 },
      { q: "Nima?", options: ["A", "B", "C", "D"], answerIdx: 0 },
      { q: "Qachon?", options: ["A", "B", "C", "D"], answerIdx: 1 },
    ];
    // Default createdAt is 30s in the past so the FRAUD-02 min-time gate
    // (3 questions × 5s = 15s) is satisfied for pre-existing tests.
    const pendingTest = {
      id: "test-1", userId: "u1", isbnScanId: "scan-1",
      passed: false, attempts: 0, questions,
      createdAt: new Date(Date.now() - 30_000)
    };

    it("to'g'ri javob berilsa test o'tildi", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue(pendingTest);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.comprehensionTest.update.mockResolvedValue({});
      mockPrisma.isbnScan.update.mockResolvedValue({});

      const result = await service.submitComprehensionTest("u1", "scan-1", [0, 0, 1]);

      expect(result.passed).toBe(true);
      expect(result.correct).toBe(3);
    });

    it("yetarli javob yo'q — test o'tilmadi", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue(pendingTest);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.comprehensionTest.update.mockResolvedValue({});

      const result = await service.submitComprehensionTest("u1", "scan-1", [1, 1, 0]);

      expect(result.passed).toBe(false);
    });

    it("test topilmasa NotFoundException", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue(null);
      await expect(service.submitComprehensionTest("u1", "scan-1", [0])).rejects.toThrow(NotFoundException);
    });

    it("boshqa foydalanuvchi testi — ForbiddenException", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({ ...pendingTest, userId: "u2" });
      await expect(service.submitComprehensionTest("u1", "scan-1", [0])).rejects.toThrow(ForbiddenException);
    });

    it("allaqachon o'tilgan test — BadRequestException", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({ ...pendingTest, passed: true });
      await expect(service.submitComprehensionTest("u1", "scan-1", [0])).rejects.toThrow(BadRequestException);
    });

    it("3 urinish tugagan — BadRequestException", async () => {
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({ ...pendingTest, attempts: 3 });
      await expect(service.submitComprehensionTest("u1", "scan-1", [0])).rejects.toThrow(BadRequestException);
    });

    // ── FRAUD-01: comprehension test answer position is randomized ─────────────
    it("comprehension test randomizes answer position (FRAUD-01)", () => {
      // generateQuestions is private; we exercise the public scanIsbn path that
      // calls it on the every-5th confirmed scan. But the simpler proof is to
      // call the private fn via [] indexing — TypeScript allows this at runtime.
      const svc = service as unknown as {
        generateQuestions(t: string, a: string): Array<{ q: string; options: string[]; answerIdx: number }>;
      };
      const N = 1000;
      let answerIdxZeroForQ1 = 0;
      for (let i = 0; i < N; i++) {
        const qs = svc.generateQuestions("Alpomish", "Fozil Yo'ldosh");
        if (qs[0].answerIdx === 0) answerIdxZeroForQ1++;
      }
      // Uniform across 4 options would average 250/1000. We assert strictly < 800
      // (the prior bug was always 0 → 1000/1000). 800 catches it without
      // flaking on a slightly biased PRNG.
      expect(answerIdxZeroForQ1).toBeLessThan(800);
    });

    it("generated questions always store the correct value at answerIdx (FRAUD-01)", () => {
      const svc = service as unknown as {
        generateQuestions(t: string, a: string): Array<{ q: string; options: string[]; answerIdx: number }>;
      };
      // Sanity check: across 100 generations, every question's options[answerIdx]
      // is one of the original "correct" values (author or title), so the
      // shuffle never desynchronises the answer.
      for (let i = 0; i < 100; i++) {
        const qs = svc.generateQuestions("Alpomish", "Fozil Yo'ldosh");
        // Question 1 — correct = author
        expect(qs[0].options[qs[0].answerIdx]).toBe("Fozil Yo'ldosh");
        // Question 2 — correct = title
        expect(qs[1].options[qs[1].answerIdx]).toBe("Alpomish");
        // Question 3 — correct = recency answer
        expect(qs[2].options[qs[2].answerIdx]).toBe("Oxirgi 30 kun ichida");
      }
    });

    // ── FRAUD-02: server-side min-time gate ────────────────────────────────────
    it("rejects fast submission — elapsed < 5s/question (FRAUD-02)", async () => {
      // Test created 1 second ago — 3 questions × 5000 = 15s required.
      const createdAt = new Date(Date.now() - 1000);
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({
        ...pendingTest,
        createdAt
      });
      await expect(
        service.submitComprehensionTest("u1", "scan-1", [0, 0, 1])
      ).rejects.toThrow(/soniya/);
    });

    it("rejects fast per-question timings — any answer < 3s (FRAUD-02)", async () => {
      // Elapsed time is sufficient (20s for 3 questions), but per-question
      // timings include a 1-second answer — must reject.
      const createdAt = new Date(Date.now() - 20_000);
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({
        ...pendingTest,
        createdAt
      });
      await expect(
        service.submitComprehensionTest("u1", "scan-1", [0, 0, 1], [5000, 1000, 5000])
      ).rejects.toThrow(BadRequestException);
    });

    it("accepts submission when elapsed and per-question gates pass (FRAUD-02)", async () => {
      const createdAt = new Date(Date.now() - 30_000);
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({
        ...pendingTest,
        createdAt
      });
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.comprehensionTest.update.mockResolvedValue({});
      mockPrisma.isbnScan.update.mockResolvedValue({});

      const result = await service.submitComprehensionTest(
        "u1",
        "scan-1",
        [0, 0, 1],
        [4000, 5000, 6000]
      );
      expect(result.passed).toBe(true);
    });
  });

  // ── BOOK-03: reserve() borrow limit enforcement ─────────────────────────────
  describe("reserve borrow limit (BOOK-03)", () => {
    it("STUDENT_UNIVERSITY at limit 5 cannot reserve 6th", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        type: "STUDENT_UNIVERSITY",
        trustScore: 80
      });
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      // Default for hasOverdueBooks=0; the limit-check call returns 5.
      mockPrisma.bookTransaction.count.mockImplementation((args: { where: { status?: unknown } }) => {
        const status = args?.where?.status as { in?: string[] } | undefined;
        // Limit check: status.in contains the three active statuses → return 5.
        if (status?.in && status.in.length === 3) return Promise.resolve(5);
        // hasOverdueBooks: status is a scalar (BORROWED) → no overdue.
        return Promise.resolve(0);
      });

      const err = await service.reserve("u1", "b1").catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toMatch(/limit/i);
    });

    it("STUDENT_UNIVERSITY with trustScore 90+ has limit 6", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        type: "STUDENT_UNIVERSITY",
        trustScore: 95
      });
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockImplementation((args: { where: { status?: unknown } }) => {
        const status = args?.where?.status as { in?: string[] } | undefined;
        if (status?.in && status.in.length === 3) return Promise.resolve(5); // limit=6, active=5 → OK
        return Promise.resolve(0); // hasOverdueBooks
      });
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.create.mockResolvedValue({ id: "tx-new" });
      mockPrisma.book.update.mockResolvedValue({});

      const result = await service.reserve("u1", "b1");
      expect(result).toEqual({ id: "tx-new" });
    });

    it("CITIZEN at limit 2 cannot reserve 3rd", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      mockPrisma.bookTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.bookTransaction.count.mockImplementation((args: { where: { status?: unknown } }) => {
        const status = args?.where?.status as { in?: string[] } | undefined;
        if (status?.in && status.in.length === 3) return Promise.resolve(2); // active = limit
        return Promise.resolve(0);
      });

      await expect(service.reserve("u1", "b1")).rejects.toThrow(ForbiddenException);
    });
  });

  // ── confirmStorePurchase ───────────────────────────────────────────────────
  describe("confirmStorePurchase", () => {
    it("do'kon yozuvini tasdiqlaydi", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        id: "scan-1", userId: "u1", source: "STORE_MANUAL", confirmed: false
      });
      mockPrisma.isbnScan.update.mockResolvedValue({});

      const result = await service.confirmStorePurchase("u1", "scan-1");

      expect(result.confirmed).toBe(true);
      expect(mockPrisma.isbnScan.update).toHaveBeenCalled();
    });

    it("yozuv topilmasa NotFoundException", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue(null);
      await expect(service.confirmStorePurchase("u1", "scan-1")).rejects.toThrow(NotFoundException);
    });

    it("boshqa foydalanuvchi yozuvi — ForbiddenException", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        id: "scan-1", userId: "u2", source: "STORE_MANUAL", confirmed: false
      });
      await expect(service.confirmStorePurchase("u1", "scan-1")).rejects.toThrow(ForbiddenException);
    });

    it("do'kon tomonidan kiritilmagan — BadRequestException", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        id: "scan-1", userId: "u1", source: "USER_SCAN", confirmed: false
      });
      await expect(service.confirmStorePurchase("u1", "scan-1")).rejects.toThrow(BadRequestException);
    });

    it("allaqachon tasdiqlangan — BadRequestException", async () => {
      mockPrisma.isbnScan.findUnique.mockResolvedValue({
        id: "scan-1", userId: "u1", source: "STORE_MANUAL", confirmed: true
      });
      await expect(service.confirmStorePurchase("u1", "scan-1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── getUserHistory ─────────────────────────────────────────────────────────
  describe("getUserHistory", () => {
    it("foydalanuvchi tarixini qaytaradi", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([{ id: "tx1" }]);
      mockPrisma.isbnScan.findMany.mockResolvedValue([{ id: "scan-1" }]);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(2)  // activeBorrows
        .mockResolvedValueOnce(1); // pendingBrons

      const result = await service.getUserHistory("u1");

      expect(result.transactions).toHaveLength(1);
      expect(result.isbnScans).toHaveLength(1);
      expect(result.activeBorrows).toBe(2);
      expect(result.pendingBrons).toBe(1);
    });
  });

  // ── extendDueDate ──────────────────────────────────────────────────────────
  describe("extendDueDate", () => {
    it("extendDueDate sets extended=true (no more penaltyDays=-1 magic number)", async () => {
      const dueDate = new Date(Date.now() + 5 * 86400000);
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u1", status: TransactionStatus.BORROWED,
        dueDate, penaltyDays: 0, extended: false
      });
      mockPrisma.bookTransaction.update.mockResolvedValue({});

      await service.extendDueDate("tx1", "u1");

      // The write must set extended=true and must NOT set penaltyDays=-1.
      expect(mockPrisma.bookTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ extended: true })
        })
      );
      const writeArgs = mockPrisma.bookTransaction.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(writeArgs.data.penaltyDays).toBeUndefined();
    });

    it("extendDueDate rejects second extension (extended=true)", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u1", status: TransactionStatus.BORROWED,
        dueDate: new Date(Date.now() + 86400000), penaltyDays: 0, extended: true
      });
      await expect(service.extendDueDate("tx1", "u1")).rejects.toThrow(BadRequestException);
    });

    it("tranzaksiya topilmasa NotFoundException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue(null);
      await expect(service.extendDueDate("notfound", "u1")).rejects.toThrow(NotFoundException);
    });

    it("boshqa foydalanuvchi — ForbiddenException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u2", status: TransactionStatus.BORROWED,
        dueDate: new Date(), penaltyDays: 0, extended: false
      });
      await expect(service.extendDueDate("tx1", "u1")).rejects.toThrow(ForbiddenException);
    });

    it("BORROWED emas — BadRequestException", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u1", status: TransactionStatus.RETURNED,
        dueDate: new Date(), penaltyDays: 0, extended: false
      });
      await expect(service.extendDueDate("tx1", "u1")).rejects.toThrow(BadRequestException);
    });

    // AUDIT-REPORT M15 — gate endi to'g'ridan-to'g'ri dueDate < now.
    // penaltyDays faqat tungi cron da yoziladi; kun davomida muddati o'tgan
    // (penaltyDays hali 0 bo'lgan) kitobni uzaytirish RAD ETILISHI shart.
    it("M15: dueDate o'tgan, penaltyDays hali 0 — uzaytirish rad etiladi", async () => {
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u1", status: TransactionStatus.BORROWED,
        dueDate: new Date(Date.now() - 60_000), // 1 daqiqa oldin o'tgan
        penaltyDays: 0, extended: false
      });

      await expect(service.extendDueDate("tx1", "u1"))
        .rejects.toThrow("Muddati o'tgan kitobni uzaytirish mumkin emas");
      expect(mockPrisma.bookTransaction.update).not.toHaveBeenCalled();
    });

    it("M15: dueDate hali kelmagan — uzaytirish ishlaydi (penaltyDays dan mustaqil)", async () => {
      const dueDate = new Date(Date.now() + 2 * 86400000);
      mockPrisma.bookTransaction.findUnique.mockResolvedValue({
        id: "tx1", userId: "u1", status: TransactionStatus.BORROWED,
        dueDate, penaltyDays: 0, extended: false
      });
      mockPrisma.bookTransaction.update.mockResolvedValue({});

      await service.extendDueDate("tx1", "u1");

      expect(mockPrisma.bookTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ extended: true }) })
      );
    });
  });

  // ── STORE-02 (Plan 02-05 Task 4): end-to-end cascade verification ─────────
  // STORE-02 = "kitobxon sotib olgan kitobni hisoblash" — the flow cascades
  // from Plan 02-01's FRAUD-01 fix (randomized answerIdx) + Plan 02-04's
  // STORE-01 24h gate. This verification suite is the audit trail proving
  // those upstream fixes integrate correctly for the scan→test→RI flow.
  // AUDIT-REPORT C6 — the 1-in-5 cadence is GONE: every scan stores a test
  // and stays unconfirmed until submitComprehensionTest passes.
  describe("STORE-02 cascade verification (scan → comprehension → RI)", () => {
    beforeEach(() => {
      mockPrisma.isbnScan.findFirst.mockResolvedValue(null); // no duplicates
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
    });

    it("scanIsbn triggers a comprehension test on EVERY scan (C6 + FRAUD-01)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findFirst.mockResolvedValue({
        title: "Alpomish",
        author: "Fozil Yo'ldosh"
      });
      mockPrisma.isbnScan.create.mockResolvedValue({ id: "scan-5" });
      mockPrisma.comprehensionTest.create.mockResolvedValue({});

      const result = await service.scanIsbn("u1", "9789943452787");

      expect(result.requiresTest).toBe(true);
      // The test was created with questions including randomized answerIdx —
      // cross-verification with Plan 02-01 FRAUD-01 randomization.
      expect(mockPrisma.comprehensionTest.create).toHaveBeenCalled();
      const createArgs = mockPrisma.comprehensionTest.create.mock.calls[0][0] as {
        data: { questions: Array<{ q: string; options: string[]; answerIdx: number }> };
      };
      const questions = createArgs.data.questions;
      // We assert the structural shape: every question stores the
      // correct value at its recorded answerIdx (FRAUD-01 invariant).
      for (const q of questions) {
        expect(q.options[q.answerIdx]).toBeDefined();
        expect(q.options).toHaveLength(4);
      }
    });

    it("scanIsbn NEVER auto-confirms — every scan in a row stays gated (C6)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findFirst.mockResolvedValue({
        title: "Alpomish",
        author: "Fozil Yo'ldosh"
      });
      mockPrisma.comprehensionTest.create.mockResolvedValue({});

      // Five consecutive scans of DIFFERENT isbns — pre-fix, 4 of these would
      // have auto-confirmed without any verification.
      for (let i = 0; i < 5; i++) {
        mockPrisma.isbnScan.create.mockResolvedValueOnce({ id: `scan-${i}` });
        const result = await service.scanIsbn("u1", `978994345278${i}`);
        expect(result.requiresTest).toBe(true);
      }
      // No auto-confirm update fired; a test row exists for each scan.
      expect(mockPrisma.isbnScan.update).not.toHaveBeenCalled();
      expect(mockPrisma.comprehensionTest.create).toHaveBeenCalledTimes(5);
    });

    it("passing submitComprehensionTest is the ONLY path that confirms the scan", async () => {
      const questions = [
        { q: "Kim?", options: ["A", "B", "C", "D"], answerIdx: 1 },
        { q: "Nima?", options: ["A", "B", "C", "D"], answerIdx: 0 },
        { q: "Qachon?", options: ["A", "B", "C", "D"], answerIdx: 2 },
      ];
      mockPrisma.comprehensionTest.findUnique.mockResolvedValue({
        id: "test-1", userId: "u1", isbnScanId: "scan-1",
        passed: false, attempts: 0, questions,
        createdAt: new Date(Date.now() - 30_000)
      });
      mockPrisma.comprehensionTest.update.mockResolvedValue({});
      mockPrisma.isbnScan.update.mockResolvedValue({});

      const result = await service.submitComprehensionTest("u1", "scan-1", [1, 0, 2]);

      expect(result.passed).toBe(true);
      expect(mockPrisma.isbnScan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "scan-1" },
          data: expect.objectContaining({ confirmed: true })
        })
      );
      // RI credit trigger — badge/RI hooks fire only after the pass.
      expect(mockBadge.checkAfterTest).toHaveBeenCalledWith("u1");
    });
  });

  // ── BOOK-04 (Plan 02-05 Task 2): overdue cron verify + rename ─────────────
  describe("BOOK-04 overdue cron", () => {
    it("checkOverdueAlerts enqueues 3-day reminder SMS for dueDate ~+3d", async () => {
      const now = Date.now();
      const dueIn3d = new Date(now + 3 * 24 * 60 * 60 * 1000);
      mockPrisma.bookTransaction.findMany
        // First call: 3-day window
        .mockResolvedValueOnce([
          {
            id: "tx-3d",
            userId: "u1",
            bookId: "b1",
            status: TransactionStatus.BORROWED,
            dueDate: dueIn3d,
            user: { phone: "+998901234567" },
            book: { title: "Alpomish" }
          }
        ])
        // Second call: 1-day window — empty
        .mockResolvedValueOnce([]);

      await service.checkOverdueAlerts();

      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901234567",
        expect.stringMatching(/3 kun/),
        "u1"
      );
    });

    it("checkOverdueAlerts enqueues 1-day reminder SMS for dueDate ~+1d", async () => {
      const now = Date.now();
      const dueIn1d = new Date(now + 1 * 24 * 60 * 60 * 1000);
      mockPrisma.bookTransaction.findMany
        .mockResolvedValueOnce([]) // 3-day window empty
        .mockResolvedValueOnce([
          {
            id: "tx-1d",
            userId: "u2",
            bookId: "b2",
            status: TransactionStatus.BORROWED,
            dueDate: dueIn1d,
            user: { phone: "+998901111111" },
            book: { title: "O'tkan kunlar" }
          }
        ]);

      await service.checkOverdueAlerts();

      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901111111",
        expect.stringMatching(/ERTAGA/i),
        "u2"
      );
    });

    it("hasOverdueBooks blocks new borrow (ForbiddenException)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      mockPrisma.book.findUnique.mockResolvedValue(availableBook);
      // hasOverdueBooks count > 0 → block
      mockPrisma.bookTransaction.count.mockResolvedValueOnce(1);

      const err = await service.borrow("u1", "b1").catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toMatch(/muddati o'tgan/i);
    });

    it("recomputeOverdueDays updates penaltyDays but does NOT touch user.status", async () => {
      const now = Date.now();
      const past = new Date(now - 5 * 24 * 60 * 60 * 1000);
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        {
          id: "tx-overdue",
          userId: "u1",
          bookId: "b1",
          status: TransactionStatus.BORROWED,
          dueDate: past,
          penaltyDays: 0,
          user: { phone: "+998901234567", status: "ACTIVE" },
          book: { title: "Alpomish" }
        }
      ]);
      mockPrisma.bookTransaction.update.mockResolvedValue({});

      // The renamed cron must exist.
      const svc = service as unknown as { recomputeOverdueDays: () => Promise<void> };
      expect(typeof svc.recomputeOverdueDays).toBe("function");
      await svc.recomputeOverdueDays();

      // penaltyDays is updated
      expect(mockPrisma.bookTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "tx-overdue" },
          data: expect.objectContaining({ penaltyDays: expect.any(Number) })
        })
      );
      // User.status was NEVER touched (naming honesty — the cron never blocked
      // users; it only updates penaltyDays).
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ── AUDIT-REPORT M14: RESERVED bronlar ham muddati o'tadi ──────────────────
  describe("autoExpireReservations — M14 RESERVED sweep", () => {
    it("supurish so'rovi ikkala holatni qamraydi: PENDING (24h) va RESERVED (72h)", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.autoExpireReservations();

      const args = mockPrisma.bookTransaction.findMany.mock.calls[0][0] as {
        where: {
          OR: Array<{
            status: string;
            reservationExpiresAt?: { lt: Date };
            createdAt?: { lt: Date };
          }>;
        };
      };
      expect(args.where.OR).toHaveLength(2);

      const pendingArm = args.where.OR.find((a) => a.status === TransactionStatus.PENDING);
      const reservedArm = args.where.OR.find((a) => a.status === TransactionStatus.RESERVED);
      expect(pendingArm?.reservationExpiresAt?.lt).toBeInstanceOf(Date);
      expect(reservedArm?.createdAt?.lt).toBeInstanceOf(Date);

      // RESERVED kesimi ~72 soat orqada bo'lishi kerak.
      const cutoff = reservedArm!.createdAt!.lt;
      const ageHours = (Date.now() - cutoff.getTime()) / 3_600_000;
      expect(ageHours).toBeGreaterThan(71.9);
      expect(ageHours).toBeLessThan(72.1);
    });

    it("eski RESERVED bron bekor qilinadi: CANCELLED + availableCount++ + SMS", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        {
          id: "tx-res-stale",
          bookId: "b1",
          userId: "u1",
          status: TransactionStatus.RESERVED,
          user: { phone: "+998901234567" },
          book: { title: "Alpomish" }
        }
      ]);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.update.mockResolvedValue({});
      mockPrisma.book.update.mockResolvedValue({});

      await service.autoExpireReservations();

      expect(mockPrisma.bookTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "tx-res-stale" },
          data: { status: TransactionStatus.CANCELLED }
        })
      );
      // Nusxa fondga qaytadi — bir xil interaktiv transaction ichida.
      expect(mockPrisma.book.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "b1" },
          data: { availableCount: { increment: 1 } }
        })
      );
      // RESERVED uchun mos xabar (72 soat tilga olinadi).
      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901234567",
        expect.stringMatching(/72 soat/),
        "u1"
      );
    });

    it("PENDING bron uchun avvalgi 24 soatlik xabar matni saqlanadi", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([
        {
          id: "tx-pending-stale",
          bookId: "b1",
          userId: "u1",
          status: TransactionStatus.PENDING,
          user: { phone: "+998901234567" },
          book: { title: "Alpomish" }
        }
      ]);
      mockPrisma.$transaction.mockImplementation(async (fn: (p: typeof mockPrisma) => Promise<unknown>) =>
        fn(mockPrisma as unknown as typeof mockPrisma)
      );
      mockPrisma.bookTransaction.update.mockResolvedValue({});
      mockPrisma.book.update.mockResolvedValue({});

      await service.autoExpireReservations();

      expect(mockSms.sendNotification).toHaveBeenCalledWith(
        "+998901234567",
        expect.stringMatching(/24 soat/),
        "u1"
      );
    });
  });

  // ── AUDIT-REPORT H8 (FIX 4): cron leader locks ─────────────────────────────
  describe("cron leader locks (H8 FIX 4)", () => {
    it("autoExpireReservations: lock not acquired → no-op (no reads, no SMS)", async () => {
      mockRedisLock.tryAcquire.mockResolvedValueOnce({ first: false });

      await service.autoExpireReservations();

      expect(mockPrisma.bookTransaction.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });

    it("autoExpireReservations: lock acquired with hour-bucket key, then sweeps", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.autoExpireReservations();

      expect(mockRedisLock.tryAcquire).toHaveBeenCalledTimes(1);
      const [key, ttl] = mockRedisLock.tryAcquire.mock.calls[0];
      // FIX F key naming: cron:<job>:<period-bucket>; hourly job → hour bucket.
      expect(key).toMatch(/^cron:auto-expire-reservations:\d{4}-\d{2}-\d{2}T\d{2}$/);
      expect(ttl).toBe(2 * 60 * 60);
      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalled();
    });

    it("checkOverdueAlerts: lock not acquired → no-op (no reads, no SMS)", async () => {
      mockRedisLock.tryAcquire.mockResolvedValueOnce({ first: false });

      await service.checkOverdueAlerts();

      expect(mockPrisma.bookTransaction.findMany).not.toHaveBeenCalled();
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });

    it("checkOverdueAlerts: lock acquired with day-bucket key, then sweeps", async () => {
      mockPrisma.bookTransaction.findMany.mockResolvedValue([]);

      await service.checkOverdueAlerts();

      const [key, ttl] = mockRedisLock.tryAcquire.mock.calls[0];
      expect(key).toMatch(/^cron:overdue-alerts:\d{4}-\d{2}-\d{2}$/);
      expect(ttl).toBe(2 * 60 * 60);
      expect(mockPrisma.bookTransaction.findMany).toHaveBeenCalledTimes(2); // 3-day + 1-day windows
    });
  });

  // ── FRAUD-04: storeManualEntry authorization via authenticated user ────────
  describe("storeManualEntry (FRAUD-04) — store entry", () => {
    const reader = { id: "reader-1", phone: "+998901234567" };

    it("store entry derives operator from authenticated user", async () => {
      const authUserId = "auth-operator-1";
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: authUserId, role: "DOKON_OPERATOR" })
        .mockResolvedValueOnce(reader);
      mockPrisma.store.findFirst.mockResolvedValue({ id: "store-1", operatorId: authUserId });
      mockPrisma.book.findFirst.mockResolvedValue({ title: "Alpomish", author: "Mualif" });
      mockPrisma.isbnScan.create.mockImplementation((args: { data: unknown }) =>
        Promise.resolve({ id: "scan-1", ...(args.data as object) })
      );

      const result = await service.storeManualEntry(authUserId, "+998901234567", "9789943452787");

      expect(mockPrisma.isbnScan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storeId: authUserId, source: "STORE_MANUAL" })
        })
      );
      expect((result as { storeId?: string }).storeId).toBe(authUserId);
    });

    it("store entry rejects non-DOKON_OPERATOR / non-SUPER_ADMIN", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: "u1", role: "CITIZEN" });

      await expect(
        service.storeManualEntry("u1", "+998901234567", "9789943452787")
      ).rejects.toThrow(ForbiddenException);
    });

    it("store entry rejects DOKON_OPERATOR without a matching Store.operatorId", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: "rogue", role: "DOKON_OPERATOR" });
      mockPrisma.store.findFirst.mockResolvedValue(null);

      await expect(
        service.storeManualEntry("rogue", "+998901234567", "9789943452787")
      ).rejects.toThrow(ForbiddenException);
    });

    it("store entry SUPER_ADMIN does not require an Institution row", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "admin-1", role: "SUPER_ADMIN" })
        .mockResolvedValueOnce(reader);
      mockPrisma.book.findFirst.mockResolvedValue({ title: "Alpomish", author: "Mualif" });
      mockPrisma.isbnScan.create.mockImplementation((args: { data: unknown }) =>
        Promise.resolve({ id: "scan-2", ...(args.data as object) })
      );

      const result = await service.storeManualEntry("admin-1", "+998901234567", "9789943452787");
      expect((result as { storeId?: string }).storeId).toBe("admin-1");
      // SUPER_ADMIN uchun egalik tekshiruvi o'tkazib yuboriladi; keyingi
      // decrementStoreStock chaqirig'i esa store.findFirst ni ishlatadi,
      // shuning uchun "umuman chaqirilmagan" emas, egalik shoxi bo'yicha
      // tekshiramiz: rad etish istisnosi otilmadi va scan yaratildi.
      expect(mockPrisma.isbnScan.create).toHaveBeenCalled();
    });

    it("store entry rejects when phone is not registered", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "admin-1", role: "SUPER_ADMIN" })
        .mockResolvedValueOnce(null);

      await expect(
        service.storeManualEntry("admin-1", "+998900000000", "9789943452787")
      ).rejects.toThrow(NotFoundException);
    });
  });
});
