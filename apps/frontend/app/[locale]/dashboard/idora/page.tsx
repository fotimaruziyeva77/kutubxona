"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import { apiClient as axiosClient } from "@/lib/api/client";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { USER_STATUS_LABELS, SEVERITY_LABELS, label } from "@/lib/labels.const";
import { PageHeader, Panel, StatCard, StatGrid, RankMedal } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";

// FIX (idora auth) — calls now go through the token-attaching clients instead
// of `fetch(`${API}/...`, { credentials: "include" })`. credentials:include
// sent only the HttpOnly *refresh* cookie (scoped to /api/auth), never the
// in-memory Bearer access token (H16) — so every call 401/403'd and the panels
// were empty. JSON GET/POST use the fetch-wrapper `apiClient` (interceptor adds
// Authorization: Bearer + 401→refresh→retry). The PQ-9 PDF download and the
// book-corner photo upload (FormData) use the raw axios instance `axiosClient`
// (blob / multipart). All paths are BARE — axios baseURL is `<origin>/api`.

// ── Types ─────────────────────────────────────────────────────────────────────

// Xodimlar sahifa hajmi — so'rov limiti va paginatsiya "Keyingi" tugmasi BIR
// qiymatni ishlatishi shart (ilgari 20 ikki joyda qattiq yozilgan edi).
const EMPLOYEE_PAGE_SIZE = 20;

interface Employee {
  id: string;
  name: string;
  phone: string;
  sifatId?: string;
  department?: string;
  position?: string;
  status: string;
  trustScore: number;
  readingIndex: Array<{ score: number; calculatedAt: string }>;
}

interface OrgRating {
  userId: string;
  userName: string;
  department?: string;
  avgRi: number;
  booksRead: number;
  rank: number;
  isMvp: boolean;
}

interface ReadingHourStats {
  total: number;
  thisMonthCount: number;
  lastEvent?: string;
  daysSinceLastEvent?: number;
}

interface BookCorner {
  id: string;
  name: string;
  floor?: string;
  isActive: boolean;
  lastVerified?: string;
  nextReminderAt?: string;
  photoUrls: string[];
}

// ── API hooks ─────────────────────────────────────────────────────────────────

function useInstitutionId() {
  const { user } = useAuthStore();
  return user?.organizationId ?? "";
}

// SUPER_ADMIN has no organizationId of their own, so the panel would resolve an
// empty institutionId and show "Sizga idora biriktirilmagan". Mirror the Maktab
// panel: fetch the IDORA institution list (GET /school/institutions?type=IDORA —
// allowed for SUPER_ADMIN) and let the admin pick which idora to view. Reuses
// the same token-attaching axios client as the rest of the page.
interface IdoraInstitution {
  id: string;
  name: string;
  code: string;
}

function useIdoraInstitutions(enabled: boolean) {
  return useQuery({
    queryKey: ["idora-institutions"],
    queryFn: async () => {
      const r = await apiClient(`/school/institutions?type=IDORA&limit=100`);
      if (!r.ok) return { data: [], total: 0 };
      return r.json() as Promise<{ data: IdoraInstitution[]; total: number }>;
    },
    enabled,
    // Har kirishda yangidan olamiz — eski bo'sh kesh adashtirmasin.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

function useEmployees(institutionId: string, search: string, dept: string, page: number) {
  return useQuery({
    queryKey: ["idora-employees", institutionId, search, dept, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(EMPLOYEE_PAGE_SIZE) });
      if (search) params.set("search", search);
      if (dept) params.set("department", dept);
      const r = await apiClient(`/idora/${institutionId}/employees?${params}`);
      if (!r.ok) return { employees: [], total: 0 };
      return r.json();
    },
    enabled: !!institutionId,
    staleTime: 60_000,
  });
}

function useInternalRating(institutionId: string, month: string) {
  return useQuery({
    queryKey: ["idora-rating", institutionId, month],
    queryFn: async () => {
      const r = await apiClient(
        `/idora/${institutionId}/rating${month ? `?month=${month}` : ""}`,
      );
      // Xato javob (403/404 — bu admin idoraga tegishli emas) array EMAS, obyekt
      // qaytaradi; uni data sifatida qaytarsak `rating.find()` crash beradi.
      if (!r.ok) return [] as OrgRating[];
      return r.json() as Promise<OrgRating[]>;
    },
    enabled: !!institutionId,
    staleTime: 120_000,
  });
}

function useReadingHourStats(institutionId: string) {
  return useQuery({
    queryKey: ["reading-hour-stats", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/reading-hours/stats`);
      if (!r.ok) return null as unknown as ReadingHourStats;
      return r.json() as Promise<ReadingHourStats>;
    },
    enabled: !!institutionId,
    staleTime: 120_000,
  });
}

function useBookCorner(institutionId: string) {
  return useQuery({
    queryKey: ["book-corner", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/book-corner`);
      if (r.status === 404) return null;
      return r.json() as Promise<BookCorner | null>;
    },
    enabled: !!institutionId,
    staleTime: 120_000,
  });
}

