/**
 * IDOR-C3 — controller-level identity binding.
 *
 * Reader-initiated endpoints (reserve, isbn-scan, test submit, store-purchase
 * confirm, extend, cancel) must derive the acting user from the JWT
 * (@CurrentUser → payload.sub), NEVER from the request body. These specs prove
 * the binding "by construction": the handler signatures no longer read
 * body.userId, so a forged id in the body cannot reach the service.
 *
 * Librarian-driven endpoints (borrow / return / confirm-reservation) KEEP an
 * explicit userId — a KUTUBXONACHI scans a reader's QR and acts FOR that
 * reader; those routes are tier-gated by @Roles(...LIBRARIAN_ROLES).
 */
import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { TransactionsController } from "../transactions.controller";
import { TransactionsService } from "../transactions.service";
import { JwtPayload } from "../../../common/decorators/current-user.decorator";

const mockSvc = {
  findAll: jest.fn(),
  getUserHistory: jest.fn().mockResolvedValue({ transactions: [] }),
  getLibraryBrons: jest.fn(),
  getLibraryBorrowed: jest.fn(),
  getOverdueByLibrary: jest.fn(),
  reserve: jest.fn().mockResolvedValue({ id: "tx-1" }),
  confirmReservation: jest.fn(),
  cancelReservation: jest.fn().mockResolvedValue({ cancelled: true }),
  borrow: jest.fn().mockResolvedValue({ id: "tx-2" }),
  extendDueDate: jest.fn().mockResolvedValue({ id: "tx-3" }),
  returnBook: jest.fn(),
  returnRoaming: jest.fn(),
  scanIsbn: jest.fn().mockResolvedValue({ scan: { id: "scan-1" }, requiresTest: true }),
  getComprehensionTest: jest.fn().mockResolvedValue({
    status: "PENDING",
    attemptsLeft: 3,
    questions: [{ question: "Kim?", options: ["A", "B", "C", "D"] }],
  }),
  submitComprehensionTest: jest.fn().mockResolvedValue({ passed: true }),
  storeManualEntry: jest.fn(),
  confirmStorePurchase: jest.fn().mockResolvedValue({ confirmed: true }),
};

const payload = (sub: string, role: UserRole): JwtPayload => ({
  sub,
  role,
  phone: "+998901234567",
});

const READER = payload("reader-jwt", UserRole.KITOBXON);
const LIBRARIAN = payload("librarian-jwt", UserRole.KUTUBXONACHI);

