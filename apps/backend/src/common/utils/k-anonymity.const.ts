/**
 * Plan 05-03-fix FIX B (SEC MEDIUM) — k-anonymity threshold for small-cell
 * suppression on demographic aggregates (gender / age buckets).
 *
 * Rationale: a bucket count of `1` deterministically re-identifies the
 * underlying user when combined with an obvious quasi-identifier (e.g.
 * "FEMALE in this mahalla"). The literature (Sweeney 2002, NIST SP 800-188)
 * treats k=5 as the minimum acceptable group size before publishing any
 * cell statistic; lower-bucket cells are suppressed (count → 0,
 * suppressed: true) before the response leaves the service boundary.
 *
 * Where this applies:
 *   - _fetchGenderBreakdown — MALE / FEMALE / UNKNOWN buckets
 *   - _fetchAgeBreakdown    — 7-14 / 15-30 / 31-60 / 60+ / unknown buckets
 *
 * Where this does NOT apply:
 *   - National/viloyat-level aggregates that span millions of users (no
 *     re-identification risk).
 *   - Counts that are already 0 (no suppression needed).
 *
 * The frontend reads `suppressed: true` to render "—" instead of a count,
 * preserving the bucket shape so chart axes don't shift between scopes.
 */
export const K_ANONYMITY_THRESHOLD = 5 as const;
