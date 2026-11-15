import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Bepul OTP kanali — Telegram bot (OTP_CHANNEL=telegram-bot).
 *
 * Oqim:
 *   1. Kitobxon botni ochadi → /start → bot "Raqamni ulashish" tugmasini beradi.
 *   2. Kitobxon O'Z kontaktini ulashadi (contact.user_id === from.id tekshiriladi —
 *      birovning kontaktini yuborib raqamni egallab bo'lmaydi) → TelegramLink(phone → chatId).
 *   3. Saytda "Kod olish" → kod shu chatga yuboriladi. Agar kod raqam ulanishidan
 *      oldin so'ralgan bo'lsa, ulangan zahoti amaldagi kod darhol yuboriladi.
 *
 * Webhook emas, long polling (getUpdates) — qo'shimcha nginx yo'li/SSL shart emas.
 * Faqat BITTA backend nusxasi polling qilishi kerak (pilot: 1 ta konteyner).
 */
@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly token?: string;
  private readonly enabled: boolean;
  private offset = 0;
  private stopped = false;
  private abort?: AbortController;
  private username?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const raw = this.config.get<string>("TELEGRAM_BOT_TOKEN")?.trim();
    this.token = raw && raw !== "not-configured" ? raw : undefined;
    this.enabled =
      Boolean(this.token) &&
      this.config.get<string>("OTP_CHANNEL")?.trim().toLowerCase() === "telegram-bot" &&
      process.env.NODE_ENV !== "test";
  }

  /** Saytda ko'rsatiladigan bot havolasi (https://t.me/<username>). */
  get botUrl(): string | null {
    return this.username ? `https://t.me/${this.username}` : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    try {
      const me = await this.call<{ username: string }>("getMe");
      this.username = me.username;
      // getUpdates webhook o'rnatilgan bo'lsa 409 beradi — ehtiyot uchun o'chiramiz.
      await this.call("deleteWebhook");
      this.logger.log(`Telegram bot ishga tushdi: @${me.username}`);
    } catch (e) {
      this.logger.error(`Telegram bot ishga tushmadi (TELEGRAM_BOT_TOKEN?): ${(e as Error).message}`);
      return;
    }
    void this.pollLoop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  /** Kodni raqamga ulangan chatga yuboradi. Raqam hali ulanmagan bo'lsa — false. */
  async sendCode(phone: string, code: string, ttlSeconds: number): Promise<boolean> {
    if (!this.token) {
      this.logger.warn("TELEGRAM_BOT_TOKEN yo'q — kod yuborilmadi");
      return false;
    }
    const link = await this.prisma.telegramLink.findUnique({ where: { phone } });
    if (!link) {
      this.logger.log(`OTP: ${this.mask(phone)} hali botga ulanmagan — ulanganda yuboriladi`);
      return false;
    }
    await this.sendCodeMessage(link.chatId, code, ttlSeconds);
    return true;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async sendCodeMessage(chatId: string, code: string, ttlSeconds: number) {
    const minutes = Math.max(1, Math.round(ttlSeconds / 60));
    await this.call("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `SIFAT LIBRARY tasdiqlash kodi: <code>${code}</code>\n` +
        `Muddati ${minutes} daqiqa. Kodni hech kimga bermang.`,
    });
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const updates = await this.call<TgUpdate[]>(
          "getUpdates",
          { offset: this.offset, timeout: 50, allowed_updates: ["message"] },
          this.abort.signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e) => this.logger.error(`Bot xabarini qayta ishlashda xato: ${(e as Error).message}`));
        }
      } catch (e) {
        if (this.stopped) return;
        this.logger.warn(`getUpdates xatosi: ${(e as Error).message} — 5 soniyadan keyin qayta`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handle(u: TgUpdate): Promise<void> {
    const msg = u.message;
    if (!msg || msg.chat.type !== "private" || !msg.from) return;
    const chatId = String(msg.chat.id);

    if (msg.contact) {
      if (msg.contact.user_id !== msg.from.id) {
        await this.reply(chatId, "Iltimos, pastdagi tugma orqali O'Z raqamingizni ulashing.", true);
        return;
      }
      const phone = "+" + msg.contact.phone_number.replace(/\D/g, "");
      await this.prisma.telegramLink.upsert({
        where: { phone },
        create: { phone, chatId, telegramUserId: String(msg.from.id) },
        update: { chatId, telegramUserId: String(msg.from.id) },
      });
      this.logger.log(`Telegram ulandi: ${this.mask(phone)}`);

      const pending = await this.prisma.otpCode.findUnique({ where: { phone } });
      if (pending && pending.expiresAt > new Date()) {
        await this.reply(chatId, `Raqamingiz ulandi: ${phone}`, false);
        await this.sendCodeMessage(chatId, pending.code, (pending.expiresAt.getTime() - Date.now()) / 1000);
      } else {
        await this.reply(
          chatId,
          `Raqamingiz ulandi: ${phone}\nEndi saytga qaytib "Kod olish" tugmasini bosing — kod shu yerga keladi.`,
          false,
        );
      }
      return;
    }

    await this.reply(
      chatId,
      "Assalomu alaykum! SIFAT LIBRARY tasdiqlash kodlari shu bot orqali keladi.\n" +
        "Pastdagi tugmani bosib telefon raqamingizni ulashing.",
      true,
    );
  }

  private reply(chatId: string, text: string, askContact: boolean) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: askContact
        ? { keyboard: [[{ text: "📱 Raqamni ulashish", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
        : { remove_keyboard: true },
    });
  }

  private async call<T = unknown>(method: string, body?: object, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  private mask(phone: string): string {
    return phone.length > 6 ? `${phone.slice(0, 6)}***${phone.slice(-2)}` : "***";
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
    contact?: { phone_number: string; user_id?: number };
  };
}
