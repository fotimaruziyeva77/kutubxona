"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { responseErrorMessage, thrownErrorMessage } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkeletonCardList, Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/ui/icon";

type PendingUser = {
  id: string;
  name: string;
  phone: string;
  type: string;
  sifatId?: string;
  createdAt: string;
  address?: { viloyatId: string; tumanId: string };
};

// Tur yorliqlari PendingPanel.types.* tarjima kalitlaridan olinadi.
const TYPE_KEYS: string[] = [
  "CITIZEN",
  "STUDENT_SCHOOL",
  "STUDENT_UNIVERSITY",
  "GOVERNMENT_EMPLOYEE",
  "TEACHER",
];

/**
 * Ilgari bu funksiya xatoni YUTARDI (`if (!res.ok) return []`) — natijada
 * 403 yoki 500 ekranda "ariza yo'q" bo'lib ko'rinardi va admin tasdiqlash
 * navbati bo'sh deb o'ylardi. Endi xato yuqoriga uzatiladi va React Query
 * uni `isError` orqali ko'rsatadi.
 */
async function fetchPending(): Promise<PendingUser[]> {
  const res = await apiClient("/admin/users/pending");
  if (!res.ok) {
    const err = new Error(await responseErrorMessage(res));
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json();
}

async function approveUser(id: string) {
  const res = await apiClient(`/admin/users/${id}/approve`, { method: "PATCH" });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}

async function rejectUser({ id, reason }: { id: string; reason: string }) {
  const res = await apiClient(`/admin/users/${id}/reject`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // Sabab rad etilgan foydalanuvchiga SMS orqali yetib boradi.
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw new Error(await responseErrorMessage(res));
  return res.json();
}

const MIN_REASON = 3;

export default function PendingUsersPage() {
  const t = useTranslations("PendingPanel");
  const qc = useQueryClient();
  const toast = useToast();

  // Tasdiqlash modallari: bir vaqtda bittasi ochiq bo'ladi.
  const [confirming, setConfirming] = useState<PendingUser | null>(null);
  const [rejecting, setRejecting] = useState<PendingUser | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const {
    data: users = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["pending-users"],
    queryFn: fetchPending,
    staleTime: 60_000,
    refetchInterval: 120_000,
    // 403 — huquq muammosi, qayta so'rash foydasiz.
    retry: (count, err) =>
      (err as { status?: number })?.status === 403 ? false : count < 2,
  });

  const approveMut = useMutation({
    mutationFn: approveUser,
    onSuccess: (_data, id) => {
      const name = users.find((u) => u.id === id)?.name ?? t("fallbackUser");
      toast.success(t("approvedToast", { name }), t("approvedToastSub"));
      setConfirming(null);
      qc.invalidateQueries({ queryKey: ["pending-users"] });
    },
    onError: (e) => toast.error(t("approveFailed"), thrownErrorMessage(e)),
  });

  const rejectMut = useMutation({
    mutationFn: rejectUser,
    onSuccess: (_data, vars) => {
      const name = users.find((u) => u.id === vars.id)?.name ?? t("fallbackUser");
      toast.success(t("rejectedToast", { name }), t("rejectedToastSub"));
      setRejecting(null);
      setReason("");
      qc.invalidateQueries({ queryKey: ["pending-users"] });
    },
    onError: (e) => toast.error(t("rejectFailed"), thrownErrorMessage(e)),
  });

  const busy = approveMut.isPending || rejectMut.isPending;

  function submitReject() {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON) {
      setReasonError(t("reasonMin", { min: MIN_REASON }));
      return;
    }
    setReasonError(null);
    if (rejecting) rejectMut.mutate({ id: rejecting.id, reason: trimmed });
  }

  return (
    <div className="max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("subtitle")}
          </p>
        </div>
        {isLoading ? (
          <Skeleton className="h-7 w-24 rounded-full" />
        ) : (
          !isError && (
            <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700">
              {t("applications", { count: users.length })}
            </span>
          )
        )}
      </div>

      {isLoading ? (
        <SkeletonCardList count={3} />
      ) : isError ? (
        (error as { status?: number })?.status === 403 ? (
          <ForbiddenState message={t("forbidden")} />
        ) : (
          <ErrorState
            message={(error as Error)?.message ?? t("unknownError")}
            onRetry={() => refetch()}
            isRetrying={isFetching}
          />
        )
      ) : users.length === 0 ? (
        <EmptyState
          icon={Icon.success}
          title={t("emptyTitle")}
          description={t("emptyDesc")}
        />
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <div
              key={user.id}
              className="card-surface rounded-xl p-4 sm:p-5"
            >
              {/* Mobilda ustma-ust, desktopda yonma-yon — planshetda
                  tugmalar to'liq kenglikda va barmoq uchun qulay. */}
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-slate-900">{user.name}</h3>
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-brand-700">
                      {TYPE_KEYS.includes(user.type) ? t(`types.${user.type}`) : user.type}
                    </span>
                    {user.sifatId && (
                      <span className="font-mono text-xs text-slate-400">
                        {user.sifatId}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                    <span>{user.phone}</span>
                    <span className="text-xs text-slate-400">
                      {new Date(user.createdAt).toLocaleString("uz-UZ")}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 gap-2">
                  <Button
                    className="flex-1 bg-green-600 hover:bg-green-700 focus-visible:ring-green-500 sm:flex-none"
                    disabled={busy}
                    onClick={() => setConfirming(user)}
                  >
                    {t("approve")}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 focus-visible:ring-red-500 sm:flex-none"
                    disabled={busy}
                    onClick={() => {
                      setRejecting(user);
                      setReason("");
                      setReasonError(null);
                    }}
                  >
                    {t("reject")}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={!!confirming}
        title={t("approveTitle")}
        description={
          confirming
            ? t("approveDesc", { name: confirming.name, phone: confirming.phone })
            : undefined
        }
        confirmLabel={t("approveConfirm")}
        isPending={approveMut.isPending}
        onConfirm={() => confirming && approveMut.mutate(confirming.id)}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmModal
        open={!!rejecting}
        variant="destructive"
        title={t("rejectTitle")}
        description={
          rejecting
            ? t("rejectDesc", { name: rejecting.name, phone: rejecting.phone })
            : undefined
        }
        confirmLabel={t("rejectConfirm")}
        isPending={rejectMut.isPending}
        onConfirm={submitReject}
        onCancel={() => {
          setRejecting(null);
          setReasonError(null);
        }}
      >
        <label
          htmlFor="reject-reason"
          className="block text-xs font-medium text-slate-700"
        >
          {t("reasonLabel")}
        </label>
        <Input
          id="reject-reason"
          value={reason}
          hasError={!!reasonError}
          aria-describedby={reasonError ? "reject-reason-error" : undefined}
          onChange={(e) => {
            setReason(e.target.value);
            if (reasonError) setReasonError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submitReject()}
          placeholder={t("reasonPlaceholder")}
          maxLength={300}
          className="mt-1.5"
        />
        {reasonError ? (
          <p
            id="reject-reason-error"
            role="alert"
            className="mt-1 text-xs text-red-600"
          >
            {reasonError}
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            {t("reasonCounter", { len: reason.trim().length })}
          </p>
        )}
      </ConfirmModal>
    </div>
  );
}
