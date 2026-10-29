import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule } from "@nestjs/config";
import { NotificationProcessor } from "./notification.processor";
import { PaymentTimeoutProcessor } from "./payment-timeout.processor";
import { SmsModule } from "../sms/sms.module";
import { FcmClient } from "../notifications/fcm.client";
import { MailClient } from "../notifications/mail.client";
import { PrismaModule } from "../prisma/prisma.module";
import {
  NOTIFICATION_QUEUE,
  REPORT_QUEUE,
  AI_QUEUE,
  RI_RECALC_QUEUE,
  BOOK_IMPORT_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  STATS_AGGREGATION_QUEUE,
  STORE_PRODUCT_IMPORT_QUEUE,
} from "./queue-names";

// Re-export for backward compatibility (spec files, etc.)
export {
  NOTIFICATION_QUEUE,
  REPORT_QUEUE,
  AI_QUEUE,
  RI_RECALC_QUEUE,
  BOOK_IMPORT_QUEUE,
  PAYMENT_TIMEOUT_QUEUE,
  STATS_AGGREGATION_QUEUE,
  STORE_PRODUCT_IMPORT_QUEUE,
} from "./queue-names";

// AUDIT FIX C9 (code tomoni): BullMQ Redis CONNECTION konfiguratsiyasi
// app-infra.module.ts dagi BullModule.forRootAsync da yashaydi va u yerda
// REDIS_QUEUE_URL ?? REDIS_URL tartibida o'qiladi (ajratilgan noeviction
// queue-Redis compose'da alohida worker tomonidan qo'shiladi). Bu modul
// faqat queue'larni nomlari bilan ro'yhatdan o'tkazadi.
@Module({
  imports: [
    SmsModule,
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue(
      {
        name: NOTIFICATION_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: false
        }
      },
      {
        // Plan 05-08 RPT-02: monthly PDF report fan-out. 215 jobs/month
        // (1 national + 14 viloyat + 200 tuman). Concurrency is enforced at
        // the WORKER (ReportEmailProcessor @Processor concurrency: 2) per
        // PITFALLS M6 — 215 simultaneous Puppeteer renders OOM the node.
        // attempts: 3 with 30s exponential backoff so transient SMTP/render
        // failures recover. removeOnComplete keeps 50 most recent for audit;
        // removeOnFail keeps 100 to aid the DLQ investigation window.
        name: REPORT_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 }
        }
      },
      {
        // Audit M19: was attempts: 1 — a single transient DB/Redis blip
        // permanently dropped the AI job. Processors are idempotent, so
        // attempts: 3 with exponential backoff (5s/10s/20s) is safe and
        // matches the RI_RECALC retry style. removeOn* left as-is (separate
        // retention decision).
        name: AI_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 200 },
          removeOnFail: false
        }
      },
      {
        name: RI_RECALC_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: false
        }
      },
      {
        name: BOOK_IMPORT_QUEUE,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "fixed", delay: 10000 },
          removeOnComplete: { count: 50 },
          removeOnFail: false
        }
      },
      {
        // Audit M19: was attempts: 1 — one transient DB blip when the
        // 12-hour delayed job fired stranded the Payment in PENDING forever
        // (nothing re-enqueues a consumed delayed job). The processor is
        // idempotent + race-safe (terminal-status guard), so attempts: 3
        // with exponential backoff (5s/10s/20s) only retries genuine
        // transient failures. removeOn* left as-is (separate retention
        // decision).
        name: PAYMENT_TIMEOUT_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 200 },
          removeOnFail: false
        }
      },
      {
        // Audit M19: was attempts: 1 — a transient blip dropped the cache
        // warm and the dashboard ate the cold-miss p99 spike the pre-agg
        // exists to prevent. Warm jobs are idempotent (cache.remember), so
        // attempts: 3 with a SHORT exponential backoff (2s/4s/8s) retries
        // within the minute-bucket relevance window. removeOn* left as-is
        // (separate retention decision).
        name: STATS_AGGREGATION_QUEUE,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 50 }
        }
      },
      {
        name: STORE_PRODUCT_IMPORT_QUEUE,
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "fixed", delay: 10000 },
          removeOnComplete: { count: 50 },
          removeOnFail: false
        }
      }
    )
  ],
  providers: [NotificationProcessor, PaymentTimeoutProcessor, FcmClient, MailClient],
  exports: [BullModule]
})
export class QueueModule {}