describe("TransactionsController (IDOR-C3)", () => {
  let controller: TransactionsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TransactionsController(mockSvc as unknown as TransactionsService);
  });

  describe("reader-self endpoints bind to the JWT sub", () => {
    it("reserve: service called with the JWT sub — a forged body.userId is unreachable", async () => {
      // Stale/malicious client still sends userId — the handler signature
      // only reads bookId, so the forged value can never reach the service.
      const forgedBody = { userId: "victim-1", bookId: "b1" } as unknown as { bookId: string };
      await controller.reserve(READER.sub, forgedBody);

      expect(mockSvc.reserve).toHaveBeenCalledWith("reader-jwt", "b1");
      expect(mockSvc.reserve).not.toHaveBeenCalledWith("victim-1", expect.anything());
    });

    it("scanIsbn: scan is credited to the JWT sub only", async () => {
      const forgedBody = { userId: "victim-1", isbn: "9789943452787" } as unknown as { isbn: string };
      await controller.scanIsbn(READER.sub, forgedBody);

      expect(mockSvc.scanIsbn).toHaveBeenCalledWith("reader-jwt", "9789943452787");
      expect(mockSvc.scanIsbn).not.toHaveBeenCalledWith("victim-1", expect.anything());
    });

    it("submitTest: submitter is the JWT sub", async () => {
      const forgedBody = { userId: "victim-1", answers: [0, 1, 2] } as unknown as { answers: number[] };
      await controller.submitTest("scan-9", READER.sub, forgedBody);

      expect(mockSvc.submitComprehensionTest).toHaveBeenCalledWith("reader-jwt", "scan-9", [0, 1, 2]);
    });

    // AUDIT-REPORT C6 — GET isbn-scan/:id/test binds the caller from the JWT
    // and the service response never carries answerIdx.
    it("getTest: question fetch binds to the JWT sub (C6)", async () => {
      const result = await controller.getTest("scan-9", READER.sub);

      expect(mockSvc.getComprehensionTest).toHaveBeenCalledWith("reader-jwt", "scan-9");
      expect(JSON.stringify(result)).not.toContain("answerIdx");
    });

    it("confirmStorePurchase: confirmer is the JWT sub", async () => {
      await controller.confirmStorePurchase("scan-7", READER.sub);
      expect(mockSvc.confirmStorePurchase).toHaveBeenCalledWith("reader-jwt", "scan-7");
    });

    it("extendDueDate: extender is the JWT sub", async () => {
      await controller.extendDueDate("tx-5", READER.sub);
      expect(mockSvc.extendDueDate).toHaveBeenCalledWith("tx-5", "reader-jwt");
    });
  });

  describe("cancelReservation — requester + librarian flag from the JWT", () => {
    it("KITOBXON: requesterId = JWT sub, isLibrarian = false (body cannot claim it)", async () => {
      await controller.cancelReservation("tx-1", READER);
      expect(mockSvc.cancelReservation).toHaveBeenCalledWith("tx-1", "reader-jwt", false);
    });

    it("KUTUBXONACHI: isLibrarian = true derived from the ROLE", async () => {
      await controller.cancelReservation("tx-1", LIBRARIAN);
      expect(mockSvc.cancelReservation).toHaveBeenCalledWith("tx-1", "librarian-jwt", true);
    });

    it("MUASSASA_ADMIN and SUPER_ADMIN also count as librarian tier", async () => {
      await controller.cancelReservation("tx-1", payload("ma-1", UserRole.MUASSASA_ADMIN));
      expect(mockSvc.cancelReservation).toHaveBeenLastCalledWith("tx-1", "ma-1", true);

      await controller.cancelReservation("tx-1", payload("sa-1", UserRole.SUPER_ADMIN));
      expect(mockSvc.cancelReservation).toHaveBeenLastCalledWith("tx-1", "sa-1", true);
    });
  });

  describe("getUserHistory — self OR librarian/admin tier", () => {
    it("KITOBXON may read their OWN history", async () => {
      await controller.getUserHistory("reader-jwt", READER);
      expect(mockSvc.getUserHistory).toHaveBeenCalledWith("reader-jwt");
    });

    it("KITOBXON requesting ANOTHER user's history → ForbiddenException (403)", async () => {
      expect(() => controller.getUserHistory("victim-1", READER)).toThrow(ForbiddenException);
      expect(mockSvc.getUserHistory).not.toHaveBeenCalled();
    });

    it("KUTUBXONACHI may read a reader's history (serves them at the desk)", async () => {
      await controller.getUserHistory("reader-jwt", LIBRARIAN);
      expect(mockSvc.getUserHistory).toHaveBeenCalledWith("reader-jwt");
    });

    it("TUMAN_ADMIN / VILOYAT_ADMIN / SUPER_ADMIN may read any history", async () => {
      await controller.getUserHistory("u-x", payload("ta-1", UserRole.TUMAN_ADMIN));
      await controller.getUserHistory("u-x", payload("va-1", UserRole.VILOYAT_ADMIN));
      await controller.getUserHistory("u-x", payload("sa-1", UserRole.SUPER_ADMIN));
      expect(mockSvc.getUserHistory).toHaveBeenCalledTimes(3);
    });

    it("DOKON_OPERATOR is NOT a history-viewer tier → 403 for another user's history", () => {
      expect(() =>
        controller.getUserHistory("u-x", payload("op-1", UserRole.DOKON_OPERATOR))
      ).toThrow(ForbiddenException);
    });
  });

  describe("librarian flows keep an explicit userId (by design)", () => {
    it("borrow: the librarian passes the SCANNED reader's id in the body", async () => {
      await controller.borrow({ userId: "scanned-reader", bookId: "b1" });
      // 4-argument — ixtiyoriy dueDate (kutubxonachi standart 14 kundan
      // boshqa muddat belgilashi mumkin); body'da berilmasa undefined.
      expect(mockSvc.borrow).toHaveBeenCalledWith(
        "scanned-reader",
        "b1",
        undefined,
        undefined,
      );
    });
  });
});
