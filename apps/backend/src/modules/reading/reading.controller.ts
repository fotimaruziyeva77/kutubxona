import {
  Controller, Get, Post, Body, Param, Query, UseGuards,
  Headers, UnauthorizedException, ForbiddenException, HttpCode, HttpStatus, Request
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiHeader } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { ReadingService } from "./reading.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";

const ADMIN_TIERS: ReadonlySet<string> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
]);

// P2 hygiene — individual RI endpointlari uchun ruxsat to'plami: o'zi YOKI
// xodim darajasi. transactions.controller dagi IDOR-C3 HISTORY_VIEWER_ROLES
// bilan bir xil (kutubxonachi kitobxonga xizmat ko'rsatayotganda uning RI
// sini ko'rishi mumkin; oddiy KITOBXON faqat o'zinikini).
const RI_VIEWER_ROLES: ReadonlySet<string> = new Set([
  ...ADMIN_TIERS,
  UserRole.KUTUBXONACHI,
]);

@ApiTags("reading")
@ApiBearerAuth()
@Controller("reading")
export class ReadingController {
  constructor(
    private readonly readingService: ReadingService,
    private readonly config: ConfigService
  ) {}

  // Ochiq endpointlar — leaderboard va individual index (@Public, INFRA-03)
  @Public()
  @Get("leaderboard")
  @ApiOperation({ summary: "Umumiy liderlar jadvali (Reading Index bo'yicha)" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  getLeaderboard(
    @Query("limit") limit = "50",
    @Query("offset") offset = "0"
  ) {
    // TOP-08: forward BOTH params so SQL pagination works (no in-memory slice).
    return this.readingService.getLeaderboard(Number(limit), Number(offset));
  }

  // P2 hygiene — bu endpoint avval @Public edi: istalgan anonim odam
  // istalgan foydalanuvchining RI sini (va hideReadingHistory sozlamasini
  // chetlab) ko'ra olardi. Endi auth majburiy: o'zi YOKI xodim darajasi
  // (transactions.controller dagi getUserHistory IDOR-C3 gating bilan
  // bir xil naqsh).
  @Get(":userId")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Foydalanuvchi Reading Index (o'zi yoki xodim)" })
  getIndex(
    @Param("userId") userId: string,
    @Request() req: { user: { sub: string; role: string } }
  ) {
    this.assertSelfOrStaff(userId, req.user);
    return this.readingService.getReadingIndex(userId);
  }

  // P2 hygiene — :userId bilan bir xil ma'lumot sinfi (12 oylik individual
  // RI tarixi), shuning uchun bir xil self-or-staff gating qo'llanadi.
  @Get(":userId/history")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Reading Index tarixi (12 oy, o'zi yoki xodim)" })
  getHistory(
    @Param("userId") userId: string,
    @Request() req: { user: { sub: string; role: string } }
  ) {
    this.assertSelfOrStaff(userId, req.user);
    return this.readingService.getHistory(userId);
  }

  private assertSelfOrStaff(userId: string, me: { sub: string; role: string }): void {
    const isSelf = me.sub === userId;
    const isStaff = RI_VIEWER_ROLES.has(me.role);
    if (!isSelf && !isStaff) {
      throw new ForbiddenException("Faqat o'z Reading Index ingizni ko'rishingiz mumkin");
    }
  }

  // ── RI-04 (Plan 02-04): delta endpoint ──────────────────────────────────
  // Returns { daily, weekly, monthly } — each window has
  // {current, prev, delta, pct}. Cached 1h in Redis. Authorization: self
  // (me.sub === userId) OR admin (SUPER/VILOYAT/TUMAN/MUASSASA).
  @Get(":userId/delta")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "RI delta (kunlik / haftalik / oylik)" })
  async getDelta(
    @Param("userId") userId: string,
    @Request() req: { user: { sub: string; role: string } }
  ) {
    const isSelf = req.user.sub === userId;
    const isAdmin = ADMIN_TIERS.has(req.user.role);
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException("Faqat o'z RI delta sini ko'rish mumkin");
    }
    return this.readingService.computeDelta(userId);
  }

  // Himoyalangan endpointlar
  @Post(":userId/recalculate")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: "Reading Index qayta hisoblash (manual trigger, faqat Super Admin)" })
  recalculate(@Param("userId") userId: string) {
    return this.readingService.recalculateForUser(userId);
  }

  @Post(":userId/mutolaa-sync")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Mutolaa platformasidan o'qish progressini sinxronlash" })
  syncMutolaa(
    @Param("userId") userId: string,
    @Body() body: { isbn: string; pagesRead: number; totalPages: number }
  ) {
    return this.readingService.syncMutolaaProgress(
      userId,
      body.isbn,
      body.pagesRead,
      body.totalPages
    );
  }

  // ── Mutolaa Server-to-Server Webhook ────────────────────────────────────────
  // Bu endpoint Mutolaa.uz platformasi tomonidan chaqiriladi.
  // Autentifikatsiya: HMAC-SHA256 imzo + X-Mutolaa-Signature header.
  // Format: "sha256=<hex>" — GitHub webhook style.
  @Public()
  @Post("webhook/mutolaa")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Mutolaa.uz webhook — server-to-server o'qish sinxronlash" })
  @ApiHeader({ name: "X-Mutolaa-Signature", required: true, description: "HMAC-SHA256 imzo: sha256=<hex>" })
  @ApiHeader({ name: "X-Mutolaa-Delivery", required: false, description: "Webhook yetkazish ID (idempotency)" })
  async mutolaaWebhook(
    @Headers("x-mutolaa-signature") signature: string,
    @Headers("x-mutolaa-delivery") deliveryId: string | undefined,
    @Body() payload: {
      events: Array<{
        userId: string;
        isbn: string;
        pagesRead: number;
        totalPages: number;
        readAt?: string;
      }>;
    }
  ) {
    // ── HMAC imzo tekshiruvi ─────────────────────────────────────────────────
    const secret = this.config.get<string>("MUTOLAA_WEBHOOK_SECRET") ?? "";

    if (!signature || !signature.startsWith("sha256=")) {
      throw new UnauthorizedException("X-Mutolaa-Signature header kerak (sha256=...)");
    }

    const expectedHmac = createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");
    const expected = `sha256=${expectedHmac}`;

    // Constant-time comparison — timing attack dan himoya
    // sha256=<64 hex> = 71 belgi har doim — uzunlik tekshiruvi qo'shimcha himoya
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    const isValid =
      sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
    if (!isValid) {
      throw new UnauthorizedException("Noto'g'ri webhook imzosi");
    }

    // ── Event lar qayta ishlash ──────────────────────────────────────────────
    const results: Array<{ userId: string; isbn: string; result: unknown }> = [];

    for (const event of payload.events ?? []) {
      try {
        const result = await this.readingService.syncMutolaaProgress(
          event.userId,
          event.isbn,
          event.pagesRead,
          event.totalPages
        );
        results.push({ userId: event.userId, isbn: event.isbn, result });
      } catch {
        results.push({ userId: event.userId, isbn: event.isbn, result: { error: "skipped" } });
      }
    }

    return {
      received: true,
      deliveryId: deliveryId ?? null,
      processed: results.length,
      results
    };
  }
}
