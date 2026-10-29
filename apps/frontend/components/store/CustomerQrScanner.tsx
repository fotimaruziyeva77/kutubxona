"use client";

import { useEffect, useRef } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";

/**
 * Mijoz QR'ini kamera orqali skanlovchi ixcham komponent. Birinchi o'qilgan
 * QR matnini onResult(text) ga uzatadi va kamerani to'xtatadi.
 */
export default function CustomerQrScanner({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const errRef = useRef<HTMLParagraphElement>(null);
  const cbRef = useRef(onResult);
  cbRef.current = onResult;

  useEffect(() => {
    let controls: { stop: () => void } | undefined;
    let done = false;
    const reader = new BrowserQRCodeReader();
    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result, _err, ctrl) => {
        controls = ctrl;
        if (result && !done) {
          done = true;
          try { ctrl.stop(); } catch {}
          cbRef.current(result.getText());
        }
      })
      .then((c) => { controls = c; })
      .catch(() => {
        if (errRef.current) {
          errRef.current.textContent =
            "Kamera ochilmadi — ruxsat bering yoki telefon raqami orqali kiriting.";
        }
      });
    return () => { try { controls?.stop(); } catch {} };
  }, []);

  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <video
        ref={videoRef}
        className="w-full max-w-sm mx-auto rounded-xl bg-black aspect-square object-cover"
        muted
        playsInline
      />
      <p ref={errRef} className="text-xs text-red-600 mt-2 text-center"></p>
      <p className="text-xs text-slate-500 mt-2 text-center">
        Mijozning ilovasidagi QR kodni kameraga ko'rsating.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-3 w-full py-2 rounded-xl border border-line-strong text-sm font-medium text-slate-600 hover:bg-surface-muted"
      >
        Bekor qilish
      </button>
    </div>
  );
}
