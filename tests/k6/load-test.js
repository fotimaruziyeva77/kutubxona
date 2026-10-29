/**
 * SIFAT LIBRARY — k6 Load Test (PERF-01)
 *
 * Simulates 5,000 concurrent virtual users (VUs) against critical API endpoints.
 * Validates that p95 response time stays under 200ms and error rate < 1%.
 *
 * Run via Docker:
 *   docker run --rm -i grafana/k6 run - < tests/k6/load-test.js
 *
 * With custom base URL:
 *   docker run --rm -i -e BASE_URL=http://staging.sifat.uz grafana/k6 run - < tests/k6/load-test.js
 *
 * With auth token for admin endpoints:
 *   docker run --rm -i -e BASE_URL=http://localhost:3001 -e AUTH_TOKEN=<jwt> grafana/k6 run - < tests/k6/load-test.js
 *
 * For 50K VU target, use distributed k6 (k6 Cloud or Kubernetes).
 * Single machine realistic limit: 5K VUs.
 *
 * WARNING: NEVER target production (sifat.uz) with load tests.
 * Always use localhost, dev.sifat.uz, or staging.sifat.uz.
 */

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";

export const options = {
  stages: [
    // Ramp up to 1,000 VUs over 2 minutes
    { duration: "2m", target: 1000 },
    // Hold at 5,000 VUs for 5 minutes (peak load)
    { duration: "5m", target: 5000 },
    // Ramp down over 2 minutes
    { duration: "2m", target: 0 },
  ],
  thresholds: {
    // 95th percentile response time must be under 200ms
    http_req_duration: ["p(95)<200"],
    // Error rate must be under 1%
    http_req_failed: ["rate<0.01"],
  },
};

/**
 * Default function — executed by each VU in a loop.
 * Tests 5 critical API endpoints in sequence:
 *   1. Landing stats (public, highest traffic)
 *   2. Leaderboard (public rankings)
 *   3. National stats (admin, requires auth)
 *   4. Book search (public)
 *   5. Library listing (public)
 */
export default function () {
  // 1. GET /api/landing/stats — public, most traffic
  const statsRes = http.get(`${BASE_URL}/api/landing/stats`);
  check(statsRes, {
    "landing/stats status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 2. GET /api/top/leaderboard — public rankings
  const leaderboardRes = http.get(
    `${BASE_URL}/api/top/leaderboard?type=MONTHLY&scope=NATIONAL&limit=10`
  );
  check(leaderboardRes, {
    "leaderboard status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 3. GET /api/stats/national — admin stats (requires Authorization)
  const headers = AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : {};
  const adminStatsRes = http.get(`${BASE_URL}/api/stats/national`, {
    headers,
  });
  check(adminStatsRes, {
    "stats/national status is 200 or 401": (r) =>
      r.status === 200 || r.status === 401,
  });
  sleep(1);

  // 4. GET /api/books/search — book search
  const searchRes = http.get(`${BASE_URL}/api/books/search?q=Alpomish`);
  check(searchRes, {
    "books/search status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 5. GET /api/libraries — library listing
  const librariesRes = http.get(
    `${BASE_URL}/api/libraries?page=1&limit=10`
  );
  check(librariesRes, {
    "libraries status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
