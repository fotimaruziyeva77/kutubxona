// FIX (dashboard home auth) — the previous SSR prefetch of
// `/admin/stats/national` forwarded only the request `cookie` header. But the
// access token lives IN MEMORY (Zustand, H16) and is NEVER a cookie — only the
// HttpOnly *refresh* cookie (scoped to /api/auth) rides the request. So the
// server fetch had no Bearer token, the backend 401'd, `initialStats` was
// always null, and the stat cards rendered "—".
//
// Resolution: drop the server-side fetch entirely and render the existing
// client component. DashboardClient already fetches `/admin/stats/national`
// via the token-attaching fetch-wrapper apiClient (Authorization: Bearer +
// 401→refresh→retry), so the numbers populate on the client where the
// in-memory token actually exists. Passing `initialStats={null}` makes the
// client query the single source of truth.

import DashboardClient from "./DashboardClient";

export default function DashboardPage() {
  return <DashboardClient initialStats={null} />;
}
