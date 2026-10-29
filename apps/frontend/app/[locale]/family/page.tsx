"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiBase } from "@/lib/api/base";
import { useLocale, useTranslations } from "next-intl";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { RankMedal } from "@/components/dashboard/ui";

// H18: canonical `<origin>/api` (the ":3000/api/v1" fallback was a bug —
// frontend port + a version prefix the backend never served).
const API = apiBase();

interface FamilyMember {
  id: string;
  name: string;
  phone: string;
  joinedFamilyAt: string;
  latestRi?: number;
  isEligibleForRating: boolean; // 30 days passed
}

interface FamilyData {
  id: string;
  name: string;
  avgRi: number;
  members: FamilyMember[];
  createdAt: string;
}

interface FamilyRating {
  month: string;
  avgScore: number;
  totalBooks: number;
  memberCount: number;
  rank: number | null;
  viloyatRank: number | null;
  tumanRank: number | null;
}

interface TopFamily {
  id: string;
  name: string;
  avgScore: number;
  totalBooks: number;
  memberCount: number;
  rank: number;
}

interface FamilySuggestion {
  userId: string;
  name: string;
  phone: string;
  address: string;
}

function RiBadge({ score }: { score?: number }) {
  if (score === undefined) return <span className="text-slate-400 text-xs">—</span>;
  const color =
    score >= 75
      ? "bg-green-100 text-green-700"
      : score >= 50
      ? "bg-yellow-100 text-yellow-700"
      : "bg-red-100 text-red-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
      {score.toFixed(1)}
    </span>
  );
}

