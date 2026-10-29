"use client";

/**
 * Plan 06-04 SCH-05 — Debate detail page.
 *
 * - Renders debate metadata (topic, date, venue, participants, summary).
 * - DRAFT state: shows media upload form (≤4 files, ≤50MB/file, MIME whitelist)
 *   + "Tasdiqlash" finalize button (disabled until ≥1 media uploaded).
 * - PUBLISHED state: shows media grid with presigned URL thumbnails.
 *
 * Auth: cookie-based via apiClient (axios withCredentials).
 */
import { useState, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// FIX: token-attaching apiClient (Bearer interceptor + 401→refresh→retry).
// Raw `axios` + withCredentials never authenticated these calls → 401.
// apiClient.baseURL is `<origin>/api`, so paths are bare (API = "").
import { apiClient as axios } from "@/lib/api/client";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { DashboardPage, PageHeader, Panel } from "@/components/dashboard/ui";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner, PageSpinner } from "@/components/ui/spinner";
import { EVENT_STATUS_LABELS, label } from "@/lib/labels.const";

const API = "";
const MAX_FILE_BYTES = 50_000_000;
const MAX_FILES = 4;
const ACCEPTED = "image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime";

type Debate = {
  id: string;
  topic: string;
  heldAt: string;
  venue: string | null;
  participants: number;
  summary: string | null;
  status: "DRAFT" | "PUBLISHED";
  mediaUrls: string[];
};

type Media = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
};

// 404 ("topilmadi") ni server xatosidan ajratish uchun belgili xato.
type DebateQueryError = Error & { notFound?: boolean };

function notFoundError(): DebateQueryError {
  const e: DebateQueryError = new Error("Debat topilmadi");
  e.notFound = true;
  return e;
}

