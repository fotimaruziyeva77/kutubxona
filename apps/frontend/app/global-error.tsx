"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import "@/app/globals.css";

/**
 * global-error.tsx — ROOT darajadagi Error Boundary (DESIGN.md §8).
 *
 * Bu fayl `[locale]/layout.tsx` ning O'ZI yiqilganda ishlaydi — ya'ni
 * NextIntlClientProvider ham, `<html>`/`<body>` ham mavjud emas. Shu sababli:
 *
 *  1. O'z `<html>` va `<body>` teglarini render qiladi (Next talabi).
 *  2. `useTranslations` ISHLATILMAYDI — i18n konteksti yo'q, u ham yiqilishi
 *     mumkin. Matn to'rt tilda birdaniga ko'rsatiladi: qaysi til buzilganini
 *     bilmaymiz, lekin foydalanuvchi o'zinikini topadi.
 *  3. Tailwind klasslari o'rniga inline uslub — CSS yuklanmagan bo'lishi ham
 *     mumkin bo'lgan yagona sahifa shu.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="uz">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: "#f9fafb",
          color: "#111827",
        }}
      >
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          {/* lucide inline SVG — Tailwind yuklanmagan bo'lsa ham chiziladi,
              o'lchami `size` atributi orqali beriladi (klassga bog'liq emas). */}
          <div style={{ color: "#dc2626" }}>
            <Icon.warning aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.5} />
          </div>

          <h1
            style={{
              margin: "1.5rem 0 0",
              fontSize: "1.5rem",
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            Tizimda jiddiy xatolik
          </h1>

          <p
            style={{
              margin: "0.75rem 0 0",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#6b7280",
            }}
          >
            Sahifani yuklab bo'lmadi. Bu bizning tomondagi muammo — qayta
            urinib ko'ring yoki birozdan so'ng qaytib keling.
          </p>

          <p
            style={{
              margin: "0.5rem 0 0",
              fontSize: "0.8125rem",
              lineHeight: 1.6,
              color: "#9ca3af",
            }}
          >
            Страница не загрузилась. Попробуйте ещё раз или вернитесь позже.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "2rem",
              minHeight: "3rem",
              padding: "0 1.5rem",
              fontSize: "1rem",
              fontWeight: 500,
              color: "#ffffff",
              background: "#2563eb",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
            }}
          >
            Qayta urinish / Повторить
          </button>

          {error.digest && (
            <p
              style={{
                margin: "1.5rem 0 0",
                fontSize: "0.6875rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                color: "#9ca3af",
              }}
            >
              {/* Operator log bilan bog'lashi uchun — foydalanuvchidan shu
                  kodni so'raymiz, stack trace'ni hech qachon ko'rsatmaymiz. */}
              Xato kodi: {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
