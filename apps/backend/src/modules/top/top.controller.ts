import { Body, Controller, Get, Post, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { UserGender, UserRole, UserType } from "@prisma/client";
import { TopService } from "./top.service";
import { InstitutionalService } from "./institutional.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("top")
@ApiBearerAuth()
@Controller("top")
export class TopController {
  constructor(
    private readonly svc: TopService,
    private readonly institutional: InstitutionalService,
  ) {}

  // ── Ochiq endpointlar (auth kerak emas — @Public, INFRA-03) ──────────────

  @Public()
  @Get()
  @ApiOperation({ summary: "Top-100 ro'yhati (filter: month, gender, ageGroup, userType)" })
  getTop100(
    @Query("month") month?: string,
    @Query("gender") gender?: UserGender,
    @Query("ageGroup") ageGroup?: "7-14" | "15-30" | "31-60" | "60+",
    @Query("userType") userType?: UserType,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.svc.getTop100({
      month,
      gender,
      ageGroup,
      userType,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });
  }

  @Public()
  @Get("months")
  @ApiOperation({ summary: "Tasdiqlangan oylar ro'yhati" })
  getAvailableMonths() {
    return this.svc.getAvailableMonths();
  }

  @Public()
  @Get("regional/:type")
  @ApiOperation({ summary: "Hududiy reyting (tuman yoki viloyat bo'yicha)" })
  getRegional(@Param("type") type: "tuman" | "viloyat") {
    return this.svc.getRegionalRanking(type);
  }

  // ── Plan 03-03 TOP-05: institutional rankings (maktab/otm/idora/hudud) ───
  @Public()
  @Get("institutional/:type")
  @ApiOperation({
    summary: "Muassasa reytingi (maktab/otm/idora/viloyat/tuman/mahalla)",
  })
  getInstitutional(
    @Param("type")
    type: "maktab" | "otm" | "idora" | "viloyat" | "tuman" | "mahalla",
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("month") month?: string,
  ) {
    return this.institutional.getInstitutionalRanking(
      type,
      {
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
        month,
      },
      this.svc,
    );
  }

  // ── Himoyalangan (faqat Super Admin) ─────────────────────────────────────

  @Get("draft")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: joriy oy DRAFT Top-100 ni ko'rish" })
  getDraft(@Query("month") month?: string) {
    return this.svc.getDraftMonth(month);
  }

  // Plan 03-04 TOP-07: /dashboard/top-review queue endpoint.
  // Returns all non-CONFIRMED entries (DRAFT/FRAUD_CHECKED/READY_FOR_PUBLISH/
  // FLAGGED/REJECTED) — separate from `/draft` which is the legacy DRAFT-only
  // view. Used by the admin Top-100 review UI.
  @Get("admin/review-queue")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: "Admin: Top-100 review queue (DRAFT/FRAUD_CHECKED/READY/FLAGGED/REJECTED)",
  })
  getAdminReviewQueue(@Query("month") month?: string) {
    return this.svc.getAdminReviewQueue(month);
  }

  @Post("compute")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: Top-100 ni qo'lda hisoblash (cron trigger)" })
  compute() {
    return this.svc.computeMonthlyTop100();
  }

  @Post(":month/confirm")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: oyni tasdiqlash (DRAFT → CONFIRMED)" })
  confirm(@Param("month") month: string) {
    return this.svc.confirmMonth(month);
  }

  // ── Plan 03-02: admin overrides during 30→1 review window ────────────────
  // Per T-03-02-E (Elevation of Privilege): SUPER_ADMIN only. Tuman-scope
  // override deferred to v2 per Plan 03-02 deferral. All four methods run
  // inside $transaction in the service layer.

  @Post(":month/flag/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: Top-100 yozuvini FLAGGED qilish (sabab bilan)" })
  flag(
    @Param("month") month: string,
    @Param("userId") userId: string,
    @Body() body: { reason?: string },
  ) {
    return this.svc.flagUser(month, userId, body?.reason);
  }

  @Post(":month/clear/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: FLAGGED ni bekor qilish (FLAGGED → FRAUD_CHECKED)" })
  clearFlag(@Param("month") month: string, @Param("userId") userId: string) {
    return this.svc.clearFlag(month, userId);
  }

  @Post(":month/reject/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: Top-100 yozuvini doimiy rad etish" })
  reject(@Param("month") month: string, @Param("userId") userId: string) {
    return this.svc.rejectEntry(month, userId);
  }

  @Post(":month/confirm/:userId")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Admin: bitta yozuvni qo'lda CONFIRMED qilish" })
  confirmOne(@Param("month") month: string, @Param("userId") userId: string) {
    return this.svc.confirmEntry(month, userId);
  }
}
