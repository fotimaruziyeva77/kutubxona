import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  UseGuards,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PaymentMethod, UserRole } from "@prisma/client";
import {
  DonateService,
  PaymeDonateWebhookBody,
  ClickDonateWebhookBody,
} from "./donate.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import {
  IpWhitelistGuard,
  IpWhitelist,
} from "../../common/guards/ip-whitelist.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("donate")
@ApiBearerAuth()
@Controller("donate")
export class DonateController {
  constructor(
    private readonly svc: DonateService,
    // SEC FIX M11 — verify optional bearer tokens on the public initiate
    // endpoint instead of trusting a client-supplied userId.
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * SEC FIX M11 — resolve the donor's userId from a VERIFIED bearer token.
   * - No Authorization header (or non-Bearer) → anonymous (null).
   * - Bearer present but invalid/expired → 401 (explicit failure beats a
   *   silent anonymous donation the user believes is attributed to them).
   * - Valid → payload.sub (same verification as JwtAuthGuard).
   */
  private resolveOptionalUserId(authHeader?: string): string | null {
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);
    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get<string>("JWT_SECRET"),
      });
      return typeof payload?.sub === "string" && payload.sub.length > 0
        ? payload.sub
        : null;
    } catch {
      throw new UnauthorizedException("Token noto'g'ri yoki muddati o'tgan");
    }
  }

  // ── Ochiq endpointlar (auth kerak emas — @Public, INFRA-03) ───────────────

  @Public()
  @Get("stats")
  @ApiOperation({ summary: "Donat statistikasi: jami, sarflangan, qolgan" })
  getStats() {
    return this.svc.getStats();
  }

  @Public()
  @Get("donors")
  @ApiOperation({ summary: "Ochiq donatchilar ro'yhati (so'nggi 50)" })
  getPublicDonors(@Query("limit") limit?: string) {
    return this.svc.getPublicDonors(limit ? parseInt(limit) : 50);
  }

  @Public()
  @Get("top-donors")
  @ApiOperation({ summary: "Top-50 donatchilar (jami miqdor bo'yicha)" })
  getTopDonors(@Query("limit") limit?: string) {
    return this.svc.getTopDonors(limit ? parseInt(limit) : 50);
  }

  // ── DONAT-02: sarflanish tarixi (jamoatchilik uchun shaffoflik) ──────────
  @Public()
  @Get("spending")
  @ApiOperation({ summary: "DONAT-02: sarflangan donatlar tarixi (ochiq)" })
  getSpending(@Query("limit") limit?: string) {
    return this.svc.getSpendingHistory(limit ? parseInt(limit) : 20);
  }

  // Anonim ham donat qilishi mumkin — auth ixtiyoriy.
  // SEC FIX M11 — body.userId OLIB TASHLANDI: pre-fix the @Public endpoint
  // accepted a client-supplied userId, letting anyone attribute donations to
  // arbitrary users (poisoning Top-50 donor rankings + badge awards). The
  // donor identity now comes ONLY from a verified JWT bearer token.
  @Public()
  @Post("initiate")
  @ApiOperation({ summary: "Donat boshlash (to'lov URL olish, anonim ham bo'lishi mumkin)" })
  initiate(
    @Body()
    body: {
      amount: number;
      purpose: "LIBRARY_BOOKS" | "SCHOOL_BOOKS" | "GENERAL";
      targetId?: string;
      targetName?: string;
      method: PaymentMethod;
      donorName?: string;
      isPublic?: boolean;
    },
    @Headers("authorization") authHeader?: string,
  ) {
    const userId = this.resolveOptionalUserId(authHeader);
    return this.svc.initiateDonation({
      amount: body.amount,
      purpose: body.purpose,
      targetId: body.targetId,
      targetName: body.targetName,
      method: body.method,
      donorName: body.donorName,
      isPublic: body.isPublic,
      userId: userId ?? undefined,
    });
  }

  // ── Webhook endpointlar (to'lov provayderidan) ────────────────────────────
  // DONAT-01: Plan 03-01 IpWhitelistGuard rejects non-whitelisted IPs.
  // DONAT-01: handlePaymentWebhook wraps in cache.remember for 7-day idempotency.
  // SEC FIX C2: @Public() bypasses JWT, but the service entry points now do
  // REAL provider verification — Payme Basic auth (timingSafeEqual against the
  // merchant key) and Click md5 sign_string (+ sign_time freshness). Success
  // derives ONLY from verified provider semantics, never from raw body flags.

  @Public()
  @UseGuards(IpWhitelistGuard)
  @IpWhitelist("PAYME_IP_WHITELIST")
  @Post("webhook/payme")
  @ApiOperation({ summary: "Payme to'lov callback (Basic auth + IP whitelist + idempotency)" })
  paymeWebhook(
    @Body() body: PaymeDonateWebhookBody,
    @Headers("authorization") authHeader?: string,
  ) {
    return this.svc.handlePaymeCallback(authHeader, body);
  }

  @Public()
  @UseGuards(IpWhitelistGuard)
  @IpWhitelist("CLICK_IP_WHITELIST")
  @Post("webhook/click")
  @ApiOperation({ summary: "Click to'lov callback (md5 imzo + IP whitelist + idempotency)" })
  clickWebhook(@Body() body: ClickDonateWebhookBody) {
    return this.svc.handleClickCallback(body);
  }

  // ── Admin endpointlar ─────────────────────────────────────────────────────

  // DONAT-03: SUPER_ADMIN + BUXGALTER moliyaviy hisobotni ko'rishi mumkin.
  @Get("admin/breakdown")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
  @ApiOperation({ summary: "DONAT-03: admin uchun donat breakdown (target+purpose)" })
  getAdminBreakdown() {
    return this.svc.getAdminBreakdown();
  }

  @Patch(":id/spend")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: donatni sarflash qayd etish" })
  recordSpending(
    @Param("id") id: string,
    @Body() body: { targetId: string; targetName: string }
  ) {
    return this.svc.recordSpending(id, body.targetId, body.targetName);
  }
}
