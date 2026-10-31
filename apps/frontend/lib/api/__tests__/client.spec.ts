/**
 * @jest-environment jsdom
 *
 * `shouldRefreshOn401` — API client'ning 401 siyosati.
 *
 * Regressiya: 2026-10-31 gacha HAR QANDAY 401 refresh'ga olib borardi; sessiyasiz
 * (anonim) mehmonda refresh ham 401 → logout + `/login` ga hard-redirect. Natija:
 * ochiq sahifadagi (qidiruv, kutubxona profili) bitta himoyalangan so'rov
 * (ReaderShell → /libraries/my-institution) mehmonni login sahifasiga uloqtirardi.
 */
import { shouldRefreshOn401 } from "../client";
import { useAuthStore } from "@/store/auth.store";
import { AUTH_HINT_COOKIE, clearAuthHintCookie, setAuthHintCookie } from "@/lib/auth-cookie";

const err401 = (url: string, retry = false) => ({
  response: { status: 401 },
  config: { url, _retry: retry },
});

describe("shouldRefreshOn401", () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, token: null, isAuthenticated: false, user: null });
    clearAuthHintCookie();
  });

  it("sessiyasiz 401 → refresh YO'Q (anonim mehmon ochiq sahifada qoladi)", () => {
    expect(document.cookie).not.toContain(AUTH_HINT_COOKIE);
    expect(shouldRefreshOn401(err401("/libraries/my-institution"))).toBe(false);
  });

  it("xotirada access token bo'lsa → refresh", () => {
    useAuthStore.setState({ accessToken: "jwt" });
    expect(shouldRefreshOn401(err401("/libraries/my-institution"))).toBe(true);
  });

  it("sl_auth hint cookie bo'lsa (hard reload, token hali xotirada emas) → refresh", () => {
    setAuthHintCookie();
    expect(document.cookie).toContain(`${AUTH_HINT_COOKIE}=1`);
    expect(shouldRefreshOn401(err401("/users/me"))).toBe(true);
  });

  it("auth oqimlari (login/refresh/register/otp/parol) → sessiya bo'lsa ham refresh emas", () => {
    useAuthStore.setState({ accessToken: "jwt" });
    for (const url of [
      "/auth/login",
      "/auth/refresh",
      "/auth/register",
      "/auth/otp/send",
      "/auth/otp/verify",
      "/auth/password/reset",
    ]) {
      expect(shouldRefreshOn401(err401(url))).toBe(false);
    }
  });

  it("allaqachon qayta urinilgan (_retry), 401 bo'lmagan yoki config'siz → false", () => {
    useAuthStore.setState({ accessToken: "jwt" });
    expect(shouldRefreshOn401(err401("/users/me", true))).toBe(false);
    expect(shouldRefreshOn401({ response: { status: 403 }, config: { url: "/users/me" } })).toBe(false);
    expect(shouldRefreshOn401({ response: { status: 401 } })).toBe(false);
  });
});
