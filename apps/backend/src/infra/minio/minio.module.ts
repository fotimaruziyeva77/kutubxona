import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MinioService } from "./minio.service";

/**
 * Plan 06-01 Task 1 — MinIO storage module.
 *
 * Global so any module (Plan 06-04 debate media, Plan 06-05 reading hour
 * media, Plan 06-06 book corner photos) can DI MinioService without
 * re-importing this module.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [MinioService],
  exports: [MinioService],
})
export class MinioModule {}
