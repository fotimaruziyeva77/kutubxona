"use client";

/**
 * Plan 06-06 ORG-03 — Reading Hour event detail page.
 *
 * Three sections:
 *   1. QR display — polls /idora/:institutionId/reading-hours/:eventId/qr every
 *      4 minutes (just before the 5-min rotation flips backend-side). Shows
 *      large QR + countdown. Token embeds in URL of /scan/reading-hour/:id?t=...
 *      that employees scan.
 *   2. Attendance list — table of {name, scannedAt, department}.
 *   3. Media gallery — upload form (multipart) + thumbnail grid + Tasdiqlash
 *      button (DRAFT→PUBLISHED). Tasdiqlash enabled only when >=1 media.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useAuthStore } from "@/store/auth.store";
import { apiClient } from "@/lib/api-client";
import { apiClient as axiosClient } from "@/lib/api/client";

// FIX (reading-hour detail auth) — calls go through the token-attaching clients
// instead of `fetch(`${API}/...`, { credentials: "include" })`, which sent only
// the HttpOnly refresh cookie, never the in-memory Bearer token (H16), so calls
// 401'd. JSON GET/POST/PATCH use the fetch-wrapper `apiClient`; the media
// (FormData) upload uses the raw axios instance `axiosClient` for multipart.
// Paths are BARE — axios baseURL is `<origin>/api`.

// Refresh just before the 5-min server-side rotation flips (4 minutes).
const QR_REFRESH_MS = 240_000;

interface QrTokenResponse {
  token: string;
  expiresAt: string;
  windowStart: number;
}

interface EventDetail {
  id: string;
  institutionId: string;
  title: string;
  heldAt: string;
  venue?: string;
  status: "DRAFT" | "PUBLISHED" | "CANCELLED";
  attendances: Array<{ id: string; userId: string; markedAt: string }>;
  media: Array<{
    id: string;
    url: string;
    mimeType: string;
    sizeBytes: number;
    uploadedAt: string;
  }>;
}

export default function ReadingHourDetailPage() {
  const t = useTranslations("ReadingHourPanel.detail");
  const params = useParams<{ id: string }>();
  const eventId = params?.id ?? "";
  const { user } = useAuthStore();
  const institutionId = user?.organizationId ?? "";
  const queryClient = useQueryClient();

  // ── Event detail ──────────────────────────────────────────────────────
  const { data: event, isLoading } = useQuery<EventDetail>({
    queryKey: ["reading-hour", institutionId, eventId],
    queryFn: async () => {
      const r = await apiClient(
        `/idora/${institutionId}/reading-hours/${eventId}`,
      );
      if (!r.ok) throw new Error("Tadbir topilmadi");
      return r.json();
    },
    enabled: !!institutionId && !!eventId,
  });

  // ── QR token polling (every 4 minutes) ───────────────────────────────
  const [qr, setQr] = useState<QrTokenResponse | null>(null);
  const [countdown, setCountdown] = useState(QR_REFRESH_MS / 1000);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!institutionId || !eventId) return;

    const fetchToken = async () => {
      try {
        const r = await apiClient(
          `/idora/${institutionId}/reading-hours/${eventId}/qr`,
          { method: "POST" },
        );
        if (!r.ok) return;
        const data = (await r.json()) as QrTokenResponse;
        setQr(data);
        setCountdown(QR_REFRESH_MS / 1000);
      } catch {
        // Retry on next interval.
      }
    };

    fetchToken();
    intervalRef.current = setInterval(fetchToken, QR_REFRESH_MS);

    const countdownTimer = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearInterval(countdownTimer);
    };
  }, [institutionId, eventId]);

  // ── Media upload ──────────────────────────────────────────────────────
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // Raw axios instance for multipart — Bearer token via interceptor.
      // Override the instance default application/json so axios sets
      // multipart/form-data with the boundary for the FormData body.
      try {
        const r = await axiosClient.post(
          `/idora/${institutionId}/reading-hours/${eventId}/media`,
          form,
          { headers: { "Content-Type": "multipart/form-data" } },
        );
        return r.data;
      } catch (e: any) {
        throw new Error(e?.response?.data?.message || t("uploadError"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["reading-hour", institutionId, eventId],
      });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const r = await apiClient(
        `/idora/${institutionId}/reading-hours/${eventId}/finalize`,
        { method: "PATCH" },
      );
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message || "Tasdiqlashda xato");
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["reading-hour", institutionId, eventId],
      });
    },
  });

  if (isLoading || !event) {
    return <div className="p-8 text-slate-500">{t("loading")}</div>;
  }

  const scanUrl = qr
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/uz-Latn/scan/reading-hour/${eventId}?t=${encodeURIComponent(qr.token)}`
    : "";

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{event.title}</h1>
          <p className="text-slate-500 text-sm mt-1">
            {new Date(event.heldAt).toLocaleString("uz-UZ")}
            {event.venue ? ` — ${event.venue}` : ""}
          </p>
        </div>
        <StatusBadge status={event.status} />
      </div>

      {/* QR Display */}
      <section className="card-surface rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">{t("qrTitle")}</h2>
        {qr ? (
          <div className="flex flex-col items-center gap-3">
            <QrCanvas data={scanUrl} />
            <div className="text-sm text-slate-500 font-mono break-all max-w-md text-center">
              {scanUrl}
            </div>
            <div className="text-xs text-slate-400">
              {t("qrCountdown", { seconds: countdown })}
            </div>
          </div>
        ) : (
          <div className="text-slate-400">{t("qrLoading")}</div>
        )}
      </section>

      {/* Attendance list */}
      <section className="card-surface rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">
          {t("attendeesTitle", { count: event.attendances.length })}
        </h2>
        {event.attendances.length === 0 ? (
          <p className="text-slate-500 text-sm">{t("noScans")}</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500 border-b">
              <tr>
                <th className="py-2">{t("userIdCol")}</th>
                <th className="py-2">{t("markedAtCol")}</th>
              </tr>
            </thead>
            <tbody>
              {event.attendances.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-2 font-mono text-xs">{a.userId}</td>
                  <td className="py-2">
                    {new Date(a.markedAt).toLocaleString("uz-UZ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {/* Media gallery + upload */}
      <section className="card-surface rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {t("mediaTitle", { count: event.media.length })}
          </h2>
          {event.status === "DRAFT" && (
            <button
              disabled={event.media.length < 1 || finalizeMutation.isPending}
              onClick={() => finalizeMutation.mutate()}
              className="px-4 py-2 bg-brand-600 text-white rounded-md disabled:bg-gray-300 text-sm"
            >
              {t("finalizeButton")}
            </button>
          )}
        </div>

        {event.status === "DRAFT" && event.media.length < 4 && (
          <label className="block mb-4">
            <span className="text-sm text-slate-600">
              {t("uploadLabel")}
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
              className="mt-1 block w-full text-sm"
              disabled={uploadMutation.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadMutation.mutate(f);
              }}
            />
            {uploadMutation.error && (
              <p className="text-red-600 text-sm mt-1">
                {(uploadMutation.error as Error).message}
              </p>
            )}
          </label>
        )}

        {event.media.length === 0 ? (
          <p className="text-slate-500 text-sm">{t("noMedia")}</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {event.media.map((m) => (
              <MediaTile key={m.id} eventId={eventId} institutionId={institutionId} media={m} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("ReadingHourPanel.detail");
  const color =
    status === "PUBLISHED"
      ? "bg-green-100 text-green-700"
      : status === "DRAFT"
        ? "bg-surface-sunken text-slate-700"
        : "bg-red-100 text-red-700";
  const label =
    status === "PUBLISHED" ? t("statusPublished") : status === "DRAFT" ? t("statusDraft") : t("statusCancelled");
  return (
    <span className={`px-3 py-1 rounded-full text-sm font-semibold ${color}`}>
      {label}
    </span>
  );
}

/**
 * Minimal QR renderer — calls a public QR data URL service. In prod the
 * project may bundle qrcode.js client-side; this fallback avoids adding
 * a new dep just for the SSR-friendly first cut.
 */
function QrCanvas({ data }: { data: string }) {
  const t = useTranslations("ReadingHourPanel.detail");
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(data)}`;
  return (
    <img
      src={url}
      alt={t("qrAlt")}
      width={320}
      height={320}
      className="border border-line rounded"
    />
  );
}

function MediaTile({
  eventId,
  institutionId,
  media,
}: {
  eventId: string;
  institutionId: string;
  media: { id: string; url: string; mimeType: string };
}) {
  const t = useTranslations("ReadingHourPanel.detail");
  const [signed, setSigned] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiClient(
          `/idora/${institutionId}/reading-hours/${eventId}/media/${media.id}/signed-url`,
        );
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setSigned(data.url);
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, institutionId, media.id]);

  if (!signed) {
    return <div className="aspect-square bg-surface-sunken rounded animate-pulse" />;
  }
  if (media.mimeType.startsWith("video/")) {
    return (
      <video src={signed} controls className="aspect-square w-full object-cover rounded" />
    );
  }
  return (
    <img
      src={signed}
      alt={t("mediaAlt")}
      className="aspect-square w-full object-cover rounded"
    />
  );
}
