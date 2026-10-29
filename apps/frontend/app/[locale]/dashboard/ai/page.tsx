"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from "recharts";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";

// Barcha chaqiruvlar fetch-wrapper apiClient orqali — in-memory Bearer token
// biriktiriladi (+ boot refresh + 401→refresh→retry). Yuqori-risk ro'yxati
// endi <a href> bilan API'ga o'tmaydi (token ketmay 401 berardi) — apiClient
// orqali yuklanadi va ilova ichida jadvalda ko'rsatiladi.

interface NlqResponse {
  question: string;
  answer: string;
  data?: unknown;
  chartType?: "line" | "bar" | "pie" | "table" | "number";
  chartData?: unknown;
  confidence: number;
  usedLlm: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: NlqResponse;
  ts: string;
}

interface FraudStat {
  total: number;
  safe: number;
  low: number;
  review: number;
  blocked: number;
}

interface MonitoringData {
  fraudModel: {
    status: string;
    coverage: number;
    blockedLast30: number;
    fraudRate: number;
    stats: FraudStat;
  };
  auditEngine: {
    unresolvedAlerts: number;
    status: string;
  };
  lastChecked: string;
}

// Tavsiya savollar kalitlari — matnlari AiPanel ns dan olinadi (sq1..sq6).
const SUGGESTED_QUESTION_KEYS = ["sq1", "sq2", "sq3", "sq4", "sq5", "sq6"] as const;

