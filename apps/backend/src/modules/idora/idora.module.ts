import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { PdfModule } from "../../infra/pdf/pdf.module";
import { MinioModule } from "../../infra/minio/minio.module";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import { AiModule } from "../ai/ai.module";
import { IdoraController } from "./idora.controller";
import { IdoraService } from "./idora.service";
import { MukofotService } from "./mukofot/mukofot.service";
// Plan 06-06 ORG-03 — Reading Hour module split into its own subdir to keep
// the rotating-HMAC QR + media-upload surface isolated from IdoraService.
import { ReadingHourController } from "./reading-hour/reading-hour.controller";
import { ReadingHourService } from "./reading-hour/reading-hour.service";
import { ReadingHourMediaService } from "./reading-hour/media/reading-hour-media.service";

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    PdfModule,
    MinioModule,
    AiModule,
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  controllers: [IdoraController, ReadingHourController],
  providers: [
    IdoraService,
    MukofotService,
    ReadingHourService,
    ReadingHourMediaService,
  ],
  exports: [IdoraService, MukofotService, ReadingHourService],
})
export class IdoraModule {}
