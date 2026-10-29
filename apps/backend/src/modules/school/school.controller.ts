import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, Res
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole, InstitutionType } from "@prisma/client";
import type { Response } from "express";
import { SchoolService } from "./school.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import type { InstitutionScopedUser } from "../../common/utils/admin-scope.util";

const SCHOOL_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN
] as const;

@ApiTags("school")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("school")
export class SchoolController {
  constructor(
    private readonly schoolService: SchoolService,
    private readonly pdfService: PdfService,
    private readonly prisma: PrismaService,
  ) {}

  // Plan 06-02 SCH-01 — resolves the caller's scope row (role + FK columns +
  // address) so service-layer `assertInstitutionInScope` has the data it needs
  // to evaluate MUASSASA_ADMIN (schoolId/universityId/organizationId) and
  // VILOYAT_ADMIN/TUMAN_ADMIN (address.viloyatId/tumanId) checks without a
  // second round-trip. Mirrors AdminController.resolveCallerScope (Plan 05-02).
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

  // ── Muassasalar ───────────────────────────────────────────────────────────

  @Post("institutions")
  @Roles(UserRole.SUPER_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Yangi muassasa qo'shish (Maktab/OTM/Idora)" })
  createInstitution(
    @Body() body: {
      type: InstitutionType;
      name: string;
      tumanId: string;
      viloyatId: string;
      address?: string;
      phone?: string;
      directorId?: string;
    }
  ) {
    return this.schoolService.createInstitution(body);
  }

  @Get("institutions")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Muassasalar ro'yhati" })
  @ApiQuery({ name: "type", required: false, enum: InstitutionType })
  @ApiQuery({ name: "tumanId", required: false })
  @ApiQuery({ name: "viloyatId", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  listInstitutions(
    @Query("type") type?: InstitutionType,
    @Query("tumanId") tumanId?: string,
    @Query("viloyatId") viloyatId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.schoolService.listInstitutions({
      type,
      tumanId,
      viloyatId,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0
    });
  }

  @Get("institutions/:id")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Muassasa ma'lumoti" })
  getInstitution(@Param("id") id: string) {
    return this.schoolService.getInstitution(id);
  }

  // ── Maktab statistika ─────────────────────────────────────────────────────

  @Get("institutions/:id/stats")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Maktab statistikasi — qamrov, RI, maqsad" })
  async getStats(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.schoolService.getSchoolStats(id, scopedUser);
  }

  // ── O'quvchilar ───────────────────────────────────────────────────────────

  @Get("institutions/:id/students")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "O'quvchilar ro'yhati (sinf filtri mumkin)" })
  @ApiQuery({ name: "class", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  async getStudents(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Query("class") schoolClass?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.schoolService.getStudents(id, {
      schoolClass,
      status,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0
    }, scopedUser);
  }

  // Plan 06-02 SCH-01 — students bucketed by class with K-anonymity suppression
  // for classes with total < 5. Scope-guarded; SUPER_ADMIN bypass.
  @Get("institutions/:id/students-by-class")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "O'quvchilar sinf bo'yicha bucketlangan (K-anonymity)" })
  async getStudentsByClass(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.schoolService.getStudentsByClass(id, scopedUser);
  }

  @Get("institutions/:id/classes")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Sinf ro'yhati va o'quvchilar soni" })
  getClasses(@Param("id") id: string) {
    return this.schoolService.getClassList(id);
  }

  @Patch("institutions/:id/students/:userId/approve")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "O'quvchini tasdiqlash → ACTIVE" })
  async approveStudent(
    @Param("id") institutionId: string,
    @Param("userId") userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.schoolService.approveStudent(userId, institutionId, scopedUser);
  }

  // Plan 06-02 SCH-02 — Reject a PENDING student with a free-text reason.
  // @Throttle limit 10/min: prevents abuse via mass-reject scripting (T-06-S2).
  // The service writes an AiAuditLog row { issueType: 'STUDENT_REJECT' } so the
  // action is recoverable via the admin audit log UI (Plan 5 admin escaping).
  @Patch("institutions/:id/students/:userId/reject")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "O'quvchini rad etish → BLOCKED (sabab majburiy)" })
  async rejectStudent(
    @Param("id") institutionId: string,
    @Param("userId") userId: string,
    @Body() body: { reason: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const scopedUser = await this.resolveScopedUser(user);
    return this.schoolService.rejectStudent(userId, institutionId, body?.reason, scopedUser);
  }

  // ── Maktab reytingi ───────────────────────────────────────────────────────

  @Get("rankings")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Maktab reytingi (respublika / viloyat / tuman)" })
  @ApiQuery({ name: "viloyatId", required: false })
  @ApiQuery({ name: "tumanId", required: false })
  @ApiQuery({ name: "month", required: false })
  @ApiQuery({ name: "limit", required: false })
  getRankings(
    @Query("viloyatId") viloyatId?: string,
    @Query("tumanId") tumanId?: string,
    @Query("month") month?: string,
    @Query("limit") limit?: string
  ) {
    return this.schoolService.getSchoolRankings({
      viloyatId,
      tumanId,
      month,
      limit: limit ? Number(limit) : 100
    });
  }

  @Post("rankings/compute")
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Barcha maktablar reytingini qayta hisoblash (Super Admin)" })
  @ApiQuery({ name: "month", required: false })
  computeRankings(@Query("month") month?: string) {
    return this.schoolService.computeSchoolRatings(month);
  }

  // ── PQ-9 PDF hisoboti ─────────────────────────────────────────────────────
  //
  // Plan 06-02 SCH-08 — passes the new jadidlarSection + goalAchievement blocks
  // through PdfService.generateSchoolPq9Report. School name + club name +
  // debate fields are ALL escaped at render time (escapeHtml).

  @Get("institutions/:id/pq9-report")
  @Roles(...SCHOOL_ADMINS)
  @ApiOperation({ summary: "Maktab PQ-9 hisobotini PDF formatda yuklab olish" })
  async downloadPq9Report(@Param("id") id: string, @CurrentUser() user: JwtPayload, @Res() res: Response) {
    const scopedUser = await this.resolveScopedUser(user);
    const data = await this.schoolService.getPq9ReportData(id, scopedUser);

    const html = this.pdfService.generateSchoolPq9Report({
      title: `PQ-9 Muvofiqlik Hisoboti — ${data.institution.name}`,
      period: data.period,
      generatedAt: data.generatedAt,
      schoolName: data.institution.name,
      stats: {
        totalStudents: Number(data.stats.students.total),
        activeStudents: Number(data.stats.students.active),
        coverageRate: Number(data.stats.coverageRate),
        avgRi: Number(data.stats.avgRi),
        activeClubs: Number(data.stats.activeClubs),
        monthlyTransactions: Number(data.stats.monthlyTransactions),
      },
      classBuckets: data.classBuckets ?? [],
      jadidlarSection: data.jadidlarSection,
      goalAchievement: data.goalAchievement,
      ranking: {
        rank: data.ranking?.rank ?? null,
        totalScore: Number(data.ranking?.totalScore ?? 0),
      },
    });

    const pdf = await this.pdfService.generateFromHtml(html);
    const filename = `pq9-${id}-${new Date().toISOString().slice(0, 7)}.pdf`;

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdf.length.toString()
    });
    res.send(pdf);
  }
}
