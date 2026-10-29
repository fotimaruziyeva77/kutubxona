import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PaymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_TIMEOUT_QUEUE } from "./queue-names";

/**
 * Plan 04-02 PAY-04 — 12-hour payment auto-cancel processor.
 *
 * Enqueued by PaymeService._createTransaction with a deterministic jobId
 * `payment-timeout:{paymentId}` and 12h delay. When the job fires, this
 * processor:
 *   1. Loads the Payment row.
 *   2. If status is no longer PENDING (already PAID/FAILED/REFUNDED) → no-op
 *      (covers the race where Payme confirms at hour 11:59 between when our
 *      delayed job becomes ready and when PerformTransaction's remove() runs).
 *   3. Otherwise opens an interactive $transaction that flips Payment.status
 *      to FAILED and writes an AiAuditLog row with issueType="TIMEOUT".
 *
 * The reason=4 mapping (per Payme docs verified 2026-06-07) is applied by
 * PaymeService._cancelTransaction when the subsequent Payme CancelTransaction
 * call observes Payment.status===FAILED and the latest audit row is TIMEOUT.
 */
export interface PaymentTimeoutJobData {
  paymentId: string;
  provider: string;
}

@Processor(PAYMENT_TIMEOUT_QUEUE, { concurrency: 5 })
export class PaymentTimeoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentTimeoutProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<PaymentTimeoutJobData>): Promise<void> {
    const { paymentId, provider } = job.data;

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      this.logger.warn(
        `Payment ${paymentId} not found for timeout — already deleted; no-op.`,
      );
      return;
    }
    if (payment.status !== "PENDING") {
      // Race: Payme confirmed (or another path resolved) between job become-
      // ready and remove() executing. Status guard makes the processor
      // idempotent + double-fire safe.
      this.logger.log(
        `Payment ${paymentId} already terminal (${payment.status}); timeout no-op.`,
      );
      return;
    }

    // Plan 04-02 audit-fix FIX B4 — conditional update closes the race
    // between `findUnique` above and `update` below. If the webhook flips
    // status PENDING→PAID in that tiny window, we MUST NOT downgrade it to
    // FAILED. The `where` clause includes status: PENDING; Prisma throws
    // P2025 (record-not-found) when the row no longer matches — we catch
    // that as a race-safe no-op and skip the audit log entirely.
    const flipped = await this.prisma.$transaction(async (tx) => {
      try {
        await tx.payment.update({
          where: { id: paymentId, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED },
        });
      } catch (err: any) {
        if (err?.code === "P2025") {
          this.logger.log(
            `Payment ${paymentId} no longer PENDING — race-safe no-op.`,
          );
          return false;
        }
        throw err;
      }
      await tx.aiAuditLog.create({
        data: {
          scope: "payment",
          scopeId: paymentId,
          issueType: "TIMEOUT",
          severity: "MEDIUM",
          analysis: JSON.stringify({
            provider,
            age_hours: 12,
            by: "SYSTEM_TIMEOUT",
          }),
          recommendation: "",
        },
      });
      return true;
    });

    if (flipped) {
      this.logger.log(
        `Payment ${paymentId} timed out after 12h; status flipped to FAILED.`,
      );
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<PaymentTimeoutJobData>, error: Error) {
    this.logger.error(
      `Payment timeout job failed (${job.id}): ${error.message}`,
      { paymentId: job.data?.paymentId },
    );
  }
}