// ── Components ────────────────────────────────────────────────────────────────

function RiBadge({ score }: { score: number }) {
  const t = useTranslations("IdoraPanel");
  const color =
    score >= 70 ? "bg-green-100 text-green-700" :
    score >= 50 ? "bg-brand-100 text-brand-700" :
    score >= 30 ? "bg-yellow-100 text-yellow-700" :
    "bg-red-100 text-red-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
      {t("riBadge", { score: score.toFixed(1) })}
    </span>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

// Yorliqlar t() orqali olinadi — modul darajasida hook chaqirib bo'lmaydi,
// shu sabab bu yerda faqat tarjima kaliti saqlanadi.
const TABS: { id: string; labelKey: string; icon: LucideIcon }[] = [
  { id: "rating", labelKey: "tabs.rating", icon: Icon.trophy },
  { id: "employees", labelKey: "tabs.employees", icon: Icon.readers },
  { id: "by-dep", labelKey: "tabs.byDep", icon: Icon.organization },
  { id: "reading-hour", labelKey: "tabs.readingHour", icon: Icon.book },
  { id: "book-corner", labelKey: "tabs.bookCorner", icon: Icon.library },
  { id: "prof-books", labelKey: "tabs.profBooks", icon: Icon.checklist },
  { id: "mukofot", labelKey: "tabs.mukofot", icon: Icon.award },
];

export default function IdoraDashboardPage() {
  // Tadbir qatori detail sahifaga (davomat/media) locale bilan ochiladi.
  const locale = useLocale();
  const t = useTranslations("IdoraPanel");
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const ownInstitutionId = useInstitutionId();

  // SUPER_ADMIN picks an idora from a dropdown; everyone else uses their own
  // organization link. The selected id is the only thing that differs — the
  // employee / rating / reading-hour logic below is identical for both.
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const { data: idoraList } = useIdoraInstitutions(isSuperAdmin);
  const institutions = useMemo(() => idoraList?.data ?? [], [idoraList]);

  // Auto-select when exactly one idora exists. (Render paytida setState chaqirish
  // React anti-pattern edi — effektga ko'chirildi.)
  useEffect(() => {
    if (isSuperAdmin && !selectedInstitutionId && institutions.length === 1) {
      setSelectedInstitutionId(institutions[0].id);
    }
  }, [isSuperAdmin, selectedInstitutionId, institutions]);

  const institutionId = isSuperAdmin ? selectedInstitutionId : ownInstitutionId;
  const [tab, setTab] = useState("rating");
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState("");
  const [empPage, setEmpPage] = useState(1);
  const [ratingMonth, setRatingMonth] = useState("");
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEvent, setNewEvent] = useState({ title: "", heldAt: "", venue: "", durationMin: 60 });
  // PQ-9 yuklab olish xatosi — alert() o'rniga inline qizil panel (school
  // sahifasidagi pdfError bilan bir xil naqsh).
  const [pq9Error, setPq9Error] = useState("");

  const queryClient = useQueryClient();
  const { data: employees, isLoading: empLoading } = useEmployees(institutionId, search, dept, empPage);
  const { data: rating, isLoading: ratingLoading } = useInternalRating(institutionId, ratingMonth);
  const { data: readingStats, isLoading: readingStatsLoading } = useReadingHourStats(institutionId);
  const { data: bookCorner, isLoading: bookCornerLoading } = useBookCorner(institutionId);

  const { data: readingHours, isLoading: readingHoursLoading } = useQuery({
    queryKey: ["reading-hours", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/reading-hours?limit=10`);
      if (!r.ok) return { items: [] };
      return r.json();
    },
    enabled: !!institutionId,
  });

  const { data: profBooks, isLoading: profBooksLoading } = useQuery({
    queryKey: ["prof-books", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/prof-books`);
      if (!r.ok) return [] as any[];
      return r.json() as Promise<any[]>;
    },
    enabled: !!institutionId,
  });

  const computeRatingMutation = useMutation({
    mutationFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/rating/compute`, {
        method: "POST",
      });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["idora-rating"] }),
  });

  const addEventMutation = useMutation({
    mutationFn: async () => {
      const { user } = useAuthStore.getState();
      const r = await apiClient(`/idora/${institutionId}/reading-hours`, {
        method: "POST",
        body: JSON.stringify({ ...newEvent, recordedById: user?.id }),
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reading-hours"] });
      queryClient.invalidateQueries({ queryKey: ["reading-hour-stats"] });
      setShowAddEvent(false);
      setNewEvent({ title: "", heldAt: "", venue: "", durationMin: 60 });
    },
  });

  const downloadPq9 = async () => {
    // Raw axios instance — Bearer token via interceptor; blob response. A 403
    // (subscription gate) rejects, so surface its message from the error body.
    try {
      setPq9Error("");
      const r = await axiosClient.get(`/idora/${institutionId}/report/pq9`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pq9-${new Date().toISOString().slice(0, 7)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      if (err?.response?.status === 403) {
        // Error body is a Blob (responseType:"blob"); parse it for the message.
        let msg = t("subscriptionRequired");
        try {
          const text = await (err.response.data as Blob).text();
          msg = JSON.parse(text)?.message ?? msg;
        } catch {
          /* keep default */
        }
        setPq9Error(msg);
        return;
      }
      setPq9Error(t("pq9Error"));
    }
  };

  // Non-super users with no organization link genuinely have no idora.
  // SUPER_ADMIN never hits this — they get the selector + empty state below.
  if (!isSuperAdmin && !institutionId) {
    return (
      <div className="p-8 text-center">
        <div className="mb-4 flex justify-center text-slate-300"><Icon.organization aria-hidden="true" size={48} strokeWidth={1.25} /></div>
        <p className="text-slate-500">{t("noIdoraAssigned")}</p>
      </div>
    );
  }

  const mvp = rating?.find((r) => r.isMvp);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <PageHeader
          title={t("title")}
          subtitle={t("subtitle")}
          icon={Icon.organization}
          action={
            institutionId ? (
              <button
                onClick={downloadPq9}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
              >
                <Icon.document aria-hidden="true" size={ICON_SIZE.sm} />
                {t("pq9Report")}
              </button>
            ) : undefined
          }
        />
      </div>

      {pq9Error && (
        <p role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {pq9Error}
        </p>
      )}

      {/* SUPER_ADMIN idora selector */}
      {isSuperAdmin && (
        <Panel noReveal className="mb-6">
          <label htmlFor="idora-institution-select" className="text-sm font-medium text-slate-700 block mb-2">
            {t("selectIdoraLabel")}
          </label>
          <select
            id="idora-institution-select"
            className="w-full max-w-md border border-line rounded-lg px-3 py-2 text-sm bg-white"
            value={selectedInstitutionId}
            onChange={(e) => setSelectedInstitutionId(e.target.value)}
          >
            <option value="">{t("selectIdoraOption")}</option>
            {institutions.map((inst) => (
              <option key={inst.id} value={inst.id}>
                {inst.name} ({inst.code})
              </option>
            ))}
          </select>
          {institutions.length === 0 && (
            <p className="text-xs text-slate-400 mt-2">{t("noIdorasFound")}</p>
          )}
        </Panel>
      )}

      {!institutionId ? (
        <div className="flex flex-col items-center py-16 text-slate-400">
          <Icon.organization aria-hidden="true" size={40} strokeWidth={1.25} className="text-slate-300" />
          <p className="mt-4">{t("selectIdoraPrompt")}</p>
        </div>
      ) : (
      <>
      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={t("statEmployees")}
          value={employees?.total ?? "—"}
          icon={Icon.readers}
        />
        <StatCard
          label={t("statReadingHour")}
          value={readingStats?.thisMonthCount ?? 0}
          icon={Icon.book}
          sub={t("lastEventSub", { date: readingStats?.lastEvent ? new Date(readingStats.lastEvent).toLocaleDateString("uz-UZ") : "—" })}
        />
        <StatCard
          label={t("statBookCorner")}
          value={bookCorner?.isActive ? t("active") : t("none")}
          icon={bookCorner?.isActive ? Icon.success : Icon.warning}
          tone={bookCorner?.isActive ? "green" : "amber"}
          sub={bookCorner?.lastVerified
            ? t("verifiedSub", { date: new Date(bookCorner.lastVerified).toLocaleDateString("uz-UZ") })
            : t("notAddedYet")}
        />
        <StatCard
          label={t("statMvp")}
          value={mvp?.userName ?? "—"}
          icon={Icon.trophy}
          tone="amber"
          sub={mvp ? t("mvpSub", { ri: mvp.avgRi.toFixed(1), books: mvp.booksRead }) : ""}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-sunken p-1 rounded-xl mb-6 overflow-x-auto">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === tb.id
                ? "bg-white text-brand-700 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {(() => { const TabIcon = tb.icon; return <TabIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={tab === tb.id ? 2.2 : 1.75} />; })()}
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {/* ── Tab: Reyting ── */}
      {tab === "rating" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <input
                type="month"
                aria-label={t("ratingMonthAria")}
                value={ratingMonth}
                onChange={(e) => setRatingMonth(e.target.value)}
                className="px-3 py-2 border border-line rounded-lg text-sm"
              />
              <span className="text-sm text-slate-400">
                {rating ? t("employeeCount", { count: rating.length }) : ""}
              </span>
            </div>
            <button
              onClick={() => computeRatingMutation.mutate()}
              disabled={computeRatingMutation.isPending}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-60"
            >
              {computeRatingMutation.isPending ? t("computing") : t("recompute")}
            </button>
          </div>

          {/* MVP card */}
          {mvp && (
            <div className="bg-gradient-to-r from-yellow-50 to-amber-50 border border-amber-200 rounded-xl p-5 mb-4">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-accent-600"><Icon.trophy aria-hidden="true" size={ICON_SIZE.lg} /></span>
                <div>
                  <div className="text-xs text-accent-600 font-medium uppercase tracking-wide">{t("mvpCardTitle")}</div>
                  <div className="text-xl font-bold text-slate-900 mt-1">{mvp.userName}</div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    {mvp.department && `${mvp.department} · `}
                    {t("mvpCardSub", { ri: mvp.avgRi.toFixed(1), books: mvp.booksRead })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {ratingLoading ? (
            <div className="text-center py-12 text-slate-400">{t("loading")}</div>
          ) : (
            <div className="card-surface rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-slate-500">#</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-500">{t("employee")}</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-500">{t("department")}</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-500">{t("readingIndex")}</th>
                    <th className="text-left px-4 py-3 font-medium text-slate-500">{t("books")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(rating ?? []).map((r) => (
                    <tr key={r.userId} className={`border-t border-line ${r.isMvp ? "bg-amber-50" : ""}`}>
                      <td className="px-4 py-3 w-12">
                        <RankMedal rank={r.rank} />
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {r.isMvp && <Icon.trophy aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline text-accent-500" />}{r.userName}
                      </td>
                      <td className="px-4 py-3 text-slate-500">{r.department ?? "—"}</td>
                      <td className="px-4 py-3">
                        <RiBadge score={r.avgRi} />
                      </td>
                      <td className="px-4 py-3 text-slate-700">{t("itemsCount", { count: r.booksRead })}</td>
                    </tr>
                  ))}
                  {(rating ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                        {t("noData")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Xodimlar ── */}
      {tab === "employees" && (
        <div>
          <div className="flex gap-3 mb-4">
            <input
              type="text"
              aria-label={t("searchAria")}
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setEmpPage(1); }}
              className="flex-1 px-3 py-2 border border-line rounded-lg text-sm"
            />
            <input
              type="text"
              aria-label={t("deptFilterAria")}
              placeholder={t("deptPlaceholder")}
              value={dept}
              onChange={(e) => { setDept(e.target.value); setEmpPage(1); }}
              className="w-40 px-3 py-2 border border-line rounded-lg text-sm"
            />
          </div>

          {empLoading ? (
            <div className="text-center py-12 text-slate-400">{t("loading")}</div>
          ) : (
            <>
              <div className="card-surface rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("employee")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("department")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("position")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("readingIndex")}</th>
                      <th className="text-left px-4 py-3 font-medium text-slate-500">{t("status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(employees?.employees ?? []).map((emp: Employee) => (
                      <tr key={emp.id} className="border-t border-line hover:bg-surface-muted">
                        <td className="px-4 py-3">
                          <div className="font-medium">{emp.name}</div>
                          <div className="text-xs text-slate-400">{emp.phone}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-500">{emp.department ?? "—"}</td>
                        <td className="px-4 py-3 text-slate-500">{emp.position ?? "—"}</td>
                        <td className="px-4 py-3">
                          {emp.readingIndex[0]
                            ? <RiBadge score={emp.readingIndex[0].score} />
                            : <span className="text-xs text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            emp.status === "ACTIVE" ? "bg-green-100 text-green-700" :
                            emp.status === "PENDING" ? "bg-yellow-100 text-yellow-700" :
                            "bg-red-100 text-red-700"
                          }`}>
                            {label(USER_STATUS_LABELS, emp.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {(employees?.employees ?? []).length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                          {t("noEmployees")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* Pagination */}
              <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
                <span>{t("totalCount", { count: employees?.total ?? 0 })}</span>
                <div className="flex gap-2">
                  <button
                    disabled={empPage === 1}
                    onClick={() => setEmpPage((p) => p - 1)}
                    aria-label={t("prevPage")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  ><Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />{t("prev")}</button>
                  <span className="px-3 py-1.5">{empPage}</span>
                  <button
                    disabled={(employees?.employees?.length ?? 0) < EMPLOYEE_PAGE_SIZE}
                    onClick={() => setEmpPage((p) => p + 1)}
                    aria-label={t("nextPage")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 border border-line rounded-lg disabled:opacity-40"
                  >{t("next")}<Icon.next aria-hidden="true" size={ICON_SIZE.xs} /></button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: O'qish soati ── */}
      {tab === "reading-hour" && (
        <div>
          {/* Statistika — sahifa yuqorisidagi StatCard uslubi bilan bir xil */}
          <StatGrid cols={3} className="mb-6">
            <StatCard
              icon={Icon.calendar}
              label={t("totalEvents")}
              value={readingStatsLoading ? "—" : readingStats?.total ?? 0}
            />
            <StatCard
              icon={Icon.book}
              label={t("thisMonth")}
              value={readingStatsLoading ? "—" : readingStats?.thisMonthCount ?? 0}
              tone="green"
            />
            <StatCard
              icon={Icon.pending}
              label={t("daysSinceLast")}
              value={readingStatsLoading ? "—" : readingStats?.daysSinceLastEvent ?? "—"}
              tone={(readingStats?.daysSinceLastEvent ?? 0) > 30 ? "rose" : "gray"}
              sub={(readingStats?.daysSinceLastEvent ?? 0) > 30 ? t("pq9MonthlyRequired") : undefined}
            />
          </StatGrid>

          {(readingStats?.daysSinceLastEvent ?? 0) > 30 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-red-700 text-sm">
              <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mr-1 inline shrink-0" />{t("lastEventWarning", { days: readingStats?.daysSinceLastEvent ?? 0 })}
            </div>
          )}

          <button
            onClick={() => setShowAddEvent(true)}
            className="mb-4 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700"
          >
            {t("addEventButton")}
          </button>

          {showAddEvent && (
            <div className="card-surface rounded-xl p-5 mb-4">
              <h3 className="font-semibold mb-4">{t("newEventTitle")}</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="new-event-title" className="text-xs text-slate-500 block mb-1">{t("eventTitleLabel")}</label>
                  <input
                    id="new-event-title"
                    value={newEvent.title}
                    onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                    placeholder={t("eventTitlePlaceholder")}
                    className="w-full px-3 py-2 border border-line rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-event-heldat" className="text-xs text-slate-500 block mb-1">{t("dateTimeRequiredLabel")}</label>
                  <input
                    id="new-event-heldat"
                    type="datetime-local"
                    value={newEvent.heldAt}
                    onChange={(e) => setNewEvent({ ...newEvent, heldAt: e.target.value })}
                    className="w-full px-3 py-2 border border-line rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-event-venue" className="text-xs text-slate-500 block mb-1">{t("venueLabel")}</label>
                  <input
                    id="new-event-venue"
                    value={newEvent.venue}
                    onChange={(e) => setNewEvent({ ...newEvent, venue: e.target.value })}
                    className="w-full px-3 py-2 border border-line rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="new-event-duration" className="text-xs text-slate-500 block mb-1">{t("durationLabel")}</label>
                  <input
                    id="new-event-duration"
                    type="number"
                    value={newEvent.durationMin}
                    onChange={(e) => setNewEvent({ ...newEvent, durationMin: Number(e.target.value) })}
                    className="w-full px-3 py-2 border border-line rounded-lg text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => addEventMutation.mutate()}
                  disabled={!newEvent.heldAt || addEventMutation.isPending}
                  className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium disabled:opacity-60"
                >
                  {addEventMutation.isPending ? t("saving") : t("save")}
                </button>
                <button
                  onClick={() => setShowAddEvent(false)}
                  className="px-4 py-2 border border-line rounded-lg text-sm"
                >
                  {t("cancelShort")}
                </button>
              </div>
            </div>
          )}

          {readingHoursLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : (
          <div className="space-y-3">
            {/* Qator — davomat/media boshqariladigan detail sahifaga havola */}
            {(readingHours?.items ?? []).map((ev: any) => (
              <Link
                key={ev.id}
                href={`/${locale}/dashboard/idora/reading-hour/${ev.id}`}
                className="card-surface rounded-xl p-4 flex items-center justify-between gap-3 transition-shadow hover:shadow-md"
              >
                <div>
                  <div className="font-medium">{ev.title}</div>
                  <div className="text-sm text-slate-500 mt-1">
                    <Icon.calendar aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{new Date(ev.heldAt).toLocaleDateString("uz-UZ")} ·
                    <Icon.pending aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("minutes", { count: ev.durationMin })} ·
                    <Icon.readers aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("participants", { count: ev.attendances?.length ?? 0 })}
                    {ev.venue && <span> · <Icon.map aria-hidden="true" size={ICON_SIZE.xs} className="inline" /> {ev.venue}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {ev.mediaUrls?.length > 0 && (
                    <span className="text-xs text-brand-600 bg-brand-50 px-2 py-1 rounded-lg">
                      <Icon.camera aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("mediaCount", { count: ev.mediaUrls.length })}
                    </span>
                  )}
                  <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />
                </div>
              </Link>
            ))}
            {(readingHours?.items ?? []).length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <div className="mb-2 flex justify-center text-slate-300"><Icon.book aria-hidden="true" size={32} strokeWidth={1.25} /></div>
                <p>{t("noEventsYet")}</p>
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {/* ── Tab: Kitob burchagi ── */}
      {tab === "book-corner" && (
        <div className="max-w-lg">
          {/* isLoading tarmog'isiz "Kitob burchagi yo'q" chaqnab ko'rinardi —
              PQ-9 auditi paytida noto'g'ri taassurot berardi. */}
          {bookCornerLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : (
          <>
          <div className={`border rounded-xl p-6 mb-4 ${
            bookCorner?.isActive
              ? "bg-green-50 border-green-200"
              : "bg-red-50 border-red-200"
          }`}>
            <div className="flex items-center gap-3 mb-3">
              <span className={bookCorner?.isActive ? "text-green-600" : "text-accent-500"}>{bookCorner?.isActive ? <Icon.success aria-hidden="true" size={ICON_SIZE.lg} /> : <Icon.warning aria-hidden="true" size={ICON_SIZE.lg} />}</span>
              <div>
                <div className="font-semibold">
                  {bookCorner?.isActive ? t("bookCornerActive") : t("bookCornerMissing")}
                </div>
                <div className="text-sm text-slate-500">
                  {bookCorner?.lastVerified
                    ? t("lastVerified", { date: new Date(bookCorner.lastVerified).toLocaleDateString("uz-UZ") })
                    : t("notAddedYet")}
                </div>
              </div>
            </div>
            {bookCorner?.nextReminderAt && (
              <div className="text-xs text-slate-500">
                {t("nextReminder", { date: new Date(bookCorner.nextReminderAt).toLocaleDateString("uz-UZ") })}
              </div>
            )}
            {bookCorner?.floor && (
              <div className="mt-2 flex items-center gap-1 text-sm text-slate-600"><Icon.map aria-hidden="true" size={ICON_SIZE.xs} />{bookCorner.floor}</div>
            )}
          </div>

          <BookCornerForm institutionId={institutionId} existing={bookCorner} />
          </>
          )}
        </div>
      )}

      {/* ── Tab: Kasb adabiyotlar ── */}
      {tab === "prof-books" && (
        <div>
          {profBooksLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : (
          <div className="card-surface rounded-xl overflow-x-auto">
            <div className="p-4 border-b border-line flex items-center justify-between">
              <span className="font-medium">{t("profBooksListTitle")}</span>
              <span className="text-sm text-slate-400">{t("itemsCount", { count: profBooks?.length ?? 0 })}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">#</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("bookName")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("author")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("department")}</th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">{t("required")}</th>
                </tr>
              </thead>
              <tbody>
                {(profBooks ?? []).map((b: any, i: number) => (
                  <tr key={b.id} className="border-t border-line">
                    <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{b.title}</td>
                    <td className="px-4 py-3 text-slate-500">{b.author}</td>
                    <td className="px-4 py-3 text-slate-500">{b.department?.name ?? t("allDepartments")}</td>
                    <td className="px-4 py-3">
                      {b.isRequired && (
                        <span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">
                          {t("required")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {(profBooks ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      {t("noProfBooks")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* ── Tab: Bo'lim bo'yicha (employees-by-department tree) ── */}
      {tab === "by-dep" && <EmployeesByDepartmentTab institutionId={institutionId} />}

      {/* ── Tab: Mukofot taklifi inbox ── */}
      {tab === "mukofot" && <MukofotInboxTab institutionId={institutionId} />}
      </>
      )}
    </div>
  );
}

// ── EmployeesByDepartmentTab — ORG-01 ─────────────────────────────────────────
//
// Plan 06-05 ORG-01 frontend — employees grouped by department, K-anonymity
// hint shown for buckets where avgRi is suppressed.

function EmployeesByDepartmentTab({ institutionId }: { institutionId: string }) {
  const t = useTranslations("IdoraPanel");
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["idora-by-dep", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/employees-by-department`);
      // r.ok tekshiruvisiz xato javob (403/500) ham "data" bo'lib ketardi.
      if (!r.ok) throw new Error("Bo'lim ma'lumotini yuklab bo'lmadi");
      return r.json() as Promise<{ buckets: any[] }>;
    },
    enabled: !!institutionId,
    staleTime: 60_000,
  });

  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const approve = useMutation({
    mutationFn: async (userId: string) => {
      const r = await apiClient(`/idora/${institutionId}/employees/${userId}/approve`, {
        method: "POST",
      });
      if (!r.ok) throw new Error((await r.json())?.message ?? "Tasdiqlab bo'lmadi");
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["idora-by-dep"] }),
  });

  const reject = useMutation({
    mutationFn: async ({ userId, reason }: { userId: string; reason: string }) => {
      const r = await apiClient(`/idora/${institutionId}/employees/${userId}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) throw new Error((await r.json())?.message ?? "Rad etib bo'lmadi");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["idora-by-dep"] });
      setRejectFor(null);
      setRejectReason("");
    },
  });

  if (isLoading) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (isError) {
    return (
      <ErrorState
        message={t("byDepError")}
        onRetry={() => refetch()}
        isRetrying={isRefetching}
      />
    );
  }

  const buckets = data?.buckets ?? [];
  return (
    <div className="space-y-4">
      {buckets.map((b: any) => (
        <details key={b.departmentName} className="card-surface rounded-xl" open>
          <summary className="cursor-pointer px-4 py-3 flex items-center justify-between font-medium">
            <span>
              <Icon.organization aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{b.departmentName}
              <span className="ml-2 text-xs text-slate-400">({t("employeeCount", { count: b.total })})</span>
            </span>
            <span className="text-sm">
              {b.kAnonymitySuppressed ? (
                <span className="text-yellow-700 text-xs bg-yellow-50 px-2 py-0.5 rounded-full">
                  {t("deptTooSmall")}
                </span>
              ) : (
                <span className="text-brand-700">{t("avgIndex", { value: b.avgRi?.toFixed?.(1) ?? "—" })}</span>
              )}
            </span>
          </summary>
          <div className="overflow-x-auto">
          <table className="w-full text-sm border-t border-line">
            <thead className="bg-surface-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("name")}</th>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("position")}</th>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("ri")}</th>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("books")}</th>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("status")}</th>
                <th className="text-left px-4 py-2 font-medium text-slate-500">{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {(b.employees ?? []).map((e: any) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-4 py-2">{e.name}</td>
                  <td className="px-4 py-2 text-slate-500">{e.position ?? "—"}</td>
                  <td className="px-4 py-2">{e.avgRi.toFixed(1)}</td>
                  <td className="px-4 py-2 text-slate-700">{e.booksReadThisYear}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      e.status === "ACTIVE" ? "bg-green-100 text-green-700" :
                      e.status === "PENDING" ? "bg-yellow-100 text-yellow-700" :
                      "bg-red-100 text-red-700"
                    }`}>{label(USER_STATUS_LABELS, e.status)}</span>
                  </td>
                  <td className="px-4 py-2">
                    {e.status === "PENDING" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => approve.mutate(e.id)}
                          className="text-xs px-2 py-1 bg-green-600 text-white rounded"
                          disabled={approve.isPending}
                        >{t("approve")}</button>
                        <button
                          onClick={() => setRejectFor(e.id)}
                          className="text-xs px-2 py-1 bg-red-600 text-white rounded"
                        >{t("reject")}</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </details>
      ))}
      {buckets.length === 0 && (
        <div className="text-center py-12 text-slate-400">{t("noDeptData")}</div>
      )}

      {rejectFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-5 max-w-md w-full">
            <h3 className="font-semibold mb-3">{t("rejectReasonTitle")}</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("rejectReasonPlaceholder")}
              rows={4}
              className="w-full px-3 py-2 border border-line rounded-lg text-sm"
            />
            <div className="flex gap-3 mt-4 justify-end">
              <button
                onClick={() => { setRejectFor(null); setRejectReason(""); }}
                className="px-4 py-2 border border-line rounded-lg text-sm"
              >{t("cancelShort")}</button>
              <button
                onClick={() => reject.mutate({ userId: rejectFor, reason: rejectReason })}
                disabled={rejectReason.trim().length < 3 || reject.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm disabled:opacity-60"
              >{t("reject")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MukofotInboxTab — ORG-05 ─────────────────────────────────────────────────

function MukofotInboxTab({ institutionId }: { institutionId: string }) {
  const t = useTranslations("IdoraPanel");
  const { data, isLoading } = useQuery({
    queryKey: ["idora-mukofot", institutionId],
    queryFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/mukofot/recent`);
      return r.json() as Promise<any[]>;
    },
    enabled: !!institutionId,
    staleTime: 60_000,
  });

  if (isLoading) return <div className="text-center py-12 text-slate-400">{t("loading")}</div>;
  const rows = data ?? [];

  return (
    <div className="space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-800 text-sm">
        <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mr-1 inline shrink-0" />{t("mukofotNotice")}
      </div>
      {rows.map((m: any) => (
        <div key={m.id} className="card-surface rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 font-medium"><Icon.award aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-500" />{new Date(m.createdAt).toLocaleString("uz-UZ")}</div>
              <div className="text-sm text-slate-500 mt-1">
                {(() => {
                  try {
                    const parsed = JSON.parse(m.analysis);
                    // Ism bo'lsa ISMNI ko'rsatamiz. UUID ni HR adminга
                    // ko'rsatishning ma'nosi yo'q — u kimni mukofotlashni
                    // bilishi kerak. Eski yozuvlarda ism yo'q, o'shanda
                    // qisqartirilgan kod ko'rsatiladi.
                    const who = parsed.recommendedUserName
                      ?? t("employeeCodeFallback", { code: String(parsed.recommendedUserId ?? "").slice(-6) });
                    return t("topEmployeeLine", { who, month: parsed.month });
                  } catch {
                    return m.analysis;
                  }
                })()}
              </div>
            </div>
            <span className="text-xs text-slate-500 bg-surface-muted px-2 py-1 rounded">{label(SEVERITY_LABELS, m.severity)}</span>
          </div>
        </div>
      ))}
      {rows.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <div className="mb-2 flex justify-center text-slate-300"><Icon.award aria-hidden="true" size={32} strokeWidth={1.25} /></div>
          <p>{t("noMukofot")}</p>
        </div>
      )}
    </div>
  );
}

// ── BookCornerForm ─────────────────────────────────────────────────────────────

function BookCornerForm({ institutionId, existing }: {
  institutionId: string;
  existing?: BookCorner | null;
}) {
  const t = useTranslations("IdoraPanel");
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: existing?.name ?? t("bookCornerDefaultName"),
    floor: existing?.floor ?? "",
    adminNote: "",
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await apiClient(`/idora/${institutionId}/book-corner`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["book-corner"] }),
  });

  return (
    <div className="card-surface rounded-xl p-5">
      <h3 className="font-semibold mb-4">
        {existing ? t("updateBookCorner") : t("addBookCorner")}
      </h3>
      <div className="space-y-3">
        <div>
          <label htmlFor="book-corner-name" className="text-xs text-slate-500 block mb-1">{t("nameLabel")}</label>
          <input
            id="book-corner-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm"
          />
        </div>
        <div>
          <label htmlFor="book-corner-floor" className="text-xs text-slate-500 block mb-1">{t("locationLabel")}</label>
          <input
            id="book-corner-floor"
            value={form.floor}
            onChange={(e) => setForm({ ...form, floor: e.target.value })}
            placeholder={t("locationPlaceholder")}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm"
          />
        </div>
        <div>
          <label htmlFor="book-corner-note" className="text-xs text-slate-500 block mb-1">{t("noteLabel")}</label>
          <input
            id="book-corner-note"
            value={form.adminNote}
            onChange={(e) => setForm({ ...form, adminNote: e.target.value })}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm"
          />
        </div>
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="w-full py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-60"
        >
          {mutation.isPending ? t("saving") : (existing ? t("update") : t("add"))}
        </button>
      </div>

      <BookCornerVerifyUpload institutionId={institutionId} />
    </div>
  );
}

// ── BookCornerVerifyUpload — ORG-04 ───────────────────────────────────────────
//
// Plan 06-05 ORG-04 frontend — verify the book corner with a fresh photo. The
// backend enforces MIME sniff (image-only) + 5MB cap + subscription gate.

function BookCornerVerifyUpload({ institutionId }: { institutionId: string }) {
  const t = useTranslations("IdoraPanel");
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(t("selectPhotoError"));
      if (file.size > 5 * 1024 * 1024) throw new Error(t("photoTooLarge"));
      const fd = new FormData();
      fd.append("file", file);
      // Raw axios instance: Bearer token via interceptor. Override the
      // instance's default application/json so axios sets multipart/form-data
      // with the correct boundary for the FormData body.
      try {
        const r = await axiosClient.post(
          `/idora/${institutionId}/book-corner/verify`,
          fd,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
        return r.data;
      } catch (e: any) {
        throw new Error(e?.response?.data?.message ?? t("genericError"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book-corner"] });
      setFile(null);
      setError(null);
    },
    onError: (e: any) => setError(String(e.message)),
  });

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="font-semibold mb-3">{t("verifyTitle")}</h3>
      <p className="text-xs text-slate-500 mb-3">
        {t("verifyDesc")}
      </p>
      {/* Yashirin input + label-tugma — xom fayl input har brauzerda boshqacha
          ko'rinadi va dizayn tiliga mos emas. */}
      <input
        id="book-corner-photo"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
        className="sr-only"
      />
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="book-corner-photo"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted"
        >
          <Icon.camera aria-hidden="true" size={ICON_SIZE.sm} />
          {t("selectPhoto")}
        </label>
        <span className={`text-xs ${file ? "text-slate-600" : "text-slate-400"}`}>
          {file ? file.name : t("noFileSelected")}
        </span>
      </div>
      {error && <div role="alert" className="text-red-600 text-xs mt-2">{error}</div>}
      <button
        onClick={() => mutation.mutate()}
        disabled={!file || mutation.isPending}
        className="mt-3 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-60"
      >
        {mutation.isPending ? t("uploading") : <span className="inline-flex items-center gap-1.5"><Icon.camera aria-hidden="true" size={ICON_SIZE.sm} />{t("verify")}</span>}
      </button>
    </div>
  );
}
