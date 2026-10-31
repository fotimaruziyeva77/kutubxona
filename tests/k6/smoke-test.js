/**
 * SIFAT LIBRARY — k6 Smoke Test (PERF-01)
 *
 * 5 ta asosiy API endpoint'ga yengil yuklama: p95 < 500 ms, xato < 5 %.
 * CI'da (`.github/workflows/ci.yml` → `e2e` job) seed DB bilan har PR'da,
 * keyin staging'da har deploy oldidan ishlatiladi.
 *
 * Lokal (backend :4000 ishlab turganda):
 *   docker run --rm -i --network host grafana/k6 run - < tests/k6/smoke-test.js
 *
 * Sozlamalar (env, hammasi ixtiyoriy):
 *   BASE_URL                    backend manzili (default http://localhost:4000)
 *   VUS / DURATION              yuklama profili (default 10 / 30s)
 *   ADMIN_PHONE + ADMIN_PASSWORD  setup() da BIR marta login → admin statistika
 *                               endpoint'i token bilan (200) tekshiriladi
 *   AUTH_TOKEN                  tayyor JWT (login o'rniga)
 *   Token bo'lmasa admin endpoint uchun 401 — KUTILGAN javob (threshold'ga
 *   xato sifatida kirmaydi).
 *
 * RATE-LIMIT: backend bitta IP'dan 100 so'rov/daqiqa (THROTTLE_LIMIT) bilan
 * cheklaydi, `landing/stats` esa route darajasida 60/daqiqa. k6 bitta IP'dan
 * uradi — shuning uchun CI'da backend THROTTLE_LIMIT=100000 bilan ko'tariladi
 * va 5 VU × 20 s profil ishlatiladi (landing/stats ≈ 20 so'rov → 60/daqiqa
 * chegarasidan pastda). 429 ko'rsangiz — profil katta yoki limit default.
 *
 * WARNING: NEVER target production (sifat.uz) with load tests.
 * Always use localhost, dev.sifat.uz, or staging.sifat.uz.
 */

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";

export const options = {
  vus: Number(__ENV.VUS) || 10,
  duration: __ENV.DURATION || "30s",
  thresholds: {
    // Relaxed thresholds for smoke test (load-test.js: p95 < 200 ms, < 1 %)
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.05"],
  },
};

/**
 * Bir marta (VU'lardan oldin): admin token.
 * Login endpoint'i 10 urinish/soat bilan cheklangan — faqat shu yerda, bir marta.
 */
export function setup() {
  if (__ENV.AUTH_TOKEN) return { token: __ENV.AUTH_TOKEN };
  if (__ENV.ADMIN_PHONE && __ENV.ADMIN_PASSWORD) {
    const res = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ phone: __ENV.ADMIN_PHONE, password: __ENV.ADMIN_PASSWORD }),
      { headers: { "Content-Type": "application/json" }, tags: { name: "POST /api/auth/login" } }
    );
    if (res.status !== 200) {
      throw new Error(`Admin login xato: ${res.status} ${res.body}`);
    }
    return { token: res.json("accessToken") };
  }
  return { token: "" };
}

/**
 * Default function — same 5 endpoints as load-test.js.
 * `tags.name` — k6 hisobotida endpoint bo'yicha guruhlash uchun.
 */
export default function (data) {
  // 1. GET /api/landing/stats — public, most traffic (route limit 60/min)
  const statsRes = http.get(`${BASE_URL}/api/landing/stats`, {
    tags: { name: "GET /api/landing/stats" },
  });
  check(statsRes, {
    "landing/stats status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 2. GET /api/top — public Top-100 (filter: month, gender, ageGroup, userType)
  const topRes = http.get(`${BASE_URL}/api/top?limit=10`, {
    tags: { name: "GET /api/top" },
  });
  check(topRes, {
    "top status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 3. GET /api/admin/stats/national — SUPER_ADMIN / BUXGALTER (token bo'lsa 200,
  //    bo'lmasa 401 kutiladi — expectedStatuses bilan xato hisoblanmaydi)
  const adminStatsRes = data.token
    ? http.get(`${BASE_URL}/api/admin/stats/national`, {
        headers: { Authorization: `Bearer ${data.token}` },
        tags: { name: "GET /api/admin/stats/national" },
      })
    : http.get(`${BASE_URL}/api/admin/stats/national`, {
        responseCallback: http.expectedStatuses(200, 401),
        tags: { name: "GET /api/admin/stats/national" },
      });
  check(adminStatsRes, {
    "admin/stats/national status is 200 (token) / 401 (tokensiz)": (r) =>
      data.token ? r.status === 200 : r.status === 401,
  });
  sleep(1);

  // 4. GET /api/books/search — book search (ES yoki Prisma fallback)
  const searchRes = http.get(`${BASE_URL}/api/books/search?q=Alpomish`, {
    tags: { name: "GET /api/books/search" },
  });
  check(searchRes, {
    "books/search status is 200": (r) => r.status === 200,
  });
  sleep(1);

  // 5. GET /api/libraries — library listing
  const librariesRes = http.get(`${BASE_URL}/api/libraries?page=1&limit=10`, {
    tags: { name: "GET /api/libraries" },
  });
  check(librariesRes, {
    "libraries status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
