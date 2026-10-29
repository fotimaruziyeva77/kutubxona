import type { Metadata } from "next";
import { apiBase } from "@/lib/api/base";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

// Plan 06-03 FAM-05 — public family profile (Top-50 link target).
// SSR fetch; no auth required. Under-14 names masked server-side
// (maskNameIfMinor) before the response reaches the browser. Family name
// is HTML-escaped at the API boundary (defense-in-depth).

// H18: the old ":3000/api/v1" fallback pointed at the FRONTEND port with a
// versioned prefix the backend never served. apiBase() = `<origin>/api`.
const API_BASE = apiBase();

// M3 (AUDIT-REPORT): the API HTML-escapes family.name (&#39; &amp; &lt; …) for
// defense-in-depth. We must NOT re-inject it via dangerouslySetInnerHTML — a
// single backend escaping regression would become stored XSS on this public,
// SEO-indexed page. Instead decode the exact 5 entities escapeHtml emits back to
// plain text and let React escape on render (safe by construction). `&amp;` is
// decoded LAST to mirror the encoder's `&`-first order.
function decodeHtmlEntities(s: string): string {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

interface PublicMember {
  id: string;
  name: string; // already masked server-side if minor
  isMinor: boolean;
  avgRi: number;
}

interface PublicFamilyProfile {
  family: {
    id: string;
    name: string; // already HTML-escaped server-side
    avgRi: number;
    memberCount: number;
    viloyatId: string | null;
    tumanId: string | null;
  };
  members: PublicMember[];
}

async function fetchFamily(familyId: string): Promise<PublicFamilyProfile | null> {
  try {
    const res = await fetch(`${API_BASE}/family/${familyId}/profile`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ familyId: string }>;
}): Promise<Metadata> {
  const { familyId } = await params;
  const data = await fetchFamily(familyId);
  if (!data) return { title: "Oila topilmadi — SIFAT LIBRARY" };
  const title = `${decodeHtmlEntities(data.family.name)} — Oila profili`;
  const description = `${data.family.memberCount} a'zo · O'rtacha RI ${data.family.avgRi}`;
  return {
    title,
    description,
    openGraph: { title, description, type: "profile" },
    twitter: { card: "summary", title, description },
  };
}

export default async function PublicFamilyProfilePage({
  params,
}: {
  params: Promise<{ familyId: string; locale: string }>;
}) {
  const { familyId } = await params;
  const data = await fetchFamily(familyId);

  if (!data) {
    return (
      <main className="min-h-screen bg-surface-muted flex items-center justify-center p-8">
        <div className="text-center">
          <Icon.search aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-4 text-slate-300" />
          <p className="text-slate-500">Oila topilmadi</p>
        </div>
      </main>
    );
  }

  const { family, members } = data;
  // M3: render the family name as TEXT (decoded), never as injected HTML.
  return (
    <main className="min-h-screen bg-surface-muted py-10 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="card-surface rounded-2xl p-6">
          <h1 className="text-3xl font-bold text-slate-900">
            {decodeHtmlEntities(family.name)}
          </h1>
          <div className="grid grid-cols-2 gap-4 mt-6">
            <div className="text-center bg-blue-50 rounded-xl p-4">
              <div className="text-3xl font-bold text-brand-700">
                {family.avgRi.toFixed(1)}
              </div>
              <div className="text-xs text-slate-500">O&apos;rtacha RI</div>
            </div>
            <div className="text-center bg-purple-50 rounded-xl p-4">
              <div className="text-3xl font-bold text-purple-700">
                {family.memberCount}
              </div>
              <div className="text-xs text-slate-500">A&apos;zo</div>
            </div>
          </div>
        </div>

        {/* Members */}
        <div className="card-surface rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-line">
            <h2 className="font-semibold text-slate-900">A&apos;zolar</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between px-5 py-3"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {m.name}
                    {m.isMinor && (
                      <span className="ml-2 inline-flex items-center gap-1 text-[10px] bg-accent-100 text-accent-700 px-1.5 py-0.5 rounded">
                        <Icon.locked aria-hidden="true" size={12} />
                        14&lt; yosh
                      </span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-brand-700">
                    {m.avgRi.toFixed(1)}
                  </div>
                  <div className="text-[10px] text-slate-400">RI</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="flex items-center justify-center gap-1.5 text-xs text-slate-400 text-center">
          <Icon.locked aria-hidden="true" size={ICON_SIZE.xs} />
          14 yoshgacha a&apos;zolarning ismlari maxfiyligi himoyalanadi.
        </p>
      </div>
    </main>
  );
}
