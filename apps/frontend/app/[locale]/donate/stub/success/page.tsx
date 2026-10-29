"use client";

/**
 * Plan 03-03 DONAT-01 — Dev-only stub success page.
 *
 * Honored ONLY when the backend has `DEV_DONATION_PAYMENT_STUB=true` AND
 * `NODE_ENV ∈ {development, test, dev}` (Plan 03-01 fail-CLOSED boot guard
 * ensures production never reaches here). This page POSTs to the Payme
 * webhook with the synthetic paymentId so the dev flow exercises the real
 * idempotency + status-update code path end-to-end. The real Payme/Click
 * success redirect lands in Phase 4 PAY-01..08.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLocale } from "next-intl";
import { apiClient } from "@/lib/api-client";

type WebhookState = "submitting" | "success" | "error";

export default function DonateStubSuccessPage() {
  const locale = useLocale();
  const searchParams = useSearchParams();
  const paymentId = searchParams?.get("paymentId") ?? null;
  const [state, setState] = useState<WebhookState>("submitting");
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    if (!paymentId) {
      setState("error");
      setErrorMessage("paymentId topilmadi (URL noto'g'ri)");
      return;
    }
    let cancelled = false;
    async function postWebhook() {
      try {
        const res = await apiClient("/donate/webhook/payme", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: paymentId,
            result: { transaction: paymentId },
          }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setErrorMessage(
            err?.message ?? `Webhook xato: HTTP ${res.status}`,
          );
          setState("error");
        } else {
          setState("success");
        }
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(
          e instanceof Error ? e.message : "Webhook chaqirilmadi",
        );
        setState("error");
      }
    }
    postWebhook();
    return () => {
      cancelled = true;
    };
  }, [paymentId]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
      <div className="rounded-2xl border border-yellow-300 bg-yellow-50 p-8 shadow-sm">
        <div className="mb-2 inline-block rounded-full bg-yellow-200 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-yellow-900">
          DEV STUB MODE
        </div>
        <h1 className="text-2xl font-bold text-slate-900">
          {state === "submitting" && "To'lov tasdiqlanmoqda..."}
          {state === "success" && "Donat muvaffaqiyatli qabul qilindi"}
          {state === "error" && "Webhook xatosi"}
        </h1>

        {paymentId && (
          <p className="mt-2 text-sm text-slate-600">
            Payment ID:{" "}
            <code className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-xs">
              {paymentId}
            </code>
          </p>
        )}

        {state === "submitting" && (
          <p className="mt-4 text-slate-700">
            Webhookga POST yuborilmoqda — bu DEV STUB rejim. Haqiqiy Payme/Click
            integratsiyasi Phase 4 da yetkaziladi.
          </p>
        )}

        {state === "success" && (
          <p className="mt-4 text-green-700">
            Donat yozuvi PAID holatiga o'tdi. Idempotency cache faollashtirildi
            (7 kun TTL).
          </p>
        )}

        {state === "error" && (
          <p className="mt-4 text-red-700">
            {errorMessage}
          </p>
        )}

        <div className="mt-6">
          <Link
            href={`/${locale}/donate`}
            className="inline-block rounded-lg border border-line-strong bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-surface-muted"
          >
            ← Donat sahifasiga qaytish
          </Link>
        </div>
      </div>
    </main>
  );
}
