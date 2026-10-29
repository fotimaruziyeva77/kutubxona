import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { XpService } from "./xp.service";
import { XpController } from "./xp.controller";

/**
 * XpModule
 *
 * KafkaService DI: KafkaModule @Global(), shuning uchun bu yerda import
 * kerak emas (BadgeModule bilan bir xil).
 */
@Module({
  imports: [PrismaModule],
  controllers: [XpController],
  providers: [XpService],
  exports: [XpService],
})
export class XpModule {}
