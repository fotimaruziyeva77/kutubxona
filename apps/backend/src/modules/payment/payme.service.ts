import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { CacheService } from "../../infra/cache/cache.service";
import { RedisLockService } from "../../infra/cache/redis-lock.service";
import { PAYMENT_TIMEOUT_QUEUE } from "../../infra/queue/queue-names";
import { buildJobId } from "../../infra/queue/job-id.util";
import { PaymentMethod, PaymentStatus, SubscriptionStatus } from "@prisma/client";
import { PaymeRpcRequestDto } from "./dto/payme-webhook.dto";
import { assertSubscriptionTransition } from "./subscription.service";
import { BUXGALTER_CACHE_PATTERN } from "./invoice.service";
import { isProductionEnv } from "../../common/utils/production-env.util";
import { verifyPaymeBasicAuth } from "./payme-auth.util";

// Plan 04-02 PAY-01 — webhook idempotency TTL (24h covers Payme's 12h
// transaction lifetime plus retransmit buffer).
const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 86400;
// Plan 04-02 PAY-04 — 12h delay before auto-cancellation per Payme docs.
const PAYMENT_TIMEOUT_DELAY_MS = 12 * 60 * 60 * 1000;

/**
 * Payme (payme.uz) Merchant API integratsiyasi
 * Hujjat: https://developer.payme.uz/documentation
 */
