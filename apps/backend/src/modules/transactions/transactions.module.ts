import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { SmsModule } from "../../infra/sms/sms.module";
// AUDIT-REPORT H8 (FIX 4) — CacheModule exports RedisLockService for the
// cron leader locks in TransactionsService.
import { CacheModule } from "../../infra/cache/cache.module";
import { BadgeModule } from "../badge/badge.module";
import { XpModule } from "../xp/xp.module";
import { TransactionsController } from "./transactions.controller";
import { TransactionsService } from "./transactions.service";

@Module({
  imports: [PrismaModule, SmsModule, CacheModule, BadgeModule, XpModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService]
})
export class TransactionsModule {}
