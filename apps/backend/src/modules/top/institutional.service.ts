import { Injectable, Logger, BadRequestException, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { InstitutionType, Severity } from "@prisma/client";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";
import type { TopService } from "./top.service";

/**
 * Plan 03-03 Task 1 — TOP-05 Institutional rankings cron + endpoint.
 *
 * Per PQ-9 §V institutional ranking requirements (CLAUDE.md §V.3 "Top
 * maktablar / Top OTMlar / Top idoralar / Top viloyatlar / Top tumanlar"):
 *
 * For each Institution of types MAKTAB / OTM / IDORA, aggregate the average
 * Reading Index across all ACTIVE users linked to that institution
 * (via the denormalized User.schoolId / universityId / organizationId CUID
 * fields — per Phase 3 D-6/D-7 lock these are Institution.id strings, no FK).
 *
 * Cron runs daily at 03:00 Asia/Tashkent (after the Top-100 monthly cron at
 * 02:00 on the 28th — so on collision dates the institutional cron picks
 * up the freshly computed RI snapshots) per the prompt spec. Monthly
 * snapshot is keyed by current month (the table @@unique constraint on
 * (institutionId, month) makes the upsert idempotent within a month).
 *
 * Schema reality (consumed at write time):
 *   - MAKTAB → SchoolRating { institutionId, month, coverageRate, avgRi,
 *     clubActivity, totalScore, rank }
 *   - OTM    → SchoolRating (no UniRating model exists in v1 — schema debt;
 *     V2 UniRating planned per RESEARCH.md). Documented in JSDoc + SUMMARY.
 *   - IDORA  → OrgRating { institutionId, month, userId, userName, avgRi,
 *     booksRead, rank, isMvp }
 *
 * Per D-1 Plan 03-02: heavy fan-out reads route through PrismaReplicaService.
 * Writes stay on the primary PrismaService.
 *
 * Per D-4: this cron is alert/analytics — never mutates inventory or user
 * state. It only writes rating snapshot rows.
 *
 * Per TOP-06: any user-name fields surfaced (OrgRating.userName for the
 * "eng faol xodim") are passed through maskNameIfMinor before persistence.
 */
@Injectable()
export class InstitutionalService {
  private readonly logger = new Logger(InstitutionalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replica: PrismaReplicaService,
    // Audit H8 — Redis SETNX leader lock for the daily cron (Plan 04-04
    // FIX F pattern). Optional so legacy 2-arg unit-test instantiations
    // still construct; runtime DI always supplies it (CacheModule is
    // @Global). Missing cache ⇒ cron fail-closed (school/club convention).
    @Optional() private readonly cache?: CacheService,
  ) {}

  /**
   * Daily institutional aggregate cron — 03:00 Asia/Tashkent.
   *
   * Aggregates the trailing 30-day window of ReadingIndex per institution,
   * writes a monthly snapshot row (idempotent on `(institutionId, month)`).
   * Subsequent runs in the same calendar month overwrite the snapshot in
   * place — this is the intended behavior; institutional ranking moves with
   * the user base.
   */
  @Cron("0 3 * * *")
  async computeInstitutionalRankings() {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // replicas:3 in prod fire this @Cron concurrently; the upsert is
    // idempotent but 3× the full fan-out is pure waste. Day-bucket key +
    // 2h TTL (above the fan-out's expected runtime).
    if (!this.cache) {
      this.logger.warn(
        "computeInstitutionalRankings skipped — CacheService not wired (dev/tests)",
      );
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:institutional-rankings:${day}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[institutional-rankings] leader lock held — skipping ${day}`);
      return;
    }

    const month = monthKey();
    this.logger.log(`Institutional rankings: computing ${month}`);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let totalWritten = 0;
    for (const type of [
      InstitutionType.MAKTAB,
      InstitutionType.OTM,
      InstitutionType.IDORA,
    ]) {
      const written = await this.computeForType(type, month, thirtyDaysAgo);
      totalWritten += written;
    }

    // Audit row — single STATE_TRANSITION entry summarising the run.
    await this.prisma.aiAuditLog.create({
      data: {
        scope: "INSTITUTIONAL",
        scopeId: month,
        issueType: "STATE_TRANSITION",
        severity: Severity.LOW,
        analysis: `Institutional rankings computed for ${month}: ${totalWritten} rows written`,
        recommendation: "Routine aggregate — no action required",
      },
    });

    this.logger.log(`Institutional rankings ${month}: ${totalWritten} rows written`);
    return { month, totalWritten };
  }

  /**
   * Per-type aggregation. Returns the number of rating rows written.
   *
   * MAKTAB / OTM use the SchoolRating table (OTM is schema debt — see header).
   * IDORA uses the OrgRating table with employee-level granularity, including
   * an `isMvp:true` row for the top scorer per PQ-9 §9b(d) "eng faol xodim".
   */
  private async computeForType(
    type: InstitutionType,
    month: string,
    thirtyDaysAgo: Date,
  ): Promise<number> {
    const institutions = await this.replica.institution.findMany({
      where: { type, status: "ACTIVE" },
      select: { id: true, name: true, type: true },
    });

    let written = 0;
    for (const inst of institutions) {
      const userFilter = userFilterForType(type, inst.id);

      // Read fan-out on replica
      const users = await this.replica.user.findMany({
        where: { ...userFilter, status: "ACTIVE" },
        select: {
          id: true,
          name: true,
          dob: true,
          readingIndex: {
            where: { calculatedAt: { gte: thirtyDaysAgo } },
            orderBy: { calculatedAt: "desc" },
            take: 1,
            select: { score: true },
          },
          transactions: {
            where: {
              status: "RETURNED",
              returnedAt: { gte: thirtyDaysAgo },
            },
            select: { id: true },
          },
        },
      });

      const totalUsers = users.length;
      if (totalUsers === 0) continue;

      const usersWithRi = users.filter((u) => u.readingIndex.length > 0);
      const activeUsers = usersWithRi.length;
      if (activeUsers === 0) continue;

      const sumRi = usersWithRi.reduce(
        (acc, u) => acc + (u.readingIndex[0]?.score ?? 0),
        0,
      );
      const avgRi = sumRi / activeUsers;
      const coverageRate = activeUsers / totalUsers;

      if (type === InstitutionType.IDORA) {
        // Per-employee snapshot rows — find MVP
        const ranked = usersWithRi
          .map((u) => ({
            id: u.id,
            name: u.name,
            dob: u.dob,
            score: u.readingIndex[0]?.score ?? 0,
            booksRead: u.transactions.length,
          }))
          .sort((a, b) => b.score - a.score);

        for (let i = 0; i < ranked.length; i++) {
          const r = ranked[i];
          // TOP-06: apply maskNameIfMinor at write time so the stored row is
          // already safe to read back into a public response.
          const safeName = maskNameIfMinor(r.name, r.dob);
          await this.prisma.orgRating.upsert({
            where: {
              institutionId_month_userId: {
                institutionId: inst.id,
                month,
                userId: r.id,
              },
            },
            update: {
              userName: safeName,
              avgRi: r.score,
              booksRead: r.booksRead,
              rank: i + 1,
              isMvp: i === 0,
            },
            create: {
              institutionId: inst.id,
              month,
              userId: r.id,
              userName: safeName,
              avgRi: r.score,
              booksRead: r.booksRead,
              rank: i + 1,
              isMvp: i === 0,
            },
          });
          written++;
        }
      } else {
        // MAKTAB + OTM → SchoolRating (one row per institution per month)
        // clubActivity remains 0 in this plan; Phase 6 SCH-09 fills it.
        const totalScore = coverageRate * 40 + avgRi * 0.6;
        await this.prisma.schoolRating.upsert({
          where: {
            institutionId_month: { institutionId: inst.id, month },
          },
          update: { coverageRate, avgRi, clubActivity: 0, totalScore },
          create: {
            institutionId: inst.id,
            month,
            coverageRate,
            avgRi,
            clubActivity: 0,
            totalScore,
          },
        });
        written++;
      }
    }
    return written;
  }

  /**
   * Public endpoint hook — `GET /top/institutional/:type`.
   *
   * Returns the latest month snapshot for the requested institutional type,
   * sorted descending. Viloyat/tuman/mahalla types delegate to TopService's
   * existing `getRegionalRanking` (they aggregate addresses, not institutions).
   */
  async getInstitutionalRanking(
    type: "maktab" | "otm" | "idora" | "viloyat" | "tuman" | "mahalla",
    options: { limit?: number; offset?: number; month?: string } = {},
    topService?: Pick<TopService, "getRegionalRanking">,
  ) {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    if (type === "viloyat" || type === "tuman") {
      if (!topService) {
        throw new BadRequestException(
          "Regional ranking requires TopService delegate",
        );
      }
      return topService.getRegionalRanking(type);
    }
    if (type === "mahalla") {
      // Aggregate per User.address.mahallaId — analogue to viloyat/tuman SQL
      // in TopService. Done here (not delegated) since TopService only
      // exposes viloyat/tuman.
      return this.prisma.$queryRaw<
        Array<{ regionId: string; avgScore: number; userCount: number }>
      >`
        SELECT
          a."mahallaId" as "regionId",
          AVG(ri.score) as "avgScore",
          COUNT(DISTINCT u.id) as "userCount"
        FROM "ReadingIndex" ri
        JOIN "User" u ON u.id = ri."userId"
        JOIN "Address" a ON a.id = u."addressId"
        WHERE ri."calculatedAt" > NOW() - INTERVAL '7 days'
          AND a."mahallaId" IS NOT NULL
        GROUP BY a."mahallaId"
        ORDER BY "avgScore" DESC
        LIMIT 50
      `;
    }

    const month = options.month ?? monthKey();
    if (type === "idora") {
      const rows = await this.prisma.orgRating.findMany({
        where: { month },
        orderBy: [{ institutionId: "asc" }, { rank: "asc" }],
        take: limit,
        skip: offset,
      });
      return { month, type, total: rows.length, rows };
    }

    // maktab + otm → SchoolRating
    const rows = await this.prisma.schoolRating.findMany({
      where: { month },
      orderBy: { totalScore: "desc" },
      take: limit,
      skip: offset,
    });
    return { month, type, total: rows.length, rows };
  }
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function userFilterForType(
  type: InstitutionType,
  institutionId: string,
): Record<string, string> {
  switch (type) {
    case InstitutionType.MAKTAB:
      return { schoolId: institutionId };
    case InstitutionType.OTM:
      return { universityId: institutionId };
    case InstitutionType.IDORA:
      return { organizationId: institutionId };
    case InstitutionType.MAHALLA:
      // No direct User → MAHALLA Institution link; mahalla rankings use the
      // Address.mahallaId path via getInstitutionalRanking. Cron skips.
      return { __unsatisfiable__: "true" };
    default: {
      // Exhaustive — TypeScript guarantees this is never reached.
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
