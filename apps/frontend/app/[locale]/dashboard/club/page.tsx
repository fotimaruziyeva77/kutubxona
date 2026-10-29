"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// FIX: token-attaching apiClient (axios instance with Bearer interceptor +
// 401→refresh→retry). Raw `axios` + withCredentials never authenticated these
// calls — the access token is a Bearer header, not a cookie — so every request
// returned 401. apiClient.baseURL is already `<origin>/api`, so paths are bare
// (API = "" → `${API}/club` becomes "/club").
import { apiClient as axios } from "@/lib/api/client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  DashboardPage,
  PageHeader,
  StatGrid,
  StatCard,
} from "@/components/dashboard/ui";
import { FormField, Input } from "@/components/ui/input";

const API = "";

type ClubMonitoring = {
  club: {
    id: string; name: string; goal: number;
    institution: { name: string };
    _count: { members: number; debates: number };
  };
  memberStats: {
    total: number; onTrack: number; atRisk: number; avgBooks: number; avgRi: number;
  };
  quarterDebates: number;
  quarterGoal: number;
  quarterProgress: number;
  daysSinceLastDebate: number | null;
  lastDebate: { topic: string; heldAt: string } | null;
  alert: { type: string; message: string } | null;
  members: Array<{
    id: string; userId: string; status: string;
    user: { name: string; sifatId: string | null; schoolClass: string | null } | null;
    latestRi: number; booksThisYear: number; goalProgress: number;
  }>;
};

type GoalProgress = {
  summary: { year: number; quarter: number; annualGoal: number; quarterGoal: number; totalMembers: number; achievedAnnual: number; onTrackCount: number; atRiskCount: number };
  members: Array<{
    userId: string;
    user: { name: string; schoolClass: string | null } | null;
    booksThisYear: number; goalProgress: number;
    quarterBooks: number; quarterGoalProgress: number; onTrackForYear: boolean;
  }>;
};

