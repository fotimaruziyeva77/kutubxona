import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { SmsService } from "./sms.service";
import { EskizSmsClient } from "./eskiz.client";
import { TelegramGatewayClient } from "./telegram-gateway.client";
import { TelegramBotService } from "./telegram-bot.service";
import { NOTIFICATION_QUEUE } from "../queue/queue-names";

@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  providers: [SmsService, EskizSmsClient, TelegramGatewayClient, TelegramBotService],
  exports: [SmsService, EskizSmsClient, TelegramGatewayClient, TelegramBotService]
})
export class SmsModule {}
