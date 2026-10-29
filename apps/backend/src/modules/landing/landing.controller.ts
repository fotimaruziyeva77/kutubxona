import { Controller, Get, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  LandingRegion,
  LandingService,
  LandingStats,
} from "./landing.service";
import { Public } from "../../common/decorators/public.decorator";

/**
 * Plan 05-09 Task 1 (LAND-01) — Public sanitized landing stats endpoint.
 *
 * `GET /landing/stats` — @Public() (bypasses global JwtAuthGuard) and rate
 * limited to 60 req/min per IP (defense-in-depth on top of the 30s server-side
 * cache).
 *
 * Defensive failure mode: if both the cache layer AND the remote fetch fail
 * we return a zero baseline rather than throwing — landing page must never
 * 500 on hero render (T-05-LIVE-DDOS resilience).
 */
@ApiTags("landing")
@Controller("landing")
export class LandingController {
  private readonly logger = new Logger(LandingController.name);

  constructor(private readonly landing: LandingService) {}

  @Public()
  @Get("stats")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: "Public landing stats (sanitized, 30s cached, 60 req/min)",
  })
  async getStats(): Promise<LandingStats> {
    try {
      return await this.landing.getLandingStats();
    } catch (err) {
      this.logger.warn(
        `[landing] stats fetch failed, returning zero baseline: ${(err as Error).message}`,
      );
      return {
        libraries: 0,
        users: 0,
        books: 0,
        transactionsThisMonth: 0,
        readingIndex: 0,
        lastUpdated: new Date(0).toISOString(),
      };
    }
  }

  /**
   * H17 (honest landing) — `GET /landing/regions`. Real per-viloyat Reading
   * Index aggregates for the public map/ranking. Same defensive failure
   * mode as /stats: on total failure return [] so the landing page renders
   * the neutral "no data" map instead of 500-ing — and the frontend is
   * contractually forbidden from substituting fabricated numbers.
   */
  @Public()
  @Get("regions")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Public per-viloyat Reading Index aggregates (sanitized, cached, 60 req/min)",
  })
  async getRegions(): Promise<LandingRegion[]> {
    try {
      return await this.landing.getLandingRegions();
    } catch (err) {
      this.logger.warn(
        `[landing] regions fetch failed, returning empty list: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
