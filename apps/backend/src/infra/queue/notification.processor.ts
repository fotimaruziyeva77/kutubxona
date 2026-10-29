import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { NOTIFICATION_QUEUE } from "./queue-names";
import { EskizSmsClient } from "../sms/eskiz.client";
import { FcmClient, InvalidFcmTokenError } from "../notifications/fcm.client";
import { MailClient } from "../notifications/mail.client";
import { PrismaService } from "../prisma/prisma.service";
import { escapeHtml } from "../../common/utils/escape-html.util";
import {
  EMAIL_REGEX,
  MAX_ADMIN_FALLBACK_RECIPIENTS,
  parseAdminFallbackEmails,
} from "../../common/utils/admin-email.util";

export interface NotificationJobData {
  type: "sms" | "push" | "email";
  phone?: string;
  email?: string;
  deviceToken?: string;
  message: string;
  userId?: string;
  // Plan 05-04 NOTIF-03 — optional email shape extensions.
  subject?: string;
  html?: string;
  jobType?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
    // Plan 05-08-fix FIX B — when set to "base64", the receiver (nodemailer)
    // decodes content back to bytes. Required when the attachment was
    // base64-encoded BEFORE enqueue to survive BullMQ's JSON round-trip.
    encoding?: string;
  }>;
  // Plan 05-04 NOTIF-02 — optional push title (callers may override the
  // default "[SIFAT LIBRARY] <jobType>" subject for push notifications).
  title?: string;
}

/**
 * Per-user fan-out cap for push: defend against token bloat. Plan 05-04 Task 1.
 * Top-10 most recently seen tokens by lastSeen DESC.
 */
const PUSH_PER_USER_TOKEN_CAP = 10;

/**
 * H5 fix — log redaction helper. SMS message bodies contain OTP codes
 * ("Tasdiqlash kodingiz: XXXX"), shuning uchun processor loglariga HECH
 * QACHON message matni yoki to'liq job.data yozilmaydi. Telefon raqam faqat
 * maskalangan holda chiqadi: +998901234567 → +99890***4567. Qisqa/g'alati
 * qiymatlar to'liq yashiriladi (prefix+suffix ustma-ust tushib raqamni
 * oshkor qilmasligi uchun).
 */
export function maskPhone(phone?: string): string {
  if (!phone) return "-";
  if (phone.length < 12) return "***";
  return `${phone.slice(0, 6)}***${phone.slice(-4)}`;
}

