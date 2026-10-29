"use client";

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { StatusPage } from "@/components/ui/status-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * 500 / render xatosi — segment darajasidagi Error Boundary (DESIGN.md §8).
 *
 * Next.js bu faylni `[locale]` ostidagi har qanday sahifa render paytida
 * yiqilganda ko'rsatadi. `reset()` — segmentni qayta render qilishga urinish
 * (to'liq sahifa reload emas), shuning uchun "Qayta urinish" tez ishlaydi.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("errors");

  useEffect(() => {
    // Xatoni kuzatuvga yuboramiz — busiz prod'da faqat foydalanuvchi ko'radi.
    // `digest` server tomonidagi log yozuvi bilan bog'lash uchun kalit.
    Sentry.captureException(error);
  }, [error]);

  const isDev = process.env.NODE_ENV === "development";

  return (
    <StatusPage
      code={error.digest ? `500 · ${error.digest}` : "500"}
      icon={Icon.warning}
      tone="danger"
      title={t("serverError.title")}
      description={t("serverError.description")}
      actions={
        <>
          <Button size="touch" onClick={reset}>
            {t("actions.retry")}
          </Button>
          <Link
            href={`/${locale}`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            {t("actions.home")}
          </Link>
        </>
      }
      footer={
        isDev ? (
          <details className="text-left">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
              {t("technicalDetail")}
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-100">
              {error.stack ?? error.message}
            </pre>
          </details>
        ) : undefined
      }
    />
  );
}
