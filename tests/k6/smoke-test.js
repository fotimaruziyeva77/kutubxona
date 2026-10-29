/**
 * SIFAT LIBRARY — k6 Smoke Test (PERF-01)
 *
 * Quick sanity check with 10 VUs for 30 seconds.
 * Run before each deploy to verify API endpoints are responsive.
 *
 * Run via Docker:
 *   docker run --rm -i grafana/k6 run - < tests/k6/smoke-test.js
 *
 * With custom base URL:
 *   docker run --rm -i -e BASE_URL=http://dev.sifat.uz grafana/k6 run - < tests/k6/smoke-test.js
 *
 * WARNING: NEVER target production (sifat.uz) with load tests.
 * Always use localhost, dev.sifat.uz, or staging.sifat.uz.
 */

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";

export const options = {
  // 10 VUs for 30 seconds — lightweight sanity check
  vus: 10,
  duration: "30s",
  thresholds: {
    // Relaxed thresholds for smoke test
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.05"],
  },
};

/**
 * Default function — same 5 endpoints as load-test.js.
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
