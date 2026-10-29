import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Res,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import type { Request, Response, CookieOptions } from "express";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  AUTH_LOGIN_TTL_MS,
  AUTH_LOGIN_LIMIT,
  AUTH_OTP_SEND_TTL_MS,
  AUTH_OTP_SEND_LIMIT,
  AUTH_OTP_VERIFY_TTL_MS,
  AUTH_OTP_VERIFY_LIMIT,
} from "../../common/config/throttle.const";
import { IsString, IsNotEmpty, Length, MinLength, IsIn } from "class-validator";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "../../common/guards";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";

// ── DTOs ────────────────────────────────────────────────────────────────────

class LoginDto {
  @IsString() @IsNotEmpty()
  phone!: string;

  @IsString() @IsNotEmpty() @MinLength(8)
  password!: string;
}

class SendOtpDto {
  @IsString() @IsNotEmpty()
  phone!: string;

  @IsString() @IsIn(["register", "reset"])
  purpose!: "register" | "reset";
}

class VerifyOtpDto {
  @IsString() @IsNotEmpty()
  phone!: string;

  @IsString() @IsNotEmpty() @Length(6, 6)
  code!: string;
}

class CompleteRegisterDto {
  @IsString() @IsNotEmpty()
  phone!: string;

  @IsString() @MinLength(8)
  password!: string;
}

class ResetPasswordDto {
  @IsString() @IsNotEmpty()
  phone!: string;

  @IsString() @MinLength(8)
  newPassword!: string;
}

class ChangePasswordDto {
  @IsString() @IsNotEmpty()
  oldPassword!: string;

  @IsString() @MinLength(8)
  newPassword!: string;
}

// ── INFRA-02 cookie helper ──────────────────────────────────────────────────
// HttpOnly refresh cookie scoped to /api/auth so it's only sent on auth
// endpoints (login, refresh, logout, register/complete, password/reset).
// SameSite=lax allows top-level navigation while blocking cross-site POST CSRF.
// secure: true in production (TLS-only); off in dev so localhost HTTP works.
// maxAge mirrors REFRESH_TTL_DAYS = 30 in auth.service.ts.
const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_PATH = "/api/auth";
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function refreshCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS
  };
}

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
}

function clearRefreshCookie(res: Response): void {
  // Clear with the same path so the browser actually evicts the right cookie.
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

// ── Controller ───────────────────────────────────────────────────────────────

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Kirish: telefon + parol ─────────────────────────────────────────────
  // INFRA-02: refreshToken → HttpOnly cookie (NOT in JSON body).
  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ strict: { ttl: AUTH_LOGIN_TTL_MS, limit: AUTH_LOGIN_LIMIT } })
  @ApiOperation({ summary: "Kirish: telefon + parol" })
  @ApiBody({ type: LoginDto })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const { accessToken, refreshToken } = await this.authService.login(
      dto.phone,
      dto.password
    );
    setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  // ── OTP yuborish (faqat ro'yhat va parol tiklash uchun) ─────────────────
  @Public()
  @Post("otp/send")
  @HttpCode(HttpStatus.OK)
  @Throttle({ strict: { ttl: AUTH_OTP_SEND_TTL_MS, limit: AUTH_OTP_SEND_LIMIT } })
  @ApiOperation({ summary: "OTP yuborish: purpose = 'register' | 'reset'" })
  @ApiBody({ type: SendOtpDto })
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto.phone, dto.purpose);
  }

  // ── OTP tasdiqlash ──────────────────────────────────────────────────────
  @Public()
  @Post("otp/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ strict: { ttl: AUTH_OTP_VERIFY_TTL_MS, limit: AUTH_OTP_VERIFY_LIMIT } })
  @ApiOperation({ summary: "OTP tasdiqlash — ro'yhat yoki parol tiklash uchun" })
  @ApiBody({ type: VerifyOtpDto })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.phone, dto.code);
  }

  // ── Ro'yhatni yakunlash: parol o'rnatish ───────────────────────────────
  // INFRA-02: refreshToken → HttpOnly cookie (NOT in JSON body).
  @Public()
  @Post("register/complete")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Ro'yhat yakunlash: OTP tasdiqlangandan so'ng parol o'rnatish" })
  @ApiBody({ type: CompleteRegisterDto })
  async completeRegister(
    @Body() dto: CompleteRegisterDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const { accessToken, refreshToken, isNewUser } =
      await this.authService.completeRegister(dto.phone, dto.password);
    setRefreshCookie(res, refreshToken);
    return { accessToken, isNewUser };
  }

  // ── Parol tiklash ──────────────────────────────────────────────────────
  // INFRA-02: refreshToken → HttpOnly cookie (NOT in JSON body).
  @Public()
  @Post("password/reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Parol tiklash: OTP tasdiqlangandan so'ng yangi parol" })
  @ApiBody({ type: ResetPasswordDto })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const { accessToken, refreshToken } = await this.authService.resetPassword(
      dto.phone,
      dto.newPassword
    );
    setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  // ── Refresh token (INFRA-02) ────────────────────────────────────────────
  // Reads the refresh token from req.cookies.refreshToken — NOT from the
  // request body. No DTO. The rotated refresh value is re-set on the cookie.
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Access token yangilash (refresh cookie orqali)" })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!cookieToken) {
      throw new UnauthorizedException("Refresh token cookie topilmadi");
    }
    const { accessToken, refreshToken } =
      await this.authService.refreshToken(cookieToken);
    setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  // ── Chiqish ────────────────────────────────────────────────────────────
  // Clears the HttpOnly refresh cookie in addition to revoking server-side.
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Chiqish — barcha refresh tokenlar bekor qilinadi" })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response
  ) {
    await this.authService.logout(user.sub);
    clearRefreshCookie(res);
    return { success: true };
  }

  // ── Parolni o'zgartirish (kirgan holatda, joriy parol bilan) ────────────
  @Post("password/change")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Parolni o'zgartirish — joriy parol bilan tasdiqlanadi" })
  @ApiBody({ type: ChangePasswordDto })
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto
  ) {
    await this.authService.changePassword(user.sub, dto.oldPassword, dto.newPassword);
    return { success: true };
  }
}
