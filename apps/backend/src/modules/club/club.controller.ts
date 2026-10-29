import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  Query, UseGuards, UseInterceptors, UploadedFile,
  BadRequestException, Req
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiConsumes } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import type { Request } from "express";
import { ClubService } from "./club.service";
import { ClubConsentService, type ConsentAction } from "./consent/club-consent.service";
import { DebateMediaService } from "./media/debate-media.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CacheService } from "../../infra/cache/cache.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import type { InstitutionScopedUser } from "../../common/utils/admin-scope.util";

// Plan 06-04 SCH-05 — 50MB file size cap, declared at controller level so
// Multer rejects oversized payloads BEFORE buffering them in memory.
const DEBATE_MEDIA_MAX_BYTES = 50_000_000;

const CLUB_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.KLUB_RAHBARI
] as const;

const REGION_ADMINS = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN
] as const;

// Plan 06-04 SCH-04 — consent endpoint IP-based rate-limit budget:
//   10 attempts per IP per hour (per plan + research §Parent SMS Consent Flow).
const CONSENT_RATE_LIMIT = 10;
const CONSENT_RATE_WINDOW_SECONDS = 60 * 60;

@ApiTags("club")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("club")
export class ClubController {
  constructor(
    private readonly clubService: ClubService,
    private readonly consentService: ClubConsentService,
    private readonly cache: CacheService,
    private readonly mediaService: DebateMediaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Plan 06-04 SCH-05 — resolves the caller's scope row (mirrors SchoolController).
   */
  private async resolveScopedUser(payload: JwtPayload): Promise<InstitutionScopedUser & { id: string }> {
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
      id: payload.sub,
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

  /**
   * Plan 06-04 SCH-04 — IP-based rate limit for /club/consent + /club/consent/info.
   *
   * Defense-in-depth on top of the global ThrottlerModule. The token itself
   * is the only auth — bcrypt + 48h TTL + single-use bounds the attack
   * surface, but we still want to bound brute-force volume per IP.
   */
  private async _consentIpRateCheck(req: Request): Promise<void> {
    const ip = (
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown"
    ).slice(0, 64);
    const key = `consent-rl:${ip}`;
    const n = await this.cache.incrWithTtl(key, CONSENT_RATE_WINDOW_SECONDS);
    if (n > CONSENT_RATE_LIMIT) {
      throw new BadRequestException(
        "Juda ko'p so'rov — 1 soatdan so'ng urinib ko'ring",
      );
    }
  }

  // ── Public consent endpoints (NO JwtAuthGuard) ────────────────────────────

  @Public()
  @Get("consent/info")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: "Public ota-ona rozilik ma'lumotini olish (minimum info, D-OQ-4)",
  })
  async getConsentInfo(@Query("t") token: string, @Req() req: Request) {
    await this._consentIpRateCheck(req);
    if (!token) throw new BadRequestException("Token kerak");
    return this.consentService.peek(token);
  }

  @Public()
  @Post("consent")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Ota-ona rozilik tasdiqi (APPROVE/REJECT)" })
  async submitConsent(
    @Body() body: { token: string; action: ConsentAction },
    @Req() req: Request,
  ) {
    await this._consentIpRateCheck(req);
    if (!body?.token) throw new BadRequestException("Token kerak");
    if (body.action !== "APPROVE" && body.action !== "REJECT") {
      throw new BadRequestException("action APPROVE yoki REJECT bo'lishi kerak");
    }
    return this.consentService.confirmByToken(body.token, body.action);
  }

  // ── Klub CRUD ─────────────────────────────────────────────────────────────

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Jadidlar izidan klubi yaratish" })
  createClub(
    @Body() body: {
      name: string;
      institutionId: string;
      leaderId: string;
      goal?: number;
      description?: string;
    }
  ) {
    return this.clubService.createClub(body);
  }

  @Get()
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Klublar ro'yhati" })
  @ApiQuery({ name: "institutionId", required: false })
  @ApiQuery({ name: "tumanId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  listClubs(
    @Query("institutionId") institutionId?: string,
    @Query("tumanId") tumanId?: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    return this.clubService.listClubs({
      institutionId,
      tumanId,
      status,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0
    });
  }

  @Get("inactive")
  @Roles(...REGION_ADMINS)
  @ApiOperation({ summary: "Faolsiz klublar (45+ kun debat yo'q)" })
  @ApiQuery({ name: "tumanId", required: true })
  @ApiQuery({ name: "inactiveDays", required: false })
  getInactiveClubs(
    @Query("tumanId") tumanId: string,
    @Query("inactiveDays") inactiveDays?: string
  ) {
    return this.clubService.getInactiveClubs(tumanId, inactiveDays ? Number(inactiveDays) : 45);
  }

  @Get(":id")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Klub ma'lumoti" })
  getClub(@Param("id") id: string) {
    return this.clubService.getClub(id);
  }

  // IDOR-H12 — KLUB_RAHBARI may only update THEIR OWN club (ownership asserted
  // in the service); admin tiers are institution-scoped.
  @Patch(":id")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.KLUB_RAHBARI)
  @ApiOperation({ summary: "Klub ma'lumotlarini yangilash (faqat o'z klubi yoki admin)" })
  async updateClub(
    @Param("id") id: string,
    @Body() body: { name?: string; goal?: number; description?: string; status?: string },
    @CurrentUser() payload: JwtPayload
  ) {
    const actor = await this.resolveScopedUser(payload);
    return this.clubService.updateClub(actor, id, body);
  }

  // ── Monitoring ────────────────────────────────────────────────────────────

