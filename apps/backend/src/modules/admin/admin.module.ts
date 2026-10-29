import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { SmsModule } from "../../infra/sms/sms.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { PdfModule } from "../../infra/pdf/pdf.module";
import {
  STATS_AGGREGATION_QUEUE,
  NOTIFICATION_QUEUE,
  REPORT_QUEUE,
} from "../../infra/queue/queue-names";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { StatsAggregationProcessor } from "./stats-aggregation.processor";
import { ReportDataService } from "./report-data.service";
import { ReportEmailProcessor } from "./report-email.processor";
// Plan 06-03 FAM-06 — address-change workflow.
import { AddressChangeController } from "./address-change.controller";
import { AddressChangeService } from "./address-change.service";
// Akaunt boshqaruvi (SUPER_ADMIN) — admin/xodim yaratish, parol, o'chirish.
import {
  AdminAccountsController,
  LibraryDeskController,
} from "./admin-accounts.controller";
import { AdminAccountsService } from "./admin-accounts.service";

@Module({
  imports: [
    PrismaModule,
    SmsModule,
    CacheModule,
    PdfModule,
    // Plan 05-02 Task 2 (STAT-03): scoped queue registration so AdminService
    // can @InjectQueue(STATS_AGGREGATION_QUEUE) and the StatsAggregationProcessor
    // can attach as a worker. Mirrors the Phase 1 NOTIFICATION_QUEUE pattern.
    BullModule.registerQueue({ name: STATS_AGGREGATION_QUEUE }),
    // Plan 05-04 Task 3 (NOTIF-02): AdminController.testPush enqueues to
    // NOTIFICATION_QUEUE for SUPER_ADMIN live-verification path. Queue is
    // already registered with defaultJobOptions in QueueModule — this entry
    // gives AdminController a binding to @InjectQueue from.
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    // Plan 05-08 Task 2 (RPT-02): AdminService.generateMonthlyReports cron
    // enqueues to REPORT_QUEUE; ReportEmailProcessor consumes with concurrency 2.
    // Queue is registered with defaultJobOptions (attempts: 3 + 30s exponential
    // backoff) in QueueModule — this re-registration gives the scope a binding.
    BullModule.registerQueue({ name: REPORT_QUEUE }),
  ],
  controllers: [AdminController, AddressChangeController, AdminAccountsController, LibraryDeskController],
  providers: [
    AdminService,
    StatsAggregationProcessor,
    ReportDataService,
    ReportEmailProcessor,
    AddressChangeService,
    AdminAccountsService,
  ],
  exports: [AdminService, ReportDataService, AddressChangeService],
})
export class AdminModule {}
