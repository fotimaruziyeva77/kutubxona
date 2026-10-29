import { ConfigService } from "@nestjs/config";
import { EskizSmsClient } from "./eskiz.client";

// Native fetch global ni mock qilish (iduz.service.spec.ts pattern)
global.fetch = jest.fn();

const makeConfig = (overrides: Record<string, string | undefined> = {}) => {
  const map: Record<string, string | undefined> = {
    ESKIZ_EMAIL: "test@sifat.uz",
    ESKIZ_PASSWORD: "secret-pass",
    ESKIZ_FROM: "4546",
    ESKIZ_BASE_URL: "https://notify.eskiz.uz",
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => map[key]),
  } as unknown as ConfigService;
};

const okResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

describe("EskizSmsClient", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockReset();
  });

  describe("authenticate + token caching", () => {
    it("authenticate POSTs ESKIZ_EMAIL/ESKIZ_PASSWORD to /api/auth/login and caches token across sends", async () => {
      // Sequence: login (token), send #1 (ok), send #2 (ok — same token, no second login)
      fetchMock
        .mockResolvedValueOnce(
          okResponse({ data: { token: "cached-bearer-token" }, message: "token_generated" })
        )
        .mockResolvedValueOnce(okResponse({ status: "waiting", id: "msg-1" }))
        .mockResolvedValueOnce(okResponse({ status: "waiting", id: "msg-2" }));

      const client = new EskizSmsClient(makeConfig());

      await client.sendSms("+998901234567", "code: 1111");
      await client.sendSms("+998907654321", "code: 2222");

      // Login called exactly once (token cached for second send)
      const loginCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/login")
      );
      expect(loginCalls).toHaveLength(1);

      // Login body carries email + password
      const [, loginInit] = loginCalls[0] as [string, RequestInit];
      const loginBody = String(loginInit.body);
      expect(loginBody).toContain("test%40sifat.uz");
      expect(loginBody).toContain("secret-pass");

      // 3 total fetch calls: 1 login + 2 sends
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("401 re-authentication", () => {
    it("on 401 from send: clears token, re-authenticates once, retries send once", async () => {
      fetchMock
        // initial login
        .mockResolvedValueOnce(okResponse({ data: { token: "old-token" } }))
        // send returns 401 -> triggers re-auth
        .mockResolvedValueOnce(okResponse({ message: "Unauthorized" }, 401))
        // re-auth
        .mockResolvedValueOnce(okResponse({ data: { token: "new-token" } }))
        // retry succeeds
        .mockResolvedValueOnce(okResponse({ status: "waiting", id: "msg-after-retry" }));

      const client = new EskizSmsClient(makeConfig());

      await client.sendSms("+998901234567", "after retry");

      const loginCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/login")
      );
      const sendCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/message/sms/send")
      );

      expect(loginCalls).toHaveLength(2); // initial + re-auth
      expect(sendCalls).toHaveLength(2); // failed 401 + retry

      // Final retry used the NEW token
      const [, retryInit] = sendCalls[1] as [string, RequestInit];
      const headers = retryInit.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer new-token");
    });
  });

  describe("sendSms request shape", () => {
    it("POSTs {mobile_phone, message, from} to /api/message/sms/send with Bearer token", async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse({ data: { token: "tok-abc" } }))
        .mockResolvedValueOnce(okResponse({ status: "waiting", id: "msg-7" }));

      const client = new EskizSmsClient(makeConfig());
      await client.sendSms("+998901234567", "SIFAT: 4242");

      const sendCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/api/message/sms/send")
      );
      expect(sendCall).toBeDefined();

      const [url, init] = sendCall as [string, RequestInit];
      expect(url).toBe("https://notify.eskiz.uz/api/message/sms/send");

      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-abc");

      const body = String(init.body);
      // Phone digits-only (no '+'), message, and approved sender 'from'
      expect(body).toContain("998901234567");
      expect(body).toContain("SIFAT");
      expect(body).toContain("4546");
    });
  });

  describe("dev no-op when credentials missing", () => {
    it("does not call fetch and does not throw when ESKIZ_EMAIL is unset", async () => {
      const client = new EskizSmsClient(
        makeConfig({ ESKIZ_EMAIL: undefined, ESKIZ_PASSWORD: undefined })
      );
      await expect(client.sendSms("+998901234567", "noop")).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── AUDIT FIX H7 — production fail-closed boot assert ─────────────────────
  describe("onModuleInit production fail-closed (H7)", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("production + creds yo'q → onModuleInit THROWS (boot yiqiladi)", () => {
      process.env.NODE_ENV = "production";
      const client = new EskizSmsClient(
        makeConfig({ ESKIZ_EMAIL: undefined, ESKIZ_PASSWORD: undefined })
      );
      expect(() => client.onModuleInit()).toThrow(/ESKIZ_EMAIL\/ESKIZ_PASSWORD/);
    });

    it("production + faqat password yo'q → ham THROWS", () => {
      process.env.NODE_ENV = "production";
      const client = new EskizSmsClient(makeConfig({ ESKIZ_PASSWORD: undefined }));
      expect(() => client.onModuleInit()).toThrow(/production da majburiy/);
    });

    it("production + creds to'liq → onModuleInit o'tadi", () => {
      process.env.NODE_ENV = "production";
      const client = new EskizSmsClient(makeConfig());
      expect(() => client.onModuleInit()).not.toThrow();
    });

    it("dev/test + creds yo'q → onModuleInit o'tadi (warn+no-op saqlanadi)", () => {
      process.env.NODE_ENV = "test";
      const client = new EskizSmsClient(
        makeConfig({ ESKIZ_EMAIL: undefined, ESKIZ_PASSWORD: undefined })
      );
      expect(() => client.onModuleInit()).not.toThrow();
    });

    it("NODE_ENV='Production' (katta harf) ham fail-closed (case-insensitive)", () => {
      process.env.NODE_ENV = "Production";
      const client = new EskizSmsClient(
        makeConfig({ ESKIZ_EMAIL: undefined, ESKIZ_PASSWORD: undefined })
      );
      expect(() => client.onModuleInit()).toThrow();
    });
  });
});
