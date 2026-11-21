"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { reserveBook } from "@/lib/api/libraries";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/**
 * Kitob sahifasidagi bron bloki. Kirmagan foydalanuvchiga "Kirish /
 * Ro'yxatdan o'tish" oynasi chiqadi (keyin AYNAN shu sahifaga qaytadi);
 * kirgan kitobxon shu yerning o'zida bron qiladi.
 */
export function BookReserveBox({
  locale,
  bookId,
  available,
  availableCount,
  totalCount,
  libraryName,
  libraryHref,
  authorHref,
}: {
  locale: string;
  bookId: string;
  available: boolean;
  availableCount: number;
  totalCount: number;
  libraryName?: string | null;
  libraryHref: string;
  authorHref: string;
}) {
  const t = useTranslations("BookPage");
  const [authOpen, setAuthOpen] = useState(false);
  const back = `/${locale}/book/${encodeURIComponent(bookId)}`;
  const next = encodeURIComponent(back);

  const reserve = useMutation({ mutationFn: () => reserveBook(bookId) });
  const errMsg = (() => {
    const res = (reserve.error as { response?: { data?: { message?: string | string[] } } } | null)?.response;
    const m = res?.data?.message;
    return Array.isArray(m) ? m.join(", ") : m || t("reserveError");
  })();

  const onReserve = () => {
    if (!hasAuthHintCookie()) {
      setAuthOpen(true);
      return;
    }
    reserve.mutate();
  };

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-brand-600 shadow-sm">
            <Icon.bookClosed aria-hidden="true" size={ICON_SIZE.sm} />
          </span>
          <div>
            <p className={`text-xl font-bold ${available ? "text-brand-700" : "text-slate-500"}`}>
              {available ? t("free") : t("unavailable")}
            </p>
            <p className="text-xs text-slate-500">
              {available ? t("available", { count: availableCount, total: totalCount }) : libraryName}
            </p>
          </div>
        </div>
        {available && libraryName && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
            <Icon.library aria-hidden="true" size={ICON_SIZE.xs} className="shrink-0 text-brand-500" />
            <span className="truncate">{libraryName}</span>
          </span>
        )}
      </div>

      {reserve.isSuccess ? (
        <div role="status" className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <p className="font-semibold">{t("reservedTitle")}</p>
          <p className="mt-1">{t("reservedText")}</p>
          <Link href={`/${locale}/profile`} className="mt-2 inline-block font-semibold text-green-700 underline">
            {t("goProfile")}
          </Link>
        </div>
      ) : available ? (
        <button
          type="button"
          onClick={onReserve}
          disabled={reserve.isPending}
          className="btn-shine mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 disabled:opacity-60"
        >
          <Icon.bookmark aria-hidden="true" size={ICON_SIZE.sm} />
          {reserve.isPending ? t("reserving") : t("reserve")}
        </button>
      ) : (
        <Link
          href={libraryHref}
          className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold text-white transition hover:bg-brand-700"
        >
          {t("openLibrary")}
        </Link>
      )}
      {reserve.isError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {errMsg}
        </p>
      )}

      <Link
        href={authorHref}
        className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-white text-sm font-semibold text-slate-700 transition hover:border-brand-300 hover:text-brand-700"
      >
        <Icon.search aria-hidden="true" size={ICON_SIZE.sm} />
        {t("moreByAuthor")}
      </Link>

      {authOpen && (
        <AuthDialog
          onClose={() => setAuthOpen(false)}
          loginHref={`/${locale}/login?next=${next}`}
          registerHref={`/${locale}/register?next=${next}`}
        />
      )}
    </div>
  );
}

function AuthDialog({
  onClose,
  loginHref,
  registerHref,
}: {
  onClose: () => void;
  loginHref: string;
  registerHref: string;
}) {
  const t = useTranslations("BookPage");
  const firstRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        className="quick-view w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <Icon.locked aria-hidden="true" size={ICON_SIZE.md} />
          </span>
          <button type="button" onClick={onClose} aria-label={t("close")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <Icon.close aria-hidden="true" size={ICON_SIZE.sm} />
          </button>
        </div>
        <h2 id="auth-dialog-title" className="mt-4 text-lg font-bold text-slate-900">
          {t("authTitle")}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{t("authText")}</p>
        <div className="mt-5 grid gap-2">
          <Link
            ref={firstRef}
            href={loginHref}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white hover:bg-brand-700"
          >
            {t("login")}
          </Link>
          <Link
            href={registerHref}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-brand-200 bg-white text-sm font-bold text-brand-700 hover:bg-brand-50"
          >
            {t("register")}
          </Link>
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">{t("authFree")}</p>
      </div>
    </div>
  );
}
