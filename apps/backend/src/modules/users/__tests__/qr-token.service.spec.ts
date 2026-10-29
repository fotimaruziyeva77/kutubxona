import { BadRequestException, NotFoundException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { QrTokenService } from "../qr-token.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { BooksService } from "../../books/books.service";

// QR rasm generatsiyasini mock qilamiz (users.service.spec bilan bir xil naqsh)
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mock-rotating-qr"),
}));

/**
 * TZ §VIII.1 + R22 — aylanuvchi foydalanuvchi QR token spec.
 *
 * Qamrov (topshiriq talabi):
 *   - oyna rotatsiyasi: JORIY va OLDINGI oyna qabul qilinadi
 *   - undan eski (va kelajak) oynalar rad etiladi
 *   - crypto.timingSafeEqual chaqirilishi (hech qachon `===` emas)
 *   - productionda secret yo'q → konstruktor fail-closed (throw)
 *   - resolveToken: rotating/static yo'llar + BooksService.scanUserQr reuse
 */

const TEST_SECRET = "test-qr-token-secret-0123456789abcdef";
const QR_WINDOW_MS = 5 * 60 * 1000;

const makeConfig = (secret: string | undefined): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === "QR_TOKEN_SECRET" ? secret : undefined,
    ),
  }) as unknown as ConfigService;

const mockPrisma = {
  user: { findUnique: jest.fn() },
} as unknown as PrismaService & { user: { findUnique: jest.Mock } };

const mockBooks = {
  scanUserQr: jest.fn(),
} as unknown as BooksService & { scanUserQr: jest.Mock };

