"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-current-user";

interface CourseBucket {
  course: number | null;
  count: number;
  avgRi: number | null;
  kAnonymitySuppressed: boolean;
}

interface MonthBucket {
  month: string;
  sampleSize: number;
  avgRi: number | null;
  kAnonymitySuppressed: boolean;
}

interface FacultyProgress {
  institution: { id: string; name: string };
  facultyName: string;
  studentCount: number;
  byCourse: CourseBucket[];
  byMonth: MonthBucket[];
}

interface Student {
  id: string;
  name: string;
  sifatId?: string;
  status: string;
  faculty?: string;
  studyCourse?: number;
  latestRi?: { score: number; calculatedAt: string } | null;
}

function RiBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-slate-400 text-xs">—</span>;
  const color = score >= 70 ? "bg-green-100 text-green-700" : score >= 50 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{score.toFixed(1)}</span>;
}

export default function FacultyDetailPage() {
  const t = useTranslations("OtmPanel.facultyPage");
  const params = useParams<{ facultyId: string }>();
  const facultyId = decodeURIComponent(params.facultyId);
  const { user } = useCurrentUser();
  const qc = useQueryClient();
  const institutionId: string =
    (user as any)?.universityId ?? (user as any)?.organizationId ?? "";

  // Plan 06-07 UNI-04 — faculty progress (aggregated).
  const progressQ = useQuery<FacultyProgress>({
    queryKey: ["otm-faculty-progress", institutionId, facultyId],
    queryFn: () =>
      api.get(`/otm/${institutionId}/faculties/${encodeURIComponent(facultyId)}/progress`).then((r: any) => r.data),
    enabled: !!institutionId && !!facultyId,
  });

  // Plan 06-07 UNI-01 — faculty-scoped student list (per-faculty approval queue).
  const studentsQ = useQuery<{ faculty: string; total: number; data: Student[] }>({
    queryKey: ["otm-faculty-students", institutionId, facultyId],
    queryFn: () =>
      api.get(`/otm/${institutionId}/faculties/${encodeURIComponent(facultyId)}/students`).then((r: any) => r.data),
    enabled: !!institutionId && !!facultyId,
  });

  const approveMut = useMutation({
    mutationFn: (userId: string) =>
      api.patch(`/otm/${institutionId}/students/${userId}/approve`).then((r: any) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["otm-faculty-students"] });
      qc.invalidateQueries({ queryKey: ["otm-faculty-progress"] });
      qc.invalidateQueries({ queryKey: ["otm-stats"] });
    },
  });

  const rejectMut = useMutation({
    mutationFn: (vars: { userId: string; reason: string }) =>
      api
        .patch(`/otm/${institutionId}/students/${vars.userId}/reject`, { reason: vars.reason })
        .then((r: any) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["otm-faculty-students"] });
    },
  });

  const handleReject = (userId: string) => {
    const reason = window.prompt(t("rejectReasonPrompt"));
    if (!reason || reason.trim().length < 3) return;
    rejectMut.mutate({ userId, reason: reason.trim() });
  };

  const progress = progressQ.data;
  const pendingStudents = (studentsQ.data?.data ?? []).filter((s) => s.status === "PENDING");
  const activeStudents = (studentsQ.data?.data ?? []).filter((s) => s.status === "ACTIVE");

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="mb-4">
        <Link href="/dashboard/otm" className="text-sm text-brand-600 hover:underline">
          ← {t("backToPanel")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-slate-800">{facultyId}</h1>
      {progress && (
        <p className="text-slate-500 text-sm mt-0.5">
          {progress.institution.name} · {t("studentCountLine", { count: progress.studentCount })}
        </p>
      )}

      {/* By course buckets */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <h2 className="font-semibold text-slate-700 mb-3">{t("courseDistribution")}</h2>
        {progressQ.isLoading ? (
          <div className="text-center py-8 text-slate-400">{t("loading")}</div>
        ) : (progress?.byCourse ?? []).length === 0 ? (
          <p className="text-slate-400 text-sm">{t("noData")}</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="pb-2">{t("course")}</th>
                <th className="pb-2">{t("students")}</th>
                <th className="pb-2">{t("avgRi")}</th>
              </tr>
            </thead>
            <tbody>
              {(progress?.byCourse ?? []).map((c) => (
                <tr key={String(c.course)} className="border-b last:border-0">
                  <td className="py-2">{t("courseN", { n: c.course ?? "—" })}</td>
                  <td className="py-2 font-medium">{c.count}</td>
                  <td className="py-2">
                    {c.kAnonymitySuppressed ? (
                      <span className="text-slate-400 text-xs" title={t("kAnonTooltip")}>—</span>
                    ) : (
                      <RiBadge score={c.avgRi} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="text-xs text-slate-400 mt-3">
          {t("kAnonNote")}
        </p>
      </div>

      {/* Monthly series */}
      {(progress?.byMonth ?? []).length > 0 && (
        <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
          <h2 className="font-semibold text-slate-700 mb-3">{t("monthlyDynamics")}</h2>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="pb-2">{t("month")}</th>
                <th className="pb-2">{t("students")}</th>
                <th className="pb-2">{t("avgRi")}</th>
              </tr>
            </thead>
            <tbody>
              {progress!.byMonth.map((m) => (
                <tr key={m.month} className="border-b last:border-0">
                  <td className="py-2">{m.month}</td>
                  <td className="py-2">{m.sampleSize}</td>
                  <td className="py-2">
                    {m.kAnonymitySuppressed ? (
                      <span className="text-slate-400 text-xs">—</span>
                    ) : (
                      <RiBadge score={m.avgRi} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* PENDING approval queue */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t("approvalQueue", { count: pendingStudents.length })}
        </h2>
        {pendingStudents.length === 0 ? (
          <p className="text-slate-400 text-sm">{t("noPending")}</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="pb-2">{t("name")}</th>
                <th className="pb-2">{t("course")}</th>
                <th className="pb-2">{t("action")}</th>
              </tr>
            </thead>
            <tbody>
              {pendingStudents.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-2">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-slate-400">{s.sifatId ?? "—"}</div>
                  </td>
                  <td className="py-2">{s.studyCourse ?? "—"}</td>
                  <td className="py-2 flex gap-2">
                    <button
                      onClick={() => approveMut.mutate(s.id)}
                      disabled={approveMut.isPending}
                      className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg"
                    >
                      {t("approve")}
                    </button>
                    <button
                      onClick={() => handleReject(s.id)}
                      disabled={rejectMut.isPending}
                      className="px-3 py-1 text-xs bg-red-600 text-white rounded-lg"
                    >
                      {t("reject")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Active students list */}
      <div className="bg-white rounded-xl border p-5 shadow-sm mt-6">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t("activeStudentsTitle", { count: activeStudents.length })}
        </h2>
        {activeStudents.length === 0 ? (
          <p className="text-slate-400 text-sm">{t("noActive")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">{t("name")}</th>
                  <th className="pb-2">{t("course")}</th>
                  <th className="pb-2">{t("ri")}</th>
                </tr>
              </thead>
              <tbody>
                {activeStudents.map((s) => (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-surface-muted">
                    <td className="py-2">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-slate-400">{s.sifatId ?? "—"}</div>
                    </td>
                    <td className="py-2">{s.studyCourse ?? "—"}</td>
                    <td className="py-2"><RiBadge score={s.latestRi?.score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
