import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { TransactionStatus, UserRole } from "@prisma/client";
import { TransactionsService } from "./transactions.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";

const LIBRARIAN_ROLES = [
  UserRole.KUTUBXONACHI,
  UserRole.MUASSASA_ADMIN,
  UserRole.SUPER_ADMIN
] as const;

const STORE_ROLES = [UserRole.DOKON_OPERATOR, UserRole.SUPER_ADMIN] as const;

// IDOR-C3 — roles that may read ANOTHER user's history (librarians serve
// readers at the desk; regional admins monitor). A plain KITOBXON may only
// read their own history. Mirrors the findAll() tier set above.
const HISTORY_VIEWER_ROLES = [
  ...LIBRARIAN_ROLES,
  UserRole.TUMAN_ADMIN,
  UserRole.VILOYAT_ADMIN
] as const;

function isLibrarianRole(role: string): boolean {
  return (LIBRARIAN_ROLES as readonly UserRole[]).includes(role as UserRole);
}

@ApiTags("transactions")
@ApiBearerAuth()
@Controller("transactions")
export class TransactionsController {
  constructor(private readonly svc: TransactionsService) {}

  // ── O'qish ────────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Tranzaksiyalar ro'yhati (filter: userId, status)" })
  findAll(
    @Query("userId") userId?: string,
    @Query("status") status?: TransactionStatus
  ) {
    return this.svc.findAll(userId, status);
  }

