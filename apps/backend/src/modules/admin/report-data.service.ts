/**
 * Plan 05-08 Task 1 (RPT-01) — Report data gathering service.
 *
 * Single responsibility: assemble the unified `ReportData` shape consumed by
 * `PdfService.buildMonthlyReportHtml(data, scope, scopeId?)`. The service is
 * scope-parameterized so the SAME template covers national / viloyat / tuman
 * monthly PDFs (per Plan 05-08 D-6 single-template decision — saves a templating
 * engine dep).
 *
 * Trust boundary: this service is invoked from
 *   (a) AdminController.downloadMonthlyReport — synchronous PDF stream
 *   (b) ReportEmailProcessor — async per-recipient PDF + email path
 * Both paths run AFTER RolesGuard + assertViloyatInScope / assertTumanInScope,
 * so the gather methods themselves do NOT re-assert. They read from the replica
 * via PrismaReplicaService (Plan 05-02 routing) and apply:
 *
 *   - K_ANONYMITY_THRESHOLD (=5) to ALL demographic bucket counts (gender + age)
 *     even though the recipient is a tier admin — defense-in-depth in case the
 *     PDF is forwarded outside the admin team. Matches the suppression contract
 *     established in admin.service._fetchGenderBreakdown / _fetchAgeBreakdown.
 *
 *   - maskNameIfMinor (Phase 3 util) on every "top reader" row. Even though the
 *     PDF recipient is SUPER_ADMIN / tier admin, the email attachment can be
 *     forwarded — Plan 05-08 §TOP-06 carry-over.
 *
 * The returned data is NOT pre-escaped — the template applies `escapeHtml` at
 * render time (Plan 05-04 consolidated util). Single-source-of-truth for HTML
 * escaping per RESEARCH §NOTIF-03.
 */

import { ForbiddenException, Injectable } from "@nestjs/common";
import { LibraryStatus, Prisma, UserStatus } from "@prisma/client";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { AdminService } from "./admin.service";
import { K_ANONYMITY_THRESHOLD } from "../../common/utils/k-anonymity.const";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";

export type ReportScope = "national" | "viloyat" | "tuman";

export interface ReportTableRow {
  label: string;
  value: string;
}

export interface ReportBucket {
  label: string;
  count: number;
  readingIndex: number;
  suppressed: boolean;
}

export interface ReportTopRow {
  rank: number;
  name: string;
  score: number;
}

export interface ReportData {
  /** Top-of-PDF title (DB-derived for viloyat/tuman — must be escapeHtml-ed at render). */
  title: string;
  /** "Iyun 2026" — server-computed. Safe but escaped defensively. */
  period: string;
  /** Headline label appearing as the section caption ("Respublika" / "Navoiy viloyati" / ...). */
  scopeLabel: string;
  /** Generic key/value table at the top of the report. */
  tableRows: ReportTableRow[];
  /** Demographic gender buckets (k-anonymity applied). */
  genderBuckets: ReportBucket[];
  /** Age-group buckets (k-anonymity applied). */
  ageBuckets: ReportBucket[];
  /** Top-5 most active libraries by transaction count this period. */
  topLibraries: Array<{ rank: number; name: string; transactions: number }>;
  /** Top-5 readers by Reading Index this period (names masked when <14). */
  topReaders: ReportTopRow[];
  /** ISO timestamp the data snapshot was taken — used in the footer. */
  generatedAt: string;
}

@Injectable()
export class ReportDataService {
  constructor(
    // Primary client is only used as a fallback when no replica is wired (tests).
    // Production DI always supplies the replica because PrismaModule is @Global.
    private readonly prisma: PrismaService,
    private readonly replica: PrismaReplicaService,
    private readonly admin: AdminService,
  ) {}

  private get r(): PrismaService | PrismaReplicaService {
    return this.replica ?? this.prisma;
  }