/** Servis algoritmining nusxasi — istalgan oyna uchun token yasash. */
const craftToken = (
  userId: string,
  windowBucket: number,
  secret = TEST_SECRET,
): string => {
  const payloadB64 = Buffer.from(
    JSON.stringify({ u: userId, w: windowBucket }),
    "utf8",
  ).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${userId}|${windowBucket}`)
    .digest("hex");
  return `${payloadB64}.${hmac}`;
};

const currentWindow = () => Math.floor(Date.now() / QR_WINDOW_MS);

const scannedUser = {
  id: "u1",
  name: "Test User",
  sifatId: "SL-UZ-14-001-0001-00001",
  type: "CITIZEN",
  status: "ACTIVE",
  trustScore: 80,
  transactions: [],
};

describe("QrTokenService", () => {
  let service: QrTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QrTokenService(makeConfig(TEST_SECRET), mockPrisma, mockBooks);
  });

  // ── Secret siyosati ────────────────────────────────────────────────────────
  describe("secret handling", () => {
    const origEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = origEnv;
    });

    it("productionda QR_TOKEN_SECRET yo'q bo'lsa konstruktor throw qiladi (fail-closed)", () => {
      process.env.NODE_ENV = "production";
      expect(
        () => new QrTokenService(makeConfig(undefined), mockPrisma, mockBooks),
      ).toThrow(/QR_TOKEN_SECRET/);
    });

    it("developmentda secret yo'q bo'lsa fallback bilan ko'tariladi va warn yozadi", () => {
      process.env.NODE_ENV = "development";
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      expect(
        () => new QrTokenService(makeConfig(undefined), mockPrisma, mockBooks),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("QR_TOKEN_SECRET"),
      );
      warnSpy.mockRestore();
    });
  });

  // ── issueToken ─────────────────────────────────────────────────────────────
  describe("issueToken", () => {
    it("base64url.hmacHex formatida token va 0 < expiresInSeconds <= 300 qaytaradi", () => {
      const issued = service.issueToken("u1");
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
      expect(issued.expiresInSeconds).toBeGreaterThan(0);
      expect(issued.expiresInSeconds).toBeLessThanOrEqual(300);
      expect(issued.windowSeconds).toBe(300);
      // expiresAt — joriy oyna oxiri
      expect(issued.expiresAt.getTime()).toBe(
        (currentWindow() + 1) * QR_WINDOW_MS,
      );
    });

    it("payload ichida userId va joriy window bucket bo'ladi", () => {
      const issued = service.issueToken("u1");
      const [payloadB64] = issued.token.split(".");
      const payload = JSON.parse(
        Buffer.from(payloadB64, "base64url").toString("utf8"),
      );
      expect(payload).toEqual({ u: "u1", w: currentWindow() });
    });
  });

  // ── verifyToken: oyna rotatsiyasi ─────────────────────────────────────────
  describe("verifyToken — window rotation", () => {
    it("JORIY oyna tokenini qabul qiladi (issue → verify roundtrip)", () => {
      const { token } = service.issueToken("u1");
      const result = service.verifyToken(token);
      expect(result).toEqual({ userId: "u1", windowBucket: currentWindow() });
    });

    it("OLDINGI oyna tokenini qabul qiladi (clock-drift grace)", () => {
      const token = craftToken("u1", currentWindow() - 1);
      const result = service.verifyToken(token);
      expect(result.userId).toBe("u1");
      expect(result.windowBucket).toBe(currentWindow() - 1);
    });

    it("2 oyna oldingi tokenni rad etadi (skrinshot eskirgan — R22)", () => {
      const token = craftToken("u1", currentWindow() - 2);
      expect(() => service.verifyToken(token)).toThrow(BadRequestException);
      expect(() => service.verifyToken(token)).toThrow(
        "QR muddati tugagan — yangilang",
      );
    });

    it("KELAJAK oyna tokenini ham rad etadi", () => {
      const token = craftToken("u1", currentWindow() + 1);
      expect(() => service.verifyToken(token)).toThrow(BadRequestException);
    });

    it("vaqt o'tishi bilan token eskiradi (Date.now siljitilganda)", () => {
      const { token } = service.issueToken("u1");
      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, "now");
      try {
        // +1 oyna — hali ham OLDINGI oyna sifatida qabul qilinadi
        nowSpy.mockReturnValue(realNow + QR_WINDOW_MS);
        expect(() => service.verifyToken(token)).not.toThrow();
        // +2 oyna — endi eskirgan
        nowSpy.mockReturnValue(realNow + 2 * QR_WINDOW_MS);
        expect(() => service.verifyToken(token)).toThrow(BadRequestException);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // ── verifyToken: imzo va format ───────────────────────────────────────────
  describe("verifyToken — signature & format", () => {
    it("crypto.timingSafeEqual orqali solishtiradi (hech qachon ===)", () => {
      const spy = jest.spyOn(crypto, "timingSafeEqual");
      const { token } = service.issueToken("u1");
      service.verifyToken(token);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("boshqa secret bilan imzolangan tokenni rad etadi", () => {
      const token = craftToken("u1", currentWindow(), "attacker-secret");
      expect(() => service.verifyToken(token)).toThrow(
        "QR muddati tugagan — yangilang",
      );
    });

    it("payload userId almashtirilsa (imzo boshqa userga) rad etadi", () => {
      // u2 uchun to'g'ri imzo, lekin payload u1 deb ko'rsatilgan
      const w = currentWindow();
      const payloadB64 = Buffer.from(
        JSON.stringify({ u: "u1", w }),
        "utf8",
      ).toString("base64url");
      const hmacForOtherUser = crypto
        .createHmac("sha256", TEST_SECRET)
        .update(`u2|${w}`)
        .digest("hex");
      expect(() =>
        service.verifyToken(`${payloadB64}.${hmacForOtherUser}`),
      ).toThrow(BadRequestException);
    });

    it.each([
      ["bo'sh", ""],
      ["nuqtasiz", "abcdef"],
      ["3 qismli", "a.b.c"],
      ["JSON bo'lmagan payload", `${Buffer.from("garbage").toString("base64url")}.${"a".repeat(64)}`],
      ["hex bo'lmagan hmac", `${Buffer.from(JSON.stringify({ u: "u1", w: 1 })).toString("base64url")}.zz-not-hex`],
    ])("buzuq token (%s) 400 bilan rad etiladi", (_label, bad) => {
      expect(() => service.verifyToken(bad)).toThrow(BadRequestException);
    });

    it("payload tiplari noto'g'ri bo'lsa rad etadi (u raqam, w satr)", () => {
      const payloadB64 = Buffer.from(
        JSON.stringify({ u: 123, w: "x" }),
        "utf8",
      ).toString("base64url");
      expect(() =>
        service.verifyToken(`${payloadB64}.${"a".repeat(64)}`),
      ).toThrow(BadRequestException);
    });
  });

  // ── issueQrForUser ─────────────────────────────────────────────────────────
  describe("issueQrForUser", () => {
    it("sifatId, rotating QR Data URL va token qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        sifatId: "SL-UZ-14-001-0001-00001",
      });
      const result = await service.issueQrForUser("u1");
      expect(result.sifatId).toBe("SL-UZ-14-001-0001-00001");
      expect(result.qrCode).toContain("data:image/png");
      expect(result.tokenType).toBe("rotating");
      expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
      expect(result.expiresInSeconds).toBeGreaterThan(0);
    });

    it("sifatId hali yo'q bo'lsa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ sifatId: null });
      await expect(service.issueQrForUser("u1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── resolveToken ───────────────────────────────────────────────────────────
  describe("resolveToken", () => {
    it("aylanuvchi token → BooksService.scanUserQr reuse + tokenType rotating", async () => {
      const { token } = service.issueToken("u1");
      mockPrisma.user.findUnique.mockResolvedValue({
        sifatId: "SL-UZ-14-001-0001-00001",
      });
      mockBooks.scanUserQr.mockResolvedValue(scannedUser);

      const result = await service.resolveToken(token);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "u1" },
        select: { sifatId: true },
      });
      // Skan oqimi bugun iste'mol qiladigan AYNAN shu service method
      expect(mockBooks.scanUserQr).toHaveBeenCalledWith(
        "SL-UZ-14-001-0001-00001",
      );
      expect(result).toEqual({ ...scannedUser, tokenType: "rotating" });
    });

    it("legacy statik sifatId ishlashda davom etadi, tokenType static bayrog'i bilan", async () => {
      mockBooks.scanUserQr.mockResolvedValue(scannedUser);

      const result = await service.resolveToken("SL-UZ-14-001-0001-00001");

      expect(mockBooks.scanUserQr).toHaveBeenCalledWith(
        "SL-UZ-14-001-0001-00001",
      );
      expect(result.tokenType).toBe("static");
      expect(result.name).toBe("Test User");
    });

    it("eskirgan token: 400, foydalanuvchi lookup UMUMAN chaqirilmaydi", async () => {
      const stale = craftToken("u1", currentWindow() - 2);
      await expect(service.resolveToken(stale)).rejects.toThrow(
        "QR muddati tugagan — yangilang",
      );
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockBooks.scanUserQr).not.toHaveBeenCalled();
    });

    it("token to'g'ri lekin foydalanuvchi sifatId siz → 404", async () => {
      const { token } = service.issueToken("u1");
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.resolveToken(token)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockBooks.scanUserQr).not.toHaveBeenCalled();
    });

    it("bo'sh token → 400", async () => {
      await expect(service.resolveToken("   ")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
