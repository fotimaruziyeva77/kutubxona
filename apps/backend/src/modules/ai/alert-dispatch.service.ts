import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { AiAuditLog } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../infra/cache/cache.service";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import {
  ALERT_TYPES,
  ALERT_SEVERITY,
  type AlertType,
  type AlertSeverity,
} from "../../common/constants/alert-types.const";

/**
 * Plan 05-05 T2 — AlertDispatchService.
 *
 * Single owner of the alert → (channel × recipient role) routing matrix.
 * Consumed by AuditService._persistAndNotify after the WebSocket emit and
 * by AdminController POST /admin/system-down-test (ALERT-06 receive side).
 *
 * Routing matrix (per RESEARCH §Notification routing matrix):
 *   LIBRARY_INACTIVE → KRITIK: sms+push+email to TUMAN_ADMIN + VILOYAT_ADMIN
 *   RI_DROPPED       → OGOH:   push+email to TUMAN_ADMIN
 *   FUND_SHORTAGE    → OGOH:   push to KUTUBXONACHI of affected library
 *   CLUB_INACTIVE    → OGOH:   push to KLUB_RAHBARI of affected club
 *   RI_RISING        → AXBOROT: WEEKLY digest (Monday 09:30) to VILOYAT_ADMIN
 *   SYSTEM_DOWN      → KRITIK: sms+email to SUPER_ADMIN (ADMIN_NOTIFICATION_EMAILS fallback)
 *
 * Dedup contract (T-05-03):
 *   key = alert:dedupe:<alertType>:<scopeId>:<YYYY-MM-DD>:<recipientUserId>:<channel>
 *   TTL = 24h. setNx false ⇒ skip duplicate dispatch.
 *
 * Failure handling (T-05-DISP-FAIL):
 *   Best-effort side effect. On queue/dispatch error, log + continue. Do NOT
 *   roll back the AiAuditLog row — it remains for retry/manual processing.
 */

type Channel = "sms" | "push" | "email";

interface MatrixEntry {
  channels: Channel[];
  recipientRoles: UserRole[];
  severity: AlertSeverity;
  deferred?: "weekly-digest";
}

interface Recipient {
  id: string;
  email: string | null;
  phone: string | null;
}

const MATRIX: Record<AlertType, MatrixEntry> = {
  [ALERT_TYPES.LIBRARY_INACTIVE]: {
    channels: ["sms", "push", "email"],
    recipientRoles: [UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN],
    severity: ALERT_SEVERITY.KRITIK,
  },
  [ALERT_TYPES.RI_DROPPED]: {
    channels: ["push", "email"],
    recipientRoles: [UserRole.TUMAN_ADMIN],
    severity: ALERT_SEVERITY.OGOHLANTIRISH,
  },
  [ALERT_TYPES.FUND_SHORTAGE]: {
    channels: ["push"],
    recipientRoles: [UserRole.KUTUBXONACHI],
    severity: ALERT_SEVERITY.OGOHLANTIRISH,
  },
  [ALERT_TYPES.CLUB_INACTIVE]: {
    channels: ["push"],
    recipientRoles: [UserRole.KLUB_RAHBARI],
    severity: ALERT_SEVERITY.OGOHLANTIRISH,
  },
  [ALERT_TYPES.RI_RISING]: {
    channels: ["email"],
    recipientRoles: [UserRole.VILOYAT_ADMIN],
    severity: ALERT_SEVERITY.AXBOROT,
    deferred: "weekly-digest",
  },
  [ALERT_TYPES.SYSTEM_DOWN]: {
    channels: ["sms", "email"],
    recipientRoles: [UserRole.SUPER_ADMIN],
    severity: ALERT_SEVERITY.KRITIK,
  },
  [ALERT_TYPES.INVENTORY_DISCREPANCY]: {
    channels: ["push", "email"],
    recipientRoles: [UserRole.MUASSASA_ADMIN, UserRole.KUTUBXONACHI],
    severity: ALERT_SEVERITY.OGOHLANTIRISH,
  },
  [ALERT_TYPES.ORDER_REQUEST]: {
    channels: ["email"],
    recipientRoles: [UserRole.SUPER_ADMIN, UserRole.TUMAN_ADMIN],
    severity: ALERT_SEVERITY.AXBOROT,
  },
  // Plan 06-05 ORG-04 — Kitob burchagi 90+ kun yangilanmagan; routed to
  // MUASSASA_ADMIN of the institution (push + email). Label:
  // "Kitob burchagi 90+ kun yangilanmagan".
  [ALERT_TYPES.BOOK_CORNER_REMINDER]: {
    channels: ["push", "email"],
    recipientRoles: [UserRole.MUASSASA_ADMIN],
    severity: ALERT_SEVERITY.OGOHLANTIRISH,
  },
  // Plan 07-04 AI-03 — RCA result logged after a tuman RI drop. Informational
  // analysis (Severity.LOW in audit.service); routed as AXBOROT email to the
  // affected TUMAN_ADMIN alongside the actionable RI_DROPPED alert.
  [ALERT_TYPES.ROOT_CAUSE_ANALYSIS]: {
    channels: ["email"],
    recipientRoles: [UserRole.TUMAN_ADMIN],
    severity: ALERT_SEVERITY.AXBOROT,
  },
};

