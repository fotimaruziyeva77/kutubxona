/**
 * Plan 05-08-fix FIX A — Shared ADMIN_NOTIFICATION_EMAILS CSV parser.
 *
 * Single source of truth for the env-CSV → validated recipient list pipeline.
 * Originally Plan 05-04 FIX C lived inside NotificationProcessor.sendEmail;
 * Plan 05-08 added a second consumer (AdminService._adminFallbackRecipients
 * for the monthly-report cron) which skipped validation entirely. We
 * consolidate both call sites here.
 *
 * Contract:
 *   - trim + lowercase each entry
 *   - drop empty entries
 *   - validate shape against EMAIL_REGEX; drop malformed with a warn() callback
 *   - cap at MAX_ADMIN_FALLBACK_RECIPIENTS (10) — log a warning if exceeded
 *
 * NotificationProcessor.sendEmail additionally writes an AiAuditLog row when
 * the fallback dispatches — that audit lives in the processor because it
 * fires on actual send, not on parse. Keeping audit there avoids
 * double-logging when AdminService enqueues a job that the processor then
 * resolves.
 */

// Simple RFC-5321-ish email shape check. Permissive on purpose — drop
// obviously malformed entries (bare strings, no '@') without rejecting
// legitimate addresses with '+' tags.
export const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Defense-in-depth cap. If ADMIN_NOTIFICATION_EMAILS is mis-configured with
 * a dumped 1000-address list, we silently fan out and burn SMTP quota. 10 is
 * comfortably above the real admin team size (Phase 5 admin set ≤ 5).
 */
export const MAX_ADMIN_FALLBACK_RECIPIENTS = 10;

export interface ParseAdminEmailsOptions {
  /**
   * Optional structured logger callback. NotificationProcessor passes its
   * Logger.warn so warnings flow into the standard log pipeline; AdminService
   * passes its Logger.warn likewise. Defaults to console.warn for callers
   * without a logger context.
   */
  warn?: (msg: string) => void;
}

/**
 * Parse the ADMIN_NOTIFICATION_EMAILS env CSV into a validated, capped list
 * of recipient addresses.
 *
 * Returns the empty array when the env is unset or every entry is malformed.
 * Callers should treat empty-array as "no fallback recipients" and skip the
 * dispatch.
 */
export function parseAdminFallbackEmails(
  csv: string | undefined,
  opts: ParseAdminEmailsOptions = {},
): string[] {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const raw = (csv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const validated: string[] = [];
  for (const addr of raw) {
    if (EMAIL_REGEX.test(addr)) {
      validated.push(addr);
    } else {
      warn(
        `[admin-email] dropping malformed ADMIN_NOTIFICATION_EMAILS entry: ${addr}`,
      );
    }
  }

  if (validated.length > MAX_ADMIN_FALLBACK_RECIPIENTS) {
    warn(
      `[admin-email] ADMIN_NOTIFICATION_EMAILS has ${validated.length} entries; truncating to ${MAX_ADMIN_FALLBACK_RECIPIENTS}`,
    );
    return validated.slice(0, MAX_ADMIN_FALLBACK_RECIPIENTS);
  }
  return validated;
}
