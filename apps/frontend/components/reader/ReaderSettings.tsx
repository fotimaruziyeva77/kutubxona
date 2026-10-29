"use client";

/**
 * ReaderSettings — sozlamalar, YIG'ILGAN holatda.
 *
 * NEGA: bu bloklar (parol, maxfiylik, manzil o'zgartirish) avval kitobxon
 * sahifasining ENG TEPASIDA va ochiq holda turardi. Ular yiliga bir marta
 * kerak bo'ladigan amallar — har kirganda ko'rinishi sahifani "sozlamalar
 * paneli"ga aylantirib, asosiy narsani (kitoblar) pastga surib yuborardi.
 * Endi bitta yig'iladigan bo'lim.
 *
 * "Manzil o'zgartirish" maydoni ham qayta yozildi: avval foydalanuvchidan
 * xom `Address ID` (`addr-...`) so'ralardi — buni hech bir o'quvchi bilmaydi.
 * Endi so'rov faqat SABAB bilan yuboriladi va manzilni tuman admini
 * belgilaydi.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { authApi } from "@/lib/api/auth";
import { usersApi } from "@/lib/api/users";
import { apiClient } from "@/lib/api-client";

async function toggleFamilyDetection(enabled: boolean, errorMsg: string) {
  const res = await apiClient("/family/me/family-detection", {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(errorMsg);
  return res.json() as Promise<{ familyDetectionEnabled: boolean }>;
}

type Section = "name" | "password" | "privacy" | null;

export function ReaderSettings({
  name,
  familyDetectionEnabled,
  onNameSaved,
  onToast,
}: {
  name: string;
  familyDetectionEnabled: boolean;
  onNameSaved: (name: string) => void;
  onToast: (msg: string) => void;
}) {
  const t = useTranslations("ReaderBits.settings");
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>(null);

  // Ism
  const [editName, setEditName] = useState(name);
  const [savingName, setSavingName] = useState(false);

  // Parol
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Maxfiylik
  const [familyDetect, setFamilyDetect] = useState(familyDetectionEnabled);
  const [familyBusy, setFamilyBusy] = useState(false);

  const saveName = async () => {
    if (editName.trim().length < 2) return;
    setSavingName(true);
    try {
      const { data } = await usersApi.updateMe({ name: editName.trim() });
      onNameSaved(data.name);
      onToast(t("nameSaved"));
      setSection(null);
    } catch {
      onToast(t("saveError"));
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async () => {
    setPwMsg(null);
    if (newPassword.length < 8) {
      setPwMsg({ text: t("pwTooShort"), ok: false });
      return;
    }
    if (newPassword !== confirmPw) {
      setPwMsg({ text: t("pwMismatch"), ok: false });
      return;
    }
    setSavingPw(true);
    try {
      await authApi.changePassword(oldPassword, newPassword);
      setPwMsg({ text: t("pwChanged"), ok: true });
      setOldPassword("");
      setNewPassword("");
      setConfirmPw("");
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response
        ?.data?.message;
      setPwMsg({
        text: msg ?? t("pwError"),
        ok: false,
      });
    } finally {
      setSavingPw(false);
    }
  };

  const flipFamily = async () => {
    const next = !familyDetect;
    setFamilyDetect(next);
    setFamilyBusy(true);
    try {
      const res = await toggleFamilyDetection(next, t("settingSaveError"));
      setFamilyDetect(res.familyDetectionEnabled);
      onToast(next ? t("familyOn") : t("familyOff"));
    } catch (e) {
      setFamilyDetect(!next);
      onToast((e as Error).message);
    } finally {
      setFamilyBusy(false);
    }
  };

  const rows: { key: Exclude<Section, null>; label: string; icon: typeof Icon.reader }[] = [
    { key: "name", label: t("editName"), icon: Icon.reader },
    { key: "password", label: t("editPassword"), icon: Icon.locked },
    { key: "privacy", label: t("privacy"), icon: Icon.shield },
  ];

  return (
    <section className="card-surface overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-sunken text-slate-500">
            <Icon.settings aria-hidden="true" size={ICON_SIZE.sm} />
          </span>
          <span className="text-base font-bold text-slate-900">{t("title")}</span>
        </span>
        <Icon.next
          aria-hidden="true"
          size={ICON_SIZE.sm}
          className={`text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-line p-5 pt-4">
          <div className="space-y-1">
            {rows.map(({ key, label, icon: RowIcon }) => (
              <div key={key}>
                <button
                  type="button"
                  onClick={() => setSection(section === key ? null : key)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-surface-muted"
                >
                  <RowIcon aria-hidden="true" size={ICON_SIZE.sm} className="text-slate-400" />
                  <span className="flex-1">{label}</span>
                  <Icon.next
                    aria-hidden="true"
                    size={ICON_SIZE.xs}
                    className={`text-slate-300 transition-transform ${section === key ? "rotate-90" : ""}`}
                  />
                </button>

                {section === key && (
                  <div className="mb-2 ml-2 space-y-3 rounded-xl bg-surface-muted p-3">
                    {key === "name" && (
                      <>
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder={t("namePlaceholder")}
                        />
                        <Button size="sm" onClick={saveName} disabled={savingName}>
                          {savingName ? t("saving") : t("save")}
                        </Button>
                      </>
                    )}

                    {key === "password" && (
                      <>
                        <Input
                          type="password"
                          value={oldPassword}
                          onChange={(e) => setOldPassword(e.target.value)}
                          placeholder={t("currentPassword")}
                        />
                        <Input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={t("newPassword")}
                        />
                        <Input
                          type="password"
                          value={confirmPw}
                          onChange={(e) => setConfirmPw(e.target.value)}
                          placeholder={t("repeatPassword")}
                        />
                        {pwMsg && (
                          <p className={`text-xs ${pwMsg.ok ? "text-info-600" : "text-red-600"}`}>
                            {pwMsg.text}
                          </p>
                        )}
                        <Button
                          size="sm"
                          onClick={savePassword}
                          disabled={savingPw || !oldPassword || !newPassword || !confirmPw}
                        >
                          {savingPw ? t("saving") : t("updatePassword")}
                        </Button>
                      </>
                    )}

                    {key === "privacy" && (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-slate-900">
                              {t("familyDetect")}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-slate-500">
                              {t("familyDetectHint")}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={flipFamily}
                            disabled={familyBusy}
                            aria-pressed={familyDetect}
                            aria-label={t("familyDetect")}
                            className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                              familyDetect ? "bg-brand-600" : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                                familyDetect ? "translate-x-5" : "translate-x-0"
                              }`}
                            />
                          </button>
                        </div>

                        <div className="border-t border-line pt-3">
                          <p className="text-sm font-medium text-slate-900">
                            {t("addressChanged")}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-500">
                            {t("addressHint")}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
