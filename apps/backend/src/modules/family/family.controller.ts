import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  BadRequestException
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsBoolean } from "class-validator";
import { FamilyService } from "./family.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";

// Plan 06-03 FAM-01 — DTO for opt-IN toggle.
export class SetFamilyDetectionDto {
  @IsBoolean()
  enabled!: boolean;
}

@ApiTags("family")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("family")
export class FamilyController {
  constructor(
    private readonly familyService: FamilyService,
    private readonly prisma: PrismaService
  ) {}

  // ── Oila CRUD ─────────────────────────────────────────────────────────────

  // IDOR-C4 — the family creator is the AUTHENTICATED user (JWT sub), never
  // body.creatorId. Any creatorId a stale client still sends is silently
  // ignored by signature (storeManualEntry / FRAUD-04 migration pattern).
  @Post()
  @ApiOperation({ summary: "Yangi oila yaratish (yaratuvchi = autentifikatsiyalangan foydalanuvchi)" })
  createFamily(
    @CurrentUser("id") creatorId: string,
    @Body() body: { name?: string }
  ) {
    return this.familyService.createFamily(creatorId, body?.name);
  }

  // ── Xonadon aniqlash ──────────────────────────────────────────────────────
  // NOTE: static "suggest" routes are declared BEFORE the ":id" route so the
  // Express router does not swallow GET /family/suggest as getFamily("suggest").

  // IDOR-C4 — detection target is the AUTHENTICATED user only.
  @Get("suggest")
  @ApiOperation({ summary: "Bir xonadondan topilgan foydalanuvchilar → oila taklifi (o'zi uchun)" })
  suggestFamily(@CurrentUser("id") userId: string) {
    return this.familyService.detectAndSuggestFamily(userId);
  }

  // Legacy path kept for the frontend migration window — the :userId param is
  // IGNORED; the actor always comes from the JWT (IDOR-C4).
  @Get("suggest/:userId")
  @ApiOperation({ summary: "[Legacy] Oila taklifi — param e'tiborga olinmaydi, JWT ishlatiladi" })
  suggestFamilyLegacy(@CurrentUser("id") userId: string) {
    return this.familyService.detectAndSuggestFamily(userId);
  }

  // IDOR-C4 + H14 — family details (member list with names + RI) are only for
  // the family's OWN members or admin-tier monitors; minor names are masked
  // in the service (maskNameIfMinor).
  @Get(":id")
  @ApiOperation({ summary: "Oila ma'lumoti (faqat a'zolar yoki admin; 14 yoshgacha ismlar maskalanadi)" })
  getFamily(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.familyService.getFamily(id, { id: user.sub, role: user.role });
  }

  // ── Plan 06-03 FAM-01 — opt-IN toggle ────────────────────────────────────

  @Patch("me/family-detection")
  @ApiOperation({
    summary: "Oilamni topishga ruxsat berish/bekor qilish (FAM-01 opt-IN)",
  })
  setFamilyDetection(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetFamilyDetectionDto,
  ) {
    return this.familyService.setFamilyDetectionEnabled(user.sub, dto.enabled);
  }

  // ── Taklif tizimi ─────────────────────────────────────────────────────────

  // IDOR-C4 — the inviter is the AUTHENTICATED user; body.inviterId removed
  // (the service's "Siz bu oila a'zosi emassiz" check now binds to the JWT
  // sub). inviteeId/inviteePhone identify the invite TARGET, not the actor,
  // so they legitimately stay in the body.
  @Post(":id/invite")
  @ApiOperation({ summary: "Oilaga a'zo taklif qilish — inviteeId yoki inviteePhone orqali (SMS yuboriladi)" })
  async inviteMember(
    @Param("id") familyId: string,
    @CurrentUser("id") inviterId: string,
    @Body() body: { inviteeId?: string; inviteePhone?: string }
  ) {
    let inviteeId = body.inviteeId;

    // Telefon raqami berilgan bo'lsa foydalanuvchini qidirish
    if (!inviteeId && body.inviteePhone) {
      const found = await this.prisma.user.findFirst({
        where: { phone: body.inviteePhone },
        select: { id: true }
      });
      if (!found) throw new BadRequestException("Bu telefon raqamli foydalanuvchi topilmadi");
      inviteeId = found.id;
    }

    if (!inviteeId) throw new BadRequestException("inviteeId yoki inviteePhone talab qilinadi");
    return this.familyService.inviteMember(familyId, inviterId, inviteeId);
  }

  // IDOR-C4 — responder = JWT sub; body.userId removed (the service's
  // `invite.inviteeId !== userId` check now binds to the real caller, so
  // nobody can accept/reject an invite addressed to someone else).
  @Post("invites/:inviteId/respond")
  @ApiOperation({ summary: "Taklifga javob berish (qabul/rad — faqat taklif egasi)" })
  respondToInvite(
    @Param("inviteId") inviteId: string,
    @CurrentUser("id") userId: string,
    @Body() body: { accept: boolean }
  ) {
    return this.familyService.respondToInvite(inviteId, userId, body.accept);
  }

  // ── Oiladan chiqish ───────────────────────────────────────────────────────

  // IDOR-C4 — only the authenticated user leaves THEIR OWN family.
  @Delete("leave")
  @ApiOperation({ summary: "Oiladan chiqish (o'zi uchun)" })
  leaveFamily(@CurrentUser("id") userId: string) {
    return this.familyService.leaveFamily(userId);
  }

