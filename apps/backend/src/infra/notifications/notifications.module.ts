import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { FcmClient } from "./fcm.client";
import { MailClient } from "./mail.client";

/**
 * Plan 05-01 Task 2 — NotificationsModule.
 *
 * Houses NOTIF-02 (FCM push) + NOTIF-03 (SMTP email) infra clients. Mirrors
 * SmsModule shape so Plan 05-04 (notification.processor) can inject FcmClient
 * + MailClient the same way it injects EskizSmsClient today.
 *
 * Registered in AppInfraModule for global visibility.
 */
@Module({
  imports: [ConfigModule],
  providers: [FcmClient, MailClient],
  exports: [FcmClient, MailClient],
})
export class NotificationsModule {}
