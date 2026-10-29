import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import * as QRCode from "qrcode";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { BooksService } from "../books/books.service";

/**
 * TZ §VIII.1 (QR kod dinamik) + §XV.R22 (skrinshot soxtalash) — foydalanuvchi
 * kutubxona QR kodi endi AYLANUVCHI: har 5 daqiqada yangi token, HMAC-SHA256
 * imzo. Skrinshot qilingan QR keyingi oynada o'z-o'zidan eskiradi.
 *
 * Naqsh to'g'ridan-to'g'ri reading-hour.service.ts dan ko'chirilgan
 * (Plan 06-06 ORG-03 dagi isbotlangan implementatsiya):
 *   - 5 daqiqalik oyna (window bucket = floor(now / 300_000)).
 *   - Verify JORIY va OLDINGI oynani qabul qiladi (soat siljishi / aynan
 *     oyna chegarasida skan qilish uchun grace).
 *   - crypto.timingSafeEqual — hech qachon `===` emas.
 *   - Productionda secret YO'Q bo'lsa servis ko'tarilmaydi (fail-closed);
 *     devda fallback konstanta + ogohlantirish log.
 *   - Eskirgan/buzuq token → 400, sababi oshkor qilinmaydi (bitta xabar).
 *
 * Token formati: `${base64url(JSON{u: userId, w: windowBucket})}.${hmacHex}`
 * HMAC `${userId}|${windowBucket}` ustidan olinadi — payload ichidagi `u`
 * almashtirilsa imzo mos kelmaydi.
 *
 * Legacy muvofiqlik: eski bosma kartalardagi statik sifatId ham resolveToken
 * orqali ishlaydi, lekin javob `tokenType: "static"` bayrog'i bilan qaytadi —
 * UI kutubxonachiga "yangilanuvchi QR so'rang" deb ko'rsatadi.
 */

const QR_WINDOW_MS = 5 * 60 * 1000; // 5 daqiqalik rotatsiya (TZ §VIII.1)
const DEV_FALLBACK_SECRET = "dev-user-qr-token-secret-rotateMe";
const INVALID_TOKEN_MESSAGE = "QR muddati tugagan — yangilang";

export interface IssuedQrToken {
  token: string;
  expiresInSeconds: number;
  expiresAt: Date;
  windowSeconds: number;
}

export interface RotatingQrResponse extends IssuedQrToken {
  sifatId: string;
  /** Data URL — QR rasm, payload: JSON {"t": token} */
  qrCode: string;
  tokenType: "rotating";
}

/** /books/scan/:sifatId bilan AYNAN bir xil foydalanuvchi payload shakli. */
export type ResolvedQrUser = Awaited<
  ReturnType<BooksService["scanUserQr"]>
> & { tokenType: "rotating" | "static" };