@Injectable()
export class AlertDispatchService {
  private readonly logger = new Logger(AlertDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Optional() private readonly replicaParam?: PrismaReplicaService,
    @Optional() private readonly config?: ConfigService,
    @Optional()
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationQueue?: Queue,
  ) {}

  private get replica(): PrismaService | PrismaReplicaService {
    return this.replicaParam ?? this.prisma;
  }

  /**
   * Dispatch a single AiAuditLog row to its routing matrix recipients.
   * Returns silently for RI_RISING (deferred to weekly digest) and for
   * alert types absent from the matrix.
   */
  async dispatch(alert: Pick<AiAuditLog, "id" | "scope" | "scopeId" | "issueType" | "severity" | "analysis" | "recommendation" | "createdAt">): Promise<void> {
    const entry = MATRIX[alert.issueType as AlertType];
    if (!entry) {
      this.logger.debug(`[alert-dispatch] no matrix entry for ${alert.issueType}`);
      return;
    }

    // RI_RISING + any other deferred entry: skip immediate dispatch.
    // The weekly digest cron (dispatchRiRisingWeeklyDigest) handles batching.
    if (entry.deferred === "weekly-digest") {
      this.logger.log(
        `[alert-dispatch] ${alert.issueType} deferred to weekly digest`,
      );
      return;
    }

    const recipients = await this._resolveRecipients(
      entry.recipientRoles,
      alert.scope,
      alert.scopeId,
    );

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let dispatched = 0;
    let deduped = 0;

    for (const recipient of recipients) {
      for (const channel of entry.channels) {
        const dedupKey = this._dedupKey(
          alert.issueType,
          alert.scopeId,
          recipient.id,
          channel,
          day,
        );
        const ok = await this.cache.setNx(dedupKey, "1", 24 * 60 * 60);
        if (!ok) {
          deduped++;
          continue;
        }
        try {
          const ok = await this._enqueue(channel, recipient, alert);
          if (ok) dispatched++;
        } catch (err) {
          this.logger.error(
            `[alert-dispatch] enqueue failed (${channel} → ${recipient.id}): ${(err as Error).message}`,
          );
        }
      }
    }

    this.logger.log(
      `[alert-dispatch] ${alert.issueType} scope=${alert.scope}:${alert.scopeId} ` +
      `dispatched=${dispatched} deduped=${deduped} recipients=${recipients.length}`,
    );
  }

