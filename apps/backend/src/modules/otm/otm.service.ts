import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
} from "@nestjs/common";
import { UserType, UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PdfService } from "../../infra/pdf/pdf.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../common/utils/admin-scope.util";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";

@Injectable()
export class OtmService {
  private readonly logger = new Logger(OtmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly pdf: PdfService,
    // Plan 06-07 UNI-01/02/03 — heavy reads route to replica (mirrors Plan 06-02).
    // Optional so older 3-arg construction in legacy unit tests still compiles.
    @Optional() private readonly replicaParam?: PrismaReplicaService,
  ) {}

  /** Replica when wired, otherwise primary (tests / dev fallback). */
  private get r(): PrismaService | PrismaReplicaService {
    return (this.replicaParam as PrismaReplicaService | undefined) ?? this.prisma;
  }

  // Plan 06-07 UNI-01/02 — scope resolver mirrors IdoraService._assertScope and
  // SchoolService scope checks. Looks up institution { type, viloyatId, tumanId }
  // so `assertInstitutionInScope` can fail-CLOSED for MUASSASA_ADMIN /
  // VILOYAT_ADMIN / TUMAN_ADMIN. SUPER_ADMIN + BUXGALTER bypass globally.
  private async _assertScope(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (!user) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("OTM topilmadi");
    assertInstitutionInScope(user, institutionId, {
      viloyatId: inst.viloyatId,
      tumanId: inst.tumanId,
      type: inst.type as any,
    });
  }

