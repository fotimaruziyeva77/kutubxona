// ============================================================================
// Serwist Service Worker Source — PWA-01
// ============================================================================
// Replaces the hand-written public/sw.js with a build-time precache manifest.
// @serwist/next injects __SW_MANIFEST at build, ensuring content-hashed cache
// keys and automatic invalidation on deploy.
//
// NOTE: This file is compiled by @serwist/next at build time in a WebWorker
// context (not by the regular tsc check). The triple-slash reference and
// ambient declarations below allow tsc --noEmit to pass for CI.
// ============================================================================

/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// ── M21: credentialed routes must NEVER be served from SW caches ────────────
// Private pages on shared kiosks (librarian phones, school computers) must
// not survive logout inside a cache another user can hit. These matchers run
// BEFORE defaultCache (Serwist routes match in registration order), forcing
// NetworkOnly for:
//   /dashboard/** /profile/** /scan/**   — protected subtrees
//   /family (exact)                      — management page; /family/[id] is
//                                          the PUBLIC Top-50 profile (FAM-05)
//                                          and stays cacheable
//   /dokon (exact), /dokon/*/dashboard   — operator home + store CRM;
//                                          /dokon/[slug] profile stays public
//   /api/**                              — every API response, any origin
// Mirror of the middleware gate list (middleware.ts PROTECTED_*). Locale
// prefix is optional in the pattern because next-intl serves every page as
// /<locale>/<path> (localePrefix: "always") while bare paths briefly hit the
// SW before the 307. Keep the locale alternation in sync with i18n.ts
// (NOT imported — i18n.ts pulls next-intl/server into the worker bundle).
const LOCALE_SEG = "(?:uz-Latn|uz-Cyrl|ru|kaa)";
const PRIVATE_PAGE_RE = new RegExp(
  `^/(?:${LOCALE_SEG}/)?(?:` +
    [
      "dashboard(?:/.*)?",
      "profile(?:/.*)?",
      "scan(?:/.*)?",
      "family/?",
      "dokon/?",
      "dokon/[^/]+/dashboard(?:/.*)?",
    ].join("|") +
    ")$"
);

const privateNetworkOnly: RuntimeCaching[] = [
  {
    // Private app pages (HTML navigations AND their RSC payload fetches —
    // both share the page pathname).
    matcher: ({ url, sameOrigin }) =>
      sameOrigin && PRIVATE_PAGE_RE.test(url.pathname),
    handler: new NetworkOnly(),
  },
  {
    // API responses: same-origin Next routes AND the cross-origin NestJS
    // backend — its global prefix is /api too, so a pathname check covers
    // both without hardcoding the origin.
    matcher: ({ url }) =>
      url.pathname === "/api" || url.pathname.startsWith("/api/"),
    handler: new NetworkOnly(),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Order matters: private NetworkOnly rules first, defaultCache (public
  // pages, static assets, fonts, images) as the fallback set.
  runtimeCaching: [...privateNetworkOnly, ...defaultCache],
});

serwist.addEventListeners();

// ── Background Sync: replay offline transactions ────────────────────────────
// Tag "sync-transactions" is registered by the Dexie-based sync module
// (apps/frontend/lib/offline/sync.ts — created in Plan 07-02).
// The dynamic import ensures the SW bundle does not fail if sync.ts is not
// yet present; the sync event handler is a no-op until Plan 07-02 ships.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag === "sync-transactions") {
    event.waitUntil(
      import("../lib/offline/sync")
        .then((m) => m.replayOfflineQueue())
        .catch(() => {
          // sync.ts not yet created (Plan 07-02) — no-op
        }),
    );
  }
}) as EventListener);
