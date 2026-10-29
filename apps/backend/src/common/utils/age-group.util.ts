/**
 * Plan 05-03 Task 1 (STAT-05 foundation) — shared age-group util.
 *
 * Promoted from `top.service.ts`'s inline `getAgeGroup(dob: Date)` (Phase 3)
 * because Plan 05-03 needs the same bucketing in `AdminService.getAgeBreakdown`.
 * Keeping a single source-of-truth prevents the "two slightly different
 * boundary semantics" drift that bit us in Phase 4 (penalty days).
 *
 * Buckets per CLAUDE.md §VI.2 (yosh guruhi taqsimoti):
 *   7-14    inclusive (school-age children — 14 still in school)
 *   15-30   inclusive (teens + young adults — university segment)
 *   31-60   inclusive (working-age adults)
 *   60+     open (retired segment)
 *   unknown DOB null / invalid / age < 7
 *
 * Timezone gotcha (per 05-RESEARCH §STAT-04/05): age boundaries shift
 * overnight. Backend cron timezone is locked to Asia/Tashkent (Phase 1
 * INFRA-05) so a 14-year-old at 23:59 Toshkent time becomes 15 at midnight
 * Toshkent time deterministically across replicas.
 *
 * Pure — no I/O. Caller may inject `referenceDate` for deterministic tests;
 * runtime defaults to `new Date()`.
 */

export type AgeGroup = "7-14" | "15-30" | "31-60" | "60+" | "unknown";

export function getAgeGroup(
  dob: Date | string | null | undefined,
  referenceDate?: Date,
): AgeGroup {
  if (dob === null || dob === undefined) return "unknown";
  const d = typeof dob === "string" ? new Date(dob) : dob;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "unknown";

  const ref = referenceDate ?? new Date();
  let age = ref.getFullYear() - d.getFullYear();
  const monthDelta = ref.getMonth() - d.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && ref.getDate() < d.getDate())) {
    age--;
  }

  if (age < 7) return "unknown";
  if (age <= 14) return "7-14";
  if (age <= 30) return "15-30";
  if (age <= 60) return "31-60";
  return "60+";
}
