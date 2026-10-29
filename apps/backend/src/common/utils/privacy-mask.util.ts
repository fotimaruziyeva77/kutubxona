/**
 * Plan 03-01 Task 1 — Underage-name anonymization (TOP-06 source of truth).
 *
 * Per CLAUDE.md §V.4: "14 yoshgacha bolalar ismlari (faqat `A.K.`, ...)".
 * Children aged ≤14 must NEVER have their full names appear in any public
 * ranking, donor list, leaderboard, or WebSocket broadcast.
 *
 * This is the SINGLE shared masker for the codebase. Consumed by:
 *   - 03-02 top.service.getTop100 / getDraftMonth (when exposed to non-SUPER admins)
 *   - 03-03 donate.service.getPublicDonors / getTopDonors
 *   - 03-04 StatsGateway.emitTop100Update (defense in depth at emit time)
 *
 * Design notes (per D-TOP-06):
 *   - Age uses Julian-year arithmetic (365.25 days) to match the existing
 *     pattern in top.service.ts:19 and badge service.
 *   - Boundary is **inclusive of age 14** ("14 yoshgacha" interpreted as
 *     "under or equal to 14"; the CLAUDE.md "12 yosh" example confirms
 *     this — anyone whose computed age floor is ≤14 must be masked).
 *   - Null name → `"—"` (em-dash placeholder; never raise — server-side
 *     formatter must not throw on JSON serialization).
 *   - Null dob → return name as-is. We have no minor signal, so the
 *     defensive policy is "trust the consumer's other guards"
 *     (top.service / donate.service still apply their own gates).
 *
 * No external deps. Pure function — safe to call from any layer.
 */

export function maskNameIfMinor(
  name: string | null | undefined,
  dob: Date | null | undefined,
): string {
  if (!name) {
    // Null name with or without dob — placeholder. Em-dash is the established
    // convention in top.service.ts:279 anonimize() fallback.
    return "—";
  }

  // Without dob we cannot determine minor status. Return name as-is; the
  // calling code is responsible for any orthogonal gates (status filter,
  // address suppression, etc.).
  if (!dob) {
    return name;
  }

  // Julian-year age calculation (matches existing codebase convention).
  const ageYears = Math.floor(
    (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
  );

  if (ageYears > 14) {
    return name;
  }

  // Minor — initial each non-empty part. Mirrors top.service.ts:279
  // `anonimize()` semantics, generalized to N parts.
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";

  return parts.map((p) => p[0].toUpperCase() + ".").join("");
}
