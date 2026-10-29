import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  Logger
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { SmsService } from "../../infra/sms/sms.service";
import { CacheService } from "../../infra/cache/cache.service";

const OTP_TTL_MS              = 2 * 60 * 1000;   // 2 daqiqa
const OTP_MAX_ATTEMPTS        = 5;
const REFRESH_TTL_DAYS        = 30;
const OTP_RATE_LIMIT_PER_HOUR = 5;
const OTP_RATE_WINDOW_SEC     = 60 * 60;         // 1 soat (rate-limit oynasi)
const BCRYPT_ROUNDS           = 12;
// C1 fix: verifyOtp dan keyin parol o'rnatish/tiklash uchun beriladigan
// server-side marker muddati. Marker bir martalik — ishlatilgach o'chiriladi.
const OTP_VERIFIED_TTL_SEC    = 10 * 60;         // 10 daqiqa

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
    private readonly cache: CacheService
  ) {}

  // ── DEV OTP BYPASS ───────────────────────────────────────────────────
  // Fail-CLOSED allowlist: bypass is ONLY active when NODE_ENV is explicitly
  // one of the known dev/test values. Any other value (production, staging,
  // unset, capitalized, typo) falls through to the real OTP path. This protects
  // against case-mismatched/missing NODE_ENV in misconfigured prod containers.
  private isOtpBypassed(): boolean {
    const enabled = this.config.get<string>('DEV_OTP_BYPASS') === 'true' || process.env.DEV_OTP_BYPASS === 'true';
    const env = (process.env.NODE_ENV || '').toLowerCase().trim();
    const isDevOrTest = env === 'development' || env === 'test' || env === 'dev';
    return enabled && isDevOrTest;
  }

  // ── Telefon normalize ────────────────────────────────────────────────
  private normalizePhone(phone: string): string {
    let p = phone.replace(/[\s\-\(\)]/g, "");
    if (!p.startsWith("+")) p = "+" + p;
    return p;
  }

  // ── Refresh token hash (AUDIT-REPORT M4) ─────────────────────────────
  // Refresh tokenlar bazada OCHIQ matnda saqlanardi — DB sizib chiqsa
  // hujumchi 30 kunlik sessiyalarni to'g'ridan-to'g'ri o'g'irlay olardi.
  // Endi faqat sha256 hex saqlanadi va qidiruv ham hash bo'yicha bo'ladi;
  // mijozga esa avvalgidek xom token qaytariladi.
  private hashRefreshToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  // ── OTP timing-safe taqqoslash ───────────────────────────────────────
  // `record.code !== code` belgima-belgi taqqoslash vaqti orqali kodni
  // taxmin qilishga imkon berardi. timingSafeEqual teng uzunlikdagi
  // buferlar talab qiladi — uzunlik avval tekshiriladi (uzunlik farqi
  // o'z-o'zidan "noto'g'ri kod" degani, sir oshkor qilmaydi).
  private isOtpCodeMatch(expected: string, provided: string): boolean {
    const expectedBuf = Buffer.from(expected, "utf8");
    const providedBuf = Buffer.from(provided, "utf8");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  // ── OTP tasdiqlangan marker (C1 fix) ─────────────────────────────────
  // resetPassword va completeRegister telefon egaligini ISBOTSIZ qabul
  // qilmasligi kerak — aks holda istalgan akkauntni egallab olish mumkin.
  // verifyOtp muvaffaqiyatli o'tgachgina Redis ga qisqa muddatli (10 daqiqa)
  // marker yoziladi; parol o'rnatuvchi endpointlar shu markerni TALAB qiladi
  // va muvaffaqiyatli yakunda BIR MARTA ishlatib o'chiradi (single-use).
  // OTP kodlar Prisma da saqlanadi, lekin marker uchun Redis (CacheService)
  // tanlandi: TTL avtomatik, rate-limit allaqachon shu Redis ga bog'liq va
  // Redis ishlamasa marker o'qilmaydi → fail-closed (403).
  private otpVerifiedKey(phone: string): string {
    return `otp:verified:${phone}`;
  }

  private async markOtpVerified(phone: string): Promise<void> {
    await this.cache.set(this.otpVerifiedKey(phone), "1", OTP_VERIFIED_TTL_SEC);
  }

  private async requireOtpVerified(phone: string): Promise<void> {
    const marker = await this.cache.get<string>(this.otpVerifiedKey(phone));
    if (!marker) {
      throw new ForbiddenException(
        "Telefon raqam SMS kod orqali tasdiqlanmagan. Avval OTP kodni tasdiqlang."
      );
    }
  }

  private async consumeOtpVerified(phone: string): Promise<void> {
    await this.cache.del(this.otpVerifiedKey(phone));
  }

  // ── KIRISH: telefon + parol ──────────────────────────────────────────
  async login(
    rawPhone: string,
    password: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const phone = this.normalizePhone(rawPhone);

    const user = await this.prisma.user.findUnique({ where: { phone } });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Telefon raqam yoki parol noto'g'ri");
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException("Telefon raqam yoki parol noto'g'ri");
    }

    if (user.status === "BLOCKED") {
      throw new UnauthorizedException("Akkaunt bloklangan. Yordam uchun murojaat qiling.");
    }

    // O'chirilgan (soft-delete) akaunt kira olmaydi — admin akauntni
    // /admin/accounts orqali o'chirganda status DELETED bo'ladi.
    if (user.status === "DELETED") {
      throw new UnauthorizedException("Akkaunt o'chirilgan.");
    }

    this.logger.log(`Kirish: ${phone} [${user.role}]`);
    return this.generateTokenPair(user.id, user.phone, user.role);
  }

  // ── OTP YUBORISH (ro'yhat va parol tiklash uchun) ────────────────────
  async sendOtp(rawPhone: string, purpose: "register" | "reset" = "register"): Promise<{ message: string }> {
    const phone = this.normalizePhone(rawPhone);
    await this.checkRateLimit(phone);

    // M1 fix (user enumeration): telefon bazada bor-yo'qligi javob orqali
    // OSHKOR QILINMAYDI — ikkala holatda ham bir xil generik javob qaytadi.
    // SMS faqat mantiqan o'rinli bo'lganda yuboriladi:
    //   register → telefon allaqachon band bo'lsa SMS yuborilmaydi (jim skip)
    //   reset    → foydalanuvchi mavjud bo'lmasa SMS yuborilmaydi (jim skip)
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    const shouldSend = purpose === "register" ? !existing : Boolean(existing);

    if (!shouldSend) {
      this.logger.warn(`OTP yuborilmadi [${purpose}]: ${phone} — holat mos emas, generik javob qaytarildi`);
      return { message: "SMS yuborildi" };
    }

    if (this.isOtpBypassed()) {
      this.logger.warn(`[DEV_OTP_BYPASS] OTP send skipped for ${phone} (purpose=${purpose}). Use any 6-digit code (e.g. 000000) to verify.`);
      return { message: 'SMS yuborildi (dev bypass)' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await this.prisma.otpCode.upsert({
      where: { phone },
      create: { phone, code: otp, expiresAt, attempts: 0 },
      update: { code: otp, expiresAt, attempts: 0 }
    });

    await this.sms.sendOtp(phone, otp);
    this.logger.log(`OTP yuborildi [${purpose}]: ${phone}`);

    return { message: "SMS yuborildi" };
  }

  // ── OTP TEKSHIRISH (ro'yhat va parol tiklash uchun) ──────────────────
  async verifyOtp(rawPhone: string, code: string): Promise<{ verified: true; phone: string }> {
    const phone = this.normalizePhone(rawPhone);

    if (this.isOtpBypassed()) {
      this.logger.warn(`[DEV_OTP_BYPASS] OTP verify auto-accept for ${phone}`);
      // C1 fix: bypass rejimida ham marker yoziladi — completeRegister va
      // resetPassword dev muhitda ham xuddi shu oqim orqali ishlashi uchun.
      await this.markOtpVerified(phone);
      return { verified: true, phone };
    }

    const record = await this.prisma.otpCode.findUnique({ where: { phone } });

    if (!record)                              throw new BadRequestException("OTP topilmadi. Qayta yuborish tugmasini bosing.");
    if (record.attempts >= OTP_MAX_ATTEMPTS)  throw new BadRequestException("Juda ko'p noto'g'ri urinish. Yangi SMS oling.");
    if (record.expiresAt < new Date())        throw new BadRequestException("OTP muddati o'tgan. Qayta yuborish tugmasini bosing.");

    if (!this.isOtpCodeMatch(record.code, code)) {
      await this.prisma.otpCode.update({
        where: { phone },
        data: { attempts: { increment: 1 } }
      });
      const left = OTP_MAX_ATTEMPTS - record.attempts - 1;
      throw new BadRequestException(`Noto'g'ri kod. ${left} ta urinish qoldi.`);
    }

    // OTP to'g'ri — o'chiramiz
    await this.prisma.otpCode.delete({ where: { phone } });

    // C1 fix: tasdiqlangan telefon uchun qisqa muddatli marker yoziladi —
    // completeRegister/resetPassword faqat shu marker mavjud bo'lsa ishlaydi.
    await this.markOtpVerified(phone);
    this.logger.log(`OTP tasdiqlandi: ${phone}`);

    return { verified: true, phone };
  }

  // ── RO'YHAT YAKUNLASH: parol o'rnatish + foydalanuvchi yaratish ──────
  async completeRegister(
    rawPhone: string,
    password: string
  ): Promise<{ accessToken: string; refreshToken: string; isNewUser: true }> {
    const phone = this.normalizePhone(rawPhone);

    // C1 fix: OTP tasdig'isiz ro'yhat yakunlash MUMKIN EMAS. Marker tekshiruvi
    // boshqa barcha tekshiruvlardan OLDIN turadi — aks holda quyidagi xato
    // matnlari orqali akkaunt mavjudligini OTP siz aniqlash mumkin bo'lardi.
    await this.requireOtpVerified(phone);

    // Telefon hali ro'yhatdan o'tmagan bo'lishi kerak
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new BadRequestException("Bu telefon allaqachon ro'yhatdan o'tgan.");
    }

    this._validatePassword(password);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        phone,
        passwordHash,
        name: "",
        dob: new Date(),
        gender: "MALE",
        type: "CITIZEN",
        trustScore: 0
      }
    });

    // C1 fix: marker bir martalik — muvaffaqiyatli ro'yhatdan so'ng o'chiriladi.
    await this.consumeOtpVerified(phone);

    const tokens = await this.generateTokenPair(user.id, user.phone, user.role);
    return { ...tokens, isNewUser: true };
  }

  // ── PAROL TIKLASH: yangi parol o'rnatish ─────────────────────────────
  async resetPassword(
    rawPhone: string,
    newPassword: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const phone = this.normalizePhone(rawPhone);

    // C1 fix: OTP tasdig'isiz parol almashtirish MUMKIN EMAS — aks holda
    // istalgan akkauntni telefon raqamini bilish bilan egallab olish mumkin.
    await this.requireOtpVerified(phone);

    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new BadRequestException("Foydalanuvchi topilmadi.");

    this._validatePassword(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.user.update({
      where: { phone },
      data: { passwordHash }
    });

    // Barcha eski tokenlarni bekor qilish (xavfsizlik)
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true }
    });

    // C1 fix: marker bir martalik — muvaffaqiyatli tiklashdan so'ng o'chiriladi.
    await this.consumeOtpVerified(phone);

    this.logger.log(`Parol tiklandi: ${phone}`);
    const updatedUser = await this.prisma.user.findUniqueOrThrow({ where: { phone } });
    return this.generateTokenPair(updatedUser.id, updatedUser.phone, updatedUser.role);
  }

  // ── PAROL O'ZGARTIRISH (kirgan holatda) ──────────────────────────────
  // Vaqtinchalik parol bilan kirgan admin/xodim o'z parolini almashtiradi.
  // OTP shart emas — joriy (eski) parol bilan tasdiqlanadi.
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Foydalanuvchi topilmadi");
    }
    const ok = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!ok) {
      throw new BadRequestException("Joriy parol noto'g'ri");
    }
    this._validatePassword(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });
    this.logger.log(`Parol o'zgartirildi: ${user.phone}`);
  }

  // ── REFRESH TOKEN ROTATION ────────────────────────────────────────────
  async refreshToken(token: string): Promise<{ accessToken: string; refreshToken: string }> {
    // M4 — qidiruv mijoz yuborgan xom tokenning sha256 hex'i bo'yicha
    // (bazada faqat hash yotadi). Rotatsiya/bekor qilish mantig'i o'zgarmagan.
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: this.hashRefreshToken(token) }
    });

    if (!record || record.revoked || record.expiresAt < new Date())
      throw new UnauthorizedException("Refresh token noto'g'ri yoki muddati o'tgan");

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true }
    });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    return this.generateTokenPair(user.id, user.phone, user.role);
  }

  // ── CHIQISH ───────────────────────────────────────────────────────────
  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true }
    });
  }

  // ── Tashqi provayderlar uchun token (ID.UZ) ───────────────────────────
  async generateTokens(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, phone: true, role: true }
    });
    return this.generateTokenPair(user.id, user.phone, user.role);
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  private _validatePassword(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException("Parol kamida 8 ta belgidan iborat bo'lishi kerak.");
    }
  }

  private async generateTokenPair(
    userId: string,
    phone: string,
    role: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = { sub: userId, phone, role };
    // Algoritm qat'iy HS256 ga mahkamlangan — alg-confusion / "none"
    // hujumlariga qarshi (verify tomonida jwt-auth.guard ham HS256 ni pinlaydi).
    const accessToken = this.jwt.sign(payload, { expiresIn: "15m", algorithm: "HS256" });

    const refreshSecret = this.config.get<string>("JWT_REFRESH_SECRET");
    if (!refreshSecret && process.env.NODE_ENV === "production") {
      throw new Error("[FATAL] JWT_REFRESH_SECRET env o'zgaruvchisi production da ko'rsatilishi shart");
    }

    // `jti` — har bir refresh token uchun unikal identifikator.
    //
    // NEGA KERAK: JWT `iat` da faqat SONIYA aniqligi bor. Bu qo'shimchasiz,
    // bir xil foydalanuvchi bir soniya ichida ikki marta kirsa (ikkita qurilma,
    // "Kirish" tugmasini ikki marta bosish, yoki mobil ilova + brauzer),
    // imzolangan token BAYT-MA-BAYT bir xil chiqadi → sha256 hash ham bir xil
    // → `RefreshToken.token` unique constraint buziladi (P2002) va kirish
    // butunlay muvaffaqiyatsiz tugaydi. randomUUID har chaqiruvda tokenni
    // noyob qiladi, `iat` qanchalik yaqin bo'lishidan qat'i nazar.
    const rawRefresh = this.jwt.sign(
      { ...payload, jti: randomUUID() },
      {
        expiresIn: `${REFRESH_TTL_DAYS}d`,
        secret: refreshSecret ?? "dev-refresh-secret",
        algorithm: "HS256"
      }
    );

    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    // M4 — bazaga faqat sha256 hex yoziladi; xom token faqat mijozga ketadi.
    await this.prisma.refreshToken.create({
      data: { userId, token: this.hashRefreshToken(rawRefresh), expiresAt }
    });

    return { accessToken, refreshToken: rawRefresh };
  }

  // ── OTP rate limit (Redis atomik fixed-window) ───────────────────────────
  // In-memory Map o'rniga Redis INCR+EXPIRE ishlatiladi: server restart'dan
  // keyin saqlanadi va barcha replicalar o'rtasida bo'linadi (PITFALLS H3).
  private async checkRateLimit(phone: string): Promise<void> {
    const count = await this.cache.incrWithTtl(`otp:rl:${phone}`, OTP_RATE_WINDOW_SEC);
    if (count > OTP_RATE_LIMIT_PER_HOUR)
      throw new BadRequestException("Juda ko'p so'rov — 1 soatdan so'ng urinib ko'ring");
  }
}
