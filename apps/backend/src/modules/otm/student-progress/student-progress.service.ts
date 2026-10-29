/**
 * Plan 06-07 UNI-04 — Student academic progress service.
 *
 * Two access modes:
 *  - getProgressForFaculty(user, otmId, facultyId)  — admin view (aggregated)
 *  - getStudentSelfProgress(user)                   — student-self view (own)
 *
 * Privacy contract (D-OQ-3):
 *  - Admin view returns aggregates ONLY (count, avgRi, byCourse, byMonth).
 *  - No per-student PII in admin view (names, sifatId, phone excluded).
 *  - Student-self returns full personal series + faculty + course only for
 *    the authenticated caller.
 *  - K-anonymity threshold 5 applied to byCourse buckets in admin view.
 *
 * Threats mitigated (Plan 06-07 STRIDE register):
 *  - T-06-U2: Faculty admin reads sibling faculty → 403 (faculty match assert)
 *  - T-06-U3: K-anonymity violation in small course buckets → suppressed
 *  - T-06-U5: Student reads classmate's progress → 403 (userId from session)
 */
import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { UserType, UserRole } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../../common/utils/admin-scope.util";
import { K_ANONYMITY_THRESHOLD } from "../../../common/utils/k-anonymity.const";

export interface StudentSelfUser extends InstitutionScopedUser {
  /** Caller's User.id — derived from the JWT, NEVER from request params. */
  sub: string;
}

