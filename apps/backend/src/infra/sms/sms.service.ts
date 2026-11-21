import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { TelegramGatewayClient } from "./telegram-gateway.client";
import { TelegramBotService } from "./telegram-bot.service";
import { NOTIFICATION_QUEUE } from "../queue/queue-names";
import { NotificationJobData } from "../queue/notification.processor";

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
    private readonly config: ConfigService,
    private readonly telegram: TelegramGatewayClient,
    private readonly telegramBot: TelegramBotService,
  ) {}

  /**
   * OTP_CHANNEL:
   *   telegram-bot — bepul: kod bizning Telegram botimiz orqali (raqam botga ulangan bo'lishi kerak)
   *   telegram     — pullik Telegram Gateway (bot shart emas)
   *   sms          — Eskiz.uz (standart)
   */
  get otpChannel(): "telegram-bot" | "telegram" | "sms" {
    const v = this.config.get<string>("OTP_CHANNEL")?.trim().toLowerCase();
    return v === "telegram-bot" || v === "telegram" ? v : "sms";
  }

  /** Frontend uchun: kod qaysi kanaldan keladi va bot havolasi. */
  otpChannelInfo(): { channel: "telegram-bot" | "telegram" | "sms"; botUrl: string | null } {
    const channel = this.otpChannel;
    return { channel, botUrl: channel === "telegram-bot" ? this.telegramBot.botUrl : null };
  }

  async sendOtp(phone: string, code: string, ttlSeconds = 120): Promise<void> {
    if (this.otpChannel === "telegram-bot") {
      // Raqam hali ulanmagan bo'lsa xato bermaymiz: kitobxon botga kontaktini
      // ulashgan zahoti amaldagi kod avtomatik yuboriladi (TelegramBotService).
      await this.telegramBot.sendCode(phone, code, ttlSeconds);
      return;
    }
    if (this.otpChannel === "telegram") {
      await this.telegram.sendCode(phone, code, ttlSeconds);
      return;
    }

    const message = `SIFAT LIBRARY: Tasdiqlash kodingiz: ${code}. Muddati 2 daqiqa. Hech kimga bermang!`;

    await this.notificationQueue.add(
      "otp-sms",
      {
        type: "sms",
        phone,
        message,
        userId: undefined
      } satisfies NotificationJobData,
      { priority: 1 }
    );

    this.logger.debug(`OTP queue ga qo'shildi: ${phone}`);
  }

  async sendNotification(phone: string, message: string, userId?: string): Promise<void> {
    await this.notificationQueue.add("notification-sms", {
      type: "sms",
      phone,
      message,
      userId
    } satisfies NotificationJobData);
  }
}