function RankBadge({ rank, label }: { rank: number | null; label: string }) {
  if (!rank) return null;
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1.5 text-2xl font-bold text-brand-700">
        {rank <= 3 && (
          <Icon.medal aria-hidden="true" size={ICON_SIZE.md} strokeWidth={2} className="text-accent-600" />
        )}
        {rank <= 3 ? rank : `#${rank}`}
      </div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function FamilyPage() {
  const locale = useLocale();
  const t = useTranslations("FamilyPage");
  const { user, token } = useAuthStore();
  const qc = useQueryClient();

  const [invitePhone, setInvitePhone] = useState("");
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [activeTab, setActiveTab] = useState<"profile" | "rating" | "top">("profile");
  const [topMonth, setTopMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Fetch my family
  const { data: family, isLoading: familyLoading } = useQuery<FamilyData | null>({
    queryKey: ["my-family", user?.id],
    queryFn: async () => {
      if (!user?.familyId) return null;
      const res = await fetch(`${API}/family/${user.familyId}`, { headers });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!user,
  });

  // Fetch suggestions (only if no family)
  const { data: suggestions } = useQuery<FamilySuggestion[]>({
    queryKey: ["family-suggest", user?.id],
    queryFn: async () => {
      const res = await fetch(`${API}/family/suggest/${user!.id}`, { headers });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && !user?.familyId,
  });

  // Fetch my family rating
  const { data: myRating } = useQuery<FamilyRating | null>({
    queryKey: ["family-rating", user?.familyId],
    queryFn: async () => {
      if (!user?.familyId) return null;
      const res = await fetch(`${API}/family/${user.familyId}/rating`, { headers });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!user?.familyId,
  });

  // Fetch top families
  const { data: topFamilies, isLoading: topLoading } = useQuery<TopFamily[]>({
    queryKey: ["top-families", topMonth],
    queryFn: async () => {
      const res = await fetch(`${API}/family/ratings/top?month=${topMonth}&limit=50`, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return data.items ?? data;
    },
  });

  // Create family
  const createFamily = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/family`, {
        method: "POST",
        headers,
        body: JSON.stringify({ creatorId: user!.id }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? t("error"));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-family"] }),
  });

  // Invite member
  const inviteMember = useMutation({
    mutationFn: async (inviteePhone: string) => {
      const res = await fetch(`${API}/family/${family!.id}/invite`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inviterId: user!.id, inviteePhone }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? t("error"));
      return res.json();
    },
    onSuccess: () => {
      setInvitePhone("");
      setShowInviteForm(false);
      qc.invalidateQueries({ queryKey: ["my-family"] });
    },
  });

  // Leave family
  const leaveFamily = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API}/family/leave/${user!.id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error((await res.json()).message ?? t("error"));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-family"] }),
  });

  // Accept suggestion (create family with suggested member)
  const acceptSuggestion = useMutation({
    mutationFn: async (suggestedUserId: string) => {
      // First create family, then invite
      const createRes = await fetch(`${API}/family`, {
        method: "POST",
        headers,
        body: JSON.stringify({ creatorId: user!.id }),
      });
      if (!createRes.ok) throw new Error(t("createError"));
      const newFamily = await createRes.json();
      const inviteRes = await fetch(`${API}/family/${newFamily.id}/invite`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inviterId: user!.id, inviteeId: suggestedUserId }),
      });
      if (!inviteRes.ok) throw new Error(t("inviteError"));
      return newFamily;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-family", "family-suggest"] }),
  });

  const tabs = [
    { key: "profile", label: t("tabProfile") },
    { key: "rating", label: t("tabRating") },
    { key: "top", label: t("tabTop") },
  ];

  return (
    <ReaderShell
      title={t("title")}
      subtitle={t("subtitle")}
      backHref={`/${locale}/profile`}
    >

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-sunken rounded-xl p-1 mb-6 w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key as typeof activeTab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === t.key
                ? "bg-white text-brand-700 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── TAB: PROFILE ── */}
      {activeTab === "profile" && (
        <div className="space-y-6">
          {familyLoading ? (
            <div className="bg-white rounded-2xl p-8 text-center text-slate-400">{t("loading")}</div>
          ) : !family ? (
            /* No family yet */
            <div className="space-y-4">
              {/* Suggestion card */}
              {suggestions && suggestions.length > 0 && (
                <div className="bg-blue-50 border border-brand-200 rounded-2xl p-5">
                  <h3 className="flex items-center gap-2 font-semibold text-blue-800 mb-3">
                    <Icon.household aria-hidden="true" size={ICON_SIZE.sm} />
                    {t("suggestionsTitle")}
                  </h3>
                  <p className="text-sm text-brand-700 mb-4">
                    {t("suggestionsHint")}
                  </p>
                  <div className="space-y-3">
                    {suggestions.map((s) => (
                      <div
                        key={s.userId}
                        className="flex items-center justify-between bg-white rounded-xl p-3"
                      >
                        <div>
                          <div className="font-medium text-slate-900">{s.name}</div>
                          <div className="text-xs text-slate-500">{s.address}</div>
                        </div>
                        <button
                          onClick={() => acceptSuggestion.mutate(s.userId)}
                          disabled={acceptSuggestion.isPending}
                          className="px-3 py-1.5 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-50"
                        >
                          {t("createWith")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Create family */}
              <div className="bg-white rounded-2xl p-8 text-center border border-line">
                <Icon.family aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-4 text-slate-300" />
                <h3 className="text-lg font-semibold text-slate-900 mb-2">
                  {t("noFamilyTitle")}
                </h3>
                <p className="text-sm text-slate-500 mb-6 max-w-sm mx-auto">
                  {t("noFamilyHint")}
                </p>
                <button
                  onClick={() => createFamily.mutate()}
                  disabled={createFamily.isPending}
                  className="px-6 py-2.5 bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700 disabled:opacity-50"
                >
                  {createFamily.isPending ? t("creating") : t("createFamily")}
                </button>
                {createFamily.isError && (
                  <p className="text-red-600 text-sm mt-2">
                    {(createFamily.error as Error).message}
                  </p>
                )}
              </div>

              {/* Protection rules info */}
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <h4 className="flex items-center gap-2 font-semibold text-amber-800 mb-2">
                  <Icon.info aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("rulesTitle")}
                </h4>
                <ul className="text-sm text-amber-700 space-y-1.5">
                  <li>• {t.rich("rule30", { strong: (c) => <strong>{c}</strong> })}</li>
                  <li>• {t.rich("ruleOne", { strong: (c) => <strong>{c}</strong> })}</li>
                  <li>• {t("ruleAddress")}</li>
                  <li>• {t.rich("ruleMax", { strong: (c) => <strong>{c}</strong> })}</li>
                </ul>
              </div>
            </div>
          ) : (
            /* Family profile */
            <div className="space-y-5">
              {/* Family header card */}
              <div className="bg-white rounded-2xl p-6 border border-line">
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">{family.name}</h2>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {t("memberSince", {
                        count: family.members.length,
                        date: new Date(family.createdAt).toLocaleDateString("uz-UZ"),
                      })}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-3xl font-bold text-brand-700">{family.avgRi.toFixed(1)}</div>
                    <div className="text-xs text-slate-500">{t("avgRi")}</div>
                  </div>
                </div>

                {/* RI progress bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>{t("familyRi")}</span>
                    <span>{family.avgRi.toFixed(1)} / 100</span>
                  </div>
                  <div className="h-3 bg-surface-sunken rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all"
                      style={{ width: `${Math.min(family.avgRi, 100)}%` }}
                    />
                  </div>
                </div>

                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => setShowInviteForm(!showInviteForm)}
                    className="px-4 py-2 bg-brand-600 text-white text-sm rounded-xl hover:bg-brand-700"
                  >
                    {t("invite")}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(t("leaveConfirm"))) leaveFamily.mutate();
                    }}
                    disabled={leaveFamily.isPending}
                    className="px-4 py-2 border border-red-200 text-red-600 text-sm rounded-xl hover:bg-red-50 disabled:opacity-50"
                  >
                    {t("leave")}
                  </button>
                </div>

                {/* Invite form */}
                {showInviteForm && (
                  <div className="mt-4 p-4 bg-surface-muted rounded-xl border border-line">
                    <p className="text-sm font-medium text-slate-700 mb-3">
                      {t("invitePrompt")}
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="tel"
                        placeholder="+998901234567"
                        value={invitePhone}
                        onChange={(e) => setInvitePhone(e.target.value)}
                        className="flex-1 px-3 py-2 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                      <button
                        onClick={() => inviteMember.mutate(invitePhone)}
                        disabled={inviteMember.isPending || !invitePhone.trim()}
                        className="px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-50"
                      >
                        {inviteMember.isPending ? "…" : t("send")}
                      </button>
                    </div>
                    {inviteMember.isError && (
                      <p className="text-red-600 text-sm mt-2">
                        {(inviteMember.error as Error).message}
                      </p>
                    )}
                    {inviteMember.isSuccess && (
                      <p className="flex items-center gap-1.5 text-green-600 text-sm mt-2">
                        <Icon.check aria-hidden="true" size={ICON_SIZE.sm} />
                        {t("inviteSent")}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Members list */}
              <div className="card-surface rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-line">
                  <h3 className="font-semibold text-slate-900">{t("members", { count: family.members.length })}</h3>
                </div>
                <div className="divide-y divide-gray-50">
                  {family.members.map((member, _idx) => {
                    const joinDate = new Date(member.joinedFamilyAt);
                    const daysSinceJoin = Math.floor(
                      (Date.now() - joinDate.getTime()) / (1000 * 60 * 60 * 24)
                    );
                    const daysLeft = Math.max(0, 30 - daysSinceJoin);

                    return (
                      <div key={member.id} className="flex items-center gap-4 px-5 py-3.5">
                        <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-brand-700 font-bold text-sm flex-shrink-0">
                          {member.name.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-900 truncate">
                              {member.name}
                            </span>
                            {member.id === user?.id && (
                              <span className="text-xs bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded">
                                {t("you")}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500">
                            {t("memberFrom", { date: joinDate.toLocaleDateString("uz-UZ") })}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {!member.isEligibleForRating ? (
                            <span className="inline-flex items-center gap-1 text-xs text-accent-600 bg-amber-50 px-2 py-1 rounded-lg">
                              <Icon.pending aria-hidden="true" size={ICON_SIZE.xs} />
                              {t("waitDays", { count: daysLeft })}
                            </span>
                          ) : (
                            <RiBadge score={member.latestRi} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Protection rules reminder */}
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <h4 className="flex items-center gap-2 font-semibold text-amber-800 mb-2">
                  <Icon.shield aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("protectionTitle")}
                </h4>
                <ul className="text-sm text-amber-700 space-y-1">
                  <li>• {t.rich("protection30", { strong: (c) => <strong>{c}</strong> })}</li>
                  <li className="flex items-center gap-1">
                    •
                    <Icon.pending aria-hidden="true" size={ICON_SIZE.xs} />
                    {t("protectionIcon")}
                  </li>
                  <li>• {t.rich("protectionOne", { strong: (c) => <strong>{c}</strong> })}</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: RATING ── */}
      {activeTab === "rating" && (
        <div className="space-y-5">
          {!family ? (
            <div className="bg-white rounded-2xl p-8 text-center text-slate-400">
              {t("needFamily")}
            </div>
          ) : !myRating ? (
            <div className="bg-white rounded-2xl p-8 text-center">
              <Icon.stats aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-3 text-slate-300" />
              <p className="text-slate-500">{t("noRating")}</p>
              <p className="text-sm text-slate-400 mt-1">
                {t("noRatingHint")}
              </p>
            </div>
          ) : (
            <>
              {/* Rank cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-2xl p-5 border border-line text-center">
                  <RankBadge rank={myRating.rank} label={t("republic")} />
                  {!myRating.rank && <span className="text-slate-400 text-lg">—</span>}
                </div>
                <div className="bg-white rounded-2xl p-5 border border-line text-center">
                  <RankBadge rank={myRating.viloyatRank} label={t("region")} />
                  {!myRating.viloyatRank && <span className="text-slate-400 text-lg">—</span>}
                </div>
                <div className="bg-white rounded-2xl p-5 border border-line text-center">
                  <RankBadge rank={myRating.tumanRank} label={t("district")} />
                  {!myRating.tumanRank && <span className="text-slate-400 text-lg">—</span>}
                </div>
              </div>

              {/* Stats */}
              <div className="bg-white rounded-2xl p-6 border border-line">
                <h3 className="font-semibold text-slate-900 mb-4">
                  {t("statsTitle", { month: myRating.month })}
                </h3>
                <div className="grid grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-brand-700">
                      {myRating.avgScore.toFixed(1)}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{t("avgScore")}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-600">
                      {myRating.totalBooks}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{t("totalBooks")}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-purple-600">
                      {myRating.memberCount}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{t("activeMembers")}</div>
                  </div>
                </div>

                <div className="mt-5">
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>{t("familyRating")}</span>
                    <span>{myRating.avgScore.toFixed(1)} / 100</span>
                  </div>
                  <div className="h-3 bg-surface-sunken rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-purple-500 to-blue-600 rounded-full"
                      style={{ width: `${Math.min(myRating.avgScore, 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Rating formula */}
              <div className="bg-surface-muted rounded-2xl p-4 border border-line">
                <h4 className="flex items-center gap-2 font-semibold text-slate-700 mb-3 text-sm">
                  <Icon.formula aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("formulaTitle")}
                </h4>
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-brand-500 rounded-full" />
                    {t("formulaRi")}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-green-500 rounded-full" />
                    {t("formulaBooks")}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 bg-purple-500 rounded-full" />
                    {t("formulaActivity")}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── TAB: TOP FAMILIES ── */}
      {activeTab === "top" && (
        <div className="space-y-5">
          {/* Month selector */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-slate-700">{t("month")}</label>
            <input
              type="month"
              value={topMonth}
              onChange={(e) => setTopMonth(e.target.value)}
              className="px-3 py-1.5 border border-line-strong rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          {/* Leaderboard */}
          <div className="card-surface rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-line flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-semibold text-slate-900">
                <Icon.trophy aria-hidden="true" size={ICON_SIZE.sm} />
                {t("topTitle", { month: topMonth })}
              </h3>
              <span className="text-xs text-slate-500">{t("familiesCount", { count: topFamilies?.length ?? 0 })}</span>
            </div>

            {topLoading ? (
              <div className="p-8 text-center text-slate-400">{t("loading")}</div>
            ) : !topFamilies || topFamilies.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                {t("noData")}
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {topFamilies.map((fam) => {
                  const isMe = family?.id === fam.id;

                  return (
                    <div
                      key={fam.id}
                      className={`flex items-center gap-4 px-5 py-3.5 ${
                        isMe ? "bg-blue-50 border-l-4 border-blue-500" : ""
                      }`}
                    >
                      <div className="w-10 flex justify-center flex-shrink-0">
                        <RankMedal rank={fam.rank} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-900 truncate">{fam.name}</span>
                          {isMe && (
                            <span className="text-xs bg-brand-600 text-white px-1.5 py-0.5 rounded">
                              {t("yourFamily")}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500">
                          {t("memberBooks", { members: fam.memberCount, books: fam.totalBooks })}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <div className="text-lg font-bold text-brand-700">
                          {fam.avgScore.toFixed(1)}
                        </div>
                        <div className="text-xs text-slate-400">{t("ball")}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Note about privacy */}
          <p className="flex items-center justify-center gap-1.5 px-4 text-center text-xs text-slate-400">
            <Icon.locked aria-hidden="true" size={12} />
            {t("privacyNote")}
          </p>
        </div>
      )}
    </ReaderShell>
  );
}
