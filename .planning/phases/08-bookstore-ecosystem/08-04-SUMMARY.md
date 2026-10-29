---
phase: "08"
plan: "04"
subsystem: bookstore-frontend
status: done
tags: [store-profile, crm-dashboard, operator-home, leaflet, recharts]
dependency_graph:
  requires: [08-01, 08-02, 08-03]
  provides: [SHOP-03, SHOP-05, SHOP-06]
  affects: [dokon-pages, store-components, api-client]
tech_stack:
  added: []
  patterns: [dynamic-import-ssr-false, react-query-cascade, intl-numberformat]
key_files:
  created:
    - apps/frontend/lib/api/store.ts
    - apps/frontend/components/store/StoreProductCard.tsx
    - apps/frontend/components/store/StoreMap.tsx
    - apps/frontend/components/store/StoreMapInner.tsx
    - apps/frontend/components/store/CrmMetricCard.tsx
    - apps/frontend/components/store/MonthlySalesChart.tsx
    - apps/frontend/app/[locale]/dokon/[slug]/page.tsx
    - apps/frontend/app/[locale]/dokon/[slug]/dashboard/page.tsx
  modified:
    - apps/frontend/app/[locale]/dokon/page.tsx
decisions:
  - Leaflet split into StoreMap (wrapper with ssr:false dynamic import) and StoreMapInner (actual Leaflet rendering) to avoid SSR hydration issues
  - StoreMapInner uses unpkg CDN for marker icons (standard Leaflet fix for webpack asset path issues in Next.js)
  - Operator home uses organizationId as store slug lookup key (matches backend store-user association pattern)
metrics:
  duration: 7min
  completed: 2026-06-09
---

# Phase 8 Plan 04: Bookstore Frontend Pages Summary

Typed store API client with 4 functions (fetchStoreProfile, fetchStoreProducts, fetchStoreCrm, searchStoreProducts) plus 4 reusable components (StoreProductCard with Intl.NumberFormat price + Mavjud/Tugagan stock badges, StoreMap with Leaflet dynamic import, CrmMetricCard with change indicators, MonthlySalesChart with Recharts BarChart), public store profile page at /dokon/[slug] with map + working hours + product catalog, CRM dashboard at /dokon/[slug]/dashboard with 4 metric cards + sales chart + top books table, and updated operator home with store info card linking to profile and analytics.

## What was built

Complete bookstore frontend ecosystem: a typed API client layer, 4 reusable UI components, a public store profile page showing store info with Leaflet map and product catalog with search, a CRM analytics dashboard for store operators with customer metrics and sales charts, and an updated operator home page with store linking and fallback for unconnected stores.

## Task Execution

### Task 1: API client + reusable store components
- Created `lib/api/store.ts` with 4 typed API functions and 6 exported types
- Created `StoreProductCard` with price formatting (Intl.NumberFormat uz-UZ + so'm suffix), green "Mavjud" / red "Tugagan" stock badges, premium star badge
- Created `StoreMap` with dynamic import (ssr: false) wrapping `StoreMapInner` for Leaflet; null lat/lon renders "Xarita mavjud emas" placeholder
- Created `CrmMetricCard` with value, label, optional icon and change indicator with up/down arrows
- Created `MonthlySalesChart` with Recharts BarChart, "Jami" (gray) and "Tasdiqlangan" (blue) bars
- Commit: d20d0d3

### Task 2: Pages - store profile + CRM dashboard + operator home
- Created `/dokon/[slug]/page.tsx`: public store profile with header (premium gold border), StoreMap, working hours table (Uzbek day abbreviations), product grid (3/2/1 columns responsive), search filter, load-more pagination
- Created `/dokon/[slug]/dashboard/page.tsx`: CRM dashboard with auth guard (DOKON_OPERATOR/SUPER_ADMIN), 4 CrmMetricCards, MonthlySalesChart, top books table, conversion details (formatted duration + expired scans badge), loading skeleton
- Updated `/dokon/page.tsx`: added "Sizning do'koningiz" card above existing form with profile/analytics links, "Do'koningiz hali ulanmagan" fallback for operators without a store
- Commit: b6de550

### Task 3: Checkpoint (skipped per user instruction)

## Files Changed

- `apps/frontend/lib/api/store.ts` -- typed store API client with 4 functions and 6 types
- `apps/frontend/components/store/StoreProductCard.tsx` -- product card with price, stock badge, cover, premium badge
- `apps/frontend/components/store/StoreMap.tsx` -- Leaflet map wrapper with dynamic import (ssr: false)
- `apps/frontend/components/store/StoreMapInner.tsx` -- Leaflet MapContainer with marker and popup
- `apps/frontend/components/store/CrmMetricCard.tsx` -- dashboard metric card with change arrows
- `apps/frontend/components/store/MonthlySalesChart.tsx` -- Recharts BarChart with Jami/Tasdiqlangan bars
- `apps/frontend/app/[locale]/dokon/[slug]/page.tsx` -- public store profile page
- `apps/frontend/app/[locale]/dokon/[slug]/dashboard/page.tsx` -- CRM dashboard page
- `apps/frontend/app/[locale]/dokon/page.tsx` -- updated operator home with store card

## Verification

- TypeScript check (`npx tsc --noEmit`): PASSED (clean, no errors)
- All 9 files verified to exist on disk
- Both commits verified in git log

## Deviations from Plan

### Auto-added (Rule 2)

**1. [Rule 2 - Missing Component] StoreMapInner split from StoreMap**
- **Found during:** Task 1
- **Issue:** Leaflet requires browser-only execution; Next.js dynamic import with ssr:false needs a separate importable module
- **Fix:** Created StoreMapInner.tsx as the actual Leaflet rendering component, StoreMap.tsx as the wrapper with dynamic(() => import("./StoreMapInner"), { ssr: false })
- **Files created:** apps/frontend/components/store/StoreMapInner.tsx

## Key Decisions

- Leaflet map split into wrapper + inner component for clean SSR-safe dynamic import pattern
- Used unpkg CDN for Leaflet marker icons (standard Next.js workaround for webpack breaking default marker icon paths)
- Operator home fetches store profile using organizationId as slug (aligns with backend user-store association)
- Working hours rendered with Uzbek day abbreviations (Dush/Sesh/Chor/Pay/Jum/Shan/Yak)
- Task 3 checkpoint skipped per explicit user instruction

## Self-Check: PASSED

- All 9 created/modified files verified on disk
- Commit d20d0d3 verified in git log
- Commit b6de550 verified in git log
- TypeScript compilation clean
