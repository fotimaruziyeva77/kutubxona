"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

/**
 * Kitob orqasidagi shtrix-kodni (EAN-13 / ISBN) telefon yoki noutbuk kamerasi
 * bilan o'qiydi. Chrome/Android — BarcodeDetector; iOS Safari/Firefox — zxing.
 * Faqat nazorat raqami to'g'ri 13 xonali kod qabul qilinadi (noto'g'ri o'qishdan himoya).
 */

type ZxingReaderLike = { decodeFromCanvas(canvas: HTMLCanvasElement): { getText(): string } };
type DetectorLike = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

let zxingLoader: Promise<ZxingReaderLike | null> | null = null;
const loadZxing = () =>
  (zxingLoader ??= import("@zxing/browser").then((m) => new m.BrowserMultiFormatReader()).catch(() => null));

const ZXING_THROTTLE_MS = 150;

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0;
}

export function IsbnBarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("BooksPanel.scanner");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let lastZxing = 0;
    let detector: DetectorLike | null = null;

    const Native = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => DetectorLike }).BarcodeDetector;
    if (Native) {
      try {
        detector = new Native({ formats: ["ean_13"] });
      } catch {
        detector = null;
      }
    }

    const finish = (code: string) => {
      stopped = true;
      if (navigator.vibrate) navigator.vibrate(80);
      onDetected(code);
    };

    const loop = async () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            if (detector) {
              const found = await detector.detect(canvas);
              const code = found.map((b) => b.rawValue).find(isValidEan13);
              if (code) return finish(code);
            } else if (Date.now() - lastZxing >= ZXING_THROTTLE_MS) {
              lastZxing = Date.now();
              const reader = await loadZxing();
              if (!reader) {
                setError(t("unsupported"));
                return;
              }
              try {
                const code = reader.decodeFromCanvas(canvas).getText();
                if (isValidEan13(code)) return finish(code);
              } catch {
                /* bu kadrda kod topilmadi */
              }
            }
          } catch {
            /* keyingi kadr */
          }
        }
      }
      raf = requestAnimationFrame(() => void loop());
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(t("unsupported"));
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
          setReady(true);
          void loop();
        }
      } catch {
        setError(t("denied"));
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onDetected, t]);

  return (
    <div className="space-y-2 rounded-xl border border-line bg-slate-950 p-2">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} playsInline muted className="aspect-video w-full object-cover" />
        <canvas ref={canvasRef} className="hidden" />
        {ready && !error && (
          // Shtrix-kodni joylash uchun ramka
          <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-24 -translate-y-1/2 rounded-md border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
            <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 animate-pulse bg-red-500/80" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white">
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="flex items-center gap-1.5 text-xs text-slate-300">
          <Icon.info aria-hidden="true" size={ICON_SIZE.xs} />
          {t("hint")}
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      </div>
    </div>
  );
}
