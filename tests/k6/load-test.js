/**
 * SIFAT LIBRARY — k6 Load Test (PERF-01)
 *
 * Simulates 5,000 concurrent virtual users (VUs) against critical API endpoints.
 * Validates that p95 response time stays under 200ms and error rate < 1%.
 *
 * Run via Docker (backend :4000 lokalda — `--network host`):
 *   docker run --rm -i --network host grafana/k6 run - < tests/k6/load-test.js
 *
 * With custom base URL:
 *   docker run --rm -i -e BASE_URL=https://staging.sifat.uz grafana/k6 run - < tests/k6/load-test.js
 *
 * With auth token for admin endpoints (SUPER_ADMIN yoki BUXGALTER JWT):
 *   docker run --rm -i --network host -e AUTH_TOKEN=<jwt> grafana/k6 run - < tests/k6/load-test.js
 *
 * Endpoint'lar smoke-test.js bilan bir xil (u yerda CI profili va rate-limit
 * izohi bor). Yuklama testi faqat staging'da: bitta IP'dan 5 000 VU uchun
 * backend THROTTLE_LIMIT ni oshirish yoki k6 ni ko'p mashinadan yurgizish kerak.
 *
 * For 50K VU target, use distributed k6 (k6 Cloud or Kubernetes).
 * Single machine realistic limit: 5K VUs.
 *
 * WARNING: NEVER target production (sifat.uz) with load tests.
 * Always use localhost, dev.sifat.uz, or staging.sifat.uz.
 */

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
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

  // 2. GET /api/top — public Top-100 rankings
  const topRes = http.get(`${BASE_URL}/api/top?limit=10`, {
    tags: { name: "GET /api/top" },
  });
  check(topRes, {
    "top status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 3. GET /api/admin/stats/national — SUPER_ADMIN / BUXGALTER (token bo'lsa 200,
  //    bo'lmasa 401 kutiladi — threshold'ga xato sifatida kirmaydi)
  const adminStatsRes = AUTH_TOKEN
    ? http.get(`${BASE_URL}/api/admin/stats/national`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
        tags: { name: "GET /api/admin/stats/national" },
      })
    : http.get(`${BASE_URL}/api/admin/stats/national`, {
        responseCallback: http.expectedStatuses(200, 401),
        tags: { name: "GET /api/admin/stats/national" },
      });
  check(adminStatsRes, {
    "admin/stats/national status is 200 (token) / 401 (tokensiz)": (r) =>
      AUTH_TOKEN ? r.status === 200 : r.status === 401,
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
