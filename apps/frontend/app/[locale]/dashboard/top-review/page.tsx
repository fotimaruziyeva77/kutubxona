"use client";

/**
 * /dashboard/top-review — TOP-07 admin review queue (Plan 03-04).
 *
 * Lists all non-CONFIRMED Top-100 entries for the current (or chosen) month
 * during the 30→1 review window. Each row has four actions:
 *   - Flag    → POST /top/:month/flag/:userId      (status → FLAGGED)
 *   - Clear   → POST /top/:month/clear/:userId     (status → FRAUD_CHECKED)
 *   - Reject  → POST /top/:month/reject/:userId    (status → REJECTED)
 *   - Confirm → POST /top/:month/confirm/:userId   (status → CONFIRMED)
 *
 * Bulk action:
 *   - Force Publish → POST /top/:month/confirm     (DRAFT bulk → CONFIRMED)
 *
 * Role gate: SUPER_ADMIN only (Plan 03-02 endpoint already enforces this;
 * the sidebar layout also hides the link for non-SUPER_ADMIN users).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Icon } from "@/components/ui/icon";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";

// ── Types ────────────────────────────────────────────────────────────────────

type ReviewEntry = {
  id: string;
  userId: string;
  month: string;
  rank: number;
  score: number;
  status:
    | "DRAFT"
    | "FRAUD_CHECKED"
    | "READY_FOR_PUBLISH"
    | "FLAGGED"
    | "REJECTED";
  components: Record<string, unknown>;
  user: {
    name: string;
    sifatId?: string;
    trustScore: number;
  };
};

type ReviewQueueResponse = {
  month: string;
  count: number;
  entries: ReviewEntry[];
};

// ── API ───────────────────────────────────────────────────────────────────────

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function fetchReviewQueue(month: string): Promise<ReviewQueueResponse> {
  const res = await apiClient(`/top/admin/review-queue?month=${month}`);
  // Xatoni bo'sh ro'yxatga aylantirmaymiz. Aks holda backend ishlamay
  // qolganda ekranda yashil belgi bilan "tekshiriladigan yozuv yo'q" chiqadi
  // va admin Top-100 ni tekshirmasdan tasdiqlaydi.
  if (!res.ok) {
    throw new Error(res.status === 403 ? "FORBIDDEN" : "Navbatni yuklab bo'lmadi");
  }
  return res.json();
}

type Action = "flag" | "clear" | "reject" | "confirm";

async function postAction(month: string, userId: string, action: Action) {
  const res = await apiClient(`/top/${month}/${action}/${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`${action} failed`);
  return res.json();
}

async function forcePublishMonth(month: string) {
  const res = await apiClient(`/top/${month}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error("force-publish failed");
  return res.json();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<ReviewEntry["status"], string> = {
  DRAFT: "bg-surface-sunken text-slate-700",
  FRAUD_CHECKED: "bg-brand-100 text-brand-700",
  READY_FOR_PUBLISH: "bg-emerald-100 text-emerald-700",
  FLAGGED: "bg-accent-100 text-accent-700",
  REJECTED: "bg-red-100 text-red-700",
};

function flagReasonsOf(components: Record<string, unknown>): string[] {
  const r = components?.flagReasons;
  if (Array.isArray(r)) return r.map((x) => String(x));
  if (typeof components?.flagReason === "string") return [components.flagReason as string];
  return [];
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TopReviewPage() {
  const t = useTranslations("TopReviewPanel");
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>(thisMonth());
  const [pending, setPending] = useState<{ userId: string; action: Action } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["top-review", month],
    queryFn: () => fetchReviewQueue(month),
    staleTime: 30_000,
    retry: false,
  });
  const isForbidden = isError && (error as Error)?.message === "FORBIDDEN";

  const actionMut = useMutation({
    mutationFn: (input: { userId: string; action: Action }) =>
      postAction(month, input.userId, input.action),
    onMutate: (input) => setPending(input),
    onSuccess: (_data, input) => {
      showToast(t("statusChanged", { action: input.action }));
    },
    onError: () => showToast(t("actionError")),
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ["top-review"] });
    },
  });

  const publishMut = useMutation({
    mutationFn: () => forcePublishMonth(month),
    onSuccess: () => showToast(t("publishOk")),
    onError: () => showToast(t("publishFail")),
    onSettled: () => qc.invalidateQueries({ queryKey: ["top-review"] }),
  });

  const entries = data?.entries ?? [];

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-brand-600 text-white px-4 py-3 rounded-xl shadow-lg text-sm font-medium">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {t("title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("subtitle", { count: entries.length })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 border border-line rounded-xl text-sm"
          />
          <button
            onClick={() => publishMut.mutate()}
            disabled={publishMut.isPending}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-40"
          >
            {t("forcePublish")}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">{t("loading")}</div>
      ) : isForbidden ? (
        <ForbiddenState message={t("forbidden")} />
      ) : isError ? (
        <ErrorState
          title={t("errTitle")}
          message={t("errMsg")}
          onRetry={() => refetch()}
          isRetrying={isFetching}
        />
      ) : entries.length === 0 ? (
        <div className="text-center py-16 card-surface rounded-2xl">
          <Icon.success aria-hidden="true" size={32} strokeWidth={1.5} className="mx-auto text-green-500" />
          <p className="text-slate-400">
            {t("emptyMonth", { month })}
          </p>
        </div>
      ) : (
        <div className="card-surface rounded-2xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted border-b border-line">
              <tr className="text-left text-xs text-slate-500 uppercase">
                <th className="px-4 py-3 font-medium">{t("thRank")}</th>
                <th className="px-4 py-3 font-medium">{t("thUser")}</th>
                <th className="px-4 py-3 font-medium">{t("thScore")}</th>
                <th className="px-4 py-3 font-medium">{t("thTrust")}</th>
                <th className="px-4 py-3 font-medium">{t("thStatus")}</th>
                <th className="px-4 py-3 font-medium">{t("thFlagReasons")}</th>
                <th className="px-4 py-3 font-medium text-right">{t("thActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => {
                const isPendingHere = pending?.userId === e.userId;
                const reasons = flagReasonsOf(e.components ?? {});
                return (
                  <tr key={e.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-3 font-mono text-slate-600">#{e.rank}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{e.user.name}</div>
                      {e.user.sifatId && (
                        <div className="text-xs text-slate-400 font-mono">
                          {e.user.sifatId}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold text-brand-700">
                      {e.score.toFixed(1)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{e.user.trustScore}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          STATUS_STYLES[e.status]
                        }`}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {reasons.length > 0 ? (
                        <div className="flex gap-1 flex-wrap">
                          {reasons.map((r) => (
                            <span
                              key={r}
                              className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded font-mono"
                            >
                              {r}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5 justify-end">
                        <button
                          onClick={() =>
                            actionMut.mutate({ userId: e.userId, action: "flag" })
                          }
                          disabled={isPendingHere || e.status === "FLAGGED"}
                          className="px-2 py-1 text-xs bg-accent-100 text-accent-700 rounded hover:bg-amber-200 disabled:opacity-30"
                        >
                          {t("flag")}
                        </button>
                        <button
                          onClick={() =>
                            actionMut.mutate({ userId: e.userId, action: "clear" })
                          }
                          disabled={isPendingHere || e.status !== "FLAGGED"}
                          className="px-2 py-1 text-xs bg-brand-100 text-brand-700 rounded hover:bg-blue-200 disabled:opacity-30"
                        >
                          {t("clear")}
                        </button>
                        <button
                          onClick={() =>
                            actionMut.mutate({ userId: e.userId, action: "reject" })
                          }
                          disabled={isPendingHere || e.status === "REJECTED"}
                          className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-30"
                        >
                          {t("reject")}
                        </button>
                        <button
                          onClick={() =>
                            actionMut.mutate({ userId: e.userId, action: "confirm" })
                          }
                          disabled={isPendingHere}
                          className="px-2 py-1 text-xs bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 disabled:opacity-30"
                        >
                          {t("confirm")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
