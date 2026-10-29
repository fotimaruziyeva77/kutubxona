"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getLibraries,
  getMyLibraries,
  createLibrary,
  approveByTuman,
  approveBySuperAdmin,
  freezeLibrary,
  unfreezeLibrary,
  deleteLibrary,
  getInventoryReport,
  type Library,
  type CreateLibraryDto,
  type InventoryReport
} from "@/lib/api/libraries";
import { getViloyatlar, getTumanlar, type GeoItem } from "@/lib/api/geo";
import { useAuthStore } from "@/store/auth.store";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { ErrorState } from "@/components/ui/error-state";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { DashboardPage, PageHeader } from "@/components/dashboard/ui";
import { LIBRARY_TYPE_LABELS, LIBRARY_STATUS_LABELS, label } from "@/lib/labels.const";

const STATUS_COLORS = {
  PENDING: "bg-yellow-100 text-yellow-800",
  ACTIVE: "bg-green-100 text-green-800",
  FROZEN: "bg-blue-100 text-blue-800",
  DELETED: "bg-red-100 text-red-800"
};

export default function LibrariesPage() {
  const t = useTranslations("LibrariesPanel");
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  // Kutubxonachi/muassasa admini o'ziga biriktirilgan kutubxona(lar)ni ko'radi
  // (hudud emas) — sarlavha matni shunga moslanadi.
  const isLibrarianScope =
    user?.role === "KUTUBXONACHI" || user?.role === "MUASSASA_ADMIN";
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [freezeModal, setFreezeModal] = useState<{ id: string; name: string } | null>(null);
  const [freezeReason, setFreezeReason] = useState("");
  const [inventoryId, setInventoryId] = useState<string | null>(null);
  // ConfirmModal uchun — qaysi kutubxona o'chirilayotgani nomi bilan ko'rsatiladi.
  const [deleteTarget, setDeleteTarget] = useState<Library | null>(null);

  // RBAC geographic scoping (Audit 2026-06) — the public GET /libraries returns
  // EVERY library in the country. A VILOYAT/TUMAN admin must only manage their
  // own region, so non-super admins use the auth+region-scoped GET
  // /libraries/mine (getManageableLibraries) which the server constrains to the
  // caller's viloyat/tuman. SUPER_ADMIN keeps the full list + status filter so
  // the PENDING approval workflow stays intact.
  // NOTE: /libraries/mine returns ACTIVE libraries only, so tier admins do not
  // see PENDING/FROZEN rows here; surfacing those per-region is a follow-up for
  // the libraries module (extend /mine with a status filter).
  const { data: libraries = [], isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["libraries", statusFilter, isSuperAdmin],
    queryFn: () =>
      isSuperAdmin
        ? getLibraries(statusFilter ? { status: statusFilter } : undefined)
        : getMyLibraries()
  });

  const { data: inventory, isLoading: inventoryLoading } = useQuery({
    queryKey: ["inventory", inventoryId],
    queryFn: () => getInventoryReport(inventoryId!),
    enabled: !!inventoryId
  });

  const approveTuman = useMutation({
    mutationFn: (id: string) => approveByTuman(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["libraries"] })
  });

  const approveSuper = useMutation({
    mutationFn: (id: string) => approveBySuperAdmin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["libraries"] })
  });

  const freeze = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => freezeLibrary(id, reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["libraries"] }); setFreezeModal(null); setFreezeReason(""); }
  });

  const unfreeze = useMutation({
    mutationFn: (id: string) => unfreezeLibrary(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["libraries"] })
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteLibrary(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["libraries"] });
      setDeleteTarget(null);
    }
  });

  return (
    <DashboardPage>
      <PageHeader
        title={t("title")}
        icon={Icon.library}
        subtitle={
          !isSuperAdmin
            ? isLibrarianScope
              ? t("subtitleLibrarian")
              : t("subtitleRegion")
            : undefined
        }
        action={
          // Kutubxona qo'shish + boshqaruv FAQAT Super admin. Viloyat/tuman
          // adminlari faqat o'z hududini kuzatadi (to'lov/hisob nazorati uchun).
          isSuperAdmin ? (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
            >
              <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
              {t("newLibrary")}
            </button>
          ) : undefined
        }
      />

      {/* Status filter — SUPER_ADMIN only (tier admins get an ACTIVE-scoped
          list via /libraries/mine, where status filtering is a no-op). */}
      {isSuperAdmin && (
        <div className="flex gap-2 flex-wrap">
          {["", "PENDING", "ACTIVE", "FROZEN"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                statusFilter === s
                  ? "bg-brand-600 text-white border-brand-600"
                  : "bg-white text-slate-600 border-line-strong hover:border-brand-400"
              }`}
            >
              {s ? label(LIBRARY_STATUS_LABELS, s) : t("filterAll")}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-slate-500">{t("loading")}</div>
      ) : isError ? (
        <ErrorState
          title={t("loadError.title")}
          message={t("loadError.message")}
          onRetry={() => refetch()}
          isRetrying={isRefetching}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-slate-600 text-left">
              <tr>
                {[t("table.code"), t("table.name"), t("table.type"), t("table.status"), t("table.fund"), t("table.actions")].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(libraries as Library[]).map((lib) => (
                <Fragment key={lib.id}>
                  <tr className="hover:bg-surface-muted">
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{lib.code}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{lib.name}</td>
                    <td className="px-4 py-3 text-slate-600">{label(LIBRARY_TYPE_LABELS, lib.type)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[lib.status as keyof typeof STATUS_COLORS]}`}>
                        {label(LIBRARY_STATUS_LABELS, lib.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{lib.fundCount.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {isSuperAdmin && lib.status === "PENDING" && (
                          <>
                            <ActionBtn
                              label={t("actions.approveTuman")}
                              color="green"
                              onClick={() => approveTuman.mutate(lib.id)}
                            />
                            <ActionBtn
                              label={t("actions.approveSuper")}
                              color="blue"
                              onClick={() => approveSuper.mutate(lib.id)}
                            />
                          </>
                        )}
                        {isSuperAdmin && lib.status === "ACTIVE" && (
                          <ActionBtn
                            label={t("actions.freeze")}
                            color="yellow"
                            onClick={() => setFreezeModal({ id: lib.id, name: lib.name })}
                          />
                        )}
                        {isSuperAdmin && lib.status === "FROZEN" && (
                          <ActionBtn
                            label={t("actions.unfreeze")}
                            color="green"
                            onClick={() => unfreeze.mutate(lib.id)}
                          />
                        )}
                        <ActionBtn
                          label={t("actions.inventory")}
                          color="gray"
                          onClick={() => setInventoryId(inventoryId === lib.id ? null : lib.id)}
                        />
                        {/* O'chirish — destruktiv amal boshqa tugmalardan
                            chetda, qizil outline bilan ajratilgan. */}
                        {isSuperAdmin && lib.status !== "DELETED" && (
                          <button
                            onClick={() => setDeleteTarget(lib)}
                            className="ml-auto inline-flex min-h-9 items-center rounded-md border border-red-200 bg-white px-3 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                          >
                            {t("actions.delete")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* Inventar hisoboti — tor <td> ichida emas, kengaytirilgan
                      qator sifatida butun jadval enida ochiladi. */}
                  {inventoryId === lib.id && (
                    <tr>
                      <td colSpan={6} className="bg-surface-muted/60 px-4 py-3">
                        {inventoryLoading ? (
                          <div className="text-xs text-slate-500">{t("inventoryRow.loading")}</div>
                        ) : inventory ? (
                          <InventoryPanel report={inventory} />
                        ) : (
                          <div className="text-xs text-slate-500">{t("inventoryRow.notFound")}</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {libraries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                    {t("empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Freeze modal */}
      {freezeModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-bold mb-2">{t("freezeModal.title")}</h2>
            <p className="text-sm text-slate-600 mb-4">
              {t.rich("freezeModal.prompt", {
                name: freezeModal.name,
                b: (chunks) => <span className="font-medium">{chunks}</span>
              })}
            </p>
            <textarea
              value={freezeReason}
              onChange={(e) => setFreezeReason(e.target.value)}
              rows={3}
              placeholder={t("freezeModal.placeholder")}
              aria-label={t("freezeModal.title")}
              className="w-full border border-line-strong rounded-lg p-3 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setFreezeModal(null); setFreezeReason(""); }}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
              >
                {t("cancel")}
              </button>
              <button
                disabled={!freezeReason.trim()}
                onClick={() => freeze.mutate({ id: freezeModal.id, reason: freezeReason })}
                className="px-4 py-2 bg-accent-500 text-white rounded-lg text-sm font-medium hover:bg-accent-600 disabled:opacity-50"
              >
                {t("freezeModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* O'chirishni tasdiqlash — TZ bo'yicha "ROZIMAN" yozib tasdiqlanadi
          (backend ham shu confirmation so'zini talab qiladi). */}
      <ConfirmModal
        open={!!deleteTarget}
        title={deleteTarget ? t("deleteModal.titleNamed", { name: deleteTarget.name }) : t("deleteModal.title")}
        description={t("deleteModal.description")}
        confirmLabel={t("deleteModal.confirm")}
        variant="destructive"
        requireTypedConfirmation="ROZIMAN"
        isPending={del.isPending}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Create modal */}
      {showCreate && (
        <CreateLibraryModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey: ["libraries"] }); setShowCreate(false); }}
        />
      )}
    </DashboardPage>
  );
}

function ActionBtn({
  label,
  color,
  onClick
}: {
  label: string;
  color: "green" | "blue" | "yellow" | "gray";
  onClick: () => void;
}) {
  const colors = {
    green: "bg-green-50 text-green-700 hover:bg-green-100",
    blue: "bg-blue-50 text-brand-700 hover:bg-blue-100",
    yellow: "bg-accent-50 text-accent-700 hover:bg-accent-100",
    gray: "bg-surface-muted text-slate-700 hover:bg-surface-sunken"
  };
  return (
    <button
      onClick={onClick}
      className={`inline-flex min-h-9 items-center rounded-md px-3 text-xs font-medium transition-colors ${colors[color]}`}
    >
      {label}
    </button>
  );
}

function InventoryPanel({ report }: { report: InventoryReport }) {
  const t = useTranslations("LibrariesPanel");
  return (
    <div className={`p-3 rounded-lg text-xs ${report.alert ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"}`}>
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        {report.alert
          ? <><Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="text-accent-600" />{t("inv.mismatch")}</>
          : <><Icon.success aria-hidden="true" size={ICON_SIZE.sm} className="text-green-600" />{t("inv.match")}</>}
      </div>
      <div className="grid grid-cols-2 gap-1 text-slate-700 sm:max-w-md">
        <span>{t("inv.declared")}</span><span className="font-medium">{report.declaredFundCount}</span>
        <span>{t("inv.inSystem")}</span><span className="font-medium">{report.dbBookCount}</span>
        <span>{t("inv.available")}</span><span className="font-medium">{report.availableCount}</span>
        <span>{t("inv.borrowed")}</span><span className="font-medium">{report.borrowedCount}</span>
        <span>{t("inv.discrepancy")}</span><span className={`font-medium ${report.alert ? "text-red-600" : ""}`}>{report.discrepancy} ({report.discrepancyPct}%)</span>
      </div>
    </div>
  );
}

function CreateLibraryModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("LibrariesPanel");
  const { data: viloyatlar = [] } = useQuery<GeoItem[]>({ queryKey: ["viloyatlar"], queryFn: getViloyatlar });
  const [viloyatId, setViloyatId] = useState("");
  const { data: tumanlar = [] } = useQuery<GeoItem[]>({
    queryKey: ["tumanlar", viloyatId],
    queryFn: () => getTumanlar(viloyatId),
    enabled: !!viloyatId
  });

  const [form, setForm] = useState<CreateLibraryDto>({
    type: "GOV",
    name: "",
    regionId: "",
    tumanId: "",
    viloyatId: "",
    address: "",
    phone: "",
    workHours: "09:00-18:00, Du-Sh"
  });

  const create = useMutation({
    mutationFn: () => createLibrary({ ...form, regionId: form.tumanId || form.regionId }),
    onSuccess: onCreated
  });

  const set = (k: keyof CreateLibraryDto, v: string) => setForm((f: CreateLibraryDto) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">{t("newLibrary")}</h2>

        <div className="space-y-3">
          {/* Tugma-guruh oddiy label bilan bog'lanmaydi — fieldset/legend
              skrinrider uchun guruh nomini beradi. */}
          <fieldset>
            <legend className="block text-sm font-medium text-slate-700 mb-2">{t("createModal.typeLabel")}</legend>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {(["GOV", "SCH", "UNI", "ORG", "MAH"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={form.type === t}
                  onClick={() => set("type", t)}
                  className={`py-2 rounded-lg text-sm font-medium border transition-colors ${
                    form.type === t ? "bg-brand-600 text-white border-brand-600" : "border-line-strong text-slate-600 hover:border-brand-400"
                  }`}
                >
                  {label(LIBRARY_TYPE_LABELS, t)}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.nameLabel")}</label>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("createModal.namePlaceholder")}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.viloyat")}</label>
              <select
                value={viloyatId}
                onChange={(e) => { setViloyatId(e.target.value); set("viloyatId", e.target.value); }}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">{t("createModal.select")}</option>
                {viloyatlar.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.tuman")}</label>
              <select
                value={form.tumanId}
                onChange={(e) => set("tumanId", e.target.value)}
                disabled={!viloyatId}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-muted"
              >
                <option value="">{t("createModal.select")}</option>
                {tumanlar.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.address")}</label>
            <input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder={t("createModal.addressPlaceholder")}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.phone")}</label>
              <input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder={t("createModal.phonePlaceholder")}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("createModal.workHours")}</label>
              <input
                value={form.workHours}
                onChange={(e) => set("workHours", e.target.value)}
                placeholder={t("createModal.workHoursPlaceholder")}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900">
            {t("cancel")}
          </button>
          <button
            disabled={!form.name || !form.tumanId || create.isPending}
            onClick={() => create.mutate()}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {create.isPending ? t("createModal.saving") : t("createModal.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
