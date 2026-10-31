import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Request,
  BadRequestException
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { AiService } from "./ai.service";
import { FraudService } from "./fraud.service";
import { RecommendService } from "./recommend.service";
import { PredictService } from "./predict.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";

const ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
];

@ApiTags("ai")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("ai")
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly fraudService: FraudService,
    private readonly recommendService: RecommendService,
    private readonly predictService: PredictService,
    private readonly prisma: PrismaService
  ) {}

  // ── NL Interface ──────────────────────────────────────────────────────────

  @Post("query")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "O'zbek tilida savol — AI javob + grafik ma'lumotlar" })
  query(
    @Body() body: { question: string },
    // JWT payload `{ sub, phone, role }` — `id` maydoni YO'Q. Eski `req.user?.id`
    // doim undefined edi: NLQ caller-identity (cache scoping, top_readers
    // hududiy filtr) ishlamasdi. nlq.service rol+doirani DB dan o'zi aniqlaydi.
    @Request() req: { user: { sub: string } }
  ) {
    return this.aiService.query(body.question, req.user?.sub);
  }

  @Get("query/history")
  @ApiOperation({ summary: "Savollar tarixi" })
  getNlqHistory(@Request() req: { user: { sub: string } }) {
    return this.aiService.getNlqHistory(req.user.sub);
  }

  // ── Fraud Detection ───────────────────────────────────────────────────────

  @Get("fraud/stats")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Fraud statistikasi (risk darajalar bo'yicha)" })
  getFraudStats() {
    return this.aiService.getFraudStats();
  }

  @Get("fraud/list")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Yuqori risk foydalanuvchilar ro'yhati" })
  @ApiQuery({ name: "minRisk", required: false })
  @ApiQuery({ name: "limit", required: false })
  getFraudList(
    @Query("minRisk") minRisk?: string,
    @Query("limit") limit?: string
  ) {
    return this.aiService.getFraudList(
      minRisk ? Number(minRisk) : 50,
      limit ? Number(limit) : 50
    );
  }

  @Post("fraud/analyze/:userId")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Foydalanuvchini fraud tahlili" })
  analyzeUserFraud(@Param("userId") userId: string) {
    return this.aiService.analyzeUserFraud(userId);
  }

  @Post("fraud/top100-check")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Top-100 da'vogarlarini AI fraud tekshiruvi" })
  checkTop100Fraud() {
    return this.aiService.checkTop100Fraud();
  }

  // ── FRAUD-03 (Plan 02-04): admin review queue ──────────────────────────────
  // Replaces the dailyFraudScan auto-block (now removed). Admins (scoped by
  // tier) decide approve/reject for each FLAGGED user.

  @Get("fraud/review-queue")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "FraudScore review navbati (admin tier scoping)" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  async getFraudReviewQueue(
    @Request() req: { user: { sub: string; role: string } },
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const tier = req.user.role as
      | "SUPER_ADMIN"
      | "VILOYAT_ADMIN"
      | "TUMAN_ADMIN"
      | "MUASSASA_ADMIN";

    // Look up the admin's address for tier-scoping. SUPER_ADMIN doesn't
    // need this — service-layer skips scoping when scopeId is undefined.
    let scopeId: string | undefined;
    if (tier === "TUMAN_ADMIN" || tier === "VILOYAT_ADMIN") {
      const admin = await this.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { address: { select: { tumanId: true, viloyatId: true } } },
      });
      scopeId =
        tier === "TUMAN_ADMIN"
          ? admin?.address?.tumanId
          : admin?.address?.viloyatId;
    }

    return this.fraudService.getReviewQueue({
      tier,
      scopeId,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
  }

  @Post("fraud/:userId/resolve")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "FraudScore reviewni hal qilish (approve | reject)" })
  resolveFraudReview(
    @Request() req: { user: { sub: string } },
    @Param("userId") userId: string,
    @Body() body: { decision: "approve" | "reject"; notes?: string }
  ) {
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new BadRequestException("decision must be 'approve' or 'reject'");
    }
    return this.fraudService.resolveReview(
      req.user.sub,
      userId,
      body.decision,
      body.notes
    );
  }

  // ── Audit Engine ──────────────────────────────────────────────────────────

  @Get("audit-logs")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "AI audit loglari ro'yhati" })
  @ApiQuery({ name: "scope", required: false })
  @ApiQuery({ name: "severity", required: false })
  @ApiQuery({ name: "resolved", required: false })
  @ApiQuery({ name: "limit", required: false })
  getAuditLogs(
    @Query("scope") scope?: string,
    @Query("severity") severity?: string,
    @Query("resolved") resolved?: string,
    @Query("limit") limit?: string
  ) {
    return this.aiService.getAuditLogs({
      scope,
      severity,
      resolved: resolved !== undefined ? resolved === "true" : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post("audit-logs")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Yangi audit log yaratish (admin)" })
  createAuditLog(@Body() body: Parameters<AiService["createAuditLog"]>[0]) {
    return this.aiService.createAuditLog(body);
  }

  @Patch("audit-logs/:id/resolve")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Audit logni yechilgan deb belgilash" })
  resolveAuditLog(@Param("id") id: string) {
    return this.aiService.resolveAuditLog(id);
  }

  // ── Predictive Analytics ──────────────────────────────────────────────────

  // Specific routes MUST come before generic :scopeType/:scopeId to avoid
  // NestJS matching "tuman", "fund", "national-goal" as scopeType params.

  @Get("predict/national-goal")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Milliy yillik maqsad erishish bashorati" })
  nationalGoalForecast() {
    return this.predictService.nationalGoalForecast();
  }

  @Get("predict/tuman/:tumanId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Tuman RI bashorati (1-3 oylik)" })
  @ApiQuery({ name: "months", required: false })
  predictTumanRi(
    @Param("tumanId") tumanId: string,
    @Query("months") months?: string
  ) {
    return this.predictService.predictTumanRi(tumanId, months ? Number(months) : 1);
  }

  @Get("predict/fund/:libraryId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Kutubxona fond yetishmovchiligi bashorati" })
  predictFundShortage(@Param("libraryId") libraryId: string) {
    return this.predictService.predictFundShortage(libraryId);
  }

  // Generic scope-based endpoints (AI-05)
  @Get("predict/:scopeType/:scopeId/causes")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Scope bo'yicha Root Cause Analysis" })
  @ApiQuery({ name: "issue", required: false, enum: ["RI_DROP", "LOW_COVERAGE", "INACTIVE_LIBRARY"] })
  predictScopeCauses(
    @Param("scopeType") scopeType: string,
    @Param("scopeId") scopeId: string,
    @Query("issue") issue: "RI_DROP" | "LOW_COVERAGE" | "INACTIVE_LIBRARY" = "RI_DROP"
  ) {
    return this.predictService.analyzeRootCause(scopeId, issue);
  }

  @Get("predict/:scopeType/:scopeId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Scope bo'yicha RI bashorati (1 oylik, linear regression)" })
  @ApiQuery({ name: "months", required: false })
  predictScopeRi(
    @Param("scopeType") scopeType: string,
    @Param("scopeId") scopeId: string,
    @Query("months") months?: string
  ) {
    return this.predictService.predictTumanRi(scopeId, months ? Number(months) : 1);
  }

  @Get("root-cause/:tumanId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Tuman muammosi sabab tahlili (Root Cause Analysis)" })
  @ApiQuery({ name: "issue", required: false, enum: ["RI_DROP", "LOW_COVERAGE", "INACTIVE_LIBRARY"] })
  analyzeRootCause(
    @Param("tumanId") tumanId: string,
    @Query("issue") issue: "RI_DROP" | "LOW_COVERAGE" | "INACTIVE_LIBRARY" = "RI_DROP"
  ) {
    return this.predictService.analyzeRootCause(tumanId, issue);
  }

  // ── Book Recommendations ──────────────────────────────────────────────────

  @Get("recommendations")
  @ApiOperation({ summary: "Foydalanuvchiga shaxsiy kitob tavsiyalari" })
  @ApiQuery({ name: "limit", required: false })
  getMyRecommendations(
    @Request() req: { user: { sub: string } },
    @Query("limit") limit?: string
  ) {
    return this.recommendService.getRecommendations(req.user.sub, limit ? Number(limit) : 5);
  }

  @Get("recommendations/:userId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Admin: foydalanuvchi uchun kitob tavsiyalari" })
  @ApiQuery({ name: "limit", required: false })
  getRecommendationsForUser(
    @Param("userId") userId: string,
    @Query("limit") limit?: string
  ) {
    return this.recommendService.getRecommendations(userId, limit ? Number(limit) : 5);
  }

  // Boshqa foydalanuvchining tavsiyalari = uning o'qish tarixi haqida ma'lumot
  // (R5 maxfiylik). Avval @Roles'siz edi — har qanday kitobxon istalgan userId
  // uchun so'ray olardi; frontend bu route'ni ishlatmaydi (2026-10-31, T6 auditi).
  @Get("recommend/user/:userId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Foydalanuvchi uchun kitob tavsiyalari (5 ta)" })
  @ApiQuery({ name: "limit", required: false })
  getRecommendations(
    @Param("userId") userId: string,
    @Query("limit") limit?: string
  ) {
    return this.recommendService.getRecommendations(userId, limit ? Number(limit) : 5);
  }

  @Get("recommend/club/:clubId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES, UserRole.KLUB_RAHBARI)
  @ApiOperation({ summary: "Klub debati uchun kitob tavsiyalari" })
  getClubRecommendations(
    @Param("clubId") clubId: string,
    @Query("limit") limit?: string
  ) {
    return this.recommendService.getClubRecommendations(clubId, limit ? Number(limit) : 5);
  }

  // ── Hisobotlar ────────────────────────────────────────────────────────────

  @Get("report/library/:libraryId")
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: "Kutubxona oylik AI hisoboti (HTML + tahlil)" })
  generateReport(@Param("libraryId") libraryId: string) {
    return this.aiService.generateAiReport(libraryId);
  }

  // ── Model Monitoring ──────────────────────────────────────────────────────

  @Get("monitoring")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "AI model monitoring dashboard" })
  getModelMonitoring() {
    return this.aiService.getModelMonitoring();
  }
}
