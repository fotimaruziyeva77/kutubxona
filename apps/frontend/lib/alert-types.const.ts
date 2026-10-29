/**
 * Plan 05-05 T3 — Frontend alert vocabulary.
 *
 * Mirrors backend `apps/backend/src/common/constants/alert-types.const.ts`.
 * Adds Uzbek labels + severity buckets for the dashboard alert filter
 * dropdown and alert badges. Centralizing here prevents the de-sync that
 * triggered the Plan 05-05 vocabulary cleanup (e.g. "INACTIVE_LIBRARY" vs
 * "LIBRARY_INACTIVE").
 */

export const ALERT_TYPES = {
  LIBRARY_INACTIVE: "LIBRARY_INACTIVE",
  RI_DROPPED: "RI_DROPPED",
  FUND_SHORTAGE: "FUND_SHORTAGE",
  CLUB_INACTIVE: "CLUB_INACTIVE",
  RI_RISING: "RI_RISING",
  SYSTEM_DOWN: "SYSTEM_DOWN",
  INVENTORY_DISCREPANCY: "INVENTORY_DISCREPANCY",
  ORDER_REQUEST: "ORDER_REQUEST",
} as const;

export type AlertType = (typeof ALERT_TYPES)[keyof typeof ALERT_TYPES];

export type AlertSeverityBucket = "KRITIK" | "OGOH" | "AXBOROT";

export const ALERT_TYPE_LABELS: Record<
  string,
  { uz: string; severity: AlertSeverityBucket }
> = {
  LIBRARY_INACTIVE: { uz: "Faolsiz kutubxona", severity: "KRITIK" },
  RI_DROPPED: { uz: "Reading Index pasaydi", severity: "OGOH" },
  FUND_SHORTAGE: { uz: "Fond yetishmovchiligi", severity: "OGOH" },
  CLUB_INACTIVE: { uz: "Klub faolsiz", severity: "OGOH" },
  RI_RISING: { uz: "Reading Index o'sdi", severity: "AXBOROT" },
  SYSTEM_DOWN: { uz: "Tizim ishlamayapti", severity: "KRITIK" },
  INVENTORY_DISCREPANCY: { uz: "Inventarizatsiya farqi", severity: "OGOH" },
  ORDER_REQUEST: { uz: "Buyurtma so'rovi", severity: "AXBOROT" },
};
