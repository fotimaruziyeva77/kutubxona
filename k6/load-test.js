/**
 * SIFAT LIBRARY — k6 Load Test
 *
 * Maqsad: 50,000 bir vaqtda foydalanuvchi simulatsiya
 * Muvaffaqiyat mezoni: p95 < 500ms, xato < 0.1%
 *
 * Ishga tushurish:
 *   k6 run k6/load-test.js --env BASE_URL=https://staging.sifat.uz
 *   k6 run k6/load-test.js --env BASE_URL=http://localhost:3000
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

// ── Sozlamalar ────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "https://staging.sifat.uz";
const API_URL = __ENV.API_URL || "https://api.staging.sifat.uz";

// Bosqichli yuklanish: 0 → 50K 10 daqiqada, 10 daqiqa ushlab turish, 5 daqiqada kamaytirish
export const options = {
  stages: [
    { duration: "2m",  target: 1000 },   // Isitish
    { duration: "5m",  target: 10000 },  // Bosqich 1
    { duration: "5m",  target: 30000 },  // Bosqich 2
    { duration: "3m",  target: 50000 },  // Bosqich 3 — maqsad
    { duration: "10m", target: 50000 },  // Barqaror yuklanish
    { duration: "5m",  target: 0 },      // Pasaytirish
  ],
  thresholds: {
    // SLA talablari
    http_req_duration: [
      "p(50)<150",   // p50 < 150ms
      "p(95)<500",   // p95 < 500ms
      "p(99)<1000",  // p99 < 1s
    ],
    http_req_failed: ["rate<0.001"],   // Xato < 0.1%

    // Endpoint bo'yicha
    "http_req_duration{name:landing}":     ["p(95)<300"],
    "http_req_duration{name:leaderboard}": ["p(95)<400"],
    "http_req_duration{name:search}":      ["p(95)<500"],
    "http_req_duration{name:stats}":       ["p(95)<600"],
  },
};

// ── Custom metrikalar ─────────────────────────────────────────────────────────

const searchDuration = new Trend("search_duration", true);
const errorRate      = new Rate("custom_errors");
const totalRequests  = new Counter("total_requests");

// ── Test ma'lumotlari ─────────────────────────────────────────────────────────

const SAMPLE_ISBNS = [
  "9789943452787", "9789943456785", "9789943452794",
  "9785040014262", "9789943452800",
];

const SEARCH_TERMS = [
  "Alpomish", "Navoiy", "O'tkan kunlar", "Sherlok Xolms",
  "Boburnoma", "Ulug'bek", "Abdulla Qodiriy",
];

// ── Asosiy test logikasi ──────────────────────────────────────────────────────

export default function () {
  const scenario = Math.random();

  if (scenario < 0.40) {
    // 40% — Anonim foydalanuvchi (landing, qidiruv, reyting)
    anonymousUserFlow();
  } else if (scenario < 0.65) {
    // 25% — Kitobxon (profil, kitob qidirish)
    readerFlow();
  } else if (scenario < 0.80) {
    // 15% — Statistika sahifalar
    statsFlow();
  } else if (scenario < 0.90) {
    // 10% — Top reytinglar
    topRatingsFlow();
  } else {
    // 10% — API qidiruv
    searchApiFlow();
  }

  sleep(Math.random() * 2 + 0.5); // 0.5–2.5 soniya pauza
}

// ── Ssenariylar ───────────────────────────────────────────────────────────────

function anonymousUserFlow() {
  group("Anonymous User", () => {
    // Landing page
    const r1 = http.get(`${BASE_URL}/uz-Latn`, {
      tags: { name: "landing" },
    });
    check(r1, {
      "landing: 200": (r) => r.status === 200,
      "landing: < 2s": (r) => r.timings.duration < 2000,
    }) || errorRate.add(1);
    totalRequests.add(1);

    sleep(1);

    // Top reytinglar
    const r2 = http.get(`${API_URL}/api/v1/top/leaderboard?limit=10`, {
      tags: { name: "leaderboard" },
    });
    check(r2, {
      "leaderboard: 200": (r) => r.status === 200,
    }) || errorRate.add(1);
    totalRequests.add(1);

    sleep(0.5);

    // Kitob qidiruv
    const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
    const t0 = Date.now();
    const r3 = http.get(
      `${API_URL}/api/v1/books/search?q=${encodeURIComponent(term)}&limit=10`,
      { tags: { name: "search" } }
    );
    searchDuration.add(Date.now() - t0);
    check(r3, {
      "search: 200": (r) => r.status === 200,
      "search: < 500ms": (r) => r.timings.duration < 500,
    }) || errorRate.add(1);
    totalRequests.add(1);
  });
}

function readerFlow() {
  group("Reader Flow", () => {
    // Profil sahifa (token kerak — simulatsiya uchun demo token)
    const headers = { Authorization: "Bearer demo-readonly-token" };

    const r1 = http.get(`${API_URL}/api/v1/reading/leaderboard?limit=50`, {
      tags: { name: "leaderboard" },
    });
    check(r1, { "reader leaderboard: ok": (r) => r.status === 200 });
    totalRequests.add(1);

    sleep(0.5);

    // ISBN lookup
    const isbn = SAMPLE_ISBNS[Math.floor(Math.random() * SAMPLE_ISBNS.length)];
    const r2 = http.get(`${API_URL}/api/v1/books/${isbn}`, {
      tags: { name: "book_detail" },
    });
    check(r2, { "book detail: not 500": (r) => r.status !== 500 });
    totalRequests.add(1);
  });
}

function statsFlow() {
  group("Stats Flow", () => {
    // Respublika statistika (ommaviy)
    const r1 = http.get(`${API_URL}/api/v1/stats/public`, {
      tags: { name: "stats" },
    });
    check(r1, {
      "public stats: 200": (r) => r.status === 200,
    }) || errorRate.add(1);
    totalRequests.add(1);

    sleep(1);

    // Viloyat statistika
    const r2 = http.get(`${API_URL}/api/v1/geo/viloyatlar`, {
      tags: { name: "stats" },
    });
    check(r2, { "viloyatlar: 200": (r) => r.status === 200 });
    totalRequests.add(1);
  });
}

function topRatingsFlow() {
  group("Top Ratings", () => {
    const endpoints = [
      "/api/v1/top/leaderboard?limit=20",
      "/api/v1/top/families?limit=20",
      "/api/v1/top/mahallas?limit=20",
    ];

    for (const ep of endpoints) {
      const r = http.get(`${API_URL}${ep}`, { tags: { name: "leaderboard" } });
      check(r, { "top: 200 or 304": (r) => r.status === 200 || r.status === 304 });
      totalRequests.add(1);
      sleep(0.3);
    }
  });
}

function searchApiFlow() {
  group("Search API", () => {
    const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];

    const t0 = Date.now();
    const r = http.get(
      `${API_URL}/api/v1/books/search?q=${encodeURIComponent(term)}&limit=20&offset=0`,
      { tags: { name: "search" } }
    );
    searchDuration.add(Date.now() - t0);

    check(r, {
      "search api: 200": (r) => r.status === 200,
      "search api: has results": (r) => {
        try {
          const body = JSON.parse(r.body as string);
          return Array.isArray(body?.data) || Array.isArray(body?.books);
        } catch {
          return false;
        }
      },
    }) || errorRate.add(1);
    totalRequests.add(1);
  });
}

// ── Umumiy yakuniy hisobot ────────────────────────────────────────────────────

export function handleSummary(data: Record<string, unknown>) {
  return {
    "k6/results.json": JSON.stringify(data, null, 2),
    stdout: generateSummaryText(data),
  };
}

function generateSummaryText(data: Record<string, unknown>): string {
  const metrics = data.metrics as Record<string, { values: Record<string, number> }>;
  const p50 = metrics?.http_req_duration?.values?.["p(50)"]?.toFixed(0) ?? "N/A";
  const p95 = metrics?.http_req_duration?.values?.["p(95)"]?.toFixed(0) ?? "N/A";
  const p99 = metrics?.http_req_duration?.values?.["p(99)"]?.toFixed(0) ?? "N/A";
  const failRate = (
    (metrics?.http_req_failed?.values?.rate ?? 0) * 100
  ).toFixed(3);
  const total = metrics?.total_requests?.values?.count ?? 0;

  return `
╔══════════════════════════════════════════════╗
║     SIFAT LIBRARY — Load Test Natijasi       ║
╠══════════════════════════════════════════════╣
║  Jami so'rovlar: ${String(total).padEnd(26)} ║
║  p50 javob vaqti: ${p50.padEnd(25)}ms ║
║  p95 javob vaqti: ${p95.padEnd(25)}ms ║
║  p99 javob vaqti: ${p99.padEnd(25)}ms ║
║  Xato darajasi: ${failRate.padEnd(27)}% ║
╠══════════════════════════════════════════════╣
║  SLA: p95<500ms=${Number(p95)<500?"✅ OK":"❌ FAIL"}   xato<0.1%=${Number(failRate)<0.1?"✅ OK":"❌ FAIL"}   ║
╚══════════════════════════════════════════════╝
`;
}
