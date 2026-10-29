"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listAccounts,
  createAccount,
  resetAccountPassword,
  deleteAccount,
  type StaffRole,
  type AccountItem,
  type CreateAccountInput,
} from "@/lib/api/accounts";
import { getViloyatlar, getTumanlar, getMahallalar } from "@/lib/api/geo";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

// Rol yorliqlari AccountsPanel.roles.* tarjima kalitlaridan olinadi.
const ROLE_OPTIONS: StaffRole[] = [
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
  "KLUB_RAHBARI",
  "BUXGALTER",
  "DOKON_OPERATOR",
];

// Bu rollar uchun hudud (viloyat→tuman→mahalla) majburiy.
const REGION_ROLES: StaffRole[] = [
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
  "KLUB_RAHBARI",
];

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700",
  PENDING: "bg-yellow-100 text-yellow-700",
  BLOCKED: "bg-red-100 text-red-700",
  DELETED: "bg-surface-sunken text-slate-500",
};

export default function AccountsPage() {
  const t = useTranslations("AccountsPanel");
  const qc = useQueryClient();
  const [roleFilter, setRoleFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [showCreate, setShowCreate] = useState(false);
  const [credModal, setCredModal] = useState<{ phone: string; password: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccountItem | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  const showToast = (msg: string, type: "ok" | "err") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const { data, isLoading } = useQuery({
    queryKey: ["accounts", roleFilter, search, page, limit],
    queryFn: () => listAccounts({ role: roleFilter || undefined, search: search || undefined, page, limit }),
  });

  const resetMut = useMutation({
    mutationFn: (id: string) => resetAccountPassword(id),
    onSuccess: (res, id) => {
      const acct = data?.items.find((a) => a.id === id);
      setCredModal({ phone: acct?.phone ?? "", password: res.tempPassword, title: t("newTempPassword") });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e: any) => showToast(e?.response?.data?.message ?? t("resetFailed"), "err"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: () => {
      showToast(t("accountDeleted"), "ok");
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e: any) => showToast(e?.response?.data?.message ?? t("deleteFailed"), "err"),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {toast && (
        <div className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ${toast.type === "ok" ? "bg-green-600" : "bg-red-600"}`}>
          {toast.type === "ok" ? <Icon.success aria-hidden="true" size={ICON_SIZE.sm} /> : <Icon.error aria-hidden="true" size={ICON_SIZE.sm} />}
          {toast.msg}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Icon.readers aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
          </span>
          {t("title")}
        </h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
        >
          {t("newAdmin")}
        </button>
      </div>

      {/* Filtrlar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
          className="border border-line bg-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">{t("allRoles")}</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{t(`roles.${r}`)}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={t("searchPlaceholder")}
          className="border border-line bg-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[200px]"
        />
        <select
          value={limit}
          onChange={(e) => { setLimit(+e.target.value); setPage(1); }}
          className="border border-line bg-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 ml-auto"
        >
          {[20, 50, 100].map((n) => <option key={n} value={n}>{t("perPage", { n })}</option>)}
        </select>
      </div>

      {/* Jadval */}
      <div className="card-surface rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-slate-500">
              <tr>
                <th className="text-left font-semibold px-4 py-3">{t("thName")}</th>
                <th className="text-left font-semibold px-4 py-3">{t("thPhone")}</th>
                <th className="text-left font-semibold px-4 py-3">{t("thRole")}</th>
                <th className="text-left font-semibold px-4 py-3">{t("thRegion")}</th>
                <th className="text-left font-semibold px-4 py-3">{t("thStatus")}</th>
                <th className="text-right font-semibold px-4 py-3">{t("thActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">{t("loading")}</td></tr>
              ) : (data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">{t("notFound")}</td></tr>
              ) : (
                data!.items.map((a) => (
                  <tr key={a.id} className="hover:bg-surface-muted/60">
                    <td className="px-4 py-3 font-medium text-slate-900">{a.name}</td>
                    <td className="px-4 py-3 text-slate-600">{a.phone}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded-full bg-blue-50 text-brand-700 text-xs font-medium">{ROLE_OPTIONS.includes(a.role) ? t(`roles.${a.role}`) : a.role}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {a.viloyatName ? (
                        <span>{a.viloyatName}{a.tumanName ? `, ${a.tumanName}` : ""}</span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[a.status] ?? "bg-surface-sunken text-slate-500"}`}>{a.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => resetMut.mutate(a.id)}
                          disabled={resetMut.isPending}
                          className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                          title={t("resetTitle")}
                        >
                          <Icon.locked aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("passwordBtn")}
                        </button>
                        <button
                          onClick={() => setDeleteTarget(a)}
                          className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                        >
                          <Icon.delete aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />{t("deleteBtn")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>{t("totalCount", { total })}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg border border-line disabled:opacity-40 hover:bg-surface-muted">←</button>
            <span>{page} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg border border-line disabled:opacity-40 hover:bg-surface-muted">→</button>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAccountModal
          onClose={() => setShowCreate(false)}
          onCreated={(res) => {
            setShowCreate(false);
            setCredModal({ phone: res.phone, password: res.tempPassword, title: t("accountCreated") });
            qc.invalidateQueries({ queryKey: ["accounts"] });
          }}
        />
      )}

      {credModal && (
        <CredentialsModal {...credModal} onClose={() => setCredModal(null)} />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 text-lg">{t("deleteModalTitle")}</h3>
            <p className="text-sm text-slate-600 mt-2">
              {t.rich("deleteModalDesc", {
                b: (chunks) => <b>{chunks}</b>,
                name: deleteTarget.name,
                phone: deleteTarget.phone,
              })}
            </p>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 px-4 py-2 rounded-xl border border-line text-sm font-medium hover:bg-surface-muted">{t("cancel")}</button>
              <button onClick={() => deleteMut.mutate(deleteTarget.id)} disabled={deleteMut.isPending}
                className="flex-1 px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                {deleteMut.isPending ? "..." : t("deleteBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Yangi akaunt modali ───────────────────────────────────────────────────────

function CreateAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (res: { phone: string; tempPassword: string }) => void;
}) {
  const t = useTranslations("AccountsPanel");
  const [role, setRole] = useState<StaffRole>("VILOYAT_ADMIN");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+998");
  const [gender, setGender] = useState<"MALE" | "FEMALE">("MALE");
  const [viloyatId, setViloyatId] = useState("");
  const [tumanId, setTumanId] = useState("");
  const [mahallaId, setMahallaId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const needsRegion = REGION_ROLES.includes(role);

  const { data: viloyatlar = [] } = useQuery({ queryKey: ["geo-vil"], queryFn: getViloyatlar, staleTime: 3600_000 });
  const { data: tumanlar = [] } = useQuery({ queryKey: ["geo-tum", viloyatId], queryFn: () => getTumanlar(viloyatId), enabled: !!viloyatId, staleTime: 3600_000 });
  const { data: mahallalar = [] } = useQuery({ queryKey: ["geo-mah", tumanId], queryFn: () => getMahallalar(tumanId), enabled: !!tumanId, staleTime: 3600_000 });

  const createMut = useMutation({
    mutationFn: (dto: CreateAccountInput) => createAccount(dto),
    onSuccess: (res) => onCreated({ phone: res.phone, tempPassword: res.tempPassword }),
    onError: (e: any) => setError(e?.response?.data?.message ?? t("createFailed")),
  });

  const submit = () => {
    setError("");
    if (!name.trim()) { setError(t("errName")); return; }
    if (!/^\+\d{9,15}$/.test(phone.replace(/\s/g, ""))) { setError(t("errPhone")); return; }
    if (needsRegion && !mahallaId) { setError(t("errRegion")); return; }
    if (password && password.length < 8) { setError(t("errPassword")); return; }
    createMut.mutate({
      name: name.trim(),
      phone: phone.replace(/\s/g, ""),
      role,
      gender,
      password: password || undefined,
      viloyatId: needsRegion ? viloyatId : undefined,
      tumanId: needsRegion ? tumanId : undefined,
      mahallaId: needsRegion ? mahallaId : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-lg w-full my-8" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-900 text-lg mb-4">{t("modalTitle")}</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("roleLabel")}</label>
            <select value={role} onChange={(e) => { setRole(e.target.value as StaffRole); }}
              className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("nameLabel")}</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">{t("phoneLabel")}</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t("phonePlaceholder")}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("genderLabel")}</label>
            <div className="flex gap-2">
              {(["MALE", "FEMALE"] as const).map((g) => (
                <button key={g} type="button" onClick={() => setGender(g)}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium border ${gender === g ? "bg-brand-600 text-white border-blue-600" : "border-line text-slate-600 hover:bg-surface-muted"}`}>
                  {g === "MALE" ? t("male") : t("female")}
                </button>
              ))}
            </div>
          </div>

          {needsRegion && (
            <div className="grid grid-cols-1 gap-3 rounded-2xl bg-blue-50/50 border border-brand-100 p-3">
              <p className="text-xs text-brand-700 font-medium">{t("regionHint")}</p>
              <select value={viloyatId} onChange={(e) => { setViloyatId(e.target.value); setTumanId(""); setMahallaId(""); }}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
                <option value="">{t("selectViloyat")}</option>
                {viloyatlar.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <select value={tumanId} onChange={(e) => { setTumanId(e.target.value); setMahallaId(""); }} disabled={!viloyatId}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-muted">
                <option value="">{t("selectTuman")}</option>
                {tumanlar.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </select>
              <select value={mahallaId} onChange={(e) => setMahallaId(e.target.value)} disabled={!tumanId}
                className="w-full border border-line rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-muted">
                <option value="">{t("selectMahalla")}</option>
                {mahallalar.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{t("passwordLabel")}</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("passwordPlaceholder")}
              className="w-full border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <p className="text-xs text-slate-400 mt-1">{t("passwordHint")}</p>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-xl border border-line text-sm font-medium hover:bg-surface-muted">{t("cancel")}</button>
          <button onClick={submit} disabled={createMut.isPending}
            className="flex-1 px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-semibold hover:opacity-95 disabled:opacity-50">
            {createMut.isPending ? t("creating") : t("create")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Login ma'lumotlari modali (parol bir marta ko'rsatiladi) ──────────────────

function CredentialsModal({
  phone,
  password,
  title,
  onClose,
}: {
  phone: string;
  password: string;
  title: string;
  onClose: () => void;
}) {
  const t = useTranslations("AccountsPanel");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Telefon: ${phone}\nParol: ${password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard yo'q */ }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-50 text-green-600"><Icon.success aria-hidden="true" size={ICON_SIZE.md} /></span>
          <h3 className="font-bold text-slate-900 text-lg">{title}</h3>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          {t.rich("credShare", { b: (chunks) => <b>{chunks}</b> })}
        </p>
        <div className="rounded-xl bg-surface-muted border border-line p-3 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-slate-400">{t("credPhone")}</span><span className="font-mono font-semibold text-slate-900">{phone}</span></div>
          <div className="flex justify-between items-center"><span className="text-slate-400">{t("credPassword")}</span><span className="font-mono font-bold text-brand-700 text-base">{password}</span></div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={copy} className="flex-1 px-4 py-2 rounded-xl border border-brand-200 text-brand-700 text-sm font-medium hover:bg-blue-50">
            {copied ? <span className="inline-flex items-center gap-1"><Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} />{t("copied")}</span> : <span className="inline-flex items-center gap-1"><Icon.document aria-hidden="true" size={ICON_SIZE.xs} />{t("copy")}</span>}
          </button>
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800">{t("closeBtn")}</button>
        </div>
      </div>
    </div>
  );
}
