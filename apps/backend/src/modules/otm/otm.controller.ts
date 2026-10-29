import {
  Controller, Get, Post, Patch, Body, Param, Query, Res,
  UseGuards, HttpStatus
} from "@nestjs/common";
import { Response } from "express";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import { OtmService } from "./otm.service";
import { StudentProgressService } from "./student-progress/student-progress.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import type { InstitutionScopedUser } from "../../common/utils/admin-scope.util";

const OTM_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
] as const;

@ApiTags("otm")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("otm")
export class OtmController {
  constructor(
    private readonly otm: OtmService,
    private readonly studentProgress: StudentProgressService,
    private readonly prisma: PrismaService,
  ) {}

  // Plan 06-07 UNI-01..04 — resolves the caller's scope row (role + FK columns +
  // address) so service-layer `assertInstitutionInScope` has the data it needs.
  // Mirrors SchoolController.resolveScopedUser.
  private async resolveScopedUser(
    payload: JwtPayload,
  ): Promise<InstitutionScopedUser & { sub: string; faculty?: string | null }> {
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        role: true,
        schoolId: true,
        universityId: true,
        organizationId: true,
        faculty: true,
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    return {
      sub: payload.sub,
      role: u?.role ?? (payload.role as UserRole),
      schoolId: u?.schoolId ?? null,
      universityId: u?.universityId ?? null,
      organizationId: u?.organizationId ?? null,
      faculty: u?.faculty ?? null,
      address: {
        viloyatId: u?.address?.viloyatId ?? null,
        tumanId: u?.address?.tumanId ?? null,
      },
    };
  }

  // ── Talabalar ─────────────────────────────────────────────────────────────

  @Get(":id/students")
  @Roles(...OTM_ADMINS)
  @ApiOperation({ summary: "OTM talabalar ro'yhati" })
  @ApiQuery({ name: "faculty", required: false })
  @ApiQuery({ name: "course", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  async getStudents(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("faculty") faculty?: string,
    @Query("course") course?: string,
    @Query("status") status?: string,
    @Query("limit") limit = "50",
    @Query("offset") offset = "0"
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.getStudents(id, {
      faculty, course, status,
      limit: Number(limit), offset: Number(offset)
    }, scopedUser);
  }

  // Plan 06-07 UNI-01/UNI-02 — faculty-scoped student list (per-faculty
  // approval queue).
  @Get(":id/faculties/:facultyId/students")
  @Roles(...OTM_ADMINS)
  @ApiOperation({ summary: "Fakultet bo'yicha talabalar ro'yhati" })
  async getStudentsByFaculty(
    @Param("id") id: string,
    @Param("facultyId") facultyId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.getStudentsByFaculty(id, facultyId, scopedUser);
  }

  @Patch(":id/students/:userId/approve")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Talabani tasdiqlash" })
  async approveStudent(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.approveStudent(userId, id, scopedUser);
  }

  // Backward-compat: keep the old POST route alive (existing frontend uses
  // POST). The PATCH route above is the new canonical method.
  @Post(":id/students/:userId/approve")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Talabani tasdiqlash (legacy POST route)" })
  async approveStudentPost(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.approveStudent(userId, id, scopedUser);
  }

  // Plan 06-07 UNI-01 — reject endpoint with mandatory reason. 10/min throttle
  // mirrors SchoolController.rejectStudent (T-06-S2 mass-reject defense).
  @Patch(":id/students/:userId/reject")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Talabani rad etish (sabab majburiy)" })
  async rejectStudent(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() body: { reason: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.rejectStudent(userId, id, body?.reason, scopedUser);
  }

  // ── Statistika ────────────────────────────────────────────────────────────

  @Get(":id/stats")
  @Roles(...OTM_ADMINS)
  @ApiOperation({ summary: "OTM statistikasi" })
  async getStats(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.otm.getOtmStats(id, scopedUser);
  }

  // Plan 06-07 UNI-04 admin progress endpoint — aggregated per-faculty + by-course.
  @Get(":id/faculties/:facultyId/progress")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Fakultet bo'yicha talabalar progressi (aggregat)" })
  async getFacultyProgress(
    @Param("id") id: string,
    @Param("facultyId") facultyId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.studentProgress.getProgressForFaculty(id, facultyId, scopedUser);
  }

  // Plan 06-07 UNI-04 student-self progress — authenticated user reads OWN data.
  @Get("me/progress")
  @ApiOperation({ summary: "Talabaning shaxsiy progressi (faqat o'zi uchun)" })
  async getMyProgress(@CurrentUser() user: JwtPayload) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.studentProgress.getStudentSelfProgress(scopedUser);
  }

  // ── Ilmiy adabiyotlar ─────────────────────────────────────────────────────

  @Get(":id/prof-books")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.KUTUBXONACHI)
  @ApiOperation({ summary: "OTM ilmiy adabiyotlar ro'yhati" })
  @ApiQuery({ name: "genre", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  getProfBooks(
    @Param("id") id: string,
    @Query("genre") genre?: string,
    @Query("limit") limit = "50",
    @Query("offset") offset = "0"
  ) {
    return this.otm.getProfBooks(id, {
      genre, limit: Number(limit), offset: Number(offset)
    });
  }

  @Post(":id/prof-books")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN)
  @ApiOperation({ summary: "Ilmiy adabiyot qo'shish" })
  addProfBook(
    @Param("id") id: string,
    @Body() body: {
      isbn?: string;
      title: string;
      author: string;
      genre?: string;
      description?: string;
      isRequired?: boolean;
    },
    @CurrentUser("id") userId: string
  ) {
    return this.otm.addProfBook(id, { ...body, addedById: userId });
  }

  // ── OTM reytingi ─────────────────────────────────────────────────────────

  @Get("rankings")
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "OTMlar reytingi" })
  @ApiQuery({ name: "viloyatId", required: false })
  @ApiQuery({ name: "month", required: false })
  @ApiQuery({ name: "limit", required: false })
  getRankings(
    @Query("viloyatId") viloyatId?: string,
    @Query("month") month?: string,
    @Query("limit") limit = "50"
  ) {
    return this.otm.getOtmRankings({ viloyatId, month, limit: Number(limit) });
  }

  // ── Akkreditatsiya hisoboti ───────────────────────────────────────────────
  // Plan 06-07 UNI-03 — subscription gate enforced in service layer. PDF
  // composer also routes every DB string through escapeHtml.

  @Get(":id/report/accreditation")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @ApiOperation({ summary: "Akkreditatsiya hisoboti PDF (subscription gated)" })
  @ApiQuery({ name: "year", required: false })
  async getAccreditationReport(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
    @Query("year") year?: string,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    const opts: { year?: number } = {};
    if (year) opts.year = Number(year);
    const pdf = await this.otm.generateAccreditationReport(id, scopedUser, opts);
    const filename = `otm-akkreditatsiya-${id}-${Date.now()}.pdf`;
    res.status(HttpStatus.OK)
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      .send(pdf);
  }
}
