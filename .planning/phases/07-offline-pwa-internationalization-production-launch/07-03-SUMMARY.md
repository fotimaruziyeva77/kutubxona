---
phase: 07-offline-pwa-internationalization-production-launch
plan: 03
subsystem: i18n, search
tags: [next-intl, elasticsearch, icu, karakalpak, russian, cyrillic, i18n]

requires:
  - phase: 07-01
    provides: "ES ICU analysis plugin in docker-compose, i18n foundation with 4 locale files"
provides:
  - "289-key synced locale files for uz-Latn, uz-Cyrl, kaa, ru"
  - "Build-time i18n key sync validator script"
  - "ES multi-script ICU analyzer for Cyrillic-Latin cross-script book search"
affects: [frontend-i18n, elasticsearch-search, ci-pipeline]

tech-stack:
  added: []
  patterns:
    - "i18n key sync validation at build time via scripts/i18n-key-check.ts"
    - "ES ICU Cyrillic-Latin transliteration via .cyrillic sub-fields on title/author"
    - "MERGED_ANALYSIS_SETTINGS deep-merge pattern for combining multiple ES analyzer configs"

key-files:
  created:
    - scripts/i18n-key-check.ts
    - apps/backend/src/infra/elasticsearch/__tests__/multi-script.spec.ts
  modified:
    - apps/backend/src/infra/elasticsearch/indices.ts
    - apps/backend/src/infra/elasticsearch/elasticsearch.service.ts

key-decisions:
  - "Used CJS require() in i18n-key-check.ts for ts-node CommonJS compatibility (avoids import.meta ESM issues)"
  - "Deep-merge helper mergeAnalysisSettings exports MERGED_ANALYSIS_SETTINGS combining Uzbek + multi-script analyzers rather than inline spreading"
  - "Added .cyrillic sub-fields only on title and author (the two text-searchable book fields) -- genre/lang/isbn are keyword fields that do not need transliteration"

patterns-established:
  - "i18n key sync check: uz-Latn.json is source of truth, all other locales must match key-for-key"
  - "ES multi-field pattern: main field uses uzbek_standard analyzer, .cyrillic sub-field uses multi_script analyzer with ICU Cyrillic-Latin transform"

requirements-completed: [I18N-01, I18N-02, I18N-03]

duration: 6min
completed: 2026-06-09
---

# Phase 7 Plan 3: I18N Locale Sync + ES Multi-Script Search Summary

**Build-time i18n key validator for 4 locale files (289 keys) and Elasticsearch ICU Cyrillic-Latin cross-script analyzer for book search**

## Performance

- **Duration:** 6 min
- **Started:** 2026-06-09T00:40:08Z
- **Completed:** 2026-06-09T00:46:08Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Verified all 4 locale files (uz-Latn, uz-Cyrl, kaa, ru) are fully synced with 289 translation keys including complete Karakalpak and Russian translations
- Created build-time i18n key sync checker that detects missing or extra keys across locale files
- Added ES multi-script analyzer with ICU Cyrillic-Latin transliteration enabling cross-script search (e.g., Cyrillic query matches Latin-indexed title)
- 5 unit tests for ES config objects all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Sync all 4 locale files + build-time key checker** - `9c7e6d9` (feat)
2. **Task 2: Elasticsearch ICU multi-script analyzer** - `3fe7650` (feat)

## Files Created/Modified
- `scripts/i18n-key-check.ts` - Build-time validator: reads all 4 JSON locale files, extracts key paths from uz-Latn (source of truth), reports missing/extra keys in other locales
- `apps/backend/src/infra/elasticsearch/indices.ts` - Added MULTI_SCRIPT_SETTINGS, MERGED_ANALYSIS_SETTINGS, .cyrillic sub-fields on title/author in BOOKS_INDEX_MAPPING
- `apps/backend/src/infra/elasticsearch/elasticsearch.service.ts` - Updated searchBooks multi_match fields to include title.cyrillic and author.cyrillic
- `apps/backend/src/infra/elasticsearch/__tests__/multi-script.spec.ts` - 5 unit tests validating ICU analyzer config, Cyrillic sub-fields, and merged settings

## Decisions Made
- Used CJS require() style in i18n-key-check.ts because ts-node defaults to CommonJS mode and import.meta.url is not available in CJS context
- Created MERGED_ANALYSIS_SETTINGS as a named export via mergeAnalysisSettings helper for clean deep-merge of Uzbek stop/stem filters with ICU multi-script filters
- .cyrillic sub-fields added only to text-searchable fields (title, author) -- keyword fields (genre, lang, isbn) do not need transliteration

## Deviations from Plan

None - plan executed exactly as written. All 4 locale files were already fully synced from prior work; the key checker confirmed 289 keys in sync.

## Issues Encountered
- ts-node treats scripts/i18n-key-check.ts as CJS by default (no "type": "module" in root package.json), so import.meta.url fails. Resolved by using CJS require() with TypeScript type annotations.
- process.exit() in ts-node causes stdout buffer to not flush. Resolved by using process.exitCode instead of process.exit() for the success path.

## User Setup Required

None - no external service configuration required. The ICU plugin is already configured in docker-compose via Plan 07-01.

## Next Phase Readiness
- All 4 UI languages fully translated and synced (uz-Latn, uz-Cyrl, kaa, ru)
- ES cross-script search ready for Cyrillic queries once ES is running with ICU plugin
- i18n key checker can be added to CI pipeline for drift prevention

---
*Phase: 07-offline-pwa-internationalization-production-launch*
*Completed: 2026-06-09*
