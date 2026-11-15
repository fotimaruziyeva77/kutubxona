import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TelegramGatewayClient } from "./telegram-gateway.client";

const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe("TelegramGatewayClient", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("token yo'q yoki 'not-configured' bo'lsa — yubormaydi, 503", async () => {
    for (const token of [undefined, "not-configured"]) {
      const c = new TelegramGatewayClient(cfg({ TELEGRAM_GATEWAY_TOKEN: token }));
      expect(c.isConfigured).toBe(false);
      await expect(c.sendCode("+998901234567", "123456", 120)).rejects.toThrow(ServiceUnavailableException);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendVerificationMessage ga to'g'ri so'rov yuboradi", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });
    const c = new TelegramGatewayClient(cfg({ TELEGRAM_GATEWAY_TOKEN: "tok" }));

    await c.sendCode("+998901234567", "123456", 120);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gatewayapi.telegram.org/sendVerificationMessage");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ phone_number: "+998901234567", code: "123456", ttl: 120 });
  });

  it("raqamda Telegram yo'q — 400 aniq xabar bilan", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: "PHONE_NUMBER_NOT_FOUND" }) });
    const c = new TelegramGatewayClient(cfg({ TELEGRAM_GATEWAY_TOKEN: "tok" }));
    await expect(c.sendCode("+998901234567", "123456", 120)).rejects.toThrow(BadRequestException);
  });

  it("boshqa xato (balans tugagan, tarmoq) — 503", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "BALANCE_NOT_ENOUGH" }) });
    const c = new TelegramGatewayClient(cfg({ TELEGRAM_GATEWAY_TOKEN: "tok" }));
    await expect(c.sendCode("+998901234567", "123456", 120)).rejects.toThrow(ServiceUnavailableException);

    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(c.sendCode("+998901234567", "123456", 120)).rejects.toThrow(ServiceUnavailableException);
  });
});
