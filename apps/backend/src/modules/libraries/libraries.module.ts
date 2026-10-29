import { Module } from "@nestjs/common";
import { LibrariesController } from "./libraries.controller";
import { LibrariesService } from "./libraries.service";
import { ReconciliationService } from "./reconciliation.service";
import { GatewayModule } from "../../infra/gateway/gateway.module";

@Module({
  // GatewayModule is needed for StatsGateway in ReconciliationService.
  // PrismaModule is global (AppInfraModule re-export).
  imports: [GatewayModule],
  controllers: [LibrariesController],
  providers: [LibrariesService, ReconciliationService],
  exports: [LibrariesService, ReconciliationService]
})
export class LibrariesModule {}
