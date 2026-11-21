"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiClient } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api-error";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

interface SystemVersion {
  current: string;
  latest: { sha: string; message: string; date: string } | null;
  updateAvailable: boolean;
  updater: { installed: boolean; requested: boolean; status: string | null; logTail: string | null };
}

const getVersion = () => apiClient.get<SystemVersion>("/admin/system/version").then((r) => r.data);
const startUpdate = () => apiClient.post("/admin/system/update").then((r) => r.data);

/**
 * SUPER_ADMIN uchun: GitHub'da yangi versiya yig'ilgan bo'lsa ogohlantiradi va
 * bir tugma bilan serverda yangilashni boshlaydi (deploy/install-updater.sh).
 */
export function SystemUpdateBanner() {
  const t = useTranslations("SystemUpdate");
  const [waiting, setWaiting] = useState(false); // so'rov yuborildi, natija kutilmoqda
  const [done, setDone] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const startedFrom = useRef<string | null>(null);

  const q = useQuery({
    queryKey: ["system-version"],
    queryFn: getVersion,
    // Yangilash ketayotganda tez-tez, aks holda 10 daqiqada bir tekshiradi.
    refetchInterval: waiting ? 5_000 : 10 * 60_000,
    retry: false,
    // Backend qayta ishga tushayotganda so'rov xato beradi — bu normal.
    throwOnError: false,
  });

  const start = useMutation({
    mutationFn: startUpdate,
    onSuccess: () => {
      startedFrom.current = q.data?.current ?? null;
      setWaiting(true);
    },
  });

  // Yangi versiya ishga tushdimi? (backend yangi APP_VERSION bilan javob beradi)
  useEffect(() => {
    const d = q.data;
    if (!waiting || !d) return;
    if (d.updater.status === "failed" && !d.updater.requested) {
      setWaiting(false);
      setShowLog(true);
    } else if (startedFrom.current && d.current !== startedFrom.current) {
      setWaiting(false);
      setDone(true);
    }
  }, [q.data, waiting]);

  const d = q.data;
  if (!d) return null;

  if (done) {
    return (
      <Bar tone="green">
        <span className="flex-1">{t("done")}</span>
        <button type="button" onClick={() => window.location.reload()} className={btn}>
          {t("reload")}
        </button>
      </Bar>
    );
  }

  if (waiting || d.updater.status === "running" || d.updater.requested) {
    return (
      <Bar tone="blue">
        <Icon.refresh aria-hidden="true" size={ICON_SIZE.sm} className="animate-spin" />
        <span className="flex-1">{t("running")}</span>
      </Bar>
    );
  }

  const failed = d.updater.status === "failed";
  if (!d.updateAvailable && !failed) return null;

  return (
    <Bar tone={failed ? "red" : "amber"}>
      <div className="flex-1">
        <p className="font-semibold">{failed ? t("failed") : t("available")}</p>
        {d.latest && !failed && (
          <p className="mt-0.5 text-xs opacity-80">
            {d.latest.message} · {new Date(d.latest.date).toLocaleString()}
          </p>
        )}
        {!d.updater.installed && <p className="mt-1 text-xs">{t("notInstalled")}</p>}
        {start.error && <p className="mt-1 text-xs">{apiErrorMessage(start.error as never)}</p>}
        {showLog && d.updater.logTail && (
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/80 p-2 text-[11px] text-white">
            {d.updater.logTail}
          </pre>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {failed && d.updater.logTail && (
          <button type="button" onClick={() => setShowLog((v) => !v)} className={btnGhost}>
            {t("log")}
          </button>
        )}
        {d.updater.installed && (
          <button
            type="button"
            disabled={start.isPending}
            onClick={() => {
              if (window.confirm(t("confirm"))) start.mutate();
            }}
            className={btn}
          >
            {failed ? t("retry") : t("update")}
          </button>
        )}
      </div>
    </Bar>
  );
}

const btn =
  "inline-flex h-9 items-center rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50";
const btnGhost =
  "inline-flex h-9 items-center rounded-lg border border-current px-3 text-sm font-semibold hover:bg-white/40";

function Bar({ tone, children }: { tone: "amber" | "blue" | "green" | "red"; children: React.ReactNode }) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    green: "border-green-200 bg-green-50 text-green-900",
    red: "border-red-200 bg-red-50 text-red-900",
  } as const;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 border-b px-4 py-3 text-sm sm:px-6 ${tones[tone]}`}>
      {children}
    </div>
  );
}
