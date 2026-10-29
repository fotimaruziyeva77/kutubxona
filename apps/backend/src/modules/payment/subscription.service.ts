import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { SmsService } from "../../infra/sms/sms.service";
import { CacheService } from "../../infra/cache/cache.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { InvoiceService } from "./invoice.service";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import { SubscriptionStatus, UserRole, Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { PLAN_PRICES, PLAN_LABELS, getPlanCatalog } from "./plan-prices.const";

// ── Plan 04-03 PAY-06 / PAY-08: 5×5 transition matrix ──────────────────────
//
// Documented in 04-RESEARCH.md §Subscription State Machine. The matrix is the
// single source of truth — any transition not listed here throws. FROZEN and
// DELETED are admin-only (SUPER_ADMIN / BUXGALTER) AND require a reason.
//
// SYSTEM (background jobs, webhooks) is allowed only the auto transitions:
// TRIAL→PENDING (trial expiry, paid plan), TRIAL→ACTIVE (trial expiry, free
// plan), PENDING→ACTIVE (webhook payment-confirmed). SYSTEM can NEVER produce
// FROZEN or DELETED — that perimeter is enforced in assertTransition.

export const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  TRIAL:   ["PENDING", "ACTIVE", "FROZEN"],
  PENDING: ["ACTIVE", "FROZEN"],
  ACTIVE:  ["PENDING", "FROZEN", "DELETED"],
  FROZEN:  ["ACTIVE", "DELETED"],
  DELETED: [],
};

export const SYSTEM_ALLOWED: Array<[SubscriptionStatus, SubscriptionStatus]> = [
  ["TRIAL", "PENDING"],
  ["TRIAL", "ACTIVE"],   // free plans only (GOV/MAH) — gated by planType
  ["PENDING", "ACTIVE"], // webhook payment-confirmed
  // Plan 04-03 audit-fix FIX D (SEC HIGH) — Payme refund propagation. When a
  // PAID payment is cancelled by Payme, the subscription that the invoice
  // belongs to goes to PENDING (not FROZEN) so it flags admin attention but
  // doesn't lock the customer out of their own billing UI. FROZEN remains
  // strictly admin-driven (sabab majburiy, §XIII.3 CLAUDE.md).
  ["ACTIVE", "PENDING"],
];

export const FREE_PLAN_TYPES: readonly string[] = ["GOV", "MAH"];

export type TransitionActor = "SYSTEM" | UserRole;

/**
 * Standalone validator usable both from SubscriptionService and from inside
 * a Payme/Click webhook $transaction (where calling the injectable service
 * would break tx atomicity). Pure function — no side effects.
 *
 * Throws:
 * - BadRequestException — illegal (from -> to) transition; FROZEN/DELETED
 *   missing reason; SYSTEM TRIAL->ACTIVE for a paid plan.
 * - ForbiddenException — FROZEN/DELETED attempted by a non-admin role.
 */
