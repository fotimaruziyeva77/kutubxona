import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Res,
  Headers,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { PaymeService } from "./payme.service";
import { ClickService } from "./click.service";
import { InvoiceService } from "./invoice.service";
import { SubscriptionService } from "./subscription.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import {
  IpWhitelistGuard,
  IpWhitelist,
} from "../../common/guards/ip-whitelist.guard";
import { Public } from "../../common/decorators/public.decorator";
import { PaymeRpcRequestDto } from "./dto/payme-webhook.dto";
import { ClickPrepareDto, ClickCompleteDto } from "./dto/click-webhook.dto";
import { SubscriptionStatusUpdateDto } from "./dto/subscription-admin.dto";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { resolveCallerLibraryId } from "../../common/utils/library-scope.util";

// Plan 04-03 audit-fix FIX C (SEC HIGH) — roles that may see global
// subscription / invoice data. KITOBXON, KLUB_RAHBARI, DOKON_OPERATORI etc.
// are NOT in this set and are 403'd by the RolesGuard.
const ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.BUXGALTER,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
] as const;

const FINANCIAL_ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.BUXGALTER,
] as const;

@ApiTags("Payment")
@Controller()
export class PaymentController {
  constructor(
    private readonly payme: PaymeService,
    private readonly click: ClickService,
    private readonly invoiceService: InvoiceService,
    private readonly subscriptionService: SubscriptionService,
    private readonly prisma: PrismaService,
  ) {}

  // Plan 04-03 audit-fix FIX C — ownership helpers used to gate the
  // MUASSASA_ADMIN / KUTUBXONACHI access paths. They resolve the caller's
  // institution-level affiliation server-side from the JWT subject (never
  // trust client-supplied libraryId for ownership decisions).
  //
  // RBAC FIX: resolution now goes through the shared resolveCallerLibraryId
  // util, which uses the CORRECT forward link
  //   User.(schoolId|universityId|organizationId) → Institution.libraryId.
  // The previous code did `library.findFirst({ where: { institutionId } })`,
  // but Library.institutionId is NULL for every row (the reverse link was
  // never populated), so this always returned null → librarians got a
  // 403 "Kutubxona biriktirilmagan" on /subscriptions/library/me.
  private async getCallerLibraryId(userId: string): Promise<string | null> {
    return resolveCallerLibraryId(this.prisma, userId);
  }

  private async assertCallerOwnsLibrary(libraryId: string, userId: string) {
    // RBAC FIX: resolve the caller's OWN library via the correct forward link
    // (Institution.libraryId) and compare ids directly. The previous code
    // compared Library.institutionId against the caller's institutionId, but
    // Library.institutionId is NULL for every row, so a legitimately-linked
    // MUASSASA_ADMIN was always 403'd on trial / renew / invoice ownership.
    const callerLib = await resolveCallerLibraryId(this.prisma, userId);
    if (!callerLib) {
      throw new ForbiddenException("Muassasa biriktirilmagan");
    }
    if (callerLib !== libraryId) {
      throw new ForbiddenException("Bu kutubxonaga ruxsat yo'q");
    }
  }

