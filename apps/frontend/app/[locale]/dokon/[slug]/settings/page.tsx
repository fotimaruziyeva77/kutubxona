"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import { fetchStoreProfile, updateStore } from "@/lib/api/store";
import StoreLocationPicker from "@/components/store/StoreLocationPicker";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { Panel } from "@/components/dashboard/ui";
import { FormField, Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/error-state";

// Hafta kunlari (kalitlar profil sahifasidagi DAY_KEYS bilan mos).
// Yorliqlar tarjima faylidan (DokonSettings.days.*) olinadi.
const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const TASHKENT = { lat: 41.311081, lon: 69.279737 };

type DayHours = { open: boolean; from: string; to: string };

function defaultHours(): Record<string, DayHours> {
  const h: Record<string, DayHours> = {};
  for (const key of DAYS) {
    h[key] = { open: key !== "sunday", from: "09:00", to: "18:00" };
  }
  return h;
}

// Logo rasmini brauzerda kichraytirib (maks 256px) data-URL'ga aylantiradi.
function fileToLogoDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("img"));
      img.onload = () => {
        const MAX = 256;
        let w = img.width;
        let hgt = img.height;
        if (w > MAX || hgt > MAX) {
          const s = Math.min(MAX / w, MAX / hgt);
          w = Math.round(w * s);
          hgt = Math.round(hgt * s);
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = hgt;
        const ctx = c.getContext("2d");
        if (!ctx) return reject(new Error("ctx"));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, hgt);
        ctx.drawImage(img, 0, 0, w, hgt);
        let q = 0.85;
        let url = c.toDataURL("image/jpeg", q);
        while (url.length > 70000 && q > 0.4) {
          q -= 0.1;
          url = c.toDataURL("image/jpeg", q);
        }
        resolve(url);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export default function StoreSettingsPage({
  params,
}: {
  params: { locale: string; slug: string };
}) {
  const { locale, slug } = params;
  const t = useTranslations("DokonSettings");
  const { user, isAuthenticated } = useAuthStore();
  const qc = useQueryClient();
  const logoRef = useRef<HTMLInputElement>(null);

  const {
    data: store,
    // isPending — oflayn-pauza holatini ham qamraydi (isLoading u paytda false).
    isPending,
    isError,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ["store-profile", slug],
    queryFn: () => fetchStoreProfile(slug),
  });

  const [description, setDescription] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [logoUrl, setLogoUrl] = useState("");
  const [hours, setHours] = useState<Record<string, DayHours>>(defaultHours());
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  // Saqlanmagan o'zgarish bormi — sahifadan chiqishda ogohlantirish uchun.
  const [dirty, setDirty] = useState(false);
  const skipDirtyRef = useRef(true);

  // Do'kon yuklangach formani to'ldiramiz (faqat bir marta).
  useEffect(() => {
    if (!store || ready) return;
    setDescription(store.description ?? "");
    setPhone(store.phone ?? "");
    setAddress(store.address ?? "");
    setLat(store.lat ?? null);
    setLon(store.lon ?? null);
    setLogoUrl(store.logoUrl ?? "");
    if (store.workingHours && Object.keys(store.workingHours).length > 0) {
      const h = defaultHours();
      for (const key of DAYS) {
        const raw = store.workingHours[key];
        if (raw && raw.includes("-")) {
          const [from, to] = raw.split("-");
          h[key] = { open: true, from: from.trim(), to: to.trim() };
        } else {
          h[key] = { ...h[key], open: false };
        }
      }
      setHours(h);
    }
    setReady(true);
  }, [store, ready]);

  // Forma qiymati o'zgardi — birinchi to'ldirishdan keyingi har o'zgarish dirty.
  useEffect(() => {
    if (!ready) return;
    if (skipDirtyRef.current) {
      skipDirtyRef.current = false;
      return;
    }
    setDirty(true);
  }, [description, phone, address, lat, lon, logoUrl, hours, ready]);

  // Dirty holatda tab yopilsa/yangilansa brauzer ogohlantiradi —
  // saqlanmagan o'zgarishlar jimgina yo'qolib ketmasin.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const save = useMutation({
    mutationFn: () => {
      const workingHours: Record<string, string> = {};
      for (const key of DAYS) {
        const d = hours[key];
        workingHours[key] = d.open ? `${d.from}-${d.to}` : "";
      }
      return updateStore(store!.id, {
        description: description.trim(),
        phone: phone.trim(),
        address: address.trim(),
        lat: lat ?? undefined,
        lon: lon ?? undefined,
        logoUrl: logoUrl || undefined,
        workingHours,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-profile", slug] });
      setDirty(false);
      showToast(t("savedToast"), true);
    },
    onError: () => showToast(t("saveError"), false),
  });

  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      return showToast(t("onlyImages"), false);
    }
    setLogoBusy(true);
    try {
      setLogoUrl(await fileToLogoDataUrl(file));
    } catch {
      showToast(t("imageProcessError"), false);
    } finally {
      setLogoBusy(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      return showToast(t("geoError"), false);
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude);
        setLon(pos.coords.longitude);
      },
      () => showToast(t("geoError"), false),
    );
  };

  const setDay = (key: string, patch: Partial<DayHours>) =>
    setHours((h) => ({ ...h, [key]: { ...h[key], ...patch } }));

  // ── Guards ──
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-800 mb-2">{t("loginRequired")}</h1>
          <Link href={`/${locale}/login`} className="text-brand-600 hover:underline">{t("login")}</Link>
        </div>
      </div>
    );
  }
  if (user?.role !== "DOKON_OPERATOR" && user?.role !== "SUPER_ADMIN") {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <p className="text-red-700 font-bold">{t("operatorsOnly")}</p>
      </div>
    );
  }
  if (isPending) {
    return <div className="min-h-screen bg-surface-muted flex items-center justify-center text-slate-400">{t("loading")}</div>;
  }
  // Xato — "Yuklanmoqda…" da abadiy qolmaydi: sabab + qayta urinish.
  if (isError || !store) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
        <ErrorState
          className="w-full max-w-md"
          title={t("errorTitle")}
          message={t("errorMessage")}
          onRetry={() => refetch()}
          isRetrying={isRefetching}
        />
      </div>
    );
  }

  const mapLat = lat ?? TASHKENT.lat;
  const mapLon = lon ?? TASHKENT.lon;

  return (
    <div className="min-h-screen bg-surface-muted">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{t("title")}</h1>
            <p className="text-sm text-slate-500 mt-1">{store.name}</p>
          </div>
          <Link href={`/${locale}/dokon/${slug}/dashboard`} className="text-sm text-brand-600 hover:underline">
            {t("backToDashboard")}
          </Link>
        </div>

        {/* Asosiy ma'lumot */}
        <Panel title={t("basicInfo")} noReveal>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              {logoUrl ? (
                <img src={logoUrl} alt="logo" className="w-16 h-16 rounded-xl object-cover border border-line" />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-surface-sunken border border-line flex items-center justify-center text-slate-300">
                  <Icon.store aria-hidden="true" size={ICON_SIZE.lg} />
                </div>
              )}
              <div className="flex flex-col gap-1.5 items-start">
                <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={(e) => onLogo(e.target.files?.[0])} />
                <button type="button" onClick={() => logoRef.current?.click()} disabled={logoBusy}
                  className="px-3 py-1.5 bg-surface-sunken hover:bg-line rounded-lg text-sm font-medium text-slate-700 disabled:opacity-50">
                  {logoBusy ? t("loading") : logoUrl ? t("logoReplace") : t("logoUpload")}
                </button>
                {logoUrl && <button type="button" onClick={() => setLogoUrl("")} className="text-xs text-red-500 hover:underline">{t("remove")}</button>}
              </div>
            </div>
            <FormField id="store-phone" label={t("phone")}>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998 71 234 56 78" />
            </FormField>
            <FormField id="store-address" label={t("address")}>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("addressPlaceholder")} />
            </FormField>
            <FormField id="store-description" label={t("description")}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder={t("descriptionPlaceholder")}
                className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
              />
            </FormField>
          </div>
        </Panel>

        {/* Joylashuv */}
        <Panel
          title={t("location")}
          noReveal
          action={
            <button type="button" onClick={useMyLocation} className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
              <Icon.map aria-hidden="true" size={ICON_SIZE.sm} />
              {t("myLocation")}
            </button>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t("mapHint")}</p>
            <StoreLocationPicker
              key={`${mapLat.toFixed(5)},${mapLon.toFixed(5)}`}
              lat={mapLat}
              lon={mapLon}
              onPick={(la, lo) => { setLat(la); setLon(lo); }}
            />
            <div className="text-xs">
              {lat != null && lon != null ? (
                // Xom koordinata operatorga hech narsa aytmaydi — inson tilida
                // tasdiq, aniq qiymat esa title (hover) da qoladi.
                <span
                  className="inline-flex items-center gap-1 text-green-700 font-medium"
                  title={`${lat.toFixed(5)}, ${lon.toFixed(5)}`}
                >
                  <Icon.check aria-hidden="true" size={ICON_SIZE.xs} />
                  {t("locationSet")}
                </span>
              ) : (
                <span className="text-slate-500">{t("locationUnset")}</span>
              )}
            </div>
          </div>
        </Panel>

        {/* Ish vaqti */}
        <Panel title={t("workingHours")} noReveal>
          <div className="space-y-2">
            {DAYS.map((key) => {
              const d = hours[key];
              const label = t(`days.${key}`);
              return (
                <div key={key} className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                    <input type="checkbox" checked={d.open} onChange={(e) => setDay(key, { open: e.target.checked })} />
                    <span className="text-sm text-slate-700">{label}</span>
                  </label>
                  {d.open ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={d.from}
                        onChange={(e) => setDay(key, { from: e.target.value })}
                        aria-label={t("openTimeAria", { day: label })}
                        className="border border-line-strong rounded-lg px-2 py-1 text-sm"
                      />
                      <span className="text-slate-400">—</span>
                      <input
                        type="time"
                        value={d.to}
                        onChange={(e) => setDay(key, { to: e.target.value })}
                        aria-label={t("closeTimeAria", { day: label })}
                        className="border border-line-strong rounded-lg px-2 py-1 text-sm"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-slate-400">{t("dayOff")}</span>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="flex justify-end gap-3">
          <Link href={`/${locale}/dokon/${slug}`} className="px-4 py-2.5 text-sm text-slate-600 hover:text-slate-900">
            {t("viewProfile")}
          </Link>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-6 py-2.5 rounded-xl font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50"
          >
            {save.isPending ? t("saving") : t("save")}
          </button>
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ${toast.ok ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