@Injectable()
export class QrTokenService {
  private readonly logger = new Logger(QrTokenService.name);
  private readonly secret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly books: BooksService,
  ) {
    this.secret =
      this.config.get<string>("QR_TOKEN_SECRET") ?? DEV_FALLBACK_SECRET;
    if (this.secret === DEV_FALLBACK_SECRET) {
      if (process.env.NODE_ENV === "production") {
        // Fail-CLOSED prodda — reading-hour QR_HMAC_SECRET bilan bir xil siyosat.
        throw new Error("QR_TOKEN_SECRET must be set in production");
      }
      this.logger.warn(
        "QR_TOKEN_SECRET o'rnatilmagan — dev fallback secret ishlatilmoqda (faqat development uchun)",
      );
    }
  }

  // ── Oyna va imzo ──────────────────────────────────────────────────────────

  /** Window bucket = floor(now / 300s). */
  private currentWindow(now = Date.now()): number {
    return Math.floor(now / QR_WINDOW_MS);
  }

  private sign(userId: string, windowBucket: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${userId}|${windowBucket}`)
      .digest("hex");
  }

  // ── Token chiqarish ──────────────────────────────────────────────────────

  /** Joriy 5 daqiqalik oyna uchun imzolangan token. */
  issueToken(userId: string): IssuedQrToken {
    const now = Date.now();
    const windowBucket = this.currentWindow(now);
    const payloadB64 = Buffer.from(
      JSON.stringify({ u: userId, w: windowBucket }),
      "utf8",
    ).toString("base64url");
    const token = `${payloadB64}.${this.sign(userId, windowBucket)}`;
    const expiresAtMs = (windowBucket + 1) * QR_WINDOW_MS;
    return {
      token,
      expiresAt: new Date(expiresAtMs),
      expiresInSeconds: Math.max(1, Math.floor((expiresAtMs - now) / 1000)),
      windowSeconds: QR_WINDOW_MS / 1000,
    };
  }

  /**
   * GET /users/me/qr javobi: token + tayyor QR rasm (Data URL).
   * QR payload ataylab kichik: {"t": "<token>"} — skan sahifasi shu kalitni
   * o'qiydi. `sifatId` esa frontendga oflayn-statik fallback chizish uchun
   * kerak (komponent oflaynda legacy {"id": sifatId} QR yasaydi).
   */
  async issueQrForUser(userId: string): Promise<RotatingQrResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { sifatId: true },
    });
    if (!user?.sifatId) {
      throw new NotFoundException("SifatID hali belgilanmagan");
    }
    const issued = this.issueToken(userId);
    const qrCode = await QRCode.toDataURL(
      JSON.stringify({ t: issued.token }),
      {
        width: 300,
        margin: 2,
        color: { dark: "#1e40af", light: "#ffffff" },
      },
    );
    return { sifatId: user.sifatId, qrCode, tokenType: "rotating", ...issued };
  }

  // ── Token tekshirish ─────────────────────────────────────────────────────

  /**
   * HMAC ni JORIY yoki OLDINGI oynaga nisbatan tekshiradi (timingSafeEqual).
   * Har qanday muvaffaqiyatsizlik → 400 + bitta xabar (sabab oshkor emas).
   */
  verifyToken(token: string): { userId: string; windowBucket: number } {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const [payloadB64, providedHmac] = parts;

    let payload: { u?: unknown; w?: unknown };
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      );
    } catch {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    if (typeof payload.u !== "string" || !Number.isInteger(payload.w)) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    const userId = payload.u;
    const windowBucket = payload.w as number;

    const current = this.currentWindow();
    // Faqat joriy YOKI oldingi oyna — undan eski (yoki kelajak) rad etiladi.
    if (windowBucket !== current && windowBucket !== current - 1) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    const expectedHmac = this.sign(userId, windowBucket);
    let providedBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      providedBuf = Buffer.from(providedHmac, "hex");
      expectedBuf = Buffer.from(expectedHmac, "hex");
    } catch {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    if (providedBuf.length !== expectedBuf.length) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    return { userId, windowBucket };
  }

  // ── Skaner oqimi uchun yechish ───────────────────────────────────────────

  /**
   * POST /users/qr/resolve markazi.
   *
   * - Aylanuvchi token (ichida "." bor) → HMAC tekshiruv → foydalanuvchi
   *   BooksService.scanUserQr orqali olinadi (skan oqimi bugun iste'mol
   *   qiladigan AYNAN shu payload — yagona manba, shakl ikkilanmaydi).
   * - Aks holda legacy statik sifatId (eski bosma kartalar) → o'sha lookup,
   *   lekin tokenType: "static" — UI yangilanuvchi QR ga undaydi.
   */
  async resolveToken(rawToken: string): Promise<ResolvedQrUser> {
    const token = (rawToken ?? "").trim();
    if (!token) {
      throw new BadRequestException(INVALID_TOKEN_MESSAGE);
    }

    if (token.includes(".")) {
      const { userId } = this.verifyToken(token);
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { sifatId: true },
      });
      if (!user?.sifatId) {
        throw new NotFoundException("Foydalanuvchi topilmadi");
      }
      const resolved = await this.books.scanUserQr(user.sifatId);
      return { ...resolved, tokenType: "rotating" };
    }

    // Legacy statik yo'l — eski bosma kartalar ishlashda davom etadi (TZ b-comp).
    const resolved = await this.books.scanUserQr(token);
    return { ...resolved, tokenType: "static" };
  }
}
