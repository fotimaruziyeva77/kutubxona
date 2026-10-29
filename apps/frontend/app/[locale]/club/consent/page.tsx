/**
 * Plan 06-04 SCH-04 — Public ota-ona rozilik (parent consent) SSR page.
 *
 * URL: /uz-Latn/club/consent?t=<nonce>
 *
 * Server-side fetches /club/consent/info to render MINIMUM info per D-OQ-4:
 *   - child name
 *   - club name
 *   - leader name
 * NO school address, NO sibling names, NO phone numbers.
 *
 * Renders APPROVE / REJECT buttons that POST to /club/consent.
 * NO authentication — the bcrypt-hashed token is the only credential.
 */
import { ConsentForm } from "./ConsentForm";
import { apiBase } from "@/lib/api/base";

// H18: canonical `<origin>/api` base — the /api prefix lives in ONE place
// (lib/api/base.ts) instead of being re-appended at every callsite.
const API_BASE = apiBase();

type PageProps = {
  params: { locale: string };
  searchParams: { t?: string };
};

type ConsentInfo = {
  childName: string;
  clubName: string;
  leaderName: string;
};

async function fetchInfo(token: string): Promise<{ status: number; data: ConsentInfo | null }> {
  try {
    const res = await fetch(
      `${API_BASE}/club/consent/info?t=${encodeURIComponent(token)}`,
      { method: "GET", cache: "no-store" },
    );
    if (!res.ok) return { status: res.status, data: null };
    const data = (await res.json()) as ConsentInfo;
    return { status: res.status, data };
  } catch {
    return { status: 500, data: null };
  }
}

export default async function ConsentPage({ searchParams }: PageProps) {
  const token = (searchParams?.t ?? "").trim();

  if (!token) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold mb-3">Token topilmadi</h1>
        <p className="text-slate-600">
          Iltimos, SMS dagi havolani to&apos;liq oching.
        </p>
      </main>
    );
  }

  const { status, data } = await fetchInfo(token);

  if (status === 410) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold mb-3 text-orange-600">
          Havola muddati o&apos;tgan
        </h1>
        <p className="text-slate-600">
          Tasdiqlash uchun 48 soat berilgan edi. Klub rahbari bilan
          bog&apos;laning va yangi taklif yuborishni so&apos;rang.
        </p>
      </main>
    );
  }

  if (status === 404 || !data) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="text-xl font-semibold mb-3 text-red-600">
          Havola noto&apos;g&apos;ri yoki ishlatilgan
        </h1>
        <p className="text-slate-600">
          Bu tasdiqlash havolasi ilgari ishlatilgan, bekor qilingan yoki
          umuman mavjud emas.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold mb-3">Klubga taklif</h1>
      <p className="text-slate-700 mb-2">
        <strong>{data.childName}</strong> farzandingiz{" "}
        <strong>&quot;{data.clubName}&quot;</strong> klubiga taklif qilingan.
      </p>
      <p className="text-slate-600 mb-6">
        Klub rahbari: <strong>{data.leaderName}</strong>
      </p>

      <ConsentForm token={token} />
    </main>
  );
}