  // Plan 06-07 UNI-03 — subscription gate for paid features (akkreditatsiya PDF).
  // Mirrors IdoraService._assertSubscriptionActive. SUPER_ADMIN bypasses for ops.
  private async _assertSubscriptionActive(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (user?.role === UserRole.SUPER_ADMIN) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { libraryId: true },
    });
    if (!inst?.libraryId) {
      // No linked library — treat as active (e.g. state-funded OTM without
      // explicit Subscription row).
      return;
    }
    const sub = await this.r.subscription.findFirst({
      where: { libraryId: inst.libraryId },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    if (!sub) return;
    if (sub.status !== "ACTIVE" && sub.status !== "TRIAL") {
      throw new ForbiddenException(
        "OTM obunasi muzlatilgan/o'chirilgan — to'lov amalga oshiring",
      );
    }
  }

  // ── Talabalar ro'yhati ─────────────────────────────────────────────────────
  // Plan 06-01 UNI-01/UNI-02 P1 BUGFIX (carried forward):
  //   - OTM students live on User.universityId, NOT User.schoolId.
  //   - UserType for OTM is STUDENT_UNIVERSITY enum (schema.prisma:166).

  async getStudents(institutionId: string, filters: {
    faculty?: string;
    course?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }, user?: InstitutionScopedUser) {
    await this._assertScope(institutionId, user);

    const { faculty, course, status, limit = 50, offset = 0 } = filters;
    const where: any = {
      universityId: institutionId,
      type: UserType.STUDENT_UNIVERSITY,
      ...(faculty && { faculty: { contains: faculty, mode: "insensitive" } }),
      ...(course && { direction: { contains: course, mode: "insensitive" } }),
      ...(status && { status }),
    };

    const [students, total] = await Promise.all([
      this.r.user.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: [{ faculty: "asc" }, { name: "asc" }],
        include: {
          readingIndex: {
            orderBy: { calculatedAt: "desc" },
            take: 1,
            select: { score: true, calculatedAt: true },
          },
        },
      }),
      this.r.user.count({ where }),
    ]);

    return {
      data: students.map((s) => ({
        ...s,
        latestRi: s.readingIndex[0] ?? null,
      })),
      total,
      limit,
      offset,
    };
  }

  // ── Talabani tasdiqlash ────────────────────────────────────────────────────

  async approveStudent(userId: string, institutionId: string, user?: InstitutionScopedUser) {
    // Plan 06-07 UNI-01 — scope guard BEFORE any side-effect.
    await this._assertScope(institutionId, user);

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (target.universityId !== institutionId) {
      throw new NotFoundException("Bu talaba sizning OTMingizga tegishli emas");
    }
    if (target.type !== UserType.STUDENT_UNIVERSITY) {
      throw new NotFoundException("Bu foydalanuvchi OTM talabasi emas");
    }

    await this.cache.del(`otm:stats:${institutionId}`);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status: "ACTIVE" },
    });

    // Plan 06-07 UNI-01 — audit log per VALIDATION must_haves.
    await this.prisma.aiAuditLog.create({
      data: {
        scope: "USER",
        scopeId: userId,
        issueType: "OTM_STUDENT_APPROVE",
        severity: "LOW",
        analysis: `OTM student ${userId} approved by admin (university=${institutionId})`,
        recommendation: "Student status set to ACTIVE.",
      },
    }).catch((e) => this.logger.warn(`audit log failed: ${e?.message ?? e}`));

    return updated;
  }

  // Plan 06-07 UNI-01 — reject endpoint with mandatory reason (mirrors Plan 06-02
  // SchoolService.rejectStudent). Sets status=BLOCKED + AiAuditLog.
  async rejectStudent(
    userId: string,
    institutionId: string,
    reason: string,
    user?: InstitutionScopedUser,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException("Rad etish sababi majburiy");
    }
    await this._assertScope(institutionId, user);

    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (target.universityId !== institutionId) {
      throw new BadRequestException("Bu talaba sizning OTMingizga tegishli emas");
    }
    if (target.type !== UserType.STUDENT_UNIVERSITY) {
      throw new BadRequestException("Bu foydalanuvchi OTM talabasi emas");
    }

    await this.cache.del(`otm:stats:${institutionId}`);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status: "BLOCKED" },
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "USER",
        scopeId: userId,
        issueType: "OTM_STUDENT_REJECT",
        severity: "MEDIUM",
        analysis: `OTM student ${userId} rejected. Reason: ${reason.slice(0, 200)}`,
        recommendation: "Notify student; manual review available.",
      },
    }).catch((e) => this.logger.warn(`audit log failed: ${e?.message ?? e}`));

    return updated;
  }

  // ── OTM statistika ─────────────────────────────────────────────────────────
  // Plan 06-07 UNI-02 — faculty grouping is the canonical OTM dimension.
  // The Wave 0 backward-compat `schoolClass` shim has been removed; the new
  // shape exposes `byFaculty` with K-anonymity suppression for buckets < 5.

  async getOtmStats(institutionId: string, user?: InstitutionScopedUser) {
    // Scope assertion BEFORE cache.remember so a forbidden caller does NOT
    // poison the cache key (T-05-02 carry-over to Phase 6).
    await this._assertScope(institutionId, user);

    const cacheKey = `otm:stats:${institutionId}`;
    return this.cache.remember(cacheKey, 300, async () => {
      const institution = await this.r.institution.findUnique({
        where: { id: institutionId },
      });
      if (!institution) throw new NotFoundException("OTM topilmadi");

      const studentWhere = {
        universityId: institutionId,
        type: UserType.STUDENT_UNIVERSITY,
      };

      const [totalStudents, activeStudents, pendingStudents] = await Promise.all([
        this.r.user.count({ where: studentWhere }),
        this.r.user.count({ where: { ...studentWhere, status: "ACTIVE" } }),
        this.r.user.count({ where: { ...studentWhere, status: "PENDING" } }),
      ]);

      // O'rtacha Reading Index
      const avgRiRaw = await this.r.$queryRaw<[{ avg: number | null }]>`
        SELECT AVG(ri.score) as avg
        FROM "ReadingIndex" ri
        INNER JOIN (
          SELECT "userId", MAX("calculatedAt") as latest
          FROM "ReadingIndex"
          GROUP BY "userId"
        ) lr ON ri."userId" = lr."userId" AND ri."calculatedAt" = lr.latest
        INNER JOIN "User" u ON u.id = ri."userId"
        WHERE u."universityId" = ${institutionId}
          AND u."type"::text = 'STUDENT_UNIVERSITY'
          AND u.status = 'ACTIVE'
      `;
      const avgRi = Number(avgRiRaw[0]?.avg ?? 0);

      // Bu oyda tranzaksiyalar
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const monthlyTransactions = await this.r.bookTransaction.count({
        where: {
          user: { universityId: institutionId, type: UserType.STUDENT_UNIVERSITY },
          createdAt: { gte: monthStart },
        },
      });

      // Faol klublar
      const activeClubs = await this.r.club.count({
        where: { institutionId, status: "ACTIVE" },
      });

      // 10 kitob maqsadi (yil ichida)
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      const tenBookGoal = await this.r.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT q."userId") as count FROM (
          SELECT bt."userId", COUNT(*) as cnt
          FROM "BookTransaction" bt
          INNER JOIN "User" u ON u.id = bt."userId"
          WHERE u."universityId" = ${institutionId}
            AND u."type"::text = 'STUDENT_UNIVERSITY'
            AND bt.status = 'RETURNED'
            AND bt."returnedAt" >= ${yearStart}
          GROUP BY bt."userId"
          HAVING COUNT(*) >= 10
        ) q
      `;
      const achievedGoal = Number(tenBookGoal[0]?.count ?? 0);

      // Plan 06-07 UNI-02 — facultyBuckets keyed by User.faculty + K-anonymity.
      // Per-faculty avgRi computed via raw join keyed on faculty; small faculties
      // (< K_ANONYMITY_THRESHOLD) suppress avgRi to null + kAnonymitySuppressed:true.
      const facultyBucketsRaw = await this.r.user.groupBy({
        by: ["faculty"],
        where: { ...studentWhere, status: "ACTIVE", faculty: { not: null } },
        _count: { id: true },
        orderBy: { faculty: "asc" },
      });

      const avgRiByFaculty = new Map<string, number>();
      const facultyNames = facultyBucketsRaw
        .map((b) => b.faculty)
        .filter((f): f is string => !!f);
      if (facultyNames.length > 0) {
        const rawAvg = await this.r.$queryRaw<Array<{ faculty: string; avg: number | null }>>`
          SELECT u."faculty" as "faculty", AVG(ri.score) as avg
          FROM "ReadingIndex" ri
          INNER JOIN (
            SELECT "userId", MAX("calculatedAt") as latest
            FROM "ReadingIndex"
            GROUP BY "userId"
          ) latest_ri ON ri."userId" = latest_ri."userId" AND ri."calculatedAt" = latest_ri.latest
          INNER JOIN "User" u ON u.id = ri."userId"
          WHERE u."universityId" = ${institutionId}
            AND u."type"::text = 'STUDENT_UNIVERSITY'
            AND u.status = 'ACTIVE'
            AND u."faculty" IS NOT NULL
          GROUP BY u."faculty"
        `;
        for (const row of rawAvg) {
          avgRiByFaculty.set(row.faculty, Math.round(Number(row.avg ?? 0) * 10) / 10);
        }
      }

      const byFaculty = facultyBucketsRaw.map((c) => {
        const facultyName = c.faculty ?? "Belgilanmagan";
        const studentCount = c._count.id;
        const suppressed = studentCount < K_ANONYMITY_THRESHOLD;
        return {
          faculty: facultyName,
          studentCount,
          avgRi: suppressed ? null : (avgRiByFaculty.get(facultyName) ?? 0),
          kAnonymitySuppressed: suppressed,
        };
      });

      // Backward-compat: keep `facultyBuckets` (count-only, old shape) for the
      // existing dashboard alongside the new `byFaculty` (with K-anon). Plan
      // 06-08 will remove `facultyBuckets`.
      const facultyBuckets = facultyBucketsRaw.map((c) => ({
        faculty: c.faculty,
        count: c._count.id,
      }));

      // Plan 06-07 UNI-02 — courseBuckets retained (keyed by direction). Course
      // year (1-4) breakdown is provided via the byCourse aggregate too.
      const courseBucketsRaw = await this.r.user.groupBy({
        by: ["direction"],
        where: { ...studentWhere, status: "ACTIVE", direction: { not: null } },
        _count: { id: true },
        orderBy: { direction: "asc" },
      });

      const byCourseRaw = await this.r.user.groupBy({
        by: ["studyCourse"],
        where: { ...studentWhere, status: "ACTIVE", studyCourse: { not: null } },
        _count: { id: true },
        orderBy: { studyCourse: "asc" },
      });
      const byCourse = byCourseRaw.map((c) => {
        const count = c._count.id;
        const suppressed = count < K_ANONYMITY_THRESHOLD;
        return {
          course: c.studyCourse,
          count,
          // We don't compute per-course avgRi here to avoid one more raw query;
          // it's exposed on the dedicated student-progress endpoint instead.
          avgRi: null as number | null,
          kAnonymitySuppressed: suppressed,
        };
      });

      return {
        institutionId,
        name: institution.name,
        students: { total: totalStudents, active: activeStudents, pending: pendingStudents },
        coverageRate: totalStudents > 0 ? Math.round((activeStudents / totalStudents) * 100) : 0,
        avgRi: Math.round(avgRi * 10) / 10,
        goalAchievement: {
          target: 10,
          achieved: achievedGoal,
          rate: activeStudents > 0 ? Math.round((achievedGoal / activeStudents) * 100) : 0,
        },
        activeClubs,
        monthlyTransactions,
        byFaculty,
        byCourse,
        facultyBuckets,
        courseBuckets: courseBucketsRaw.map((c) => ({
          course: c.direction,
          count: c._count.id,
        })),
      };
    });
  }

  // Plan 06-07 UNI-01 — faculty-scoped student list endpoint. Used by
  // GET /otm/:id/faculties/:facultyId/students. Scope-guarded; K-anon does NOT
  // apply at the per-student grain (this returns individual rows for the
  // admin approval queue — small facultys still see their list since they
  // are the admin of record).
  async getStudentsByFaculty(
    institutionId: string,
    facultyId: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);

    const where: any = {
      universityId: institutionId,
      type: UserType.STUDENT_UNIVERSITY,
      faculty: facultyId,
    };

    const students = await this.r.user.findMany({
      where,
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: {
        readingIndex: {
          orderBy: { calculatedAt: "desc" },
          take: 1,
          select: { score: true, calculatedAt: true },
        },
      },
    });

    return {
      faculty: facultyId,
      total: students.length,
      data: students.map((s) => ({
        ...s,
        latestRi: s.readingIndex[0] ?? null,
      })),
    };
  }

  // ── Ilmiy adabiyotlar ──────────────────────────────────────────────────────

  async getProfBooks(institutionId: string, filters: {
    genre?: string;
    limit?: number;
    offset?: number;
  }) {
    const { genre, limit = 50, offset = 0 } = filters;
    const where: any = {
      institutionId,
      ...(genre && { genre }),
    };

    const [data, total] = await Promise.all([
      this.r.profBook.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.r.profBook.count({ where }),
    ]);

    return { data, total, limit, offset };
  }

  async addProfBook(institutionId: string, data: {
    isbn?: string;
    title: string;
    author: string;
    genre?: string;
    description?: string;
    isRequired?: boolean;
    addedById: string;
  }) {
    return this.prisma.profBook.create({
      data: { ...data, institutionId },
    });
  }

  // ── OTM reytingi ──────────────────────────────────────────────────────────

  async getOtmRankings(filters: {
    viloyatId?: string;
    month?: string;
    limit?: number;
  }) {
    const month = filters.month ?? this._currentMonth();
    const limit = filters.limit ?? 50;

    const rankings = await this.r.schoolRating.findMany({
      where: {
        month,
        institution: filters.viloyatId
          ? { viloyatId: filters.viloyatId, type: "OTM" }
          : { type: "OTM" },
      } as any,
      orderBy: { totalScore: "desc" },
      take: limit,
    });

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
  }

  // ── Akkreditatsiya hisoboti PDF ───────────────────────────────────────────
  // Plan 06-07 UNI-03 — Pq9OtmReport composer + subscription gate. Builds
  // per-faculty section (aggregated; NO per-student PII per D-Q7), an
  // akkreditatsiya digital-library checklist (auto-computed PASS/FAIL),
  // and the prof books list. The PDF render is delegated to
  // PdfService.generateAkkreditatsiyaReport which routes every DB string
  // through escapeHtml (XSS regression).

  async generateAccreditationReport(
    institutionId: string,
    user?: InstitutionScopedUser,
    options: { year?: number } = {},
  ): Promise<Buffer> {
    await this._assertScope(institutionId, user);
    await this._assertSubscriptionActive(institutionId, user);

    const data = await this.composeAccreditationData(institutionId, user, options);
    const html = this.pdf.generateAkkreditatsiyaReport(data);
    return this.pdf.generateFromHtml(html);
  }

  /**
   * Plan 06-07 UNI-03 — data composer for the akkreditatsiya PDF.
   * Returns the aggregated `Pq9OtmReport` shape that PdfService renders.
   * No per-student rows leak out — only per-faculty buckets + checklist.
   */
  async composeAccreditationData(
    institutionId: string,
    user?: InstitutionScopedUser,
    options: { year?: number } = {},
  ) {
    const stats = await this.getOtmStats(institutionId, user);
    const profBooksResp = await this.getProfBooks(institutionId, { limit: 20 });
    const now = new Date();
    const year = options.year ?? now.getFullYear();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);

    // Plan 06-07 UNI-03 — digital library checklist auto-computed from counts.
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, libraryId: true, name: true },
    });
    const libraryId = inst?.libraryId ?? null;

    const [bookCount, riCount, transactionCount] = await Promise.all([
      libraryId
        ? this.r.book.count({ where: { libraryId } as any })
        : Promise.resolve(0),
      this.r.readingIndex.count({
        where: { user: { universityId: institutionId, type: UserType.STUDENT_UNIVERSITY } },
      }),
      this.r.bookTransaction.count({
        where: { user: { universityId: institutionId, type: UserType.STUDENT_UNIVERSITY } },
      }),
    ]);

    const sub = libraryId
      ? await this.r.subscription.findFirst({
          where: { libraryId },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        })
      : null;

    const checklist = [
      {
        criterion: "Elektron katalog mavjud (Book entries > 0)",
        status: bookCount > 0 ? ("PASS" as const) : ("FAIL" as const),
        note: `${bookCount} ta kitob ro'yhatda`,
      },
      {
        criterion: "Talabalar uchun Reading Index hisoblanadi",
        status: riCount > 0 ? ("PASS" as const) : ("FAIL" as const),
        note: `${riCount} ta RI yozuvi`,
      },
      {
        criterion: "Faol kutubxonalashtirilgan tranzaksiyalar",
        status: transactionCount > 0 ? ("PASS" as const) : ("FAIL" as const),
        note: `${transactionCount} ta tranzaksiya`,
      },
      {
        criterion: "Tavsiya etiladigan ilmiy adabiyotlar ro'yhati",
        status: profBooksResp.total > 0 ? ("PASS" as const) : ("FAIL" as const),
        note: `${profBooksResp.total} ta ilmiy adabiyot`,
      },
      {
        criterion: "Faol obuna (ACTIVE/TRIAL)",
        status:
          !sub || sub.status === "ACTIVE" || sub.status === "TRIAL"
            ? ("PASS" as const)
            : ("FAIL" as const),
        note: sub ? `Subscription status: ${sub.status}` : "Davlat tomonidan moliyalashtiriladi",
      },
      {
        criterion: "Fakultetlar bo'yicha qamrov",
        status: stats.byFaculty.length > 0 ? ("PASS" as const) : ("FAIL" as const),
        note: `${stats.byFaculty.length} ta fakultet ro'yhatda`,
      },
    ];

    return {
      scope: "OTM" as const,
      institution: {
        id: institutionId,
        name: inst?.name ?? stats.name,
      },
      academicYear: `${year}/${year + 1}`,
      quarter: `${year}-Q${quarter}`,
      generatedAt: now.toISOString(),
      summary: {
        totalStudents: stats.students.total,
        activeStudents: stats.students.active,
        pendingStudents: stats.students.pending,
        coverageRate: stats.coverageRate,
        avgRi: stats.avgRi,
        activeClubs: stats.activeClubs,
        monthlyTransactions: stats.monthlyTransactions,
        goalAchievement: stats.goalAchievement,
      },
      byFaculty: stats.byFaculty,
      digitalLibraryChecklist: checklist,
      profBooks: profBooksResp.data.map((b: any) => ({
        title: b.title,
        author: b.author,
        genre: b.genre ?? null,
        isRequired: !!b.isRequired,
      })),
    };
  }

  private _currentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
}
