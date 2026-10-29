// ============================================================================
// H18 — Single source of truth for the backend origin + API prefix.
// ============================================================================
// CONTRACT (do not re-derive this anywhere else):
//
//   NEXT_PUBLIC_API_URL = the BARE backend origin the BROWSER should call.
//   No path, no trailing slash, no /api. Examples:
//     classic dev : http://localhost:4000   (NestJS default — see backend main.ts)
//     prod        : https://api.sifat.uz
//     "" (empty)  : RELATIVE mode — the browser calls its own origin and a
//                   same-origin reverse proxy (Next rewrites / nginx) forwards
//                   /api to the backend. This is what lets a SINGLE ngrok
//                   tunnel (to the frontend) serve the whole app.
//
//   The NestJS backend mounts EVERYTHING under the "api" global prefix
//   (apps/backend/src/main.ts: app.setGlobalPrefix("api")) — there is NO
//   /api/v1 versioning. Socket.IO handshakes at the bare origin with path "/ws".
//
// SERVER vs CLIENT (critical):
//   fetch() in a Server Component / RSC has NO page origin, so a relative URL
//   ("/api/...") throws "Failed to parse URL" and crashes the render (500).
//   Therefore on the SERVER we always resolve to an ABSOLUTE backend origin
//   (BACKEND_PROXY_TARGET, default http://localhost:4000) and hit the backend
//   directly — no proxy hop needed, the frontend server can reach it. On the
//   CLIENT we honor NEXT_PUBLIC_API_URL (absolute) or fall back to relative.
// ============================================================================

// NOTE: NEXT_PUBLIC_* must be referenced statically so Next inlines it into
// the client bundle at build time.
const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL;

if (
  !RAW_API_URL &&
  typeof window !== "undefined" &&
  process.env.NODE_ENV === "production"
) {
  // Prod browser bundle with no origin AND no same-origin proxy would silently
  // hit nothing. Surface it loudly. (Relative "" is allowed when a proxy fronts
  // the app — that is a deliberate deploy choice, so we only trip in the
  // browser where we cannot know the server topology.)
  // eslint-disable-next-line no-console
  console.error(
    "[lib/api/base] NEXT_PUBLIC_API_URL is empty in a production browser " +
      "bundle. API calls will be relative — ensure a reverse proxy forwards " +
      "/api to the backend, or set the bare backend origin."
  );
}

/** Strip trailing slashes ("http://x:4000/" → "http://x:4000"). */
function clean(s: string | undefined | null): string {
  return (s ?? "").replace(/\/+$/, "");
}

/**
 * SSR/RSC: fetch() needs an ABSOLUTE url. Hit the backend directly — same box
 * in dev, service DNS in prod. BACKEND_PROXY_TARGET (also used by the Next
 * rewrite in next.config.js) is the single knob; default localhost:4000.
 */
function serverOrigin(): string {
  return clean(
    process.env.BACKEND_PROXY_TARGET || RAW_API_URL || "http://localhost:4000"
  );
}

/**
 * Browser: honor NEXT_PUBLIC_API_URL. Empty → "" so apiBase() becomes the
 * RELATIVE "/api" and calls ride the current origin through the reverse proxy.
 */
function clientOrigin(): string {
  return clean(RAW_API_URL);
}

function resolveOrigin(): string {
  return typeof window === "undefined" ? serverOrigin() : clientOrigin();
}

if (
  process.env.NODE_ENV !== "production" &&
  /\/api(\/v\d+)?$/.test(clean(RAW_API_URL))
) {
  // eslint-disable-next-line no-console
  console.warn(
    `[lib/api/base] NEXT_PUBLIC_API_URL="${clean(RAW_API_URL)}" ends with an ` +
      "API prefix. It must be the bare backend origin; apiBase() appends /api."
  );
}

/**
 * Bare backend origin — use ONLY outside the REST prefix: Socket.IO handshakes
 * (path "/ws"), health checks, static assets. Server-absolute, client-relative.
 */
export function apiOrigin(): string {
  return resolveOrigin();
}

/**
 * Canonical REST base: `<origin>/api` (NestJS global prefix). Every HTTP
 * endpoint lives under this. Usage: `fetch(`${apiBase()}/top?limit=100`)`.
 */
export function apiBase(): string {
  return `${resolveOrigin()}/api`;
}

/**
 * Thin fetch wrapper that joins `path` onto apiBase(). Pass `init` through
 * untouched — callers decide about credentials/headers themselves (the axios
 * apiClient in ./client.ts remains the right tool for authed browser calls).
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${apiBase()}${suffix}`, init);
}
