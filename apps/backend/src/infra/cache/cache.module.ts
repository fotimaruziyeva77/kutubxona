import { Global, Module } from "@nestjs/common";
import { CacheService } from "./cache.service";
import { RedisLockService } from "./redis-lock.service";

@Global() // Barcha modullar @inject orqali ishlatsin
@Module({
  providers: [CacheService, RedisLockService],
  exports: [CacheService, RedisLockService]
})
export class CacheModule {}
