"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// FIX: token-attaching apiClient (Bearer interceptor + 401→refresh→retry).
// Raw `axios` + withCredentials never authenticated these calls (access token
// is a Bearer header, not a cookie) → 401. apiClient.baseURL is `<origin>/api`,
// so paths are bare (API = "").
import { apiClient as axios } from "@/lib/api/client";
import { ComplianceGauge } from "@/components/charts/ComplianceGauge";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import {
  DashboardPage,
  PageHeader,
  StatGrid,
  StatCard,
  BarRow,
  RankMedal,
} from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { USER_STATUS_LABELS, label } from "@/lib/labels.const";

const API = "";

// ── Types ─────────────────────────────────────────────────────────────────────

type SchoolStats = {
  institutionId: string;
  name: string;
  students: { total: number; active: number; pending: number };
  coverageRate: number;
  avgRi: number;
  goalAchievement: { target: number; achieved: number; rate: number };
  activeClubs: number;
  monthlyTransactions: number;
  classBuckets: { class: string | null; count: number }[];
};

type Student = {
  id: string;
  name: string;
  sifatId: string | null;
  schoolClass: string | null;
  status: string;
  trustScore: number;
  latestRi: { score: number; calculatedAt: string } | null;
};

// Plan 06-02 SCH-01 — K-anon bucket shape from backend.
type ClassBucket = {
  className: string;
  total: number;
  pending: number;
  active: number;
  inactive: number;
  avgRi: number | null;
  kAnonymitySuppressed: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function riColor(score: number) {
  if (score >= 70) return "text-green-600 bg-green-50";
  if (score >= 50) return "text-yellow-600 bg-yellow-50";
  if (score >= 30) return "text-orange-600 bg-orange-50";
  return "text-red-600 bg-red-50";
}

// Plan 06-02 SCH-02 — Reject modal — collects reason (min 3 chars, max 500).
function RejectModal({
  isOpen,
  onClose,
  onConfirm,
  studentName,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  studentName: string;
}) {
  const t = useTranslations("SchoolPanel");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold text-slate-900 mb-2">{t("rejectModal.title")}</h3>
        <p className="text-sm text-slate-500 mb-4">
          <span className="font-medium">{studentName}</span> {t("rejectModal.desc")}
        </p>
        <textarea
          rows={4}
          value={reason}
          onChange={(e) => { setReason(e.target.value); setError(""); }}
          placeholder={t("rejectModal.reasonPlaceholder")}
          className="w-full border border-line-strong rounded-xl px-3 py-2 text-sm"
          maxLength={500}
        />
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        <div className="text-xs text-slate-400 mt-1 text-right">{reason.length} / 500</div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-700 rounded-lg hover:bg-surface-sunken"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => {
              if (reason.trim().length < 3) {
                setError(t("rejectModal.minError"));
                return;
              }
              onConfirm(reason.trim());
              setReason("");
            }}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            {t("reject")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SchoolDashboardPage() {
  const t = useTranslations("SchoolPanel");
  const [selectedInstitutionId, setSelectedInstitutionId] = useState<string | null>(null);
  const [classFilter, setClassFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // O'quvchilar ro'yxati uchun client-side pagination — ko'p o'quvchida
  // ro'yxat cho'zilib ketmasligi uchun (20 / 50 / 100 tanlanadi).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [tab, setTab] = useState<"overview" | "students" | "rankings">("overview");
  const [rejectingStudent, setRejectingStudent] = useState<Student | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");

  // Plan 04-01 audit-fix FIX 4: Phase 1 INFRA-02 cookie auth. The old
  // localStorage.getItem('access_token') flow was deprecated by Phase 1 and
  // returned 401 on every call in production. axios.withCredentials forwards
  // the HttpOnly refresh-token cookie + short-lived access token middleware.
  const qc = useQueryClient();
  const axiosCfg = { withCredentials: true } as const;

  // Institutions list
  const { data: institutions } = useQuery({
    queryKey: ["institutions", "MAKTAB"],
    queryFn: () =>
      axios.get(`${API}/school/institutions?type=MAKTAB&limit=100`, axiosCfg)
        .then((r) => r.data)
  });

  // School stats
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    refetch: refetchStats,
  } = useQuery<SchoolStats>({
    queryKey: ["school-stats", selectedInstitutionId],
    queryFn: () =>
      axios.get(`${API}/school/institutions/${selectedInstitutionId}/stats`, axiosCfg)
        .then((r) => r.data),
    enabled: !!selectedInstitutionId
  });

  // Plan 06-02 SCH-01 — students bucketed by class (K-anonymity applied).
  const { data: byClass } = useQuery<{ institutionId: string; buckets: ClassBucket[] }>({
    queryKey: ["school-by-class", selectedInstitutionId],
    queryFn: () =>
      axios.get(`${API}/school/institutions/${selectedInstitutionId}/students-by-class`, axiosCfg)
        .then((r) => r.data),
    enabled: !!selectedInstitutionId && tab === "overview"
  });

  // Students
  const { data: students } = useQuery({
    queryKey: ["school-students", selectedInstitutionId, classFilter, statusFilter],
    queryFn: () =>
      axios.get(`${API}/school/institutions/${selectedInstitutionId}/students`, {
        withCredentials: true,
        params: { class: classFilter || undefined, status: statusFilter || undefined }
      }).then((r) => r.data),
    enabled: !!selectedInstitutionId && tab === "students"
  });

  // Rankings
  const {
    data: rankings,
    isLoading: rankingsLoading,
    isError: rankingsError,
    refetch: refetchRankings,
  } = useQuery({
    queryKey: ["school-rankings"],
    queryFn: () =>
      axios.get(`${API}/school/rankings?limit=20`, axiosCfg).then((r) => r.data),
    enabled: tab === "rankings"
  });

  // Approve student
  const approveStudent = useMutation({
    mutationFn: (userId: string) =>
      axios.patch(
        `${API}/school/institutions/${selectedInstitutionId}/students/${userId}/approve`,
        {},
        axiosCfg
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["school-students"] });
      qc.invalidateQueries({ queryKey: ["school-stats"] });
      qc.invalidateQueries({ queryKey: ["school-by-class"] });
    }
  });

  // Plan 06-02 SCH-02 — Reject student with reason (sent as body { reason }).
  const rejectStudent = useMutation({
    mutationFn: ({ userId, reason }: { userId: string; reason: string }) =>
      axios.patch(
        `${API}/school/institutions/${selectedInstitutionId}/students/${userId}/reject`,
        { reason },
        axiosCfg
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["school-students"] });
      qc.invalidateQueries({ queryKey: ["school-stats"] });
      qc.invalidateQueries({ queryKey: ["school-by-class"] });
      setRejectingStudent(null);
    }
  });

  // PQ-9 PDF. Ilgari bu oddiy <a href> edi va IKKI sabab bilan ishlamasdi:
  //   1) href = "/school/..." — Next ilovasiga ketardi, backendga emas, ya'ni
  //      tugma 404 HTML sahifasini yuklab olardi;
  //   2) endpoint Bearer token talab qiladi, brauzer anchor esa faqat cookie
  //      yuboradi — token hech qachon ketmasdi.
  // Endi idora panelidagi kabi blob orqali yuklaymiz.
  const downloadPdf = async () => {
    if (!selectedInstitutionId || pdfBusy) return;
    setPdfBusy(true);
    setPdfError("");
    try {
      const r = await axios.get(
        `/school/institutions/${selectedInstitutionId}/pq9-report`,
        { responseType: "blob" },
      );
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pq9-maktab-${new Date().toISOString().slice(0, 7)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const res = (err as { response?: { status?: number; data?: Blob } })?.response;
      let msg = t("pdf.error");
      if (res?.status === 403) {
        msg = t("pdf.subscriptionRequired");
        try {
          msg = JSON.parse(await res.data!.text())?.message ?? msg;
        } catch {
          /* standart matn qoladi */
        }
      }
      setPdfError(msg);
    } finally {
      setPdfBusy(false);
    }
  };

  // Birinchi maktabni avtomatik tanlash — render ichida setState React
  // qoidasiga zid edi, effektga ko'chirildi.
  useEffect(() => {
    if (institutions?.data?.length > 0 && !selectedInstitutionId) {
      setSelectedInstitutionId(institutions.data[0].id);
    }
  }, [institutions, selectedInstitutionId]);

  // ── O'quvchilar pagination (client-side) ───────────────────────────────────
  const allStudents: Student[] = students?.data ?? [];
  const studentsTotal = allStudents.length;
  const sPageCount = Math.max(1, Math.ceil(studentsTotal / pageSize));
  const sSafePage = Math.min(page, sPageCount);
  const pagedStudents = allStudents.slice((sSafePage - 1) * pageSize, sSafePage * pageSize);
  const sFirst = studentsTotal === 0 ? 0 : (sSafePage - 1) * pageSize + 1;
  const sLast = Math.min(sSafePage * pageSize, studentsTotal);
  const sWinStart = Math.max(1, Math.min(sSafePage - 2, sPageCount - 4));
  const sWinEnd = Math.min(sPageCount, sWinStart + 4);
  const sPageNums: number[] = [];
  for (let p = sWinStart; p <= sWinEnd; p++) sPageNums.push(p);

  return (
    <DashboardPage>
      <PageHeader
        icon={Icon.school}
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          selectedInstitutionId ? (
            <button
              onClick={downloadPdf}
              disabled={pdfBusy}
              data-testid="pq9-download"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98] disabled:opacity-60"
            >
              <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
              {pdfBusy ? t("pdf.preparing") : t("pdf.button")}
            </button>
          ) : undefined
        }
      />

      {pdfError && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {pdfError}
        </p>
      )}

      {/* Institution selector */}
      <div className="card-surface rounded-2xl p-4">
        <label htmlFor="school-institution-select" className="text-sm font-medium text-slate-700 block mb-2">
          {t("selectSchool")}
        </label>
        <select
          id="school-institution-select"
          className="w-full max-w-md border border-line-strong rounded-xl px-3 py-2 text-sm"
          value={selectedInstitutionId ?? ""}
          onChange={(e) => { setSelectedInstitutionId(e.target.value || null); setPage(1); }}
        >
          <option value="">{t("selectSchoolPlaceholder")}</option>
          {institutions?.data?.map((inst: { id: string; name: string; code: string }) => (
            <option key={inst.id} value={inst.id}>
              {inst.name} ({inst.code})
            </option>
          ))}
        </select>
      </div>

      {!selectedInstitutionId && (
        <div className="flex flex-col items-center py-16 text-slate-400">
          <Icon.school aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} className="text-slate-300" />
          <p className="mt-4">{t("selectSchoolHint")}</p>
        </div>
      )}

      {selectedInstitutionId && (
        <>
          {/* Tabs */}
          <div className="flex gap-1 bg-surface-sunken p-1 rounded-xl w-fit">
            {(["overview", "students", "rankings"] as const).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  tab === tabKey ? "bg-white text-brand-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {t(`tabs.${tabKey}`)}
              </button>
            ))}
          </div>

          {/* ── Tab: Overview ───────────────────────────────────────────────── */}
          {tab === "overview" && (
            <>
              {statsLoading ? (
                <div className="flex justify-center py-12 text-brand-600">
                  <Spinner size="lg" label={t("overview.loading")} />
                </div>
              ) : statsError ? (
                <ErrorState
                  title={t("overview.errorTitle")}
                  message={t("overview.errorMessage")}
                  onRetry={() => refetchStats()}
                />
              ) : stats ? (
                <>
                  {/* KPI cards */}
                  <StatGrid cols={4}>
                    <StatCard
                      icon={Icon.school}
                      label={t("overview.totalStudents")}
                      value={stats.students.total.toLocaleString()}
                      sub={t("overview.activeCount", { count: stats.students.active })}
                      tone="blue"
                    />
                    <StatCard
                      icon={Icon.trendUp}
                      label={t("overview.coverage")}
                      value={`${stats.coverageRate}%`}
                      sub={t("overview.coverageSub")}
                      tone={stats.coverageRate >= 70 ? "green" : stats.coverageRate >= 40 ? "amber" : "rose"}
                    />
                    <StatCard
                      icon={Icon.index}
                      label={t("overview.avgRi")}
                      value={t("points", { value: stats.avgRi })}
                      sub={t("overview.avgRiSub")}
                      tone={stats.avgRi >= 70 ? "green" : stats.avgRi >= 40 ? "amber" : "rose"}
                    />
                    <StatCard
                      icon={Icon.target}
                      label={t("overview.goal20")}
                      value={t("overview.achievedPeople", { count: stats.goalAchievement.achieved })}
                      sub={t("overview.achievedRate", { rate: stats.goalAchievement.rate })}
                      tone="violet"
                    />
                  </StatGrid>

                  {/* Progress bars */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="card-surface rounded-2xl p-5">
                      <h3 className="font-semibold text-slate-800 mb-4">{t("overview.goalProgress")}</h3>
                      <div className="space-y-4">
                        <BarRow
                          label={t("overview.goal20Annual")}
                          value={`${stats.goalAchievement.rate}%`}
                          pct={
                            stats.students.active > 0
                              ? (stats.goalAchievement.achieved / stats.students.active) * 100
                              : 0
                          }
                        />
                        <BarRow
                          label={t("overview.studentCoverage")}
                          value={`${stats.coverageRate}%`}
                          pct={stats.coverageRate}
                          color={stats.coverageRate >= 70 ? "bg-green-500" : stats.coverageRate >= 40 ? "bg-yellow-500" : "bg-red-500"}
                        />
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div className="bg-brand-50 rounded-xl p-3 text-center">
                          <div className="text-xl font-bold text-brand-700">{stats.activeClubs}</div>
                          <div className="text-xs text-brand-600">{t("overview.activeClubs")}</div>
                        </div>
                        <div className="bg-surface-sunken rounded-xl p-3 text-center">
                          <div className="text-xl font-bold text-slate-700">{stats.monthlyTransactions}</div>
                          <div className="text-xs text-slate-500">{t("overview.monthlyTransactions")}</div>
                        </div>
                      </div>
                    </div>

                    {/* Plan 06-02 SCH-01 — Class buckets with K-anonymity suppression */}
                    <div className="card-surface rounded-2xl p-5">
                      <h3 className="font-semibold text-slate-800 mb-4">{t("overview.byClass")}</h3>
                      <div className="space-y-3 max-h-64 overflow-y-auto" data-testid="class-buckets">
                        {!byClass?.buckets?.length ? (
                          <p className="text-slate-400 text-sm text-center py-8">{t("overview.noClassData")}</p>
                        ) : (
                          byClass.buckets.map((c) => (
                            <div key={c.className} data-testid={`class-row-${c.className}`}>
                              <BarRow
                                label={t("overview.classLabel", { name: c.className })}
                                value={t("overview.studentCount", { count: c.total })}
                                pct={(c.total / Math.max(...byClass.buckets.map((x) => x.total), 1)) * 100}
                              />
                              <div className="mt-1 text-xs text-slate-500 text-right" data-testid={`class-avgri-${c.className}`}>
                                {c.kAnonymitySuppressed ? (
                                  <span title={t("overview.kAnonTitle")} className="text-slate-400">
                                    {t("overview.kAnonText")}
                                  </span>
                                ) : (
                                  <span title={t("riTitle")}>{t("overview.riValue", { value: c.avgRi ?? 0 })}</span>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  {/* PQ-9 status card */}
                  <PQ9StatusCard stats={stats} />
                </>
              ) : null}
            </>
          )}

          {/* ── Tab: Students ────────────────────────────────────────────────── */}
          {tab === "students" && (
            <div className="card-surface rounded-2xl overflow-x-auto">
              <div className="p-4 border-b border-line flex flex-wrap gap-3">
                <label htmlFor="school-class-filter" className="sr-only">{t("students.classFilterLabel")}</label>
                <input
                  id="school-class-filter"
                  type="text"
                  placeholder={t("students.classFilterPlaceholder")}
                  className="border border-line-strong rounded-xl px-3 py-2 text-sm w-48"
                  value={classFilter}
                  onChange={(e) => { setClassFilter(e.target.value); setPage(1); }}
                />
                <label htmlFor="school-status-filter" className="sr-only">{t("students.statusFilterLabel")}</label>
                <select
                  id="school-status-filter"
                  className="border border-line-strong rounded-xl px-3 py-2 text-sm"
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                >
                  <option value="">{t("students.allStatuses")}</option>
                  <option value="ACTIVE">{USER_STATUS_LABELS.ACTIVE}</option>
                  <option value="PENDING">{USER_STATUS_LABELS.PENDING}</option>
                  <option value="BLOCKED">{USER_STATUS_LABELS.BLOCKED}</option>
                </select>

                {/* Sahifa hajmi — 20 / 50 / 100 */}
                <div className="sm:ml-auto flex items-center gap-2">
                  <span className="text-xs text-slate-500">{t("students.perPage")}</span>
                  {[20, 50, 100].map((size) => (
                    <button
                      key={size}
                      onClick={() => { setPageSize(size); setPage(1); }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                        pageSize === size
                          ? "bg-brand-600 text-white"
                          : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>

              <table className="w-full text-sm">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("students.thName")}</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("students.thClass")}</th>
                    <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("students.thStatus")}</th>
                    <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("students.thRi")}</th>
                    <th className="text-right px-4 py-3 text-slate-600 font-medium">{t("students.thAction")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {pagedStudents.map((s: Student) => (
                    <tr key={s.id} className="hover:bg-surface-muted">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{s.name}</div>
                        <div className="text-xs text-slate-400">{s.sifatId ?? t("students.noId")}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{s.schoolClass ?? "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          s.status === "ACTIVE" ? "bg-green-100 text-green-700"
                          : s.status === "PENDING" ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                        }`}>
                          {label(USER_STATUS_LABELS, s.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {s.latestRi ? (
                          <span
                            title={t("riTitle")}
                            className={`px-2 py-0.5 rounded-lg text-xs font-bold ${riColor(s.latestRi.score)}`}
                          >
                            {t("points", { value: s.latestRi.score })}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">{t("students.notCalculated")}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {s.status === "PENDING" && (
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => approveStudent.mutate(s.id)}
                              data-testid={`approve-${s.id}`}
                              className="text-xs bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700"
                            >
                              {t("approve")}
                            </button>
                            <button
                              onClick={() => setRejectingStudent(s)}
                              data-testid={`reject-${s.id}`}
                              className="text-xs bg-red-600 text-white px-3 py-1 rounded-lg hover:bg-red-700"
                            >
                              {t("reject")}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {students && studentsTotal === 0 && (
                <div className="flex flex-col items-center py-12 text-slate-400">
                  <Icon.school aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} className="text-slate-300" />
                  <p className="mt-2">{t("students.empty")}</p>
                </div>
              )}

              {/* Pagination — sahifalarga bo'lish */}
              {sPageCount > 1 && (
                <div className="flex items-center justify-between gap-3 flex-wrap p-4 border-t border-line">
                  <span className="text-xs text-slate-500">
                    {t("students.pageInfo", { first: sFirst, last: sLast, total: studentsTotal })}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPage(Math.max(1, sSafePage - 1))}
                      disabled={sSafePage <= 1}
                      className="h-9 w-9 card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      aria-label={t("students.prevPage")}
                    >
                      ‹
                    </button>
                    {sWinStart > 1 && <span className="px-1 text-slate-400 text-sm">…</span>}
                    {sPageNums.map((p) => (
                      <button
                        key={p}
                        onClick={() => setPage(p)}
                        className={`h-9 min-w-9 px-3 rounded-xl text-sm font-medium transition-colors ${
                          p === sSafePage
                            ? "bg-brand-600 text-white"
                            : "bg-white border border-line text-slate-600 hover:bg-surface-muted"
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                    {sWinEnd < sPageCount && <span className="px-1 text-slate-400 text-sm">…</span>}
                    <button
                      onClick={() => setPage(Math.min(sPageCount, sSafePage + 1))}
                      disabled={sSafePage >= sPageCount}
                      className="h-9 w-9 card-surface rounded-xl text-slate-600 hover:bg-surface-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      aria-label={t("students.nextPage")}
                    >
                      ›
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Rankings ────────────────────────────────────────────────── */}
          {tab === "rankings" && (
            <div className="card-surface rounded-2xl overflow-x-auto">
              <div className="p-4 border-b border-line">
                <h3 className="flex items-center gap-2 font-semibold text-slate-800"><Icon.trophy aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-500" />{t("rankings.title")}</h3>
              </div>
              {rankingsLoading ? (
                <div className="flex justify-center py-12 text-brand-600">
                  <Spinner size="lg" label={t("rankings.loading")} />
                </div>
              ) : rankingsError ? (
                <div className="p-5">
                  <ErrorState
                    title={t("rankings.errorTitle")}
                    message={t("rankings.errorMessage")}
                    onRetry={() => refetchRankings()}
                  />
                </div>
              ) : !rankings || rankings.length === 0 ? (
                <div className="p-5">
                  <EmptyState
                    icon={Icon.trophy}
                    title={t("rankings.emptyTitle")}
                    description={t("rankings.emptyDesc")}
                  />
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium w-12">{t("rankings.thRank")}</th>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("rankings.thSchool")}</th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("rankings.thCoverage")}</th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">
                        <span title={t("rankings.avgRiTitle")}>{t("rankings.thAvgRi")}</span>
                      </th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("rankings.thClubActivity")}</th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("rankings.thTotal")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rankings.map((r: {
                      rank: number;
                      institution: { name: string };
                      coverageRate: number;
                      avgRi: number;
                      clubActivity: number;
                      totalScore: number;
                    }) => (
                      <tr key={r.rank} className={`hover:bg-surface-muted ${r.rank <= 3 ? "bg-yellow-50" : ""}`}>
                        <td className="px-4 py-3">
                          <div className="flex justify-center"><RankMedal rank={r.rank} /></div>
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">{r.institution?.name ?? "—"}</td>
                        <td className="px-4 py-3 text-center">{Math.round(r.coverageRate)}%</td>
                        <td className="px-4 py-3 text-center">{t("points", { value: r.avgRi })}</td>
                        <td className="px-4 py-3 text-center">{Math.round(r.clubActivity)}%</td>
                        <td className="px-4 py-3 text-center font-bold text-brand-700">{r.totalScore.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {/* Plan 06-02 SCH-02 — Reject modal portal */}
      <RejectModal
        isOpen={rejectingStudent !== null}
        onClose={() => setRejectingStudent(null)}
        onConfirm={(reason) => {
          if (rejectingStudent) rejectStudent.mutate({ userId: rejectingStudent.id, reason });
        }}
        studentName={rejectingStudent?.name ?? ""}
      />
    </DashboardPage>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

type PQ9Criterion = {
  // key — locale-dan mustaqil barqaror identifikator (data-testid uchun).
  key: string;
  label: string;
  value: number;
  threshold: number;
  unit: string;
  met: boolean;
};

function PQ9StatusCard({ stats }: { stats: SchoolStats }) {
  const t = useTranslations("SchoolPanel");
  const criteria: PQ9Criterion[] = [
    {
      key: "coverage",
      label: t("overview.studentCoverage"),
      value: stats.coverageRate,
      threshold: 50,
      unit: "%",
      met: stats.coverageRate >= 50,
    },
    {
      key: "avgRi",
      label: t("overview.avgRi"),
      value: stats.avgRi,
      threshold: 40,
      unit: t("pq9.unitPoints"),
      met: stats.avgRi >= 40,
    },
    {
      key: "goal20",
      label: t("overview.goal20"),
      value: stats.goalAchievement.rate,
      threshold: 20,
      unit: "%",
      met: stats.goalAchievement.rate >= 20,
    },
    {
      key: "club",
      label: t("pq9.clubCriterion"),
      value: stats.activeClubs,
      threshold: 1,
      unit: t("pq9.unitClub"),
      met: stats.activeClubs >= 1,
    },
  ];
  const passCount = criteria.filter((c) => c.met).length;
  const total = criteria.length;

  // Umumiy muvofiqlik bo'yicha yaxlit rang (gradient emas — token ranglar).
  const badgeClass =
    passCount === total
      ? "bg-emerald-600"
      : passCount >= total / 2
        ? "bg-amber-500"
        : "bg-rose-600";

  return (
    <div className="card-surface rounded-2xl p-6">
      {/* Header + summary badge */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Icon.shield aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
          </span>
          <h3 className="font-bold text-slate-900 leading-tight">{t("pq9.title")}</h3>
        </div>
        <span
          data-testid="pq9-summary-badge"
          className={`px-4 py-1.5 rounded-full text-sm font-bold text-white ${badgeClass} shadow-md whitespace-nowrap`}
        >
          {t("pq9.summary", { pass: passCount, total })}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-6 lg:gap-8 items-center">
        {/* Compliance gauge */}
        <div className="flex justify-center">
          <ComplianceGauge met={passCount} total={total} />
        </div>

        {/* Criteria progress rows */}
        <div className="space-y-3">
          {criteria.map((c) => {
            const fillPct = Math.min(Math.round((c.value / c.threshold) * 100), 100);
            return (
              <div
                key={c.key}
                data-testid={`pq9-criterion-${c.key}`}
                className="rounded-2xl border border-line bg-surface-muted/60 p-4"
              >
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-sm font-medium text-slate-700">{c.label}</span>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-bold inline-flex items-center gap-1 ${
                      c.met ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    {c.met
                      ? <><Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />{t("pq9.met")}</>
                      : <><Icon.close aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />{t("pq9.notMet")}</>}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-2.5 rounded-full bg-surface-sunken flex-1 overflow-hidden">
                    <div
                      className={`h-2.5 rounded-full transition-all duration-700 ease-out bg-gradient-to-r ${
                        c.met ? "from-emerald-500 to-teal-600" : "from-rose-500 to-red-600"
                      }`}
                      style={{ width: `${fillPct}%` }}
                    />
                  </div>
                  <span className="text-xs font-semibold text-slate-500 tabular-nums whitespace-nowrap w-24 text-right">
                    {c.value} / {c.threshold} {c.unit}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
