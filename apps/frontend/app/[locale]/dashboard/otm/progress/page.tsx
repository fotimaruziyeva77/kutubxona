"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-current-user";

// Plan 06-07 UNI-04 — Student-self progress view. Calls GET /otm/me/progress
// which derives userId from the JWT (NEVER request params) — T-06-U5 mitigation.

interface MonthlyPoint {
  at: string;
  score: number;
}

interface SelfProgress {
  user: {
    id: string;
    name: string;
    sifatId: string | null;
    universityId: string | null;
    faculty: string | null;
    direction: string | null;
    studyCourse: number | null;
    status: string;
  };
  currentRi: number | null;
  monthlySeries: MonthlyPoint[];
  booksReadThisYear: number;
  clubMembershipCount: number;
}

function RiBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-slate-400 text-xs">—</span>;
  const color =
    score >= 70
      ? "bg-green-100 text-green-700"
      : score >= 50
      ? "bg-yellow-100 text-yellow-700"
      : "bg-red-100 text-red-700";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
      {score.toFixed(1)}
    </span>
  );
}

function MonthlyMiniChart({ series }: { series: MonthlyPoint[] }) {
  if (series.length === 0) {
    return <p className="text-sm text-slate-400">Hali RI ma'lumoti yo'q</p>;
  }
  const max = Math.max(100, ...series.map((p) => p.score));
  const min = Math.min(0, ...series.map((p) => p.score));
  const width = 600;
  const height = 120;
  const pad = 8;
  const stepX = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  const yFor = (s: number) =>
    height - pad - ((s - min) / (max - min || 1)) * (height - pad * 2);
  const points = series
    .map((p, i) => `${pad + i * stepX},${yFor(p.score)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32">
      <polyline
        points={points}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="2"
      />
      {series.map((p, i) => (
        <circle
          key={i}
          cx={pad + i * stepX}
          cy={yFor(p.score)}
          r="3"
          fill="#1e40af"
        />
      ))}
    </svg>
  );
}

export default function StudentProgressPage() {
  const { user } = useCurrentUser();

  const progressQ = useQuery<SelfProgress>({
    queryKey: ["otm-my-progress"],
    queryFn: () => api.get(`/otm/me/progress`).then((r: any) => r.data),
    enabled: !!user,
  });

  if (progressQ.isLoading) {
    return <div className="max-w-3xl mx-auto px-4 py-12 text-slate-400">Yuklanmoqda...</div>;
  }

  if (progressQ.isError) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-700">
          Bu sahifa faqat OTM talabalari uchun. Boshqa rolda kirgan bo'lsangiz,
          o'z paneliga o'ting.
        </div>
      </div>
    );
  }

  const p = progressQ.data;
  if (!p) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-800">Mening progressim</h1>
      <p className="text-slate-500 text-sm mt-0.5">
        {p.user.name} · {p.user.faculty ?? "Fakultet belgilanmagan"}
        {p.user.studyCourse ? ` · ${p.user.studyCourse}-kurs` : ""}
      </p>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        <div className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="text-xs text-slate-500">Joriy Reading Index</div>
          <div className="mt-2">
            <RiBadge score={p.currentRi} />
          </div>
        </div>
        <div className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="text-2xl font-bold text-brand-700">{p.booksReadThisYear}</div>
          <div className="text-xs text-slate-500 mt-1">Bu yili o'qilgan kitoblar</div>
        </div>
        <div className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="text-2xl font-bold text-green-600">{p.clubMembershipCount}</div>
          <div className="text-xs text-slate-500 mt-1">Klub a'zoligi</div>
        </div>
        <div className="bg-white rounded-xl border p-4 shadow-sm">
          <div className="text-xs text-slate-500">SIFAT ID</div>
          <div className="text-xs text-slate-700 mt-2 font-mono">{p.user.sifatId ?? "—"}</div>
        </div>
      </div>

      {/* 10 kitob progress */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <div className="flex justify-between text-sm mb-2">
          <span className="font-medium">10 kitob maqsadi (yillik)</span>
          <span className="text-slate-500">
            {Math.min(p.booksReadThisYear, 10)} / 10
          </span>
        </div>
        <div className="w-full h-3 bg-surface-sunken rounded-full">
          <div
            className="h-3 rounded-full transition-all bg-green-500"
            style={{
              width: `${Math.min((p.booksReadThisYear / 10) * 100, 100)}%`,
            }}
          />
        </div>
      </div>

      {/* Monthly RI chart */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <h2 className="font-semibold text-slate-700 mb-3">12 oylik Reading Index dinamikasi</h2>
        <MonthlyMiniChart series={p.monthlySeries} />
      </div>

      {/* Profile summary */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <h2 className="font-semibold text-slate-700 mb-3">Akademik ma'lumot</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500">Fakultet</dt>
            <dd className="font-medium">{p.user.faculty ?? "Belgilanmagan"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Yo'nalish</dt>
            <dd className="font-medium">{p.user.direction ?? "Belgilanmagan"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Kurs</dt>
            <dd className="font-medium">{p.user.studyCourse ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Status</dt>
            <dd className="font-medium">{p.user.status}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
