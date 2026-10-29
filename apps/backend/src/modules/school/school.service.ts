import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { InstitutionType } from "@prisma/client";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../common/utils/admin-scope.util";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";

@Injectable()
export class SchoolService {
  private readonly logger = new Logger(SchoolService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    // Plan 06-02 SCH-01/06/07/08 — heavy reads route to replica per OQ-1.
    // Optional so older 2-arg construction in legacy unit tests still compiles.
    private readonly replica?: PrismaReplicaService,
    // Plan 06-02 SCH-07 — weekly cache refresh @Cron uses Redis SETNX leader lock
    // (Plan 05-05 FIX B pattern). Optional for tests.
    private readonly lock?: RedisLockService,
  ) {}

  /** Replica when wired, otherwise primary (tests / dev fallback). */
  private get r(): PrismaService | PrismaReplicaService {
    return (this.replica as PrismaReplicaService | undefined) ?? this.prisma;
  }

  // ── Muassasa CRUD ─────────────────────────────────────────────────────────

  async createInstitution(data: {
    type: InstitutionType;
    name: string;
    tumanId: string;
    viloyatId: string;
    address?: string;
    phone?: string;
    directorId?: string;
  }) {
    // Kod generatsiya: MAKTAB-tumanCode-seq
    const tuman = await this.prisma.tuman.findUnique({ where: { id: data.tumanId } });
    if (!tuman) throw new NotFoundException("Tuman topilmadi");

    const count = await this.prisma.institution.count({
      where: { tumanId: data.tumanId, type: data.type }
    });
    const seq = String(count + 1).padStart(3, "0");
    const code = `${data.type}-${tuman.code.replace("-", "")}-${seq}`;

    return this.prisma.institution.create({
      data: { ...data, code }
    });
  }

  async getInstitution(id: string) {
    const institution = await this.r.institution.findUnique({
      where: { id },
      include: {
        clubs: {
          where: { status: "ACTIVE" },
          select: { id: true, name: true, leaderId: true, _count: { select: { members: true } } }
        }
      }
    });
    if (!institution) throw new NotFoundException("Muassasa topilmadi");
    return institution;
  }