export default function DebateDetailPage() {
  const params = useParams<{ clubId: string; debateId: string }>();
  const locale = useLocale();
  const t = useTranslations("DebatePage");
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  // Yuklash jarayoni hisoblagichi — null bo'lsa yuklash ketmayapti.
  const [uploadState, setUploadState] = useState<{ done: number; total: number } | null>(null);

  const axiosCfg = { withCredentials: true } as const;

  const {
    data: debate,
    isLoading: debateLoading,
    isError: debateIsError,
    error: debateError,
    refetch: refetchDebate,
  } = useQuery<Debate, DebateQueryError>({
    queryKey: ["debate", params.debateId],
    queryFn: async () => {
      let list: Debate[];
      try {
        const r = await axios.get(`${API}/club/${params.clubId}/debates`, axiosCfg);
        list = r.data as Debate[];
      } catch (err) {
        // Klub 404 = "topilmadi"; qolgan hamma narsa server/tarmoq xatosi.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) throw notFoundError();
        throw err;
      }
      const found = list.find((d) => d.id === params.debateId);
      if (!found) throw notFoundError();
      return found;
    },
    retry: (failureCount, err) => !err?.notFound && failureCount < 2,
  });

  const {
    data: media,
    isLoading: mediaLoading,
    isError: mediaIsError,
    refetch: refetchMedia,
  } = useQuery<Media[]>({
    queryKey: ["debate-media", params.debateId],
    queryFn: () =>
      axios
        .get(`${API}/club/${params.clubId}/debates/${params.debateId}/media`, axiosCfg)
        .then((r) => r.data),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return axios.post(
        `${API}/club/${params.clubId}/debates/${params.debateId}/media`,
        fd,
        { withCredentials: true, headers: { "Content-Type": "multipart/form-data" } },
      );
    },
    onSuccess: () => {
      refetchMedia();
      qc.invalidateQueries({ queryKey: ["debate", params.debateId] });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: () =>
      axios.patch(
        `${API}/club/${params.clubId}/debates/${params.debateId}/finalize`,
        {},
        axiosCfg,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["debate", params.debateId] });
    },
  });

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Ikkinchi bosishdan himoya: partiya tugamaguncha yangi tanlov qabul qilinmaydi.
    if (uploadState) return;
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const newErrors: string[] = [];
    const remaining = MAX_FILES - (media?.length ?? 0);
    if (files.length > remaining) {
      newErrors.push(t("errFilesLeft", { remaining, max: MAX_FILES }));
    }
    const batch = files.slice(0, Math.max(remaining, 0));
    if (batch.length === 0) {
      setUploadErrors(newErrors);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploadState({ done: 0, total: batch.length });
    try {
      for (const f of batch) {
        if (f.size > MAX_FILE_BYTES) {
          newErrors.push(t("errTooLarge", { name: f.name }));
        } else {
          try {
            await uploadMutation.mutateAsync(f);
          } catch (err: unknown) {
            const ax = err as { response?: { data?: { message?: string } } };
            newErrors.push(`${f.name}: ${ax.response?.data?.message ?? t("errUploadFallback")}`);
          }
        }
        setUploadState((s) => (s ? { ...s, done: s.done + 1 } : s));
      }
    } finally {
      setUploadState(null);
      setUploadErrors(newErrors);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const backHref = `/${locale}/dashboard/club`;
  const backLink = (
    <Link
      href={backHref}
      className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
    >
      <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
      {t("backToClub")}
    </Link>
  );

  if (debateLoading) {
    return (
      <DashboardPage>
        <PageSpinner label={t("loading")} />
      </DashboardPage>
    );
  }

  // 404 — debat yo'q: bu server xatosi emas, qayta urinish ma'nosiz.
  if (debateIsError && debateError?.notFound) {
    return (
      <DashboardPage>
        {backLink}
        <EmptyState
          icon={Icon.club}
          title={t("notFoundTitle")}
          description={t("notFoundDesc")}
          action={
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
            >
              {t("backToClub")}
            </Link>
          }
        />
      </DashboardPage>
    );
  }

  // Server/tarmoq xatosi — qayta urinish taklif qilinadi.
  if (debateIsError || !debate) {
    return (
      <DashboardPage>
        {backLink}
        <ErrorState
          title={t("errorTitle")}
          message={t("errorMessage")}
          onRetry={() => refetchDebate()}
        />
      </DashboardPage>
    );
  }

  const mediaCount = media?.length ?? 0;
  const canFinalize = debate.status === "DRAFT" && mediaCount >= 1;
  const uploading = uploadState !== null;

  return (
    <DashboardPage>
      {backLink}

      <PageHeader
        icon={Icon.club}
        title={`«${debate.topic}»`}
        action={
          <span
            className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
              debate.status === "PUBLISHED"
                ? "bg-green-100 text-green-700"
                : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {label(EVENT_STATUS_LABELS, debate.status)}
          </span>
        }
      />

      <p className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-slate-500">
        <Icon.calendar aria-hidden="true" size={ICON_SIZE.xs} />
        {new Date(debate.heldAt).toLocaleDateString("uz-UZ")}
        {debate.venue && <span className="inline-flex items-center gap-1"> · <Icon.map aria-hidden="true" size={ICON_SIZE.xs} />{debate.venue}</span>}
        <span className="inline-flex items-center gap-1"> · <Icon.readers aria-hidden="true" size={ICON_SIZE.xs} />{t("participantCount", { count: debate.participants })}</span>
      </p>
      {debate.summary && <p className="text-slate-700">{debate.summary}</p>}

      {/* Media list */}
      <Panel
        title={t("mediaTitle", { count: mediaCount, max: MAX_FILES })}
        icon={Icon.camera}
        action={
          debate.status === "DRAFT" && mediaCount < MAX_FILES ? (
            <label
              aria-disabled={uploading || undefined}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white ${
                uploading
                  ? "pointer-events-none cursor-not-allowed bg-brand-600 opacity-60"
                  : "cursor-pointer bg-brand-600 hover:bg-brand-700"
              }`}
            >
              {uploadState ? (
                <>
                  <Spinner size="sm" label={t("uploadingFile")} />
                  {t("uploadingProgress", {
                    done: Math.min(uploadState.done + 1, uploadState.total),
                    total: uploadState.total,
                  })}
                </>
              ) : (
                <>
                  <Icon.add aria-hidden="true" size={ICON_SIZE.sm} />
                  {t("addFile")}
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED}
                className="hidden"
                disabled={uploading}
                onChange={handleFileChange}
              />
            </label>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {uploadErrors.length > 0 && (
            <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 space-y-1">
              {uploadErrors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

          {mediaLoading ? (
            <div className="flex justify-center py-8 text-brand-600">
              <Spinner size="lg" label={t("mediaLoading")} />
            </div>
          ) : mediaIsError ? (
            <ErrorState
              title={t("mediaErrorTitle")}
              message={t("mediaErrorMessage")}
              onRetry={() => refetchMedia()}
            />
          ) : mediaCount === 0 ? (
            <p className="text-sm text-slate-500 italic">{t("noFiles")}</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {media!.map((m) => {
                const isImage = m.mimeType.startsWith("image/");
                return (
                  <div key={m.id} className="border border-line rounded-lg overflow-hidden">
                    {isImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.thumbnailUrl ?? m.url}
                        alt={t("mediaAlt")}
                        className="w-full h-32 object-cover"
                      />
                    ) : (
                      <video src={m.url} controls className="w-full h-32 object-cover" />
                    )}
                    <div className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500">
                      {isImage ? (
                        <Icon.camera aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0" />
                      ) : (
                        <Icon.document aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0" />
                      )}
                      <span className="truncate">{isImage ? t("image") : t("video")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {/* Finalize */}
      {debate.status === "DRAFT" && (
        <button
          type="button"
          disabled={!canFinalize || finalizeMutation.isPending}
          onClick={() => finalizeMutation.mutate()}
          className="px-6 py-3 bg-green-600 text-white rounded-xl font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {finalizeMutation.isPending ? t("finalizing") : t("finalize")}
        </button>
      )}

      {debate.status === "DRAFT" && !canFinalize && (
        <p className="text-sm text-slate-500">
          {t("finalizeHint")}
        </p>
      )}
    </DashboardPage>
  );
}