  private async assertCallerOwnsSubscription(subscriptionId: string, userId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { libraryId: true },
    });
    if (!sub) {
      throw new ForbiddenException("Obuna topilmadi");
    }
    await this.assertCallerOwnsLibrary(sub.libraryId, userId);
  }

  private async assertCallerOwnsInvoice(invoiceId: string, userId: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { subscription: { select: { libraryId: true } } },
    });
    if (!inv) {
      throw new ForbiddenException("Faktura topilmadi");
    }
    await this.assertCallerOwnsLibrary(inv.subscription.libraryId, userId);
  }

  // ── Plan 04-04 audit-fix FIX D (SEC MEDIUM — cross-scope IDOR) ───────────
  //
  // Pre-fix: VILOYAT_ADMIN / TUMAN_ADMIN were allowed on GET /invoices and
  // GET /subscriptions via @Roles(...ADMIN_ROLES), but the service applied
  // NO scope filter. A viloyat admin could list every invoice in the country
  // by hitting GET /invoices (no filter), and a tuman admin could query a
  // sibling tuman's billing by passing ?libraryId=<their-neighbour>.
  //
  // Resolution: look up the caller's tumanId / viloyatId via
  // user.address.{tumanId,viloyatId}. Inject the matching constraint into
  // the where clause before calling the service. If the caller also passes
  // an explicit libraryId, verify the library is inside their scope OR
  // throw ForbiddenException.
  //
  // SUPER_ADMIN and BUXGALTER bypass — they have global financial scope.
  private async getCallerScope(
    userId: string,
    role?: UserRole,
  ): Promise<{ viloyatId: string | null; tumanId: string | null }> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    const scope = {
      viloyatId: u?.address?.viloyatId ?? null,
      tumanId: u?.address?.tumanId ?? null,
    };
    // Plan 04-04-fix audit FIX D follow-up — fail-CLOSED for tier admins with
    // missing scope. A VILOYAT_ADMIN / TUMAN_ADMIN whose User.address row is
    // null (misconfigured account or deleted address) would otherwise see
    // global financial data via the scope-filter falling through. Refuse.
    if (
      (role === UserRole.VILOYAT_ADMIN && !scope.viloyatId) ||
      (role === UserRole.TUMAN_ADMIN && !scope.tumanId)
    ) {
      throw new ForbiddenException(
        "Hudud aniqlanmagan — administrator manzilini sozlang",
      );
    }
    return scope;
  }

  private async assertLibraryInScope(
    libraryId: string,
    role: UserRole,
    callerScope: { viloyatId: string | null; tumanId: string | null },
  ): Promise<void> {
    if (
      role === UserRole.SUPER_ADMIN ||
      role === UserRole.BUXGALTER
    ) {
      return; // global scope
    }
    const lib = await this.prisma.library.findUnique({
      where: { id: libraryId },
      select: { viloyatId: true, tumanId: true },
    });
    if (!lib) {
      throw new ForbiddenException("Kutubxona topilmadi");
    }
    if (role === UserRole.VILOYAT_ADMIN) {
      if (!callerScope.viloyatId || lib.viloyatId !== callerScope.viloyatId) {
        throw new ForbiddenException("Kutubxona viloyat doirasidan tashqarida");
      }
      return;
    }
    if (role === UserRole.TUMAN_ADMIN) {
      if (!callerScope.tumanId || lib.tumanId !== callerScope.tumanId) {
        throw new ForbiddenException("Kutubxona tuman doirasidan tashqarida");
      }
      return;
    }
  }

  // ── Payme Webhook (ochiq — Payme serveri chaqiradi) ──────────────────────
  // Plan 04-02 PAY-01: IpWhitelistGuard + typed DTO body. @Public() bypasses
  // JWT — the IP whitelist + Basic-Auth (Payme spec) + idempotency form the
  // security perimeter.

  @Public()
  @UseGuards(IpWhitelistGuard)
  @IpWhitelist("PAYME_IP_WHITELIST")
  @Post("payment/payme/webhook")
  @ApiOperation({ summary: "Payme webhook (JSON-RPC 2.0)" })
  paymeWebhook(
    @Headers("Authorization") auth: string,
    @Body() body: PaymeRpcRequestDto,
  ) {
    return this.payme.handleWebhook(auth, body);
  }

  // ── Click Webhooks (ochiq — Click serveri chaqiradi) ─────────────────────
  // Plan 04-02 PAY-02: IpWhitelistGuard + typed DTO bodies.

  @Public()
  @UseGuards(IpWhitelistGuard)
  @IpWhitelist("CLICK_IP_WHITELIST")
  @Post("payment/click/prepare")
  @ApiOperation({ summary: "Click Prepare" })
  clickPrepare(@Body() body: ClickPrepareDto) {
    return this.click.prepare(body);
  }

  @Public()
  @UseGuards(IpWhitelistGuard)
  @IpWhitelist("CLICK_IP_WHITELIST")
  @Post("payment/click/complete")
  @ApiOperation({ summary: "Click Complete" })
  clickComplete(@Body() body: ClickCompleteDto) {
    return this.click.complete(body);
  }

  // ── Invoices (Buxgalter + Admin) ──────────────────────────────────────────
  //
  // Plan 04-03 audit-fix FIX C (SEC HIGH) — every invoice route is now gated:
  //   - GET /invoices: admin-only (financial scope).
  //   - GET /invoices/:id, /pdf: admin OR owner of the library.
  //   - GET /invoices/stats, /export/csv: financial admin (BUXGALTER / SUPER_ADMIN).

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get("invoices")
  @ApiOperation({ summary: "Fakturalar ro'yhati" })
  async getInvoices(
    @CurrentUser() user: JwtPayload,
    @Query("libraryId") libraryId?: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    // Plan 04-04 audit-fix FIX D (SEC MEDIUM — cross-scope IDOR).
    // VILOYAT_ADMIN / TUMAN_ADMIN must be scope-restricted; SUPER_ADMIN /
    // BUXGALTER pass through with no filter (global financial scope).
    const role = user.role as UserRole;
    const isTierAdmin =
      role === UserRole.VILOYAT_ADMIN || role === UserRole.TUMAN_ADMIN;
    if (isTierAdmin) {
      const scope = await this.getCallerScope(user.sub, role);
      // If caller passed an explicit libraryId, verify it's inside their
      // scope BEFORE the service runs. Defence: prevents an explicit out-of-
      // scope libraryId from succeeding even though the where filter would
      // also constrain it.
      if (libraryId) {
        await this.assertLibraryInScope(libraryId, role, scope);
      }
      // Inject scope filter into where via the service options. We piggy-
      // back on libraryId-or-scope by hand: the service builds its own where
      // clause, so we expose the scope via a synthetic property passed
      // through. Cleanest path is to call the service with the standard
      // filters PLUS the scope marker on a fresh helper.
      return this.invoiceService.getInvoices({
        libraryId,
        status,
        from,
        to,
        page,
        limit,
        scopeViloyatId:
          role === UserRole.VILOYAT_ADMIN ? scope.viloyatId : undefined,
        scopeTumanId:
          role === UserRole.TUMAN_ADMIN ? scope.tumanId : undefined,
      } as any);
    }
    return this.invoiceService.getInvoices({ libraryId, status, from, to, page, limit });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...FINANCIAL_ADMIN_ROLES)
  @Get("invoices/stats")
  @ApiOperation({ summary: "To'lov statistikasi (buxgalter)" })
  getPaymentStats(@Query("from") from?: string, @Query("to") to?: string) {
    return this.invoiceService.getPaymentStats(from, to);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("invoices/:id")
  async getInvoice(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    // Admin: any invoice. MUASSASA_ADMIN / KUTUBXONACHI: only their library.
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.BUXGALTER
    ) {
      await this.assertCallerOwnsInvoice(id, user.sub);
    }
    return this.invoiceService.getInvoice(id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("invoices/:id/pdf")
  @ApiOperation({ summary: "Faktura PDF yuklab olish" })
  async downloadInvoicePdf(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.BUXGALTER
    ) {
      await this.assertCallerOwnsInvoice(id, user.sub);
    }
    const pdfBuffer = await this.invoiceService.generateInvoicePdf(id);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="faktura-${id.slice(-8)}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...FINANCIAL_ADMIN_ROLES)
  @Get("invoices/export/csv")
  @ApiOperation({ summary: "To'lovlar CSV eksport (oddiy, Excel uchun)" })
  async exportCsv(
    @Query("from") from: string,
    @Query("to") to: string,
    @Res() res: Response,
  ) {
    const { csv, filename } = await this.invoiceService.exportToExcel(from, to);
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    res.end("﻿" + csv); // BOM for Excel
  }

  // ── Plan 04-04 RPT-03 — real XLSX export endpoint ──────────────────────
  //
  // Replaces the pre-04-04 CSV-mislabeled-as-Excel button. Buxgalter operators
  // now download a real .xlsx workbook (exceljs) with numeric Summa column,
  // bold header, and column widths tuned for Buxgalter day-to-day workflow.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...FINANCIAL_ADMIN_ROLES)
  @Get("invoices/export/xlsx")
  @ApiOperation({ summary: "To'lovlar Excel (.xlsx) eksport (Buxgalter)" })
  async exportXlsx(
    @Query("from") from: string,
    @Query("to") to: string,
    @Res() res: Response,
  ) {
    const buf = await this.invoiceService.exportToXlsx(from, to);
    const fromTag = from ?? "boshidan";
    const toTag = to ?? "hozirgacha";
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="payments-${fromTag}-${toTag}.xlsx"`,
      "Content-Length": buf.length,
    });
    res.end(buf);
  }

  // ── Plan 04-04 RPT-03 — 1C-Bukhgalteriya CSV export endpoint ────────────
  //
  // Per OQ-3 user decision — semicolon-CSV with 11 standardized columns; bank
  // columns blank per OQ-4 (Library schema lacks bank fields today, Phase 5
  // migration). UTF-8 BOM + CRLF for cross-platform import.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...FINANCIAL_ADMIN_ROLES)
  @Get("invoices/export/1c")
  @ApiOperation({ summary: "To'lovlar 1C-Bukhgalteriya CSV eksport" })
  async export1c(
    @Query("from") from: string,
    @Query("to") to: string,
    @Res() res: Response,
  ) {
    const csv = await this.invoiceService.exportTo1C(from, to);
    const fromTag = from ?? "boshidan";
    const toTag = to ?? "hozirgacha";
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payments-1c-${fromTag}-${toTag}.csv"`,
    });
    res.end(csv);
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────
  //
  // Plan 04-03 audit-fix FIX C (SEC HIGH) — admin/owner gating applied below.

  // Trial: financial admin OR MUASSASA_ADMIN of the target library.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER, UserRole.MUASSASA_ADMIN)
  @Post("subscriptions/trial")
  @ApiOperation({ summary: "Trial boshlash (kutubxona qo'shilganda)" })
  async createTrial(
    @Body() body: { libraryId: string; planType: string },
    @CurrentUser() user: JwtPayload,
  ) {
    if (user.role === UserRole.MUASSASA_ADMIN) {
      await this.assertCallerOwnsLibrary(body.libraryId, user.sub);
    }
    return this.subscriptionService.createTrial(body.libraryId, body.planType);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ADMIN_ROLES)
  @Get("subscriptions")
  async getAllSubscriptions(
    @CurrentUser() user: JwtPayload,
    @Query("status") status?: string,
    @Query("planType") planType?: string,
    @Query("libraryId") libraryId?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    // Plan 04-04 audit-fix FIX D (SEC MEDIUM — cross-scope IDOR).
    const role = user.role as UserRole;
    const isTierAdmin =
      role === UserRole.VILOYAT_ADMIN || role === UserRole.TUMAN_ADMIN;
    if (isTierAdmin) {
      const scope = await this.getCallerScope(user.sub, role);
      if (libraryId) {
        await this.assertLibraryInScope(libraryId, role, scope);
      }
      return this.subscriptionService.getAllSubscriptions({
        status,
        planType,
        page,
        limit,
        scopeViloyatId:
          role === UserRole.VILOYAT_ADMIN ? scope.viloyatId : undefined,
        scopeTumanId:
          role === UserRole.TUMAN_ADMIN ? scope.tumanId : undefined,
      } as any);
    }
    return this.subscriptionService.getAllSubscriptions({ status, planType, page, limit });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...FINANCIAL_ADMIN_ROLES)
  @Get("subscriptions/stats")
  getSubscriptionStats() {
    return this.subscriptionService.getStats();
  }

  // Tariflar katalogi (narx + nom) — har bir tashkilot o'z tarifini va boshqa
  // tariflarni ko'rishi uchun. Har qanday autentifikatsiyalangan foydalanuvchi.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("subscriptions/plans")
  @ApiOperation({ summary: "Tariflar ro'yxati (narx + nom)" })
  listPlans() {
    return this.subscriptionService.listPlans();
  }

  // Plan 04-03 audit-fix FIX C — /me endpoint: resolves the caller's own
  // library subscription server-side. Frontend pages prefer this over
  // /library/:libraryId so they never need to read libraryId from JWT and
  // pass it back. Closes a class of "I copied my colleague's libraryId out
  // of localStorage" probes.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("subscriptions/library/me")
  @ApiOperation({ summary: "Joriy foydalanuvchi kutubxonasi obunasi" })
  async getMyLibrarySubscription(@CurrentUser() user: JwtPayload) {
    const callerLib = await this.getCallerLibraryId(user.sub);
    if (!callerLib) {
      throw new ForbiddenException("Kutubxona biriktirilmagan");
    }
    return this.subscriptionService.getSubscription(callerLib);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("subscriptions/library/:libraryId")
  async getLibrarySubscription(
    @Param("libraryId") libraryId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    // Admin → any library. Otherwise must be the caller's own library.
    const isAdmin =
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.BUXGALTER ||
      user.role === UserRole.VILOYAT_ADMIN ||
      user.role === UserRole.TUMAN_ADMIN;
    if (!isAdmin) {
      await this.assertCallerOwnsLibrary(libraryId, user.sub);
    }
    return this.subscriptionService.getSubscription(libraryId);
  }

  // Plan 04-03 audit-fix FIX B / FIX C (SEC HIGH) — renewSubscription gated.
  // SUPER_ADMIN / BUXGALTER can renew any subscription. MUASSASA_ADMIN can
  // only renew their own library's subscription — the service checks the
  // ownership against req.user.libraryId before mutating. Pre-fix this endpoint
  // ran under JwtAuthGuard alone — any authenticated KITOBXON could POST a
  // renew for any library, forcing free-plan reactivation or spamming invoice
  // creation on paid plans.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER, UserRole.MUASSASA_ADMIN)
  @Post("subscriptions/:id/renew")
  @ApiOperation({ summary: "Subscription yangilash (faktura yaratish)" })
  async renewSubscription(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("provider") provider?: string,
  ) {
    if (user.role === UserRole.MUASSASA_ADMIN) {
      await this.assertCallerOwnsSubscription(id, user.sub);
    }
    // To'lov usuli: karta (PAYME/CLICK) → checkout URL, bank → faqat faktura.
    const method =
      provider === "PAYME" || provider === "CLICK" || provider === "BANK_TRANSFER"
        ? provider
        : undefined;
    return this.subscriptionService.renewSubscription(id, method);
  }

  // Obuna shartnomasi (PDF) — bank o'tkazma orqali to'lovchilar uchun.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get("subscriptions/:id/contract")
  @ApiOperation({ summary: "Obuna shartnomasi (PDF) yuklab olish" })
  async downloadContractPdf(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.BUXGALTER
    ) {
      await this.assertCallerOwnsSubscription(id, user.sub);
    }
    const pdfBuffer = await this.invoiceService.generateContractPdf(id);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="shartnoma-${id.slice(-8)}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  // Plan 04-03 PAY-06 / PAY-08: admin-only state transitions. RolesGuard
  // rejects non-admin tokens before the service runs; the service-level
  // validator (assertSubscriptionTransition) is the second line of defense
  // and additionally enforces non-empty reason for FROZEN / DELETED. The
  // actor id is taken from the JWT payload (sub) — not from the request
  // body — so an admin cannot impersonate another admin in the audit log.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
  @Patch("subscriptions/:id/status")
  @ApiOperation({ summary: "Subscription holatini o'zgartirish (admin)" })
  updateStatus(
    @Param("id") id: string,
    @Body() body: SubscriptionStatusUpdateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.subscriptionService.updateStatus(
      id,
      body.status,
      body.reason,
      user.sub,
      user.role as UserRole,
    );
  }
}
