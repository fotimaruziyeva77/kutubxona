import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { UserRole } from "@prisma/client";
import { IdoraService } from "./idora.service";
import { MukofotService } from "./mukofot/mukofot.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import type { InstitutionScopedUser } from "../../common/utils/admin-scope.util";

const HR_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.MUASSASA_ADMIN,
] as const;

const IDORA_VIEWERS = [
  UserRole.SUPER_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.BUXGALTER,
] as const;

@ApiTags("Idora")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("idora")
export class IdoraController {
  constructor(
    private readonly idora: IdoraService,
    private readonly prisma: PrismaService,
    private readonly mukofot: MukofotService,
  ) {}

  // Plan 06-05 ORG-01 — JWT payload → scoped user (FK + address) so the
  // service-layer `assertInstitutionInScope` has everything it needs. Mirrors
  // SchoolController.resolveScopedUser.
  private async resolveScopedUser(payload: JwtPayload): Promise<InstitutionScopedUser> {
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        role: true,
        schoolId: true,
        universityId: true,
        organizationId: true,
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    return {
      role: u?.role ?? (payload.role as UserRole),
      schoolId: u?.schoolId ?? null,
      universityId: u?.universityId ?? null,
      organizationId: u?.organizationId ?? null,
      address: {
        viloyatId: u?.address?.viloyatId ?? null,
        tumanId: u?.address?.tumanId ?? null,
      },
    };
  }

  // ── Xodimlar ──────────────────────────────────────────────────────────────

  @Get(":institutionId/employees")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Xodimlar ro'yhati" })
  async getEmployees(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("department") department?: string,
    @Query("search") search?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getEmployees(
      institutionId,
      { department, search, page, limit },
      scoped,
    );
  }

  // Plan 06-05 ORG-01 — employees-by-department tree with K-anonymity.
  @Get(":institutionId/employees-by-department")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Xodimlar bo'lim bo'yicha (K-anonymity)" })
  async getEmployeesByDepartment(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("departmentId") departmentId?: string,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getEmployeesByDepartment(institutionId, { departmentId }, scoped);
  }

  // Plan 06-05-fix FIX A — institutionId scope is now part of the route so
  // the service can assert the caller owns this institution AND the userId
  // belongs to that institution (404 on cross-org id-enumeration).
  @Get(":institutionId/employee/:userId")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Xodim profili (scoped)" })
  async getEmployee(
    @Param("institutionId") institutionId: string,
    @Param("userId") userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getEmployee(institutionId, userId, scoped);
  }

  // Plan 06-05 ORG-01 — HR admin approves a PENDING employee.
  @Post(":institutionId/employees/:userId/approve")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Xodimni tasdiqlash → ACTIVE" })
  async approveEmployee(
    @Param("institutionId") institutionId: string,
    @Param("userId") userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.approveEmployee(institutionId, userId, scoped);
  }

