import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { StatsGateway } from "../../infra/gateway/stats.gateway";
import { CacheService } from "../../infra/cache/cache.service";
import { Severity } from "@prisma/client";

/**
 * Plan 03-03 Task 1 — FRAUD-08 Inventory reconciliation cron (ALERT-ONLY).
 *
 * Per D-4 (Plan 03-03 RESEARCH.md): this cron NEVER mutates Book or
 * BookTransaction rows. Theft AND inflation are both possible; the only
 * safe response from an autonomous agent is to alert humans. Inventory
 * correction is a deliberate, audited admin decision — not an automated
 * fix.
 *
 * Schedule: 04:00 Asia/Tashkent daily (after the 03:00 institutional cron
 * — same-host, non-overlapping wall-clock).
 *
 * For each ACTIVE library:
 *   expected_available = sum(Book.totalCount)
 *                      - count(BookTransaction WHERE status='BORROWED' for books in this library)
 *                      - count(BookTransfer WHERE fromLibraryId=lib.id AND status='PENDING')
 *
 * The PENDING BookTransfer term is critical. Per Phase 2 BOOK-02 (roaming
 * return ledger): when a borrower returns at a different library, the
 * source-library availableCount is NOT bumped until the bilateral confirm
 * endpoint fires (Plan 02-05). The book is in flight. Without subtracting
 * this term, every legitimate roaming return would trigger a false alert.
 *
 * Discrepancy = |actual - expected| / expected. Threshold 5% (per spec).
 *
 * Stuck-transfer detection (R5): a separate scan flags BookTransfer rows
 * with status='PENDING' older than 30 days as WARNING-severity audit logs.
 * Phase 2 deferred the explicit rejection endpoint; this gives visibility
 * until that endpoint lands.
 *
 * Threat dispositions:
 *  - T-03-03-T (librarian inflates inventory) → mitigate via 5% threshold
 *  - T-03-03-R (stuck transfers go unnoticed) → mitigate via 30-day scan
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private static readonly DISCREPANCY_THRESHOLD = 0.05;
  private static readonly STUCK_TRANSFER_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StatsGateway,
    // Audit H8 — Redis SETNX leader lock for the daily cron (Plan 04-04
    // FIX F pattern). Optional so legacy 2-arg unit-test instantiations
    // still construct; runtime DI always supplies it (CacheModule is
    // @Global). Missing cache ⇒ cron fail-closed (school/club convention).
    @Optional() private readonly cache?: CacheService,
  ) {}

  @Cron("0 4 * * *")
  async reconcileInventory() {
    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern).
    // replicas:3 in prod fire this @Cron concurrently and this service has
    // NO AiAuditLog dedup (unlike AuditService._persistAndNotify) — every
    // extra replica writes duplicate CRITICAL discrepancy alerts. Day-bucket
    // key + 2h TTL (above the full-fund scan's expected runtime).
    if (!this.cache) {
      this.logger.warn(
        "reconcileInventory skipped — CacheService not wired (dev/tests)",
      );
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:inventory-reconciliation:${day}`;
    const acquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[inventory-reconciliation] leader lock held — skipping ${day}`);
      return;
    }

    this.logger.log("Inventory reconciliation: running daily scan");

    const libraries = await this.prisma.library.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
    });

    let alertsRaised = 0;
    for (const lib of libraries) {
      const raised = await this.checkLibrary(lib.id, lib.name);
      if (raised) alertsRaised++;
    }

    // Stuck-transfer scan — separate concern, separate cron pass
    const stuckCount = await this.flagStuckTransfers();

    this.logger.log(
      `Inventory reconciliation: ${alertsRaised} discrepancy alerts, ${stuckCount} stuck transfers`,
    );
    return { libraries: libraries.length, alertsRaised, stuckCount };
  }

  /**
   * Per-library check. Returns true when an alert was raised. ALERT-ONLY —
   * never writes to Book or BookTransaction (D-4).
   */
  private async checkLibrary(
    libraryId: string,
    libraryName: string,
  ): Promise<boolean> {
    const [bookAggregate, borrowed, pendingFrom] = await Promise.all([
      this.prisma.book.aggregate({
        where: { libraryId },
        _sum: { totalCount: true, availableCount: true },
      }),
      this.prisma.bookTransaction.count({
        where: { status: "BORROWED", book: { libraryId } },
      }),
      this.prisma.bookTransfer.count({
        where: { fromLibraryId: libraryId, status: "PENDING" },
      }),
    ]);

    const totalSum = bookAggregate._sum?.totalCount ?? 0;
    const actual = bookAggregate._sum?.availableCount ?? 0;
    const expected = totalSum - borrowed - pendingFrom;

    if (expected <= 0) {
      // No books at this library yet, OR all books are borrowed/in-transit —
      // either way there's nothing to reconcile.
      return false;
    }

    const discrepancy = Math.abs(expected - actual) / expected;
    if (discrepancy <= ReconciliationService.DISCREPANCY_THRESHOLD) {
      return false;
    }

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "KUTUBXONA",
        scopeId: libraryId,
        issueType: "INVENTORY_DISCREPANCY",
        severity: Severity.CRITICAL,
        analysis: `${libraryName}: kutilgan ${expected}, haqiqiy ${actual} (${(discrepancy * 100).toFixed(1)}% farq)`,
        recommendation:
          "Kutubxonachi qo'l bilan inventarizatsiya qilishi va farqni hisobotlashi kerak. Tizim avtomatik tuzatish qilmaydi (D-4).",
      },
    });

    this.gateway.emitNewAlert({
      scope: "KUTUBXONA",
      libraryId,
      libraryName,
      discrepancy,
      expected,
      actual,
      severity: "CRITICAL",
    });

    return true;
  }

  /**
   * R5 stuck-transfer scan — BookTransfer rows where status='PENDING' AND
   * createdAt is older than 30 days produce WARNING audit logs. ALERT-ONLY
   * (the auto-rejection endpoint is Phase 2 deferred work).
   *
   * Uses `requestedAt` (the actual schema field name; `createdAt` does not
   * exist on BookTransfer per Phase 2 02-02 schema).
   */
  private async flagStuckTransfers(): Promise<number> {
    const cutoff = new Date(
      Date.now() - ReconciliationService.STUCK_TRANSFER_DAYS * 24 * 60 * 60 * 1000,
    );

    const stuck = await this.prisma.bookTransfer.findMany({
      where: {
        status: "PENDING",
        requestedAt: { lt: cutoff },
      },
      select: {
        id: true,
        transactionId: true,
        fromLibraryId: true,
        toLibraryId: true,
        requestedAt: true,
      },
    });

    for (const t of stuck) {
      await this.prisma.aiAuditLog.create({
        data: {
          scope: "KUTUBXONA",
          scopeId: t.fromLibraryId,
          issueType: "STUCK_TRANSFER",
          severity: Severity.MEDIUM,
          analysis: `BookTransfer ${t.id} (transaction ${t.transactionId}) ${ReconciliationService.STUCK_TRANSFER_DAYS}+ kun PENDING holatida. Yuborildi: ${t.requestedAt.toISOString()}`,
          recommendation:
            "Qabul qiluvchi kutubxonadan tasdiq so'rang yoki manual rad eting. Phase 2 da avtomatik rad endpoint kechiktirildi.",
        },
      });
    }

    return stuck.length;
  }
}
