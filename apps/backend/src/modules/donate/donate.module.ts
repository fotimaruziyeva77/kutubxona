import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { BadgeModule } from "../badge/badge.module";
import { DonateController } from "./donate.controller";
import { DonateService } from "./donate.service";

@Module({
  // SEC FIX C2 — ConfigModule for the Payme/Click merchant keys used by the
  // real webhook verification. JwtService (SEC FIX M11) comes from the
  // @Global() AuthModule which exports JwtModule.
  imports: [ConfigModule, PrismaModule, BadgeModule],
  controllers: [DonateController],
  providers: [DonateService],
  exports: [DonateService]
})
export class DonateModule {}
