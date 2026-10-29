import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { BadgeService } from "./badge.service";

/**
 * BadgeModule
 *
 * KafkaService DI: KafkaModule is registered as @Global() (see
 * apps/backend/src/infra/kafka/kafka.module.ts), so BadgeService can inject
 * KafkaService without an explicit import here. Plan 03-04 GAME-02 emits
 * KAFKA_TOPICS.BADGE_EARNED from BadgeService.award() on success.
 */
@Module({
  imports: [PrismaModule],
  providers: [BadgeService],
  exports: [BadgeService]
})
export class BadgeModule {}
