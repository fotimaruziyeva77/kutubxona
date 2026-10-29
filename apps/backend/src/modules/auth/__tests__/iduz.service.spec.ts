import { UnauthorizedException } from "@nestjs/common";
import { IduzService } from "../iduz.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infra/prisma/prisma.service";

// fetch global ni mock qilish (eskiz.client.spec.ts pattern)
global.fetch = jest.fn();

const mockConfig = {
  get: jest.fn().mockImplementation((key: string) => {
    const map: Record<string, string> = {
      IDUZ_BASE_URL:      "https://sso.egov.uz",
      IDUZ_CLIENT_ID:     "test-client-id",
      IDUZ_CLIENT_SECRET: "test-secret",
      IDUZ_REDIRECT_URI:  "https://sifat.uz/auth/iduz/callback",
    };
    return map[key] ?? undefined;
  }),
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(), // M5 — PINFL-birinchi qidiruv
    findFirst:  jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(), // M5 — telefon yangilash / PINFL biriktirish
  },
  refreshToken: {
    create: jest.fn().mockResolvedValue({}),
  },
};

const makeService = () =>
  new IduzService(
    mockConfig as unknown as ConfigService,
    mockPrisma as unknown as PrismaService,
  );

describe("IduzService", () => {
  let service: IduzService;

  beforeEach(() => {
    jest.clearAllMocks();
    // M5 defaults: hech kim topilmaydi — create yo'li
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.user.update.mockResolvedValue({});
    service = makeService();
  });

  // ── buildAuthUrl ───────────────────────────────────────────────────────────
  describe("buildAuthUrl", () => {
    it("targets the official OneID provider host (sso.egov.uz) via .do endpoint", () => {
      const url = service.buildAuthUrl("test-state", "test-challenge");

      // OneID (official egov.uz provider) — not sso.id.uz
      expect(url).toContain("sso.egov.uz/sso/oauth/Authorization.do");
      expect(url).not.toContain("sso.id.uz");
    });

    it("uses the OneID `one_code` response type and configured client_id", () => {
      const url = service.buildAuthUrl("test-state", "test-challenge");

      expect(url).toContain("response_type=one_code");
      expect(url).toContain("client_id=test-client-id");
      // Default 'dev-client' must not leak into the URL when a real client_id is configured
      expect(url).not.toContain("client_id=dev-client");
    });

    it("carries PKCE challenge + state CSRF token in the URL", () => {
      const url = service.buildAuthUrl("test-state", "test-challenge");

      expect(url).toContain("state=test-state");
      expect(url).toContain("code_challenge=test-challenge");
      expect(url).toContain("code_challenge_method=S256");
    });

    it("redirect_uri is URL-encoded into the authorize URL", () => {
      const url = service.buildAuthUrl("s", "c");
      expect(url).toContain(encodeURIComponent("https://sifat.uz/auth/iduz/callback"));
    });
  });

  // ── generateState / verifyState ───────────────────────────────────────────
  describe("generateState / verifyState", () => {
    it("generateState 32-baytli hex qaytaradi", () => {
      const state = service.generateState();
      expect(state).toHaveLength(32); // 16 bytes hex = 32 chars
      expect(/^[0-9a-f]+$/.test(state)).toBe(true);
    });

    it("to'g'ri state juftini tasdiqlaydi", () => {
      const state = service.generateState();
      expect(service.verifyState(state, state)).toBe(true);
    });

    it("noto'g'ri state false qaytaradi", () => {
      const state = service.generateState();
      const wrongState = state.replace(/./g, (c, i) => (i === 0 ? (c === "a" ? "b" : "a") : c));
      expect(service.verifyState(wrongState, state)).toBe(false);
    });

    it("bo'sh state false qaytaradi", () => {
      expect(service.verifyState("", "anything")).toBe(false);
      expect(service.verifyState("anything", "")).toBe(false);
    });
  });

  // ── exchangeCode (OneID `one_authorization_code` grant) ──────────────────
  describe("exchangeCode", () => {
    it("POSTs to the .do endpoint with grant_type=one_authorization_code", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token:  "access-123",
          refresh_token: "refresh-456",
          token_type:    "Bearer",
          expires_in:    3600,
        }),
      });

      const result = await service.exchangeCode("auth-code", "code-verifier");

      expect(result.access_token).toBe("access-123");
      expect(result.refresh_token).toBe("refresh-456");

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://sso.egov.uz/sso/oauth/Authorization.do");
      expect(init.method).toBe("POST");

      const body = String(init.body);
      expect(body).toContain("grant_type=one_authorization_code");
      expect(body).toContain("code=auth-code");
      expect(body).toContain("code_verifier=code-verifier");
      expect(body).toContain("client_id=test-client-id");
      expect(body).toContain("client_secret=test-secret");
    });

    it("token server xatosi UnauthorizedException", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false, status: 400,
        text: jest.fn().mockResolvedValue("Bad Request"),
      });

      await expect(service.exchangeCode("bad-code", "verifier")).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  // ── getUserInfo (OneID `one_access_token_identify` grant) ────────────────
  describe("getUserInfo", () => {
    it("POSTs to the .do endpoint with grant_type=one_access_token_identify", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          pin:          "12345678901234",
          full_name:    "Navoiy Alisher Ulug'bekovich",
          sur_name:     "Navoiy",
          mid_name:     "Ulug'bekovich",
          birth_date:   "09.02.1990",
          mob_phone_no: "998901234567",
          pport_no:     "AA1234567",
          gender:       "1",
        }),
      });

      const info = await service.getUserInfo("access-token-xyz");

      // PINFL must come from OneID's `pin` field (not OAuth `sub`)
      expect(info.pinfl).toBe("12345678901234");
      // Phone normalized
      expect(info.phone_number).toBe("+998901234567");

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://sso.egov.uz/sso/oauth/Authorization.do");
      expect(init.method).toBe("POST");

      const body = String(init.body);
      expect(body).toContain("grant_type=one_access_token_identify");
      expect(body).toContain("access_token=access-token-xyz");
    });

    it("falls back to `sub` or `pinfl` field when `pin` is absent (test/staging providers)", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          sub:          "fallback-sub-123",
          given_name:   "Alisher",
          family_name:  "Navoiy",
          phone_number: "+998901234567",
        }),
      });

      const info = await service.getUserInfo("access-token");

      expect(info.pinfl).toBe("fallback-sub-123");
      expect(info.given_name).toBe("Alisher");
    });

    it("userInfo API xatosi UnauthorizedException", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });

      await expect(service.getUserInfo("bad-token")).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  // ── loginOrRegister (M5 — PINFL-birinchi bog'lash tartibi) ────────────────
  describe("loginOrRegister", () => {
    const userInfo = {
      sub:          "12345678901234",
      pinfl:        "12345678901234",
      phone_number: "+998901234567",
      given_name:   "Alisher",
      family_name:  "Navoiy",
      gender:       "male" as const,
      birthdate:    "1990-02-09",
    };

    // 1) PINFL bo'yicha topilgan — birlamchi yo'l
    it("PINFL bo'yicha topilgan foydalanuvchi login qilinadi (telefon tekshirilmaydi)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "pinfl-user", phone: "+998901234567",
      });

      const result = await service.loginOrRegister(userInfo);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { pinfl: "12345678901234" } })
      );
      expect(result).toEqual({ userId: "pinfl-user", isNew: false });
      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      // Telefon bir xil — yangilash kerak emas
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("PINFL mos, telefon o'zgargan — telefon yangilanadi va log yoziladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "pinfl-user", phone: "+998907777777", // eski raqam
      });

      const result = await service.loginOrRegister(userInfo);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "pinfl-user" },
        data:  { phone: "+998901234567" },
      });
      expect(result).toEqual({ userId: "pinfl-user", isNew: false });
    });

    it("telefon yangilash unique to'qnashuvida ham PINFL egasi login qilinadi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "pinfl-user", phone: "+998907777777",
      });
      mockPrisma.user.update.mockRejectedValue(new Error("P2002 unique constraint"));

      const result = await service.loginOrRegister(userInfo);

      expect(result).toEqual({ userId: "pinfl-user", isNew: false });
    });

    // 2) Telefon bo'yicha topilgan — legacy bog'lash
    it("telefon mos, PINFL yo'q — bir martalik biriktiriladi", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: "u-legacy", pinfl: null });

      const result = await service.loginOrRegister(userInfo);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "u-legacy" },
        data:  { pinfl: "12345678901234" },
      });
      expect(result).toEqual({ userId: "u-legacy", isNew: false });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it("telefon mos, PINFL ham bir xil — oddiy login, qayta yozilmaydi", async () => {
      mockPrisma.user.findFirst.mockResolvedValue({
        id: "u1", pinfl: "12345678901234",
      });

      const result = await service.loginOrRegister(userInfo);

      expect(result.isNew).toBe(false);
      expect(result.userId).toBe("u1");
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("telefon mos, lekin BOSHQA PINFL — UnauthorizedException (kirgizilmaydi)", async () => {
      // Raqam qayta ishlatilgan: akkaunt boshqa fuqaroning PINFL i bilan bog'langan
      mockPrisma.user.findFirst.mockResolvedValue({
        id: "u-other", pinfl: "99999999999999",
      });

      await expect(service.loginOrRegister(userInfo)).rejects.toThrow(
        UnauthorizedException
      );
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    // 3) Yangi foydalanuvchi
    it("yangi foydalanuvchi — PINFL bilan birga yaratadi", async () => {
      mockPrisma.user.create.mockResolvedValue({
        id: "new-u", phone: "+998901234567", status: "ACTIVE"
      });

      const result = await service.loginOrRegister(userInfo);

      expect(result.isNew).toBe(true);
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            phone:  "+998901234567",
            pinfl:  "12345678901234", // M5 — endi tashlab yuborilmaydi
            type:   "CITIZEN",
            gender: "MALE",
          }),
        })
      );
    });

    it("PINFL bo'sh bo'lsa findUnique chaqirilmaydi, create pinfl=null", async () => {
      mockPrisma.user.create.mockResolvedValue({ id: "u-nopinfl", status: "ACTIVE" });

      await service.loginOrRegister({ ...userInfo, pinfl: "" });

      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ pinfl: null }),
        })
      );
    });

    it("noma'lum gender — MALE default", async () => {
      mockPrisma.user.create.mockResolvedValue({ id: "u2", status: "ACTIVE" });

      await service.loginOrRegister({ ...userInfo, gender: undefined });

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ gender: "MALE" }),
        })
      );
    });

    it("birthdate yo'q bo'lganda default dob ishlatiladi", async () => {
      mockPrisma.user.create.mockResolvedValue({ id: "u3", status: "ACTIVE" });

      await service.loginOrRegister({ ...userInfo, birthdate: undefined });

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dob: new Date("1990-01-01"),
          }),
        })
      );
    });
  });

  // ── ConfigService driven base URL ────────────────────────────────────────
  describe("config-driven host", () => {
    it("falls back to sso.egov.uz when IDUZ_BASE_URL is unset", () => {
      const fallbackConfig = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === "IDUZ_BASE_URL") return undefined;
          if (key === "IDUZ_CLIENT_ID") return "test-client-id";
          if (key === "IDUZ_CLIENT_SECRET") return "test-secret";
          if (key === "IDUZ_REDIRECT_URI") return "https://sifat.uz/auth/iduz/callback";
          return undefined;
        }),
      };
      const svc = new IduzService(
        fallbackConfig as unknown as ConfigService,
        mockPrisma as unknown as PrismaService,
      );
      const url = svc.buildAuthUrl("s", "c");
      expect(url).toContain("sso.egov.uz/sso/oauth/Authorization.do");
    });
  });
});
