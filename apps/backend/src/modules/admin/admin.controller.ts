import {
  BadRequestException,
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  Optional,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import type { Response } from "express";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { AdminService } from "./admin.service";
import { OrderRequestDto } from "./dto/order-request.dto";
import { TestPushDto } from "./dto/test-push.dto";
import { RejectUserDto } from "./dto/reject-user.dto";
import {
  CreateDemoRequestDto,
  UpdateDemoRequestDto,
} from "./dto/demo-request.dto";
import { ReportDataService, ReportScope } from "./report-data.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import {
  assertViloyatInScope,
  assertTumanInScope,
} from "../../common/utils/admin-scope.util";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";

type CallerScope = {
  role: UserRole | string;
  address: { viloyatId: string | null; tumanId: string | null };
};

const ALL_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN
] as const;

const REGION_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN
] as const;

@ApiTags("admin")
@ApiBearerAuth()
@Controller("admin")
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly pdfService: PdfService,
    private readonly prisma: PrismaService,
    // Plan 05-04 Task 3 (NOTIF-02) — POST /admin/test-push enqueues a push
    // job for QA / ALERT-06 system-down verification. NOTIFICATION_QUEUE is
    // re-exported via QueueModule which AdminModule already imports indirectly
    // (BullModule.registerQueue + global config from AppInfraModule).
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
    // Plan 05-05 T3 — ConfigService for ADMIN_SMS_RECIPIENTS env CSV.
    // Optional so existing 4-arg unit tests still construct AdminController.
    @Optional() private readonly config?: ConfigService,
    // Plan 05-08 T2 (RPT-01 endpoint) — ReportDataService composes the
    // scope-parameterized PDF data shape. Optional so older unit tests with
    // 4/5-arg constructor signatures still compile.
    @Optional() private readonly reportData?: ReportDataService,
  ) {}

  // Plan 05-02 Task 1 (OQ-6 Q6) — Resolves the caller's geo scope from their
  // address row. Mirrors PaymentController.getCallerScope (Plan 04-04-fix
  // FIX D). Used by the stats endpoints to pass an enriched user into the
  // service-layer assertViloyatInScope / assertTumanInScope helpers.
  private async resolveCallerScope(payload: JwtPayload): Promise<CallerScope> {
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        role: true,
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    return {
      role: u?.role ?? (payload.role as UserRole),
      address: {
        viloyatId: u?.address?.viloyatId ?? null,
        tumanId: u?.address?.tumanId ?? null,
      },
    };
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  @Get("stats")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMINS)
  @ApiOperation({ summary: "Dashboard statistikasi" })
  getStats() {
    return this.adminService.getDashboardStats();
  }

  // ── Foydalanuvchilar ───────────────────────────────────────────────────────

  @Get("users/pending")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Tasdiqlash kutayotgan foydalanuvchilar" })
  getPendingUsers() {
    return this.adminService.getPendingUsers();
  }

  @Patch("users/:id/approve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Foydalanuvchini tasdiqlash → ACTIVE" })
  approveUser(@Param("id") id: string) {
    return this.adminService.approveUser(id);
  }

  @Patch("users/:id/reject")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Foydalanuvchini rad etish → BLOCKED (sabab bilan)" })
  rejectUser(@Param("id") id: string, @Body() body?: RejectUserDto) {
    // AdminService.rejectUser allaqachon `reason` ni qabul qilib SMS matniga
    // qo'shardi, lekin controller uni HECH QACHON uzatmagan — natijada rad
    // etilgan foydalanuvchi doim umumiy "batafsil ma'lumot uchun murojaat
    // qiling" xabarini olardi va sababni bilmasdi.
    return this.adminService.rejectUser(id, body?.reason);
  }

  // ── Loglar ─────────────────────────────────────────────────────────────────

  @Get("audit-logs")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "AI audit loglari" })
  getAuditLogs(@Query("limit") limit?: string) {
    return this.adminService.getAuditLogs(limit ? Number(limit) : 50);
  }

  @Get("risk-logs")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Risk loglari" })
  getRiskLogs(@Query("limit") limit?: string) {
    return this.adminService.getRiskLogs(limit ? Number(limit) : 50);
  }

  // ── Statistika ─────────────────────────────────────────────────────────────

  // Plan 05-02-fix FIX A — national stats are a global view; tier admins
  // (VILOYAT_ADMIN / TUMAN_ADMIN) MUST NOT see other viloyats' aggregates.
  // Lock to SUPER_ADMIN + BUXGALTER only. Tier admins get their own scope
  // via /stats/viloyat/:id and /stats/tuman/:id.
  @Get("stats/national")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
  @ApiOperation({ summary: "Milliy statistika (Super Admin + Buxgalter)" })
  getNationalStats() {
    return this.adminService.getNationalStats();
  }

  // Plan 05-02-fix FIX A — map-overlay feeder returns EVERY viloyat's RI
  // and library count, so anything below SUPER_ADMIN would be a cross-
  // viloyat scope leak. Tier admins paint their own polygon via
  // /stats/viloyat/:id.
  @Get("stats/viloyat/all")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.BUXGALTER)
  @ApiOperation({ summary: "Barcha viloyatlar statistikasi (xarita uchun, Super Admin + Buxgalter)" })
  getAllViloyatStats() {
    return this.adminService.getAllViloyatStats();
  }

  @Get("stats/viloyat/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Viloyat statistikasi" })
  async getViloyatStats(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const scope = await this.resolveCallerScope(user);
    return this.adminService.getViloyatStats(id, scope);
  }

  @Get("stats/tuman/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Tuman statistikasi" })
  async getTumanStats(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const scope = await this.resolveCallerScope(user);
    // Pre-resolve the tuman's parent viloyatId so the assertTumanInScope
    // VILOYAT_ADMIN check has the data it needs (avoid second lookup inside
    // the service for purity).
    const tuman = await this.prisma.tuman.findUnique({
      where: { id },
      select: { viloyatId: true },
    });
    return this.adminService.getTumanStats(id, scope, tuman?.viloyatId ?? null);
  }

  // Plan 05-02 Task 2 (STAT-01 4th level) — Mahalla scope endpoint.
  // On-demand only — NOT pre-warmed by the stats cron (per Q3 user decision).
  // 30-min cache TTL via getMahallaStats.
  @Get("stats/mahalla/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Mahalla statistikasi (on-demand)" })
  async getMahallaStats(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const scope = await this.resolveCallerScope(user);
    return this.adminService.getMahallaStats(id, scope);
  }

  @Get("stats/genres")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Janr tahlili" })
  @ApiQuery({ name: "viloyatId", required: false })
  getGenreStats(@Query("viloyatId") viloyatId?: string) {
    return this.adminService.getGenreStats(viloyatId);
  }

  @Get("stats/shortage")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMINS, UserRole.KUTUBXONACHI)
  @ApiOperation({ summary: "Kitob yetishmovchiligi tahlili" })
  @ApiQuery({ name: "limit", required: false })
  getBookShortage(@Query("limit") limit?: string) {
    return this.adminService.getBookShortage(limit ? Number(limit) : 20);
  }

  // ── Plan 05-03 (STAT-04/05/06) — Gender / Age / Genre-trend endpoints ──────
  // Tier admins (VILOYAT_ADMIN / TUMAN_ADMIN) allowed; service-layer
  // assertViloyatInScope / assertTumanInScope enforces scope ownership.
  // For tuman scope, we pre-resolve Tuman.viloyatId so the VILOYAT_ADMIN
  // cross-viloyat check has the data it needs (same pattern as /stats/tuman/:id).

  @Get("stats/gender")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Gender taqsimoti (national | viloyat | tuman)" })
  @ApiQuery({ name: "scope", required: false, enum: ["national", "viloyat", "tuman"] })
  @ApiQuery({ name: "scopeId", required: false })
  async getGenderBreakdown(
    @Query("scope") scope: "national" | "viloyat" | "tuman" = "national",
    @Query("scopeId") scopeId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const callerScope = await this.resolveCallerScope(user);
    let resolvedViloyatId: string | null = null;
    if (scope === "tuman" && scopeId) {
      const t = await this.prisma.tuman.findUnique({
        where: { id: scopeId },
        select: { viloyatId: true },
      });
      resolvedViloyatId = t?.viloyatId ?? null;
    }
    return this.adminService.getGenderBreakdown(
      scope,
      scopeId,
      callerScope,
      resolvedViloyatId,
    );
  }

  @Get("stats/age")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Yosh guruhi bo'yicha taqsimot" })
  @ApiQuery({ name: "scope", required: false, enum: ["national", "viloyat", "tuman", "mahalla"] })
  @ApiQuery({ name: "scopeId", required: false })
  async getAgeBreakdown(
    @Query("scope") scope: "national" | "viloyat" | "tuman" | "mahalla" = "national",
    @Query("scopeId") scopeId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const callerScope = await this.resolveCallerScope(user);
    let resolvedViloyatId: string | null = null;
    if (scope === "tuman" && scopeId) {
      const t = await this.prisma.tuman.findUnique({
        where: { id: scopeId },
        select: { viloyatId: true },
      });
      resolvedViloyatId = t?.viloyatId ?? null;
    }
    return this.adminService.getAgeBreakdown(
      scope,
      scopeId,
      callerScope,
      resolvedViloyatId,
    );
  }

  @Get("stats/genres/trend")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Janr × oy trend (so'nggi N oy, default 12)" })
  @ApiQuery({ name: "months", required: false })
  @ApiQuery({ name: "scope", required: false, enum: ["national", "viloyat", "tuman", "mahalla"] })
  @ApiQuery({ name: "scopeId", required: false })
  async getGenreTrend(
    @Query("months") months: string | undefined,
    @Query("scope") scope: "national" | "viloyat" | "tuman" | "mahalla" = "national",
    @Query("scopeId") scopeId: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const callerScope = await this.resolveCallerScope(user);
    let resolvedViloyatId: string | null = null;
    if (scope === "tuman" && scopeId) {
      const t = await this.prisma.tuman.findUnique({
        where: { id: scopeId },
        select: { viloyatId: true },
      });
      resolvedViloyatId = t?.viloyatId ?? null;
    }
    const m = months ? Math.max(1, Math.min(36, Number(months))) : 12;
    return this.adminService.getGenreTrend(
      m,
      scope,
      scopeId,
      callerScope,
      resolvedViloyatId,
    );
  }

  // ── Plan 05-03 T2 (STAT-07) — Mark book for order ──────────────────────────
  // KUTUBXONACHI allowed in addition to the tier admins because library staff
  // physically know what's missing. Service-layer scope check enforces that
  // a librarian can only order for their OWN library (T-05-01c).
  @Post("stats/order-request")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
    UserRole.MUASSASA_ADMIN,
    UserRole.KUTUBXONACHI,
  )
  @ApiOperation({ summary: "Kitob yetishmasligi uchun buyurtma so'rovi yuborish" })
  async createOrderRequest(
    @Body() dto: OrderRequestDto,
    @CurrentUser() user: JwtPayload,
  ) {
    // KUTUBXONACHI: resolve their library via institution affiliation,
    // same pattern as payment.controller.getCallerLibraryId.
    let libraryId: string | null = null;
    if ((user.role as UserRole) === UserRole.KUTUBXONACHI) {
      const u = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: {
          schoolId: true,
          universityId: true,
          organizationId: true,
        },
      });
      const institutionId = u?.schoolId ?? u?.universityId ?? u?.organizationId ?? null;
      if (institutionId) {
        const lib = await this.prisma.library.findFirst({
          where: { institutionId },
          select: { id: true },
        });
        libraryId = lib?.id ?? null;
      }
    }
    return this.adminService.markBookForOrder(dto, {
      id: user.sub,
      role: user.role,
      libraryId,
    });
  }

  // ── Smart alertlar ─────────────────────────────────────────────────────────

  // RBAC geographic scoping (Audit 2026-06) — tier admins must only see alerts
  // in their own region. We resolve the caller's geo scope from their address
  // row (same pattern as the stats endpoints) and pass it into the service,
  // which filters AiAuditLog by the alert's scope-typed region. SUPER_ADMIN /
  // BUXGALTER get the global unfiltered view.
  @Get("alerts")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMINS)
  @ApiOperation({ summary: "Faol smart alertlar (hudud bo'yicha scoped)" })
  @ApiQuery({ name: "limit", required: false })
  async getSmartAlerts(
    @Query("limit") limit: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const scope = await this.resolveCallerScope(user);
    return this.adminService.getSmartAlerts(limit ? Number(limit) : 50, scope);
  }

  @Patch("alerts/:id/resolve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ALL_ADMINS)
  @ApiOperation({ summary: "Alertni yechilgan deb belgilash" })
  resolveAlert(@Param("id") id: string) {
    return this.adminService.resolveAlert(id);
  }

  // ── Demo so'rovlar (B2B CRM) ───────────────────────────────────────────────
  // POST ochiq — istalgan kishi yuborishi mumkin (@Public, INFRA-03)
  //
  // Plan 05-09 Task 2 (LAND-02 + T-05-09): rate-limited to 3/hour per phone
  // via AdminService.createDemoRequest → CacheService.incrWithTtl. On 429 we
  // set the Retry-After response header to give the client a clean signal.
  @Public()
  @Post("demo-request")
  @ApiOperation({ summary: "Demo so'rov yuborish (ommaviy, auth kerak emas)" })
  async createDemoRequest(
    @Body() body: CreateDemoRequestDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return await this.adminService.createDemoRequest(body);
    } catch (err) {
      if (
        err instanceof HttpException &&
        err.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      ) {
        // Extract the retryAfterSeconds the service set on the payload.
        const raw = err.getResponse() as { retryAfterSeconds?: number };
        const retry = raw?.retryAfterSeconds ?? 3600;
        res.setHeader("Retry-After", String(retry));
      }
      throw err;
    }
  }

  @Get("demo-requests")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Demo so'rovlar ro'yhati (faqat Super Admin)" })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "take", required: false, description: "1..200, default 50" })
  @ApiQuery({ name: "skip", required: false })
  getDemoRequests(
    @Query("status") status?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    return this.adminService.getDemoRequests(
      status,
      take ? Number(take) : undefined,
      skip ? Number(skip) : undefined,
    );
  }

  // ── PDF hisobotlar ────────────────────────────────────────────────────────

  // Plan 05-08 T2 — parameterized monthly PDF download (RPT-01).
  //
  // ?scope=national             → SUPER_ADMIN + BUXGALTER (national aggregate).
  // ?scope=viloyat&scopeId=...  → SUPER_ADMIN + BUXGALTER + VILOYAT_ADMIN
  //                              (assertViloyatInScope enforces own scope).
  // ?scope=tuman&scopeId=...    → SUPER_ADMIN + BUXGALTER + VILOYAT_ADMIN + TUMAN_ADMIN
  //                              (assertTumanInScope + pre-resolved viloyatId).
  //
  // RolesGuard lets tier admins reach the endpoint; the service-layer scope
  // assert enforces ownership (T-05-RPT-SCOPE).
  @Get("reports/monthly")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.BUXGALTER,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
  )
  @ApiOperation({ summary: "Oylik statistika hisobotini PDF formatda yuklab olish (scope-parameterized)" })
  @ApiQuery({ name: "scope", required: false, enum: ["national", "viloyat", "tuman"] })
  @ApiQuery({ name: "scopeId", required: false })
  async downloadMonthlyReport(
    @Query("scope") scope: string | undefined,
    @Query("scopeId") scopeId: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    const resolvedScope: ReportScope = (scope === "viloyat" || scope === "tuman")
      ? scope
      : "national";

    if ((resolvedScope === "viloyat" || resolvedScope === "tuman") && !scopeId) {
      throw new BadRequestException(`scopeId is required for scope=${resolvedScope}`);
    }

    // Scope assertion (defense-in-depth beyond RolesGuard).
    const callerScope = await this.resolveCallerScope(user);

    if (resolvedScope === "national") {
      if (
        callerScope.role !== UserRole.SUPER_ADMIN &&
        callerScope.role !== UserRole.BUXGALTER
      ) {
        throw new HttpException("Scope mismatch: national report restricted", HttpStatus.FORBIDDEN);
      }
    } else if (resolvedScope === "viloyat") {
      assertViloyatInScope(callerScope, scopeId as string);
    } else if (resolvedScope === "tuman") {
      const tuman = await this.prisma.tuman.findUnique({
        where: { id: scopeId as string },
        select: { viloyatId: true },
      });
      assertTumanInScope(callerScope, scopeId as string, {
        resolvedViloyatId: tuman?.viloyatId ?? null,
      });
    }

    if (!this.reportData) {
      throw new ServiceUnavailableException("ReportDataService not wired");
    }

    // Period covers the month that just ended (same convention as the cron).
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);

    const data = await this.reportData.gatherForScope(
      resolvedScope,
      scopeId ?? null,
      periodStart,
      periodEnd,
    );
    const pdf = await this.pdfService.generateMonthlyReport(
      data,
      resolvedScope,
      scopeId,
    );

    const monthStr = `${periodStart.getFullYear()}-${String(periodStart.getMonth() + 1).padStart(2, "0")}`;
    const filename = `sifat-hisobot-${resolvedScope}-${scopeId ?? "UZ"}-${monthStr}.pdf`;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdf.length.toString(),
    });
    res.send(pdf);
  }

  @Patch("demo-requests/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Demo so'rov holatini yangilash" })
  updateDemoRequest(
    @Param("id") id: string,
    @Body() body: UpdateDemoRequestDto
  ) {
    return this.adminService.updateDemoRequest(id, body);
  }

  // ── Plan 05-04 Task 3 (NOTIF-02) — Admin test-push ──────────────────────
  // Verifies that FCM is live by enqueueing a push for an arbitrary user.
  // SUPER_ADMIN only — feeds the Plan 05-05 ALERT-06 system-down test path
  // and ops live-verification flow. 404 when userId is invalid.
  @Post("test-push")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Sinov push bildirishnomasi (Super Admin)" })
  async testPush(@Body() dto: TestPushDto): Promise<{ enqueued: true; jobId: string | number | undefined }> {
    const target = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException("Foydalanuvchi topilmadi");

    const job = await this.notificationQueue.add("test-push", {
      type: "push",
      userId: target.id,
      message: dto.message,
      title: dto.title ?? "SIFAT LIBRARY",
      jobType: "test-push",
    });
    return { enqueued: true, jobId: job.id };
  }

  // ── Plan 05-05 T3 (ALERT-06) — System-down smoke endpoint ─────────────
  //
  // Receive-side test for ALERT-06 SYSTEM_DOWN. Reads the operator-supplied
  // ADMIN_SMS_RECIPIENTS env CSV and enqueues an SMS ping per recipient via
  // NOTIFICATION_QUEUE → EskizSmsClient. Records an AiAuditLog row tying the
  // test to the SUPER_ADMIN who triggered it.
  //
  // Architectural note (documented in 05-05-SUMMARY.md):
  //   Real ALERT-06 DETECTION requires an EXTERNAL watchdog (UptimeRobot /
  //   BetterStack / Pingdom hitting `/health`) — the server cannot reliably
  //   detect its own outage. Phase 5 ships the receive path only; the env
  //   variable + this endpoint let operators verify the path end-to-end.
  //
  // 503 when ADMIN_SMS_RECIPIENTS is empty — forces operator to configure
  // before the smoke test works (prevents silent no-op pings).
  @Post("system-down-test")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "ALERT-06 SYSTEM_DOWN smoke ping (Super Admin — ADMIN_SMS_RECIPIENTS env required)",
  })
  async systemDownTest(
    @CurrentUser() user: JwtPayload,
  ): Promise<{ enqueued: number; recipients: number }> {
    const csv =
      this.config?.get<string>("ADMIN_SMS_RECIPIENTS") ??
      process.env.ADMIN_SMS_RECIPIENTS ??
      "";
    const recipients = csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (recipients.length === 0) {
      throw new ServiceUnavailableException(
        "ADMIN_SMS_RECIPIENTS env variable is not configured",
      );
    }

    let enqueued = 0;
    for (const phone of recipients) {
      await this.notificationQueue.add("system-down-test", {
        type: "sms",
        phone,
        message: `[SIFAT LIBRARY] System down test ${new Date().toISOString()}`,
        jobType: "system-down-test",
      });
      enqueued++;
    }

    await this.adminService.recordSystemDownTestAudit(user.sub);
    return { enqueued, recipients: recipients.length };
  }
}
