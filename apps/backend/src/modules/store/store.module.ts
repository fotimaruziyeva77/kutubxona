import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { StoreService } from "./store.service";
import { StoreController } from "./store.controller";
import { StoreProductImportProcessor } from "./store-product-import.processor";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { KafkaModule } from "../../infra/kafka/kafka.module";
import { SearchModule } from "../../infra/elasticsearch/elasticsearch.module";
import { STORE_PRODUCT_IMPORT_QUEUE } from "../../infra/queue/queue-names";

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    KafkaModule,
    SearchModule,
    BullModule.registerQueue({ name: STORE_PRODUCT_IMPORT_QUEUE }),
  ],
  controllers: [StoreController],
  providers: [StoreService, StoreProductImportProcessor],
  exports: [StoreService],
})
export class StoreModule {}
