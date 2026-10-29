import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { AuthService } from "../auth.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

const mockPrisma = {
  otpCode: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  },
  user: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  refreshToken: {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  }
};

const mockJwt = {
  sign: jest.fn().mockReturnValue("mock-token"),
  verify: jest.fn()
};

const mockConfig = {
  get: jest.fn().mockReturnValue("dev-secret")
};

const mockSms = {
  sendOtp: jest.fn().mockResolvedValue(undefined)
};

// CacheService stub emulating an atomic fixed-window counter (Redis INCR+EXPIRE).
// Per-phone counts live in a Map; incrWithTtl returns the post-increment value.
const cacheCounters = new Map<string, number>();
// C1 fix: get/set/del store emulating Redis — the OTP-verified marker
// (otp:verified:<phone>) written by verifyOtp and consumed by
// completeRegister/resetPassword lives here.
const cacheStore = new Map<string, unknown>();
const mockCache = {
  incrWithTtl: jest.fn(async (key: string, _ttl: number) => {
    const next = (cacheCounters.get(key) ?? 0) + 1;
    cacheCounters.set(key, next);
    return next;
  }),
  get: jest.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  set: jest.fn(async (key: string, value: unknown, _ttl: number) => {
    cacheStore.set(key, value);
  }),
  del: jest.fn(async (key: string) => {
    cacheStore.delete(key);
  })
};

