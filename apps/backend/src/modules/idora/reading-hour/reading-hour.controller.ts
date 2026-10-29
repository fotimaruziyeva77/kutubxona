import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { ReadingHourService } from "./reading-hour.service";
import { ReadingHourMediaService } from "./media/reading-hour-media.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { Roles } from "../../../common/decorators/roles.decorator";
import {
  CurrentUser,
  JwtPayload,
} from "../../../common/decorators/current-user.decorator";
import type { InstitutionScopedUser } from "../../../common/utils/admin-scope.util";

/**
 * Plan 06-06 ORG-03 — Reading Hour endpoints.
 *
 * Routes:
 *   POST   /idora/:institutionId/reading-hours             (HR_ADMIN+) — create DRAFT event
 *   GET    /idora/:institutionId/reading-hours             — list (filterable by month/status)
 *   GET    /idora/:institutionId/reading-hours/:eventId    — detail + attendees + media
 *   POST   /idora/:institutionId/reading-hours/:eventId/qr — generate rotating QR token (HR_ADMIN+)
 *   POST   /idora/:institutionId/reading-hours/:eventId/media (HR_ADMIN+) — upload photo/video
 *   GET    /idora/:institutionId/reading-hours/:eventId/media — presigned URLs
 *   PATCH  /idora/:institutionId/reading-hours/:eventId/finalize (HR_ADMIN+) — DRAFT→PUBLISHED
 *   DELETE /idora/:institutionId/reading-hours/:eventId    (HR_ADMIN+) — soft delete (DRAFT only unless SUPER_ADMIN)
 *
 *   POST   /reading-hours/:eventId/attend                  — public scan POST (any auth user)
 */

const HR_ROLES = [UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN] as const;
const VIEWERS = [
  UserRole.SUPER_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.BUXGALTER,
] as const;

@ApiTags("Idora — Reading Hour")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ReadingHourController {
  constructor(
    private readonly readingHour: ReadingHourService,
    private readonly readingHourMedia: ReadingHourMediaService,
    private readonly prisma: PrismaService,
  ) {}

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

  // ── CRUD ─────────────────────────────────────────────────────────────────

  @Post("idora/:institutionId/reading-hours")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Yangi kitob o'qish soati yaratish (DRAFT)" })
  async create(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      title?: string;
      heldAt: string;
      venue?: string;
      durationMin?: number;
      notes?: string;
    },
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.createReadingHour(institutionId, user.sub, body, scoped);
  }

  @Get("idora/:institutionId/reading-hours")
  @Roles(...VIEWERS)
  async list(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
    @Query("month") month?: string,
    @Query("status") status?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query("limit", new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.listReadingHours(
      institutionId,
      { month, status, page, limit },
      scoped,
    );
  }

  @Get("idora/:institutionId/reading-hours/summary")
  @Roles(...VIEWERS)
  async summary(
    @Param("institutionId") institutionId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.getReadingHoursSummary(institutionId, scoped);
  }

  @Get("idora/:institutionId/reading-hours/:eventId")
  @Roles(...VIEWERS)
  async detail(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.getReadingHourDetail(institutionId, eventId, scoped);
  }

  @Patch("idora/:institutionId/reading-hours/:eventId/finalize")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "DRAFT→PUBLISHED (≥1 media majburiy)" })
  async finalize(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.finalizeReadingHour(institutionId, eventId, scoped);
  }

  @Delete("idora/:institutionId/reading-hours/:eventId")
  @Roles(...HR_ROLES)
  async delete(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.deleteReadingHour(institutionId, eventId, scoped);
  }

  // ── QR token (rotates every 5 min) ───────────────────────────────────────

  @Post("idora/:institutionId/reading-hours/:eventId/qr")
  @Roles(...HR_ROLES)
  @ApiOperation({ summary: "Yangi QR token (5 daqiqada yangilanadi)" })
  async generateQr(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHour.generateQrToken(institutionId, eventId, scoped);
  }

  // ── Media upload (mirror Plan 06-04 debate-media) ────────────────────────

  @Post("idora/:institutionId/reading-hours/:eventId/media")
  @Roles(...HR_ROLES)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiOperation({ summary: "Foto/video yuklash (50MB cap, 4 fayl/tadbir)" })
  async uploadMedia(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHourMedia.uploadMedia(scoped, institutionId, eventId, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  @Get("idora/:institutionId/reading-hours/:eventId/media")
  @Roles(...VIEWERS)
  async listMedia(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHourMedia.listMedia(scoped, institutionId, eventId);
  }

  @Get(
    "idora/:institutionId/reading-hours/:eventId/media/:mediaId/signed-url",
  )
  @Roles(...VIEWERS)
  async signedUrl(
    @Param("institutionId") institutionId: string,
    @Param("eventId") eventId: string,
    @Param("mediaId") mediaId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const scoped = await this.resolveScopedUser(user);
    return this.readingHourMedia.getSignedUrl(scoped, institutionId, eventId, mediaId);
  }

  // ── Public scan attendance (any authenticated user) ──────────────────────

  @Post("reading-hours/:eventId/attend")
  @ApiOperation({ summary: "Public scan landing: QR token bilan qatnashish" })
  async attend(
    @Param("eventId") eventId: string,
    @Body() body: { token: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const u = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { id: true, organizationId: true, role: true },
    });
    if (!u) {
      // Should never happen — JwtAuthGuard verifies; defence-in-depth.
      return { error: "User not found" };
    }
    return this.readingHour.markAttendanceByToken(eventId, body?.token, {
      id: u.id,
      organizationId: u.organizationId,
      role: u.role,
    });
  }
}
