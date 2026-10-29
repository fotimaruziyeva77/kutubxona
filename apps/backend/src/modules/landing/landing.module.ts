import { Module } from "@nestjs/common";
import { CacheModule } from "../../infra/cache/cache.module";
import { AdminModule } from "../admin/admin.module";
import { LandingController } from "./landing.controller";
import { LandingService } from "./landing.service";

/**
 * Plan 05-09 Task 1 (LAND-01) — Landing module.
 *
 * Imports AdminModule (which exports AdminService) to pull the cached
 * getNationalStats source of truth, and CacheModule for the 30s public TTL
 * layer (CacheService.keys.landingPublic / ttl.landingPublic).
 */
@Module({
  imports: [AdminModule, CacheModule],
  controllers: [LandingController],
  providers: [LandingService],
  exports: [LandingService],
})
export class LandingModule {}