export default function ClubDashboardPage() {
  const locale = useLocale();
  const t = useTranslations("ClubPanel");
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null);
  const [tab, setTab] = useState<"monitoring" | "goals" | "debates" | "inactive">("monitoring");
  const [debateForm, setDebateForm] = useState(false);
  const [newDebate, setNewDebate] = useState({ topic: "", heldAt: "", venue: "", participants: 0, summary: "" });

  // Plan 04-01 audit-fix FIX 4: Phase 1 INFRA-02 cookie auth. The old
  // localStorage.getItem('access_token') flow was deprecated by Phase 1 and
  // returned 401 in production. axios.withCredentials forwards the HttpOnly
  // refresh-token cookie + the short-lived access-token middleware.
  const qc = useQueryClient();
  const axiosCfg = { withCredentials: true } as const;

  const { data: clubs } = useQuery({
    queryKey: ["clubs"],
    queryFn: () => axios.get(`${API}/club?limit=100`, axiosCfg).then((r) => r.data)
  });

  const {
    data: monitoring,
    isLoading,
    isError: monitoringError,
    refetch: refetchMonitoring,
  } = useQuery<ClubMonitoring>({
    queryKey: ["club-monitoring", selectedClubId],
    queryFn: () => axios.get(`${API}/club/${selectedClubId}/monitoring`, axiosCfg).then((r) => r.data),
    enabled: !!selectedClubId && tab === "monitoring"
  });

  const {
    data: goalData,
    isLoading: goalsLoading,
    isError: goalsError,
    refetch: refetchGoals,
  } = useQuery<GoalProgress>({
    queryKey: ["club-goals", selectedClubId],
    queryFn: () => axios.get(`${API}/club/${selectedClubId}/goal-progress`, axiosCfg).then((r) => r.data),
    enabled: !!selectedClubId && tab === "goals"
  });

  const { data: debates } = useQuery({
    queryKey: ["club-debates", selectedClubId],
    queryFn: () => axios.get(`${API}/club/${selectedClubId}/debates`, axiosCfg).then((r) => r.data),
    enabled: !!selectedClubId && tab === "debates"
  });

  const {
    data: inactive,
    isLoading: inactiveLoading,
    isError: inactiveError,
    refetch: refetchInactive,
  } = useQuery({
    queryKey: ["clubs-inactive"],
    queryFn: () => axios.get(`${API}/club/inactive?tumanId=all`, axiosCfg).then((r) => r.data),
    enabled: tab === "inactive"
  });

  const createDebate = useMutation({
    mutationFn: (data: typeof newDebate) =>
      // recordedById YUBORILMAYDI: backend uni JWT dan oladi (IDOR-H12) va
      // klient yuborgan qiymatni e'tiborsiz qoldiradi. Ilgari bu yerda
      // "current-user-id" degan matn qoldirilgan edi — o'lik joy egallovchi.
      axios.post(`${API}/club/${selectedClubId}/debates`, {
        ...data,
        participants: Number(data.participants),
      }, axiosCfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["club-debates"] });
      qc.invalidateQueries({ queryKey: ["club-monitoring"] });
      setDebateForm(false);
      setNewDebate({ topic: "", heldAt: "", venue: "", participants: 0, summary: "" });
    }
  });

  // Birinchi klubni avtomatik tanlash — render ichida setState React
  // qoidasiga zid edi, effektga ko'chirildi.
  useEffect(() => {
    if (clubs?.data?.length > 0 && !selectedClubId) {
      setSelectedClubId(clubs.data[0].id);
    }
  }, [clubs, selectedClubId]);

  return (
    <DashboardPage>
      <PageHeader
        icon={Icon.club}
        title={t("title")}
        subtitle={t("subtitle")}
      />

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto bg-surface-sunken p-1 rounded-xl w-fit max-w-full">
        {(["monitoring", "goals", "debates", "inactive"] as const).map((tabKey) => (
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

      {tab !== "inactive" && (
        /* Club selector */
        <div className="card-surface rounded-2xl p-4">
          <label htmlFor="club-select" className="text-sm font-medium text-slate-700 block mb-2">
            {t("selectClub")}
          </label>
          <select
            id="club-select"
            className="w-full max-w-md border border-line-strong rounded-xl px-3 py-2 text-sm"
            value={selectedClubId ?? ""}
            onChange={(e) => setSelectedClubId(e.target.value || null)}
          >
            <option value="">{t("selectClubPlaceholder")}</option>
            {clubs?.data?.map((c: { id: string; name: string; institution: { name: string }; _count: { members: number } }) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.institution?.name} ({t("memberCount", { count: c._count?.members ?? 0 })})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ── Tab: Monitoring ─────────────────────────────────────────────────── */}
      {tab === "monitoring" && selectedClubId && (
        <>
          {isLoading ? (
            <div className="flex justify-center py-12 text-brand-600">
              <Spinner size="lg" label={t("monitoring.loading")} />
            </div>
          ) : monitoringError ? (
            <ErrorState
              title={t("monitoring.errorTitle")}
              message={t("monitoring.errorMessage")}
              onRetry={() => refetchMonitoring()}
            />
          ) : monitoring ? (
            <>
              {/* Alert */}
              {monitoring.alert && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-2xl px-4 py-3 flex items-center gap-3">
                  <Icon.warning aria-hidden="true" size={ICON_SIZE.md} className="shrink-0" />
                  <span className="text-sm font-medium">{monitoring.alert.message}</span>
                </div>
              )}

              {/* KPI cards */}
              <StatGrid cols={4}>
                <StatCard
                  icon={Icon.readers}
                  label={t("monitoring.activeMembers")}
                  value={monitoring.memberStats.total}
                  tone="blue"
                />
                <StatCard
                  icon={Icon.target}
                  label={t("monitoring.onTrack")}
                  value={monitoring.memberStats.onTrack}
                  sub={t("monitoring.atRiskCount", { count: monitoring.memberStats.atRisk })}
                  tone="green"
                />
                <StatCard
                  icon={Icon.club}
                  label={t("monitoring.quarterDebates")}
                  value={`${monitoring.quarterDebates}/${monitoring.quarterGoal}`}
                  sub={t("monitoring.percentDone", { percent: Math.min(Math.round(monitoring.quarterProgress), 100) })}
                  tone="violet"
                />
                <StatCard
                  icon={Icon.calendar}
                  label={t("monitoring.daysWithoutDebate")}
                  value={monitoring.daysSinceLastDebate ?? "—"}
                  sub={monitoring.lastDebate ? `«${monitoring.lastDebate.topic}»` : t("monitoring.noDebateYet")}
                  tone="amber"
                />
              </StatGrid>

              {/* A'zolar jadvali */}
              <div className="card-surface rounded-2xl overflow-x-auto">
                <div className="p-4 border-b border-line">
                  <h3 className="font-semibold text-slate-800">{t("monitoring.memberActivity")}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {t("monitoring.avgLine", { ri: monitoring.memberStats.avgRi, books: monitoring.memberStats.avgBooks })}
                  </p>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("monitoring.thMember")}</th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("monitoring.thRi")}</th>
                      <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("monitoring.thBooksThisYear")}</th>
                      <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("monitoring.thGoal")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {monitoring.members.map((m) => (
                      <tr key={m.id} className="hover:bg-surface-muted">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{m.user?.name ?? "—"}</div>
                          <div className="text-xs text-slate-400">{m.user?.schoolClass ?? ""}</div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-lg text-xs font-bold ${
                            m.latestRi >= 70 ? "bg-green-100 text-green-700"
                            : m.latestRi >= 40 ? "bg-yellow-100 text-yellow-700"
                            : "bg-red-100 text-red-700"
                          }`}>
                            {m.latestRi}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center font-medium text-slate-800">{m.booksThisYear}</td>
                        <td className="px-4 py-3 min-w-[160px]">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-surface-sunken rounded-full h-2">
                              <div
                                className={`h-2 rounded-full ${m.goalProgress >= 75 ? "bg-green-500" : m.goalProgress >= 40 ? "bg-yellow-500" : "bg-red-500"}`}
                                style={{ width: `${Math.min(m.goalProgress, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-slate-500 w-8">{m.goalProgress}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}

      {/* ── Tab: Goals ──────────────────────────────────────────────────────── */}
      {tab === "goals" && selectedClubId && (
        goalsLoading ? (
          <div className="flex justify-center py-12 text-brand-600">
            <Spinner size="lg" label={t("goals.loading")} />
          </div>
        ) : goalsError ? (
          <ErrorState
            title={t("goals.errorTitle")}
            message={t("goals.errorMessage")}
            onRetry={() => refetchGoals()}
          />
        ) : !goalData ? null : goalData.members.length === 0 ? (
          <EmptyState
            icon={Icon.target}
            title={t("goals.emptyTitle")}
            description={t("goals.emptyDesc")}
          />
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <StatGrid cols={4}>
              <StatCard
                icon={Icon.readers}
                label={t("goals.totalMembers")}
                value={goalData.summary.totalMembers}
                tone="blue"
              />
              <StatCard
                icon={Icon.trophy}
                label={t("goals.achieved")}
                value={goalData.summary.achievedAnnual}
                tone="green"
              />
              <StatCard
                icon={Icon.trendUp}
                label={t("goals.onTrack")}
                value={goalData.summary.onTrackCount}
                tone="amber"
              />
              <StatCard
                icon={Icon.warning}
                label={t("goals.atRisk")}
                value={goalData.summary.atRiskCount}
                tone="rose"
              />
            </StatGrid>

            {/* Per-member table */}
            <div className="card-surface rounded-2xl overflow-x-auto">
              <div className="p-4 border-b border-line">
                <h3 className="font-semibold">
                  {t("goals.header", {
                    year: goalData.summary.year,
                    quarter: goalData.summary.quarter,
                    annual: goalData.summary.annualGoal,
                    quarterly: goalData.summary.quarterGoal,
                  })}
                </h3>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-surface-muted">
                  <tr>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("goals.thMember")}</th>
                    <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("goals.thThisYear")}</th>
                    <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("goals.thThisQuarter")}</th>
                    <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("goals.thAnnualProgress")}</th>
                    <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("goals.thStatus")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {goalData.members.map((m) => (
                    <tr key={m.userId} className="hover:bg-surface-muted">
                      <td className="px-4 py-3">
                        <div className="font-medium">{m.user?.name ?? "—"}</div>
                        <div className="text-xs text-slate-400">{m.user?.schoolClass ?? ""}</div>
                      </td>
                      <td className="px-4 py-3 text-center font-bold text-brand-700">{m.booksThisYear}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`${m.quarterGoalProgress >= 100 ? "text-green-600" : "text-slate-600"}`}>
                          {m.quarterBooks}/{goalData.summary.quarterGoal}
                        </span>
                      </td>
                      <td className="px-4 py-3 min-w-[180px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-surface-sunken rounded-full h-2">
                            <div
                              className={`h-2 rounded-full ${
                                m.goalProgress >= 100 ? "bg-green-500"
                                : m.goalProgress >= 60 ? "bg-brand-500"
                                : m.goalProgress >= 30 ? "bg-yellow-500"
                                : "bg-red-400"
                              }`}
                              style={{ width: `${Math.min(m.goalProgress, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-500 w-10 text-right">{m.booksThisYear}/20</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {m.booksThisYear >= 20 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700"><Icon.trophy aria-hidden="true" size={ICON_SIZE.xs} />{t("goals.goalReached")}</span>
                        ) : m.onTrackForYear ? (
                          <span className="px-2 py-0.5 bg-brand-100 text-brand-700 rounded-full text-xs">{t("goals.onTrack")}</span>
                        ) : (
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs">{t("goals.behind")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* ── Tab: Debates ─────────────────────────────────────────────────────── */}
      {tab === "debates" && selectedClubId && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => setDebateForm(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700"
            >
              <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
              {t("debates.addButton")}
            </button>
          </div>

          {/* New debate form */}
          {debateForm && (
            <div className="card-surface rounded-2xl p-5 space-y-4">
              <h3 className="font-semibold text-slate-800">{t("debates.newTitle")}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField id="debate-topic" label={t("debates.topic")} required>
                  <Input
                    className="rounded-xl"
                    value={newDebate.topic}
                    onChange={(e) => setNewDebate({ ...newDebate, topic: e.target.value })}
                    placeholder={t("debates.topicPlaceholder")}
                  />
                </FormField>
                <FormField id="debate-held-at" label={t("debates.date")} required>
                  <Input
                    type="datetime-local"
                    className="rounded-xl"
                    value={newDebate.heldAt}
                    onChange={(e) => setNewDebate({ ...newDebate, heldAt: e.target.value })}
                  />
                </FormField>
                <FormField id="debate-venue" label={t("debates.venue")}>
                  <Input
                    className="rounded-xl"
                    value={newDebate.venue}
                    onChange={(e) => setNewDebate({ ...newDebate, venue: e.target.value })}
                    placeholder={t("debates.venuePlaceholder")}
                  />
                </FormField>
                <FormField id="debate-participants" label={t("debates.participants")} required>
                  <Input
                    type="number"
                    className="rounded-xl"
                    value={newDebate.participants}
                    onChange={(e) => setNewDebate({ ...newDebate, participants: Number(e.target.value) })}
                    min={1}
                  />
                </FormField>
              </div>
              <FormField id="debate-summary" label={t("debates.summary")}>
                <textarea
                  className="w-full border border-line-strong rounded-xl px-3 py-2 text-sm"
                  rows={3}
                  value={newDebate.summary}
                  onChange={(e) => setNewDebate({ ...newDebate, summary: e.target.value })}
                  placeholder={t("debates.summaryPlaceholder")}
                />
              </FormField>
              <div className="flex gap-3">
                <button
                  onClick={() => createDebate.mutate(newDebate)}
                  disabled={!newDebate.topic || !newDebate.heldAt || !newDebate.participants}
                  className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                >
                  {createDebate.isPending ? t("debates.saving") : t("debates.save")}
                </button>
                <button
                  onClick={() => setDebateForm(false)}
                  className="px-4 py-2 border border-line-strong text-slate-600 rounded-xl text-sm hover:bg-surface-muted"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}

          {/* Debates list — har qator debat detal sahifasiga havola (media
              yuklash va DRAFT→PUBLISHED faqat o'sha sahifada) */}
          <div className="card-surface rounded-2xl divide-y divide-line">
            {debates?.map((d: {
              id: string; topic: string; heldAt: string;
              venue: string | null; participants: number;
              summary: string | null; mediaUrls: string[];
            }) => (
              <Link
                key={d.id}
                href={`/${locale}/dashboard/club/${selectedClubId}/debate/${d.id}`}
                className="flex items-start justify-between gap-3 p-4 transition-colors hover:bg-surface-muted"
              >
                <div className="min-w-0">
                  <div className="font-medium text-slate-900">«{d.topic}»</div>
                  <div className="text-xs text-slate-400 mt-1">
                    <span className="inline-flex items-center gap-1"><Icon.calendar aria-hidden="true" size={ICON_SIZE.xs} />{new Date(d.heldAt).toLocaleDateString("uz-UZ")}</span>
                    {d.venue && <span className="inline-flex items-center gap-1"> · <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />{d.venue}</span>}
                    <span className="inline-flex items-center gap-1"> · <Icon.readers aria-hidden="true" size={ICON_SIZE.xs} />{t("debates.participantCount", { count: d.participants })}</span>
                  </div>
                  {d.summary && (
                    <div className="text-sm text-slate-600 mt-2">{d.summary}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {d.mediaUrls.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600">
                      <Icon.camera aria-hidden="true" size={ICON_SIZE.xs} />{t("debates.mediaCount", { count: d.mediaUrls.length })}
                    </span>
                  )}
                  <Icon.next aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />
                </div>
              </Link>
            ))}
            {(!debates || debates.length === 0) && (
              <div className="flex flex-col items-center py-12 text-slate-400">
                <Icon.checklist aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.25} className="text-slate-300" />
                <p className="mt-2">{t("debates.empty")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Inactive clubs ──────────────────────────────────────────────── */}
      {tab === "inactive" && (
        <div className="card-surface rounded-2xl overflow-x-auto">
          <div className="p-4 border-b border-line">
            <h3 className="flex items-center gap-2 font-semibold text-slate-800"><Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-500" />{t("inactive.title")}</h3>
          </div>
          {/* "Barcha klublar faol!" faqat javob KELGANDA va u haqiqatan
              bo'sh bo'lganda chiqadi. Ilgari u yuklanish paytida ham,
              so'rov yiqilganda ham chiqardi — tuman admini hamma klub
              talabni bajaryapti deb o'ylardi. */}
          {inactiveLoading ? (
            <div className="py-12 text-center text-slate-400">{t("inactive.loading")}</div>
          ) : inactiveError ? (
            <div className="p-5">
              <ErrorState
                title={t("inactive.errorTitle")}
                message={t("inactive.errorMessage")}
                onRetry={() => refetchInactive()}
              />
            </div>
          ) : !inactive || inactive.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-green-600">
              <Icon.success aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.5} />
              <p className="mt-2 font-medium">{t("inactive.allActive")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("inactive.thClub")}</th>
                  <th className="text-left px-4 py-3 text-slate-600 font-medium">{t("inactive.thInstitution")}</th>
                  <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("inactive.thMembers")}</th>
                  <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("inactive.thLastDebate")}</th>
                  <th className="text-center px-4 py-3 text-slate-600 font-medium">{t("inactive.thDaysWithout")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {inactive.map((c: {
                  clubId: string; clubName: string; institution: string;
                  memberCount: number; lastDebateAt: string | null; daysSinceDebate: number | null;
                }) => (
                  <tr key={c.clubId} className="hover:bg-red-50">
                    <td className="px-4 py-3 font-medium text-slate-900">{c.clubName}</td>
                    <td className="px-4 py-3 text-slate-600">{c.institution}</td>
                    <td className="px-4 py-3 text-center">{c.memberCount}</td>
                    <td className="px-4 py-3 text-center text-slate-500">
                      {c.lastDebateAt ? new Date(c.lastDebateAt).toLocaleDateString("uz-UZ") : t("inactive.never")}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        (c.daysSinceDebate ?? 999) > 60 ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"
                      }`}>
                        {c.daysSinceDebate != null ? t("inactive.daysCount", { count: c.daysSinceDebate }) : t("inactive.never")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </DashboardPage>
  );
}
