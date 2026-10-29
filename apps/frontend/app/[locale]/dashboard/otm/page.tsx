"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { USER_STATUS_LABELS, label as enumLabel } from "@/lib/labels.const";
import {
  DashboardPage,
  PageHeader,
  Panel,
  StatGrid,
  StatCard,
  BarRow,
  RankMedal,
} from "@/components/dashboard/ui";
import { FormField, Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FacultyBucket {
  faculty: string;
  studentCount: number;
  avgRi: number | null;
  kAnonymitySuppressed: boolean;
}

interface CourseBucket {
  course: number | null;
  count: number;
  avgRi: number | null;
  kAnonymitySuppressed: boolean;
}

interface OtmStats {
  institutionId: string;
  name: string;
  students: { total: number; active: number; pending: number };
  coverageRate: number;
  avgRi: number;
  goalAchievement: { target: number; achieved: number; rate: number };
  activeClubs: number;
  monthlyTransactions: number;
  byFaculty: FacultyBucket[];
  byCourse: CourseBucket[];
  // Backward compat — old shape still present
  facultyBuckets?: Array<{ faculty: string | null; count: number }>;
  courseBuckets?: Array<{ course: string | null; count: number }>;
}

interface Student {
  id: string;
  name: string;
  phone?: string;
  sifatId?: string;
  status: string;
  faculty?: string;
  direction?: string;
  studyCourse?: number;
  latestRi?: { score: number; calculatedAt: string } | null;
}

interface ProfBook {
  id: string;
  title: string;
  author: string;
  genre?: string;
  isbn?: string;
  isRequired: boolean;
  description?: string;
}

// RiBadge lokal qoladi — shared faylga yangi komponent qo'shib bo'lmaydi.
function RiBadge({ score }: { score?: number | null }) {
  if (score == null) return <span className="text-slate-400 text-xs">—</span>;
  const color = score >= 70 ? "bg-green-100 text-green-700" : score >= 50 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>{score.toFixed(1)}</span>;
}

function AddProfBookForm({ institutionId, onDone }: { institutionId: string; onDone: () => void }) {
  const t = useTranslations("OtmPanel");
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: "", author: "", isbn: "", genre: "", description: "", isRequired: false });

  const mutation = useMutation({
    mutationFn: (data: typeof form) =>
      api.post(`/otm/${institutionId}/prof-books`, data).then((r: any) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["otm-prof-books", institutionId] });
      onDone();
    },
  });

  return (
    <div className="bg-surface-muted rounded-xl p-4 border border-line mt-4">
      <h4 className="font-semibold text-sm mb-3">{t("addBook.title")}</h4>
      <div className="grid grid-cols-2 gap-3">
        <FormField id="prof-book-title" label={t("bookTitle")} required className="col-span-2">
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={t("addBook.titlePlaceholder")}
          />
        </FormField>
        <FormField id="prof-book-author" label={t("author")} required>
          <Input
            value={form.author}
            onChange={(e) => setForm({ ...form, author: e.target.value })}
            placeholder={t("addBook.authorPlaceholder")}
          />
        </FormField>
        <FormField id="prof-book-isbn" label={t("isbn")}>
          <Input
            value={form.isbn}
            onChange={(e) => setForm({ ...form, isbn: e.target.value })}
            placeholder={t("addBook.isbnPlaceholder")}
          />
        </FormField>
        <FormField id="prof-book-genre" label={t("genre")}>
          <Input
            value={form.genre}
            onChange={(e) => setForm({ ...form, genre: e.target.value })}
            placeholder={t("addBook.genrePlaceholder")}
          />
        </FormField>
        <div className="flex items-center gap-2 pt-4">
          <input type="checkbox" id="prof-book-required" checked={form.isRequired}
            onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} />
          <label htmlFor="prof-book-required" className="text-sm">{t("addBook.requiredLabel")}</label>
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <button
          className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg disabled:opacity-50"
          disabled={!form.title || !form.author || mutation.isPending}
          onClick={() => mutation.mutate(form)}
        >
          {mutation.isPending ? t("addBook.saving") : t("addBook.save")}
        </button>
        <button className="px-4 py-2 text-sm border border-line rounded-lg" onClick={onDone}>{t("addBook.cancel")}</button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OtmDashboardPage() {
  // Fakultet havolasi [locale] segmentisiz edi — har bosishda 307 redirect
  // va foydalanuvchining tili uz-Latn ga qaytardi.
  const locale = useLocale();
  const t = useTranslations("OtmPanel");
  const { user } = useCurrentUser();
  const qc = useQueryClient();
  const isSuperAdmin = (user as any)?.role === "SUPER_ADMIN";

  // SUPER_ADMIN picks an OTM from a dropdown; everyone else resolves it from
  // their own link. (Plan 06-07 UNI-04 — OTM admins identify via universityId,
  // NOT organizationId which is idora; the org id is a historical fallback.)
  const ownInstitutionId: string =
    (user as any)?.universityId ?? (user as any)?.organizationId ?? "";
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");

  // GET /school/institutions?type=OTM is allowed for SUPER_ADMIN. Note: the DB
  // may currently hold zero OTM rows — the selector renders an empty state then.
  const otmListQ = useQuery<{ data: Array<{ id: string; name: string; code: string }>; total: number }>({
    queryKey: ["otm-institutions"],
    queryFn: () => api.get("/school/institutions?type=OTM&limit=100").then((r: any) => r.data),
    enabled: isSuperAdmin,
    // Har kirishda yangidan olamiz — yangi ro'yxatga olingan OTM darhol ko'rinsin
    // va eski bo'sh kesh "OTM topilmadi" deb adashtirmasin.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const otmInstitutions = useMemo(() => otmListQ.data?.data ?? [], [otmListQ.data]);

  // Bitta OTM bo'lsa avtomatik tanlash. (Render ichida setState React
  // anti-pattern edi — effektga ko'chirildi.)
  useEffect(() => {
    if (isSuperAdmin && !selectedInstitutionId && otmInstitutions.length === 1) {
      setSelectedInstitutionId(otmInstitutions[0].id);
    }
  }, [isSuperAdmin, selectedInstitutionId, otmInstitutions]);

  const institutionId: string = isSuperAdmin ? selectedInstitutionId : ownInstitutionId;
  const [tab, setTab] = useState<"stats" | "students" | "profbooks" | "rankings">("stats");
  const [studentPage, setStudentPage] = useState(0);
  const [showAddBook, setShowAddBook] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [pdfError, setPdfError] = useState("");

  const statsQ = useQuery<OtmStats>({
    queryKey: ["otm-stats", institutionId],
    queryFn: () => api.get(`/otm/${institutionId}/stats`).then((r: any) => r.data),
    enabled: !!institutionId,
  });

  const studentsQ = useQuery<{ data: Student[]; total: number }>({
    queryKey: ["otm-students", institutionId, studentPage, statusFilter],
    queryFn: () =>
      api.get(`/otm/${institutionId}/students`, {
        params: { limit: 50, offset: studentPage * 50, status: statusFilter || undefined },
      }).then((r: any) => r.data),
    enabled: !!institutionId && tab === "students",
  });

  const profBooksQ = useQuery<{ data: ProfBook[]; total: number }>({
    queryKey: ["otm-prof-books", institutionId],
    queryFn: () => api.get(`/otm/${institutionId}/prof-books`).then((r: any) => r.data),
    enabled: !!institutionId && tab === "profbooks",
  });

  const rankingsQ = useQuery({
    queryKey: ["otm-rankings"],
    queryFn: () => api.get("/otm/rankings?limit=50").then((r: any) => r.data),
    enabled: tab === "rankings",
  });

  // Plan 06-07 UNI-01 — PATCH route is canonical. We keep the legacy POST as
  // fallback (controller exposes both for backward-compat).
  const approveMut = useMutation({
    mutationFn: (userId: string) =>
      api.patch(`/otm/${institutionId}/students/${userId}/approve`).then((r: any) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["otm-students"] }),
  });

  // Plan 06-07 UNI-03 — subscription-aware download; the backend returns 403
  // if FROZEN. alert() o'rniga xabar inline ogohlantirish paneliga yoziladi.
  const downloadPdf = async () => {
    try {
      setPdfDownloading(true);
      setPdfError("");
      const res = await api.get(`/otm/${institutionId}/report/accreditation`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `otm-akkreditatsiya-${institutionId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setPdfError(
        err?.response?.status === 403
          ? t("pdfSubscriptionError")
          : t("pdfDownloadError")
      );
    } finally {
      setPdfDownloading(false);
    }
  };

  const stats = statsQ.data;
  const tabs = ["stats", "students", "profbooks", "rankings"] as const;
  const tabLabels: Record<typeof tab, string> = {
    stats: t("tabs.stats"),
    students: t("tabs.students"),
    profbooks: t("tabs.profbooks"),
    rankings: t("tabs.rankings"),
  };

  return (
    <DashboardPage>
      <PageHeader
        title={t("title")}
        subtitle={stats?.name ?? t("subtitle")}
        icon={Icon.university}
        action={
          <button
            onClick={downloadPdf}
            disabled={pdfDownloading || !institutionId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
            {pdfDownloading ? t("loading") : t("accreditationReport")}
          </button>
        }
      />

      {pdfError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-700"
        >
          <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
          <span>{pdfError}</span>
        </div>
      )}

      {/* SUPER_ADMIN OTM selector */}
      {isSuperAdmin && (
        <div className="border border-line rounded-xl px-4 py-3 bg-white">
          <label htmlFor="otm-institution-select" className="text-sm font-medium text-slate-700 block mb-2">
            {t("selectOtmLabel")}
          </label>
          <select
            id="otm-institution-select"
            className="w-full max-w-md border border-line rounded-lg px-3 py-2 text-sm bg-white"
            value={selectedInstitutionId}
            onChange={(e) => setSelectedInstitutionId(e.target.value)}
          >
            <option value="">{t("selectOtmOption")}</option>
            {otmInstitutions.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.name} ({inst.code})
              </option>
            ))}
          </select>
          {otmListQ.isLoading ? (
            <p className="text-xs text-slate-400 mt-2">{t("otmListLoading")}</p>
          ) : otmListQ.isError ? (
            <p className="text-xs text-red-500 mt-2">
              {t("otmListError")}{" "}
              <button onClick={() => otmListQ.refetch()} className="underline font-medium">
                {t("retry")}
              </button>
            </p>
          ) : otmInstitutions.length === 0 ? (
            <p className="text-xs text-slate-400 mt-2">
              {t("otmNotFound")}
            </p>
          ) : null}
        </div>
      )}

      {!institutionId ? (
        <EmptyState
          icon={Icon.university}
          title={isSuperAdmin ? t("noOtmSelectedTitle") : t("noOtmAssignedTitle")}
          description={
            isSuperAdmin
              ? t("noOtmSelectedDesc")
              : t("noOtmAssignedDesc")
          }
        />
      ) : (
      <>
      <div className="flex gap-2 overflow-x-auto border-b border-line pb-3">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium transition-colors ${
              tab === t ? "bg-brand-600 text-white" : "text-slate-600 hover:text-brand-600"
            }`}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {/* ── Stats Tab ── */}
      {tab === "stats" && (
        <div className="space-y-6">
          {statsQ.isLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : statsQ.isError ? (
            <ErrorState
              message={t("statsError")}
              onRetry={() => statsQ.refetch()}
              isRetrying={statsQ.isRefetching}
            />
          ) : stats ? (
            <>
              <StatGrid cols={4}>
                <StatCard icon={Icon.readers} label={t("totalStudents")} value={stats.students.total} />
                <StatCard icon={Icon.success} label={t("activeStudents")} value={stats.students.active} tone="green" />
                <StatCard icon={Icon.index} label={t("avgRi")} value={stats.avgRi} />
                <StatCard icon={Icon.target} label={t("coverageRate")} value={`${stats.coverageRate}%`} tone="amber" />
              </StatGrid>

              <Panel title={t("goalsTitle")} icon={Icon.target}>
                <div className="space-y-4">
                  <BarRow
                    label={t("studentCoverage")}
                    value={`${stats.coverageRate}%`}
                    pct={stats.coverageRate}
                  />
                  <BarRow
                    label={t("booksGoal")}
                    value={t("goalAchievedValue", { achieved: stats.goalAchievement.achieved, rate: stats.goalAchievement.rate })}
                    pct={stats.goalAchievement.rate}
                    color="bg-green-500"
                  />
                </div>
              </Panel>

              {/* Plan 06-07 UNI-02 — Faculty tree with K-anon badges */}
              <Panel title={t("byFacultyTitle")} icon={Icon.university}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-slate-500">
                        <th className="pb-2 font-medium">{t("faculty")}</th>
                        <th className="pb-2 font-medium">{t("students")}</th>
                        <th className="pb-2 font-medium">{t("avgRi")}</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stats.byFaculty ?? []).length === 0 ? (
                        <tr><td colSpan={4} className="py-4 text-center text-slate-400">{t("noFacultyData")}</td></tr>
                      ) : (stats.byFaculty ?? []).map((f) => (
                        <tr key={f.faculty} className="border-b border-line last:border-0 hover:bg-surface-muted">
                          <td className="py-2 font-medium">{f.faculty}</td>
                          <td className="py-2">{f.studentCount}</td>
                          <td className="py-2">
                            {f.kAnonymitySuppressed ? (
                              <span className="text-slate-400 text-xs" title={t("kAnonTooltip")}>—</span>
                            ) : (
                              <RiBadge score={f.avgRi} />
                            )}
                          </td>
                          <td className="py-2 text-right">
                            <Link
                              href={`/${locale}/dashboard/otm/faculty/${encodeURIComponent(f.faculty)}`}
                              className="inline-flex items-center gap-0.5 text-xs text-brand-600 hover:underline"
                            >
                              {t("details")}
                              <Icon.next aria-hidden="true" size={ICON_SIZE.xs} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {/* By course (1..4) */}
              {(stats.byCourse ?? []).length > 0 && (
                <Panel title={t("byCourseTitle")} icon={Icon.school}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-slate-500">
                          <th className="pb-2 font-medium">{t("course")}</th>
                          <th className="pb-2 font-medium">{t("students")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(stats.byCourse ?? []).map((c, i) => (
                          <tr key={i} className="border-b border-line last:border-0">
                            <td className="py-2">{t("courseN", { n: c.course ?? "—" })}</td>
                            <td className="py-2 font-medium">{c.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </>
          ) : (
            <EmptyState
              icon={Icon.stats}
              title={t("noStatsTitle")}
              description={t("noStatsDesc")}
            />
          )}
        </div>
      )}

      {/* ── Students Tab ── */}
      {tab === "students" && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <div>
              <label htmlFor="otm-status-filter" className="sr-only">{t("statusFilterLabel")}</label>
              <select
                id="otm-status-filter"
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setStudentPage(0); }}
                className="border border-line rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="">{t("allStatuses")}</option>
                <option value="ACTIVE">{t("statusActive")}</option>
                <option value="PENDING">{t("statusPending")}</option>
                <option value="BLOCKED">{t("statusBlocked")}</option>
              </select>
            </div>
          </div>

          {studentsQ.isLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : studentsQ.isError ? (
            <ErrorState
              message={t("studentsError")}
              onRetry={() => studentsQ.refetch()}
              isRetrying={studentsQ.isRefetching}
            />
          ) : (studentsQ.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={Icon.readers}
              title={statusFilter ? t("noStudentsFilteredTitle") : t("noStudentsTitle")}
              description={
                statusFilter
                  ? t("noStudentsFilteredDesc")
                  : t("noStudentsDesc")
              }
            />
          ) : (
            <div className="bg-white rounded-xl border border-line shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-muted text-left text-slate-500">
                    <th className="px-4 py-3 font-medium">{t("name")}</th>
                    <th className="px-4 py-3 font-medium">{t("faculty")}</th>
                    <th className="px-4 py-3 font-medium">{t("course")}</th>
                    <th className="px-4 py-3 font-medium">{t("status")}</th>
                    <th className="px-4 py-3 font-medium">{t("ri")}</th>
                    <th className="px-4 py-3 font-medium">{t("action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(studentsQ.data?.data ?? []).map((s) => (
                    <tr key={s.id} className="border-b border-line last:border-0 hover:bg-surface-muted">
                      <td className="px-4 py-3">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-slate-400">{s.sifatId}</div>
                      </td>
                      <td className="px-4 py-3">{s.faculty ?? "—"}</td>
                      <td className="px-4 py-3">{s.studyCourse ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          s.status === "ACTIVE" ? "bg-green-100 text-green-700" :
                          s.status === "PENDING" ? "bg-yellow-100 text-yellow-700" :
                          "bg-red-100 text-red-700"
                        }`}>{enumLabel(USER_STATUS_LABELS, s.status)}</span>
                      </td>
                      <td className="px-4 py-3"><RiBadge score={s.latestRi?.score} /></td>
                      <td className="px-4 py-3">
                        {s.status === "PENDING" && (
                          <button
                            onClick={() => approveMut.mutate(s.id)}
                            disabled={approveMut.isPending}
                            className="text-xs px-3 py-1 bg-green-600 text-white rounded-lg disabled:opacity-50"
                          >
                            {t("approve")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="px-4 py-3 border-t border-line flex items-center justify-between text-sm text-slate-500">
                <span>{t("totalCount", { count: studentsQ.data?.total ?? 0 })}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setStudentPage((p) => Math.max(0, p - 1))}
                    disabled={studentPage === 0}
                    aria-label={t("prevPage")}
                    className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  >
                    <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="rotate-180" />
                  </button>
                  <span>{studentPage + 1}</span>
                  <button
                    onClick={() => setStudentPage((p) => p + 1)}
                    disabled={(studentPage + 1) * 50 >= (studentsQ.data?.total ?? 0)}
                    aria-label={t("nextPage")}
                    className="px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  >
                    <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Prof Books Tab ── */}
      {tab === "profbooks" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-slate-700">
              {t("profBooksCount", { count: profBooksQ.data?.total ?? 0 })}
            </h3>
            <button
              onClick={() => setShowAddBook((v) => !v)}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm"
            >
              {t("addButton")}
            </button>
          </div>

          {showAddBook && (
            <AddProfBookForm institutionId={institutionId} onDone={() => setShowAddBook(false)} />
          )}

          {profBooksQ.isLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : (
            <div className="bg-white rounded-xl border border-line shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-muted text-left text-slate-500">
                    <th className="px-4 py-3 font-medium">{t("bookTitle")}</th>
                    <th className="px-4 py-3 font-medium">{t("author")}</th>
                    <th className="px-4 py-3 font-medium">{t("genre")}</th>
                    <th className="px-4 py-3 font-medium">{t("isbn")}</th>
                    <th className="px-4 py-3 font-medium">{t("required")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(profBooksQ.data?.data ?? []).map((b) => (
                    <tr key={b.id} className="border-b border-line last:border-0 hover:bg-surface-muted">
                      <td className="px-4 py-3 font-medium">{b.title}</td>
                      <td className="px-4 py-3">{b.author}</td>
                      <td className="px-4 py-3">{b.genre ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{b.isbn ?? "—"}</td>
                      <td className="px-4 py-3">
                        {b.isRequired ? (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">{t("yes")}</span>
                        ) : (
                          <span className="text-xs text-slate-400">{t("no")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {(profBooksQ.data?.data ?? []).length === 0 && (
                    <tr><td colSpan={5} className="py-8 text-center text-slate-400">{t("noProfBooks")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Rankings Tab ── */}
      {tab === "rankings" && (
        <div className="space-y-4">
          <h3 className="font-semibold text-slate-700">{t("rankingsTitle")}</h3>
          {rankingsQ.isLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : rankingsQ.isError ? (
            <ErrorState
              message={t("rankingsError")}
              onRetry={() => rankingsQ.refetch()}
              isRetrying={rankingsQ.isRefetching}
            />
          ) : (rankingsQ.data ?? []).length === 0 ? (
            <EmptyState
              icon={Icon.trophy}
              title={t("noRankingsTitle")}
              description={t("noRankingsDesc")}
            />
          ) : (
            <div className="bg-white rounded-xl border border-line shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-muted text-left text-slate-500">
                    <th className="px-4 py-3 font-medium">{t("rank")}</th>
                    <th className="px-4 py-3 font-medium">{t("otmCol")}</th>
                    <th className="px-4 py-3 font-medium">{t("score")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(rankingsQ.data ?? []).map((r: any, i: number) => (
                    <tr key={r.institutionId} className={`border-b border-line last:border-0 hover:bg-surface-muted ${
                      r.institutionId === institutionId ? "bg-brand-50" : ""
                    }`}>
                      <td className="px-4 py-3">
                        <RankMedal rank={r.rank ?? i + 1} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.institution?.name ?? t("unknownOtm")}</div>
                        {r.institutionId === institutionId && (
                          <span className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-brand-600">
                            <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
                            {t("yourOtm")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-bold text-brand-700">{r.totalScore?.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      </>
      )}
    </DashboardPage>
  );
}
