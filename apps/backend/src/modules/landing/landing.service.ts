import { Injectable, Logger, Optional } from "@nestjs/common";
import { AdminService } from "../admin/admin.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";

/**
 * Plan 05-09 Task 1 (LAND-01) — Sanitized public landing stats.
 *
 * Wraps AdminService.getNationalStats (which is already cached at 5min) and
 * projects only the whitelisted public-safe fields. Defense-in-depth:
 *   - No pendingUsers (administrative)
 *   - No byGender / byType (avoid demographic profiling on a public surface)
 *   - No growth percent (avoid embarrassing negative deltas in the SEO head)
 *   - No fraud signals (T-05-08)
 *
 * Cached under `landing:public` (CacheService.keys.landingPublic) TTL 30s so
 * the LiveStatsRefresher 30s poll feels live without pounding the replica
 * (T-05-LIVE-DDOS).
 */
export interface LandingStats {
  libraries: number;
  users: number;
  books: number;
  transactionsThisMonth: number;
  readingIndex: number;
  lastUpdated: string;
}

/**
 * H17 (honest landing) — public per-viloyat Reading Index aggregate.
 *
 * `ri`/`rank` are null when a viloyat has no recent RI data (or fewer than
 * K_ANONYMITY_THRESHOLD distinct users behind the average — a public
 * "viloyat average" over 1-4 users is both statistically meaningless and a
 * thin re-identification surface). The frontend renders null as a neutral
 * gray region — it must NEVER substitute an invented number.
 */
export interface LandingRegion {
  slug: string;
  name: string;
  ri: number | null;
  rank: number | null;
}

/**
 * Literal key (not in CacheService.keys — that file is owned by the cache
 * layer); namespaced beside `landing:public` so `delPattern("landing:*")`
 * invalidates both surfaces together.
 */
export const LANDING_REGIONS_CACHE_KEY = "landing:regions";

@Injectable()
export class LandingService {
  private readonly logger = new Logger(LandingService.name);

  constructor(
    private readonly admin: AdminService,
    private readonly cache: CacheService,
    // Optional so legacy 2-arg spec instantiations keep working; runtime DI
    // always supplies it (PrismaModule is @Global() and exports the replica).
    @Optional() private readonly replica?: PrismaReplicaService,
  ) {}

  async getLandingStats(): Promise<LandingStats> {
    return this.cache.remember(
      CacheService.keys.landingPublic(),
      CacheService.ttl.landingPublic,
      async () => {
        const nat = await this.admin.getNationalStats();
        // Whitelisted projection — never spread the source object verbatim.
        return {
          libraries: nat.libraries?.total ?? 0,
          users: nat.users?.total ?? 0,
          books: nat.books?.total ?? 0,
          transactionsThisMonth: nat.transactions?.thisMonth ?? 0,
          readingIndex: nat.readingIndex?.national ?? 0,
          lastUpdated: new Date().toISOString(),
        };
      },
    );
  }

  /**
   * H17 — real per-viloyat RI for the public landing choropleth + ranking
   * list. Source of truth: AdminService.getAllViloyatStats() (Plan 05-02
   * STAT-01) — a 30-day GROUP BY viloyatId over ReadingIndex×User×Address
   * routed through the read replica and already cached at 5 min. We layer
   * the short public landing TTL on top, then join the Viloyat table (also
   * via replica) for slug/name and compute dense ranks over the viloyats
   * that actually have data.
   *
   * Whitelisted projection: slug, name, ri, rank — userCount and library
   * counts never leave this method (T-05-08 discipline).
   */
  async getLandingRegions(): Promise<LandingRegion[]> {
    return this.cache.remember(
      LANDING_REGIONS_CACHE_KEY,
      CacheService.ttl.landingPublic,
      async () => {
        const replica = this.replica;
        if (!replica) {
          // Only reachable in legacy unit-test constructions; runtime DI
          // always provides the replica. Empty list = frontend renders the
          // neutral "no data" map, never fabricated numbers.
          this.logger.warn(
            "[landing] regions requested without replica binding — returning []",
          );
          return [];
        }

        const [viloyatRows, stats] = await Promise.all([
          replica.viloyat.findMany({
            select: { id: true, name: true, slug: true },
            orderBy: { code: "asc" },
          }),
          this.admin.getAllViloyatStats(),
        ]);

        const perViloyat = stats?.viloyats ?? {};

        const projected = viloyatRows.map((v) => {
          const agg = perViloyat[v.id];
          const publishable =
            agg !== undefined && agg.userCount >= K_ANONYMITY_THRESHOLD;
          return {
            slug: v.slug,
            name: v.name,
            ri: publishable ? +Number(agg.readingIndex).toFixed(1) : null,
          };
        });

        // Rank only the viloyats with publishable data (1 = highest RI).
        const rankBySlug = new Map<string, number>(
          projected
            .filter((r): r is { slug: string; name: string; ri: number } => r.ri !== null)
            .sort((a, b) => b.ri - a.ri || a.name.localeCompare(b.name))
            .map((r, i) => [r.slug, i + 1]),
        );

        return projected
          .map<LandingRegion>((r) => ({
            ...r,
            rank: rankBySlug.get(r.slug) ?? null,
          }))
          .sort(
            (a, b) =>
              (a.rank ?? Number.MAX_SAFE_INTEGER) -
                (b.rank ?? Number.MAX_SAFE_INTEGER) ||
              a.name.localeCompare(b.name),
          );
      },
    );
  }
}