  /**
   * Weekly digest cron — Monday 09:30 Asia/Tashkent (per Q3 user decision).
   * Aggregates all RI_RISING AiAuditLog rows from the last 7 days, groups by
   * VILOYAT, and emails ONE digest per VILOYAT_ADMIN.
   */
  @Cron("30 9 * * 1", {
    name: "ri-rising-weekly-digest",
    timeZone: "Asia/Tashkent",
  })
  async dispatchRiRisingWeeklyDigest(): Promise<void> {
    if (!this.notificationQueue) {
      this.logger.debug("[alert-dispatch] no queue; skipping weekly digest");
      return;
    }

    // Audit H8 — Redis SETNX leader lock (Plan 04-04 FIX F pattern). The
    // per-recipient setNx dedup below already prevents duplicate sends, but
    // without a leader gate all 3 prod replicas still run the full grouping
    // fan-out. Fires Mondays only, so the day bucket is unique per run.
    const lockDay = new Date().toISOString().slice(0, 10);
    const lockKey = `cron:ri-rising-weekly-digest:${lockDay}`;
    const lockAcquired = await this.cache.setNx(lockKey, "1", 2 * 60 * 60);
    if (!lockAcquired) {
      this.logger.debug(`[ri-rising-weekly-digest] leader lock held — skipping ${lockDay}`);
      return;
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const risingLogs = await this.replica.aiAuditLog.findMany({
      where: {
        issueType: ALERT_TYPES.RI_RISING,
        createdAt: { gte: weekAgo },
      },
      orderBy: { createdAt: "desc" },
    });

    if (risingLogs.length === 0) {
      this.logger.log("[alert-dispatch] weekly digest: no RI_RISING events");
      return;
    }

    // Group by viloyat via Tuman.viloyatId lookup.
    const tumanIds = Array.from(new Set(risingLogs.map((r) => r.scopeId)));
    const tumans = await this.replica.tuman.findMany({
      where: { id: { in: tumanIds } },
      select: { id: true, viloyatId: true, name: true },
    });
    const tumanToViloyat = new Map(tumans.map((t) => [t.id, t.viloyatId]));
    const tumanNames = new Map(tumans.map((t) => [t.id, t.name]));

    // Group rising logs by viloyatId.
    const byViloyat = new Map<string, typeof risingLogs>();
    for (const log of risingLogs) {
      const viloyatId = tumanToViloyat.get(log.scopeId);
      if (!viloyatId) continue;
      const existing = byViloyat.get(viloyatId) ?? [];
      existing.push(log);
      byViloyat.set(viloyatId, existing);
    }

    const isoWeek = this._isoWeekKey(new Date());

    for (const [viloyatId, logs] of byViloyat.entries()) {
      const admins = await this.replica.user.findMany({
        where: {
          role: UserRole.VILOYAT_ADMIN,
          status: "ACTIVE",
          address: { viloyatId },
        },
        select: { id: true, phone: true },
      });

      for (const admin of admins) {
        const dedupKey = `alert:dedupe:weekly-digest:${viloyatId}:${admin.id}:${isoWeek}`;
        const ok = await this.cache.setNx(dedupKey, "1", 8 * 24 * 60 * 60);
        if (!ok) continue;

        const summaryLines = logs.map(
          (l) => `• ${tumanNames.get(l.scopeId) ?? l.scopeId}: ${l.analysis}`,
        );
        const message =
          `Hududingizda kitobxonlik indeksi o'sgan tumanlar (so'nggi 7 kun):\n\n` +
          summaryLines.join("\n");

        try {
          // Q7: User has no email field — fall back to admin-fallback email
          // path (NotificationProcessor reads ADMIN_NOTIFICATION_EMAILS).
          await this.notificationQueue.add("ri-rising-digest", {
            type: "email",
            userId: admin.id,
            admin: true,
            subject: "[SIFAT LIBRARY] Reading Index o'sish — haftalik xulosa",
            message,
            jobType: "ri-rising-digest",
          });
        } catch (err) {
          this.logger.error(
            `[alert-dispatch] digest enqueue failed for admin ${admin.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    this.logger.log(
      `[alert-dispatch] weekly digest: ${risingLogs.length} events across ${byViloyat.size} viloyats`,
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private _dedupKey(
    alertType: string,
    scopeId: string,
    recipientUserId: string,
    channel: string,
    day: string,
  ): string {
    return `alert:dedupe:${alertType}:${scopeId}:${day}:${recipientUserId}:${channel}`;
  }

  /**
   * Resolve recipient users for the given roles + alert scope. Geographic
   * roles (TUMAN_ADMIN / VILOYAT_ADMIN) filter by the scope's geo affinity:
   *   scope=TUMAN  → TUMAN_ADMIN.address.tumanId == scopeId
   *                  VILOYAT_ADMIN via Tuman.viloyatId lookup
   *   scope=KUTUBXONA / KLUB / IDORA → all admins of the role (broad fan-out);
   *                                    matrix already narrows by role.
   *
   * SUPER_ADMIN resolution falls back to ADMIN_NOTIFICATION_EMAILS env CSV
   * when the row.email is null (Q7 contract).
   */
  private async _resolveRecipients(
    roles: UserRole[],
    scope: string,
    scopeId: string,
  ): Promise<Recipient[]> {
    const out: Recipient[] = [];

    let resolvedViloyatId: string | null = null;
    if (scope === "TUMAN") {
      const tuman = await this.replica.tuman.findUnique({
        where: { id: scopeId },
        select: { viloyatId: true },
      });
      resolvedViloyatId = tuman?.viloyatId ?? null;
    }

    // Plan 06-05-fix FIX C — INSTITUTION scope narrowing (mirrors Plan 05-05
    // FIX C). Without this, an INSTITUTION-scoped alert (e.g.
    // BOOK_CORNER_REMINDER for ORG-X) would resolve `recipientRoles =
    // [MUASSASA_ADMIN]` and fan-out to EVERY MUASSASA_ADMIN in the country.
    // We resolve the institution → its FK type (school/uni/org) → narrow
    // the user query by that FK so only admins of THIS institution receive
    // the alert.
    let institutionFkFilter: Record<string, unknown> | null = null;
    let institutionResolvable = true;
    if (scope === "INSTITUTION") {
      const inst = await this.replica.institution.findUnique({
        where: { id: scopeId },
        select: { type: true },
      });
      if (!inst) {
        this.logger.warn(
          `[alert-dispatch] INSTITUTION ${scopeId} not resolvable; skipping MUASSASA_ADMIN narrowing`,
        );
        institutionResolvable = false;
      } else {
        const t = inst.type as string;
        if (t === "ORG" || t === "IDORA") {
          institutionFkFilter = { organizationId: scopeId };
        } else if (t === "SCH" || t === "MAKTAB" || t === "SCHOOL") {
          institutionFkFilter = { schoolId: scopeId };
        } else if (t === "UNI" || t === "OTM" || t === "UNIVERSITY") {
          institutionFkFilter = { universityId: scopeId };
        } else {
          this.logger.warn(
            `[alert-dispatch] Unsupported institution type for MUASSASA_ADMIN narrowing: ${t}`,
          );
          institutionResolvable = false;
        }
      }
    }

    for (const role of roles) {
      try {
        let where: Record<string, unknown> = {
          role,
          status: "ACTIVE",
        };

        if (role === UserRole.TUMAN_ADMIN && scope === "TUMAN") {
          where = { ...where, address: { tumanId: scopeId } };
        } else if (
          role === UserRole.VILOYAT_ADMIN &&
          scope === "TUMAN" &&
          resolvedViloyatId
        ) {
          where = { ...where, address: { viloyatId: resolvedViloyatId } };
        } else if (
          role === UserRole.MUASSASA_ADMIN &&
          scope === "INSTITUTION"
        ) {
          if (!institutionResolvable) {
            // Cannot narrow safely — skip rather than fan out unscoped.
            continue;
          }
          where = { ...where, ...(institutionFkFilter ?? {}) };
        }

        const users = await this.replica.user.findMany({
          where: where as never,
          select: { id: true, phone: true },
        });
        for (const u of users) {
          // User schema has no `email` column — email channels fall through
          // to the ADMIN_NOTIFICATION_EMAILS env fallback (appended below).
          out.push({ id: u.id, email: null, phone: u.phone ?? null });
        }
      } catch (err) {
        this.logger.warn(
          `[alert-dispatch] _resolveRecipients failed for role=${role}: ${(err as Error).message}`,
        );
      }
    }

    // Env-CSV email fallback (Q7) — User schema has no `email` column, so
    // SUPER_ADMIN (and any other email-routed alert) falls through to the
    // operator-supplied ADMIN_NOTIFICATION_EMAILS list. Phone-channel only
    // recipients above keep their per-user phone resolution.
    if (roles.includes(UserRole.SUPER_ADMIN)) {
      const csv =
        this.config?.get<string>("ADMIN_NOTIFICATION_EMAILS") ??
        process.env.ADMIN_NOTIFICATION_EMAILS ??
        "";
      const extras = csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const email of extras) {
        out.push({ id: `env:${email}`, email, phone: null });
      }
    }

    return out;
  }

  /**
   * Enqueue a notification job per (channel, recipient). Email shapes use
   * the default escapeHtml-protected body in MailClient (Plan 05-04).
   *
   * Returns true when a queue job was actually added; false when the
   * channel was skipped (missing phone/email/queue). Caller uses this to
   * keep the `dispatched` counter accurate.
   */
  private async _enqueue(
    channel: Channel,
    recipient: Recipient,
    alert: Pick<AiAuditLog, "issueType" | "analysis" | "recommendation">,
  ): Promise<boolean> {
    if (!this.notificationQueue) {
      this.logger.debug("[alert-dispatch] no queue configured; skipping enqueue");
      return false;
    }

    const message = `${alert.analysis}\n\n${alert.recommendation}`;
    const subject = `[SIFAT LIBRARY] ${alert.issueType}`;

    if (channel === "sms") {
      if (!recipient.phone) return false;
      await this.notificationQueue.add("alert-sms", {
        type: "sms",
        phone: recipient.phone,
        userId: recipient.id.startsWith("env:") ? undefined : recipient.id,
        message,
        jobType: alert.issueType,
      });
      return true;
    }
    if (channel === "push") {
      if (recipient.id.startsWith("env:")) return false;
      await this.notificationQueue.add("alert-push", {
        type: "push",
        userId: recipient.id,
        title: subject,
        message,
        jobType: alert.issueType,
      });
      return true;
    }
    if (channel === "email") {
      if (!recipient.email) return false;
      await this.notificationQueue.add("alert-email", {
        type: "email",
        email: recipient.email,
        userId: recipient.id.startsWith("env:") ? undefined : recipient.id,
        subject,
        message,
        jobType: alert.issueType,
      });
      return true;
    }
    return false;
  }

  /** ISO-week bucket key for the digest dedup (e.g. "2026-W23"). */
  private _isoWeekKey(d: Date): string {
    const target = new Date(d.getTime());
    target.setUTCHours(0, 0, 0, 0);
    // ISO 8601: Thursday of the current week determines the year.
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
}
