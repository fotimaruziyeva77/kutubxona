/**
 * Plan 05-01 Task 3 — ALERT_TYPES single source of truth (ALERT-01..06).
 *
 * The string-valued entries form the issueType vocabulary used across
 * the alert engines that Plan 05-05 consolidates into one (admin.service.ts
 * + audit.service.ts). Centralizing here keeps the vocabulary in one place
 * so consumers can import the AlertType union and the engines emit/dedupe
 * against the same set.
 *
 * Plan 05-01 seeded the original eight entries; later plans appended:
 *   - BOOK_CORNER_REMINDER (Plan 06-05 ORG-04, idora module)
 *   - ROOT_CAUSE_ANALYSIS  (Plan 07-04 AI-03, audit.service RCA trigger)
 *
 * Severity is exposed alongside as ALERT_SEVERITY — the three-bucket scheme
 * CLAUDE.md §VI.4 (Smart Alert) defines: KRITIK, OGOHLANTIRISH, AXBOROT.
 *
 * Consumed by:
 *   - Plan 05-05 audit.service.ts (consolidates the dual alert engines)
 *   - Plan 05-05 alert dedupe cache key (cache.service.ts alertDedupe)
 *   - Plan 05-04 notification.processor (push payload data.alertType)
 *   - Plan 03-01 fraud INVENTORY_DISCREPANCY regression guard (FRAUD-08)
 */

export const ALERT_TYPES = {
  /** Library has had 0 active borrowers for the configured window. */
  LIBRARY_INACTIVE: "LIBRARY_INACTIVE",
  /** Tuman/viloyat Reading Index dropped >= threshold over a rolling window. */
  RI_DROPPED: "RI_DROPPED",
  /** A title has >= N reservation requests but 0 in-stock copies. */
  FUND_SHORTAGE: "FUND_SHORTAGE",
  /** Jadidlar izidan klubi has had no debat events for >= N days. */
  CLUB_INACTIVE: "CLUB_INACTIVE",
  /** Tuman/viloyat Reading Index rose >= threshold (positive signal). */
  RI_RISING: "RI_RISING",
  /** Backend/health probe reported the system down. */
  SYSTEM_DOWN: "SYSTEM_DOWN",
  /** Tizim vs jismoniy fond farqi >= 5% (Plan 03-01 FRAUD-08 carry-over). */
  INVENTORY_DISCREPANCY: "INVENTORY_DISCREPANCY",
  /** Procurement/fund-shortage promoted to an order request to the admin. */
  ORDER_REQUEST: "ORDER_REQUEST",
  /** Plan 06-05 ORG-04 — Kitob burchagi 90+ kun yangilanmagan. */
  BOOK_CORNER_REMINDER: "BOOK_CORNER_REMINDER",
  /** Plan 07-04 AI-03 — RCA result logged for a tuman after an RI drop. */
  ROOT_CAUSE_ANALYSIS: "ROOT_CAUSE_ANALYSIS",
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

/**
 * Three-bucket severity per CLAUDE.md §VI.4 Smart Alert tizimi.
 * - KRITIK         — push + email + SMS, immediate
 * - OGOHLANTIRISH  — push + email
 * - AXBOROT        — weekly digest only
 */
export const ALERT_SEVERITY = {
  KRITIK: "KRITIK",
  OGOHLANTIRISH: "OGOHLANTIRISH",
  AXBOROT: "AXBOROT",
} as const;

export type AlertSeverity = (typeof ALERT_SEVERITY)[keyof typeof ALERT_SEVERITY];
