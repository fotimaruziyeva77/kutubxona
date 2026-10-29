import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";

/**
 * Plan 05-01 Task 2 — SMTP mail client (NOTIF-03).
 *
 * Mirrors EskizSmsClient + FcmClient pattern:
 *   1. Constructor reads SMTP_HOST/PORT/USER/PASS/SECURE/FROM via ConfigService.
 *   2. onModuleInit lazily creates the nodemailer Transporter. If SMTP_HOST is
 *      unset, logs [mail dev no-op] and returns — local dev / unit tests boot
 *      WITHOUT real SMTP credentials.
 *   3. Production fail-hard for SMTP_HOST/USER/PASS/FROM is enforced earlier in
 *      main.ts._assertEnvVars via PRODUCTION_REQUIRED_ENV.
 *   4. send() short-circuits when transporter is null.
 *
 * Threat model (T-05-07 email-header injection, T-05-SMTP-ENV):
 *   - Subject + From + To are sanitized to strip CR/LF before being placed in
 *     headers (mirrors the spirit of Plan 04-04 _sanitizeForSms).
 *   - To-address must contain exactly one '@' and no CR/LF — otherwise reject.
 *   - Recipient is masked in logs as `local@***` (full address never logged).
 */

export interface MailSendOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
    /**
     * Plan 05-08-fix FIX B — when content is a base64-encoded string (because
     * the attachment travelled through BullMQ's JSON envelope), set this to
     * "base64" so nodemailer decodes back to bytes server-side. Without it
     * nodemailer treats the string as UTF-8 and the attachment is corrupted.
     */
    encoding?: string;
  }>;
}

@Injectable()
export class MailClient implements OnModuleInit {
  private readonly logger = new Logger(MailClient.name);

  private readonly host?: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly user?: string;
  private readonly pass?: string;
  private readonly from: string;

  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>("SMTP_HOST");
    this.port = Number(this.config.get<string>("SMTP_PORT") ?? "587");
    this.secure =
      (this.config.get<string>("SMTP_SECURE") ?? "false").toLowerCase() ===
      "true";
    this.user = this.config.get<string>("SMTP_USER");
    this.pass = this.config.get<string>("SMTP_PASS");
    this.from =
      this.config.get<string>("SMTP_FROM") ??
      "SIFAT LIBRARY <noreply@sifat.uz>";
  }

  onModuleInit(): void {
    if (!this.host) {
      this.logger.warn(
        "[mail dev no-op] SMTP_HOST not set — email delivery disabled",
      );
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth:
          this.user && this.pass
            ? { user: this.user, pass: this.pass }
            : undefined,
      });
      this.logger.log(
        `SMTP ulandi: ${this.host}:${this.port} (secure=${this.secure})`,
      );
    } catch (err) {
      this.logger.error(
        `SMTP createTransport xatosi: ${(err as Error).message}`,
      );
      this.transporter = null;
    }
  }

  /**
   * Send an email. Dev no-op when SMTP_HOST was unset.
   * Throws on header-injection attempt (CR/LF in subject, from, or to).
   */
  async send(options: MailSendOptions): Promise<void> {
    const { to, subject, html, attachments } = options;

    // T-05-07: reject email-header injection BEFORE the no-op gate so dev
    // also catches the bug.
    if (this._hasCrlf(to) || this._hasCrlf(subject) || this._hasCrlf(this.from)) {
      this.logger.error(
        `[mail] header injection attempt rejected (to/subject/from contained CR/LF)`,
      );
      throw new Error("Email header injection rejected");
    }

    if (!this._isPlausibleAddress(to)) {
      throw new Error(`Invalid recipient address: ${this._maskEmail(to)}`);
    }

    if (!this.transporter) {
      this.logger.warn(`[mail dev no-op] to=${this._maskEmail(to)}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this._sanitizeHeader(this.from),
        to,
        subject: this._sanitizeHeader(subject),
        html,
        attachments,
      });
      this.logger.log({ to: this._maskEmail(to), status: "success" });
    } catch (err) {
      this.logger.error(
        `SMTP send xatosi (${this._maskEmail(to)}): ${(err as Error).message}`,
      );
      throw err;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Strip CR/LF from header values (defense-in-depth on top of the reject). */
  private _sanitizeHeader(s: string): string {
    return s.replace(/[\r\n]+/g, " ");
  }

  /** True when the value contains CR or LF — used to reject header injection. */
  private _hasCrlf(s: string): boolean {
    return /[\r\n]/.test(s ?? "");
  }

  private _isPlausibleAddress(s: string): boolean {
    if (!s || typeof s !== "string") return false;
    if (this._hasCrlf(s)) return false;
    // Simple sanity check: exactly one '@' with non-empty local + domain.
    const at = s.indexOf("@");
    return at > 0 && at < s.length - 1 && s.indexOf("@", at + 1) === -1;
  }

  /** Mask the recipient for log output: local@***. */
  private _maskEmail(addr: string): string {
    if (!addr || typeof addr !== "string") return "***";
    const at = addr.indexOf("@");
    if (at <= 0) return "***";
    return `${addr.slice(0, at)}@***`;
  }
}
