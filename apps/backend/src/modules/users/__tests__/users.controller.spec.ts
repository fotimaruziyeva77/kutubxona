import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { UsersController } from "../users.controller";
import { UsersService } from "../users.service";
import { PrivacyService } from "../privacy.service";
import { QrTokenService } from "../qr-token.service";
import { BadgeService, BADGE_CATALOG } from "../../badge/badge.service";
import { JwtPayload } from "../../../common/decorators/current-user.decorator";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";

/**
 * UsersController spec (Plan 03-04 GAME-03).
 *
 * Covers the GET /users/me/badges endpoint:
 *   - Returns {earned, available} pair from BadgeService.getUserBadges()
 *     joined with BADGE_CATALOG
 *   - earned = user's UserBadge rows
 *   - available = BADGE_CATALOG entries the user has NOT yet earned
 *   - JWT guard wiring is verified at integration layer; this unit spec
 *     focuses on the response shape and join logic.
 */

const mockUsersService = {
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
  completeProfile: jest.fn(),
  getQrCode: jest.fn(),
  findAll: jest.fn(),
  // Plan 05-04 Task 3 (NOTIF-02) — FCM device-token CRUD stubs
  upsertFcmToken: jest.fn(),
  deleteFcmToken: jest.fn(),
  listMyFcmTokens: jest.fn(),
} as unknown as UsersService;

const mockBadgeService = {
  getUserBadges: jest.fn(),
};

const mockPrivacyService = {
  getPrivacySettings: jest.fn(),
  updatePrivacySettings: jest.fn(),
} as unknown as PrivacyService;

// TZ §VIII.1 R22 — aylanuvchi QR endpointlari uchun stub
const mockQrTokenService = {
  issueQrForUser: jest.fn(),
  resolveToken: jest.fn(),
} as unknown as QrTokenService;