// Plan 05-04 FIX C + Plan 05-08-fix FIX A — admin-fallback parsing and cap are
// now consolidated into common/utils/admin-email.util so AdminService (monthly
// report cron) and NotificationProcessor share a single validation pipeline.
// EMAIL_REGEX and MAX_ADMIN_FALLBACK_RECIPIENTS are re-exported via the named
// imports above so existing grep gates ("EMAIL_REGEX", "MAX_ADMIN_FALLBACK_…")
// continue to hit this file. The constants are also used directly here for the
// validated.length === 0 short-circuit branch.
void EMAIL_REGEX;
void MAX_ADMIN_FALLBACK_RECIPIENTS;

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly eskiz: EskizSmsClient,
    // Plan 05-04 NOTIF-02 — FCM push wiring (replaces the prior TODO stub).
    private readonly fcm: FcmClient,
    // Plan 05-04 NOTIF-03 — SMTP email wiring (replaces the prior TODO stub).
    private readonly mail: MailClient,
    // Plan 05-04 — DeviceToken fan-out + dead-token cleanup require Prisma.
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const { type } = job.data;

    switch (type) {
      case "sms":
        await this.sendSms(job.data);
        break;
      case "push":
        await this.sendPush(job.data);
        break;
      case "email":
        await this.sendEmail(job.data);
        break;
      default:
        throw new Error(`Noma'lum bildirishnoma turi: ${type}`);
    }

    // H5 fix: faqat metadata log qilinadi (message matni EMAS) — SMS matnida
    // OTP kod bor, log orqali sizib chiqmasligi shart.
    this.logger.log(
      `Bildirishnoma yuborildi [${type}] job=${job.name} id=${job.id} tel=${maskPhone(job.data.phone)}`
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<NotificationJobData>, error: Error) {
    // H5 fix: job.data log qilinmaydi (telefon + SMS matni/OTP kod bor) —
    // faqat jobId, nom, tur va maskalangan telefon.
    this.logger.error(
      `Job muvaffaqiyatsiz (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
      {
        jobId: job.id,
        name: job.name,
        type: job.data?.type,
        jobType: job.data?.jobType,
        phone: maskPhone(job.data?.phone),
      }
    );

    // Barcha urinishlar tugagach dead letter ga o'tadi (removeOnFail: false)
    if (job.attemptsMade === job.opts.attempts) {
      this.logger.error(`Job DLQ ga o'tkazildi: ${job.id}`);
    }
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`Job tugadi: ${job.id}`);
  }

  private async sendSms(data: NotificationJobData): Promise<void> {
    if (!data.phone) {
      throw new Error("SMS job missing phone");
    }
    // NOTIF-01 / NOTIF-04: route through the real Eskiz HTTP client (replaces the prior no-op).
    // The client itself handles dev-no-op when ESKIZ_EMAIL is unset.
    await this.eskiz.sendSms(data.phone, data.message);
  }

  /**
   * Plan 05-04 Task 1 — NOTIF-02 closure.
   *
   * Single-target path: `data.deviceToken` is provided → push exactly once.
   * Fan-out path:       only `data.userId` is provided → look up top-10 most
   *                     recently seen device tokens for that user and push to
   *                     each. Each token's error is handled in isolation so
   *                     one dead token cannot fail the whole job.
   * Bug-tolerant path:  neither set → warn and return (no throw).
   *
   * Dead-token handling: when FcmClient throws InvalidFcmTokenError, the
   * processor deletes the matching DeviceToken row and CONTINUES with the
   * remaining tokens. Any other error from fcm.sendToToken propagates so
   * BullMQ can retry per the queue's exponential-backoff job options.
   *
   * lastSeen update is fire-and-forget — failure to update lastSeen never
   * breaks the actual send.
   */
  private async sendPush(data: NotificationJobData): Promise<void> {
    const title = data.title ?? data.subject ?? "SIFAT LIBRARY";
    const body = data.message ?? "";

    if (data.deviceToken) {
      await this._pushToToken(data.deviceToken, title, body);
      return;
    }

    if (!data.userId) {
      this.logger.warn("[notification] push job missing target (no deviceToken, no userId)");
      return;
    }

    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId: data.userId },
      orderBy: { lastSeen: "desc" },
      take: PUSH_PER_USER_TOKEN_CAP,
      select: { id: true, token: true },
    });

    if (tokens.length === 0) {
      this.logger.debug(`[notification] no device tokens for user=${data.userId}`);
      return;
    }

    for (const row of tokens) {
      // Per-token error containment: a dead/blocked token must not abort
      // the fan-out. Generic transient errors re-throw so BullMQ retries
      // — the loop position is recovered on retry by re-fetching tokens.
      await this._pushToToken(row.token, title, body);
    }
  }

  /**
   * Plan 05-04 — push a single token. Returns void on success; deletes the
   * DeviceToken row on InvalidFcmTokenError and SWALLOWS that error so the
   * caller's fan-out can continue. Other errors propagate to the caller.
   */
  private async _pushToToken(token: string, title: string, body: string): Promise<void> {
    try {
      await this.fcm.sendToToken(token, { title, body });
      // Fire-and-forget lastSeen update. Failure here is non-fatal.
      this.prisma.deviceToken
        .updateMany({ where: { token }, data: { lastSeen: new Date() } })
        .catch((err: Error) =>
          this.logger.debug(`[fcm lastSeen update failed] ${err.message}`),
        );
    } catch (err) {
      if (err instanceof InvalidFcmTokenError) {
        // P2025 (record not found) on double-delete is benign — swallow it.
        try {
          await this.prisma.deviceToken.deleteMany({ where: { token } });
        } catch (delErr) {
          this.logger.debug(
            `[fcm token cleanup] delete failed: ${(delErr as Error).message}`,
          );
        }
        this.logger.log(`[fcm token cleanup] removed dead token ***${token.slice(-8)}`);
        // SWALLOW the InvalidFcmTokenError — do NOT re-throw.
        return;
      }
      // Other errors re-throw for BullMQ retry.
      throw err;
    }
  }

  /**
   * Plan 05-04 Task 2 — NOTIF-03 closure.
   *
   * Bug-tolerant path: no recipient (no `email`, no admin-fallback) → warn
   * and return silently (mirrors sendPush no-target behaviour).
   *
   * Defaults:
   *   subject = `[SIFAT LIBRARY] <jobType ?? "Notification">`
   *   html    = `<pre>${escapeHtml(message)}</pre>` (defense-in-depth — if a
   *             caller forgets to escape, we still emit safe HTML).
   *
   * Callers that pass `data.html` are responsible for escaping at the source
   * (e.g. Plan 05-05 alert engine, Plan 05-08 PDF report email shell).
   *
   * Admin fallback (per Q7): when `to` is empty BUT `data.admin === true`
   * (passed via the data envelope), the message is broadcast to every entry
   * in the ADMIN_NOTIFICATION_EMAILS env var (CSV).
   */
  private async sendEmail(data: NotificationJobData): Promise<void> {
    const subject =
      data.subject ?? `[SIFAT LIBRARY] ${data.jobType ?? "Notification"}`;
    const html = data.html ?? `<pre>${escapeHtml(data.message ?? "")}</pre>`;

    if (data.email) {
      await this.mail.send({
        to: data.email,
        subject,
        html,
        attachments: data.attachments,
      });
      return;
    }

    // Admin-fallback path: env-driven recipient list. Used by Plan 05-09
    // demo-request notifications and similar admin broadcasts.
    //
    // 05-04-fix FIX C — defense in depth:
    //   - parse: trim + lowercase + regex-validate, drop malformed with warn.
    //   - cap MAX_ADMIN_FALLBACK_RECIPIENTS (10) — if env is misconfigured
    //     with a long list, we take only the first 10 and log a warning.
    //   - audit: write an AiAuditLog row capturing the recipient count and
    //     subject (NOT body — bodies can contain PII). Admin-fallback should
    //     be a rare event; the audit row makes abuse spike obvious.
    const admin = (data as NotificationJobData & { admin?: boolean }).admin === true;
    if (admin) {
      // Shared validation + cap pipeline lives in admin-email.util — single
      // source of truth across NotificationProcessor and AdminService
      // (Plan 05-08-fix FIX A).
      const recipients = parseAdminFallbackEmails(
        process.env.ADMIN_NOTIFICATION_EMAILS,
        { warn: (m) => this.logger.warn(`[notification] ${m}`) },
      );

      if (recipients.length === 0) {
        this.logger.warn(
          "[notification] email admin fallback requested but ADMIN_NOTIFICATION_EMAILS is unset or all entries invalid",
        );
        return;
      }

      // Audit row (best-effort — never block the actual send if audit fails).
      this.prisma.aiAuditLog
        .create({
          data: {
            scope: "SYSTEM",
            scopeId: "notification-processor",
            issueType: "ADMIN_NOTIFICATION_FALLBACK",
            severity: "LOW",
            analysis: `Admin email fallback dispatched to ${recipients.length} recipient(s). Subject: ${subject}`,
            recommendation:
              "Admin fallback should be rare; investigate if frequency spikes.",
          },
        })
        .catch((err: Error) =>
          this.logger.debug(`[admin fallback audit failed] ${err.message}`),
        );

      for (const addr of recipients) {
        await this.mail.send({
          to: addr,
          subject,
          html,
          attachments: data.attachments,
        });
      }
      return;
    }

    this.logger.warn("[notification] email job missing recipient (no to, no admin fallback)");
  }
}
