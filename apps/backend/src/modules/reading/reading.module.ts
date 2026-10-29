import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { QueueModule } from "../../infra/queue/queue.module";
import { XpModule } from "../xp/xp.module";
import { ReadingController } from "./reading.controller";
import { ReadingService } from "./reading.service";
import { RiRecalcProcessor } from "./ri-recalc.processor";

@Module({
  imports: [PrismaModule, ConfigModule, CacheModule, QueueModule, XpModule],
  controllers: [ReadingController],
  providers: [ReadingService, RiRecalcProcessor],
  exports: [ReadingService]
})
export class ReadingModule {}
