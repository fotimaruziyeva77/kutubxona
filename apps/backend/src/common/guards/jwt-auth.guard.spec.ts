import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

const mockJwt = {
  verify: jest.fn()
};

const mockConfig = {
  get: jest.fn().mockReturnValue("test-jwt-secret")
};

const makeReflector = (isPublic: boolean): Reflector =>
  ({
    getAllAndOverride: jest.fn((key: string) =>
      key === IS_PUBLIC_KEY ? isPublic : undefined
    )
  } as unknown as Reflector);

const makeContext = (authHeader?: string): ExecutionContext => {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({})
  } as unknown as ExecutionContext;
};

const makeGuard = (reflector: Reflector): JwtAuthGuard =>
  new JwtAuthGuard(
    mockJwt as unknown as JwtService,
    mockConfig as unknown as ConfigService,
    reflector
  );

describe("JwtAuthGuard", () => {
  beforeEach(() => jest.clearAllMocks());

  it("@Public() (isPublic=true) — Authorization header tekshirmasdan true qaytaradi", () => {
    const guard = makeGuard(makeReflector(true));
    // Token umuman yo'q, lekin route public bo'lgani uchun o'tib ketishi kerak.
    const result = guard.canActivate(makeContext(undefined));

    expect(result).toBe(true);
    expect(mockJwt.verify).not.toHaveBeenCalled();
  });

  it("public emas + token yo'q — UnauthorizedException (default-deny)", () => {
    const guard = makeGuard(makeReflector(false));
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException
    );
  });

  it("public emas + noto'g'ri token — UnauthorizedException", () => {
    mockJwt.verify.mockImplementation(() => {
      throw new Error("invalid");
    });
    const guard = makeGuard(makeReflector(false));
    expect(() =>
      guard.canActivate(makeContext("Bearer bad-token"))
    ).toThrow(UnauthorizedException);
  });

  it("public emas + to'g'ri token — true qaytaradi va req.user o'rnatiladi", () => {
    mockJwt.verify.mockReturnValue({ sub: "u1", phone: "+998901234567", role: "KITOBXON" });
    const guard = makeGuard(makeReflector(false));
    const ctx = makeContext("Bearer good-token");

    expect(guard.canActivate(ctx)).toBe(true);
    // P2 hygiene — verify algoritmi qat'iy HS256 ga pinlangan (alg-confusion
    // va "none" hujumlarining oldi olinadi).
    expect(mockJwt.verify).toHaveBeenCalledWith("good-token", {
      secret: "test-jwt-secret",
      algorithms: ["HS256"]
    });
  });

  // ── Global default-deny xulq-atvori (Task 4: APP_GUARD) ───────────────────
  // Guard global registratsiya qilinganda har bir route default himoyalangan:
  // metadata yo'q (undefined) = himoyalangan = tokensiz rad etiladi.
  // @Public() = ochiq = tokensiz o'tadi. Bu login lockout'ni oldini oladi.
  describe("global default-deny", () => {
    it("metadata yo'q (himoyalangan) route tokensiz rad etiladi", () => {
      const guard = makeGuard(makeReflector(false));
      expect(() => guard.canActivate(makeContext(undefined))).toThrow(
        UnauthorizedException
      );
    });

    it("@Public() route global guard ostida ham tokensiz o'tadi", () => {
      const guard = makeGuard(makeReflector(true));
      expect(guard.canActivate(makeContext(undefined))).toBe(true);
    });
  });
});
