import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import * as crypto from "crypto";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { PaymentMethod, PaymentStatus, SubscriptionStatus } from "@prisma/client";
import { ClickPrepareDto, ClickCompleteDto } from "./dto/click-webhook.dto";
import { assertSubscriptionTransition } from "./subscription.service";
import { BUXGALTER_CACHE_PATTERN } from "./invoice.service";

// Plan 04-02 PAY-02 — 24h idempotency TTL matches Click's retransmit window.
const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 86400;

/**
 * Plan 04-02 audit-fix FIX C1 — deterministic Click error codes that are
 * safe to cache for 24h. -1 (bad signature/service_id/sign_time) is
 * deterministic per-payload. 0 (success) is always cached. -2 (bad amount),
 * -4 (already paid), -5 (invoice not found), -6 (transaction not found) are
 * also deterministic per the current Invoice/Payment state. Anything else
 * (DB blip, unexpected) is treated as transient and NOT cached.
 */
const CLICK_DETERMINISTIC_ERROR_CODES = new Set([0, -1, -2, -4, -5, -6]);

/**
 * Click (click.uz) To'lov tizimi integratsiyasi
 * Hujjat: https://docs.click.uz
 */
@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);
  private readonly merchantId: string;
  private readonly secretKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache after webhook
    // commits a payment. Symmetric to PaymeService.
    private readonly cache: CacheService,
  ) {
    this.merchantId = this.config.get("CLICK_MERCHANT_ID", "");
    this.secretKey  = this.config.get("CLICK_SECRET_KEY", "");
  }

  // ── Prepare (boshlang'ich tasdiqlash) ────────────────────────────────────

  /**
   * Plan 04-02 audit-fix FIX D5 — Click 12h timeout symmetry decision.
   *
   * Per docs.click.uz, Click's own server-side state machine handles
   * transaction expiry: when a user abandons checkout, Click sends a
   * Complete callback with `error != 0` (typically -1 or -8). We do NOT
   * enqueue a parallel 12h cancel timer (as we do for Payme PAY-04)
   * because:
   *   1) Click's outgoing Complete on user/timeout cancellation makes the
   *      PENDING → FAILED transition observable via the existing webhook
   *      path — no missing-event risk like Payme's silent expiry.
   *   2) Adding a second timer would require deduplicating it against
   *      Click's own cancel callback, complicating the state machine.
   *
   * If late-PENDING accumulation becomes a real production issue (e.g.,
   * Click misses Complete on a user disappear), Plan 04-03's subscription
   * state machine refactor revisits this. Operationally, monitor the
   * count of PENDING Click payments older than 24h via a metrics query.
   */
  async prepare(body: ClickPrepareDto): Promise<ClickResponse> {
    const { click_trans_id, action } = body;

    // Plan 04-02 PAY-02 — idempotency gate keyed by click_trans_id + action.
    // action differentiates prepare (0) vs complete (1) so a Prepare replay
    // doesn't satisfy a Complete duplicate (and vice versa).
    const idempotencyKey = `webhook:click:${click_trans_id}:${action}`;
    const traceId = randomUUID();
    const acquire = await this.lockService.tryAcquire(
      idempotencyKey,
      WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      traceId,
    );
    if (!acquire.first) {
      if (acquire.cachedResponse !== undefined) {
        this.logger.log(`Click prepare idempotent replay: ${idempotencyKey}`);
        return acquire.cachedResponse as ClickResponse;
      }
      // Plan 04-02 audit-fix FIX C2 — in-flight race. The lock is held but
      // the first caller hasn't yet stored its response. Return a transient
      // error so Click retries with backoff instead of receiving a stale ack.
      this.logger.warn(
        `Click prepare in-flight (no cached response yet) for ${idempotencyKey} — asking caller to retry.`,
      );
      return { error: -9, error_note: "Service temporarily unavailable" };
    }

    let response: ClickResponse;
    try {
      response = await this._prepareInternal(body);
    } catch (err: any) {
      this.logger.error(`Click prepare xato: ${err.message}`);
      response = { error: -8, error_note: err.message ?? "Internal error" };
    }

    // Plan 04-02 audit-fix FIX C1 — only cache deterministic responses.
    if (CLICK_DETERMINISTIC_ERROR_CODES.has(response.error)) {
      await this.lockService.storeResponse(
        idempotencyKey,
        response,
        WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      );
    } else {
      await this.lockService.release(idempotencyKey);
      this.logger.warn(
        `Click prepare transient error ${response.error} for ${idempotencyKey} — not cached, lock released.`,
      );
    }
    return response;
  }

  private async _prepareInternal(body: ClickPrepareDto): Promise<ClickResponse> {
    const { click_trans_id, service_id, merchant_trans_id, amount, sign_time, sign_string, action } = body;

    // Plan 04-01 audit-fix FIX 1 — cross-action signature replay protection.
    // prepare() MUST only accept action="0". If an attacker captures a Complete
    // body and replays it against prepare(), the action mismatch alone rejects.
    // Generic -1 to not leak which check failed.
    if (String(action) !== "0") {
      this.logger.warn(
        `[SECURITY] Click prepare() called with action=${JSON.stringify(action)} — expected "0". Possible cross-action replay.`,
      );
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // Plan 04-01 audit-fix FIX 6 — sign_time 5-minute skew validation.
    if (!this._isSignTimeFresh(sign_time)) {
      this.logger.warn(
        `[SECURITY] Click prepare() sign_time stale or invalid: ${sign_time}`,
      );
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // service_id tekshiruvi — Plan 04-01 PAY-02 (R8). When CLICK_SERVICE_ID env is
    // configured and the body service_id mismatches, reject before computing the
    // hash so attackers can't probe for valid service_id values.
    const expectedServiceId = this.config.get<string>("CLICK_SERVICE_ID", "");
    if (expectedServiceId && service_id !== expectedServiceId) {
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // Imzo tekshiruvi — Plan 04-01 PAY-02: official Click formula includes service_id.
    // https://docs.click.uz/en/click-api-request/
    const signCheck = this._makeSign(
      click_trans_id,
      service_id,
      this.secretKey,
      merchant_trans_id,
      amount,
      action,
      sign_time,
    );
    // Plan 04-01 audit-fix FIX 5 — constant-time compare to remove the timing
    // side channel that a non-Click attacker could use to probe sign bytes.
    if (!this._safeHexEqual(signCheck, sign_string)) {
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // Invoice topish
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: merchant_trans_id },
    });
    if (!invoice) return { error: -5, error_note: "Invoice topilmadi" };
    if (invoice.status === "PAID") return { error: -4, error_note: "Allaqachon to'langan" };

    // Summa tekshiruvi (so'mga)
    const expectedAmount = Number(invoice.amount);
    if (Math.abs(parseFloat(amount) - expectedAmount) > 1) {
      return { error: -2, error_note: "Noto'g'ri summa" };
    }

    // Kutilmoqda payment yaratish
    const existing = await this.prisma.payment.findFirst({
      where: { transactionId: click_trans_id },
    });
    if (!existing) {
      await this.prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: invoice.amount,
          method: PaymentMethod.CLICK,
          status: PaymentStatus.PENDING,
          transactionId: click_trans_id,
        },
      });
    }

    return {
      click_trans_id,
      merchant_trans_id,
      merchant_prepare_id: invoice.id,
      error: 0,
      error_note: "Success",
    };
  }

  // ── Complete (yakunlash) ───────────────────────────────────────────────────

  async complete(body: ClickCompleteDto): Promise<ClickResponse> {
    const { click_trans_id, action } = body;

    // Plan 04-02 PAY-02 — idempotency gate. Same key shape as prepare(); the
    // action="1" component distinguishes from the prepare cache entry.
    const idempotencyKey = `webhook:click:${click_trans_id}:${action}`;
    const traceId = randomUUID();
    const acquire = await this.lockService.tryAcquire(
      idempotencyKey,
      WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      traceId,
    );
    if (!acquire.first) {
      if (acquire.cachedResponse !== undefined) {
        this.logger.log(`Click complete idempotent replay: ${idempotencyKey}`);
        return acquire.cachedResponse as ClickResponse;
      }
      // Plan 04-02 audit-fix FIX C2 — in-flight race.
      this.logger.warn(
        `Click complete in-flight (no cached response yet) for ${idempotencyKey} — asking caller to retry.`,
      );
      return { error: -9, error_note: "Service temporarily unavailable" };
    }

    let response: ClickResponse;
    try {
      response = await this._completeInternal(body);
    } catch (err: any) {
      this.logger.error(`Click complete xato: ${err.message}`);
      response = { error: -8, error_note: err.message ?? "Internal error" };
    }

    // Plan 04-02 audit-fix FIX C1 — only cache deterministic responses.
    if (CLICK_DETERMINISTIC_ERROR_CODES.has(response.error)) {
      await this.lockService.storeResponse(
        idempotencyKey,
        response,
        WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      );
    } else {
      await this.lockService.release(idempotencyKey);
      this.logger.warn(
        `Click complete transient error ${response.error} for ${idempotencyKey} — not cached, lock released.`,
      );
    }
    return response;
  }

  private async _completeInternal(body: ClickCompleteDto): Promise<ClickResponse> {
    const {
      click_trans_id,
      service_id,
      merchant_trans_id,
      merchant_prepare_id,
      amount,
      sign_time,
      sign_string,
      action,
      error,
    } = body;

    // Plan 04-01 audit-fix FIX 1 — cross-action signature replay protection.
    // complete() MUST require action="1" AND a non-empty merchant_prepare_id.
    // Without these checks, an attacker can POST a captured Prepare body
    // (action="0", no merchant_prepare_id, original Prepare sign) and the
    // _makeSign falls through to Prepare-format concatenation, the signature
    // verifies, and the subscription is flipped to ACTIVE without payment.
    // Generic -1 to not leak which check failed.
    if (String(action) !== "1") {
      this.logger.warn(
        `[SECURITY] Click complete() called with action=${JSON.stringify(action)} — expected "1". Possible cross-action replay.`,
      );
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }
    if (!merchant_prepare_id) {
      this.logger.warn(
        `[SECURITY] Click complete() called without merchant_prepare_id — possible cross-action replay (click_trans_id=${click_trans_id}).`,
      );
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // Plan 04-01 audit-fix FIX 6 — sign_time 5-minute skew validation.
    if (!this._isSignTimeFresh(sign_time)) {
      this.logger.warn(
        `[SECURITY] Click complete() sign_time stale or invalid: ${sign_time}`,
      );
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // service_id tekshiruvi — Plan 04-01 PAY-02 (R8).
    const expectedServiceId = this.config.get<string>("CLICK_SERVICE_ID", "");
    if (expectedServiceId && service_id !== expectedServiceId) {
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    // Imzo tekshiruvi — Plan 04-01 PAY-02: official Click formula includes service_id.
    const signCheck = this._makeSign(
      click_trans_id,
      service_id,
      this.secretKey,
      merchant_trans_id,
      amount,
      action,
      sign_time,
      merchant_prepare_id,
    );
    // Plan 04-01 audit-fix FIX 5 — constant-time compare.
    if (!this._safeHexEqual(signCheck, sign_string)) {
      return { error: -1, error_note: "Noto'g'ri imzo" };
    }

    const payment = await this.prisma.payment.findFirst({
      where: { transactionId: click_trans_id },
      include: { invoice: { include: { subscription: true } } },
    });
    if (!payment) return { error: -6, error_note: "Tranzaksiya topilmadi" };

    // Plan 04-02 audit-fix FIX B1 — state-machine guard: already-PAID short-
    // circuit. A Click retransmit after a successful Complete must NOT re-run
    // the $transaction (would re-issue Invoice/Subscription writes + duplicate
    // audit log row). The idempotency cache catches the same-payload case but
    // a delayed retransmit after TTL expiry, or a webhook retried with a
    // micro-diff that defeats the cache key, must still be safe here.
    if (payment.status === PaymentStatus.PAID) {
      this.logger.log(
        `Click complete() idempotent short-circuit — payment ${payment.id} already PAID.`,
      );
      return {
        click_trans_id,
        merchant_trans_id,
        merchant_confirm_id: payment.id,
        error: 0,
        error_note: "Success",
      };
    }

    // Foydalanuvchi tomonidan bekor qilingan
    // Plan 04-02 PAY-03 — atomic Payment.update + AiAuditLog inside $transaction.
    if (error < 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FAILED },
        });
        await tx.aiAuditLog.create({
          data: {
            scope: "payment",
            scopeId: payment.id,
            issueType: "STATE_TRANSITION",
            severity: "MEDIUM",
            analysis: JSON.stringify({
              from: payment.status,
              to: "FAILED",
              provider: "CLICK",
              transactionId: click_trans_id,
              by: "WEBHOOK",
              reason: "user_cancelled",
            }),
            recommendation: "",
          },
        });
      });
      return { error: 0, error_note: "Cancelled" };
    }

    const now = new Date();

    // Plan 04-02 PAY-03 — Payment + Invoice + Subscription + AiAuditLog all
    // commit-or-rollback together. Pre-04-02 the three updates were sequential
    // awaits OUTSIDE any transaction; a crash between them left the system in
    // a partial-commit state (e.g., Invoice PAID but Subscription not ACTIVE).
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PAID, paidAt: now },
      });

      await tx.invoice.update({
        where: { id: payment.invoiceId },
        data: {
          status: PaymentStatus.PAID,
          paidDate: now,
          paymentMethod: PaymentMethod.CLICK,
        },
      });

      // Plan 04-03 PAY-06: validate Subscription transition via SYSTEM
      // whitelist (PENDING→ACTIVE is the standard click webhook path).
      const sub = await tx.subscription.findUnique({
        where: { id: payment.invoice.subscriptionId },
      });
      if (sub) {
        assertSubscriptionTransition(
          sub.status,
          SubscriptionStatus.ACTIVE,
          "SYSTEM",
          undefined,
          sub.planType,
        );
        await tx.subscription.update({
          where: { id: payment.invoice.subscriptionId },
          data: { status: SubscriptionStatus.ACTIVE },
        });
      }

      await tx.aiAuditLog.create({
        data: {
          scope: "payment",
          scopeId: payment.id,
          issueType: "STATE_TRANSITION",
          severity: "MEDIUM",
          analysis: JSON.stringify({
            from: "PENDING",
            to: "PAID",
            provider: "CLICK",
            transactionId: click_trans_id,
            by: "WEBHOOK",
          }),
          recommendation: "",
        },
      });
    });

    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache after a successful
    // Click commit so the dashboard reflects within seconds (not 5min).
    // Symmetric to PaymeService._performTransaction. .catch swallows Redis
    // blips so a cache outage never fails a payment commit.
    await this.cache.delPattern(BUXGALTER_CACHE_PATTERN).catch(() => undefined);

    this.logger.log(`Click to'lov tasdiqlandi: ${payment.id}`);

    return {
      click_trans_id,
      merchant_trans_id,
      merchant_confirm_id: payment.id,
      error: 0,
      error_note: "Success",
    };
  }

  // ── Imzo hisoblash ────────────────────────────────────────────────────────

  /**
   * Click HMAC signature — Plan 04-01 PAY-02 (D-CLICK-SIG).
   *
   * Official Click formula per https://docs.click.uz/en/click-api-request/:
   *   Prepare:  md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)
   *   Complete: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
   *
   * Pre-Plan-04-01 code OMITTED service_id and placed action before secretKey —
   * every real Click callback was rejected with -1. Fixed RED-first.
   */
  private _makeSign(
    clickTransId: string,
    serviceId: string,
    secretKey: string,
    merchantTransId: string,
    amount: string,
    action: string | number,
    signTime: string,
    merchantPrepareId?: string,
  ): string {
    const raw = merchantPrepareId
      ? `${clickTransId}${serviceId}${secretKey}${merchantTransId}${merchantPrepareId}${amount}${action}${signTime}`
      : `${clickTransId}${serviceId}${secretKey}${merchantTransId}${amount}${action}${signTime}`;
    return crypto.createHash("md5").update(raw).digest("hex");
  }

  /**
   * Plan 04-01 audit-fix FIX 5 — constant-time hex compare.
   * Both args are md5 hex strings of equal length in the normal case;
   * timingSafeEqual throws on length mismatch, so we length-check first and
   * treat any throw as inequality (length itself isn't sensitive — both sides
   * are server-controlled md5 hex).
   */
  private _safeHexEqual(a: string, b: string): boolean {
    try {
      const aBuf = Buffer.from(a, "hex");
      const bBuf = Buffer.from(b, "hex");
      if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    } catch {
      return false;
    }
  }

  /**
   * Plan 04-01 audit-fix FIX 6 — sign_time 5-minute skew validation.
   *
   * Plan 04-02 audit-fix FIX D1 — TIMEZONE CORRECTION.
   * Per docs.click.uz, Click sends sign_time as "YYYY-MM-DD HH:MM:SS" in
   * Asia/Tashkent local time (UTC+5), NOT UTC. The pre-04-02 implementation
   * appended "Z" and parsed as UTC, which placed every legitimate Click
   * webhook 5 hours in the past — outside the 5-minute skew window — so
   * every real Complete callback was rejected with -1 once the FIX 6 skew
   * gate landed. Now we treat the wall-clock string as Asia/Tashkent local
   * time and append +05:00 to anchor it to that zone.
   *
   * Without this skew check, an attacker who captured a legitimate webhook
   * could replay it indefinitely (the merchant_prepare_id check stops
   * re-marking the same payment, but a captured Prepare body could still
   * pre-create payments for invoices the attacker later targets, etc.).
   * 5 minutes balances clock skew tolerance with replay window minimization.
   * Returns false on unparseable input.
   */
  private _isSignTimeFresh(signTime: string): boolean {
    if (!signTime || typeof signTime !== "string") return false;
    // Click format: "YYYY-MM-DD HH:MM:SS" wall-clock in Asia/Tashkent (UTC+5).
    // Append the explicit +05:00 offset so Date.parse anchors it correctly.
    // If the caller already passed an ISO 8601 string (e.g., tests or future
    // upstream API change), use it verbatim.
    const iso = signTime.includes("T")
      ? signTime
      : signTime.replace(" ", "T") + "+05:00";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return false;
    const SKEW_MS = 5 * 60 * 1000; // 5 minutes
    return Math.abs(Date.now() - ts) <= SKEW_MS;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClickPrepareBody {
  click_trans_id: string;
  service_id: string;
  click_paydoc_id?: string;
  merchant_trans_id: string;
  amount: string;
  action: string | number;
  error: number;
  error_note?: string;
  sign_time: string;
  sign_string: string;
}

export interface ClickCompleteBody extends ClickPrepareBody {
  merchant_prepare_id: string;
}

export interface ClickResponse {
  click_trans_id?: string;
  merchant_trans_id?: string;
  merchant_prepare_id?: string;
  merchant_confirm_id?: string;
  error: number;
  error_note: string;
}
