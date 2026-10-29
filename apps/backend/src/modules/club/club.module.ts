import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { SmsModule } from "../../infra/sms/sms.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { MinioModule } from "../../infra/minio/minio.module";
import { ClubController } from "./club.controller";
import { ClubService } from "./club.service";
import { ClubConsentService } from "./consent/club-consent.service";
import { DebateMediaService } from "./media/debate-media.service";

@Module({
  imports: [PrismaModule, SmsModule, CacheModule, MinioModule],
  controllers: [ClubController],
  providers: [ClubService, ClubConsentService, DebateMediaService],
  exports: [ClubService, ClubConsentService, DebateMediaService]
})
export class ClubModule {}
