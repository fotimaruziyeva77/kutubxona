"use client";

/**
 * ReservationNextSteps — bron yuborilgandan keyingi «keyingi qadam» oynasi.
 *
 * NEGA KERAK: avval bron bosilgach faqat tugma matni "Bron qilindi" ga
 * o'zgarardi (yoki toast chiqardi) va kitobxon nima bo'lishini bilmay
 * qolardi: kutubxonachi tasdiqlashi kerakmi, qachongacha, qayerga borish,
 * kitobni qanday olish. Bu oyna o'sha uch qadamni bitta joyda aytadi va
 * QR'ga / bronlar ro'yxatiga to'g'ri havola beradi.
 *
 * Sana — backend qaytargan `reservationExpiresAt` (24 soat qoidasi serverda).
 * Sana kelmasa aniq soat O'YLAB TOPILMAYDI — umumiy "24 soat" matni chiqadi.
 */

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { fmtDayMonthTime } from "@/lib/format";
import { Modal } from "@/components/ui/modal";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";

export type ReservationInfo = {
  bookTitle: string;
  libraryName?: string | null;
  libraryAddress?: string | null;
  libraryWorkHours?: string | null;
  /** Kutubxona ommaviy sahifasi — berilsa 2-qadam nomi havola bo'ladi. */
  libraryHref?: string | null;
  /** Backend `BookTransaction.reservationExpiresAt` (ISO). */
  expiresAt?: string | null;
};

export function ReservationNextSteps({
  info,
  onClose,
}: {
  /** null — oyna yopiq. */
  info: ReservationInfo | null;
  onClose: () => void;
}) {
  const t = useTranslations("ReservationSteps");
  const locale = useLocale();
  // Toshkent vaqti, raqamli format (lib/format.ts — nega Intl oy nomlari emas).
  const expiresText = info?.expiresAt ? fmtDayMonthTime(info.expiresAt) : null;
  const expiresValid = expiresText !== null && expiresText !== "—";

  const steps: { icon: LucideIcon; title: string; body: React.ReactNode }[] = [
    {
      icon: Icon.pending,
      title: t("step1Title"),
      body: expiresValid
        ? t("step1Desc", { date: expiresText })
        : t("step1DescNoDate"),
    },
    {
      icon: Icon.library,
      title: t("step2Title"),
      body: (
        <>
          {info?.libraryName ? (
            info.libraryHref ? (
              <Link
                href={info.libraryHref}
                className="font-semibold text-brand-700 underline underline-offset-2"
              >
                {info.libraryName}
              </Link>
            ) : (
              <span className="font-semibold text-slate-800">{info.libraryName}</span>
            )
          ) : (
            <span>{t("step2Unknown")}</span>
          )}
          {(info?.libraryAddress || info?.libraryWorkHours) && (
            <span className="mt-1 block text-xs text-slate-500">
              {[info?.libraryAddress, info?.libraryWorkHours].filter(Boolean).join(" · ")}
            </span>
          )}
        </>
      ),
    },
    {
      icon: Icon.qr,
      title: t("step3Title"),
      body: t("step3Desc"),
    },
  ];

  return (
    <Modal
      open={info !== null}
      title={t("title")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-line-strong px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-muted"
          >
            {t("close")}
          </button>
          <Link
            href={`/${locale}/profile`}
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-brand-200 bg-brand-50 px-4 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-100"
          >
            {t("myBrons")}
          </Link>
          <Link
            href={`/${locale}/profile#qr`}
            onClick={onClose}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            <Icon.qr aria-hidden="true" size={ICON_SIZE.sm} />
            {t("showQr")}
          </Link>
        </>
      }
    >
      <div className="flex items-start gap-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
        <Icon.check aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} className="mt-0.5 shrink-0" />
        <p>{t("lead", { title: info?.bookTitle ?? "" })}</p>
      </div>

      <ol className="mt-4 space-y-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              <s.icon aria-hidden="true" size={ICON_SIZE.sm} />
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">
                {i + 1}
              </span>
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-sm font-semibold text-slate-900">{s.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
