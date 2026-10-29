"use client";

// Plan 04-03 Task 4 — Admin subscription management UI (PAY-08).
//
// Surface for SUPER_ADMIN + BUXGALTER to freeze, unfreeze, and delete
// subscriptions. Every freeze / delete forces a reason dialog (3+ chars)
// so the backend audit log (AiAuditLog STATE_TRANSITION, severity HIGH)
// is fed a meaningful row.
//
// Plan 04-03 audit-fix FIX E (SEC MEDIUM) — use apiClient (Bearer + 401
// refresh) instead of raw fetch. Backend's JwtAuthGuard reads Bearer from
// the Authorization header; credentials:'include' alone never authenticated
// these admin pages so they would return 401 in production.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api/client";
import { ErrorState, ForbiddenState } from "@/components/ui/error-state";
import { EmptyState, NoResultsState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { SkeletonTable } from "@/components/ui/skeleton";
import { DashboardPage, PageHeader } from "@/components/dashboard/ui";
import { Icon } from "@/components/ui/icon";
import { SUBSCRIPTION_STATUS_LABELS, label } from "@/lib/labels.const";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  libraryId: string;
  planType: string;
  status: "TRIAL" | "PENDING" | "ACTIVE" | "FROZEN" | "DELETED";
  startDate: string;
  endDate: string;
  trialEnd?: string | null;
  frozenReason?: string | null;
  frozenAt?: string | null;
  deletedReason?: string | null;
  deletedAt?: string | null;
  library?: { id: string; name: string; type: string };
  invoices?: Array<{ status: string; amount: string; dueDate: string }>;
}

type ActionStatus = "FROZEN" | "ACTIVE" | "DELETED";

function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return fallback;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useSubscriptions(status: string) {
  return useQuery({
    queryKey: ["admin-subscriptions", status],
    queryFn: async () => {
      const params: Record<string, string> = { limit: "50" };
      if (status) params.status = status;
      const { data } = await apiClient.get<{
        subscriptions: Subscription[];
        total: number;
      }>("/subscriptions", { params });
      return data;
    },
    staleTime: 30_000,
  });
}

function useStatusMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      status: ActionStatus;
      reason?: string;
    }) => {
      const { data } = await apiClient.patch(
        `/subscriptions/${args.id}/status`,
        { status: args.status, reason: args.reason },
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-subscriptions"] }),
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Subscription["status"] }) {
  const colors: Record<Subscription["status"], string> = {
    TRIAL: "bg-brand-100 text-brand-700",
    PENDING: "bg-yellow-100 text-yellow-700",
    ACTIVE: "bg-green-100 text-green-700",
    FROZEN: "bg-orange-100 text-orange-700",
    DELETED: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${colors[status]}`}
    >
      {label(SUBSCRIPTION_STATUS_LABELS, status)}
    </span>
  );
}

// ── Reason Dialog ─────────────────────────────────────────────────────────────
// Umumiy Modal ustiga qurilgan: role="dialog", aria, Esc, fokus qulfi va
// fokus qaytarish Modal ichida — qo'lda yozilgan overlay bularsiz edi.

interface ReasonDialogProps {
  open: boolean;
  action: "FREEZE" | "DELETE" | null;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

function ReasonDialog({ open, action, onClose, onConfirm }: ReasonDialogProps) {
  const t = useTranslations("SubsPanel");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Har ochilishda eski sabab/xato tozalanadi.
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  const title =
    action === "DELETE" ? t("dialog.deleteTitle") : t("dialog.freezeTitle");

  const handleSubmit = async () => {
    if (reason.trim().length < 3) {
      setError(t("dialog.reasonMin"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason);
      onClose();
    } catch (e: unknown) {
      setError(errorMessage(e, t("genericError")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!submitting) onClose();
      }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-md border border-line-strong text-sm font-medium text-slate-700 hover:bg-surface-muted disabled:opacity-50"
          >
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className={`px-4 py-2 rounded-md text-white text-sm font-medium ${
              action === "DELETE"
                ? "bg-red-600 hover:bg-red-700"
                : "bg-orange-600 hover:bg-orange-700"
            } disabled:opacity-50`}
          >
            {submitting ? t("dialog.submitting") : t("dialog.confirm")}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600 mb-3">
        {t("dialog.auditNote")}
      </p>
      <label
        htmlFor="reason-text"
        className="mb-1 block text-sm font-medium text-slate-700"
      >
        {t("dialog.reasonLabel")}
      </label>
      <textarea
        id="reason-text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("dialog.reasonPlaceholder")}
        className="w-full rounded-md border border-line-strong p-2 h-24 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminSubscriptionsPage() {
  const t = useTranslations("SubsPanel");
  const { user } = useAuthStore();
  const [statusFilter, setStatusFilter] = useState("");
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    action: "FREEZE" | "DELETE" | null;
    subscriptionId: string | null;
  }>({ open: false, action: null, subscriptionId: null });
  // Faollashtirish tasdiqlash modali (ilgari confirm()+alert() edi).
  const [unfreezeId, setUnfreezeId] = useState<string | null>(null);
  const [unfreezeError, setUnfreezeError] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useSubscriptions(statusFilter);
  const statusMutation = useStatusMutation();

  // Role gate. Server-side RolesGuard also rejects non-admin tokens; client
  // gate prevents the wrong UI from rendering at all.
  const isAdmin =
    user?.role === "SUPER_ADMIN" || user?.role === "BUXGALTER";

  if (!isAdmin) {
    return (
      <DashboardPage>
        <ForbiddenState message={t("forbidden")} />
      </DashboardPage>
    );
  }

  const handleAction = async (reason: string) => {
    if (!dialogState.subscriptionId || !dialogState.action) return;
    const status: ActionStatus =
      dialogState.action === "FREEZE" ? "FROZEN" : "DELETED";
    await statusMutation.mutateAsync({
      id: dialogState.subscriptionId,
      status,
      reason,
    });
  };

  const handleUnfreezeConfirm = async () => {
    if (!unfreezeId) return;
    setUnfreezeError(null);
    try {
      await statusMutation.mutateAsync({ id: unfreezeId, status: "ACTIVE" });
      setUnfreezeId(null);
    } catch (e: unknown) {
      setUnfreezeError(errorMessage(e, t("genericError")));
    }
  };

  const subscriptions = data?.subscriptions ?? [];

  return (
    <DashboardPage>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.checklist}
      />

      <div className="flex flex-wrap gap-3 items-center">
        <label htmlFor="sub-status-filter" className="text-sm font-medium">
          {t("statusLabel")}
        </label>
        <select
          id="sub-status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-lg border border-line-strong bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">{t("filter.all")}</option>
          <option value="TRIAL">{t("filter.trial")}</option>
          <option value="PENDING">{t("filter.pending")}</option>
          <option value="ACTIVE">{t("filter.active")}</option>
          <option value="FROZEN">{t("filter.frozen")}</option>
          <option value="DELETED">{t("filter.deleted")}</option>
        </select>
        {data && (
          <span className="text-sm text-slate-600 ml-auto">
            {t("total", { count: data.total })}
          </span>
        )}
      </div>

      {isLoading && <SkeletonTable rows={5} columns={6} />}
      {/* Xom Axios obyektini ("AxiosError: Request failed with status
          code 500") foydalanuvchiga ko'rsatmaymiz. */}
      {error && (
        <ErrorState
          title={t("loadErrorTitle")}
          message={t("loadErrorMsg")}
          onRetry={() => refetch()}
        />
      )}

      {data && subscriptions.length === 0 && (
        statusFilter ? (
          <NoResultsState onReset={() => setStatusFilter("")} />
        ) : (
          <EmptyState
            icon={Icon.checklist}
            title={t("emptyTitle")}
            description={t("emptyDesc")}
          />
        )
      )}

      {data && subscriptions.length > 0 && (
        <div className="overflow-x-auto border border-line rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted">
              <tr>
                <th className="text-left p-3">{t("table.library")}</th>
                <th className="text-left p-3">{t("table.plan")}</th>
                <th className="text-left p-3">{t("table.status")}</th>
                <th className="text-left p-3">{t("table.ends")}</th>
                <th className="text-left p-3">{t("table.reason")}</th>
                <th className="text-right p-3">{t("table.action")}</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <tr key={sub.id} className="border-t border-line hover:bg-surface-muted">
                  <td className="p-3">
                    <div className="font-medium">{sub.library?.name ?? sub.libraryId}</div>
                    <div className="text-xs text-slate-500">{sub.library?.type}</div>
                  </td>
                  <td className="p-3">{sub.planType}</td>
                  <td className="p-3">
                    <StatusBadge status={sub.status} />
                  </td>
                  <td className="p-3">
                    {sub.endDate
                      ? new Date(sub.endDate).toLocaleDateString("uz-UZ")
                      : "—"}
                  </td>
                  <td className="p-3 text-xs text-slate-600 max-w-xs truncate">
                    {sub.status === "FROZEN" && sub.frozenReason}
                    {sub.status === "DELETED" && sub.deletedReason}
                    {sub.status !== "FROZEN" && sub.status !== "DELETED" && "—"}
                  </td>
                  <td className="p-3 text-right space-x-1">
                    {sub.status === "ACTIVE" && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setDialogState({
                              open: true,
                              action: "FREEZE",
                              subscriptionId: sub.id,
                            })
                          }
                          className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-700"
                        >
                          {t("actions.freeze")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDialogState({
                              open: true,
                              action: "DELETE",
                              subscriptionId: sub.id,
                            })
                          }
                          className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          {t("actions.delete")}
                        </button>
                      </>
                    )}
                    {sub.status === "FROZEN" && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setUnfreezeError(null);
                            setUnfreezeId(sub.id);
                          }}
                          className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          {t("actions.unfreeze")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDialogState({
                              open: true,
                              action: "DELETE",
                              subscriptionId: sub.id,
                            })
                          }
                          className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          {t("actions.delete")}
                        </button>
                      </>
                    )}
                    {(sub.status === "TRIAL" || sub.status === "PENDING") && (
                      <button
                        type="button"
                        onClick={() =>
                          setDialogState({
                            open: true,
                            action: "FREEZE",
                            subscriptionId: sub.id,
                          })
                        }
                        className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-700"
                      >
                        {t("actions.freeze")}
                      </button>
                    )}
                    {sub.status === "DELETED" && (
                      <span className="text-xs text-slate-400">{t("actions.deletedNoAction")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReasonDialog
        open={dialogState.open && !!dialogState.action && !!dialogState.subscriptionId}
        action={dialogState.action}
        onClose={() =>
          setDialogState({ open: false, action: null, subscriptionId: null })
        }
        onConfirm={handleAction}
      />

      <ConfirmModal
        open={!!unfreezeId}
        title={t("unfreeze.title")}
        description={t("unfreeze.desc")}
        confirmLabel={t("actions.unfreeze")}
        isPending={statusMutation.isPending}
        onConfirm={handleUnfreezeConfirm}
        onCancel={() => {
          if (!statusMutation.isPending) {
            setUnfreezeId(null);
            setUnfreezeError(null);
          }
        }}
      >
        {unfreezeError && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {unfreezeError}
          </p>
        )}
      </ConfirmModal>
    </DashboardPage>
  );
}
