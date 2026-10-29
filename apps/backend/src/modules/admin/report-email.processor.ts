/**
 * Plan 05-08 Task 2 (RPT-02) — Monthly PDF report email processor.
 *
 * @Processor(REPORT_QUEUE, { concurrency: 2 }) consumes the 215 jobs enqueued
 * by AdminService.generateMonthlyReports cron (1 national + 14 viloyat + 200
 * tuman). Each job:
 *
 *   1. Calls ReportDataService.gatherForScope(scope, scopeId, periodStart, periodEnd).
 *   2. Renders the PDF via PdfService.generateMonthlyReport (which wraps
 *      buildMonthlyReportHtml + generateFromHtml).
 *   3. Enqueues NOTIFICATION_QUEUE 'email' jobs carrying the PDF as a base64
 *      string attachment. The NotificationProcessor.sendEmail path (Plan 05-04
 *      NOTIF-03) is reused — single source of truth for MailClient + the
 *      header-injection guard + admin-fallback validation.
 *
 * Plan 05-08-fix FIX B (HIGH SEC) — PDF Buffer JSON corruption.
 *   BullMQ persists job.data via JSON.stringify. Buffer.toJSON returns
 *   {type:'Buffer', data:[byte,...]}. The receiver decodes to a plain object,
 *   NOT a Buffer. Nodemailer then String(content) → '[object Object]' →
 *   corrupted attachment. We base64-encode the PDF BEFORE enqueue and set
 *   encoding: 'base64' so nodemailer decodes back to bytes server-side; the
 *   base64 string round-trips JSON intact.
 *
 * Plan 05-08-fix FIX A (HIGH SEC) — ADMIN_NOTIFICATION_EMAILS validation.
 *   The previous fan-out enqueued one NOTIFICATION_QUEUE job per recipient
 *   with `email: addr` (bypassing the admin-fallback validation Plan 05-04
 *   FIX C established). We now enqueue ONE job per scope with `admin: true`
 *   when the recipient list is the env-CSV fallback — NotificationProcessor
 *   handles the validated fan-out (regex + cap 10 + AiAuditLog). When the
 *   recipient list comes from a real per-scope user lookup
 *   (ReportEmailJobData.recipients[i].userId != null), we keep the
 *   per-recipient enqueue path because those addresses are already
 *   trusted (they came from the User table, not env CSV).
 *
 * Concurrency cap = 2 per Plan 05-08 PITFALLS M6: 215 simultaneous Puppeteer
 * renders OOM a 4GB-RAM node. BullMQ naturally throttles to the concurrency
 * limit even if many jobs land in the queue at once.
 *
 * Retries are governed by REPORT_QUEUE defaultJobOptions in queue.module.ts
 * (attempts: 3, exponential backoff base 30s).
 */

import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Inject, Logger, forwardRef } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { NOTIFICATION_QUEUE, REPORT_QUEUE } from "../../infra/queue/queue-names";
import { buildJobId } from "../../infra/queue/job-id.util";
import { PdfService } from "../../infra/pdf/pdf.service";
import { ReportDataService, ReportScope } from "./report-data.service";

export interface ReportEmailJobData {
  scope: ReportScope;
  scopeId: string | null;
  periodStart: string; // ISO — serialized through BullMQ Redis envelope
  periodEnd: string;
  /**
   * Recipients resolved by AdminService._resolveRecipients. When every
   * recipient has `userId == null`, the list came from the
   * ADMIN_NOTIFICATION_EMAILS env CSV fallback (see _resolveRecipients
   * fall-through). In that case we hand control to NotificationProcessor's
   * `admin: true` path which re-parses + validates + caps the env CSV via
   * common/utils/admin-email.util (Plan 05-08-fix FIX A).
   */
  recipients: Array<{ email: string; userId?: string | null }>;
}

