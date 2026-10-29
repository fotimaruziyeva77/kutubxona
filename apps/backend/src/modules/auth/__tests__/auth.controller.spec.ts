import { UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";

// ─────────────────────────────────────────────────────────────────────────────
// Controller spec pinning the INFRA-02 cookie contract.
//
// What this enforces (RED → GREEN target):
//   1. /auth/login  — sets the refreshToken as an HttpOnly cookie scoped to
//                     path '/api/auth' with SameSite=lax, and OMITS the
//                     refreshToken from the JSON response body.
//   2. /auth/refresh — reads the refresh token from req.cookies.refreshToken
//                     (NOT the JSON body) and rejects when the cookie is
//                     absent.
//   3. /auth/register/complete — same cookie contract as /login.
//   4. /auth/password/reset — same cookie contract as /login.
//   5. /auth/logout — clears the refreshToken cookie.
//
// These specs MUST fail with the current controller (which still returns the
// refresh token in the JSON body and reads it from RefreshTokenDto).
// ─────────────────────────────────────────────────────────────────────────────

const mockAuthService = {
  login: jest.fn(),
  sendOtp: jest.fn(),
  verifyOtp: jest.fn(),
  completeRegister: jest.fn(),
  resetPassword: jest.fn(),
  refreshToken: jest.fn(),
  logout: jest.fn()
};

const fabricateRes = () => {
  const res: Partial<Response> & {
    cookie: jest.Mock;
    clearCookie: jest.Mock;
  } = {
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis()
  };
  return res as Response & { cookie: jest.Mock; clearCookie: jest.Mock };
};

const fabricateReq = (cookies: Record<string, string> = {}) =>
  ({ cookies } as unknown as Request);

describe("AuthController — INFRA-02 cookie contract", () => {
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(mockAuthService as unknown as AuthService);
  });

  // ── /auth/login ──────────────────────────────────────────────────────────
  describe("POST /auth/login", () => {
    it("sets the refreshToken as an HttpOnly cookie and OMITS it from the response body", async () => {
      mockAuthService.login.mockResolvedValue({
        accessToken: "access-1",
        refreshToken: "refresh-1"
      });

      const res = fabricateRes();
      const body = await controller.login(
        { phone: "+998901234567", password: "Sec1234567" },
        res
      );

      // The cookie MUST be set with the secure-by-default options. We accept
      // any sameSite that is 'lax' (case-insensitive) and require httpOnly.
      expect(res.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "refresh-1",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/api/auth"
        })
      );

      // The body MUST NOT contain the refresh token (XSS-defense — the whole
      // point of INFRA-02).
      expect(body).toEqual(expect.objectContaining({ accessToken: "access-1" }));
      expect(body).not.toHaveProperty("refreshToken");
    });
  });

  // ── /auth/register/complete ──────────────────────────────────────────────
  describe("POST /auth/register/complete", () => {
    it("sets the refreshToken cookie and OMITS it from the body", async () => {
      mockAuthService.completeRegister.mockResolvedValue({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        isNewUser: true
      });

      const res = fabricateRes();
      const body = await controller.completeRegister(
        { phone: "+998901234567", password: "Sec1234567" },
        res
      );

      expect(res.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "refresh-2",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/api/auth"
        })
      );
      expect(body).toEqual(
        expect.objectContaining({ accessToken: "access-2", isNewUser: true })
      );
      expect(body).not.toHaveProperty("refreshToken");
    });
  });

  // ── /auth/password/reset ─────────────────────────────────────────────────
  describe("POST /auth/password/reset", () => {
    it("sets the refreshToken cookie and OMITS it from the body", async () => {
      mockAuthService.resetPassword.mockResolvedValue({
        accessToken: "access-3",
        refreshToken: "refresh-3"
      });

      const res = fabricateRes();
      const body = await controller.resetPassword(
        { phone: "+998901234567", newPassword: "NewSec1234" },
        res
      );

      expect(res.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "refresh-3",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/api/auth"
        })
      );
      expect(body).toEqual(expect.objectContaining({ accessToken: "access-3" }));
      expect(body).not.toHaveProperty("refreshToken");
    });
  });

  // ── /auth/refresh ────────────────────────────────────────────────────────
  describe("POST /auth/refresh", () => {
    it("reads the refresh token from req.cookies.refreshToken (NOT the body)", async () => {
      mockAuthService.refreshToken.mockResolvedValue({
        accessToken: "access-new",
        refreshToken: "refresh-new"
      });

      const req = fabricateReq({ refreshToken: "cookie-refresh-1" });
      const res = fabricateRes();
      const body = await controller.refresh(req, res);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith("cookie-refresh-1");

      // Rotated refresh re-set on the cookie, NOT in the body.
      expect(res.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "refresh-new",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/api/auth"
        })
      );
      expect(body).toEqual({ accessToken: "access-new" });
      expect(body).not.toHaveProperty("refreshToken");
    });

    it("throws Unauthorized when the refresh cookie is absent", async () => {
      const req = fabricateReq({}); // no refreshToken cookie
      const res = fabricateRes();
      await expect(controller.refresh(req, res)).rejects.toBeInstanceOf(
        UnauthorizedException
      );
      expect(mockAuthService.refreshToken).not.toHaveBeenCalled();
    });
  });

  // ── /auth/logout ─────────────────────────────────────────────────────────
  describe("POST /auth/logout", () => {
    it("clears the refreshToken cookie on logout", async () => {
      mockAuthService.logout.mockResolvedValue(undefined);
      const res = fabricateRes();
      await controller.logout(
        { sub: "user-1", phone: "+998901234567", role: "CITIZEN" } as any,
        res
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        "refreshToken",
        expect.objectContaining({ path: "/api/auth" })
      );
    });
  });
});