@Injectable()
export class StudentProgressService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly replicaParam?: PrismaReplicaService,
  ) {}

  private get r(): PrismaService | PrismaReplicaService {
    return (this.replicaParam as PrismaReplicaService | undefined) ?? this.prisma;
  }

  // Plan 06-07 UNI-04 admin view — aggregated faculty progress.
  async getProgressForFaculty(
    otmId: string,
    facultyId: string,
    user: InstitutionScopedUser,
  ) {
    if (!facultyId || facultyId.trim().length === 0) {
      throw new BadRequestException("Fakultet ko'rsatilmagan");
    }

    // Resolve institution + scope-guard.
    const inst = await this.r.institution.findUnique({
      where: { id: otmId },
      select: { id: true, type: true, viloyatId: true, tumanId: true, name: true },
    });
    if (!inst) throw new NotFoundException("OTM topilmadi");
    assertInstitutionInScope(user, otmId, {
      viloyatId: inst.viloyatId,
      tumanId: inst.tumanId,
      type: inst.type as any,
    });

    // Plan 06-07 UNI-04 — extra faculty restriction for MUASSASA_ADMIN.
    // SUPER_ADMIN / TUMAN_ADMIN / VILOYAT_ADMIN bypass this narrower gate
    // (they already passed the institution-level scope above).
    if (user.role === UserRole.MUASSASA_ADMIN) {
      const callerFaculty = (user as any).faculty as string | null | undefined;
      if (callerFaculty && callerFaculty !== facultyId) {
        throw new ForbiddenException(
          "Scope mismatch: fakultet doirasidan tashqarida",
        );
      }
    }

    const studentWhere = {
      universityId: otmId,
      type: UserType.STUDENT_UNIVERSITY,
      faculty: facultyId,
      status: "ACTIVE" as const,
    };

    const studentCount = await this.r.user.count({ where: studentWhere });

    // byCourse aggregate (1..4) with K-anonymity.
    const byCourseRaw = await this.r.user.groupBy({
      by: ["studyCourse"],
      where: { ...studentWhere, studyCourse: { not: null } },
      _count: { id: true },
      orderBy: { studyCourse: "asc" },
    });

    // Per-course avgRi via raw join.
    const avgRiByCourse = new Map<number, number>();
    if (byCourseRaw.length > 0) {
      const rawAvg = await this.r.$queryRaw<Array<{ studyCourse: number; avg: number | null }>>`
        SELECT u."studyCourse" as "studyCourse", AVG(ri.score) as avg
        FROM "ReadingIndex" ri
        INNER JOIN (
          SELECT "userId", MAX("calculatedAt") as latest
          FROM "ReadingIndex"
          GROUP BY "userId"
        ) latest_ri ON ri."userId" = latest_ri."userId" AND ri."calculatedAt" = latest_ri.latest
        INNER JOIN "User" u ON u.id = ri."userId"
        WHERE u."universityId" = ${otmId}
          AND u."type"::text = 'STUDENT_UNIVERSITY'
          AND u.status = 'ACTIVE'
          AND u."faculty" = ${facultyId}
          AND u."studyCourse" IS NOT NULL
        GROUP BY u."studyCourse"
      `;
      for (const row of rawAvg) {
        if (row.studyCourse != null) {
          avgRiByCourse.set(
            Number(row.studyCourse),
            Math.round(Number(row.avg ?? 0) * 10) / 10,
          );
        }
      }
    }

    const byCourse = byCourseRaw.map((c) => {
      const count = c._count.id;
      const suppressed = count < K_ANONYMITY_THRESHOLD;
      return {
        course: c.studyCourse,
        count,
        avgRi: suppressed ? null : (avgRiByCourse.get(Number(c.studyCourse)) ?? 0),
        kAnonymitySuppressed: suppressed,
      };
    });

    // Monthly aggregate (last 12 months) — count + avg of RI scores per month.
    const twelveMoAgo = new Date();
    twelveMoAgo.setMonth(twelveMoAgo.getMonth() - 12);
    const byMonthRaw = await this.r.$queryRaw<Array<{ ym: string; avg: number | null; n: bigint }>>`
      SELECT
        TO_CHAR(ri."calculatedAt", 'YYYY-MM') as ym,
        AVG(ri.score) as avg,
        COUNT(DISTINCT ri."userId") as n
      FROM "ReadingIndex" ri
      INNER JOIN "User" u ON u.id = ri."userId"
      WHERE u."universityId" = ${otmId}
        AND u."type"::text = 'STUDENT_UNIVERSITY'
        AND u."faculty" = ${facultyId}
        AND ri."calculatedAt" >= ${twelveMoAgo}
      GROUP BY ym
      ORDER BY ym ASC
    `;
    const byMonth = byMonthRaw.map((m) => {
      const n = Number(m.n);
      const suppressed = n < K_ANONYMITY_THRESHOLD;
      return {
        month: m.ym,
        sampleSize: n,
        avgRi: suppressed ? null : Math.round(Number(m.avg ?? 0) * 10) / 10,
        kAnonymitySuppressed: suppressed,
      };
    });

    return {
      institution: { id: otmId, name: inst.name },
      facultyName: facultyId,
      studentCount,
      byCourse,
      byMonth,
    };
  }

  // Plan 06-07 UNI-04 student-self view — full personal progress.
  async getStudentSelfProgress(user: StudentSelfUser) {
    if (!user?.sub) {
      throw new ForbiddenException("Foydalanuvchi aniqlanmadi");
    }

    // Plan 06-07 UNI-04 — load THIS user's record from DB (we trust the JWT
    // sub claim for identity, but the type/faculty/course must come from DB).
    const me = await this.r.user.findUnique({
      where: { id: user.sub },
      select: {
        id: true,
        name: true,
        sifatId: true,
        type: true,
        universityId: true,
        faculty: true,
        direction: true,
        studyCourse: true,
        status: true,
      },
    });
    if (!me) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (me.type !== UserType.STUDENT_UNIVERSITY) {
      throw new ForbiddenException(
        "Bu sahifa faqat OTM talabalari uchun",
      );
    }

    // Last 12 months of RI series.
    const twelveMoAgo = new Date();
    twelveMoAgo.setMonth(twelveMoAgo.getMonth() - 12);
    const series = await this.r.readingIndex.findMany({
      where: { userId: me.id, calculatedAt: { gte: twelveMoAgo } },
      orderBy: { calculatedAt: "asc" },
      select: { score: true, calculatedAt: true },
    });
    const currentRi = series.length > 0 ? series[series.length - 1].score : null;
    const monthlySeries = series.map((s) => ({
      at: s.calculatedAt,
      score: s.score,
    }));

    // Books read this year (RETURNED transactions since Jan 1).
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const booksReadThisYear = await this.r.bookTransaction.count({
      where: {
        userId: me.id,
        status: "RETURNED",
        returnedAt: { gte: yearStart },
      },
    });

    // Club memberships count (Plan 06-04 ClubMember table).
    const clubMembershipCount = await this.r.clubMember.count({
      where: { userId: me.id, status: "ACTIVE" },
    });

    return {
      user: {
        id: me.id,
        name: me.name,
        sifatId: me.sifatId,
        universityId: me.universityId,
        faculty: me.faculty,
        direction: me.direction,
        studyCourse: me.studyCourse,
        status: me.status,
      },
      currentRi,
      monthlySeries,
      booksReadThisYear,
      clubMembershipCount,
    };
  }
}