@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);
  private readonly merchantId: string;
  private readonly secretKey: string;
  private readonly testKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
    @InjectQueue(PAYMENT_TIMEOUT_QUEUE) private readonly paymentTimeoutQueue: Queue,
    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache after webhook
    // commits a payment so the dashboard reflects within seconds (not 5min).
    private readonly cache: CacheService,
  ) {
    this.merchantId = this.config.get("PAYME_MERCHANT_ID", "");
    this.secretKey  = this.config.get("PAYME_SECRET_KEY", "");
    // Plan 04-01 audit-fix FIX 7 — PAYME_TEST_KEY is optional in production
    // (sandbox "Paycom" login key). Empty disables the sandbox-auth allowlist
    // branch — the FIX 3 empty-key reject in _verifyAuth ensures unset can't
    // be exploited to bypass auth.
    this.testKey    = this.config.get("PAYME_TEST_KEY", "");
  }

  // ── Webhook handler (JSON-RPC 2.0) ───────────────────────────────────────

  async handleWebhook(authHeader: string, body: PaymeRpcRequestDto): Promise<PaymeRpcResponse> {
    // 1. Auth tekshiruvi
    this._verifyAuth(authHeader);

    const { method, params, id } = body;

    // Plan 04-02 audit-fix FIX C3 — GetStatement is a read-only reconciliation
    // query (Payme polls it for partner accounting). Caching the response for
    // 24h is WRONG: a poll an hour later asking for a different {from, to}
    // window would replay stale data. Skip the lock + cache entirely.
    if (method === "GetStatement") {
      try {
        return await this._getStatement(id, params);
      } catch (err: any) {
        this.logger.error(`Payme webhook xato: ${err.message}`);
        return this._error(id, -31001, err.message);
      }
    }

    // Plan 04-02 PAY-01 — idempotency gate. Key by params.id (Payme transaction
    // id) + method so each method+transaction pair is deduped independently.
    // CheckPerformTransaction has no params.id; key on invoiceId for that case.
    const txKey =
      (params as { id?: string })?.id ??
      ((params as { account?: { invoiceId?: string } })?.account?.invoiceId ?? "no-id");
    const idempotencyKey = `webhook:payme:${txKey}:${method}`;
    const traceId = randomUUID();
    const acquire = await this.lockService.tryAcquire(
      idempotencyKey,
      WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      traceId,
    );
    if (!acquire.first) {
      if (acquire.cachedResponse !== undefined) {
        this.logger.log(`Payme webhook idempotent replay: ${idempotencyKey}`);
        return acquire.cachedResponse as PaymeRpcResponse;
      }
      // Plan 04-02 audit-fix FIX C2 — in-flight race. The lock is held but
      // the first caller hasn't yet stored its response. Returning a generic
      // success here would be unsafe — Payme would consider the txn settled
      // and move on. Instead surface -31008 so Payme retries with backoff.
      this.logger.warn(
        `Payme webhook in-flight (no cached response yet) for ${idempotencyKey} — asking caller to retry.`,
      );
      return this._error(id, -31008, "Service temporarily unavailable");
    }

    let response: PaymeRpcResponse;
    try {
      switch (method) {
        case "CheckPerformTransaction":
          response = await this._checkPerformTransaction(id, params);
          break;
        case "CreateTransaction":
          response = await this._createTransaction(id, params);
          break;
        case "PerformTransaction":
          response = await this._performTransaction(id, params);
          break;
        case "CancelTransaction":
          response = await this._cancelTransaction(id, params);
          break;
        case "CheckTransaction":
          response = await this._checkTransaction(id, params);
          break;
        default:
          response = this._error(id, -32601, "Method not found");
      }
    } catch (err: any) {
      this.logger.error(`Payme webhook xato: ${err.message}`);
      response = this._error(id, -31001, err.message);
    }

    // Plan 04-02 audit-fix FIX C1 — only cache responses that are
    // DETERMINISTIC for this {method, params} pair. Caching a transient
    // infrastructure error (-31001, e.g., DB connection blip) for 24h means
    // every retry within the window returns the stale failure even after the
    // outage clears. Whitelist:
    //   - success (no error field)
    //   - -31050 account/invoice-not-found, -31051 invoice-already-paid
    //     (P2 M9 — rasmiy hisob-xato diapazoni -31050..-31099), -32600 invalid
    //     params, -32601 method-not-found (deterministic rejections — input
    //     shape, not infra)
    //   - -31008 terminal-state guard from FIX B2 (deterministic per-payment)
    //   - -31003 transaction-not-found (deterministic per params.id)
    // Skip caching for -31001 so the next retry hits the real handler.
    // (-31001 is ALSO the catch-all for transient infra errors below, so the
    // amount-mismatch -31001 is deliberately left uncached too — recomputing
    // it on retry is cheap and an operator-corrected invoice heals the flow.)
    const DETERMINISTIC_ERROR_CODES = new Set([
      -31050, -31051, -32600, -32601, -31008, -31003,
    ]);
    const isCacheable =
      !response.error ||
      DETERMINISTIC_ERROR_CODES.has(response.error.code);
    if (isCacheable) {
      await this.lockService.storeResponse(
        idempotencyKey,
        response,
        WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
      );
    } else {
      // Release the lock so the next retry re-runs the handler. Without this,
      // the lock TTL (24h) would block every retry as in-flight.
      await this.lockService.release(idempotencyKey);
      this.logger.warn(
        `Payme webhook transient error ${response.error?.code} for ${idempotencyKey} — not cached, lock released.`,
      );
    }
    return response;
  }

  // ── CheckPerformTransaction ───────────────────────────────────────────────
  // Plan 04-02 audit-fix FIX D4 — inline defensive checks that mirror the
  // CheckPerformTransactionParamsDto shape in dto/payme-webhook.dto.ts.
  // Cheap, explicit, easy to audit alongside the rest of the handler.
  //
  // P2 M9 — rasmiy xato kodlari (developer.help.paycom.uz → Oshibki/ERRORS):
  //   -31050..-31099 — hisob (account) xatolari: invoiceId yo'q/topilmadi/
  //                    allaqachon to'langan. `data` maydoni muammoli account
  //                    pastki-maydon nomini ko'rsatadi.
  //   -31001         — noto'g'ri summa (CheckPerformTransaction/CreateTransaction).
  //   -32600         — FAQAT buzilgan JSON-RPC (majburiy maydon yo'q yoki tip
  //                    spetsifikatsiyaga mos emas) — hisob muammolari uchun EMAS.
  private async _checkPerformTransaction(id: any, params: any): Promise<PaymeRpcResponse> {
    const invoiceId = params?.account?.invoiceId;
    if (typeof invoiceId !== "string" || invoiceId.length === 0) {
      // P2 M9 — hisob maydoni yo'q/bo'sh = account xatosi (-31050 diapazoni),
      // -32600 emas: RPC konvert butun, muammo account ichida.
      return this._error(id, -31050, "Hisob ma'lumoti (invoiceId) ko'rsatilmagan", "invoiceId");
    }
    if (!Number.isFinite(params?.amount)) {
      return this._error(id, -32600, "Noto'g'ri params.amount");
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      return this._error(id, -31050, "Invoice topilmadi", "invoiceId");
    }
    if (invoice.status === "PAID") {
      // P2 M9 — alohida kod (-31051, rasmiy -31050..-31099 diapazonida) —
      // "topilmadi" va "allaqachon to'langan" holatlarini ajratish
      // sertifikatsiya sandbox'ida talab qilinadi.
      return this._error(id, -31051, "Invoice allaqachon to'langan", "invoiceId");
    }

    // Summa tekshiruvi (tiyin dan so'mga: Payme tiyin yuboradi)
    const expectedTiyin = Number(invoice.amount) * 100;
    if (Math.abs(params.amount - expectedTiyin) > 1) {
      return this._error(id, -31001, "Noto'g'ri summa");
    }

    return {
      jsonrpc: "2.0",
      id,
      result: { allow: true },
    };
  }

  // ── CreateTransaction ─────────────────────────────────────────────────────
  // Plan 04-02 audit-fix FIX D4 — inline defensive checks.
  // P2 M9 — hisob xatolari -31050..-31099 diapazoniga ko'chirildi va summa
  // tekshiruvi qo'shildi: rasmiy spec bo'yicha CreateTransaction ham
  // CheckPerformTransaction bilan bir xil validatsiyani bajarishi shart
  // (-31001 noto'g'ri summa, -31050/-31051 hisob muammosi).
  private async _createTransaction(id: any, params: any): Promise<PaymeRpcResponse> {
    if (typeof params?.id !== "string" || params.id.length === 0) {
      return this._error(id, -32600, "Noto'g'ri params.id");
    }
    if (!Number.isFinite(params?.amount)) {
      return this._error(id, -32600, "Noto'g'ri params.amount");
    }
    const invoiceId = params?.account?.invoiceId;
    if (typeof invoiceId !== "string" || invoiceId.length === 0) {
      return this._error(id, -31050, "Hisob ma'lumoti (invoiceId) ko'rsatilmagan", "invoiceId");
    }

    const existing = await this.prisma.payment.findFirst({
      where: { transactionId: params.id },
    });
    if (existing) {
      // P2 M9 — takroriy CreateTransaction faqat tranzaksiya hali state=1
      // (PENDING) bo'lsa idempotent echo qiladi. Bekor qilingan yoki
      // bajarilgan tranzaksiya uchun rasmiy javob -31008 ("operatsiyani
      // bajarib bo'lmaydi — holat noto'g'ri").
      if (existing.status !== PaymentStatus.PENDING) {
        return this._error(id, -31008, "Tranzaksiya holati yangi yaratishga ruxsat bermaydi");
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          create_time: existing.createdAt.getTime(),
          transaction: existing.id,
          state: 1,
        },
      };
    }

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) return this._error(id, -31050, "Invoice topilmadi", "invoiceId");
    if (invoice.status === "PAID") {
      return this._error(id, -31051, "Invoice allaqachon to'langan", "invoiceId");
    }

    // P2 M9 — summa invoice bilan mos kelishi shart (tiyin). CheckPerform
    // o'tgan bo'lsa ham Create alohida chaqiriq — qayta tekshiramiz.
    const expectedTiyin = Number(invoice.amount) * 100;
    if (Math.abs(params.amount - expectedTiyin) > 1) {
      return this._error(id, -31001, "Noto'g'ri summa");
    }

    const payment = await this.prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amount: invoice.amount,
        method: PaymentMethod.PAYME,
        status: PaymentStatus.PENDING,
        transactionId: params.id,
      },
    });

    // Plan 04-02 PAY-04 — schedule 12h auto-cancel. Deterministic jobId so
    // duplicate webhook retransmits within TTL coalesce to a single delayed
    // job. The remove() in _performTransaction / _cancelTransaction defuses
    // the timer when the payment settles.
    try {
      await this.paymentTimeoutQueue.add(
        "cancel-on-timeout",
        { paymentId: payment.id, provider: "PAYME" },
        {
          jobId: buildJobId("payment-timeout", payment.id),
          delay: PAYMENT_TIMEOUT_DELAY_MS,
        },
      );
    } catch (err) {
      // BullMQ failure must NOT break the transaction-create response — Payme
      // will retransmit on its own and the deterministic jobId makes the
      // re-enqueue idempotent.
      this.logger.warn(
        `Payme timeout enqueue failed for ${payment.id}: ${(err as Error).message}`,
      );
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        create_time: payment.createdAt.getTime(),
        transaction: payment.id,
        state: 1,
      },
    };
  }

  // ── PerformTransaction ────────────────────────────────────────────────────
  // Plan 04-02 PAY-03 — Payment + Invoice + Subscription updates + AiAuditLog
  // commit-or-rollback together via interactive $transaction. Pre-04-02 the
  // four awaits were sequential outside any transaction; a crash between them
  // left the system in an inconsistent state (Invoice PAID, Subscription not).
  private async _performTransaction(id: any, params: any): Promise<PaymeRpcResponse> {
    const payment = await this.prisma.payment.findFirst({
      where: { transactionId: params.id },
      include: { invoice: { include: { subscription: true } } },
    });
    if (!payment) return this._error(id, -31003, "Tranzaksiya topilmadi");
    if (payment.status === PaymentStatus.PAID) {
      return {
        jsonrpc: "2.0",
        id,
        result: { perform_time: payment.paidAt.getTime(), transaction: payment.id, state: 2 },
      };
    }
    // Plan 04-02 audit-fix FIX B2 — terminal-state guard. PerformTransaction
    // is only valid for PENDING. Pre-fix, a Payme retransmit (or operator
    // request) on a FAILED or REFUNDED row would flip status to PAID via the
    // $transaction below — losing the prior cancel/refund and double-charging
    // Subscription side-effects. -31008 is "transaction in terminal state".
    if (
      payment.status === PaymentStatus.FAILED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      this.logger.warn(
        `Payme PerformTransaction rejected — payment ${payment.id} in terminal state ${payment.status}.`,
      );
      return this._error(
        id,
        -31008,
        "Cannot perform — transaction terminal state",
      );
    }

    // P2 M10 (defense-in-depth) — aktivlashtirishdan OLDIN to'lov summasi
    // invoice summasiga (tiyin) tengligini qayta tasdiqlaymiz. Create va
    // Perform orasida invoice summasi o'zgargan (yoki payment qatori buzilgan)
    // bo'lsa, hujjatlashtirilgan -31001 "Noto'g'ri summa" qaytariladi.
    // NaN xavfsizligi: noma'lum/yo'q summa ham rad etiladi (Number.isFinite).
    const paymentTiyin = Number(payment.amount) * 100;
    const invoiceTiyin = Number(payment.invoice?.amount) * 100;
    if (
      !Number.isFinite(paymentTiyin) ||
      !Number.isFinite(invoiceTiyin) ||
      Math.abs(paymentTiyin - invoiceTiyin) > 1
    ) {
      this.logger.warn(
        `Payme PerformTransaction rejected — amount mismatch for ${payment.id}: payment=${paymentTiyin} invoice=${invoiceTiyin} (tiyin).`,
      );
      return this._error(id, -31001, "Noto'g'ri summa");
    }

    const now = new Date();

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
          paymentMethod: PaymentMethod.PAYME,
        },
      });

      // Plan 04-03 PAY-06: validate the Subscription transition via the
      // SYSTEM bypass whitelist. This proves a webhook can never reach
      // FROZEN / DELETED. PENDING→ACTIVE is the standard webhook path;
      // TRIAL→ACTIVE only validates for free plans (GOV/MAH) — which is
      // the expected shape for a webhook only if the subscription was
      // already on a free plan, so the assertion is safe.
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
            provider: "PAYME",
            transactionId: params.id,
            by: "WEBHOOK",
          }),
          recommendation: "",
        },
      });
    });

    // Plan 04-02 PAY-04 — defuse the 12h timeout. .catch swallows the missing-
    // job error BullMQ throws when remove() runs after the job already fired.
    await this.paymentTimeoutQueue
      .remove(buildJobId("payment-timeout", payment.id))
      .catch(() => undefined);

    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache. A successful
    // perform mutates totalRevenue + paidInvoices + monthlyTrend and the
    // dashboard polls every 30-60s; without invalidation the operator sees
    // stale numbers for up to 5min (cache TTL). .catch swallows Redis blips
    // so a cache outage never fails a payment commit.
    await this.cache.delPattern(BUXGALTER_CACHE_PATTERN).catch(() => undefined);

    this.logger.log(`Payme to'lov tasdiqlandi: ${payment.id}, Invoice: ${payment.invoiceId}`);

    return {
      jsonrpc: "2.0",
      id,
      result: { perform_time: now.getTime(), transaction: payment.id, state: 2 },
    };
  }

  // ── CancelTransaction ─────────────────────────────────────────────────────
  // Plan 04-02 PAY-03 — atomic Payment.update + AiAuditLog inside $transaction.
  // Plan 04-02 PAY-04 — reason=4 when our timeout fired before Payme cancelled
  // (per Payme docs verified 2026-06-07: reason=4 = "transaction not found by
  // merchant after the merchant marked it cancelled").
  //
  // P2 M9 — rasmiy holat mashinasi (developer.help.paycom.uz + PaycomUZ
  // rasmiy PHP shabloni Transaction.php):
  //   state -1 = perform'dan OLDIN bekor qilingan  → Payment.status FAILED
  //   state -2 = perform'dan KEYIN bekor qilingan  → Payment.status REFUNDED
  // Bekor qilish metama'lumotlari (cancelledAt + cancelReason) endi Payment
  // qatorida saqlanadi — CheckTransaction/GetStatement haqiqiy cancel_time
  // (ms epoch) va reason ni qaytara oladi.
  private async _cancelTransaction(id: any, params: any): Promise<PaymeRpcResponse> {
    const payment = await this.prisma.payment.findFirst({
      where: { transactionId: params.id },
      include: { invoice: { include: { subscription: true } } },
    });
    if (!payment) return this._error(id, -31003, "Tranzaksiya topilmadi");

    // Plan 04-02 audit-fix FIX B3 — idempotent re-cancel. A duplicate
    // CancelTransaction on an already-cancelled payment must echo the same
    // success without re-running the $transaction (otherwise we'd double-
    // demote Invoice/Subscription on every retransmit).
    // P2 M9 — "allaqachon bekor qilingan" = REFUNDED (perform'dan keyin)
    // YOKI FAILED + cancelledAt to'ldirilgan (perform'dan oldin webhook
    // orqali bekor qilingan; cancelledAt'siz FAILED = bizning timeout
    // ishchimiz belgilagan, Payme'ning o'z Cancel'i hali kelmagan).
    const alreadyCancelled =
      payment.status === PaymentStatus.REFUNDED ||
      (payment.status === PaymentStatus.FAILED && payment.cancelledAt != null);
    if (alreadyCancelled) {
      // Sabab: avval saqlangan ustundan; legacy qatorlar (ustun migratsiyadan
      // oldin yozilgan) uchun oxirgi STATE_TRANSITION audit yozuvidan o'qiladi.
      let echoReason: number | undefined =
        typeof payment.cancelReason === "number" ? payment.cancelReason : undefined;
      if (echoReason === undefined) {
        const lastLog = await this.prisma.aiAuditLog.findFirst({
          where: { scope: "payment", scopeId: payment.id, issueType: "STATE_TRANSITION" },
          orderBy: { createdAt: "desc" },
        });
        try {
          const parsed = lastLog?.analysis
            ? JSON.parse(lastLog.analysis as string)
            : null;
          if (parsed && typeof parsed.reason === "number") {
            echoReason = parsed.reason;
          }
        } catch {
          // Swallow — best-effort echo. Fall through without reason override.
        }
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          cancel_time: payment.cancelledAt ? payment.cancelledAt.getTime() : Date.now(),
          transaction: payment.id,
          state: payment.status === PaymentStatus.REFUNDED ? -2 : -1,
          ...(echoReason !== undefined ? { reason: echoReason } : {}),
        },
      };
    }

    // Detect timeout-driven cancel: Payment already FAILED + most recent
    // AiAuditLog row for this payment has issueType="TIMEOUT". If so, the
    // response carries reason=4 instead of caller-supplied reason.
    const wasTimedOut = payment.status === PaymentStatus.FAILED;
    let reasonOverride: number | undefined;
    if (wasTimedOut) {
      const lastLog = await this.prisma.aiAuditLog.findFirst({
        where: { scope: "payment", scopeId: payment.id },
        orderBy: { createdAt: "desc" },
      });
      if (lastLog?.issueType === "TIMEOUT") {
        reasonOverride = 4;
      }
    }

    // Plan 04-02 audit-fix FIX B3 — full refund propagation. Cancel of a
    // PAID payment must also walk back Invoice + Subscription so the system
    // state stays internally consistent. PENDING cancel (the timeout path)
    // only touches Payment + the audit log because Invoice/Subscription
    // were never advanced in the first place.
    const fromStatus = payment.status;
    const propagateRefund = fromStatus === PaymentStatus.PAID;

    // P2 M9 — yakuniy holat rasmiy mashinaga mos:
    //   perform'dan keyin bekor → REFUNDED, state -2 (pul qaytarildi);
    //   perform'dan oldin bekor (PENDING yoki timeout-FAILED) → FAILED,
    //   state -1 (hech qachon bajarilmagan to'lovni "REFUNDED" deb belgilash
    //   semantik xato edi va -1/-2 farqini yo'qotardi).
    const cancelledStatus = propagateRefund
      ? PaymentStatus.REFUNDED
      : PaymentStatus.FAILED;
    const cancelState = propagateRefund ? -2 : -1;
    const cancelledAt = new Date();
    const rawReason = reasonOverride ?? params?.reason;
    const cancelReason =
      typeof rawReason === "number" && Number.isFinite(rawReason)
        ? Math.trunc(rawReason)
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: cancelledStatus,
          // P2 M9 — bekor qilish metama'lumotlari CheckTransaction/GetStatement
          // uchun saqlanadi (haqiqiy cancel_time + reason).
          cancelledAt,
          cancelReason,
        },
      });

      if (propagateRefund) {
        // Schema note: Invoice.status uses the PaymentStatus enum (PENDING,
        // PAID, FAILED, REFUNDED) — REFUNDED is the correct terminal value
        // for a refunded invoice.
        await tx.invoice.update({
          where: { id: payment.invoiceId },
          data: { status: PaymentStatus.REFUNDED },
        });
        if (payment.invoice?.subscriptionId) {
          // Plan 04-03 audit-fix FIX D (SEC HIGH) — refund propagation MUST
          // go through assertSubscriptionTransition. Pre-fix, the webhook
          // wrote `status: FROZEN` directly, bypassing the state-machine
          // validator AND skipping the AiAuditLog row. FROZEN is the
          // admin-only terminal (sabab majburiy); the webhook target is
          // PENDING — needs admin attention, but billing UI still visible.
          const sub = await tx.subscription.findUnique({
            where: { id: payment.invoice.subscriptionId },
          });
          if (sub) {
            assertSubscriptionTransition(
              sub.status,
              SubscriptionStatus.PENDING,
              "SYSTEM",
              "Payme refund",
              sub.planType,
            );
            await tx.subscription.update({
              where: { id: payment.invoice.subscriptionId },
              data: { status: SubscriptionStatus.PENDING },
            });
            await tx.aiAuditLog.create({
              data: {
                scope: "subscription",
                scopeId: payment.invoice.subscriptionId,
                issueType: "STATE_TRANSITION",
                severity: "HIGH",
                analysis: JSON.stringify({
                  from: sub.status,
                  to: "PENDING",
                  by: "WEBHOOK_PAYME",
                  actorRole: "SYSTEM",
                  reason: "Payme refund — needs admin review",
                  paymentId: payment.id,
                }),
                recommendation:
                  "Admin: verify refund + decide whether to FROZEN/DELETE the subscription",
              },
            });
          }
        }
      }

      await tx.aiAuditLog.create({
        data: {
          scope: "payment",
          scopeId: payment.id,
          issueType: "STATE_TRANSITION",
          severity: "MEDIUM",
          analysis: JSON.stringify({
            from: fromStatus,
            to: cancelledStatus,
            provider: "PAYME",
            transactionId: params.id,
            reason: cancelReason,
            paymeState: cancelState,
            by: "WEBHOOK",
            invoiceRefunded: propagateRefund,
            subscriptionFrozen:
              propagateRefund && !!payment.invoice?.subscriptionId,
          }),
          recommendation: "",
        },
      });
    });

    // Defuse any pending timeout job.
    await this.paymentTimeoutQueue
      .remove(buildJobId("payment-timeout", payment.id))
      .catch(() => undefined);

    // Plan 04-04 RPT-03 — invalidate Buxgalter stats cache on refund too,
    // since totalRevenue, byMethod, and monthlyTrend all reflect PAID payments
    // that just transitioned to REFUNDED.
    if (propagateRefund) {
      await this.cache.delPattern(BUXGALTER_CACHE_PATTERN).catch(() => undefined);
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        cancel_time: cancelledAt.getTime(),
        transaction: payment.id,
        state: cancelState,
        ...(reasonOverride !== undefined ? { reason: reasonOverride } : {}),
      },
    };
  }

  // ── Payme holat ko'rinishi (P2 M9) ───────────────────────────────────────
  // Rasmiy holat mashinasi: 1 yaratilgan, 2 bajarilgan, -1 perform'dan oldin
  // bekor, -2 perform'dan keyin bekor. CheckTransaction va GetStatement bir
  // xil maydon to'plamini qaytarishi shart — shu yerda umumlashtirilgan.
  private _paymeTransactionView(p: {
    id: string;
    status: PaymentStatus | string;
    createdAt: Date;
    paidAt: Date | null;
    cancelledAt?: Date | null;
    cancelReason?: number | null;
  }): {
    create_time: number;
    perform_time: number;
    cancel_time: number;
    transaction: string;
    state: number;
    reason: number | null;
  } {
    const stateMap: Record<string, number> = {
      PENDING: 1,
      PAID: 2,
      // FAILED = perform'dan OLDIN bekor (timeout yoki Payme cancel) → -1
      FAILED: -1,
      // REFUNDED = perform'dan KEYIN bekor (pul qaytarilgan) → -2
      REFUNDED: -2,
    };
    // perform_time bekor qilingandan keyin ham saqlanadi: -2 holatda Payme
    // ham perform_time, ham cancel_time to'ldirilgan bo'lishini kutadi.
    const performed = p.status === "PAID" || p.status === "REFUNDED";
    return {
      create_time: p.createdAt.getTime(),
      perform_time: performed && p.paidAt ? p.paidAt.getTime() : 0,
      cancel_time: p.cancelledAt ? p.cancelledAt.getTime() : 0,
      transaction: p.id,
      state: stateMap[p.status as string] ?? 1,
      reason: p.cancelReason ?? null,
    };
  }

  // ── CheckTransaction ──────────────────────────────────────────────────────
  // P2 M9 — avval cancel_time:0 va reason:null hardcode bo'lib, FAILED va
  // REFUNDED ikkalasi -1 ga maplanardi. Endi saqlangan cancelledAt/cancelReason
  // qaytariladi va -1/-2 rasmiy mashinaga mos ajratiladi.
  private async _checkTransaction(id: any, params: any): Promise<PaymeRpcResponse> {
    const payment = await this.prisma.payment.findFirst({
      where: { transactionId: params.id },
    });
    if (!payment) return this._error(id, -31003, "Tranzaksiya topilmadi");

    return {
      jsonrpc: "2.0",
      id,
      result: this._paymeTransactionView(payment),
    };
  }

  // ── GetStatement ──────────────────────────────────────────────────────────
  // P2 M9 — CheckTransaction bilan bir xil holat/vaqt maydonlari (rasmiy spec:
  // statement yozuvlari ham to'liq state machine ko'rinishini qaytaradi).
  private async _getStatement(id: any, params: any): Promise<PaymeRpcResponse> {
    const from = new Date(params.from);
    const to = new Date(params.to);

    const payments = await this.prisma.payment.findMany({
      where: {
        method: PaymentMethod.PAYME,
        createdAt: { gte: from, lte: to },
      },
      include: { invoice: true },
    });

    return {
      jsonrpc: "2.0",
      id,
      result: {
        transactions: payments.map((p) => ({
          id: p.transactionId,
          time: p.createdAt.getTime(),
          amount: Number(p.amount) * 100,
          account: { invoiceId: p.invoiceId },
          ...this._paymeTransactionView(p),
        })),
      },
    };
  }

  // ── Auth tekshiruvi ───────────────────────────────────────────────────────
  // Plan 04-01 audit-fix FIX 3 — constant-time compare + reject empty keys
  // (logic now lives in the shared verifyPaymeBasicAuth helper so the donate
  // webhook path reuses the exact same verifier).
  //
  // SEC FIX H2 — pre-fix, `login === "Paycom"` selected PAYME_TEST_KEY even
  // under NODE_ENV=production, so anyone holding the sandbox key could
  // authenticate production webhooks (perform/cancel real transactions).
  // The sandbox branch is now gated on !isProductionEnv(): in production the
  // expected key is ALWAYS the production merchant key, regardless of login.
  private _verifyAuth(authHeader: string) {
    verifyPaymeBasicAuth(authHeader, {
      secretKey: this.secretKey,
      testKey: this.testKey,
      allowTestKey: !isProductionEnv(),
    });
  }

  // P2 M9 — rasmiy spec: -31050..-31099 hisob xatolari uchun `data` maydoni
  // muammoli account pastki-maydon nomini ko'rsatishi shart (masalan,
  // "invoiceId"). Boshqa kodlar uchun data yuborilmaydi.
  private _error(
    id: any,
    code: number,
    message: string,
    data?: string,
  ): PaymeRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymeRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: Record<string, any>;
}

export interface PaymeRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, any>;
  // P2 M9 — `data` (ixtiyoriy): -31050..-31099 hisob xatolarida muammoli
  // account maydon nomi (rasmiy Merchant API talabi).
  error?: { code: number; message: string; data?: string };
}
