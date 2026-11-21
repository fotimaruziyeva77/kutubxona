import { ConfigService } from "@nestjs/config";
import { TelegramBotService } from "./telegram-bot.service";
import { PrismaService } from "../prisma/prisma.service";

const cfg = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as unknown as ConfigService;

describe("TelegramBotService", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let prisma: {
    telegramLink: { findUnique: jest.Mock; upsert: jest.Mock };
    otpCode: { findUnique: jest.Mock };
  };
  let svc: TelegramBotService;

  const sentTexts = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/sendMessage"))
      .map(([, init]) => JSON.parse(init.body));

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ ok: true, result: {} }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    prisma = {
      telegramLink: { findUnique: jest.fn(), upsert: jest.fn() },
      otpCode: { findUnique: jest.fn() },
    };
    svc = new TelegramBotService(
      cfg({ TELEGRAM_BOT_TOKEN: "tok", OTP_CHANNEL: "telegram-bot" }),
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const handle = (u: unknown) => (svc as unknown as { handle: (u: unknown) => Promise<void> }).handle(u);

  it("ulangan raqamga kodni yuboradi", async () => {
    prisma.telegramLink.findUnique.mockResolvedValue({ phone: "+998901234567", chatId: "555" });
    await expect(svc.sendCode("+998901234567", "123456", 120)).resolves.toBe(true);
    const [msg] = sentTexts();
    expect(msg.chat_id).toBe("555");
    expect(msg.text).toContain("123456");
  });

  it("ulanmagan raqam — xato bermaydi, false qaytaradi", async () => {
    prisma.telegramLink.findUnique.mockResolvedValue(null);
    await expect(svc.sendCode("+998901234567", "123456", 120)).resolves.toBe(false);
    expect(sentTexts()).toHaveLength(0);
  });

  it("birovning kontaktini ulashsa — bog'lamaydi", async () => {
    await handle({
      update_id: 1,
      message: {
        chat: { id: 555, type: "private" },
        from: { id: 1 },
        contact: { phone_number: "998901234567", user_id: 2 },
      },
    });
    expect(prisma.telegramLink.upsert).not.toHaveBeenCalled();
  });

  it("o'z kontakti — bog'laydi va kutib turgan kodni darhol yuboradi", async () => {
    prisma.otpCode.findUnique.mockResolvedValue({ code: "654321", expiresAt: new Date(Date.now() + 60_000) });
    await handle({
      update_id: 1,
      message: {
        chat: { id: 555, type: "private" },
        from: { id: 7 },
        contact: { phone_number: "998901234567", user_id: 7 },
      },
    });
    expect(prisma.telegramLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: "+998901234567" } }),
    );
    expect(sentTexts().some((m) => m.text.includes("654321"))).toBe(true);
  });

  it("muddati o'tgan kodni yubormaydi", async () => {
    prisma.otpCode.findUnique.mockResolvedValue({ code: "654321", expiresAt: new Date(Date.now() - 1000) });
    await handle({
      update_id: 1,
      message: {
        chat: { id: 555, type: "private" },
        from: { id: 7 },
        contact: { phone_number: "+998901234567", user_id: 7 },
      },
    });
    expect(sentTexts().some((m) => m.text.includes("654321"))).toBe(false);
  });
});
