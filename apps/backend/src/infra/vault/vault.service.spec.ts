import { ConfigService } from "@nestjs/config";
import { VaultService } from "./vault.service";

// ── node-vault ni mock qilish ───────────────────────────────────────────────
// Konstruktor faqat klient yaratadi; health() ni testda boshqaramiz.
const mockHealth = jest.fn();
const mockClient = {
  health: mockHealth,
  read: jest.fn(),
};

jest.mock("node-vault", () => {
  return jest.fn(() => mockClient);
});

/**
 * ConfigService mock — VAULT_TOKEN/VAULT_ADDR qiymatlarini boshqaradi.
 * token=undefined => VAULT_TOKEN o'rnatilmagan holatni simulyatsiya qiladi.
 */
const makeConfig = (overrides: Record<string, string | undefined> = {}) => ({
  get: jest.fn((key: string) => {
    const map: Record<string, string | undefined> = {
      VAULT_ADDR: "http://localhost:8200",
      VAULT_TOKEN: "dev-root-token",
      ...overrides,
    };
    return map[key];
  }),
});

describe("VaultService", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHealth.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // ── Production: token yo'q => konstruktor throw ───────────────────────────
  describe("production muhitida", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
    });

    it("VAULT_TOKEN o'rnatilmagan bo'lsa konstruktor xato beradi (dev-root-token fallback yo'q)", () => {
      const config = makeConfig({ VAULT_TOKEN: undefined });
      expect(
        () => new VaultService(config as unknown as ConfigService),
      ).toThrow(/VAULT_TOKEN/);
    });

    it("Vault health check muvaffaqiyatsiz bo'lsa onModuleInit throw qiladi (warn emas)", async () => {
      const config = makeConfig();
      const service = new VaultService(config as unknown as ConfigService);
      mockHealth.mockRejectedValueOnce(new Error("connection refused"));

      await expect(service.onModuleInit()).rejects.toThrow();
    });

    it("token mavjud va health o'tsa onModuleInit muvaffaqiyatli ishlaydi", async () => {
      const config = makeConfig();
      const service = new VaultService(config as unknown as ConfigService);
      mockHealth.mockResolvedValueOnce({});

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  // ── Development: dev xulq-atvori o'zgarmasligi kerak ──────────────────────
  describe("development muhitida", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "development";
    });

    it("VAULT_TOKEN yo'q bo'lsa dev-root-token ga fallback qiladi (throw qilmaydi)", () => {
      const config = makeConfig({ VAULT_TOKEN: undefined });
      expect(
        () => new VaultService(config as unknown as ConfigService),
      ).not.toThrow();
    });

    it("Vault health check muvaffaqiyatsiz bo'lsa faqat warn qiladi (throw qilmaydi)", async () => {
      const config = makeConfig({ VAULT_TOKEN: undefined });
      const service = new VaultService(config as unknown as ConfigService);
      mockHealth.mockRejectedValueOnce(new Error("connection refused"));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
