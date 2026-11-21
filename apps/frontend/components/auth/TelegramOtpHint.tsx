"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { authApi } from "@/lib/api/auth";

/**
 * OTP_CHANNEL=telegram-bot bo'lganda: kod bizning Telegram botimiz orqali keladi,
 * shuning uchun kitobxon avval botni ochib raqamini ulashishi kerak.
 * Boshqa kanallarda hech narsa ko'rsatmaydi.
 */
export function TelegramOtpHint() {
  const t = useTranslations("auth");
  const { data } = useQuery({
    queryKey: ["auth", "otp-channel"],
    queryFn: () => authApi.otpChannel().then((r) => r.data),
    staleTime: 10 * 60 * 1000,
  });

  if (data?.channel !== "telegram-bot" || !data.botUrl) return null;

  return (
    <div className="rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 space-y-2">
      <p>{t("tgBotHint")}</p>
      <a
        href={data.botUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-700"
      >
        {t("tgBotOpen")}
      </a>
    </div>
  );
}
