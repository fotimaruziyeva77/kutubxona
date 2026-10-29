import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { SmsService } from "./sms.service";
import { EskizSmsClient } from "./eskiz.client";
import { NOTIFICATION_QUEUE } from "../queue/queue-names";

@Module({
  imports: [
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  providers: [SmsService, EskizSmsClient],
  exports: [SmsService, EskizSmsClient]
})
export class SmsModule {}