  @Get(":id/monitoring")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Klub monitoring paneli — faollik, debatlar, a'zolar statistika" })
  getMonitoring(@Param("id") id: string) {
    return this.clubService.getClubMonitoring(id);
  }

  @Get(":id/goal-progress")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "20 kitob maqsadi — har a'zo progressi" })
  getGoalProgress(@Param("id") id: string) {
    return this.clubService.getGoalProgress(id);
  }

  // ── A'zolik ───────────────────────────────────────────────────────────────

  @Get(":id/members")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Klub a'zolari (RI va kitoblar soni bilan)" })
  getMembers(@Param("id") id: string) {
    return this.clubService.getMembers(id);
  }

  // IDOR-H12 — ownership/scope asserted in the service. NOTE: body.userId here
  // is the MEMBER being added (the target), not the actor — it legitimately
  // stays in the body (a leader adds a student, never "adds themselves").
  @Post(":id/members")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.KLUB_RAHBARI)
  @ApiOperation({ summary: "Klubga a'zo qo'shish (18 yoshgacha ota-ona SMS yuboriladi; faqat o'z klubi)" })
  async addMember(
    @Param("id") clubId: string,
    @Body() body: { userId: string; parentPhone?: string },
    @CurrentUser() payload: JwtPayload
  ) {
    const actor = await this.resolveScopedUser(payload);
    return this.clubService.addMember(actor, clubId, body.userId, body.parentPhone);
  }

  // IDOR-H12 — the member's club is resolved server-side and ownership asserted.
  @Post("members/:memberId/consent")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Ota-ona roziligini tasdiqlash (faqat o'z klubi yoki admin)" })
  async confirmConsent(
    @Param("memberId") memberId: string,
    @Body() body: { parentPhone: string },
    @CurrentUser() payload: JwtPayload
  ) {
    const actor = await this.resolveScopedUser(payload);
    return this.clubService.confirmParentConsent(actor, memberId, body.parentPhone);
  }

  @Delete(":id/members/:userId")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.KLUB_RAHBARI)
  @ApiOperation({ summary: "A'zoni klubdan chiqarish (faqat o'z klubi yoki admin)" })
  async removeMember(
    @Param("id") clubId: string,
    @Param("userId") userId: string,
    @CurrentUser() payload: JwtPayload
  ) {
    const actor = await this.resolveScopedUser(payload);
    return this.clubService.removeMember(actor, clubId, userId);
  }

  // ── Debatlar ──────────────────────────────────────────────────────────────

  // IDOR-H12 — recordedById comes from the JWT (service sets it to actor.id);
  // any recordedById a stale client still sends is silently ignored by
  // signature. KLUB_RAHBARI may only record debates for THEIR OWN club.
  @Post(":id/debates")
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN, UserRole.KLUB_RAHBARI)
  @ApiOperation({ summary: "Debat qayd etish (foto/video majburiy; faqat o'z klubi)" })
  async createDebate(
    @Param("id") clubId: string,
    @Body() body: {
      topic: string;
      heldAt: string;
      venue?: string;
      participants: number;
      summary?: string;
      mediaUrls?: string[];
    },
    @CurrentUser() payload: JwtPayload
  ) {
    const actor = await this.resolveScopedUser(payload);
    return this.clubService.createDebate(actor, {
      topic: body.topic,
      venue: body.venue,
      participants: body.participants,
      summary: body.summary,
      mediaUrls: body.mediaUrls,
      clubId,
      heldAt: new Date(body.heldAt)
    });
  }

  @Get(":id/debates")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Klub debatlari tarixi" })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "limit", required: false })
  getDebates(
    @Param("id") clubId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string
  ) {
    return this.clubService.getDebates(clubId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : 50
    });
  }

  // ── Plan 06-04 SCH-05 — Debate media upload + finalize ────────────────────

  @Post(":clubId/debates/:debateId/media")
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
    UserRole.MUASSASA_ADMIN,
    UserRole.KLUB_RAHBARI,
  )
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: DEBATE_MEDIA_MAX_BYTES, files: 1 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiOperation({
    summary: "Debat uchun media fayl yuklash (≤50MB, max 4 ta fayl per debat)",
  })
  async uploadDebateMedia(
    @Param("clubId") clubId: string,
    @Param("debateId") debateId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() payload: JwtPayload,
  ) {
    if (!file) throw new BadRequestException("Fayl topilmadi");
    const user = await this.resolveScopedUser(payload);
    return this.mediaService.uploadDebateMedia(user, clubId, debateId, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  @Patch(":clubId/debates/:debateId/finalize")
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
    UserRole.MUASSASA_ADMIN,
    UserRole.KLUB_RAHBARI,
  )
  @ApiOperation({ summary: "Debat DRAFT → PUBLISHED (≥1 media majburiy)" })
  async finalizeDebate(
    @Param("clubId") clubId: string,
    @Param("debateId") debateId: string,
    @CurrentUser() payload: JwtPayload,
  ) {
    const user = await this.resolveScopedUser(payload);
    return this.mediaService.finalizeDebate(user, clubId, debateId);
  }

  @Get(":clubId/debates/:debateId/media")
  @Roles(...CLUB_ADMINS)
  @ApiOperation({ summary: "Debat media ro'yhati (presigned URL, 1h TTL)" })
  async listDebateMedia(
    @Param("clubId") clubId: string,
    @Param("debateId") debateId: string,
    @CurrentUser() payload: JwtPayload,
  ) {
    const user = await this.resolveScopedUser(payload);
    return this.mediaService.listDebateMedia(user, clubId, debateId);
  }
}
