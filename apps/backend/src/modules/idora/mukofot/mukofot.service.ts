import {
  Injectable,
  Logger,
  Optional,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { NOTIFICATION_QUEUE } from "../../../infra/queue/queue-names";
import { escapeHtml } from "../../../common/utils/escape-html.util";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../../common/utils/admin-scope.util";

/**
 * Plan 06-05 ORG-05 — Mukofot taklifi worker.
 *
 * PQ-9 §9b(d) — each idora MUST nominate the most active reader of the month
 * for a reward. To prevent HR self-dealing (T-06-09), the recommendation MUST
 * originate from Phase 3 InstitutionalService.computeForType('IDORA') (sole
 * writer of OrgRating per D-OQ-1) — never from raw HR input.
 *
 * D-Q6: Mukofot is NEVER auto-disbursed. We write an AiAuditLog row and email
 * the HR admin; the human admin executes the actual reward outside the
 * platform.
 */
@Injectable()
export class MukofotService {
  private readonly logger = new Logger(MukofotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Optional() private readonly replicaParam?: PrismaReplicaService,
    @Optional()
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationQueue?: Queue,
  ) {}

  private get r(): PrismaService | PrismaReplicaService {
    return (this.replicaParam as PrismaReplicaService | undefined) ?? this.prisma;
  }

  /**
   * HR-initiated nomination. Caller-supplied actor MUST NOT match the nominee
   * — that path is blocked here (T-06-09 self-nomination guard).
   *
   * When `systemActor` is true (monthly cron path) the self-nomination guard
   * is bypassed because the MVP source is Phase 3 cron (immutable).
   */
  async recommendMukofot(
    institutionId: string,
    monthlyTopEmployeeUserId: string,
    actor: { sub: string; user?: InstitutionScopedUser; systemActor?: boolean },
    context: { month: string; monthlyRi?: number; userName?: string; institutionName?: string },
  ): Promise<{ auditId: string; flagged: boolean }> {
    if (actor.user) {
      await this._assertScope(institutionId, actor.user);
    }

    // T-06-09 — self-nomination guard. HR admin who sets themselves up as the
    // top reader: skip + flag for auditor review. The cron path bypasses this
    // because the MVP source is Phase 3 (immutable), not user input.
    if (!actor.systemActor && actor.sub === monthlyTopEmployeeUserId) {
      const flag = await this.prisma.aiAuditLog.create({
        data: {
          scope: "INSTITUTION",
          scopeId: institutionId,
          issueType: "MUKOFOT_SELF_NOMINATION_FLAG",
          severity: "MEDIUM" as any,
          analysis: `HR admin ${actor.sub} attempted to self-nominate as mukofot for ${context.month}`,
          recommendation: "Auditor manually review — self-nomination blocked",
        },
      });
      throw new ForbiddenException(
        `Mukofot taklifi rad etildi: HR admin o'zini tavsiya eta olmaydi (audit: ${flag.id})`,
      );
    }

    const audit = await this.prisma.aiAuditLog.create({
      data: {
        scope: "INSTITUTION",
        scopeId: institutionId,
        issueType: "MUKOFOT_TAKLIFI",
        severity: "LOW" as any,
        analysis: JSON.stringify({
          recommendedUserId: monthlyTopEmployeeUserId,
          // Ism ham saqlanadi. Ilgari faqat UUID yozilardi va HR paneldagi
          // mukofot ro'yxati "Top xodim: 6f2a…-…" ko'rinishida chiqardi —
          // HR admin kim haqida gap ketayotganini bilmasdi.
          recommendedUserName: context.userName ?? null,
          byHrId: actor.sub,
          month: context.month,
          monthlyRi: context.monthlyRi ?? null,
          systemActor: Boolean(actor.systemActor),
        }),
        recommendation: "PQ-9 §9b(d) bo'yicha mukofot tavsiya etiladi",
      },
    });

    // Send HR email — best-effort, never throw on enqueue failure.
    await this._notifyHrAdmins(institutionId, {
      institutionName: context.institutionName ?? institutionId,
      userName: context.userName ?? monthlyTopEmployeeUserId,
      monthlyRi: context.monthlyRi ?? 0,
      month: context.month,
    });

    return { auditId: audit.id, flagged: false };
  }

  /**
   * Monthly cron: scans Phase 3 OrgRating writes for new isMvp:true rows and
   * fires the mukofot taklifi for each. Leader-locked via Redis SETNX.
   *
   * @Cron('0 4 1 * *') — 1st of each month at 04:00 Asia/Tashkent (after
   * Phase 3 InstitutionalService cron at 03:00).
   */
  @Cron("0 4 1 * *", {
    name: "mukofot-monthly-scan",
    timeZone: "Asia/Tashkent",
  })
  async scanForNewMvp(): Promise<void> {
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;

    const lockKey = `cron:mukofot-monthly-scan:${month}`;
    const acquired = await this.cache.setNx(lockKey, "1", 22 * 60 * 60);
    if (!acquired) {
      this.logger.debug(`[mukofot] leader lock held — skipping ${month}`);
      return;
    }

    const mvps = await this.r.orgRating.findMany({
      where: { month, isMvp: true },
    });
    if (mvps.length === 0) {
      this.logger.log(`[mukofot] no MVP rows for ${month}`);
      return;
    }

    let processed = 0;
    let deduped = 0;
    let flagged = 0;

    for (const mvp of mvps) {
      // Dedup — skip if MUKOFOT_TAKLIFI already exists for this institution +
      // month.
      const existing = await this.r.aiAuditLog.findFirst({
        where: {
          issueType: "MUKOFOT_TAKLIFI",
          scope: "INSTITUTION",
          scopeId: mvp.institutionId,
          analysis: { contains: `"month":"${month}"` },
        },
        select: { id: true },
      });
      if (existing) {
        deduped++;
        continue;
      }

      // Look up HR admin and institution name for the email body.
      const [hrAdmin, institution] = await Promise.all([
        this.r.user.findFirst({
          where: {
            role: UserRole.MUASSASA_ADMIN,
            organizationId: mvp.institutionId,
            status: "ACTIVE",
          },
          select: { id: true, name: true },
        }),
        this.r.institution.findUnique({
          where: { id: mvp.institutionId },
          select: { name: true },
        }),
      ]);

      // T-06-09 — if HR admin is the MVP themselves, flag instead of email.
      if (hrAdmin && hrAdmin.id === mvp.userId) {
        await this.prisma.aiAuditLog.create({
          data: {
            scope: "INSTITUTION",
            scopeId: mvp.institutionId,
            issueType: "MUKOFOT_SELF_NOMINATION_FLAG",
            severity: "MEDIUM" as any,
            analysis: `Phase 3 MVP equals HR admin (userId=${mvp.userId}) for institution=${mvp.institutionId} month=${month}`,
            recommendation: "Auditor manually review — likely gaming",
          },
        });
        flagged++;
        continue;
      }

      try {
        await this.recommendMukofot(
          mvp.institutionId,
          mvp.userId,
          { sub: "system", systemActor: true },
          {
            month,
            monthlyRi: mvp.avgRi,
            userName: mvp.userName,
            institutionName: institution?.name ?? mvp.institutionId,
          },
        );
        processed++;
      } catch (err) {
        this.logger.error(
          `[mukofot] recommendMukofot failed for ${mvp.institutionId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `[mukofot] month=${month} processed=${processed} deduped=${deduped} flagged=${flagged}`,
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async _assertScope(
    institutionId: string,
    user: InstitutionScopedUser,
  ): Promise<void> {
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Idora topilmadi");
    assertInstitutionInScope(user, institutionId, {
      viloyatId: inst.viloyatId,
      tumanId: inst.tumanId,
      type: inst.type as any,
    });
  }

  private async _notifyHrAdmins(
    institutionId: string,
    payload: { institutionName: string; userName: string; monthlyRi: number; month: string },
  ): Promise<void> {
    if (!this.notificationQueue) {
      this.logger.debug("[mukofot] no notification queue — skipping email");
      return;
    }
    const hrAdmins = await this.r.user.findMany({
      where: {
        role: UserRole.MUASSASA_ADMIN,
        organizationId: institutionId,
        status: "ACTIVE",
      },
      select: { id: true, phone: true },
    });
    if (hrAdmins.length === 0) {
      this.logger.warn(`[mukofot] no HR admin found for ${institutionId} — email skipped`);
      return;
    }

    const safeUserName = escapeHtml(payload.userName);
    const safeInstitutionName = escapeHtml(payload.institutionName);
    const safeMonth = escapeHtml(payload.month);
    const subject = "Mukofot taklifi — eng faol xodim";
    const message =
      `Hurmatli HR admin,\n\n` +
      `${safeMonth} oyida ${safeInstitutionName} idorasining eng faol kitobxoni — ` +
      `${safeUserName} (RI: ${Number(payload.monthlyRi).toFixed(1)}).\n\n` +
      `PQ-9 §9b(d) bandi bo'yicha mukofot tavsiya qilamiz.`;

    for (const admin of hrAdmins) {
      try {
        await this.notificationQueue.add("mukofot-taklifi", {
          type: "email",
          userId: admin.id,
          admin: true,
          subject,
          message,
          jobType: "MUKOFOT_TAKLIFI",
        });
      } catch (err) {
        this.logger.error(
          `[mukofot] notification enqueue failed for admin ${admin.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
