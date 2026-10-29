"use client";

/**
 * /dashboard/fraud-review — FRAUD-03 (Plan 02-04)
 *
 * Admin review queue UI. Replaces the auto-block behaviour with an
 * approve/reject decision per FLAGGED user. Scoping is enforced on the
 * backend (SUPER_ADMIN sees all; TUMAN/VILOYAT see only their region).
 *
 * Endpoints:
 *   GET  /api/ai/fraud/review-queue?limit=&offset=
 *   POST /api/ai/fraud/:userId/resolve   { decision, notes? }
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";
import { ConfirmModal } from "@/components/ui/confirm-modal";

type ReviewItem = {
  id: string;
  userId: string;
  riskScore: number;
  flags: string[] | string;
  action: string;
  checkedAt: string;
  user: {
    id: string;
    name: string;
    phone: string;
    sifatId?: string | null;
    status: string;
    trustScore: number;
    address?: { viloyatId?: string; tumanId?: string; mahallaId?: string } | null;
  };
};

type ReviewQueueResponse = {
  items: ReviewItem[];
  total: number;
  limit: number;
  offset: number;
};

async function fetchReviewQueue(): Promise<ReviewQueueResponse> {
  const res = await apiClient("/ai/fraud/review-queue?limit=50&offset=0");
  // Xatoni bo'sh navbatga aylantirmaymiz — aks holda backend yiqilganda
  // ekranda yashil belgi bilan "fraud aniqlanmadi" chiqadi va admin
  // shubhali akkauntlarni ko'rmasdan qoladi.
  if (!res.ok) {
    throw new Error(res.status === 403 ? "FORBIDDEN" : "Navbatni yuklab bo'lmadi");
  }
  return res.json();
}

async function resolveReview(input: {
  userId: string;
  decision: "approve" | "reject";
  notes?: string;
}) {
  const res = await apiClient(`/ai/fraud/${encodeURIComponent(input.userId)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: input.decision, notes: input.notes }),
  });
  if (!res.ok) throw new Error("Hal qilib bo'lmadi");
  return res.json();
}

function flagsToList(flags: ReviewItem["flags"]): string[] {
  if (Array.isArray(flags)) return flags;
  if (typeof flags === "string") {
    try {
      const parsed = JSON.parse(flags);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [flags];
    }
  }
  return [];
}

export default function FraudReviewPage() {
  const t = useTranslations("FraudPanel");
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Qaytarilmas qaror oldidan tasdiq: {userId, name, decision}
  const [confirming, setConfirming] = useState<{
    userId: string;
    name: string;
    decision: "approve" | "reject";
  } | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["fraud-review-queue"],
    queryFn: fetchReviewQueue,
    staleTime: 30_000,
    refetchInterval: 120_000,
    retry: false,
  });
  const isForbidden = isError && (error as Error)?.message === "FORBIDDEN";

  const resolveMut = useMutation({
    mutationFn: resolveReview,
    onMutate: ({ userId }) => setPendingId(userId),
    onSettled: () => {
      setPendingId(null);
      qc.invalidateQueries({ queryKey: ["fraud-review-queue"] });
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon.shield aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} /></span>
          {t("title")}
        </h1>
        <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-sm font-medium">
          {t("reviewCount", { count: items.length })}
        </span>
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
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center card-surface rounded-xl py-16 text-center">
          <Icon.success aria-hidden="true" size={32} strokeWidth={1.5} className="text-green-500" />
          <p className="mt-2 text-slate-400">{t("empty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const flagList = flagsToList(item.flags);
            const isPending = pendingId === item.userId;
            return (
              <div
                key={item.id}
                className="card-surface rounded-2xl p-5"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <h3 className="font-semibold text-slate-800">{item.user.name}</h3>
                      {item.user.sifatId && (
                        <span className="text-xs font-mono text-slate-400">
                          {item.user.sifatId}
                        </span>
                      )}
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          item.riskScore >= 70
                            ? "bg-red-100 text-red-700"
                            : item.riskScore >= 50
                              ? "bg-orange-100 text-orange-700"
                              : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {t("risk", { score: item.riskScore })}
                      </span>
                      <span className="text-xs text-slate-500">
                        {t("trust", { score: item.user.trustScore })}
                      </span>
                    </div>
                    <div className="flex gap-4 text-sm text-slate-500 mb-2">
                      <span className="inline-flex items-center gap-1"><Icon.phone aria-hidden="true" size={ICON_SIZE.xs} />{item.user.phone}</span>
                      <span className="text-slate-400 text-xs">
                        {new Date(item.checkedAt).toLocaleString("uz-UZ")}
                      </span>
                    </div>
                    {flagList.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap">
                        {flagList.map((f) => (
                          <span
                            key={f}
                            className="text-xs bg-surface-sunken text-slate-700 px-2 py-0.5 rounded font-mono"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Qaror qaytarilmas — bitta noto'g'ri bosish odamni
                      fraudga chiqaradi yoki fraudni oqlaydi. Shu sabab avval
                      ConfirmModal, keyin mutate. */}
                  <div className="flex gap-3 shrink-0">
                    <button
                      onClick={() =>
                        setConfirming({ userId: item.userId, name: item.user.name, decision: "approve" })
                      }
                      disabled={isPending}
                      className="min-h-11 px-4 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-40"
                    >
                      <Icon.check aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} className="mr-1 inline" />{t("approveBtn")}
                    </button>
                    <button
                      onClick={() =>
                        setConfirming({ userId: item.userId, name: item.user.name, decision: "reject" })
                      }
                      disabled={isPending}
                      className="min-h-11 px-4 border border-red-200 bg-white text-red-700 rounded-xl text-sm font-medium hover:bg-red-50 disabled:opacity-40"
                    >
                      <Icon.close aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} className="mr-1 inline" />{t("rejectBtn")}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={!!confirming}
        title={confirming?.decision === "approve" ? t("approveTitle") : t("rejectTitle")}
        description={
          confirming
            ? confirming.decision === "approve"
              ? t("approveDesc", { name: confirming.name })
              : t("rejectDesc", { name: confirming.name })
            : undefined
        }
        confirmLabel={confirming?.decision === "approve" ? t("approveConfirm") : t("rejectConfirm")}
        variant={confirming?.decision === "reject" ? "destructive" : "default"}
        isPending={resolveMut.isPending}
        onConfirm={() => {
          if (!confirming) return;
          resolveMut.mutate(
            { userId: confirming.userId, decision: confirming.decision },
            { onSettled: () => setConfirming(null) },
          );
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
