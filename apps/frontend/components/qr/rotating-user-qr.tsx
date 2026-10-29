"use client";

/**
 * TZ §VIII.1 (QR kod dinamik) + §XV.R22 (skrinshot soxtalash) — aylanuvchi
 * foydalanuvchi QR kodi.
 *
 * - GET /users/me/qr dan {qrCode, token, expiresInSeconds} oladi; qrCode
 *   ichida payload {"t": "<HMAC-imzoli token>"} kodlangan.
 * - Muddat tugashidan ~30 soniya OLDIN avtomatik qayta so'raydi — ekranda
 *   doim amaldagi oynaning tokeni turadi (server oldingi oynani ham grace
 *   sifatida qabul qiladi, shuning uchun chegarada skan uzilmaydi).
 * - Pastida nozik countdown indikator: jonli nuqta + "yangilanadi" matni +
 *   ingichka progress chiziq.
 * - OFLAYN yoki server xatosida: legacy {"id": sifatId} payloadli statik QR
 *   klient tomonda chiziladi (qrcode paketi dinamik import) va "Oflayn
 *   rejim — statik QR" belgisi ko'rsatiladi; ulanish qaytishi bilan (online
 *   event yoki 30s retry) aylanuvchi rejimga o'zi qaytadi.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api/client";

const REFRESH_LEAD_S = 30; // muddat tugashidan necha soniya oldin yangilash
const MIN_REFRESH_S = 5; // server juda kichik muddat qaytarsa ham min interval
const OFFLINE_RETRY_MS = 30_000;

interface RotatingQrResponse {
  sifatId: string;
  /** Data URL — payload: {"t": token} */
  qrCode: string;
  token: string;
  expiresInSeconds: number;
  expiresAt: string;
  windowSeconds: number;
  tokenType: "rotating";
}

type QrMode = "loading" | "rotating" | "static";

export function RotatingUserQr({
  sifatId,
  sizeClass = "w-36 h-36",
}: {
  sifatId: string;
  /** Tailwind o'lcham klassi, masalan "w-48 h-48" */
  sizeClass?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [mode, setMode] = useState<QrMode>("loading");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const totalSecondsRef = useRef(300);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Oflayn fallback: legacy formatdagi ({"id": sifatId}) statik QR —
  // skan sahifasi bu formatni eskidan tushunadi.
  const loadStaticFallback = useCallback(async () => {
    try {
      const { toDataURL } = await import("qrcode");
      const dataUrl = await toDataURL(JSON.stringify({ id: sifatId }), {
        width: 300,
        margin: 2,
        color: { dark: "#1e40af", light: "#ffffff" },
      });
      if (!mountedRef.current) return;
      setSrc(dataUrl);
      setMode("static");
    } catch {
      if (mountedRef.current) setMode("static"); // src yo'q — matnli fallback
    }
  }, [sifatId]);

  const loadRotating = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    try {
      const { data } = await apiClient.get<RotatingQrResponse>("/users/me/qr");
      if (!mountedRef.current) return;
      setSrc(data.qrCode);
      setMode("rotating");
      setSecondsLeft(data.expiresInSeconds);
      totalSecondsRef.current = data.windowSeconds || 300;
      // ~30s oldin yangilaymiz — server oldingi oynani ham qabul qilgani
      // uchun chegara holatlarida ham skan muvaffaqiyatli bo'ladi.
      const refreshInS = Math.max(data.expiresInSeconds - REFRESH_LEAD_S, MIN_REFRESH_S);
      refreshTimer.current = setTimeout(loadRotating, refreshInS * 1000);
    } catch {
      if (!mountedRef.current) return;
      await loadStaticFallback();
      // Ulanish qaytganda avtomatik tiklanish
      refreshTimer.current = setTimeout(loadRotating, OFFLINE_RETRY_MS);
    }
  }, [loadStaticFallback]);

  useEffect(() => {
    mountedRef.current = true;
    void loadRotating();

    const tick = setInterval(
      () => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)),
      1000,
    );
    const onOnline = () => void loadRotating();
    window.addEventListener("online", onOnline);

    return () => {
      mountedRef.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      clearInterval(tick);
      window.removeEventListener("online", onOnline);
    };
  }, [loadRotating]);

  const progressPct = Math.max(
    0,
    Math.min(100, (secondsLeft / totalSecondsRef.current) * 100),
  );

  return (
    <div className="shrink-0 flex flex-col items-center">
      {mode === "loading" && (
        <div className={`${sizeClass} rounded-xl border bg-surface-sunken animate-pulse`} />
      )}

      {mode !== "loading" && src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="QR Code" className={`${sizeClass} rounded-xl border`} />
      )}

      {mode === "static" && !src && (
        <div
          className={`${sizeClass} rounded-xl border bg-surface-muted flex items-center justify-center p-2`}
        >
          <p className="font-mono text-[10px] text-slate-500 text-center break-all">
            {sifatId}
          </p>
        </div>
      )}

      {mode === "rotating" && (
        <div className="w-full mt-1.5">
          <div className="h-0.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-1000 ease-linear"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="text-[10px] text-slate-400 text-center mt-1 flex items-center justify-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Jonli QR · {secondsLeft}s da yangilanadi
          </p>
        </div>
      )}

      {mode === "static" && (
        <p className="text-[10px] text-accent-600 text-center mt-1.5 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
          Oflayn rejim — statik QR
        </p>
      )}
    </div>
  );
}
