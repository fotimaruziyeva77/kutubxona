import { Module } from "@nestjs/common";
// Plan 06-01 — PrismaModule is @Global so PrismaReplicaService is auto-wired.
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { SmsModule } from "../../infra/sms/sms.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { FamilyController } from "./family.controller";
import { FamilyService } from "./family.service";

@Module({
  imports: [PrismaModule, SmsModule, CacheModule],
  controllers: [FamilyController],
  providers: [FamilyService],
  exports: [FamilyService]
})
export class FamilyModule {}
