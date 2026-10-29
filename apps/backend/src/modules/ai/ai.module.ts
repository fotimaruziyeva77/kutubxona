import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { KafkaModule } from "../../infra/kafka/kafka.module";
import { GatewayModule } from "../../infra/gateway/gateway.module";
import { PdfModule } from "../../infra/pdf/pdf.module";
import { NOTIFICATION_QUEUE, REPORT_QUEUE } from "../../infra/queue/queue-names";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { FraudService } from "./fraud.service";
import { AuditService } from "./audit.service";
import { AlertDispatchService } from "./alert-dispatch.service";
import { NlqService } from "./nlq.service";
import { PredictService } from "./predict.service";
import { RecommendService } from "./recommend.service";
import { KafkaAuditConsumer } from "./kafka-audit.consumer";

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    KafkaModule,
    GatewayModule,
    PdfModule,
    ConfigModule,
    BullModule.registerQueue({ name: REPORT_QUEUE }),
    // Plan 05-05 T2 — AlertDispatchService fans alerts out to NOTIFICATION_QUEUE.
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    FraudService,
    AuditService,
    AlertDispatchService,
    NlqService,
    PredictService,
    RecommendService,
    KafkaAuditConsumer,
  ],
  exports: [AiService, FraudService, RecommendService, AlertDispatchService],
})
export class AiModule {}