  /**
   * Gather scope-parameterized report data for the given period.
   *
   * RPT-01 contract: returns the unified {@link ReportData} shape regardless of
   * scope. Callers (AdminController, ReportEmailProcessor) hand the result to
   * `PdfService.buildMonthlyReportHtml(data, scope, scopeId?)`.
   */
  async gatherForScope(
    scope: ReportScope,
    scopeId: string | null,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReportData> {
    const period = this._buildPeriodLabel(periodStart);
    const scopeLabel = await this._buildScopeLabel(scope, scopeId);
    const title = this._buildTitle(scopeLabel, period);

    if (scope === "national") {
      return this._gatherNational(title, period, scopeLabel, periodStart, periodEnd);
    }
    if (scope === "viloyat") {
      if (!scopeId) {
        throw new ForbiddenException("Viloyat hisoboti uchun scopeId majburiy");
      }
      return this._gatherViloyat(title, period, scopeLabel, scopeId, periodStart, periodEnd);
    }
    if (scope === "tuman") {
      if (!scopeId) {
        throw new ForbiddenException("Tuman hisoboti uchun scopeId majburiy");
      }
      return this._gatherTuman(title, period, scopeLabel, scopeId, periodStart, periodEnd);
    }
    throw new ForbiddenException(`Noma'lum hisobot scope: ${scope}`);
  }

  // ── Scope label helpers ──────────────────────────────────────────────────

  private _buildPeriodLabel(periodStart: Date): string {
    return periodStart.toLocaleString("uz-UZ", { month: "long", year: "numeric" });
  }

  private _buildTitle(scopeLabel: string, period: string): string {
    return `${scopeLabel} oylik kitobxonlik hisoboti — ${period}`;
  }

  private async _buildScopeLabel(scope: ReportScope, scopeId: string | null): Promise<string> {
    if (scope === "national") return "Respublika";
    if (scope === "viloyat" && scopeId) {
      const v = await this.r.viloyat.findUnique({
        where: { id: scopeId },
        select: { name: true },
      });
      return v?.name ? `${v.name} viloyati` : `Viloyat ${scopeId}`;
    }
    if (scope === "tuman" && scopeId) {
      const t = await this.r.tuman.findUnique({
        where: { id: scopeId },
        select: { name: true },
      });
      return t?.name ? `${t.name} tumani` : `Tuman ${scopeId}`;
    }
    return scope;
  }

  // ── Gathering ────────────────────────────────────────────────────────────

  private async _gatherNational(
    title: string,
    period: string,
    scopeLabel: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReportData> {
    const stats = await this.admin.getNationalStats();
    const gender = await this.admin.getGenderBreakdown("national");
    const age = await this.admin.getAgeBreakdown("national");

    const tableRows = this._buildNationalTableRows(stats);
    const [topLibraries, topReaders] = await Promise.all([
      this._topLibraries({ periodStart, periodEnd }),
      this._topReaders({ periodStart, periodEnd }),
    ]);

    return {
      title,
      period,
      scopeLabel,
      tableRows,
      genderBuckets: this._mapGenderBuckets(gender.buckets),
      ageBuckets: this._mapAgeBuckets(age.buckets),
      topLibraries,
      topReaders,
      generatedAt: new Date().toISOString(),
    };
  }

  private async _gatherViloyat(
    title: string,
    period: string,
    scopeLabel: string,
    viloyatId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReportData> {
    // Skip admin scope-assert because the cron / synchronous endpoint already
    // asserted before reaching us; this is the trusted internal path.
    const viloyatStats = await this.admin.getViloyatStats(viloyatId);
    const gender = await this.admin.getGenderBreakdown("viloyat", viloyatId);
    const age = await this.admin.getAgeBreakdown("viloyat", viloyatId);

    const tableRows = this._buildViloyatTableRows(viloyatStats);
    const [topLibraries, topReaders] = await Promise.all([
      this._topLibraries({ periodStart, periodEnd, viloyatId }),
      this._topReaders({ periodStart, periodEnd, viloyatId }),
    ]);

    return {
      title,
      period,
      scopeLabel,
      tableRows,
      genderBuckets: this._mapGenderBuckets(gender.buckets),
      ageBuckets: this._mapAgeBuckets(age.buckets),
      topLibraries,
      topReaders,
      generatedAt: new Date().toISOString(),
    };
  }

  private async _gatherTuman(
    title: string,
    period: string,
    scopeLabel: string,
    tumanId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<ReportData> {
    const tumanStats = await this.admin.getTumanStats(tumanId);
    const gender = await this.admin.getGenderBreakdown("tuman", tumanId);
    const age = await this.admin.getAgeBreakdown("tuman", tumanId);

    const tableRows = this._buildTumanTableRows(tumanStats);
    const [topLibraries, topReaders] = await Promise.all([
      this._topLibraries({ periodStart, periodEnd, tumanId }),
      this._topReaders({ periodStart, periodEnd, tumanId }),
    ]);

    return {
      title,
      period,
      scopeLabel,
      tableRows,
      genderBuckets: this._mapGenderBuckets(gender.buckets),
      ageBuckets: this._mapAgeBuckets(age.buckets),
      topLibraries,
      topReaders,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Table-row builders (key/value rows for the headline section) ─────────

  private _buildNationalTableRows(stats: Awaited<ReturnType<AdminService["getNationalStats"]>>): ReportTableRow[] {
    return [
      { label: "Jami faol foydalanuvchilar", value: this._num(stats.users.total) },
      { label: "Bu oy yangi foydalanuvchilar", value: this._num(stats.users.newThisMonth) },
      { label: "Jami kutubxonalar", value: this._num(stats.libraries.total) },
      { label: "Jami kitoblar (fond)", value: this._num(stats.books.total) },
      { label: "Bu oy tranzaksiyalar", value: this._num(stats.transactions.thisMonth) },
      { label: "O'sish/pasayish (oy)", value: `${stats.transactions.growth ?? 0}%` },
      { label: "Milliy Reading Index", value: `${stats.readingIndex.national ?? 0} ball` },
    ];
  }

  private _buildViloyatTableRows(stats: Awaited<ReturnType<AdminService["getViloyatStats"]>>): ReportTableRow[] {
    return [
      { label: "Kutubxonalar", value: this._num(stats.libraries) },
      { label: "Faol foydalanuvchilar", value: this._num(stats.users) },
      { label: "So'nggi 30 kun tranzaksiyalari", value: this._num(stats.transactions30d) },
      { label: "Viloyat Reading Index", value: `${stats.readingIndex ?? 0} ball` },
    ];
  }

  private _buildTumanTableRows(stats: Awaited<ReturnType<AdminService["getTumanStats"]>>): ReportTableRow[] {
    return [
      { label: "Kutubxonalar", value: this._num(stats.libraries) },
      { label: "Faol foydalanuvchilar", value: this._num(stats.users) },
      { label: "Bu oy tranzaksiyalar", value: this._num(stats.transactionsThisMonth) },
      { label: "Tuman Reading Index", value: `${stats.readingIndex ?? 0} ball` },
      { label: "Faol alertlar", value: this._num(stats.activeAlerts) },
    ];
  }

  private _num(n: number | null | undefined): string {
    return (n ?? 0).toLocaleString("uz-UZ");
  }

  // ── Gender / age bucket projection (k-anonymity carry-over) ──────────────
  //
  // Even though AdminService.getGenderBreakdown / getAgeBreakdown already apply
  // K_ANONYMITY_THRESHOLD suppression, we re-assert here as defense-in-depth
  // (the data shape may evolve and the report should remain safe). Suppressed
  // buckets emit count=0 + readingIndex=0 + suppressed:true so the PDF can
  // render "—" without re-identifying a singleton user.

  private _mapGenderBuckets(
    src: { MALE: { count: number; readingIndex: number; suppressed: boolean };
           FEMALE: { count: number; readingIndex: number; suppressed: boolean };
           UNKNOWN: { count: number; readingIndex: number; suppressed: boolean } },
  ): ReportBucket[] {
    return [
      this._reapplyKAnon("Erkak", src.MALE.count, src.MALE.readingIndex),
      this._reapplyKAnon("Ayol", src.FEMALE.count, src.FEMALE.readingIndex),
      this._reapplyKAnon("Noma'lum", src.UNKNOWN.count, src.UNKNOWN.readingIndex),
    ];
  }

  private _mapAgeBuckets(
    src: Array<{ ageGroup: string; userCount: number; readingIndex: number; suppressed: boolean }>,
  ): ReportBucket[] {
    return src.map((b) => this._reapplyKAnon(b.ageGroup, b.userCount, b.readingIndex));
  }

  private _reapplyKAnon(label: string, count: number, readingIndex: number): ReportBucket {
    const suppressed = count > 0 && count < K_ANONYMITY_THRESHOLD;
    return {
      label,
      count: suppressed ? 0 : count,
      readingIndex: suppressed ? 0 : readingIndex,
      suppressed,
    };
  }

  // ── Top-N queries (libraries + readers) ──────────────────────────────────

  private async _topLibraries(
    where: { periodStart: Date; periodEnd: Date; viloyatId?: string; tumanId?: string },
  ): Promise<Array<{ rank: number; name: string; transactions: number }>> {
    const r = this.r;

    type Row = { libraryId: string; name: string; cnt: bigint | number };
    const rows = await r.$queryRaw<Row[]>`
      SELECT l.id AS "libraryId",
             l.name AS name,
             COUNT(bt.id) AS cnt
      FROM "Library" l
      LEFT JOIN "Book" b ON b."libraryId" = l.id
      LEFT JOIN "BookTransaction" bt ON bt."bookId" = b.id
        AND bt."createdAt" >= ${where.periodStart}
        AND bt."createdAt" < ${where.periodEnd}
      WHERE l.status = ${LibraryStatus.ACTIVE}::"LibraryStatus"
        ${where.viloyatId ? Prisma.sql`AND l."viloyatId" = ${where.viloyatId}` : Prisma.empty}
        ${where.tumanId ? Prisma.sql`AND l."tumanId" = ${where.tumanId}` : Prisma.empty}
      GROUP BY l.id, l.name
      HAVING COUNT(bt.id) > 0
      ORDER BY cnt DESC
      LIMIT 5
    `;

    return rows.map((row, i) => ({
      rank: i + 1,
      name: row.name,
      transactions: Number(row.cnt ?? 0),
    }));
  }

  private async _topReaders(
    where: { periodStart: Date; periodEnd: Date; viloyatId?: string; tumanId?: string },
  ): Promise<ReportTopRow[]> {
    const r = this.r;

    type Row = { id: string; name: string; dob: Date | null; score: number | null };
    const rows = await r.$queryRaw<Row[]>`
      SELECT u.id AS id,
             u.name AS name,
             u.dob AS dob,
             COALESCE(MAX(ri.score), 0)::float AS score
      FROM "User" u
      LEFT JOIN "ReadingIndex" ri ON ri."userId" = u.id
        AND ri."calculatedAt" >= ${where.periodStart}
        AND ri."calculatedAt" < ${where.periodEnd}
      LEFT JOIN "Address" a ON u."addressId" = a.id
      WHERE u.status = ${UserStatus.ACTIVE}::"UserStatus"
        ${where.viloyatId ? Prisma.sql`AND a."viloyatId" = ${where.viloyatId}` : Prisma.empty}
        ${where.tumanId ? Prisma.sql`AND a."tumanId" = ${where.tumanId}` : Prisma.empty}
      GROUP BY u.id, u.name, u.dob
      ORDER BY score DESC
      LIMIT 5
    `;

    return rows.map((row, i) => ({
      rank: i + 1,
      // Plan 05-08 TOP-06 carry-over: every reader name passes through
      // maskNameIfMinor even though the recipient is an admin.
      name: maskNameIfMinor(row.name, row.dob),
      score: +(Number(row.score ?? 0)).toFixed(1),
    }));
  }
}

