"use client";

/**
 * Plan 06-06 ORG-03 — Public scan landing page.
 *
 * Flow: employee opens the URL printed in the QR code (held by the HR admin
 * dashboard). Page reads the `?t=` token from the query string, POSTs it to
 * /reading-hours/:id/attend, then renders one of four outcomes:
 *
 *   - 200 — qatnashganligi qayd etildi
 *   - 409 — allaqachon qatnashgan
 *   - 410 — QR muddati o'tdi
 *   - 403 — boshqa idoraga tegishli
 */

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { apiBase } from "@/lib/api/base";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

// H18 — haqiqiy route `POST /api/reading-hours/:id/attend`
// (reading-hour.controller.ts:240 + main.ts:69 global "api" prefiksi).
// Ilgari bu yerda xom `NEXT_PUBLIC_API_URL` ishlatilardi va `/api` tushib
// qolib, QR davomat skani doim 404 qaytarardi.
const API = apiBase();

type AttendState =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "success"; markedAt: string }
  | { kind: "duplicate" }
  | { kind: "expired" }
  | { kind: "forbidden" }
  | { kind: "auth-required" }
  // message xom (serverdan kelgani) saqlanadi; bo'sh bo'lsa render vaqtida
  // tarjima qilingan fallback ko'rsatiladi — t() ni effect ichida ishlatmaymiz
  // (t deps ga kirsa attend POST qayta yuborilishi mumkin edi).
  | { kind: "error"; message: string; network?: boolean };

export default function ScanReadingHourPage() {
  const t = useTranslations("ScanPage");
  const params = useParams<{ id: string; locale: string }>();
  const search = useSearchParams();
  const eventId = params?.id ?? "";
  // Kirish havolasi ilgari `/uz-Latn/auth/login` ga qotirilgan edi — ikkita
  // xato: (1) `auth/` segmenti mavjud emas, haqiqiy route `/[locale]/login`;
  // (2) ru/kaa foydalanuvchisi o'zbek lotin sahifasiga tashlanardi.
  const locale = params?.locale ?? "uz-Latn";
  const token = search?.get("t") ?? "";
  const [state, setState] = useState<AttendState>({ kind: "loading" });

  useEffect(() => {
    if (!eventId) return;
    if (!token) {
      setState({ kind: "missing-token" });
      return;
    }

    (async () => {
      try {
        const r = await fetch(`${API}/reading-hours/${eventId}/attend`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (r.status === 200 || r.status === 201) {
          const data = await r.json();
          setState({ kind: "success", markedAt: data.markedAt });
        } else if (r.status === 401) {
          setState({ kind: "auth-required" });
        } else if (r.status === 403) {
          setState({ kind: "forbidden" });
        } else if (r.status === 409) {
          setState({ kind: "duplicate" });
        } else if (r.status === 410) {
          setState({ kind: "expired" });
        } else {
          const err = await r.json().catch(() => ({}));
          setState({
            kind: "error",
            message: err.message || "",
          });
        }
      } catch (e) {
        setState({
          kind: "error",
          message: (e as Error).message ?? "",
          network: true,
        });
      }
    })();
  }, [eventId, token]);

  return (
    <div className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
      <div className="bg-white max-w-md w-full rounded-xl shadow-sm border border-line p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">
          {t("readingHour.title")}
        </h1>

        {state.kind === "loading" && (
          <p className="text-slate-500">{t("readingHour.loading")}</p>
        )}

        {state.kind === "missing-token" && (
          <p className="text-red-600">
            {t("readingHour.missingToken")}
          </p>
        )}

        {state.kind === "success" && (
          <div>
            <Icon.success aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2 text-green-600" />
            <p className="text-green-700 font-semibold">
              {t("readingHour.success")}
            </p>
            <p className="text-slate-500 text-sm mt-2">
              {t("readingHour.time", { time: new Date(state.markedAt).toLocaleString("uz-UZ") })}
            </p>
          </div>
        )}

        {state.kind === "duplicate" && (
          <div>
            <div className="text-brand-600 text-4xl mb-2">i</div>
            <p className="text-brand-700 font-semibold">
              {t("readingHour.duplicate")}
            </p>
          </div>
        )}

        {state.kind === "expired" && (
          <div>
            <div className="text-yellow-600 text-4xl mb-2">!</div>
            <p className="text-yellow-700 font-semibold">
              {t("readingHour.expired")}
            </p>
            <p className="text-slate-500 text-sm mt-2">
              {t("readingHour.expiredHint")}
            </p>
          </div>
        )}

        {state.kind === "forbidden" && (
          <div>
            <div className="text-red-600 text-4xl mb-2">×</div>
            <p className="text-red-700 font-semibold">
              {t("readingHour.forbidden")}
            </p>
          </div>
        )}

        {state.kind === "auth-required" && (
          <div>
            <p className="text-slate-700">
              {t("readingHour.authRequired")}
            </p>
            <Link
              href={`/${locale}/login`}
              className="inline-block mt-3 px-4 py-2 bg-brand-600 text-white rounded-md text-sm"
            >
              {t("readingHour.login")}
            </Link>
          </div>
        )}

        {state.kind === "error" && (
          <p className="text-red-600">
            {t("readingHour.error", {
              message:
                state.message ||
                t(state.network ? "readingHour.networkError" : "readingHour.unexpectedError"),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
