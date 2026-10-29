---
phase: 08-bookstore-ecosystem
plan: 02
subsystem: store-search
status: done
tags: [store, search, elasticsearch, geo, SHOP-04, SHOP-07]
dependency_graph:
  requires: [08-01]
  provides: [searchStoreProducts, unified-book-search]
  affects: [books-service, store-service, elasticsearch-service]
tech_stack:
  added: []
  patterns: [geo_distance-sort, prisma-fallback, multi_match-fuzziness]
key_files:
  created:
    - apps/backend/src/modules/store/__tests__/store-search.spec.ts
  modified:
    - apps/backend/src/modules/store/store.service.ts
    - apps/backend/src/modules/store/store.controller.ts
    - apps/backend/src/infra/elasticsearch/elasticsearch.service.ts
    - apps/backend/src/modules/books/books.service.ts
    - apps/backend/src/modules/books/books.controller.ts
    - apps/backend/src/modules/books/books.module.ts
    - apps/backend/src/modules/books/__tests__/books.service.spec.ts
decisions:
  - "StoreProductSearchResult interface added for type-safe return values across ES and Prisma fallback paths"
  - "Store results capped at 5 per book search to avoid overwhelming library results"
  - "Pre-existing books.service.spec mock issue fixed inline (Rule 3 - blocking)"
metrics:
  duration_seconds: 475
  completed: 2026-06-09T05:06:00Z
  tasks_completed: 2
  tasks_total: 2
  files_changed: 8
requirements:
  - SHOP-04
  - SHOP-07
---

# Phase 8 Plan 02: Price-Aware Search Integration Summary

Store product search with geo_distance sorting, price/stock filters, and premium badge boost integrated into the book search pipeline. When readers search for books, they see library copies in `data[]` and nearby store listings with prices in `storeResults[]`.

## What was built

Added `searchStoreProducts` method to StoreService that queries Elasticsearch `sifat_store_products` index with full-text multi_match (title, author, isbn, storeName), geo_distance sort when lat/lon provided, price range filters, stock availability filter, and premium badge secondary sort. Prisma fallback ensures graceful degradation when ES is unavailable. Extended BooksService.search to include store results alongside library results -- store search failures are silently caught so library search never breaks. Added GET /store/products/search public endpoint with full @ApiQuery documentation.

## Files changed

- `apps/backend/src/modules/store/store.service.ts` -- Added searchStoreProducts + searchStoreProductsFallback methods, StoreProductSearchResult interface
- `apps/backend/src/modules/store/store.controller.ts` -- Added GET /store/products/search public endpoint with 10 @ApiQuery decorators
- `apps/backend/src/infra/elasticsearch/elasticsearch.service.ts` -- Added searchStoreProducts method for parameterized ES queries
- `apps/backend/src/modules/books/books.service.ts` -- Extended SearchBooksDto with lat/lon, injected StoreService, extended search to return storeResults[]
- `apps/backend/src/modules/books/books.controller.ts` -- Added @ApiQuery for lat/lon on GET /books/search
- `apps/backend/src/modules/books/books.module.ts` -- Added StoreModule import for DI
- `apps/backend/src/modules/books/__tests__/books.service.spec.ts` -- Added 4th constructor arg (StoreService mock), fixed pre-existing @nestjs/elasticsearch mock
- `apps/backend/src/modules/store/__tests__/store-search.spec.ts` -- New: 7 test cases covering ES query, geo sort, price filters, stock filter, premium boost, fallback

## Verification

- `npx jest --testPathPatterns="store-search"` -- 7/7 passed
- `npx jest --testPathPatterns="store"` -- 36/36 passed (29 existing + 7 new)
- `npx jest --testPathPatterns="books.service.spec"` -- 21/21 passed
- `npx tsc --noEmit` -- Only pre-existing ES type errors remain (ElasticsearchService wrapper)

## Key decisions

- StoreProductSearchResult interface unifies return types from ES path and Prisma fallback path
- Store results limited to 5 items per book search to keep library results primary
- Pre-existing books.service.spec failure fixed as Rule 3 deviation (blocking test infrastructure)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed pre-existing books.service.spec mock issue**
- **Found during:** Task 2
- **Issue:** books.service.spec.ts lacked jest.mock for @nestjs/elasticsearch, causing all 21 tests to fail before our changes
- **Fix:** Added jest.mock for @nestjs/elasticsearch and store.service to avoid transitive @elastic/elasticsearch resolution
- **Files modified:** apps/backend/src/modules/books/__tests__/books.service.spec.ts
- **Commit:** 5836c20

## Commits

| Hash | Message |
|------|---------|
| efb7f21 | feat(08-02): store product search with geo_distance sort + price/stock filters (SHOP-04, SHOP-07) |
| 5836c20 | feat(08-02): extend book search to include store results alongside library results (SHOP-04) |
