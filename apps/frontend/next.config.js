const path = require("path");
const withSerwist = require("@serwist/next").default({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Demo'da service worker O'CHIRILGAN. SW eski manifest/sahifa/API javoblarni
  // keshlab, /icons/icon-192.png 404 oqimi, soxta "offline" holat, qidiruv
  // natijalari osilib qolishi va kitob sahifasi ochilmasligiga sabab bo'lardi.
  // layout.tsx'dagi skript mavjud (eski) SW'ni unregister qilib keshni tozalaydi.
  disable: true,
});
const createNextIntlPlugin = require("next-intl/plugin");

// ── Build-time guard: refuse prod build with DEV-only OTP bypass ────────
// Dual-check: trip on either NEXT_PHASE=phase-production-build (set by
// `next build`) OR NODE_ENV=production (set by CI / Docker / deploy
// scripts that don't go through `next build` directly). Lint-like runs
// (`next lint`, dev phase) are explicitly exempted so dev workstations
// can keep NEXT_PUBLIC_DISABLE_OTP=true in .env.local without breaking
// `npm run lint`.
const isProdBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NODE_ENV === "production";
const isLintLikeRun =
  process.env.NEXT_PHASE === "phase-development-build" ||
  process.env.npm_lifecycle_event === "lint";
// Escape hatch for the LOCAL stable demo: a production build is dramatically
// more stable than `next dev` (no compile-on-demand SWC worker pool that OOM-
// crashes over long sessions). ALLOW_DEMO_OTP_BUILD=true downgrades the refusal
// to a warning so the single-tunnel demo can run `next start` WITH the dev OTP
// bypass. Real CI/deploy never sets this var, so the safety still holds there.
const allowDemoBuild = process.env.ALLOW_DEMO_OTP_BUILD === "true";
if (
  isProdBuild &&
  !isLintLikeRun &&
  process.env.NEXT_PUBLIC_DISABLE_OTP === "true"
) {
  if (allowDemoBuild) {
    console.warn(
      "[next.config] WARNING: production build with NEXT_PUBLIC_DISABLE_OTP=true " +
        "allowed via ALLOW_DEMO_OTP_BUILD=true — LOCAL DEMO ONLY, never deploy this bundle."
    );
  } else {
    throw new Error(
      "Build refused: NEXT_PUBLIC_DISABLE_OTP=true with NODE_ENV=production or NEXT_PHASE=phase-production-build. This flag is DEV ONLY."
    );
  }
}

const withNextIntl = createNextIntlPlugin("./i18n.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",

  // Demo production build barqarorligi uchun lintni build vaqtida o'tkazib
  // yuboramiz (TypeScript tekshiruvi saqlanadi — alohida `tsc --noEmit` bilan).
  // Lintni CI alohida ishlatadi; u build'ni bloklamasligi kerak.
  eslint: { ignoreDuringBuilds: true },

  // ── Security Headers ────────────────────────────────────────────────────
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(self)",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
        ],
      },
      // Statik aktivlar FAQAT productionda "immutable".
      //
      // NEGA SHART: prod build fayl nomiga kontent xeshini qo'yadi
      // (main-abc123.js), shuning uchun bir yillik kesh xavfsiz. DEV da esa
      // nomlar o'zgarmaydi (app/[locale]/layout.js), kontent esa har
      // tahrirda o'zgaradi — "immutable" brauzerga bu faylni boshqa
      // hech qachon so'ramaslikni aytadi. Natijada brauzer o'chirilgan
      // komponentli eski JS ni ushlab qoladi va sahifa "Cannot read
      // properties of undefined (reading 'call')" bilan yiqiladi, server
      // esa to'g'ri kod bersa ham. Shu sabab dev da kesh berilmaydi.
      ...(process.env.NODE_ENV === "production"
        ? [
            {
              source: "/_next/static/(.*)",
              headers: [
                {
                  key: "Cache-Control",
                  value: "public, max-age=31536000, immutable",
                },
              ],
            },
          ]
        : [
            {
              source: "/_next/static/(.*)",
              headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
            },
          ]),
    ];
  },

  // ── Image Optimization ─────────────────────────────────────────────────
  images: {
    domains: ["sifat.uz", "api.sifat.uz"],
    formats: ["image/avif", "image/webp"],
    // Next 14.2 Image Optimization API (/_next/image) uchun unauthenticated RCE/DoS
    // advisory'lari bor (GHSA-2xp9-vwfh-vxw4, GHSA-2464-fhr4-w9xw, GHSA-9g9p-9gw9-jx7f),
    // tuzatish faqat Next 15.5.28+/16 da. Loyihada next/image ishlatilmaydi —
    // optimizator o'chiriladi, nginx.prod.conf esa /_next/image ni 404 qaytaradi.
    // Next upgrade — PILOT-REJA 1-bosqich, alohida PR. audit-ci.jsonc ga qarang.
    unoptimized: true,
  },

  // ── Bundle Optimization ────────────────────────────────────────────────
  experimental: {
    optimizePackageImports: ["recharts", "@tanstack/react-query"],
    // Monorepo: standalone chiqish hoisted node_modules ni repo ildizidan izlasin
    // (apps/frontend/Dockerfile, D6). Aks holda standalone/ da modullar yetishmaydi.
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },


  // ── Redirects ─────────────────────────────────────────────────────────
  async redirects() {
    return [
      {
        source: "/top",
        destination: "/uz-Latn/top",
        permanent: false,
      },
      {
        source: "/donate",
        destination: "/uz-Latn/donate",
        permanent: false,
      },
    ];
  },

  // ── Dev reverse-proxy to the backend (single-tunnel ngrok demo) ─────────
  // With NEXT_PUBLIC_API_URL="" apiBase() resolves to the RELATIVE "/api",
  // so the browser calls <frontend-origin>/api/* and Next proxies it to the
  // local NestJS backend. This lets ONE ngrok tunnel (to :3000) serve the
  // whole app — no second tunnel and no CORS, since the hop to :4000 is
  // server-side. WebSocket (/ws) proxying through dev rewrites is best-effort;
  // live-stats push may be unavailable over the tunnel (pages still render).
  async rewrites() {
    const backend = process.env.BACKEND_PROXY_TARGET || "http://localhost:4000";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      { source: "/ws", destination: `${backend}/ws` },
      { source: "/ws/:path*", destination: `${backend}/ws/:path*` },
      { source: "/socket.io/:path*", destination: `${backend}/socket.io/:path*` },
    ];
  },
};

module.exports = withSerwist(withNextIntl(nextConfig));
