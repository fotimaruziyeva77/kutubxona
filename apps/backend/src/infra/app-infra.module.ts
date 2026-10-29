import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { VaultModule } from "./vault/vault.module";
import { SearchModule } from "./elasticsearch/elasticsearch.module";
import { CacheModule } from "./cache/cache.module";
import { KafkaModule } from "./kafka/kafka.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { MinioModule } from "./minio/minio.module";

@Module({
  imports: [
    PrismaModule,
    VaultModule,
    SearchModule,
    CacheModule,
    KafkaModule,
    // Plan 05-01 Task 2 — NOTIF-02/03 (FcmClient + MailClient) wired alongside
    // existing infra so any module can DI them via global exports.
    NotificationsModule,
    // Plan 06-01 Task 1 — MinIO wrapper (Phase 6 SCH-05/ORG-04/UNI-03 media).
    MinioModule,
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        // AUDIT FIX C9 (code tomoni) — BullMQ uchun ajratilgan noeviction
        // Redis instansiyasi: REDIS_QUEUE_URL birinchi o'rinda o'qiladi.
        // Cache Redis odatda maxmemory-policy=allkeys-lru bilan ishlaydi —
        // u job state'ni evict qilib yuborishi mumkin (BullMQ talabi:
        // noeviction). REDIS_QUEUE_URL o'rnatilmaganda xatti-harakat
        // avvalgidek REDIS_URL ga tushadi (dev/test uchun o'zgarish yo'q).
        const redisUrl =
          configService.get<string>("REDIS_QUEUE_URL") ??
          configService.get<string>("REDIS_URL") ??
          "redis://localhost:56379";
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379)
          }
        };
      },
      inject: [ConfigService]
    })
  ],
  exports: [
    PrismaModule,
    VaultModule,
    SearchModule,
    CacheModule,
    KafkaModule,
    NotificationsModule,
    MinioModule,
  ],
})
export class AppInfraModule {}