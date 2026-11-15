import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { ConfigService } from "@nestjs/config";
import { TelegramGatewayClient } from "./telegram-gateway.client";
import { NOTIFICATION_QUEUE } from "../queue/queue-names";
import { NotificationJobData } from "../queue/notification.processor";

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
    private readonly config: ConfigService,
    private readonly telegram: TelegramGatewayClient,
  ) {}

  /** OTP_CHANNEL=telegram → kod Telegram Gateway orqali (sinxron, xato foydalanuvchiga qaytadi). */
  get otpChannel(): "telegram" | "sms" {
    return this.config.get<string>("OTP_CHANNEL")?.trim().toLowerCase() === "telegram" ? "telegram" : "sms";
  }

  async sendOtp(phone: string, code: string, ttlSeconds = 120): Promise<void> {
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
