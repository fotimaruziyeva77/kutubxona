import {
  Controller,
  Get,
  Put,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { UserRole } from "@prisma/client";
import { UsersService, CompleteProfileDto, UpdateProfileDto } from "./users.service";
import { QrTokenService } from "./qr-token.service";
import { BadgeService, BADGE_CATALOG } from "../badge/badge.service";
import { PrivacyService } from "./privacy.service";
import { JwtAuthGuard, RolesGuard } from "../../common/guards";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import { RegisterFcmTokenDto } from "./dto/register-fcm-token.dto";
import { ResolveQrDto } from "./dto/resolve-qr.dto";

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly badge: BadgeService,
    private readonly privacyService: PrivacyService,
    private readonly qrToken: QrTokenService,
  ) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mening profilim" })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.getProfile(user.sub);
  }

  @Put("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Profilni yangilash" })
  updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.sub, dto);
  }

  @Post("me/complete-profile")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Profil to'ldirish (2-4 qadam)" })
  // M2 — body tipi endi to'g'ridan-to'g'ri class (avvalgi Omit<...> mapped
  // type runtime metatype ni Object ga aylantirib, ValidationPipe ni
  // o'chirib qo'yardi). userId hali ham faqat JWT sub dan olinadi.
  completeProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteProfileDto
  ) {
    return this.usersService.completeProfile({ ...dto, userId: user.sub });
  }

  /**
   * TZ §VIII.1 + R22 — endi AYLANUVCHI QR: javobda 5 daqiqalik HMAC-imzoli
   * token + shu tokenni kodlagan QR rasm (Data URL, payload {"t": token}).
   * Frontend muddat tugashidan ~30s oldin qayta so'raydi — skrinshot
   * qilingan QR keyingi oynada eskiradi. `sifatId` oflayn-statik fallback
   * uchun qaytariladi.
   */
  @Get("me/qr")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Aylanuvchi QR kod olish (5 daqiqalik token + Data URL)",
  })
  getQr(@CurrentUser() user: JwtPayload) {
    return this.qrToken.issueQrForUser(user.sub);
  }

  /**
   * TZ §VIII.1 + R22 — kutubxonachi skaneri uchun: aylanuvchi QR tokenni
   * foydalanuvchi payloadiga yechadi (/books/scan/:sifatId bilan bir xil
   * shakl). HMAC joriy YOKI oldingi 5-daqiqalik oynada timingSafeEqual
   * bilan tekshiriladi; eskirgan/buzuq token → 400 "QR muddati tugagan —
   * yangilang". Legacy statik sifatId ham qabul qilinadi (eski bosma
   * kartalar) — javob tokenType: "static" bayrog'i bilan farqlanadi.
   *
   * Rollar /books/scan bilan aynan bir xil: skanerlaydigan xodimlar.
   */
  @Post("qr/resolve")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "QR tokenni foydalanuvchiga yechish (kutubxonachi/admin)",
  })
  resolveQr(@Body() dto: ResolveQrDto) {
    return this.qrToken.resolveToken(dto.token);
  }

  /**
   * Plan 03-04 GAME-03 + D-5: foydalanuvchi badgelarini ikki bo'limda qaytaradi:
   * - earned: UserBadge satrlari (awardedAt bilan), tarixiy katalog metadatasi
   *   joinlangan
   * - available: katalogdagi qolgan (hali olinmagan) badgelar
   *
   * Frontend BadgesGrid komponenti ikki tab — Earned + Available — sifatida
   * render qiladi (per RESEARCH §GAME-03 D-5 user decision).
   */
  @Get("me/badges")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mening badgelarim (earned + available)" })
  async getMyBadges(@CurrentUser() user: JwtPayload) {
    const earned = await this.badge.getUserBadges(user.sub);
    const earnedCodes = new Set(
      earned.map((e) => (e as unknown as { badge: { code: string } }).badge.code),
    );
    const available = BADGE_CATALOG.filter((b) => !earnedCodes.has(b.code));
    return { earned, available };
  }

  // ── Plan 07-02 PERF-06 — Privacy endpoints ─────────────────────────────────

  @Get("me/privacy")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Maxfiylik sozlamalari (hideReadingHistory)" })
  getPrivacySettings(@CurrentUser() user: JwtPayload) {
    return this.privacyService.getPrivacySettings(user.sub);
  }

  @Patch("me/privacy")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Maxfiylik sozlamalarini yangilash" })
  updatePrivacy(
    @CurrentUser() user: JwtPayload,
    @Body() body: { hideReadingHistory: boolean },
  ) {
    return this.privacyService.toggleReadingHistoryVisibility(
      user.sub,
      body.hideReadingHistory,
    );
  }

  // ── Plan 05-04 Task 3 — FCM device-token endpoints (NOTIF-02) ─────────────

  @Post("me/device-tokens")
  @UseGuards(JwtAuthGuard)
  // 05-04-fix FIX A Layer 1 — device-token flood guard. Legitimate
  // browser/mobile re-installs at most a handful of times per hour;
  // 10/hour/(IP+user) shuts down automated registration loops.
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "FCM token ro'yhatdan o'tkazish (web/android/ios)" })
  registerFcmToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterFcmTokenDto,
  ) {
    return this.usersService.upsertFcmToken({
      userId: user.sub,
      token: dto.token,
      platform: dto.platform,
    });
  }

  @Delete("me/device-tokens/:id")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "FCM tokenni o'chirish (faqat o'z tokeningiz)",
  })
  async deleteFcmToken(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
  ): Promise<void> {
    // 404 used for both not-found AND wrong-owner per T-05-FCM-DELETE
    // (defense-in-depth — 403 would leak existence of other users' tokens).
    await this.usersService.deleteFcmToken(user.sub, id);
  }

  @Get("me/device-tokens")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mening FCM tokenlarim (token plaintext qaytarilmaydi)" })
  listMyFcmTokens(@CurrentUser() user: JwtPayload) {
    return this.usersService.listMyFcmTokens(user.sub);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Barcha foydalanuvchilar (admin)" })
  findAll(@Query("page") page = "1", @Query("limit") limit = "20") {
    return this.usersService.findAll(+page, +limit);
  }
}
