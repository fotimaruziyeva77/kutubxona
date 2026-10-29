/**
 * Plan 05-04 Task 2 — Single source of truth for HTML escaping.
 *
 * Consumers (PdfService.buildMonthlyReportHtml, NotificationProcessor.sendEmail
 * default body builder, future Plan 05-05 alert email shells, Plan 05-08 PDF
 * report email shells) MUST import from here. Do not duplicate the
 * implementation — see RESEARCH §NOTIF-03 + T-05-07 (email-header injection)
 * + T-05-10 (PDF injection).
 *
 * NOTE: not idempotent on `&` (escapeHtml(escapeHtml("&")) === "&amp;amp;").
 * Callers must escape EXACTLY ONCE at the source — do not chain.
 */
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
