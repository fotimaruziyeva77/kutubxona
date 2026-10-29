import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { GeoController } from "./geo.controller";
import { GeoService } from "./geo.service";

@Module({
  imports: [PrismaModule],
  controllers: [GeoController],
  providers: [GeoService],
  exports: [GeoService]
})
export class GeoModule {}
