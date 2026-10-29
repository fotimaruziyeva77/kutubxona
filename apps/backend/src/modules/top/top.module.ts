import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { AiModule } from "../ai/ai.module";
import { TopController } from "./top.controller";
import { TopService } from "./top.service";
import { InstitutionalService } from "./institutional.service";
import { GatewayModule } from "../../infra/gateway/gateway.module";
import { BadgeModule } from "../badge/badge.module";

@Module({
  // PrismaModule is @Global so PrismaReplicaService is available without
  // re-importing here. AiModule is wrapped in forwardRef to keep us safe
  // against a future circular if AiModule ever DIs TopService.
  //
  // Plan 03-04 TOP-07: GatewayModule (StatsGateway) is added here so
  // TopService.autoPublish + confirmMonth + admin overrides can broadcast
  // updates to the `top100:{month}` room. BadgeModule injects BadgeService
  // so autoPublish can award TOP_10/TOP_100/ACTIVE_MONTH badges in the same
  // transaction window (chained inside the cron, NOT a transaction — Kafka
  // and WebSocket are non-transactional best-effort side effects).
  imports: [
    PrismaModule,
    forwardRef(() => AiModule),
    GatewayModule,
    BadgeModule,
  ],
  controllers: [TopController],
  providers: [TopService, InstitutionalService],
  exports: [TopService, InstitutionalService]
})
export class TopModule {}