@Processor(REPORT_QUEUE, { concurrency: 2 })
export class ReportEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportEmailProcessor.name);

  constructor(
    @Inject(forwardRef(() => ReportDataService))
    private readonly reportData: ReportDataService,
    private readonly pdf: PdfService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ReportEmailJobData>): Promise<{ enqueuedEmails: number }> {
    const { scope, scopeId, periodStart, periodEnd, recipients } = job.data;

    if (!recipients || recipients.length === 0) {
      this.logger.warn(
        `[report-email] no recipients for scope=${scope} scopeId=${scopeId ?? "-"}; skipping render`,
      );
      return { enqueuedEmails: 0 };
    }

    const pStart = new Date(periodStart);
    const pEnd = new Date(periodEnd);

    // 1. Gather (single replica round-trip set per job).
    const data = await this.reportData.gatherForScope(scope, scopeId, pStart, pEnd);

    // 2. Render PDF once per job (NOT once per recipient — the same PDF goes
    //    to all recipients of the same scope).
    const pdfBuffer = await this.pdf.generateMonthlyReport(data, scope, scopeId ?? undefined);

    // Plan 05-08-fix FIX B — base64-encode the PDF BEFORE enqueueing.
    // BullMQ persists job.data via JSON.stringify; a raw Buffer becomes
    // {type:'Buffer', data:[...]} on the round-trip and nodemailer then
    // serializes that object literal to '[object Object]'. base64 string +
    // encoding:'base64' survives the Redis envelope intact.
    const pdfBase64 = pdfBuffer.toString("base64");

    const periodLabel = pStart.toISOString().slice(0, 7); // YYYY-MM
    const subject = `[SIFAT LIBRARY] ${this._scopeLabel(scope)} oylik hisobot — ${periodLabel}`;
    const html = `<p>Hurmatli admin,</p>
<p>${this._scopeLabel(scope)} doirasidagi ${periodLabel} oyiga oid kitobxonlik hisoboti tayyor.
PDF ilovani tekshiring.</p>
<p>— SIFAT LIBRARY</p>`;
    const filename = `sifat-hisobot-${scope}-${scopeId ?? "UZ"}-${periodLabel}.pdf`;

    const attachmentPayload = {
      filename,
      content: pdfBase64,
      encoding: "base64",
      contentType: "application/pdf",
    };

    // Plan 05-08-fix FIX A — detect ADMIN_NOTIFICATION_EMAILS fallback
    // recipients (every entry has userId == null because
    // AdminService._adminFallbackRecipients constructs them that way).
    // For those, enqueue ONE per-scope job with admin: true so
    // NotificationProcessor.sendEmail re-resolves via the shared validation
    // pipeline (parseAdminFallbackEmails: regex + cap 10 + AiAuditLog row).
    const isAdminFallback = recipients.every(
      (r) => !r.userId && !!r.email,
    );

    if (isAdminFallback) {
      await this.notificationQueue.add(
        "monthly-report-email",
        {
          type: "email",
          admin: true,
          subject,
          html,
          message: subject,
          jobType: "monthly-report",
          attachments: [attachmentPayload],
        },
        {
          // Dedupe per (scope, scopeId, period) so a retried REPORT_QUEUE job
          // doesn't double-email the admin fallback set.
          jobId: buildJobId(
            "monthly-report-email",
            scope,
            scopeId ?? "UZ",
            periodLabel,
            "admin-fallback",
          ),
        },
      );
      this.logger.log(
        `[report-email] scope=${scope} scopeId=${scopeId ?? "-"} period=${periodLabel} enqueued=admin-fallback (1 job, NotificationProcessor fans out)`,
      );
      return { enqueuedEmails: 1 };
    }

    // Per-recipient enqueue path — used when recipients come from a real
    // per-scope user lookup. Those addresses are trusted (already in the
    // User table) and don't need the env-CSV validation pipeline.
    let enqueued = 0;
    for (const recipient of recipients) {
      if (!recipient.email) continue;
      await this.notificationQueue.add(
        "monthly-report-email",
        {
          type: "email",
          email: recipient.email,
          subject,
          html,
          message: subject,
          jobType: "monthly-report",
          attachments: [attachmentPayload],
        },
        {
          // Per-recipient dedupe inside the notification queue so a retried
          // REPORT_QUEUE job doesn't double-email any recipient.
          jobId: buildJobId(
            "monthly-report-email",
            scope,
            scopeId ?? "UZ",
            periodLabel,
            recipient.email,
          ),
        },
      );
      enqueued++;
    }

    this.logger.log(
      `[report-email] scope=${scope} scopeId=${scopeId ?? "-"} period=${periodLabel} enqueued=${enqueued}`,
    );
    return { enqueuedEmails: enqueued };
  }

  private _scopeLabel(scope: ReportScope): string {
    if (scope === "national") return "Respublika";
    if (scope === "viloyat") return "Viloyat";
    return "Tuman";
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<ReportEmailJobData>, error: Error) {
    this.logger.error(
      `[report-email] job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
      { scope: job.data.scope, scopeId: job.data.scopeId },
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`[report-email] job ${job.id} completed`);
  }
}