  // Legacy path kept for the frontend migration window — the :userId param is
  // IGNORED; the actor always comes from the JWT (IDOR-C4).
  @Delete("leave/:userId")
  @ApiOperation({ summary: "[Legacy] Oiladan chiqish — param e'tiborga olinmaydi, JWT ishlatiladi" })
  leaveFamilyLegacy(@CurrentUser("id") userId: string) {
    return this.familyService.leaveFamily(userId);
  }

  // ── Oila reytingi ─────────────────────────────────────────────────────────

  @Get("ratings/top")
  @Public()
  @ApiOperation({ summary: "Top oilalar reytingi (ochiq, anonimlashtirilgan)" })
  @ApiQuery({ name: "viloyatId", required: false })
  @ApiQuery({ name: "tumanId", required: false })
  @ApiQuery({ name: "mahallaId", required: false })
  @ApiQuery({ name: "month", required: false })
  @ApiQuery({ name: "limit", required: false })
  getFamilyRatings(
    @Query("viloyatId") viloyatId?: string,
    @Query("tumanId") tumanId?: string,
    @Query("mahallaId") mahallaId?: string,
    @Query("month") month?: string,
    @Query("limit") limit?: string
  ) {
    return this.familyService.getFamilyRatings({
      viloyatId,
      tumanId,
      mahallaId,
      month,
      limit: limit ? Number(limit) : 50
    });
  }

  // ── Admin: hudud bo'yicha scoped oila reytingi (dashboard) ────────────────
  //
  // RBAC geographic scoping (Audit 2026-06). The PUBLIC `ratings/top` stays
  // public + unscoped (anonimized Top-50). The DASHBOARD family panel must NOT
  // let a VILOYAT/TUMAN admin browse every viloyat's families, so it uses THIS
  // auth+region-scoped path instead. The caller's region is derived from their
  // address row (JWT-bound) and CLAMPS the client-supplied filters:
  //   * SUPER_ADMIN → any viloyat/tuman (or none = national).
  //   * VILOYAT_ADMIN → forced viloyatId = own; may narrow to a tuman that the
  //                     guard does not verify belongs to the viloyat (the
  //                     viloyat filter still constrains the result set).
  //   * TUMAN_ADMIN → forced tumanId = own (viloyat filter dropped).
  // Fail-CLOSED: a tier admin with no region gets an empty list.
  //
  // Reuses FamilyService.getFamilyRatings unchanged — only the WHERE filters
  // are clamped here, so the family module's compute logic is untouched.
  @Get("ratings/admin")
  @UseGuards(RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
  )
  @ApiOperation({ summary: "Oila reytingi — admin hududi bo'yicha (dashboard)" })
  @ApiQuery({ name: "viloyatId", required: false })
  @ApiQuery({ name: "tumanId", required: false })
  @ApiQuery({ name: "mahallaId", required: false })
  @ApiQuery({ name: "month", required: false })
  @ApiQuery({ name: "limit", required: false })
  async getAdminFamilyRatings(
    @CurrentUser() user: JwtPayload,
    @Query("viloyatId") viloyatId?: string,
    @Query("tumanId") tumanId?: string,
    @Query("mahallaId") mahallaId?: string,
    @Query("month") month?: string,
    @Query("limit") limit?: string,
  ) {
    const caller = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        role: true,
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    const role = (caller?.role ?? user.role) as UserRole;
    const callerViloyatId = caller?.address?.viloyatId ?? null;
    const callerTumanId = caller?.address?.tumanId ?? null;

    // Clamp the geo filters to the caller's authority.
    let effViloyatId = viloyatId;
    let effTumanId = tumanId;
    let effMahallaId = mahallaId;

    if (role === UserRole.TUMAN_ADMIN) {
      // Fail-CLOSED — no tuman means no scope.
      if (!callerTumanId) return [];
      effTumanId = callerTumanId;
      effViloyatId = undefined; // tuman filter is strictly narrower
    } else if (role === UserRole.VILOYAT_ADMIN) {
      if (!callerViloyatId) return [];
      effViloyatId = callerViloyatId;
      // A VILOYAT_ADMIN may narrow to a tuman within their viloyat; the viloyat
      // filter remains in the WHERE so an out-of-viloyat tumanId yields nothing.
      // mahallaId likewise stays constrained by the viloyat filter.
    }
    // SUPER_ADMIN: filters pass through unchanged (national + arbitrary scope).

    return this.familyService.getFamilyRatings({
      viloyatId: effViloyatId,
      tumanId: effTumanId,
      mahallaId: effMahallaId,
      month,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Get(":id/rating")
  @ApiOperation({ summary: "Oila reytingi (oylik)" })
  @ApiQuery({ name: "month", required: false })
  getFamilyRating(
    @Param("id") familyId: string,
    @Query("month") month?: string
  ) {
    return this.familyService.getFamilyRating(familyId, month);
  }

  // ── Plan 06-03 FAM-05 — Public family profile (Top-50 link target) ───────
  // Anonimized: under-14 member names are masked server-side. No auth required.
  @Get(":id/profile")
  @Public()
  @ApiOperation({
    summary: "Oilaning ochiq profili (14 yoshgacha ismlar maskalanadi)",
  })
  getPublicFamilyProfile(@Param("id") familyId: string) {
    return this.familyService.getPublicFamilyProfile(familyId);
  }

  // ── Admin: Reytingni qayta hisoblash ──────────────────────────────────────

  @Post("ratings/compute")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Barcha oilalar reytingini qayta hisoblash (Super Admin)" })
  @ApiQuery({ name: "month", required: false })
  computeRatings(@Query("month") month?: string) {
    return this.familyService.computeFamilyRatings(month);
  }
}