function ChartRenderer({ response }: { response: NlqResponse }) {
  const data = response.chartData as Record<string, unknown>[];
  if (!data || data.length === 0) return null;

  if (response.chartType === "line" && Array.isArray(data) && "kitoblar" in (data[0] ?? {})) {
    return (
      <div className="mt-3 bg-white rounded-xl p-4 border border-line">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="oy" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Line
              type="monotone"
              dataKey="kitoblar"
              stroke="#2563eb"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (response.chartType === "bar" || (response.chartType === "line" && "value" in (data[0] ?? {}))) {
    return (
      <div className="mt-3 bg-white rounded-xl p-4 border border-line">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis dataKey="label" type="category" tick={{ fontSize: 11 }} width={140} />
            <Tooltip />
            <Bar dataKey="value" fill="#2563eb" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (response.chartType === "number") {
    return (
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
        {data.map((item, i) => (
          <div key={i} className="bg-white rounded-xl p-3 border border-line text-center">
            <div className="text-xl font-bold text-brand-700">{String(item.value)}</div>
            <div className="text-xs text-slate-500 mt-0.5">{String(item.label)}</div>
          </div>
        ))}
      </div>
    );
  }

  if (response.chartType === "table" && Array.isArray(data) && data.length > 0) {
    const keys = Object.keys(data[0] as object);
    return (
      <div className="mt-3 bg-white rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-muted">
                {keys.map((k) => (
                  <th key={k} className="px-3 py-2 text-left text-xs font-semibold text-slate-500">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(data as Record<string, unknown>[]).slice(0, 10).map((row, i) => (
                <tr key={i} className="hover:bg-surface-muted">
                  {keys.map((k) => (
                    <td key={k} className="px-3 py-2 text-slate-700">
                      {String(row[k] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return null;
}

function ConfidenceBadge({ confidence, usedLlm }: { confidence: number; usedLlm: boolean }) {
  const t = useTranslations("AiPanel");
  const pct = Math.round(confidence * 100);
  const color = pct >= 85 ? "text-green-700 bg-green-50" : pct >= 60 ? "text-yellow-700 bg-yellow-50" : "text-red-700 bg-red-50";
  return (
    <div className="flex items-center gap-2 mt-2">
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${color}`}>
        {t("confidence", { pct })}
      </span>
      {usedLlm && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-medium">
          <Icon.sparkle aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("llmEnriched")}
        </span>
      )}
    </div>
  );
}

export default function AiDashboardPage() {
  const t = useTranslations("AiPanel");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState<"chat" | "fraud" | "monitoring">("chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Yuqori risk ro'yxati — ilova ichida ko'rsatamiz (avval API'ga to'g'ridan
  // <a href> bilan o'tilardi → token ketmay 401 "Token topilmadi" chiqardi).
  type FraudRow = {
    id: string;
    riskScore: number;
    action?: string;
    flags?: unknown;
    user?: { name?: string; sifatId?: string; phone?: string; status?: string };
  };
  const [fraudList, setFraudList] = useState<FraudRow[] | null>(null);
  const [fraudLoading, setFraudLoading] = useState(false);
  const [checkMsg, setCheckMsg] = useState("");

  const loadFraudList = async () => {
    setFraudLoading(true);
    try {
      const res = await apiClient(`/ai/fraud/list?minRisk=50`);
      if (res.ok) setFraudList((await res.json()) as FraudRow[]);
      else setFraudList([]);
    } catch {
      setFraudList([]);
    } finally {
      setFraudLoading(false);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // AI query mutation
  const queryMutation = useMutation({
    mutationFn: async (question: string): Promise<NlqResponse> => {
      const res = await apiClient(`/ai/query`, {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? "Xato");
      return res.json();
    },
    onSuccess: (data, _question) => {
      const msg: ChatMessage = {
        id: Date.now().toString(),
        role: "assistant",
        content: data.answer,
        response: data,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, msg]);
    },
  });

  const handleSend = (question?: string) => {
    const q = question ?? input.trim();
    if (!q) return;

    // User xabari
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), role: "user", content: q, ts: new Date().toISOString() },
    ]);
    setInput("");
    queryMutation.mutate(q);
  };

  // Fraud stats
  const { data: fraudStats, isError: fraudStatsError, refetch: refetchFraudStats } = useQuery<FraudStat>({
    queryKey: ["fraud-stats"],
    queryFn: async () => {
      const res = await apiClient(`/ai/fraud/stats`);
      // Xato nol-statistika bo'lib ko'rinmasin — "0 bloklangan" degani
      // fraud yo'q emas, server javob bermadi degani bo'lishi mumkin.
      if (!res.ok) throw new Error("Fraud statistikasi yuklanmadi");
      return res.json();
    },
    enabled: activeTab === "fraud",
  });

  // Monitoring
  const { data: monitoring, isError: monitoringError, refetch: refetchMonitoring } = useQuery<MonitoringData>({
    queryKey: ["ai-monitoring"],
    queryFn: async () => {
      const res = await apiClient(`/ai/monitoring`);
      if (!res.ok) throw new Error("Xato");
      return res.json();
    },
    enabled: activeTab === "monitoring",
    refetchInterval: 60_000,
  });

  const tabs: { key: string; label: string; icon: LucideIcon; desc: string }[] = [
    { key: "chat",       label: t("tabChat"),       icon: Icon.sparkle, desc: "NL Interface" },
    { key: "fraud",      label: t("tabFraud"),      icon: Icon.shield,  desc: "Risk monitoring" },
    { key: "monitoring", label: t("tabMonitoring"), icon: Icon.stats,   desc: "Tizim holati" },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon.sparkle aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} /></span>{t("title")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t("subtitle")}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto bg-surface-sunken rounded-xl p-1 w-fit max-w-full">
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
            {(() => { const TabIcon = t.icon; return <TabIcon aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={activeTab === t.key ? 2.2 : 1.75} className="mr-1.5 inline" />; })()}
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Chat UI ── */}
      {activeTab === "chat" && (
        <div className="flex flex-col" style={{ height: "calc(100vh - 280px)" }}>
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
            {messages.length === 0 && (
              <div className="text-center py-12">
                <div className="mb-4 flex justify-center text-slate-300"><Icon.sparkle aria-hidden="true" size={40} strokeWidth={1.25} /></div>
                <h3 className="text-lg font-semibold text-slate-900 mb-2">
                  {t("emptyTitle")}
                </h3>
                <p className="text-sm text-slate-500 mb-6">
                  {t("emptySubtitle")}
                </p>
                <div className="grid grid-cols-2 gap-2 max-w-xl mx-auto">
                  {SUGGESTED_QUESTION_KEYS.map((k) => (
                    <button
                      key={k}
                      onClick={() => handleSend(t(k))}
                      className="text-left px-4 py-2.5 bg-surface-muted border border-line rounded-xl text-sm text-slate-700 hover:bg-blue-50 hover:border-brand-200 hover:text-brand-700 transition-colors"
                    >
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-2xl ${
                    msg.role === "user"
                      ? "bg-brand-600 text-white rounded-2xl rounded-br-sm px-4 py-3"
                      : "bg-white border border-line rounded-2xl rounded-bl-sm px-4 py-3"
                  }`}
                >
                  <p className="text-sm whitespace-pre-line">{msg.content}</p>
                  {msg.response && (
                    <>
                      <ChartRenderer response={msg.response} />
                      <ConfidenceBadge
                        confidence={msg.response.confidence}
                        usedLlm={msg.response.usedLlm}
                      />
                    </>
                  )}
                </div>
              </div>
            ))}

            {queryMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-white border border-line rounded-2xl rounded-bl-sm px-4 py-3">
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    {/* "Yozmoqda" nuqtalari — CSS doiralar. Matn glifi (●)
                        har shriftda boshqa o'lchamda va boshqa balandlikda
                        chiziladi, sakrash esa buni yanada ko'zga tashlaydi. */}
                    <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                    <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: "0.1s" }} />
                    <span aria-hidden="true" className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" style={{ animationDelay: "0.2s" }} />
                    <span className="ml-1">{t("thinking")}</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t("inputPlaceholder")}
              rows={2}
              className="flex-1 px-4 py-3 border border-line-strong rounded-2xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || queryMutation.isPending}
              className="px-5 py-3 bg-brand-600 text-white rounded-2xl font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              {t("send")}
            </button>
          </div>
        </div>
      )}

      {/* ── Fraud Detection ── */}
      {activeTab === "fraud" && (
        <div className="space-y-5">
          {fraudStatsError && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              <span>{t("fraudStatsError")}</span>
              <button onClick={() => refetchFraudStats()} className="min-h-9 rounded-lg border border-red-300 bg-white px-3 font-medium hover:bg-red-100">
                {t("retry")}
              </button>
            </div>
          )}
          {/* Stats cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            {[
              { label: t("statTotal"), value: fraudStats?.total ?? 0, color: "blue" },
              { label: t("statSafe"), value: fraudStats?.safe ?? 0, color: "green" },
              { label: t("statLow"), value: fraudStats?.low ?? 0, color: "yellow" },
              { label: t("statReview"), value: fraudStats?.review ?? 0, color: "orange" },
              { label: t("statBlocked"), value: fraudStats?.blocked ?? 0, color: "red" },
            ].map((s) => (
              <div key={s.label} className="bg-white rounded-2xl p-5 border border-line">
                <div className={`text-2xl font-bold text-${s.color}-600`}>{s.value}</div>
                <div className="text-xs text-slate-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Risk darajalar */}
          <div className="bg-white rounded-2xl p-6 border border-line">
            <h3 className="font-semibold text-slate-900 mb-4">{t("riskLevelsTitle")}</h3>
            <div className="space-y-3">
              {[
                { range: "0–24", label: t("riskSafe"), color: "bg-green-500", action: t("riskSafeAction") },
                { range: "25–49", label: t("riskLow"), color: "bg-yellow-500", action: t("riskLowAction") },
                { range: "50–69", label: t("riskReview"), color: "bg-orange-500", action: t("riskReviewAction") },
                { range: "70–100", label: t("riskBlocked"), color: "bg-red-500", action: t("riskBlockedAction") },
              ].map((r) => (
                <div key={r.range} className="flex items-center gap-4">
                  <div className={`w-3 h-3 rounded-full ${r.color} flex-shrink-0`} />
                  <span className="text-sm font-mono text-slate-500 w-14">{r.range}</span>
                  <span className="text-sm font-medium text-slate-900 w-24">{r.label}</span>
                  <span className="text-sm text-slate-500">{r.action}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={loadFraudList}
              disabled={fraudLoading}
              className="px-4 py-2 bg-red-600 text-white text-sm rounded-xl hover:bg-red-700 disabled:opacity-50"
            >
              <Icon.search aria-hidden="true" size={ICON_SIZE.sm} className="mr-1.5 inline" />{t("highRiskBtn")}
            </button>
            <button
              onClick={async () => {
                // Native alert() o'rniga sahifadagi status xabari.
                try {
                  const r = await apiClient(`/ai/fraud/top100-check`, { method: "POST" });
                  setCheckMsg(r.ok ? t("checkStarted") : t("checkFailed"));
                } catch {
                  setCheckMsg(t("checkFailed"));
                }
              }}
              className="px-4 py-2 bg-brand-600 text-white text-sm rounded-xl hover:bg-brand-700"
            >
              <Icon.check aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} className="mr-1.5 inline" />{t("top100Btn")}
            </button>
          </div>

          {checkMsg && (
            <p role="status" className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-800">
              {checkMsg}
            </p>
          )}

          {/* Yuqori risk natijalari */}
          {fraudLoading && (
            <div className="bg-white rounded-2xl p-6 text-center text-slate-400 border border-line">
              {t("loading")}
            </div>
          )}
          {fraudList && !fraudLoading && (
            <div className="card-surface rounded-2xl overflow-x-auto">
              <div className="px-5 py-3 border-b border-line text-sm font-semibold text-slate-700">
                {t("highRiskUsers", { count: fraudList.length })}
              </div>
              {fraudList.length === 0 ? (
                <div className="p-6 text-center text-slate-400 text-sm">
                  {t("highRiskEmpty")}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted text-slate-500 text-left">
                    <tr>
                      <th className="px-5 py-2 font-medium">{t("thUser")}</th>
                      <th className="px-5 py-2 font-medium">{t("thRisk")}</th>
                      <th className="px-5 py-2 font-medium">{t("thStatus")}</th>
                      <th className="px-5 py-2 font-medium">{t("thAction")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fraudList.map((f) => (
                      <tr key={f.id} className="border-t border-line">
                        <td className="px-5 py-2 text-slate-900">
                          {f.user?.name ?? "—"}
                          {f.user?.sifatId && (
                            <span className="ml-2 text-xs text-slate-400 font-mono">{f.user.sifatId}</span>
                          )}
                        </td>
                        <td className="px-5 py-2">
                          <span className={`font-semibold ${f.riskScore >= 70 ? "text-red-600" : "text-orange-500"}`}>
                            {f.riskScore}
                          </span>
                        </td>
                        <td className="px-5 py-2 text-slate-600">{f.user?.status ?? "—"}</td>
                        <td className="px-5 py-2 text-slate-600">{f.action ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Model Monitoring ── */}
      {activeTab === "monitoring" && (
        <div className="space-y-5">
          {monitoringError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
              <span>{t("monitoringError")}</span>
              <button onClick={() => refetchMonitoring()} className="min-h-9 rounded-lg border border-red-300 bg-white px-3 font-medium hover:bg-red-100">
                {t("retry")}
              </button>
            </div>
          ) : !monitoring ? (
            <div className="bg-white rounded-2xl p-8 text-center text-slate-400">{t("loading")}</div>
          ) : (
            <>
              {/* Fraud Model card */}
              <div className="bg-white rounded-2xl p-6 border border-line">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Icon.shield aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />{t("fraudModelTitle")}</h3>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${
                      monitoring.fraudModel.status === "healthy"
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {monitoring.fraudModel.status === "healthy" ? t("healthy") : t("problem")}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-brand-700">
                      {monitoring.fraudModel.coverage}%
                    </div>
                    <div className="text-xs text-slate-500">{t("coverage")}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-red-600">
                      {monitoring.fraudModel.blockedLast30}
                    </div>
                    <div className="text-xs text-slate-500">{t("blocked30")}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-600">
                      {monitoring.fraudModel.fraudRate}%
                    </div>
                    <div className="text-xs text-slate-500">{t("fraudRate")}</div>
                  </div>
                </div>
              </div>

              {/* Audit Engine card */}
              <div className="bg-white rounded-2xl p-6 border border-line">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="flex items-center gap-2 font-semibold text-slate-900"><Icon.search aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />{t("auditEngine")}</h3>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${
                      monitoring.auditEngine.status === "healthy"
                        ? "bg-green-100 text-green-700"
                        : monitoring.auditEngine.status === "warning"
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {monitoring.auditEngine.status === "healthy"
                      ? t("healthy")
                      : monitoring.auditEngine.status === "warning"
                      ? t("warning")
                      : t("critical")}
                  </span>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold text-slate-900">
                    {monitoring.auditEngine.unresolvedAlerts}
                  </div>
                  <div className="text-sm text-slate-500">{t("unresolvedAlerts")}</div>
                </div>
              </div>

              {/* Scheduled jobs info */}
              <div className="bg-surface-muted rounded-2xl p-5 border border-line">
                <h4 className="flex items-center gap-2 font-semibold text-slate-700 mb-3 text-sm">
                  <Icon.pending aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("schedulesTitle")}
                </h4>
                <div className="space-y-2 text-sm text-slate-600">
                  <div className="flex justify-between">
                    <span>{t("jobDailyFraud")}</span>
                    <span className="text-slate-400">{t("jobDailyFraudTime")}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("jobAudit")}</span>
                    <span className="text-slate-400">{t("jobAuditTime")}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("jobTop100")}</span>
                    <span className="text-slate-400">{t("jobTop100Time")}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t("jobReports")}</span>
                    <span className="text-slate-400">{t("jobReportsTime")}</span>
                  </div>
                </div>
                <div className="mt-3 text-xs text-slate-400">
                  {t("lastChecked", { date: new Date(monitoring.lastChecked).toLocaleString("uz-UZ") })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
