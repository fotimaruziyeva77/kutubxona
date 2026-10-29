"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { useAuthStore } from "@/store/auth.store";

/**
 * B2B demo so'rovlar (lead) paneli — sotuv jarayonining yagona ish joyi.
 *
 * Bu sahifa mahsulotni sotadigan odam kun davomida ochib turadigan ro'yxat:
 * kim so'rov qoldirdi, unga qo'ng'iroq qilindimi, nima gaplashildi. Shu sabab
 * bu yerda TO'LIQ aloqa ma'lumoti (telefon/email bosiladigan havola) va
 * qo'ng'iroq natijasini yozib qo'yish maydoni bo'lishi shart — aks holda
 * kuzatuv Excel'ga ko'chib ketadi va lead yo'qoladi.
 */

type DemoRequest = {
  id: string;
  organization: string;
  phone: string;
  email?: string;
  orgType: string;
  message?: string;
  status: "PENDING" | "CONTACTED" | "CLOSED";
  adminNote?: string;
  createdAt: string;
};

type DemoRequestPage = {
  items: DemoRequest[];
  total: number;
  take: number;
  skip: number;
  counts: Record<string, number>;
};

// Yorliqlar moliya.*.json → DemoReqPanel.org.* / status.* / filter.* dan
// olinadi; bu yerda faqat kalit va ranglar qoladi.
const ORG_LABEL_KEYS: Record<string, string> = {
  MAKTAB: "maktab",
  OTM: "otm",
  IDORA: "idora",
  MAHALLA: "mahalla",
  OTHER: "other",
};

const STATUS_CONFIG: Record<string, { bg: string; labelKey: string }> = {
  PENDING: { bg: "bg-amber-100 text-amber-800", labelKey: "pending" },
  CONTACTED: { bg: "bg-brand-100 text-brand-700", labelKey: "contacted" },
  CLOSED: { bg: "bg-surface-sunken text-slate-500", labelKey: "closed" },
};

const FILTERS = [
  { key: "all", labelKey: "all" },
  { key: "PENDING", labelKey: "new" },
  { key: "CONTACTED", labelKey: "inProgress" },
  { key: "CLOSED", labelKey: "closed" },
] as const;

const EMPTY_PAGE: DemoRequestPage = {
  items: [],
  total: 0,
  take: 50,
  skip: 0,
  counts: {},
};

async function fetchRequests(status: string, limit: number): Promise<DemoRequestPage> {
  const params = new URLSearchParams({ take: String(Math.min(limit, 200)) });
  if (status && status !== "all") params.set("status", status);
  const res = await apiClient(`/admin/demo-requests?${params}`);
  if (!res.ok) {
    // 403 (noto'g'ri rol) va tarmoq xatosini farqlash kerak — jimgina bo'sh
    // ro'yxat ko'rsatish "lead yo'q" degan YOLG'ON xabar berardi.
    // Kod tashlanadi, matn render joyida t() orqali tarjima qilinadi.
    throw new Error(res.status === 403 ? "FORBIDDEN" : "LOAD_FAILED");
  }
  return res.json();
}

