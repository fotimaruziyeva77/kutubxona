import {
  Controller, Get, Post, Query, Body, Req, Res, HttpStatus, Logger,
} from "@nestjs/common";
import type { Request, Response, CookieOptions } from "express";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { IduzService } from "./iduz.service";
import { AuthService } from "./auth.service";
import { Public } from "../../common/decorators/public.decorator";

/**
 * OneID (sso.egov.uz) OAuth2.0 + PKCE oqimi.
 *
 * @Public() — bu marshrutlar global JwtAuthGuard tomonidan token talab
 * qilinmasligi kerak (foydalanuvchi hali kirmagan).
 *
 * CSRF himoyasi: `/authorize` da `iduz_state` HttpOnly cookie qo'yiladi.
 * `/callback` da qaytib kelgan `state` shu cookie qiymati bilan timing-safe
 * taqqoslanadi (oldingi versiya client-supplied `expected_state` body
 * maydoniga ishonardi — bu T-06-01 spoofing zaifligi edi).
 */
const IDUZ_STATE_COOKIE = "iduz_state";
const IDUZ_STATE_MAX_AGE_MS = 5 * 60 * 1000; // 5 daqiqa

// P2 hygiene fix — cookie path AVVAL "/auth/iduz" edi, lekin main.ts dagi
// setGlobalPrefix("api") tufayli haqiqiy marshrut /api/auth/iduz/callback.
// Path mos kelmagani uchun brauzer cookie ni callback ga HECH QACHON
// yubormasdi → CSRF state tekshiruvi har doim 401 bilan yiqilardi.
const IDUZ_STATE_COOKIE_PATH = "/api/auth/iduz";

function iduzStateCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: IDUZ_STATE_MAX_AGE_MS,
    // OneID callback /api/auth/iduz/callback da kelgan cookie ni o'qishi
    // kerak, shuning uchun path global "api" prefiksi BILAN cheklanadi.
    path: IDUZ_STATE_COOKIE_PATH,
  };
}

@ApiTags("auth/iduz")
@Controller("auth/iduz")
export class IduzController {
  private readonly logger = new Logger(IduzController.name);

  constructor(
    private readonly iduz: IduzService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Qadam 1: OneID authorization URL yaratish.
   * Frontend bu URL ga foydalanuvchini yo'naltiradi va `iduz_state` cookie
   * orqali CSRF state ni server yodida tutadi.
   */
  @Public()
  @Get("authorize")
  @ApiOperation({ summary: "OneID login URL yaratish (PKCE)" })
  @ApiQuery({ name: "code_challenge", required: true, description: "SHA256 hash of code_verifier (Base64URL)" })
  authorize(
    @Query("code_challenge") codeChallenge: string,
    @Res() res: Response,
  ) {
    const state = this.iduz.generateState();
    const url = this.iduz.buildAuthUrl(state, codeChallenge);

    res.cookie(IDUZ_STATE_COOKIE, state, iduzStateCookieOptions());

    // `state` ni javobda ham qaytaramiz — frontend kuzatish uchun
    // (CSRF tekshiruvi cookie ga asoslangan, body ga emas).
    return res.status(HttpStatus.OK).json({ url, state });
  }

  /**
   * Qadam 2: OneID callback — `code` va `state` bilan keladi.
   *
   * CSRF tekshiruvi: callback dagi `state` ↔ `iduz_state` HttpOnly cookie.
   * `code_verifier` ni frontend body orqali yuboradi (PKCE).
   */
  @Public()
  @Post("callback")
  @ApiOperation({ summary: "OneID callback: code ni tokenga almashtirish" })
  async callback(
    @Body() body: {
      code: string;
      state: string;
      code_verifier: string;
    },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // CSRF: state cookie dan o'qiladi, body ga ishonmaymiz.
    const cookieState = (req.cookies?.[IDUZ_STATE_COOKIE] ?? "") as string;
    if (!cookieState || !this.iduz.verifyState(body.state, cookieState)) {
      this.logger.warn(`OneID callback: CSRF state mismatch`);
      // Foydalanilgan cookie ni darhol tozalaymiz.
      res.clearCookie(IDUZ_STATE_COOKIE, { path: IDUZ_STATE_COOKIE_PATH });
      return res.status(HttpStatus.UNAUTHORIZED).json({
        message: "Noto'g'ri state — CSRF xatosi",
      });
    }

    // One-shot: muvaffaqiyatli tekshiruvdan keyin cookie ni o'chiramiz
    res.clearCookie(IDUZ_STATE_COOKIE, { path: IDUZ_STATE_COOKIE_PATH });

    // Token olish
    const tokens = await this.iduz.exchangeCode(body.code, body.code_verifier);

    // Foydalanuvchi ma'lumotlari
    const userInfo = await this.iduz.getUserInfo(tokens.access_token);

    // Platformada login yoki ro'yhat
    const { userId, isNew } = await this.iduz.loginOrRegister(userInfo);

    // Platforma JWT yaratish
    const { accessToken, refreshToken } = await this.auth.generateTokens(userId);

    this.logger.log(`OneID ${isNew ? "yangi ro'yhat" : "login"}: ${userId}`);

    // Refresh token — Plan 01-04 pattern (HttpOnly cookie, /api/auth scoped).
    // Auth flow refresh cookie path bilan moslashish uchun shu yerda ham xuddi shunday.
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/api/auth",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.status(HttpStatus.OK).json({
      accessToken,
      isNew,
      userId,
    });
  }
}