  // IDOR-C3 — self OR librarian/admin tiers only. A librarian legitimately
  // views a reader's history while serving them; a plain KITOBXON must not
  // enumerate other readers' borrow history.
  @Get("user/:userId/history")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Kitobxon faoliyat tarixi (o'zi yoki kutubxonachi/admin)" })
  getUserHistory(@Param("userId") userId: string, @CurrentUser() user: JwtPayload) {
    const isSelf = user.sub === userId;
    const isPrivileged = (HISTORY_VIEWER_ROLES as readonly UserRole[]).includes(
      user.role as UserRole
    );
    if (!isSelf && !isPrivileged) {
      throw new ForbiddenException("Faqat o'z faoliyat tarixingizni ko'rishingiz mumkin");
    }
    return this.svc.getUserHistory(userId);
  }

  @Get("library/:libraryId/brons")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kutubxona aktiv bronlari (PENDING + RESERVED)" })
  getLibraryBrons(@Param("libraryId") libraryId: string) {
    return this.svc.getLibraryBrons(libraryId);
  }

  @Get("library/:libraryId/borrowed")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kutubxona berilgan kitoblar" })
  getLibraryBorrowed(@Param("libraryId") libraryId: string) {
    return this.svc.getLibraryBorrowed(libraryId);
  }

  @Get("library/:libraryId/overdue")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kutubxona muddati o'tgan kitoblar" })
  getOverdueByLibrary(@Param("libraryId") libraryId: string) {
    return this.svc.getOverdueByLibrary(libraryId);
  }

  // ── Bron ─────────────────────────────────────────────────────────────────

  // IDOR-C3 — the reserving reader is the AUTHENTICATED user (JWT sub), never
  // body.userId. The body type omits userId so callers cannot forge it; any
  // userId a stale client still sends is silently ignored by signature
  // (same migration-window pattern as storeManualEntry / FRAUD-04 below).
  @Post("reserve")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Kitob bron qilish (har qanday autentifikatsiyalangan — o'zi uchun)" })
  reserve(@CurrentUser("id") userId: string, @Body() body: { bookId: string }) {
    return this.svc.reserve(userId, body.bookId);
  }

  @Patch(":id/confirm-reservation")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kutubxonachi bronni tasdiqlaydi (PENDING→RESERVED)" })
  confirmReservation(@Param("id") id: string) {
    return this.svc.confirmReservation(id);
  }

  // IDOR-C3 — requester = JWT sub; librarian privilege = JWT ROLE, never the
  // body. Previously any reader could send {isLibrarian: true} and cancel
  // arbitrary reservations. Self-cancel works for the owning reader; the
  // librarian tier (KUTUBXONACHI/MUASSASA_ADMIN/SUPER_ADMIN) may cancel any.
  @Delete(":id/cancel-reservation")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Bron bekor qilish (kitobxon o'ziniki yoki kutubxonachi)" })
  cancelReservation(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.svc.cancelReservation(id, user.sub, isLibrarianRole(user.role));
  }

  // ── Berish / Qaytarish ────────────────────────────────────────────────────

  @Post("borrow")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kitob berish (BORROWED). reservationId + dueDate ixtiyoriy." })
  borrow(@Body() body: { userId: string; bookId: string; reservationId?: string; dueDate?: string }) {
    return this.svc.borrow(body.userId, body.bookId, body.reservationId, body.dueDate);
  }

  // IDOR-C3 — reader-self endpoint: actor from JWT, body.userId removed
  // (service ownership check `tx.userId !== userId` now runs against the sub).
  @Patch(":id/extend")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Qaytarish muddatini 7 kunga uzaytirish (1 marta, o'zi uchun)" })
  extendDueDate(@Param("id") id: string, @CurrentUser("id") userId: string) {
    return this.svc.extendDueDate(id, userId);
  }

  @Patch(":id/return")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kitob qaytarish" })
  returnBook(
    @Param("id") id: string,
    @Body() body: { returnLibraryId?: string }
  ) {
    return this.svc.returnBook(id, body.returnLibraryId);
  }

  @Patch(":id/return-roaming")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...LIBRARIAN_ROLES)
  @ApiOperation({ summary: "Kitob roaming qaytarish (boshqa kutubxona)" })
  returnRoaming(
    @Param("id") id: string,
    @Body() body: { returnLibraryId: string }
  ) {
    return this.svc.returnRoaming(id, body.returnLibraryId);
  }

  // ── ISBN Scan ─────────────────────────────────────────────────────────────

  // IDOR-C3 — scan is credited to the AUTHENTICATED reader only. Previously a
  // fraudster could pump another user's (or a mule account's) Reading Index by
  // posting arbitrary userId values.
  @Post("isbn-scan")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Kitobxon sotib olingan kitob ISBN skan qiladi (o'zi uchun)" })
  scanIsbn(@CurrentUser("id") userId: string, @Body() body: { isbn: string }) {
    return this.svc.scanIsbn(userId, body.isbn);
  }

  // AUDIT-REPORT C6 — server-side question feed. The scan owner (JWT sub)
  // fetches {question, options[]} per question; answerIdx NEVER leaves the
  // server. Foreign scan id → 403 (404 if the scan doesn't exist). Confirmed
  // or attempts-exhausted scans return a status the UI renders directly.
  @Get("isbn-scan/:id/test")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Comprehension test savollarini olish (o'zi uchun; javob indekslari qaytarilmaydi)" })
  getTest(
    @Param("id") isbnScanId: string,
    @CurrentUser("id") userId: string
  ) {
    return this.svc.getComprehensionTest(userId, isbnScanId);
  }

  // IDOR-C3 — test submitter = JWT sub (service check `test.userId !== userId`
  // now binds to the real caller).
  @Post("isbn-scan/:id/test")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Comprehension test javoblarini yuborish (o'zi uchun)" })
  submitTest(
    @Param("id") isbnScanId: string,
    @CurrentUser("id") userId: string,
    @Body() body: { answers: number[] }
  ) {
    return this.svc.submitComprehensionTest(userId, isbnScanId, body.answers);
  }

  @Post("store-entry")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STORE_ROLES)
  @ApiOperation({ summary: "Do'kon operatori manual kitob yozuvi (operator = autentifikatsiyalangan foydalanuvchi)" })
  // FRAUD-04: operatorId is derived from the JWT (CurrentUser), NOT from the
  // request body. The body type omits operatorId so callers cannot forge it.
  // (The frontend still sends operatorId during the migration window; the
  // service silently ignores any body.operatorId by signature.)
  storeManualEntry(
    @CurrentUser("id") authUserId: string,
    @Body() body: { phone: string; isbn: string }
  ) {
    return this.svc.storeManualEntry(authUserId, body.phone, body.isbn);
  }

  // QR-skan orqali xarid: mijoz QR'i frontendda /users/qr/resolve bilan
  // sifatId ga yechiladi, so'ng shu yerga sifatId + ISBN keladi. Ombor avtomat
  // kamayadi; mijoz keyin ilovada tasdiqlaydi.
  @Post("store-qr-entry")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...STORE_ROLES)
  @ApiOperation({ summary: "Do'kon QR-skan xaridi (operator)" })
  storeQrEntry(
    @CurrentUser("id") authUserId: string,
    @Body() body: { sifatId: string; isbn: string }
  ) {
    return this.svc.storeQrEntry(authUserId, body.sifatId, body.isbn);
  }

  // IDOR-C3 — reader-self confirm: actor from JWT (service check
  // `scan.userId !== userId` now binds to the real caller).
  @Patch("isbn-scan/:id/confirm")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Kitobxon do'kon yozuvini tasdiqlaydi (o'zi uchun)" })
  confirmStorePurchase(
    @Param("id") isbnScanId: string,
    @CurrentUser("id") userId: string
  ) {
    return this.svc.confirmStorePurchase(userId, isbnScanId);
  }
}