  async listInstitutions(filters: {
    type?: InstitutionType;
    tumanId?: string;
    viloyatId?: string;
    limit?: number;
    offset?: number;
  }) {
    const { type, tumanId, viloyatId, limit = 50, offset = 0 } = filters;
    const where = {
      ...(type && { type }),
      ...(tumanId && { tumanId }),
      ...(viloyatId && { viloyatId })
    };

    const [data, total] = await Promise.all([
      this.r.institution.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { name: "asc" },
        include: {
          _count: { select: { clubs: true } }
        }
      }),
      this.r.institution.count({ where })
    ]);

    return { data, total, limit, offset };
  }

  // ── Maktab statistika ─────────────────────────────────────────────────────
  //
  // Plan 06-02 SCH-01 — scope-guard runs BEFORE cache.remember so a forbidden
  // caller does NOT poison the cache key (T-06-01 / T-05-02 carry-over).
  async getSchoolStats(institutionId: string, user?: InstitutionScopedUser) {
    // Resolve institution scope and assert ownership BEFORE touching cache.
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, name: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Muassasa topilmadi");
    if (user) {
      assertInstitutionInScope(user, institutionId, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
        type: inst.type as any,
      });
    }

    const cacheKey = `school:stats:${institutionId}`;
    return this.cache.remember(cacheKey, 300, async () => {

      // O'quvchilar (STUDENT_SCHOOL turi va schoolId = institutionId)
      const [totalStudents, activeStudents, pendingStudents] = await Promise.all([
        this.r.user.count({ where: { schoolId: institutionId } }),
        this.r.user.count({ where: { schoolId: institutionId, status: "ACTIVE" } }),
        this.r.user.count({ where: { schoolId: institutionId, status: "PENDING" } })
      ]);

      // O'rtacha Reading Index
      const avgRiRaw = await this.r.$queryRaw<[{ avg: number | null }]>`
        SELECT AVG(ri.score) as avg
        FROM "ReadingIndex" ri
        INNER JOIN (
          SELECT "userId", MAX("calculatedAt") as latest
          FROM "ReadingIndex"
          GROUP BY "userId"
        ) latest_ri ON ri."userId" = latest_ri."userId" AND ri."calculatedAt" = latest_ri.latest
        INNER JOIN "User" u ON u.id = ri."userId"
        WHERE u."schoolId" = ${institutionId}
          AND u.status = 'ACTIVE'
      `;
      const avgRi = Number(avgRiRaw[0]?.avg ?? 0);

      // 10 kitob maqsadi progresi — necha o'quvchi 10+ kitob o'qigan (yil ichida)
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      const studentsWithTenBooks = await this.r.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT bt."userId") as count
        FROM "BookTransaction" bt
        INNER JOIN "User" u ON u.id = bt."userId"
        WHERE u."schoolId" = ${institutionId}
          AND bt.status = 'RETURNED'
          AND bt."returnedAt" >= ${yearStart}
        GROUP BY bt."userId"
        HAVING COUNT(*) >= 10
      `;
      const achievedGoal = Number(studentsWithTenBooks[0]?.count ?? 0);

      // Sinf bo'yicha faollik (schoolClass field)
      const classBuckets = await this.r.user.groupBy({
        by: ["schoolClass"],
        where: { schoolId: institutionId, status: "ACTIVE", schoolClass: { not: null } },
        _count: { id: true }
      });

      // Faol klublar
      const activeClubs = await this.r.club.count({
        where: { institutionId, status: "ACTIVE" }
      });

      // Bu oyda tranzaksiyalar
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const monthlyTransactions = await this.r.bookTransaction.count({
        where: {
          user: { schoolId: institutionId },
          createdAt: { gte: monthStart }
        }
      });

      const coverageRate = totalStudents > 0
        ? Math.round((activeStudents / totalStudents) * 100)
        : 0;

      const goalRate = activeStudents > 0
        ? Math.round((achievedGoal / activeStudents) * 100)
        : 0;

      return {
        institutionId,
        name: inst.name,
        students: { total: totalStudents, active: activeStudents, pending: pendingStudents },
        coverageRate,
        avgRi: Math.round(avgRi * 10) / 10,
        goalAchievement: { target: 10, achieved: achievedGoal, rate: goalRate },
        activeClubs,
        monthlyTransactions,
        classBuckets: classBuckets.map((c) => ({ class: c.schoolClass, count: c._count.id }))
      };
    });
  }

  // ── O'quvchilar ro'yhati (legacy flat list) ───────────────────────────────

  async getStudents(institutionId: string, filters: {
    schoolClass?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }, user?: InstitutionScopedUser) {
    // Plan 06-02 SCH-01 — scope guard runs BEFORE any read.
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Muassasa topilmadi");
    if (user) {
      assertInstitutionInScope(user, institutionId, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
        type: inst.type as any,
      });
    }

    const { schoolClass, status, limit = 50, offset = 0 } = filters;
    const where: any = {
      schoolId: institutionId,
      ...(schoolClass && { schoolClass }),
      ...(status && { status }),
    };

    const [students, total] = await Promise.all([
      this.r.user.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: [{ schoolClass: "asc" }, { name: "asc" }],
        include: {
          readingIndex: {
            orderBy: { calculatedAt: "desc" },
            take: 1,
            select: { score: true, calculatedAt: true }
          }
        },
      }),
      this.r.user.count({ where })
    ]);

    return {
      data: students.map((s) => ({
        ...s,
        latestRi: s.readingIndex[0] ?? null
      })),
      total,
      limit,
      offset
    };
  }

  // ── O'quvchilar sinf bo'yicha bucketlangan (SCH-01) ──────────────────────
  //
  // Plan 06-02 SCH-01 — students grouped by class with K-anonymity suppression
  // (small classes with total < 5 hide avgRi). Scope-guard runs BEFORE
  // cache.remember (regression: forbidden caller does not poison cache key).
  async getStudentsByClass(institutionId: string, user?: InstitutionScopedUser) {
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Muassasa topilmadi");
    if (user) {
      assertInstitutionInScope(user, institutionId, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
        type: inst.type as any,
      });
    }

    const cacheKey = `school:students-by-class:${institutionId}`;
    return this.cache.remember(cacheKey, 300, async () => {
      // groupBy by (schoolClass, status) — collapse into per-class buckets in JS.
      const rows = await this.r.user.groupBy({
        by: ["schoolClass", "status"],
        where: { schoolId: institutionId, schoolClass: { not: null } },
        _count: { id: true },
      });

      const buckets = new Map<string, { total: number; pending: number; active: number; inactive: number }>();
      for (const row of rows) {
        const klass = row.schoolClass ?? "Belgilanmagan";
        const bucket = buckets.get(klass) ?? { total: 0, pending: 0, active: 0, inactive: 0 };
        const count = row._count.id;
        bucket.total += count;
        const status = String(row.status);
        if (status === "ACTIVE") bucket.active += count;
        else if (status === "PENDING") bucket.pending += count;
        else bucket.inactive += count;
        buckets.set(klass, bucket);
      }

      // For each class with avgRi requested, compute via raw query batched.
      // Small-class (total < K_ANONYMITY_THRESHOLD) suppress avgRi.
      const classNames = Array.from(buckets.keys());
      const avgRiByClass = new Map<string, number>();
      if (classNames.length > 0) {
        const rawAvg = await this.r.$queryRaw<Array<{ schoolClass: string; avg: number | null }>>`
          SELECT u."schoolClass" as "schoolClass", AVG(ri.score) as avg
          FROM "ReadingIndex" ri
          INNER JOIN (
            SELECT "userId", MAX("calculatedAt") as latest
            FROM "ReadingIndex"
            GROUP BY "userId"
          ) latest_ri ON ri."userId" = latest_ri."userId" AND ri."calculatedAt" = latest_ri.latest
          INNER JOIN "User" u ON u.id = ri."userId"
          WHERE u."schoolId" = ${institutionId}
            AND u.status = 'ACTIVE'
            AND u."schoolClass" IS NOT NULL
          GROUP BY u."schoolClass"
        `;
        for (const row of rawAvg) {
          avgRiByClass.set(row.schoolClass, Math.round(Number(row.avg ?? 0) * 10) / 10);
        }
      }

      const out = Array.from(buckets.entries())
        .map(([className, b]) => {
          const suppressed = b.total < K_ANONYMITY_THRESHOLD;
          return {
            className,
            total: b.total,
            pending: b.pending,
            active: b.active,
            inactive: b.inactive,
            avgRi: suppressed ? null : (avgRiByClass.get(className) ?? 0),
            kAnonymitySuppressed: suppressed,
          };
        })
        .sort((a, b) => a.className.localeCompare(b.className));

      return { institutionId, buckets: out };
    });
  }

  // ── O'quvchi tasdiqlash ──────────────────────────────────────────────────

  async approveStudent(userId: string, institutionId: string, user?: InstitutionScopedUser) {
    // Plan 06-02 SCH-01 — scope guard BEFORE any side-effect.
    if (user) {
      const inst = await this.r.institution.findUnique({
        where: { id: institutionId },
        select: { id: true, type: true, viloyatId: true, tumanId: true },
      });
      if (!inst) throw new NotFoundException("Muassasa topilmadi");
      assertInstitutionInScope(user, institutionId, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
        type: inst.type as any,
      });
    }

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (target.schoolId !== institutionId) {
      throw new BadRequestException("Bu o'quvchi sizning muassasangizga tegishli emas");
    }
    if (target.status !== "PENDING") {
      throw new BadRequestException("Foydalanuvchi allaqachon tasdiqlangan yoki bloklangan");
    }

    await this.cache.del(`school:stats:${institutionId}`);
    await this.cache.del(`school:students-by-class:${institutionId}`);
    return this.prisma.user.update({
      where: { id: userId },
      data: { status: "ACTIVE" }
    });
  }

  // ── O'quvchini rad etish (SCH-02) ─────────────────────────────────────────
  //
  // Plan 06-02 SCH-02 — Rejects a PENDING student with a free-text reason and
  // writes an AiAuditLog row { scope:'USER', issueType:'STUDENT_REJECT' }.
  // Reason: min 3 chars, max 500. Rate-limited at controller layer via @Throttle.
  async rejectStudent(
    userId: string,
    institutionId: string,
    reason: string,
    user?: InstitutionScopedUser,
  ) {
    if (typeof reason !== "string" || reason.trim().length < 3) {
      throw new BadRequestException("Rad etish sababi (kamida 3 belgi) majburiy");
    }
    const trimmedReason = reason.trim().slice(0, 500);

    if (user) {
      const inst = await this.r.institution.findUnique({
        where: { id: institutionId },
        select: { id: true, type: true, viloyatId: true, tumanId: true },
      });
      if (!inst) throw new NotFoundException("Muassasa topilmadi");
      assertInstitutionInScope(user, institutionId, {
        viloyatId: inst.viloyatId,
        tumanId: inst.tumanId,
        type: inst.type as any,
      });
    }

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (target.schoolId !== institutionId) {
      throw new BadRequestException("Bu o'quvchi sizning muassasangizga tegishli emas");
    }
    if (target.status !== "PENDING") {
      throw new BadRequestException("Talaba PENDING holatida emas");
    }

    await this.cache.del(`school:stats:${institutionId}`);
    await this.cache.del(`school:students-by-class:${institutionId}`);

    const [, audit] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status: "BLOCKED" as any },
      }),
      this.prisma.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "STUDENT_REJECT",
          severity: "LOW" as any,
          analysis: `School admin rejected: ${trimmedReason}`,
          recommendation: "—",
        },
      }),
    ]);

    return { userId, status: "BLOCKED", reason: trimmedReason, auditId: audit.id };
  }

  // ── Sinf ro'yhati ─────────────────────────────────────────────────────────

  async getClassList(institutionId: string) {
    const classes = await this.r.user.groupBy({
      by: ["schoolClass"],
      where: { schoolId: institutionId, schoolClass: { not: null } },
      _count: { id: true },
      orderBy: { schoolClass: "asc" }
    });
    return classes.map((c) => ({ class: c.schoolClass, studentCount: c._count.id }));
  }

  // ── Maktab reytingi (respublika bo'yicha) ─────────────────────────────────
  //
  // Plan 06-02 SCH-07 — SchoolService is a READ-ONLY consumer of SchoolRating
  // (D-OQ-1). Phase 3 InstitutionalService.computeForType('MAKTAB') is the sole
  // writer. assertInstitutionInScope runs when a user context is supplied
  // (per-institution lookups); the cross-republic/viloyat/tuman list can be
  // gated at the controller via @Roles.

  async getSchoolRankings(filters: {
    viloyatId?: string;
    tumanId?: string;
    month?: string;
    limit?: number;
  }) {
    const { month = this._currentMonth(), limit = 100 } = filters;
    const where = {
      month,
      ...(filters.viloyatId && {
        institution: { viloyatId: filters.viloyatId }
      }),
      ...(filters.tumanId && {
        institution: { tumanId: filters.tumanId }
      })
    };

    const cacheKey = `school:ranking:${month}:${filters.viloyatId ?? "all"}:${filters.tumanId ?? "all"}:${limit}`;
    return this.cache.remember(cacheKey, 300, async () => {
      const rankings = await this.r.schoolRating.findMany({
        where,
        orderBy: { totalScore: "desc" },
        take: limit,
      });

      // institutionId bo'yicha institution ma'lumotlarini qo'shamiz
      const institutionIds = [...new Set(rankings.map((r) => r.institutionId))];
      const institutions = await this.r.institution.findMany({
        where: { id: { in: institutionIds } },
        select: { id: true, name: true, code: true, tumanId: true, viloyatId: true },
      });
      const instMap = new Map(institutions.map((i) => [i.id, i]));

      return rankings.map((r, i) => ({
        ...r,
        rank: r.rank ?? i + 1,
        institution: instMap.get(r.institutionId) ?? null,
      }));
    });
  }

  // ── Maktab reytingi hisoblash — R-DUP RESOLVED (Plan 06-01 SCH-07) ────────
  //
  // Phase 3 InstitutionalService.computeForType('MAKTAB') is the SOLE writer
  // of SchoolRating rows (D-OQ-1 decision). The previous SchoolService
  // implementation maintained a parallel scaffold that wrote duplicate rows;
  // when both crons fired within the same minute the rank flapped between
  // values. SchoolService is now READ-ONLY for SchoolRating — write path
  // was deleted intentionally. Phase 3's @Cron handles materialisation.

  async computeSchoolRatings(_month?: string): Promise<{ computed: number; total: number; note: string }> {
    // Intentional no-op — see header comment. Phase 3 InstitutionalService
    // is the sole writer of SchoolRating rows.
    this.logger.log(
      "computeSchoolRatings called — no-op (R-DUP: Phase 3 InstitutionalService is sole writer)",
    );
    return {
      computed: 0,
      total: 0,
      note: "deprecated — see InstitutionalService.computeForType(MAKTAB)",
    };
  }

  // ── Weekly cache refresh (SCH-07) ─────────────────────────────────────────
  //
  // Plan 06-02 SCH-07 — Sunday 02:00 Asia/Tashkent. Acquires Redis SETNX leader
  // lock so multi-replica clusters do not double-refresh. Strictly invalidates
  // `school:ranking:*` cache keys — DOES NOT WRITE SchoolRating (Phase 3 owns
  // the write path per D-OQ-1).
  @Cron("0 2 * * 0", { name: "school-ranking-refresh-weekly", timeZone: "Asia/Tashkent" })
  async refreshRankingCache(): Promise<void> {
    if (!this.lock) {
      this.logger.warn("refreshRankingCache skipped — RedisLockService not wired (dev/tests)");
      return;
    }
    const key = "lock:school-ranking-refresh-weekly";
    const ttlSec = 30 * 60; // 30 min
    const traceId = `school-ranking-${Date.now()}`;
    const acquire = await this.lock.tryAcquire(key, ttlSec, traceId);
    if (!acquire.first) {
      this.logger.log("refreshRankingCache: lock not acquired — another replica owns the run");
      return;
    }
    this.logger.log("refreshRankingCache: invalidating school:ranking:* cache keys");
    await this.cache.delPattern("school:ranking:*");
    // NB: we intentionally do NOT call this.prisma.schoolRating.create/upsert here.
    // Phase 3 InstitutionalService is the sole writer (R-DUP gate).
  }

  // ── PQ-9 hisoboti uchun ma'lumot ──────────────────────────────────────────
  //
  // Plan 06-02 SCH-08 — Aggregates the Jadidlar Izidan section and goal
  // achievement block. Scope-guard runs at the controller via assertInstitution
  // BEFORE invocation; user context is therefore optional here.
  async getPq9ReportData(institutionId: string, user?: InstitutionScopedUser) {
    if (user) {
      const instLite = await this.r.institution.findUnique({
        where: { id: institutionId },
        select: { id: true, type: true, viloyatId: true, tumanId: true },
      });
      if (!instLite) throw new NotFoundException("Muassasa topilmadi");
      assertInstitutionInScope(user, institutionId, {
        viloyatId: instLite.viloyatId,
        tumanId: instLite.tumanId,
        type: instLite.type as any,
      });
    }

    const institution = await this.getInstitution(institutionId);
    const stats = await this.getSchoolStats(institutionId);
    const byClass = await this.getStudentsByClass(institutionId);

    const currentMonth = this._currentMonth();
    const [year, q] = [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
    const quarterStart = new Date(year, (q - 1) * 3, 1);
    const quarterEnd = new Date(year, q * 3, 0, 23, 59, 59);

    // Klub holati (Jadidlar Izidan section data)
    const clubs = await this.r.club.findMany({
      where: { institutionId, status: "ACTIVE" },
      include: {
        _count: { select: { members: true, debates: true } },
        debates: {
          where: { heldAt: { gte: quarterStart, lte: quarterEnd } },
          select: { id: true, topic: true, heldAt: true, participants: true }
        }
      }
    });

    // Inactive clubs (no debate in 30+ days — SCH-09 threshold)
    const inactiveCutoff = new Date(Date.now() - 30 * 86_400_000);
    const inactiveClubs = await this.r.club.findMany({
      where: {
        institutionId,
        status: "ACTIVE",
        debates: { none: { heldAt: { gte: inactiveCutoff } } },
      },
      select: { id: true, name: true, debates: { take: 1, orderBy: { heldAt: "desc" }, select: { heldAt: true } } },
    });

    // Bu chorakda eng faol o'quvchilar
    const topStudents = await this.r.user.findMany({
      where: { schoolId: institutionId, status: "ACTIVE" },
      orderBy: { trustScore: "desc" },
      take: 5,
      select: { name: true, schoolClass: true, trustScore: true }
    });

    // Reyting (READ-only)
    const ranking = await this.r.schoolRating.findUnique({
      where: { institutionId_month: { institutionId, month: currentMonth } }
    });

    // Goal achievement aggregate across school
    const target = 20; // hardcoded per CLAUDE.md §VII (D-Q2)
    const totalAchieved = stats.goalAchievement.achieved;
    const totalActiveStudents = stats.students.active;
    const goalAchievement = {
      target,
      achieved: totalAchieved,
      rate: totalActiveStudents > 0
        ? Math.round((totalAchieved / totalActiveStudents) * 100)
        : 0,
    };

    return {
      institution: { name: institution.name, code: institution.name },
      generatedAt: new Date().toLocaleDateString("uz-UZ"),
      period: `${year}-yil ${q}-chorak`,
      stats,
      classBuckets: byClass.buckets,
      clubs: clubs.map((c) => ({
        name: c.name,
        memberCount: c._count.members,
        quarterDebates: c.debates.length,
        totalDebates: c._count.debates,
        recentDebates: c.debates,
        lastDebateAt: c.debates[0]?.heldAt
          ? c.debates[0].heldAt.toISOString().slice(0, 10)
          : null,
      })),
      jadidlarSection: {
        clubs: clubs.map((c) => ({
          name: c.name,
          memberCount: c._count.members,
          quarterDebates: c.debates.length,
          lastDebateAt: c.debates[0]?.heldAt
            ? c.debates[0].heldAt.toISOString().slice(0, 10)
            : null,
        })),
        inactiveClubs: inactiveClubs.map((c) => {
          const last = c.debates[0]?.heldAt ?? null;
          const daysSince = last
            ? Math.floor((Date.now() - last.getTime()) / 86_400_000)
            : Infinity;
          return {
            name: c.name,
            daysSince: daysSince === Infinity ? 999 : daysSince,
          };
        }),
      },
      goalAchievement,
      topStudents,
      ranking: ranking ?? { rank: null, totalScore: 0 }
    };
  }

  private _currentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
}