  // Plan 06-05 ORG-01 — HR admin rejects a PENDING employee (reason required).
  @Post(":institutionId/employees/:userId/reject")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Xodimni rad etish → BLOCKED (sabab majburiy)" })
  async rejectEmployee(
    @Param("institutionId") institutionId: string,
    @Param("userId") userId: string,
    @Body() body: { reason: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.rejectEmployee(institutionId, userId, body?.reason, scoped);
  }

  // ── Bo'limlar ─────────────────────────────────────────────────────────────

  @Get(":institutionId/departments")
  @Roles(...IDORA_VIEWERS)
  async getDepartments(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getDepartments(institutionId, scoped);
  }

  @Post(":institutionId/departments")
  @Roles(...HR_ROLES)
  async createDepartment(
    @Param("institutionId") institutionId: string,
    @Body() body: { name: string; code?: string; headId?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.createDepartment(institutionId, body, scoped);
  }

  // Plan 06-05-fix FIX B — route now carries institutionId so the service
  // can assert scope AND verify the department.institutionId === institutionId
  // before any update. Prevents cross-org department takeover.
  @Put(":institutionId/departments/:id")
  @Roles(...HR_ROLES)
  async updateDepartment(
    @Param("institutionId") institutionId: string,
    @Param("id") id: string,
    @Body() body: { name?: string; code?: string; headId?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.updateDepartment(institutionId, id, body, scoped);
  }

  // Plan 06-05-fix FIX B — same contract as update; 404 on cross-org id.
  @Delete(":institutionId/departments/:id")
  @Roles(...HR_ROLES)
  async deleteDepartment(
    @Param("institutionId") institutionId: string,
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.deleteDepartment(institutionId, id, scoped);
  }

  // ── Ichki reyting ─────────────────────────────────────────────────────────

  @Get(":institutionId/rating")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Idora ichki xodimlar reytingi" })
  async getInternalRating(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("month") month?: string,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getInternalRating(institutionId, month, scoped);
  }

  // Plan 06-05 ORG-02 — last-6-months OrgRating series for the dynamics chart.
  @Get(":institutionId/rating/history")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Reyting tarixi (so'nggi 6 oy)" })
  async getInternalRatingHistory(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getInternalRatingHistory(institutionId, scoped);
  }

  @Post(":institutionId/rating/compute")
  @Roles(...HR_ROLES)
  @ApiOperation({
    summary:
      "Reyting qayta hisoblash (R-DUP: deprecated — Phase 3 InstitutionalService is sole writer)",
  })
  async computeRating(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("month") month?: string,
  ) {
    const scoped = await this.resolveScopedUser(user);
    // Plan 06-01 R-DUP — IdoraService no longer writes OrgRating.
    return this.idora.getInternalRating(institutionId, month, scoped);
  }

  // ── Kitob burchagi ────────────────────────────────────────────────────────

  @Get(":institutionId/book-corner")
  @Roles(...IDORA_VIEWERS)
  async getBookCorner(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getBookCorner(institutionId, scoped);
  }

  @Post(":institutionId/book-corner")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Kitob burchagi yaratish / yangilash" })
  async upsertBookCorner(
    @Param("institutionId") institutionId: string,
    @Body() body: {
      name?: string;
      floor?: string;
      photoUrls?: string[];
      latitude?: number;
      longitude?: number;
      adminNote?: string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.upsertBookCorner(institutionId, body, scoped);
  }

  // Plan 06-05 ORG-04 — verify book corner with a fresh photo (MinIO upload).
  // MIME sniff (image-only), 5MB cap. Subscription gate enforced inside.
  @Post(":institutionId/book-corner/verify")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Kitob burchagi qayta tekshiruvi (foto yuklash)" })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  async verifyBookCorner(
    @Param("institutionId") institutionId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string; size?: number; originalname?: string } | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.verifyBookCorner(institutionId, user.sub, file, scoped);
  }

  // ── Kitob o'qish soati ────────────────────────────────────────────────────

  @Get(":institutionId/reading-hours")
  @Roles(...IDORA_VIEWERS)
  async getReadingHours(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getReadingHours(institutionId, page, limit, scoped);
  }

  @Get(":institutionId/reading-hours/stats")
  @Roles(...IDORA_VIEWERS)
  async getReadingHourStats(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getReadingHourStats(institutionId, scoped);
  }

  // Plan 06-05-fix FIX D — recordedById comes from JWT (@CurrentUser().sub),
  // NOT from the body. DTO no longer accepts recordedById — clients sending
  // it will have it ignored. Audit-trail integrity: only the authenticated
  // actor can be recorded as the event recorder.
  @Post(":institutionId/reading-hours")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Kitob o'qish soati tadbiri qayd etish" })
  async createReadingHour(
    @Param("institutionId") institutionId: string,
    @Body() body: {
      title?: string;
      heldAt: string;
      venue?: string;
      durationMin?: number;
      mediaUrls?: string[];
      notes?: string;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.createReadingHour(institutionId, user.sub, body, scoped);
  }

  // Plan 06-05-fix FIX D — route now carries institutionId so the service
  // can (1) assert scope, (2) verify the readingHour belongs to this
  // institution, and (3) reject userIds that don't belong to this institution
  // (cross-org attendance forgery defence).
  @Post(":institutionId/reading-hours/:id/attendance")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Tadbirga qatnashish belgisi (QR)" })
  async markAttendance(
    @Param("institutionId") institutionId: string,
    @Param("id") readingHourId: string,
    @Body() body: { userIds: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.markAttendance(
      institutionId,
      readingHourId,
      body.userIds,
      scoped,
    );
  }

  // ── Kasb adabiyotlar ──────────────────────────────────────────────────────

  @Get(":institutionId/prof-books")
  @Roles(...IDORA_VIEWERS)
  async getProfBooks(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("departmentId") departmentId?: string,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.getProfBooks(institutionId, departmentId, scoped);
  }

  @Post(":institutionId/prof-books")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Kasb adabiyotini qo'shish (HR admin)" })
  async addProfBook(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: {
      departmentId?: string;
      isbn?: string;
      title: string;
      author: string;
      genre?: string;
      description?: string;
      isRequired?: boolean;
    },
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.addProfBook(institutionId, user.sub, body, scoped);
  }

  @Delete(":institutionId/prof-books/:id")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Kasb adabiyotini o'chirish (HR admin)" })
  async removeProfBook(
    @Param("institutionId") institutionId: string,
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.idora.removeProfBook(institutionId, id, scoped);
  }

  // Legacy 1-arg path (kept for back-compat with any direct admin tooling).
  @Delete("prof-books/:id")
  @Roles(UserRole.SUPER_ADMIN)
  removeProfBookLegacy(@Param("id") id: string) {
    return this.idora.removeProfBookById(id);
  }

  // ── Mukofot taklifi (ORG-05) ──────────────────────────────────────────────

  @Post(":institutionId/mukofot/recommend")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Mukofot taklifi yaratish (HR admin)" })
  async recommendMukofot(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: { userId: string; month?: string; monthlyRi?: number; userName?: string; institutionName?: string },
  ) {
    const scoped = await this.resolveScopedUser(user);
    const month = body.month ?? this._currentMonth();
    return this.mukofot.recommendMukofot(
      institutionId,
      body.userId,
      { sub: user.sub, user: scoped, systemActor: false },
      {
        month,
        monthlyRi: body.monthlyRi,
        userName: body.userName,
        institutionName: body.institutionName,
      },
    );
  }

  @Get(":institutionId/mukofot/recent")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "Mukofot taklifi tarixi (so'nggi 10)" })
  async recentMukofot(@Param("institutionId") institutionId: string) {
    const rows = await this.prisma.aiAuditLog.findMany({
      where: {
        issueType: "MUKOFOT_TAKLIFI",
        scope: "INSTITUTION",
        scopeId: institutionId,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows;
  }

  // ── PQ-9 PDF Hisobot ──────────────────────────────────────────────────────
  //
  // Plan 06-05 ORG-06 — subscription gate enforced inside service. Frozen /
  // deleted Subscription → 403 ForbiddenException with explanatory message.

  @Get(":institutionId/report/pq9")
  @Roles(...IDORA_VIEWERS)
  @ApiOperation({ summary: "PQ-9 muvofiqlik hisoboti (PDF, obuna talab)" })
  async generatePq9Report(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const scoped = await this.resolveScopedUser(user);
    // The service checks subscription.status === ACTIVE/TRIAL; SUPER_ADMIN
    // bypass; throws ForbiddenException("Idora obunasi muzlatilgan/o'chirilgan")
    // when the gate fails.
    const pdfBuffer = await this.idora.generatePq9Report(institutionId, scoped);
    const month = new Date().toISOString().slice(0, 7);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="pq9-${institutionId}-${month}.pdf"`,
      "Content-Length": pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }

  private _currentMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}