const makeService = () =>
  new AuthService(
    mockPrisma as unknown as PrismaService,
    mockJwt as unknown as JwtService,
    mockConfig as unknown as ConfigService,
    mockSms as unknown as SmsService,
    mockCache as unknown as CacheService
  );

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
    cacheCounters.clear();
    cacheStore.clear();
    // Clear DEV_OTP_BYPASS so it doesn't leak from .env into the standard
    // OTP-path tests. The "OTP bypass" describes re-set it explicitly.
    delete process.env.DEV_OTP_BYPASS;
  });

  // ── sendOtp ──────────────────────────────────────────────────────────────
  describe("sendOtp", () => {
    it("OTP upsert va SMS queue ga yuboradi", async () => {
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: "+998901234567" } })
      );
      expect(mockSms.sendOtp).toHaveBeenCalledWith("+998901234567", expect.any(String));
      expect(result).toEqual({ message: "SMS yuborildi" });
    });

    it("rate limitni Redis incrWithTtl orqali tekshiradi (in-memory Map emas)", async () => {
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      await service.sendOtp("+998901234567");
      expect(mockCache.incrWithTtl).toHaveBeenCalledWith("otp:rl:+998901234567", 3600);
    });

    it("rate limit: bir soatda 5 dan ortiq (6-chi) urinish rad etiladi", async () => {
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      for (let i = 0; i < 5; i++) await service.sendOtp("+998999999999");
      // 6-chi yuborish count > OTP_RATE_LIMIT_PER_HOUR bo'lib rad etiladi.
      await expect(service.sendOtp("+998999999999")).rejects.toThrow(BadRequestException);
    });

    it("generatsiya qilingan OTP uzunligi VerifyOtpDto @Length(6,6) ga mos — 6 xona", async () => {
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      await service.sendOtp("+998901111111");
      // upsert.create.code — generatsiya qilingan OTP
      const upsertArg = mockPrisma.otpCode.upsert.mock.calls[0][0];
      const generated = upsertArg.create.code as string;
      expect(generated).toHaveLength(6);
      expect(/^\d{6}$/.test(generated)).toBe(true);
    });

    // ── M1 fix: user enumeration himoyasi ──────────────────────────────────
    // Javob hech qachon akkaunt mavjudligini oshkor qilmaydi — ikkala holatda
    // ham bir xil generik { message: "SMS yuborildi" } qaytadi; SMS esa faqat
    // mantiqan o'rinli bo'lganda yuboriladi.
    it("M1: purpose='register' + telefon band — generik javob, SMS YUBORILMAYDI (xato emas)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "existing", phone: "+998901234567" });
      const result = await service.sendOtp("+998901234567", "register");
      expect(result).toEqual({ message: "SMS yuborildi" });
      expect(mockPrisma.otpCode.upsert).not.toHaveBeenCalled();
      expect(mockSms.sendOtp).not.toHaveBeenCalled();
    });

    it("M1: purpose='reset' + foydalanuvchi topilmadi — generik javob, SMS YUBORILMAYDI (xato emas)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.sendOtp("+998901234567", "reset");
      expect(result).toEqual({ message: "SMS yuborildi" });
      expect(mockPrisma.otpCode.upsert).not.toHaveBeenCalled();
      expect(mockSms.sendOtp).not.toHaveBeenCalled();
    });

    it("M1: purpose='reset' + foydalanuvchi mavjud — real SMS yuboriladi, javob bir xil generik", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", phone: "+998901234567" });
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "reset");
      expect(result).toEqual({ message: "SMS yuborildi" });
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
    });

    it("M1: ikkala holatda javob IDENTIK (register-band vs register-bo'sh)", async () => {
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      mockPrisma.user.findUnique.mockResolvedValue({ id: "existing" });
      const taken = await service.sendOtp("+998901234560", "register");
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const free = await service.sendOtp("+998901234561", "register");
      expect(taken).toEqual(free);
    });
  });

  // ── verifyOtp ────────────────────────────────────────────────────────────
  // verifyOtp FAQAT OTP ni tekshiradi va { verified: true, phone } qaytaradi.
  // Login va foydalanuvchi yaratish BU YERDA EMAS — bu ro'yhat/parol tiklash uchun.
  describe("verifyOtp", () => {
    const validRecord = {
      id: "otp-1",
      phone: "+998901234567",
      code: "123456",  // 6 xonali
      expiresAt: new Date(Date.now() + 60000),
      attempts: 0
    };

    it("to'g'ri 6 xonali kod — { verified: true, phone } qaytaradi (token emas)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(validRecord);
      mockPrisma.otpCode.delete.mockResolvedValue({});

      const result = await service.verifyOtp("+998901234567", "123456");
      expect(result).toEqual({ verified: true, phone: "+998901234567" });
      expect(mockPrisma.otpCode.delete).toHaveBeenCalledWith({ where: { phone: "+998901234567" } });
      // Token yaratilmasligi va user.create chaqirilmasligi kerak
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockJwt.sign).not.toHaveBeenCalled();
    });

    it("OTP topilmasa BadRequestException", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(null);
      await expect(service.verifyOtp("+998901234567", "123456")).rejects.toThrow(BadRequestException);
    });

    it("5 noto'g'ri urinishdan keyin bloklanadi (OTP_MAX_ATTEMPTS = 5)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue({ ...validRecord, attempts: 5 });
      await expect(service.verifyOtp("+998901234567", "123456")).rejects.toThrow("Juda ko'p noto'g'ri urinish");
    });

    it("muddati o'tgan OTP xato", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue({
        ...validRecord, expiresAt: new Date(Date.now() - 1000)
      });
      await expect(service.verifyOtp("+998901234567", "123456")).rejects.toThrow("muddati o'tgan");
    });

    it("noto'g'ri kod attempts oshiradi", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(validRecord);
      mockPrisma.otpCode.update.mockResolvedValue({});
      await expect(service.verifyOtp("+998901234567", "999999")).rejects.toThrow("Noto'g'ri kod");
      expect(mockPrisma.otpCode.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { attempts: { increment: 1 } } })
      );
    });

    // Timing-safe taqqoslash: timingSafeEqual teng uzunlik talab qiladi —
    // uzunligi farq qiluvchi kod ham (exception siz) oddiy "Noto'g'ri kod"
    // yo'lidan o'tishi shart.
    it("timing-safe: uzunligi farq qiluvchi kod ham 'Noto'g'ri kod' (crash emas)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(validRecord);
      mockPrisma.otpCode.update.mockResolvedValue({});
      await expect(service.verifyOtp("+998901234567", "12345")).rejects.toThrow("Noto'g'ri kod");
      expect(mockPrisma.otpCode.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { attempts: { increment: 1 } } })
      );
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    // ── C1 fix: marker yozilishi ───────────────────────────────────────────
    it("C1: muvaffaqiyatli verify otp:verified markerni yozadi (TTL 600s, single-use)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(validRecord);
      mockPrisma.otpCode.delete.mockResolvedValue({});
      await service.verifyOtp("+998901234567", "123456");
      expect(mockCache.set).toHaveBeenCalledWith("otp:verified:+998901234567", "1", 600);
    });

    it("C1: noto'g'ri kodda marker YOZILMAYDI", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(validRecord);
      mockPrisma.otpCode.update.mockResolvedValue({});
      await expect(service.verifyOtp("+998901234567", "999999")).rejects.toThrow(BadRequestException);
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  // ── completeRegister (C1 fix — OTP tasdig'i MAJBURIY) ────────────────────
  // resetPassword/completeRegister OTP isbotisiz parol o'rnatishi mumkin emas
  // — aks holda istalgan akkauntni telefon raqami bilan egallab olish mumkin.
  describe("completeRegister (C1 — OTP marker talab qilinadi)", () => {
    const otpRecord = {
      id: "otp-1",
      phone: "+998901234567",
      code: "123456",
      expiresAt: new Date(Date.now() + 60000),
      attempts: 0
    };
    const newUser = { id: "u-new", phone: "+998901234567", role: "KITOBXON" };

    it("OTP tasdig'isiz chaqirilsa 403 ForbiddenException — user YARATILMAYDI", async () => {
      await expect(
        service.completeRegister("+998901234567", "Sec1234567")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      // Marker tekshiruvi user-mavjudlik tekshiruvidan OLDIN — enumeration yo'q.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("verifyOtp dan keyin ishlaydi; marker BIR MARTA ishlatiladi (replay → 403)", async () => {
      // 1) OTP tasdiqlash — marker yoziladi
      mockPrisma.otpCode.findUnique.mockResolvedValue(otpRecord);
      mockPrisma.otpCode.delete.mockResolvedValue({});
      await service.verifyOtp("+998901234567", "123456");

      // 2) Ro'yhat yakunlash — muvaffaqiyatli
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);
      const result = await service.completeRegister("+998901234567", "Sec1234567");
      expect(result).toHaveProperty("accessToken", "mock-token");
      expect(result).toHaveProperty("isNewUser", true);
      expect(mockCache.del).toHaveBeenCalledWith("otp:verified:+998901234567");

      // 3) Marker iste'mol qilingan — qayta chaqirish 403
      await expect(
        service.completeRegister("+998901234567", "Sec1234567")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
    });

    it("marker bor, lekin telefon band — BadRequestException (marker tekshiruvidan KEYIN)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue(otpRecord);
      mockPrisma.otpCode.delete.mockResolvedValue({});
      await service.verifyOtp("+998901234567", "123456");

      mockPrisma.user.findUnique.mockResolvedValue({ id: "existing", phone: "+998901234567" });
      await expect(
        service.completeRegister("+998901234567", "Sec1234567")
      ).rejects.toThrow("allaqachon ro'yhatdan o'tgan");
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });

  // ── resetPassword (C1 fix — OTP tasdig'i MAJBURIY) ───────────────────────
  describe("resetPassword (C1 — OTP marker talab qilinadi)", () => {
    const otpRecord = {
      id: "otp-1",
      phone: "+998901234567",
      code: "123456",
      expiresAt: new Date(Date.now() + 60000),
      attempts: 0
    };
    const dbUser = { id: "u1", phone: "+998901234567", role: "KITOBXON", passwordHash: "old-hash" };

    it("OTP tasdig'isiz chaqirilsa 403 ForbiddenException — parol O'ZGARMAYDI", async () => {
      await expect(
        service.resetPassword("+998901234567", "NewSec1234")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("403 xabari o'zbekcha — 'tasdiqlanmagan'", async () => {
      await expect(
        service.resetPassword("+998901234567", "NewSec1234")
      ).rejects.toThrow("Telefon raqam SMS kod orqali tasdiqlanmagan");
    });

    it("verifyOtp dan keyin parol yangilanadi, eski tokenlar bekor, marker iste'mol (replay → 403)", async () => {
      // 1) OTP tasdiqlash — marker yoziladi
      mockPrisma.otpCode.findUnique.mockResolvedValue(otpRecord);
      mockPrisma.otpCode.delete.mockResolvedValue({});
      await service.verifyOtp("+998901234567", "123456");

      // 2) Parol tiklash — muvaffaqiyatli
      mockPrisma.user.findUnique.mockResolvedValue(dbUser);
      mockPrisma.user.update.mockResolvedValue(dbUser);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(dbUser);

      const result = await service.resetPassword("+998901234567", "NewSec1234");
      expect(result).toHaveProperty("accessToken", "mock-token");
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: "+998901234567" } })
      );
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "u1", revoked: false },
        data: { revoked: true }
      });
      expect(mockCache.del).toHaveBeenCalledWith("otp:verified:+998901234567");

      // 3) Marker iste'mol qilingan — qayta chaqirish 403, parol qayta yozilmaydi
      await expect(
        service.resetPassword("+998901234567", "BoshqaParol1")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    });
  });

  // ── refreshToken ─────────────────────────────────────────────────────────
  describe("refreshToken", () => {
    it("to'g'ri DB token bilan yangi pair qaytaradi", async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt-1", userId: "u1", token: "rt", revoked: false,
        expiresAt: new Date(Date.now() + 86400000)
      });
      mockPrisma.refreshToken.update.mockResolvedValue({});
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: "u1", phone: "+998901234567", role: "KITOBXON" });
      mockPrisma.refreshToken.create.mockResolvedValue({});

      const result = await service.refreshToken("rt");
      expect(result).toHaveProperty("accessToken", "mock-token");
      expect(result).toHaveProperty("refreshToken", "mock-token");
    });

    it("revoke qilingan token UnauthorizedException", async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt-1", userId: "u1", token: "rt", revoked: true,
        expiresAt: new Date(Date.now() + 86400000)
      });
      await expect(service.refreshToken("rt")).rejects.toThrow(UnauthorizedException);
    });

    it("muddati o'tgan token UnauthorizedException", async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt-1", userId: "u1", token: "rt", revoked: false,
        expiresAt: new Date(Date.now() - 1000)
      });
      await expect(service.refreshToken("rt")).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── AUDIT-REPORT M4: refresh token sha256 hashing ────────────────────────
  // Refresh tokenlar bazada ochiq matnda saqlanardi — DB sizib chiqsa 30
  // kunlik sessiyalar to'g'ridan-to'g'ri o'g'irlanardi. Endi: bazada faqat
  // sha256 hex, qidiruv hash bo'yicha, mijozga esa xom token qaytadi.
  describe("M4 — refresh token sha256 hashing", () => {
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
    const futureDate = new Date(Date.now() + 86_400_000);

    beforeEach(() => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt-1", userId: "u1", revoked: false, expiresAt: futureDate
      });
      mockPrisma.refreshToken.update.mockResolvedValue({});
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue({
        id: "u1", phone: "+998901234567", role: "KITOBXON"
      });
      mockPrisma.refreshToken.create.mockResolvedValue({});
    });

    it("lookup mijoz yuborgan xom tokenning sha256 hex'i bo'yicha bo'ladi", async () => {
      await service.refreshToken("incoming-raw-token");

      expect(mockPrisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { token: sha256("incoming-raw-token") }
      });
    });

    it("create bazaga FAQAT sha256 hex yozadi; mijozga xom token qaytadi", async () => {
      const result = await service.refreshToken("incoming-raw-token");

      // jwt.sign mock'i "mock-token" qaytaradi — bazada uning hash'i yotadi.
      const createArg = mockPrisma.refreshToken.create.mock.calls[0][0] as {
        data: { token: string; userId: string };
      };
      expect(createArg.data.token).toBe(sha256("mock-token"));
      expect(createArg.data.token).toMatch(/^[0-9a-f]{64}$/);
      expect(createArg.data.token).not.toBe("mock-token"); // plaintext EMAS

      // Mijoz xom tokenni oladi — hash emas.
      expect(result.refreshToken).toBe("mock-token");
    });

    it("rotation mantig'i o'zgarmagan: eski yozuv revoked=true qilinadi", async () => {
      await service.refreshToken("incoming-raw-token");

      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: "rt-1" },
        data: { revoked: true }
      });
    });

    it("sign chaqiruvlari HS256 ga pinlangan (access + refresh)", async () => {
      await service.refreshToken("incoming-raw-token");

      const signCalls = mockJwt.sign.mock.calls as Array<[unknown, Record<string, unknown>]>;
      expect(signCalls).toHaveLength(2);
      // Access token: 15m + HS256
      expect(signCalls[0][1]).toMatchObject({ expiresIn: "15m", algorithm: "HS256" });
      // Refresh token: 30d + HS256
      expect(signCalls[1][1]).toMatchObject({ expiresIn: "30d", algorithm: "HS256" });
    });

    // ── Regressiya: bir soniya ichidagi ikkita kirish ────────────────────
    // JWT `iat` da faqat SONIYA aniqligi bor. `jti` qo'shilmasa, bitta
    // foydalanuvchi bir soniya ichida ikki marta token olsa (ikki qurilma,
    // tugmani ikki marta bosish) imzolangan token bayt-ma-bayt bir xil
    // chiqadi → sha256 ham bir xil → RefreshToken.token unique constraint
    // buziladi (P2002) va KIRISH BUTUNLAY YIQILADI. Bu haqiqiy xato edi:
    // brauzerda ketma-ket kirishda "Bu ma'lumot allaqachon mavjud" xatosi
    // chiqardi.
    it("refresh payload'ida unikal jti bor — bir soniyadagi 2 ta token to'qnashmaydi", async () => {
      await service.refreshToken("incoming-raw-token");
      await service.refreshToken("incoming-raw-token");

      const signCalls = mockJwt.sign.mock.calls as Array<[Record<string, unknown>, unknown]>;
      // 0,2 = access; 1,3 = refresh
      const jti1 = signCalls[1][0].jti as string;
      const jti2 = signCalls[3][0].jti as string;

      expect(jti1).toEqual(expect.any(String));
      expect(jti1).not.toHaveLength(0);
      expect(jti2).not.toBe(jti1);
    });

    it("access token payload'iga jti qo'shilmaydi (faqat refresh uchun)", async () => {
      await service.refreshToken("incoming-raw-token");

      const signCalls = mockJwt.sign.mock.calls as Array<[Record<string, unknown>, unknown]>;
      expect(signCalls[0][0]).not.toHaveProperty("jti");
      expect(signCalls[1][0]).toHaveProperty("jti");
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────
  describe("logout", () => {
    it("barcha refresh tokenlarni revoke qiladi", async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      await service.logout("u1");
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "u1", revoked: false },
        data: { revoked: true }
      });
    });
  });

  // ── OTP bypass (DEV_OTP_BYPASS=true) ─────────────────────────────────────
  describe("OTP bypass (DEV_OTP_BYPASS=true)", () => {
    beforeEach(() => {
      process.env.DEV_OTP_BYPASS = "true";
      process.env.NODE_ENV = "test";
    });

    afterEach(() => {
      delete process.env.DEV_OTP_BYPASS;
      delete process.env.NODE_ENV;
    });

    it("(a) sendOtp returns dev-bypass message and does NOT call prisma.otpCode.upsert or sms.sendOtp", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null); // no existing user (register flow)
      const result = await service.sendOtp("+998901234567", "register");
      expect(result).toEqual({ message: "SMS yuborildi (dev bypass)" });
      expect(mockPrisma.otpCode.upsert).not.toHaveBeenCalled();
      expect(mockSms.sendOtp).not.toHaveBeenCalled();
    });

    it("(b) sendOtp with purpose='register' + existing phone returns the GENERIC response (M1: no enumeration), skips send", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: "existing", phone: "+998901234567" });
      // M1 fix: ilgari "allaqachon ro'yhatdan o'tgan" xatosi otilardi — bu
      // akkaunt mavjudligini oshkor qilardi. Endi generik javob qaytadi.
      const result = await service.sendOtp("+998901234567", "register");
      expect(result).toEqual({ message: "SMS yuborildi" });
      expect(mockPrisma.otpCode.upsert).not.toHaveBeenCalled();
      expect(mockSms.sendOtp).not.toHaveBeenCalled();
    });

    it("(c) verifyOtp returns { verified: true, phone } without calling prisma.otpCode.findUnique", async () => {
      const result = await service.verifyOtp("+998901234567", "000000");
      expect(result).toEqual({ verified: true, phone: "+998901234567" });
      expect(mockPrisma.otpCode.findUnique).not.toHaveBeenCalled();
    });

    it("(d) verifyOtp accepts arbitrary codes like '123456' and '999999'", async () => {
      const r1 = await service.verifyOtp("+998901234567", "123456");
      expect(r1).toEqual({ verified: true, phone: "+998901234567" });
      const r2 = await service.verifyOtp("+998901234567", "999999");
      expect(r2).toEqual({ verified: true, phone: "+998901234567" });
      expect(mockPrisma.otpCode.findUnique).not.toHaveBeenCalled();
    });

    it("(g) C1: bypass verifyOtp HAM otp:verified markerni yozadi — keyin resetPassword ishlaydi", async () => {
      await service.verifyOtp("+998901234567", "000000");
      expect(mockCache.set).toHaveBeenCalledWith("otp:verified:+998901234567", "1", 600);

      const dbUser = { id: "u1", phone: "+998901234567", role: "KITOBXON" };
      mockPrisma.user.findUnique.mockResolvedValue(dbUser);
      mockPrisma.user.update.mockResolvedValue(dbUser);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(dbUser);

      const result = await service.resetPassword("+998901234567", "NewSec1234");
      expect(result).toHaveProperty("accessToken", "mock-token");
    });
  });

  // ── OTP bypass is gated by NODE_ENV ──────────────────────────────────────
  describe("OTP bypass is gated by NODE_ENV", () => {
    beforeEach(() => {
      process.env.DEV_OTP_BYPASS = "true";
      process.env.NODE_ENV = "production";
    });

    afterEach(() => {
      delete process.env.DEV_OTP_BYPASS;
      delete process.env.NODE_ENV;
    });

    it("(e) sendOtp falls through to the real path (prisma.otpCode.upsert IS called)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "register");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
      expect(result).toEqual({ message: "SMS yuborildi" });
    });

    it("(f) verifyOtp with bad code throws BadRequestException (real path runs)", async () => {
      mockPrisma.otpCode.findUnique.mockResolvedValue({
        id: "otp-1",
        phone: "+998901234567",
        code: "123456",
        expiresAt: new Date(Date.now() + 60000),
        attempts: 0
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      await expect(service.verifyOtp("+998901234567", "999999")).rejects.toThrow(BadRequestException);
      expect(mockPrisma.otpCode.findUnique).toHaveBeenCalled();
    });
  });

  // ── OTP bypass fails closed on unknown NODE_ENV ──────────────────────────
  // The isOtpBypassed() helper uses a fail-CLOSED allowlist: only
  // 'development' | 'test' | 'dev' (case-insensitive, trimmed) enable bypass.
  // Anything else — capitalized 'Production', uppercase 'PRODUCTION', unset,
  // 'staging' — must fall through to the real OTP path.
  describe("OTP bypass fails closed on unknown NODE_ENV", () => {
    beforeEach(() => {
      process.env.DEV_OTP_BYPASS = "true";
    });

    afterEach(() => {
      delete process.env.DEV_OTP_BYPASS;
      delete process.env.NODE_ENV;
    });

    it("NODE_ENV='Production' (capitalized) — real path runs (upsert IS called)", async () => {
      process.env.NODE_ENV = "Production";
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "register");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
      expect(result).toEqual({ message: "SMS yuborildi" });
    });

    it("NODE_ENV='PRODUCTION' (uppercase) — real path runs (upsert IS called)", async () => {
      process.env.NODE_ENV = "PRODUCTION";
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "register");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
      expect(result).toEqual({ message: "SMS yuborildi" });
    });

    it("NODE_ENV unset — real path runs (upsert IS called)", async () => {
      delete process.env.NODE_ENV;
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "register");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
      expect(result).toEqual({ message: "SMS yuborildi" });
    });

    it("NODE_ENV='staging' — real path runs (upsert IS called)", async () => {
      process.env.NODE_ENV = "staging";
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.otpCode.upsert.mockResolvedValue({});
      const result = await service.sendOtp("+998901234567", "register");
      expect(mockPrisma.otpCode.upsert).toHaveBeenCalled();
      expect(mockSms.sendOtp).toHaveBeenCalled();
      expect(result).toEqual({ message: "SMS yuborildi" });
    });
  });
});
