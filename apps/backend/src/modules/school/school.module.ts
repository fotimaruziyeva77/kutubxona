import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { PdfModule } from "../../infra/pdf/pdf.module";
import { SchoolController } from "./school.controller";
import { SchoolService } from "./school.service";

// Plan 06-02 — PrismaModule + CacheModule are @Global so PrismaReplicaService
// and RedisLockService are available via DI without explicit re-import.
@Module({
  imports: [PrismaModule, CacheModule, PdfModule],
  controllers: [SchoolController],
  providers: [SchoolService],
  exports: [SchoolService]
})
export class SchoolModule {}