export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
  by: TransitionActor,
  reason: string | undefined,
  planType?: string,
): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new BadRequestException(`Invalid transition ${from} → ${to}`);
  }

  if (by === "SYSTEM") {
    const allowed = SYSTEM_ALLOWED.some(([f, t]) => f === from && t === to);
    if (!allowed) {
      throw new BadRequestException(`SYSTEM cannot transition ${from} → ${to}`);
    }
    if (from === "TRIAL" && to === "ACTIVE") {
      if (!planType || !FREE_PLAN_TYPES.includes(planType)) {
        throw new BadRequestException(
          `SYSTEM TRIAL → ACTIVE only allowed for free plans (GOV/MAH)`,
        );
      }
    }
    return;
  }

  // Human actor path. FROZEN / DELETED gated to SUPER_ADMIN + BUXGALTER and
  // require a non-empty reason (CLAUDE.md §XIII.3 "sabab majburiy").
  if (to === "FROZEN" || to === "DELETED") {
    if (by !== UserRole.SUPER_ADMIN && by !== UserRole.BUXGALTER) {
      throw new ForbiddenException(
        `Only SUPER_ADMIN or BUXGALTER can move to ${to}`,
      );
    }
    // Plan 04-03 audit-fix FIX G — tighten the reason check. Old `!reason.trim()`
    // accepted "ok" or "  a  " — too short to be a meaningful audit entry.
    // Require 3+ chars AFTER trim so "fr" / "  ok  " / "   " all fail.
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException(
        `${to} requires a non-empty reason of at least 3 characters`,
      );
    }
  }
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly cache: CacheService,
    private readonly invoiceService: InvoiceService,
    // Plan 04-04 PAY-07 — daily reminder cron enqueues SMS jobs into the
    // shared NOTIFICATION_QUEUE so the cron loop returns immediately even
    // when the Eskiz provider is slow / unreachable. The processor handles
    // delivery + retries + dev no-op uniformly.
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notifQueue: Queue,
    // Plan 04-04 audit-fix FIX F — distributed leader lock. Three backend
    // replicas would each fire the @Cron handlers; SETNX gates so only one
    // wins the day.
    private readonly redisLock: RedisLockService,
    private readonly config: ConfigService,
  ) {}

  // ── Yangi subscription yaratish (trial) ─────────────────────────────────

  async createTrial(libraryId: string, planType: string) {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    return this.prisma.subscription.create({
      data: {
        libraryId,
        planType,
        status: SubscriptionStatus.TRIAL,
        startDate: now,
        endDate: end,
        trialEnd,
      },
    });
  }

  // ── Subscription holati ──────────────────────────────────────────────────

  async getSubscription(libraryId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { libraryId },
      orderBy: { createdAt: "desc" },
      include: {
        invoices: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });
    if (!sub) return null;
    // Tarif narxi + nomini ham qaytaramiz — akkaunt sahifasi "tarifingiz X
    // so'm/yil" deb ko'rsatadi (avval faqat planType kodi ko'rinardi).
    return {
      ...sub,
      planPrice: PLAN_PRICES[sub.planType] ?? 0,
      planLabel: PLAN_LABELS[sub.planType] ?? sub.planType,
    };
  }

  // Barcha tariflar ro'yxati (narx + nom) — frontend "Mavjud tariflar" jadvali.
  listPlans() {
    return getPlanCatalog();
  }

  async getAllSubscriptions(filters: {
    status?: string;
    planType?: string;
    page?: number;
    limit?: number;
    // Plan 04-04 audit-fix FIX D — tier-admin scope filter, injected by the
    // controller. SUPER_ADMIN / BUXGALTER pass through with no filter.
    scopeViloyatId?: string;
    scopeTumanId?: string;
  }) {
    const {
      status,
      planType,
      page = 1,
      limit = 50,
      scopeViloyatId,
      scopeTumanId,
    } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (planType) where.planType = planType;
    if (scopeViloyatId || scopeTumanId) {
      const libFilter: any = {};
      if (scopeViloyatId) libFilter.viloyatId = scopeViloyatId;
      if (scopeTumanId) libFilter.tumanId = scopeTumanId;
      where.library = libFilter;
    }

    const [subscriptions, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        include: {
          library: { select: { id: true, name: true, type: true, viloyatId: true } },
          invoices: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { status: true, amount: true, dueDate: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    return { subscriptions, total, page, limit };
  }

  // ── Subscription yangilash ───────────────────────────────────────────────

  /**
   * Plan 04-03 audit-fix FIX B (SEC HIGH) — renew goes through the validator.
   *
   * Pre-fix the free-plan branch called prisma.subscription.update directly
   * with status=ACTIVE, bypassing assertSubscriptionTransition AND the audit
   * log. Two failure modes:
   *   1. A FROZEN/DELETED free-plan sub would silently un-freeze itself.
   *   2. No AiAuditLog row landed for the renew — admin lost the trail.
   *
   * Fix:
   *   - TRIAL → ACTIVE: route through updateStatus(SYSTEM) — the validator's
   *     planType gate enforces this is only legal for GOV/MAH (free) plans.
   *   - ACTIVE → endDate extension: not a state transition. Use the new
   *     extendEndDate() helper which wraps the update + audit in a tx.
   *   - Anything else (PENDING, FROZEN, DELETED) → BadRequestException; you
   *     must go through admin freeze/unfreeze first.
   */
  async renewSubscription(
    subscriptionId: string,
    provider?: "PAYME" | "CLICK" | "BANK_TRANSFER",
  ) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { library: true },
    });
    if (!sub) throw new NotFoundException("Subscription topilmadi");

    const price = PLAN_PRICES[sub.planType] ?? 0;

    // Bepul tariflar (GOV / MAH) — to'lov kerak emas. Validator + audit log
    // orqali o'tadi.
    if (price === 0) {
      if (sub.status === SubscriptionStatus.TRIAL) {
        // TRIAL → ACTIVE (SYSTEM whitelist gates on planType being GOV/MAH).
        await this.updateStatus(
          subscriptionId,
          SubscriptionStatus.ACTIVE,
          "avtomatik trial yangilanishi",
          "system",
          "SYSTEM",
        );
        const newEnd = new Date(sub.endDate.getTime() + 365 * 24 * 60 * 60 * 1000);
        return this.extendEndDate(subscriptionId, newEnd, "system", "SYSTEM");
      }
      if (sub.status === SubscriptionStatus.ACTIVE) {
        // State-preserving renewal — just extend endDate, log to audit.
        const newEnd = new Date(sub.endDate.getTime() + 365 * 24 * 60 * 60 * 1000);
        return this.extendEndDate(subscriptionId, newEnd, "system", "SYSTEM");
      }
      // PENDING / FROZEN / DELETED — refuse. Admin must un-freeze first.
      throw new BadRequestException(
        `Free-plan renewal not allowed from ${sub.status}`,
      );
    }

    // Faktura yaratish (paid plans). On payment confirmation Payme/Click
    // webhook moves PENDING → ACTIVE via the validator.
    const invoice = await this.invoiceService.createInvoice(subscriptionId, price, 15);
    this.logger.log(`Yangi faktura yaratildi: ${invoice.id} — ${price.toLocaleString()} so'm`);
    // Karta to'lovi (Payme/Click) tanlangan bo'lsa — checkout URL qaytaramiz.
    // Bank o'tkazma (yoki tanlanmagan) — faqat faktura; foydalanuvchi faktura
    // + shartnomani yuklab oladi va bank orqali to'laydi.
    const paymentUrl =
      provider === "PAYME" || provider === "CLICK"
        ? this.buildCheckoutUrl(provider, invoice.id, price)
        : undefined;
    return {
      invoice,
      paymentUrl,
      message: paymentUrl
        ? "To'lov sahifasiga yo'naltirilmoqda…"
        : "Faktura yaratildi. Bank o'tkazmasi orqali to'lang (faktura + shartnomani yuklab oling).",
    };
  }

  // Payme/Click checkout URL — env merchant sozlamalaridan quriladi. Prod'da
  // to'g'ri ishlaydi; merchant sozlanmagan demo'da placeholder bilan provider
  // sahifasiga yo'naltiradi (bank o'tkazma yo'li har doim ishlaydi).
  private buildCheckoutUrl(
    method: "PAYME" | "CLICK",
    invoiceId: string,
    amount: number,
  ): string {
    if (method === "PAYME") {
      const merchant = this.config.get<string>("PAYME_MERCHANT_ID") || "MERCHANT_ID";
      const amountTiyin = Math.round(amount * 100);
      const params = Buffer.from(
        `m=${merchant};ac.invoice_id=${invoiceId};a=${amountTiyin};l=uz`,
      ).toString("base64");
      return `https://checkout.paycom.uz/${params}`;
    }
    const serviceId = this.config.get<string>("CLICK_SERVICE_ID") || "SERVICE_ID";
    const merchantId = this.config.get<string>("CLICK_MERCHANT_ID") || "MERCHANT_ID";
    const base = this.config.get<string>("PUBLIC_BASE_URL") || "https://sifat.uz";
    return `https://my.click.uz/services/pay?service_id=${serviceId}&merchant_id=${merchantId}&amount=${amount}&transaction_param=${invoiceId}&return_url=${base}/dashboard/library/billing`;
  }

  /**
   * Plan 04-03 audit-fix FIX B — state-preserving endDate extension.
   *
   * Not a status transition (status stays the same) so the validator is not
   * invoked. The mutation + AiAuditLog row are wrapped in a single tx so the
   * audit trail never decouples from the date change. Used by free-plan
   * renewals and (in the future) by admin "extend without state change"
   * operations.
   */
  async extendEndDate(
    subscriptionId: string,
    newEndDate: Date,
    actorId: string,
    actorRole: TransitionActor,
  ) {
    const existing = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!existing) {
      throw new NotFoundException(`Subscription ${subscriptionId} topilmadi`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subscription.update({
        where: { id: subscriptionId },
        data: { endDate: newEndDate },
      });
      await tx.aiAuditLog.create({
        data: {
          scope: "subscription",
          scopeId: subscriptionId,
          issueType: "STATE_TRANSITION",
          severity: "MEDIUM",
          analysis: JSON.stringify({
            action: "endDate extended",
            oldEndDate: existing.endDate.toISOString(),
            newEndDate: newEndDate.toISOString(),
            actorRole,
            actorId,
          }),
          recommendation: "",
        },
      });
      return updated;
    });
  }

  /**
   * Plan 04-03 PAY-06 / PAY-08: state-machine-gated subscription transition.
   *
   * - Validates (from, to, actor, reason, planType) via assertSubscriptionTransition.
   * - Runs the Subscription.update + AiAuditLog.create in a single $transaction
   *   so the audit row never decouples from the state change.
   * - FROZEN / DELETED populate the audit columns added in Task 1.
   *
   * For SYSTEM callers (cron, webhook) actorId is informational (e.g. "system")
   * — they are restricted to TRIAL→PENDING, TRIAL→ACTIVE (free plans),
   * PENDING→ACTIVE.
   */
  async updateStatus(
    subscriptionId: string,
    status: SubscriptionStatus,
    reason: string | undefined,
    actorId: string,
    actorRole: TransitionActor,
  ) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub) {
      throw new NotFoundException(`Subscription ${subscriptionId} topilmadi`);
    }

    assertSubscriptionTransition(sub.status, status, actorRole, reason, sub.planType);

    const result = await this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.SubscriptionUpdateInput = { status };
      if (status === SubscriptionStatus.FROZEN) {
        updateData.frozenReason = reason ?? null;
        updateData.frozenAt = new Date();
        updateData.frozenBy = actorId;
      }
      if (status === SubscriptionStatus.DELETED) {
        updateData.deletedReason = reason ?? null;
        updateData.deletedAt = new Date();
        updateData.deletedBy = actorId;
      }

      const updated = await tx.subscription.update({
        where: { id: subscriptionId },
        data: updateData,
      });

      const isAdminFreezeOrDelete =
        status === SubscriptionStatus.FROZEN ||
        status === SubscriptionStatus.DELETED;

      await tx.aiAuditLog.create({
        data: {
          scope: "subscription",
          scopeId: subscriptionId,
          issueType: "STATE_TRANSITION",
          severity: isAdminFreezeOrDelete ? "HIGH" : "MEDIUM",
          analysis: JSON.stringify({
            from: sub.status,
            to: status,
            by: actorId,
            actorRole,
            reason: reason ?? null,
          }),
          recommendation: "",
        },
      });

      return updated;
    });

    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache on FROZEN/DELETED
    // since both change Subscription.status histograms in subscription:stats
    // and the cached invoice/payment aggregations. .catch swallows Redis blips
    // so the transaction (already committed above) never re-throws on a Redis
    // outage.
    if (
      status === SubscriptionStatus.FROZEN ||
      status === SubscriptionStatus.DELETED
    ) {
      await this.cache.delPattern("stats:buxgalter:*").catch(() => undefined);
      await this.cache.del("subscription:stats").catch(() => undefined);
    }

    return result;
  }

  // ── Statistika (Buxgalter uchun) ─────────────────────────────────────────

  async getStats() {
    return this.cache.remember("subscription:stats", 300, async () => {
      const [byStatus, byPlan] = await Promise.all([
        this.prisma.subscription.groupBy({
          by: ["status"],
          _count: { id: true },
        }),
        this.prisma.subscription.groupBy({
          by: ["planType"],
          _count: { id: true },
        }),
      ]);

      const revenue = await this.prisma.payment.aggregate({
        where: { status: "PAID" },
        _sum: { amount: true },
      });

      return {
        byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
        byPlan: byPlan.map((p) => ({ plan: p.planType, count: p._count.id })),
        totalRevenue: Number(revenue._sum.amount ?? 0),
      };
    });
  }

  // ── To'lov eslatmasi (kundalik cron) ─────────────────────────────────────

  /**
   * Plan 04-04 PAY-07 — payment reminder cron via NOTIFICATION_QUEUE.
   *
   * Pre-Plan-04-04 the loop body called this.sms.sendNotification directly,
   * which blocked the cron on the Eskiz HTTP roundtrip. A slow provider
   * stalled the entire 30/15/7/1-day sweep. Now we enqueue NotificationJobData
   * into NOTIFICATION_QUEUE (Plan 01-01 pattern); NotificationProcessor handles
   * delivery + Eskiz dev no-op + retries uniformly. Cron returns in <1s.
   *
   * Anti-injection (T-04-23): the message body is server-templated. Only
   * library.name flows from the DB into it, and library names pass admin
   * validation at registration (LibraryService.create). Do NOT interpolate
   * any user-controlled invoice metadata (description, payer name, etc.)
   * into this template — SMS-injection surface.
   */
  // Plan 04-04 audit-fix FIX E — explicit timeZone option. Pre-fix the
  // "10:00 Asia/Tashkent" was only documented in a comment; nest@10 reads
  // the cron expression in the server TZ (UTC in our K8s pods), so the job
  // actually fired at 15:00 Tashkent. timeZone option pins the schedule.
  //
  // Plan 04-04 audit-fix FIX F — Redis SETNX leader lock. Three replicas
  // would each fire the @Cron; tryAcquire wins only on the first replica
  // and the others log + return.
  @Cron("0 10 * * *", { timeZone: "Asia/Tashkent" })
  async sendPaymentReminders() {
    // Plan 04-04 audit-fix FIX F — single-leader gate.
    const today = new Date();
    const lockDayStr = today.toISOString().slice(0, 10);
    const lockKey = `cron:reminders:${lockDayStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, 2 * 60 * 60, lockDayStr);
    if (!lock.first) {
      this.logger.log(
        `sendPaymentReminders: leader lock not acquired (${lockKey}) — another replica is sweeping. Skipping.`,
      );
      return;
    }

    this.logger.log("To'lov eslatmalari yuborilmoqda...");
    const REMINDER_DAYS = [30, 15, 7, 1];

    for (const days of REMINDER_DAYS) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + days);
      const targetDateStr = targetDate.toISOString().slice(0, 10);
      // Plan 04-04 audit-fix FIX G — upper bound is the *next* day's
      // midnight (exclusive) instead of T23:59:59Z (which silently dropped
      // the last sub-second of the day's window).
      const nextDate = new Date(targetDate);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().slice(0, 10);

      const pendingInvoices = await this.prisma.invoice.findMany({
        where: {
          status: "PENDING",
          dueDate: {
            gte: new Date(`${targetDateStr}T00:00:00Z`),
            lt: new Date(`${nextDateStr}T00:00:00Z`),
          },
        },
        include: {
          subscription: {
            include: {
              library: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });

      for (const invoice of pendingInvoices) {
        const lib = invoice.subscription.library;
        if (!lib.phone) {
          this.logger.debug(`Eslatma o'tkazib yuborildi (telefon yo'q): ${lib.name}`);
          continue;
        }

        const message = this._buildReminderMessage(
          lib.name,
          Number(invoice.amount),
          invoice.id,
          invoice.dueDate,
          days,
        );

        try {
          await this.notifQueue.add(
            "payment-reminder",
            {
              type: "sms" as const,
              phone: lib.phone,
              message,
              userId: lib.id,
            },
            {
              // De-dupe defensively in case the cron double-fires within the
              // same minute (e.g., during a deploy bounce). One enqueue per
              // (invoice, day-window) pair.
              jobId: `payment-reminder:${invoice.id}:${days}d`,
              removeOnComplete: { count: 200 },
            },
          );
          this.logger.log(`Eslatma queue ga qo'shildi: ${lib.name}, ${days} kun qoldi`);
        } catch (err) {
          // BullMQ enqueue must never break the cron sweep — log + continue.
          this.logger.warn(
            `Reminder enqueue xato (${invoice.id}, ${days}d): ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Plan 04-04 audit-fix FIX B (SEC HIGH) — SMS template-injection defence.
   *
   * library.name is the only DB-sourced field that flows into the SMS body.
   * Adversarial review found three injection vectors:
   *
   *   1. CR / LF characters — an attacker could inject a "second SMS" or a
   *      newline-terminated header that some gateways interpret as a control
   *      sequence ("X\nFREE MONEY https://evil/").
   *   2. Library name >> recipient bandwidth — UCS-2 SMS limit is 70 chars
   *      per segment, GSM-7 is 160. A 500-char library name fragments into 7
   *      segments and pushes attacker content into the trusted-suffix slot.
   *   3. Single quotes — the message wraps libraryName in quotes; an
   *      attacker could close the quote and append a fake instruction:
   *      "Lib' please send 1m UZS to ..." reads as a sentence to humans.
   *
   * Sanitization: strip CR/LF (replace with space), strip single quotes
   * entirely, truncate to 60 chars with ellipsis. Library names that pass
   * the LibrariesService.create regex (FIX C — alphanumeric + space + hyphen
   * + ampersand) cannot contain quotes / newlines anyway, but defence in
   * depth matters here because legacy rows from before that DTO landed
   * still exist in the DB.
   */
  static _sanitizeForSms(raw: string): string {
    if (!raw) return "";
    // Strip CR/LF (defence against multi-line / gateway-control injection).
    let s = raw.replace(/[\r\n]/g, " ");
    // Remove single quotes entirely (we wrap the field in quotes below, so
    // the apostrophe is the breakout char). Don't replace with apostrophe-
    // safe equivalent — just drop. Legitimate uz library names don't use
    // apostrophes.
    s = s.replace(/'/g, "");
    // Truncate with ellipsis to keep SMS bandwidth predictable.
    const MAX = 60;
    if (s.length > MAX) {
      s = s.slice(0, MAX - 1) + "…";
    }
    return s;
  }

  /**
   * Plan 04-04 PAY-07 — templated reminder body. Pure function, no side
   * effects, deterministic for unit tests. library.name is the only DB-
   * sourced field interpolated; everything else is computed from numeric
   * or trusted server-side data. Never accept user-supplied description
   * here — see anti-injection comment on sendPaymentReminders.
   *
   * Plan 04-04 audit-fix FIX B — libraryName routes through _sanitizeForSms
   * before interpolation. Strips CR/LF, drops single quotes, truncates to
   * 60 chars. Output is guaranteed to be a single SMS line.
   */
  private _buildReminderMessage(
    libraryName: string,
    amountUzs: number,
    invoiceId: string,
    dueDate: Date,
    daysUntilDue: number,
  ): string {
    const safeName = SubscriptionService._sanitizeForSms(libraryName);
    const amountFmt = amountUzs.toLocaleString("uz-UZ");
    const dueIso = dueDate.toISOString().slice(0, 10);
    if (daysUntilDue === 1) {
      return `SIFAT Library: ${safeName} uchun ${amountFmt} so'm to'lov ${dueIso} sanasiga qadar (1 kun) to'lanishi kerak. Hozir to'lash: sifat.uz/pay/${invoiceId}`;
    }
    return `SIFAT Library: ${safeName} uchun ${amountFmt} so'm to'lov ${dueIso} sanasiga qadar (${daysUntilDue} kun) to'lanishi kerak. Hozir to'lash: sifat.uz/pay/${invoiceId}`;
  }

  // ── Trial tugash eslatmasi ───────────────────────────────────────────────

  // Plan 04-04 audit-fix FIX E — explicit Asia/Tashkent timezone.
  // Plan 04-04 audit-fix FIX F — Redis SETNX leader lock.
  @Cron("0 9 * * *", { timeZone: "Asia/Tashkent" })
  async trialExpiryReminders() {
    const today = new Date();
    // Plan 04-04 audit-fix FIX F — single-leader gate.
    const lockDayStr = today.toISOString().slice(0, 10);
    const lockKey = `cron:trial-expiry:${lockDayStr}`;
    const lock = await this.redisLock.tryAcquire(lockKey, 2 * 60 * 60, lockDayStr);
    if (!lock.first) {
      this.logger.log(
        `trialExpiryReminders: leader lock not acquired (${lockKey}) — another replica is sweeping. Skipping.`,
      );
      return;
    }

    const in3Days = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const in10Days = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);
    // Plan 04-04 audit-fix FIX G — upper bound is the next-day midnight
    // (exclusive). Old T23:59:59Z silently dropped the last sub-second
    // of the day. The half-open [start, in11Days T00:00:00Z) window is
    // still inclusive of "10 days from now" because in10Days < in11Days.
    const in11Days = new Date(today.getTime() + 11 * 24 * 60 * 60 * 1000);

    const subs = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.TRIAL,
        trialEnd: {
          gte: new Date(in3Days.toISOString().slice(0, 10) + "T00:00:00Z"),
          lt: new Date(in11Days.toISOString().slice(0, 10) + "T00:00:00Z"),
        },
      },
      include: {
        library: { select: { name: true, phone: true } },
      },
    });
    void in10Days; // window kept inclusive of "10 days from now" via in11Days exclusive bound

    for (const sub of subs) {
      const daysLeft = Math.ceil((sub.trialEnd!.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      // Plan 04-04 audit-fix FIX B — sanitize libraryName before splicing
      // into the SMS body. Strips CR/LF, drops quotes, truncates to 60 chars.
      const safeName = SubscriptionService._sanitizeForSms(sub.library.name);
      const msg = `SIFAT LIBRARY: ${safeName} sinov muddatiga ${daysLeft} kun qoldi. Davom etish uchun: sifat.uz/subscription`;
      if (sub.library.phone) {
        await this.sms.sendNotification(sub.library.phone, msg).catch(() => {});
      }
    }

    // Trial tugagan va PENDING ga o'tmagan larni yangilash. Plan 04-03 PAY-06:
    // route via updateStatus so the state-machine validator + AiAuditLog row
    // catch this transition too. SYSTEM actor is whitelisted for these moves;
    // FROZEN/DELETED stay unreachable from here.
    const expired = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.TRIAL,
        trialEnd: { lt: today },
      },
    });

    for (const sub of expired) {
      const price = PLAN_PRICES[sub.planType] ?? 0;

      if (price === 0) {
        // Bepul (GOV/MAH) — TRIAL → ACTIVE via SYSTEM
        await this.updateStatus(sub.id, SubscriptionStatus.ACTIVE, undefined, "system", "SYSTEM");
      } else {
        // To'lovli — TRIAL → PENDING via SYSTEM, then create invoice
        await this.updateStatus(sub.id, SubscriptionStatus.PENDING, undefined, "system", "SYSTEM");
        await this.invoiceService.createInvoice(sub.id, price, 15);
        this.logger.log(`Trial tugadi, faktura yaratildi: ${sub.id}`);
      }
    }
  }
}
