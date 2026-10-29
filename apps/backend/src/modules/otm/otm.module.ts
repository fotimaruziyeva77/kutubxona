import { Module } from "@nestjs/common";
import { OtmService } from "./otm.service";
import { OtmController } from "./otm.controller";
import { StudentProgressService } from "./student-progress/student-progress.service";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { PdfModule } from "../../infra/pdf/pdf.module";

@Module({
  imports: [PrismaModule, CacheModule, PdfModule],
  controllers: [OtmController],
  providers: [OtmService, StudentProgressService],
  exports: [OtmService, StudentProgressService],
})
export class OtmModule {}