describe("UsersController", () => {
  let controller: UsersController;

  beforeEach(() => {
    controller = new UsersController(
      mockUsersService,
      mockBadgeService as unknown as BadgeService,
      mockPrivacyService,
      mockQrTokenService,
    );
    jest.clearAllMocks();
  });

  describe("GET /users/me/badges", () => {
    const user: JwtPayload = { sub: "u1", role: "KITOBXON" } as JwtPayload;

    it("foydalanuvchi olgan badgelarni va qolgan kataloglarni qaytaradi", async () => {
      const earnedBadges = [
        {
          id: "ub1",
          awardedAt: new Date("2026-06-01"),
          badge: { code: "FIRST_BOOK", name: "Birinchi kitob", icon: "📖" },
        },
      ];
      mockBadgeService.getUserBadges.mockResolvedValue(earnedBadges);

      const result = await controller.getMyBadges(user);

      expect(mockBadgeService.getUserBadges).toHaveBeenCalledWith("u1");
      expect(result.earned).toEqual(earnedBadges);
      // 18 ta katalog − 1 ta olingan = 17 ta available
      expect(result.available).toHaveLength(BADGE_CATALOG.length - 1);
      // Olingan badge code'i available ro'yhatida bo'lmasligi kerak
      expect(result.available.find((b) => b.code === "FIRST_BOOK")).toBeUndefined();
    });

    it("badge yo'q bo'lsa earned bo'sh, available = 18 ta katalog", async () => {
      mockBadgeService.getUserBadges.mockResolvedValue([]);

      const result = await controller.getMyBadges(user);

      expect(result.earned).toEqual([]);
      expect(result.available).toHaveLength(BADGE_CATALOG.length);
    });

    it("barcha badgelar olingan bo'lsa available bo'sh massiv", async () => {
      const allBadges = BADGE_CATALOG.map((b, i) => ({
        id: `ub${i}`,
        awardedAt: new Date(),
        badge: { code: b.code, name: b.name, icon: b.icon },
      }));
      mockBadgeService.getUserBadges.mockResolvedValue(allBadges);

      const result = await controller.getMyBadges(user);

      expect(result.earned).toHaveLength(BADGE_CATALOG.length);
      expect(result.available).toEqual([]);
    });

    it("BadgeService dan kelgan user.sub JWT payload bilan mos keladi", async () => {
      mockBadgeService.getUserBadges.mockResolvedValue([]);
      const otherUser: JwtPayload = { sub: "different-user-id", role: "KITOBXON" } as JwtPayload;

      await controller.getMyBadges(otherUser);

      // JWT.sub orqali user.id chiqarib olinadi (URL parametrini emas)
      expect(mockBadgeService.getUserBadges).toHaveBeenCalledWith("different-user-id");
    });
  });

  // ── Plan 05-04 Task 3 — FCM device-token endpoints ───────────────────────
  describe("device-tokens endpoints (Plan 05-04 NOTIF-02)", () => {
    const user: JwtPayload = { sub: "u-1", role: "KITOBXON" } as JwtPayload;

    it("POST /users/me/device-tokens delegates to usersService.upsertFcmToken with caller sub", async () => {
      (mockUsersService.upsertFcmToken as jest.Mock).mockResolvedValue({
        id: "dt-1",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const dto = {
        token: "a".repeat(120),
        platform: "web" as const,
      };
      const result = await controller.registerFcmToken(user, dto);

      expect(mockUsersService.upsertFcmToken).toHaveBeenCalledWith({
        userId: "u-1",
        token: dto.token,
        platform: "web",
      });
      expect(result).toMatchObject({ id: "dt-1", platform: "web" });
    });

    it("DELETE /users/me/device-tokens/:id delegates with caller sub + token id", async () => {
      (mockUsersService.deleteFcmToken as jest.Mock).mockResolvedValue(undefined);

      await controller.deleteFcmToken(user, "dt-1");

      expect(mockUsersService.deleteFcmToken).toHaveBeenCalledWith("u-1", "dt-1");
    });

    it("GET /users/me/device-tokens returns the caller's list (no plaintext token)", async () => {
      const rows = [
        { id: "dt-1", platform: "web", lastSeen: new Date(), createdAt: new Date() },
        { id: "dt-2", platform: "android", lastSeen: new Date(), createdAt: new Date() },
      ];
      (mockUsersService.listMyFcmTokens as jest.Mock).mockResolvedValue(rows);

      const result = await controller.listMyFcmTokens(user);
      expect(mockUsersService.listMyFcmTokens).toHaveBeenCalledWith("u-1");
      expect(result).toEqual(rows);
      // Defense-in-depth — service layer never selects token plaintext.
      result.forEach((r: unknown) => {
        expect(r).not.toHaveProperty("token");
      });
    });
  });

  // ── TZ §VIII.1 + R22 — aylanuvchi QR endpointlari ─────────────────────────
  describe("rotating QR endpoints (TZ §VIII.1 R22)", () => {
    const reader: JwtPayload = { sub: "u-1", role: "KITOBXON" } as JwtPayload;

    it("GET /users/me/qr QrTokenService.issueQrForUser ga JWT sub bilan delegatsiya qiladi", async () => {
      const payload = {
        sifatId: "SL-UZ-14-001-0001-00001",
        qrCode: "data:image/png;base64,x",
        token: "abc.def",
        expiresInSeconds: 280,
        expiresAt: new Date(),
        windowSeconds: 300,
        tokenType: "rotating" as const,
      };
      (mockQrTokenService.issueQrForUser as jest.Mock).mockResolvedValue(payload);

      const result = await controller.getQr(reader);

      expect(mockQrTokenService.issueQrForUser).toHaveBeenCalledWith("u-1");
      expect(result).toEqual(payload);
      // Topshiriq sharti: javobda token + expiresInSeconds bo'lishi shart
      expect(result).toHaveProperty("token");
      expect(result).toHaveProperty("expiresInSeconds");
    });

    it("POST /users/qr/resolve QrTokenService.resolveToken ga body token bilan delegatsiya qiladi", async () => {
      const resolved = {
        id: "u-9",
        name: "Kitobxon",
        sifatId: "SL-UZ-14-001-0001-00009",
        type: "CITIZEN",
        status: "ACTIVE",
        trustScore: 75,
        transactions: [],
        tokenType: "rotating" as const,
      };
      (mockQrTokenService.resolveToken as jest.Mock).mockResolvedValue(resolved);

      const result = await controller.resolveQr({ token: "abc.def" });

      expect(mockQrTokenService.resolveToken).toHaveBeenCalledWith("abc.def");
      // Skan oqimi kutadigan payload shakli o'zgarmagan + tokenType bayrog'i
      expect(result).toMatchObject({
        sifatId: "SL-UZ-14-001-0001-00009",
        trustScore: 75,
        tokenType: "rotating",
      });
    });

    it("POST /users/qr/resolve faqat skanerlaydigan rollarga ochiq (role-gating)", () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(
        ROLES_KEY,
        UsersController.prototype.resolveQr,
      );
      expect(roles).toEqual(
        expect.arrayContaining([
          UserRole.KUTUBXONACHI,
          UserRole.MUASSASA_ADMIN,
          UserRole.SUPER_ADMIN,
        ]),
      );
      // Oddiy kitobxon boshqalarning profilini token orqali ocha olmasligi kerak
      expect(roles).not.toContain(UserRole.KITOBXON);
      // /books/scan/:sifatId bilan aynan bir xil rollar (paritet)
      expect(roles).toHaveLength(3);
    });

    it("POST /users/qr/resolve da JwtAuthGuard + RolesGuard o'rnatilgan", () => {
      const reflector = new Reflector();
      const guards =
        reflector.get<Array<{ name: string }>>(
          "__guards__",
          UsersController.prototype.resolveQr,
        ) ?? [];
      const names = guards.map((g) => g.name);
      expect(names).toEqual(
        expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]),
      );
    });

    it("GET /users/me/qr esa rol talab qilmaydi (har bir kitobxon o'z QR ini oladi)", () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[] | undefined>(
        ROLES_KEY,
        UsersController.prototype.getQr,
      );
      expect(roles).toBeUndefined();
    });
  });
});
