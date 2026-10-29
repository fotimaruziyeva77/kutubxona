/**
 * SIFAT LIBRARY — Lighthouse CI Configuration (PERF-03)
 *
 * Run via: npx @lhci/cli autorun
 *
 * Assertions:
 *   - Performance: 90+ (error)
 *   - Accessibility: 90+ (error)
 *   - SEO: 95+ (error)
 *   - Best Practices: 85+ (warn)
 */
module.exports = {
  ci: {
    collect: {
      url: [
        "http://localhost:3000/uz-Latn",
        "http://localhost:3000/uz-Latn/top",
        "http://localhost:3000/uz-Latn/search",
      ],
      numberOfRuns: 3,
      startServerCommand: "npm run start -w apps/frontend",
      startServerReadyPattern: "ready on",
      startServerReadyTimeout: 30000,
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.9 }],
        "categories:seo": ["error", { minScore: 0.95 }],
        "categories:best-practices": ["warn", { minScore: 0.85 }],
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