async function updateRequest(
  id: string,
  data: { status?: string; adminNote?: string },
) {
  const res = await apiClient(`/admin/demo-requests/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Yangilab bo'lmadi");
  return res.json();
}

// ── Bitta lead kartasi ──────────────────────────────────────────────────────

function LeadCard({
  req,
  onUpdate,
  isSaving,
}: {
  req: DemoRequest;
  onUpdate: (data: { status?: string; adminNote?: string }) => void;
  isSaving: boolean;
}) {
  const t = useTranslations("DemoReqPanel");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(req.adminNote ?? "");
  const stCfg = STATUS_CONFIG[req.status] ?? STATUS_CONFIG.PENDING;

  return (
    <div className="card-surface rounded-2xl p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-slate-900">{req.organization}</h3>
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-slate-600">
              {ORG_LABEL_KEYS[req.orgType] ? t(`org.${ORG_LABEL_KEYS[req.orgType]}`) : req.orgType}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stCfg.bg}`}>
              {t(`status.${stCfg.labelKey}`)}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
            <a
              href={`tel:${req.phone}`}
              className="inline-flex items-center gap-1.5 font-medium hover:text-brand-600"
            >
              <Icon.phone aria-hidden="true" size={ICON_SIZE.xs} />
              {req.phone}
            </a>
            {req.email && (
              <a
                href={`mailto:${req.email}`}
                className="inline-flex items-center gap-1.5 hover:text-brand-600"
              >
                <Icon.mail aria-hidden="true" size={ICON_SIZE.xs} />
                {req.email}
              </a>
            )}
            <span className="text-xs text-slate-400">
              {new Date(req.createdAt).toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" })}
            </span>
          </div>

          {req.message && (
            <p className="mt-3 rounded-lg bg-surface-muted px-3 py-2 text-sm text-slate-600">
              {req.message}
            </p>
          )}

          {req.adminNote && !noteOpen && (
            <p className="mt-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
              <Icon.document aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />
              {req.adminNote}
            </p>
          )}

          {noteOpen && (
            <div className="mt-3">
              <label
                htmlFor={`note-${req.id}`}
                className="mb-1 block text-xs font-medium text-slate-500"
              >
                {t("note.label")}
              </label>
              <textarea
                id={`note-${req.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={t("note.placeholder")}
                className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    onUpdate({ adminNote: note });
                    setNoteOpen(false);
                  }}
                  disabled={isSaving}
                  className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40"
                >
                  {t("note.save")}
                </button>
                <button
                  onClick={() => {
                    setNote(req.adminNote ?? "");
                    setNoteOpen(false);
                  }}
                  className="rounded-lg bg-surface-sunken px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-line"
                >
                  {t("note.cancel")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Amallar */}
        <div className="flex shrink-0 flex-row gap-2 sm:flex-col">
          {req.status === "PENDING" && (
            <button
              onClick={() => onUpdate({ status: "CONTACTED" })}
              disabled={isSaving}
              className="rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              <Icon.phone aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />
              {t("card.contacted")}
            </button>
          )}
          {!noteOpen && (
            <button
              onClick={() => setNoteOpen(true)}
              className="rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-surface-muted"
            >
              <Icon.edit aria-hidden="true" size={ICON_SIZE.xs} className="mr-1 inline" />
              {req.adminNote ? t("card.editNote") : t("card.addNote")}
            </button>
          )}
          {req.status !== "CLOSED" && (
            <button
              onClick={() => onUpdate({ status: "CLOSED" })}
              disabled={isSaving}
              className="rounded-xl bg-surface-sunken px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-line disabled:opacity-40"
            >
              <Icon.check aria-hidden="true" size={ICON_SIZE.xs} strokeWidth={2.5} className="mr-1 inline" />
              {t("card.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sahifa ──────────────────────────────────────────────────────────────────

export default function DemoRequestsPage() {
  const t = useTranslations("DemoReqPanel");
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const [filter, setFilter] = useState<string>("all");
  const [limit, setLimit] = useState(50);

  const { data = EMPTY_PAGE, isLoading, error } = useQuery({
    queryKey: ["demo-requests", filter, limit],
    queryFn: () => fetchRequests(filter, limit),
    staleTime: 60_000,
    retry: false,
  });

  const updateMut = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { status?: string; adminNote?: string };
    }) => updateRequest(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demo-requests"] }),
  });

  // Rol darvozasi. Backend allaqachon 403 qaytaradi, lekin noto'g'ri rol
  // panelni umuman ko'rmasligi kerak — aks holda "bo'sh ro'yxat" chalkashlik
  // tug'diradi.
  if (role && role !== "SUPER_ADMIN") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="card-surface rounded-2xl p-10 text-center">
          <Icon.locked aria-hidden="true" size={32} className="mx-auto text-slate-300" />
          <p className="mt-3 font-semibold text-slate-900">{t("forbidden.title")}</p>
          <p className="mt-1 text-sm text-slate-500">
            {t("forbidden.desc")}
          </p>
        </div>
      </div>
    );
  }

  const pending = data.counts.PENDING ?? 0;
  const contacted = data.counts.CONTACTED ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Icon.checklist aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
            </span>
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("subtitle")}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800">
            {t("badges.new", { count: pending })}
          </span>
          <span className="rounded-full bg-brand-100 px-3 py-1 font-medium text-brand-700">
            {t("badges.inProgress", { count: contacted })}
          </span>
        </div>
      </div>

      {/* Holat filtri */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-line bg-white text-slate-600 hover:border-brand-300"
            }`}
          >
            {t(`filter.${f.labelKey}`)}
          </button>
        ))}
      </div>

      {error ? (
        <div className="card-surface flex flex-col items-center rounded-2xl py-14 text-center">
          <Icon.warning aria-hidden="true" size={32} strokeWidth={1.25} className="text-amber-500" />
          <p className="mt-3 font-semibold text-slate-900">
            {(error as Error).message === "FORBIDDEN"
              ? t("errors.forbidden")
              : t("errors.loadFailed")}
          </p>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["demo-requests"] })}
            className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t("retry")}
          </button>
        </div>
      ) : isLoading ? (
        <div className="py-12 text-center text-slate-400">{t("loading")}</div>
      ) : data.items.length === 0 ? (
        <div className="card-surface flex flex-col items-center rounded-2xl py-16 text-center">
          <Icon.checklist aria-hidden="true" size={32} strokeWidth={1.25} className="text-slate-300" />
          <p className="mt-2 text-slate-400">
            {filter === "all" ? t("empty.none") : t("empty.noneInStatus")}
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {data.items.map((req) => (
              <LeadCard
                key={req.id}
                req={req}
                isSaving={updateMut.isPending}
                onUpdate={(d) => updateMut.mutate({ id: req.id, data: d })}
              />
            ))}
          </div>
          {data.total > data.items.length && (
            <div className="flex flex-col items-center gap-2 py-2">
              <p className="text-center text-xs text-slate-400">
                {t("shownOf", { shown: data.items.length, total: data.total })}
              </p>
              {/* Ilgari bu boshi berk edi: 50 tadan keyin qolganini
                  ko'rishning iloji yo'q edi. */}
              <button
                onClick={() => setLimit((l) => l + 50)}
                className="min-h-10 rounded-lg border border-line-strong bg-white px-4 text-sm font-medium text-slate-700 hover:bg-surface-muted"
              >
                {t("loadMore")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
