"use client";

/**
 * Plan 06-06 ORG-03 — Reading Hour list page (HR admin entry point).
 *
 * Lists events with month + status filter; "Yangi tadbir" modal posts to
 * POST /idora/:institutionId/reading-hours, then routes into the event
 * detail page at /dashboard/idora/reading-hour/[id].
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import { Icon } from "@/components/ui/icon";
import { DashboardPage, PageHeader, Panel } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { EVENT_STATUS_LABELS, label } from "@/lib/labels.const";

// FIX (reading-hour auth) — the fetch-wrapper apiClient attaches the in-memory
// Bearer token (+ 401→refresh→retry). The old `fetch(`${API}/...`,
// { credentials: "include" })` sent only the HttpOnly refresh cookie, never the
// access token (H16), so calls 401'd. Paths are BARE (axios baseURL = /api).

interface EventRow {
  id: string;
  title: string;
  heldAt: string;
  venue?: string;
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  _count: { attendances: number; media: number };
}

interface IdoraInstitution {
  id: string;
  name: string;
  code: string;
}

export default function ReadingHourListPage() {
  // Tadbir havolasiga lokal til kerak. Ilgari "/uz-Latn/..." qattiq yozilgan
  // edi va rus tilidagi admin tadbirni bosishi bilan o'zbek tiliga tashlanardi.
  const locale = useLocale();
  const t = useTranslations("ReadingHourPanel");
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const ownInstitutionId = user?.organizationId ?? "";

  // SUPER_ADMIN da organizationId yo'q — ilgari institutionId bo'sh qolib,
  // so'rov disabled bo'lardi va sahifa abadiy "Tadbir topilmadi" ko'rsatardi.
  // idora/page.tsx dagi kabi idoralar ro'yxati olinadi va select ko'rsatiladi;
  // oddiy admin o'z organizationId sidan foydalanadi.
  const [selectedInstitutionId, setSelectedInstitutionId] = useState("");
  const institutionsQ = useQuery({
    queryKey: ["idora-institutions"],
    queryFn: async () => {
      const r = await apiClient(`/school/institutions?type=IDORA&limit=100`);
      if (!r.ok) return { data: [] as IdoraInstitution[], total: 0 };
      return r.json() as Promise<{ data: IdoraInstitution[]; total: number }>;
    },
    enabled: isSuperAdmin,
    // Har kirishda yangidan olamiz — eski bo'sh kesh adashtirmasin.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const institutions = useMemo(() => institutionsQ.data?.data ?? [], [institutionsQ.data]);

  // Bitta idora bo'lsa avtomatik tanlash.
  useEffect(() => {
    if (isSuperAdmin && !selectedInstitutionId && institutions.length === 1) {
      setSelectedInstitutionId(institutions[0].id);
    }
  }, [isSuperAdmin, selectedInstitutionId, institutions]);

  const institutionId = isSuperAdmin ? selectedInstitutionId : ownInstitutionId;
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState("ALL");
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["reading-hours", institutionId, month, status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (month) params.set("month", month);
      if (status) params.set("status", status);
      const r = await apiClient(
        `/idora/${institutionId}/reading-hours?${params}`,
      );
      if (!r.ok) throw new Error("Yuklashda xato");
      return r.json() as Promise<{ items: EventRow[]; total: number }>;
    },
    enabled: !!institutionId,
  });

  const create = useMutation({
    mutationFn: async (body: {
      title: string;
      heldAt: string;
      venue?: string;
    }) => {
      const r = await apiClient(
        `/idora/${institutionId}/reading-hours`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || t("createError"));
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["reading-hours", institutionId],
      });
      setShowCreate(false);
    },
  });

  return (
    <DashboardPage>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        icon={Icon.book}
        action={
          institutionId ? (
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
            >
              {t("createEventButton")}
            </button>
          ) : undefined
        }
      />

      {/* SUPER_ADMIN idora selector */}
      {isSuperAdmin && (
        <Panel noReveal>
          <label htmlFor="rh-institution-select" className="text-sm font-medium text-slate-700 block mb-2">
            {t("selectIdoraLabel")}
          </label>
          <select
            id="rh-institution-select"
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
          {institutionsQ.isLoading ? (
            <p className="text-xs text-slate-400 mt-2">{t("idoraListLoading")}</p>
          ) : institutions.length === 0 ? (
            <p className="text-xs text-slate-400 mt-2">{t("noIdorasFound")}</p>
          ) : null}
        </Panel>
      )}

      {!institutionId ? (
        <EmptyState
          icon={Icon.organization}
          title={isSuperAdmin ? t("noIdoraSelectedTitle") : t("noIdoraAssignedTitle")}
          description={
            isSuperAdmin
              ? t("noIdoraSelectedDesc")
              : t("noIdoraAssignedDesc")
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <label htmlFor="rh-month-filter" className="sr-only">{t("monthFilterLabel")}</label>
              <input
                id="rh-month-filter"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="border border-line-strong rounded-lg px-3 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="rh-status-filter" className="sr-only">{t("statusFilterLabel")}</label>
              <select
                id="rh-status-filter"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="border border-line-strong rounded-lg px-3 py-1.5 text-sm bg-white"
              >
                <option value="ALL">{t("allStatuses")}</option>
                <option value="DRAFT">{label(EVENT_STATUS_LABELS, "DRAFT")}</option>
                <option value="PUBLISHED">{label(EVENT_STATUS_LABELS, "PUBLISHED")}</option>
                <option value="CANCELLED">{label(EVENT_STATUS_LABELS, "CANCELLED")}</option>
              </select>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner size="lg" /></div>
          ) : isError ? (
            // Xato holat — "Tadbir topilmadi" (bo'sh ro'yxat) bilan adashtirilmaydi.
            <ErrorState
              message={t("listError")}
              onRetry={() => refetch()}
              isRetrying={isRefetching}
            />
          ) : (data?.items ?? []).length === 0 ? (
            <EmptyState
              icon={Icon.calendar}
              title={t("noEventsTitle")}
              description={t("noEventsDesc")}
            />
          ) : (
            <div className="card-surface rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-muted text-left text-slate-600">
                  <tr>
                    <th className="py-2 px-4 font-medium">{t("eventCol")}</th>
                    <th className="py-2 px-4 font-medium">{t("dateCol")}</th>
                    <th className="py-2 px-4 font-medium">{t("venueCol")}</th>
                    <th className="py-2 px-4 font-medium">{t("statusCol")}</th>
                    <th className="py-2 px-4 font-medium">{t("attendeesCol")}</th>
                    <th className="py-2 px-4 font-medium">{t("filesCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.items ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-line hover:bg-surface-muted">
                      <td className="py-2 px-4">
                        <Link
                          href={`/${locale}/dashboard/idora/reading-hour/${row.id}`}
                          className="text-brand-600 hover:underline"
                        >
                          {row.title}
                        </Link>
                      </td>
                      <td className="py-2 px-4 text-slate-500">
                        {new Date(row.heldAt).toLocaleString("uz-UZ")}
                      </td>
                      <td className="py-2 px-4 text-slate-500">
                        {row.venue ?? "—"}
                      </td>
                      <td className="py-2 px-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-2 px-4">{row._count.attendances}</td>
                      <td className="py-2 px-4">{row._count.media}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onSubmit={(body) => create.mutate(body)}
          isPending={create.isPending}
          error={create.error ? (create.error as Error).message : null}
        />
      )}
    </DashboardPage>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PUBLISHED: "bg-green-100 text-green-700",
    DRAFT: "bg-surface-sunken text-slate-700",
    CANCELLED: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-semibold ${map[status] ?? ""}`}
    >
      {label(EVENT_STATUS_LABELS, status)}
    </span>
  );
}

function CreateModal({
  onClose,
  onSubmit,
  isPending,
  error,
}: {
  onClose: () => void;
  onSubmit: (b: { title: string; heldAt: string; venue?: string }) => void;
  isPending: boolean;
  error: string | null;
}) {
  const t = useTranslations("ReadingHourPanel");
  const [title, setTitle] = useState(t("defaultEventTitle"));
  const [heldAt, setHeldAt] = useState("");
  const [venue, setVenue] = useState("");

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-4">{t("newEventTitle")}</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-slate-600">{t("nameLabel")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full border border-line-strong rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-600">{t("dateTimeLabel")}</span>
            <input
              type="datetime-local"
              value={heldAt}
              onChange={(e) => setHeldAt(e.target.value)}
              className="mt-1 w-full border border-line-strong rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-600">{t("venueOptionalLabel")}</span>
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="mt-1 w-full border border-line-strong rounded-lg px-3 py-2 text-sm"
            />
          </label>
          {error && <p role="alert" className="text-red-600 text-sm">{error}</p>}
        </div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-slate-600 text-sm"
          >
            {t("cancel")}
          </button>
          <button
            disabled={!heldAt || isPending}
            onClick={() =>
              onSubmit({
                title: title.trim() || t("defaultEventTitle"),
                heldAt: new Date(heldAt).toISOString(),
                venue: venue.trim() || undefined,
              })
            }
            className="px-4 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm disabled:opacity-50"
          >
            {isPending ? t("creating") : t("create")}
          </button>
        </div>
      </div>
    </div>
  );
}
