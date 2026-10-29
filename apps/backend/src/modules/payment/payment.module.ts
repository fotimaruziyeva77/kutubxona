import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { SmsModule } from "../../infra/sms/sms.module";
import { PdfModule } from "../../infra/pdf/pdf.module";
import { QueueModule } from "../../infra/queue/queue.module";
import { PaymeService } from "./payme.service";
import { ClickService } from "./click.service";
import { InvoiceService } from "./invoice.service";
import { SubscriptionService } from "./subscription.service";
import { PaymentController } from "./payment.controller";

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    CacheModule,
    SmsModule,
    PdfModule,
    // Plan 04-02 audit-fix FIX D3 — drop the duplicate
    // BullModule.registerQueue({ name: PAYMENT_TIMEOUT_QUEUE }) here. QueueModule
    // already registers PAYMENT_TIMEOUT_QUEUE alongside the other queues and
    // exports BullModule, so importing QueueModule provides the @InjectQueue
    // token to PaymeService's constructor without a second registration.
    // Two registerQueue calls for the same name caused a duplicate BullMQ
    // worker subscription in some test contexts (and silent log spam in prod).
    QueueModule,
  ],
  controllers: [PaymentController],
  providers: [PaymeService, ClickService, InvoiceService, SubscriptionService],
  exports: [InvoiceService, SubscriptionService],
})
export class PaymentModule {}
