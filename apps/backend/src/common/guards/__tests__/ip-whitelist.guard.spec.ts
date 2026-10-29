import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { IpWhitelistGuard, IP_WHITELIST_ENV_KEY } from "../ip-whitelist.guard";

/**
 * Plan 03-01 Task 1 — ip-whitelist.guard.spec.ts
 *
 * DONAT-01 hardening primitive. Webhook routes use this guard with
 * `@IpWhitelist("PAYME_IP_WHITELIST")` to reject non-whitelisted source IPs.
 *
 * Plan 04-02 audit-fix Group A:
 *   - FIX A1: fail-CLOSED in production when env CSV is empty.
 *   - FIX A2: drop X-Forwarded-For parsing; rely on Express req.ip
 *             (driven by `app.set('trust proxy', N)` in main.ts).
 */

interface MockRequest {
  ip?: string;
  headers?: Record<string, string | undefined>;
  connection?: { remoteAddress?: string };
}

function makeReflector(metadataValue: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === IP_WHITELIST_ENV_KEY ? metadataValue : undefined,
    ),
  } as unknown as Reflector;
}

function makeConfig(envMap: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((k: string) => envMap[k]),
  } as unknown as ConfigService;
}

function makeContext(req: MockRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("IpWhitelistGuard", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("returns true (permissive) when the configured env var is unset — dev-friendly default", () => {
    process.env.NODE_ENV = "development";
    const guard = new IpWhitelistGuard(
      makeReflector("PAYME_IP_WHITELIST"),
      makeConfig({}), // env is empty
    );
    const ctx = makeContext({ ip: "203.0.113.5" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("allows request when req.ip is in the whitelist", () => {
    const guard = new IpWhitelistGuard(
      makeReflector("PAYME_IP_WHITELIST"),
      makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5, 198.51.100.10" }),
    );
    const ctx = makeContext({ ip: "203.0.113.5" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("rejects request when source IP is not in the whitelist", () => {
    const guard = new IpWhitelistGuard(
      makeReflector("PAYME_IP_WHITELIST"),
      makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
    );
    const ctx = makeContext({ ip: "10.0.0.1" });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow("IP whitelist rejected");
  });

  it("falls back to req.connection.remoteAddress when req.ip absent", () => {
    const guard = new IpWhitelistGuard(
      makeReflector("PAYME_IP_WHITELIST"),
      makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
    );
    const ctx = makeContext({ connection: { remoteAddress: "203.0.113.5" } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("uses the default env key PAYME_IP_WHITELIST when no decorator metadata is set", () => {
    const guard = new IpWhitelistGuard(
      makeReflector(undefined), // no metadata
      makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
    );
    const ctx = makeContext({ ip: "203.0.113.5" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("trims whitespace around CSV entries before matching", () => {
    const guard = new IpWhitelistGuard(
      makeReflector("PAYME_IP_WHITELIST"),
      makeConfig({ PAYME_IP_WHITELIST: "   203.0.113.5  ,  198.51.100.10  " }),
    );
    const ctx = makeContext({ ip: "198.51.100.10" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ── Plan 04-02 audit-fix FIX A1 — fail-CLOSED in production ─────────────────

  describe("FIX A1 — fail-CLOSED in production when env CSV is empty", () => {
    it("isProductionEnv()=true + empty env → throws ForbiddenException", () => {
      process.env.NODE_ENV = "production";
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({}), // CSV is empty
      );
      const ctx = makeContext({ ip: "203.0.113.5" });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx)).toThrow(
        "IP whitelist required in production",
      );
    });

    it("isProductionEnv()=false + empty env → returns true (dev permissive)", () => {
      process.env.NODE_ENV = "development";
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({}),
      );
      const ctx = makeContext({ ip: "203.0.113.5" });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("isProductionEnv()=true + non-empty env + non-whitelisted IP → 403", () => {
      process.env.NODE_ENV = "production";
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      const ctx = makeContext({ ip: "10.0.0.1" });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it("isProductionEnv()=true + non-empty env + whitelisted IP → true", () => {
      process.env.NODE_ENV = "production";
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      const ctx = makeContext({ ip: "203.0.113.5" });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("isProductionEnv()=true + whitespace-only env → throws", () => {
      process.env.NODE_ENV = "production";
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "   " }),
      );
      const ctx = makeContext({ ip: "203.0.113.5" });
      expect(() => guard.canActivate(ctx)).toThrow(
        "IP whitelist required in production",
      );
    });
  });

  // ── Plan 04-02 audit-fix FIX A2 — drop X-Forwarded-For spoof surface ──────

  describe("FIX A2 — X-Forwarded-For header alone does NOT bypass the guard", () => {
    it("req.ip is the single source of truth (X-Forwarded-For ignored)", () => {
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      // Attacker spoofs X-Forwarded-For but req.ip (set by Express per
      // trust-proxy config) is the real client IP and is NOT in the list.
      const ctx = makeContext({
        ip: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.5" },
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it("matches against req.ip when it equals a whitelisted address", () => {
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      // Even with a confusing XFF header, the guard relies on req.ip alone.
      const ctx = makeContext({
        ip: "203.0.113.5",
        headers: { "x-forwarded-for": "10.0.0.1, 192.168.0.1" },
      });
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it("X-Forwarded-For with a spoofed whitelisted IP cannot bypass when req.ip says otherwise", () => {
      const guard = new IpWhitelistGuard(
        makeReflector("PAYME_IP_WHITELIST"),
        makeConfig({ PAYME_IP_WHITELIST: "203.0.113.5" }),
      );
      const ctx = makeContext({
        ip: "10.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
      });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
