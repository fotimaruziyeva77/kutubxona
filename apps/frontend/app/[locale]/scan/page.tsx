"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { scanUserQr } from "@/lib/api/libraries";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/store/auth.store";
import { SuccessCheck } from "@/components/ui/success-check";
import { Icon, ICON_SIZE } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { BookRow } from "@/components/books/BookCard";
import { USER_STATUS_LABELS, TRANSACTION_STATUS_LABELS, label } from "@/lib/labels.const";

type ScanResult = Awaited<ReturnType<typeof scanUserQr>>;
// TZ §VIII.1 R22 — natijaga token turi qo'shildi: static (eski bosma karta)
// bo'lsa UI kutubxonachini yangilanuvchi QR so'rashga undaydi.
type ScanOutcome = ScanResult & { tokenType: "rotating" | "static" };
type Mode = "qr" | "isbn";

// Backend Prisma `include` transaksiyaning barcha skalarlari (jumladan
// dueDate) ni qaytaradi — lib/api/libraries.ts tipida esa u e'lon qilinmagan.
// Lokal ixtiyoriy kengaytma: maydon kelmasa ham UI yiqilmaydi.
type ScanTransaction = ScanResult["transactions"][number] & {
  dueDate?: string | null;
};

// ── Aylanuvchi QR token (TZ §VIII.1 R22) ──────────────────────────────────────
// Profil sahifasi QR ichiga {"t": "<base64url>.<hmacHex>"} payload kodlaydi.
// Token serverda joriy YOKI oldingi 5 daqiqalik oynaga nisbatan tekshiriladi —
// skrinshot qilingan QR tez eskiradi.

const ROTATING_TOKEN_RE = /^[A-Za-z0-9_-]{8,}\.[0-9a-fA-F]{32,}$/;

async function resolveQrTokenApi(token: string, errMsg: string): Promise<ScanOutcome> {
  const res = await apiClient("/users/qr/resolve", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    // Server xabari o'zbekcha keladi: "QR muddati tugagan — yangilang"
    throw new Error(d.message ?? errMsg);
  }
  return res.json() as Promise<ScanOutcome>;
}

// ── zxing fallback (BarcodeDetector yo'q brauzerlar: iOS Safari, Firefox) ────
// Dinamik import — asosiy bundle kattalashmaydi; reader bir marta yuklanib
// keshda turadi. Import ham, konstruktor ham ishlamasa null qaytadi va UI
// foydalanuvchiga qo'lda kiritishni taklif qiladi.

type ZxingReaderLike = {
  decodeFromCanvas(canvas: HTMLCanvasElement): { getText(): string };
};

const zxingLoaders: Partial<Record<"qr" | "isbn", Promise<ZxingReaderLike | null>>> = {};

function loadZxingReader(kind: "qr" | "isbn"): Promise<ZxingReaderLike | null> {
  zxingLoaders[kind] ??= import("@zxing/browser")
    .then((m) =>
      kind === "qr" ? new m.BrowserQRCodeReader() : new m.BrowserMultiFormatReader()
    )
    .catch(() => null);
  return zxingLoaders[kind]!;
}

const hasNativeDetector = () =>
  typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";

const ZXING_THROTTLE_MS = 150; // har kadrda emas — CPU ni tejash uchun ~6-7 fps

const STATUS_COLORS = {
  ACTIVE: "text-green-700 bg-green-50 border-green-200",
  PENDING: "text-yellow-700 bg-yellow-50 border-yellow-200",
  BLOCKED: "text-red-700 bg-red-50 border-red-200",
  DELETED: "text-slate-700 bg-surface-muted border-line"
};
// Tarjimasi mavjud foydalanuvchi tiplari — kaliti ScanPage.userTypes.* da.
// Noma'lum tip kelsa xom qiymat ko'rsatiladi (t() ga berilsa xato bo'lardi).
const KNOWN_USER_TYPES: string[] = [
  "CITIZEN",
  "STUDENT_SCHOOL",
  "STUDENT_UNIVERSITY",
  "GOVERNMENT_EMPLOYEE",
  "TEACHER"
];

const DAY_MS = 86_400_000;

// Intl locale'ga bog'lanmagan barqaror sana formati: dd.mm.yyyy
const fmtDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

// Muddat o'tgan bo'lsa nechchi kun kechikkan (kamida 1).
const overdueDays = (due: Date) =>
  Math.max(1, Math.ceil((Date.now() - due.getTime()) / DAY_MS));

// ── ISBN Scan API ─────────────────────────────────────────────────────────────
// AUDIT-REPORT C6 — actor keladi JWT'dan (body'da userId YO'Q); savollar
// faqat serverdan olinadi va javob indekslari (answerIdx) hech qachon
// klientga yetib kelmaydi.

async function scanIsbnApi(isbn: string, errMsg: string) {
  const res = await apiClient("/transactions/isbn-scan", {
    method: "POST",
    body: JSON.stringify({ isbn })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json() as Promise<{
    scan: { id: string; isbn: string; title: string; author: string };
    requiresTest: boolean;
    resumed?: boolean;
    message?: string;
  }>;
}

// AUDIT-REPORT C6 — server-side savollar: {question, options[]} (answerIdx'siz).
async function fetchTestApi(isbnScanId: string, errMsg: string) {
  const res = await apiClient(`/transactions/isbn-scan/${isbnScanId}/test`);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json() as Promise<{
    status: "PENDING" | "CONFIRMED" | "ATTEMPTS_EXHAUSTED";
    title: string;
    author: string;
    attemptsLeft: number;
    questions: { question: string; options: string[] }[];
  }>;
}

async function submitTestApi(isbnScanId: string, answers: number[], errMsg: string) {
  const res = await apiClient(`/transactions/isbn-scan/${isbnScanId}/test`, {
    method: "POST",
    body: JSON.stringify({ answers })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message ?? errMsg);
  }
  return res.json() as Promise<{
    passed: boolean;
    correct: number;
    total: number;
    attemptsLeft: number;
  }>;
}

// ── Asosiy sahifa ─────────────────────────────────────────────────────────────

export default function ScanPage() {
  const t = useTranslations("ScanPage");
  const role = useAuthStore((s) => s.user?.role);
  const [mode, setMode] = useState<Mode>("qr");
  const modeTouchedRef = useRef(false);

  // Boshlang'ich tab rolga qarab: KITOBXON o'z sotib olgan kitobini skanlaydi
  // (ISBN), xodimlar esa navbatdagi kitobxon QR ini. useEffect'da — server
  // render har doim "qr" bo'lib, persist gidratsiyasi bilan hydration mismatch
  // bo'lmaydi; foydalanuvchi qo'lda tanlagan tab esa bosib yuborilmaydi.
  useEffect(() => {
    if (!modeTouchedRef.current && role === "KITOBXON") setMode("isbn");
  }, [role]);

  const pickMode = (m: Mode) => {
    modeTouchedRef.current = true;
    setMode(m);
  };

  return (
    <div className="min-h-screen bg-surface-muted flex flex-col items-center justify-start py-8 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-900 text-center mb-4">{t("title")}</h1>

        {/* Mode switch */}
        <div className="flex gap-1 mb-6 bg-surface-sunken rounded-xl p-1">
          <button
            type="button"
            onClick={() => pickMode("qr")}
            aria-pressed={mode === "qr"}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-12 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === "qr" ? "bg-brand-600 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Icon.camera aria-hidden="true" size={ICON_SIZE.sm} />
            {t("qrTab")}
          </button>
          <button
            type="button"
            onClick={() => pickMode("isbn")}
            aria-pressed={mode === "isbn"}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-12 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === "isbn" ? "bg-green-600 text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <Icon.book aria-hidden="true" size={ICON_SIZE.sm} />
            {t("isbnTab")}
          </button>
        </div>

        {mode === "qr" ? <QrScanPanel /> : <IsbnScanPanel />}
      </div>
    </div>
  );
}

// ── QR Skan paneli (kutubxonachi) ─────────────────────────────────────────────

function QrScanPanel() {
  const t = useTranslations("ScanPage");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanOutcome | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [manualId, setManualId] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number>(0);
  const zxingLastAttemptRef = useRef(0);
  // Brauzer skanerlashni qo'llamasa reset() kamerani behuda qayta yoqmasin.
  const scannerSupportedRef = useRef(true);

  const startCamera = async () => {
    // Ikki marta chaqirilsa eski stream sizmasin.
    if (streamRef.current) stopCamera();
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setScanning(true);
        scheduleFrame();
      }
    } catch {
      setError(t("cameraDenied"));
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    cancelAnimationFrame(animRef.current);
    setScanning(false);
  };

  useEffect(() => () => stopCamera(), []);

  const scheduleFrame = () => { animRef.current = requestAnimationFrame(scanFrame); };

  const scanFrame = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) { scheduleFrame(); return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      if (hasNativeDetector()) {
        // @ts-expect-error BarcodeDetector Web API
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const barcodes = await detector.detect(canvas);
        if (barcodes.length > 0) { await handleQrData(barcodes[0].rawValue as string); return; }
      } else {
        // iOS Safari / Firefox: BarcodeDetector yo'q — zxing fallback (LOW fix).
        const reader = await loadZxingReader("qr");
        if (!reader) {
          scannerSupportedRef.current = false;
          stopCamera();
          setError(t("qr.unsupported"));
          return;
        }
        const now = Date.now();
        if (now - zxingLastAttemptRef.current >= ZXING_THROTTLE_MS) {
          zxingLastAttemptRef.current = now;
          try {
            const decoded = reader.decodeFromCanvas(canvas);
            if (decoded) { await handleQrData(decoded.getText()); return; }
          } catch { /* bu kadrda QR topilmadi — davom etamiz */ }
        }
      }
    } catch { /* skan davom etadi */ }
    scheduleFrame();
  };

  const handleQrData = async (raw: string) => {
    stopCamera();
    setLoading(true);
    setError("");
    try {
      // Payload variantlari:
      //   {"t": "<token>"}  — aylanuvchi QR (profil sahifasi, TZ §VIII.1 R22)
      //   {"id": "SL-..."}  — legacy QR rasm (eski format)
      //   "SL-UZ-..."       — qo'lda kiritilgan / bosma kartadagi statik ID
      //   "<b64url>.<hex>"  — qo'lda kiritilgan xom aylanuvchi token
      let token: string | null = null;
      let sifatId = raw.trim();
      try {
        const p = JSON.parse(raw) as { id?: string; t?: string };
        if (p?.t) token = String(p.t);
        else if (p?.id) sifatId = String(p.id);
      } catch { /* JSON emas — plain qiymat */ }
      if (!token && ROTATING_TOKEN_RE.test(sifatId)) token = sifatId;

      if (token) {
        // Aylanuvchi token serverda yechiladi (HMAC, joriy/oldingi oyna).
        const data = await resolveQrTokenApi(token, t("qr.resolveError"));
        setResult({ ...data, tokenType: data.tokenType ?? "rotating" });
      } else {
        // Legacy yo'l o'zgarmagan — eski bosma kartalar ishlayveradi.
        const data = await scanUserQr(sifatId);
        setResult({ ...data, tokenType: "static" });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      // resolveQrTokenApi serverning o'zbekcha xabarini tashlaydi; axios
      // xatolari ("Request failed...") esa umumiy matnga almashtiriladi.
      setError(
        msg && !msg.startsWith("Request failed")
          ? msg
          : t("qr.notFound")
      );
    } finally { setLoading(false); }
  };

  const reset = () => {
    setResult(null);
    setError("");
    setManualId("");
    // Navbat tez yursin: "Yangi skan" bosilishi bilan videokadr jonli bo'ladi —
    // kutubxonachi ikkinchi tugmani bosib kamera warm-up kutmaydi.
    if (scannerSupportedRef.current) void startCamera();
  };

  const submitManual = () => {
    // Enter loading paytida qayta so'rov yubormasin.
    if (loading || !manualId.trim()) return;
    void handleQrData(manualId.trim());
  };

  return (
    <>
      <div className="relative bg-slate-900 rounded-2xl overflow-hidden mb-4" style={{ aspectRatio: "1/1" }}>
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        <canvas ref={canvasRef} className="hidden" />
        {scanning && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-56 h-56 relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-green-400 rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-green-400 rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-green-400 rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-green-400 rounded-br-lg" />
              <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-green-400/50 animate-pulse" />
            </div>
          </div>
        )}
        {!scanning && !loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <button
              type="button"
              onClick={() => void startCamera()}
              className="inline-flex min-h-12 items-center gap-2 bg-brand-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-brand-700"
            >
              <Icon.camera aria-hidden="true" size={ICON_SIZE.md} />
              {t("qr.startCamera")}
            </button>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="text-white text-center">
              {/* Chegara-spinner: aylanish o'qi qutining markazida — matn
                  glifidan farqli o'laroq tebranmaydi. */}
              <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-4 border-white/40 border-t-transparent" />
              <p className="text-sm">{t("checking")}</p>
            </div>
          </div>
        )}
      </div>

      {scanning && (
        <button
          type="button"
          onClick={stopCamera}
          className="w-full min-h-12 py-3 mb-4 rounded-xl border border-line-strong bg-surface text-sm text-slate-700 transition-colors hover:bg-surface-sunken"
        >
          {t("qr.stopCamera")}
        </button>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); submitManual(); }}
        className="card-surface rounded-xl p-4 mb-4"
      >
        <label htmlFor="scan-manual-sifatid" className="block text-xs font-medium text-slate-600 mb-2">
          {t("qr.manualLabel")}
        </label>
        <div className="flex gap-2">
          <input
            id="scan-manual-sifatid"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder="SL-UZ-14-001-0001-00001"
            autoComplete="off"
            className="flex-1 min-w-0 min-h-12 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!manualId.trim() || loading}
            className="min-h-12 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm transition-colors hover:bg-brand-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
          >
            {t("search")}
          </button>
        </div>
      </form>

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4 text-sm text-red-700">
          <p>{error}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-medium text-white transition-colors hover:bg-red-700 active:scale-[0.98]"
          >
            <Icon.refresh aria-hidden="true" size={ICON_SIZE.sm} />
            {t("retry")}
          </button>
        </div>
      )}

      {result && <UserInfoCard user={result} onReset={reset} />}
    </>
  );
}

// ── ISBN Skan paneli (foydalanuvchi — sotib olingan kitob) ───────────────────

type IsbnState = "idle" | "scanning" | "test" | "done" | "exhausted";

type ScanData = {
  scan: { id: string; isbn: string; title: string; author: string };
  requiresTest: boolean;
};

// AUDIT-REPORT C6 — savollar SERVERdan keladi (answerIdx hech qachon emas).
type TestQuestion = { question: string; options: string[] };

function IsbnScanPanel() {
  const t = useTranslations("ScanPage");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number>(0);
  const zxingLastAttemptRef = useRef(0);

  const [state, setState] = useState<IsbnState>("idle");
  const [manualIsbn, setManualIsbn] = useState("");
  const [scanData, setScanData] = useState<ScanData | null>(null);
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [attemptsLeft, setAttemptsLeft] = useState(3);
  const [answers, setAnswers] = useState<number[]>([]);
  const [testResult, setTestResult] = useState<{ passed: boolean; correct: number; total: number; attemptsLeft: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const startCamera = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setState("scanning");
        scheduleFrame();
      }
    } catch { setError(t("cameraDenied")); }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    cancelAnimationFrame(animRef.current);
  };

  useEffect(() => () => stopCamera(), []);

  const scheduleFrame = () => { animRef.current = requestAnimationFrame(scanFrame); };

  const scanFrame = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) { scheduleFrame(); return; }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      if (hasNativeDetector()) {
        // @ts-expect-error BarcodeDetector Web API
        const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "isbn"] });
        const barcodes = await detector.detect(canvas);
        if (barcodes.length > 0) { await handleIsbn(barcodes[0].rawValue as string); return; }
      } else {
        // iOS Safari / Firefox: zxing MultiFormat fallback (EAN-13/8 ham o'qiydi).
        const reader = await loadZxingReader("isbn");
        if (!reader) {
          stopCamera();
          setState("idle");
          setError(t("isbnPanel.unsupported"));
          return;
        }
        const now = Date.now();
        if (now - zxingLastAttemptRef.current >= ZXING_THROTTLE_MS) {
          zxingLastAttemptRef.current = now;
          try {
            const decoded = reader.decodeFromCanvas(canvas);
            if (decoded) { await handleIsbn(decoded.getText()); return; }
          } catch { /* bu kadrda barkod topilmadi */ }
        }
      }
    } catch {}
    scheduleFrame();
  };

  // AUDIT-REPORT C6 — savollar serverdan olinadi. Tasdiqlangan yoki
  // urinishlari tugagan skan uchun server tegishli holatni qaytaradi.
  const loadTest = async (isbnScanId: string) => {
    const test = await fetchTestApi(isbnScanId, t("isbnPanel.testFetchError"));
    if (test.status === "CONFIRMED") {
      setState("done");
      return;
    }
    if (test.status === "ATTEMPTS_EXHAUSTED") {
      setState("exhausted");
      return;
    }
    setQuestions(test.questions);
    setAttemptsLeft(test.attemptsLeft);
    setAnswers([]);
    setState("test");
  };

  const handleIsbn = async (isbn: string) => {
    stopCamera();
    setLoading(true);
    setError("");
    try {
      const data = await scanIsbnApi(isbn.replace(/[-\s]/g, ""), t("isbnPanel.scanError"));
      setScanData(data);
      // C6: har skan testdan o'tadi — savollarni serverdan olamiz.
      await loadTest(data.scan.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("isbnPanel.scanError"));
      setState("idle");
    } finally { setLoading(false); }
  };

  const handleSubmitTest = async () => {
    if (!scanData) return;
    setLoading(true);
    setError("");
    try {
      const result = await submitTestApi(scanData.scan.id, answers, t("isbnPanel.testSubmitError"));
      setTestResult(result);
      if (result.passed) {
        setState("done");
      } else if (result.attemptsLeft <= 0) {
        setState("exhausted");
      } else {
        setAttemptsLeft(result.attemptsLeft);
        setAnswers([]); // qayta urinish uchun tozalaymiz
      }
    } catch (e: unknown) {
      // Masalan: server min-vaqt darvozasi ("Test juda tez topshirildi...")
      setError(e instanceof Error ? e.message : t("isbnPanel.testSubmitError"));
    } finally { setLoading(false); }
  };

  const reset = () => {
    setState("idle"); setScanData(null); setQuestions([]); setAttemptsLeft(3);
    setAnswers([]); setTestResult(null); setError(""); setManualIsbn("");
  };

  const submitManual = () => {
    // Enter loading paytida qayta so'rov yubormasin.
    if (loading || !manualIsbn.trim()) return;
    void handleIsbn(manualIsbn);
  };

  return (
    <div className="space-y-4">
      {/* IDLE */}
      {state === "idle" && (
        <>
          <div className="card-surface rounded-xl p-4 text-center">
            <p className="text-slate-600 text-sm mb-3">
              {t("isbnPanel.intro")}
            </p>
            <button
              type="button"
              onClick={() => void startCamera()}
              className="inline-flex w-full min-h-12 items-center justify-center gap-2 bg-green-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-green-700"
            >
              <Icon.camera aria-hidden="true" size={ICON_SIZE.md} />
              {t("isbnPanel.scanButton")}
            </button>
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); submitManual(); }}
            className="card-surface rounded-xl p-4"
          >
            <label htmlFor="scan-manual-isbn" className="block text-xs font-medium text-slate-600 mb-2">
              {t("isbnPanel.manualLabel")}
            </label>
            <div className="flex gap-2">
              <input
                id="scan-manual-isbn"
                value={manualIsbn}
                onChange={(e) => setManualIsbn(e.target.value)}
                placeholder="9789943452787"
                autoComplete="off"
                inputMode="numeric"
                className="flex-1 min-w-0 min-h-12 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
              <button
                type="submit"
                disabled={!manualIsbn.trim() || loading}
                className="min-h-12 px-4 py-2 bg-green-600 text-white rounded-lg text-sm transition-colors hover:bg-green-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
              >
                {loading ? "…" : t("search")}
              </button>
            </div>
          </form>
        </>
      )}

      {/* SCANNING */}
      {state === "scanning" && (
        <>
          <div className="relative bg-slate-900 rounded-2xl overflow-hidden" style={{ aspectRatio: "4/3" }}>
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            <canvas ref={canvasRef} className="hidden" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-48 h-24 border-4 border-green-400 rounded-lg" />
            </div>
            <div className="absolute bottom-4 left-0 right-0 flex justify-center">
              <span className="rounded-full bg-slate-900/80 px-3 py-1 text-xs text-slate-100">
                {t("isbnPanel.holdBarcode")}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { stopCamera(); setState("idle"); }}
            className="w-full min-h-12 py-3 rounded-xl border border-line-strong bg-surface text-sm text-slate-700 transition-colors hover:bg-surface-sunken"
          >
            {t("cancel")}
          </button>
          {loading && (
            <p className="flex items-center justify-center gap-2 text-center text-slate-600 text-sm">
              <Spinner size="sm" label={t("checking")} />
              {t("checking")}
            </p>
          )}
        </>
      )}

      {/* TEST — savollar serverdan (C6), javob indekslari klientda yo'q */}
      {state === "test" && scanData && (
        <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
          <div className="bg-green-700 p-4 text-white">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs opacity-75">{t("isbnPanel.testTitle")}</p>
              <p className="text-xs opacity-75">{t("isbnPanel.attemptsLeft", { count: attemptsLeft })}</p>
            </div>
            <p className="font-bold">{scanData.scan.title}</p>
            <p className="text-sm opacity-80">{scanData.scan.author}</p>
          </div>
          <div className="p-4 space-y-5">
            {testResult && !testResult.passed && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <Icon.error aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
                <span>
                  {t("isbnPanel.wrongAnswers", { correct: testResult.correct, total: testResult.total, left: testResult.attemptsLeft })}
                </span>
              </div>
            )}
            {questions.map((q, qi) => (
              <div key={qi}>
                <p className="text-sm font-semibold text-slate-800 mb-2">{qi + 1}. {q.question}</p>
                <div className="space-y-2">
                  {q.options.map((opt, oi) => (
                    <label
                      key={oi}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer text-sm transition-colors ${
                        answers[qi] === oi
                          ? "border-green-500 bg-green-50"
                          : "border-line hover:border-line-strong"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`q-${qi}`}
                        value={oi}
                        checked={answers[qi] === oi}
                        onChange={() => setAnswers((prev) => { const a = [...prev]; a[qi] = oi; return a; })}
                        className="accent-green-600"
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => void handleSubmitTest()}
              disabled={answers.length < questions.length || answers.some((a) => a === undefined) || loading}
              className="w-full min-h-12 py-3 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? t("checking") : t("isbnPanel.submitAnswers")}
            </button>
          </div>
        </div>
      )}

      {/* DONE */}
      {state === "done" && scanData && (
        <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
          <div className="bg-green-600 p-5 text-white text-center">
            {/* DESIGN.md §10 — amal YAKUNLANGANINI bildiruvchi bir martalik
                animatsiya: kutubxonachi/kitobxon ikkinchi marta bosmaydi. */}
            <div className="mb-2 flex justify-center">
              <SuccessCheck size={48} label={t("isbnPanel.bookAdded")} />
            </div>
            <p className="font-bold text-lg">{t("isbnPanel.bookAddedExcl")}</p>
            <p className="text-sm opacity-80 mt-1">{t("isbnPanel.indexUpdated")}</p>
          </div>
          <div className="p-4">
            <p className="font-semibold text-slate-900">{scanData.scan.title}</p>
            <p className="text-sm text-slate-500 mb-4">{scanData.scan.author}</p>
            <p className="text-xs text-slate-400 font-mono mb-4">ISBN: {scanData.scan.isbn}</p>
            <button
              type="button"
              onClick={reset}
              className="w-full min-h-12 py-3 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700"
            >
              {t("isbnPanel.scanNew")}
            </button>
          </div>
        </div>
      )}

      {/* EXHAUSTED — 3 urinish tugadi, kitob hisobga olinmaydi (C6) */}
      {state === "exhausted" && scanData && (
        <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
          <div className="bg-red-600 p-5 text-white text-center">
            <Icon.locked aria-hidden="true" size={ICON_SIZE.xl} className="mx-auto mb-2" />
            <p className="font-bold text-lg">{t("isbnPanel.exhaustedTitle")}</p>
            <p className="text-sm opacity-80 mt-1">{t("isbnPanel.exhaustedDesc")}</p>
          </div>
          <div className="p-4">
            <p className="font-semibold text-slate-900">{scanData.scan.title}</p>
            <p className="text-sm text-slate-500 mb-4">{scanData.scan.author}</p>
            <button
              type="button"
              onClick={reset}
              className="w-full min-h-12 py-3 rounded-xl border border-line-strong bg-surface text-sm font-medium text-slate-700 transition-colors hover:bg-surface-sunken"
            >
              {t("isbnPanel.scanNew")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{error}</p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-medium text-white transition-colors hover:bg-red-700 active:scale-[0.98]"
          >
            <Icon.refresh aria-hidden="true" size={ICON_SIZE.sm} />
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── QR natija kartochkasi ─────────────────────────────────────────────────────

function UserInfoCard({ user, onReset }: { user: ScanOutcome; onReset: () => void }) {
  const t = useTranslations("ScanPage");
  const locale = useLocale();
  const canIssue = user.status === "ACTIVE";
  // Noma'lum status go-vazifasiga tushmasin: fallback neytral (DELETED) uslub.
  const statusStyle = STATUS_COLORS[user.status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.DELETED;
  const transactions = user.transactions as ScanTransaction[];

  return (
    <div className="bg-surface rounded-2xl overflow-hidden shadow-xl">
      {/* Go/no-go verdikt — kutubxonachi bir qarashda qaror qiladi */}
      {canIssue ? (
        <div className="flex items-center gap-2 bg-info-50 border-b border-info-100 px-4 py-3 text-sm font-semibold text-info-700">
          <Icon.check aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
          {t("card.canIssue")}
        </div>
      ) : (
        <div className="flex items-center gap-2 bg-red-50 border-b border-red-100 px-4 py-3 text-sm font-semibold text-red-700">
          <Icon.locked aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
          {t("card.cannotIssue", { status: label(USER_STATUS_LABELS, user.status) })}
        </div>
      )}
      <div className="bg-brand-700 p-5 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold">{user.name}</h2>
            <p className="text-blue-200 text-sm font-mono mt-0.5">{user.sifatId}</p>
          </div>
          <Icon.reader aria-hidden="true" size={ICON_SIZE.xl} strokeWidth={1.5} />
        </div>
        <div className="flex gap-3 mt-3 text-sm">
          <span className="bg-brand-600 px-2 py-0.5 rounded-full">{KNOWN_USER_TYPES.includes(user.type) ? t(`userTypes.${user.type}`) : user.type}</span>
          <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${statusStyle}`}>
            {label(USER_STATUS_LABELS, user.status)}
          </span>
          {user.tokenType === "rotating" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-300 text-green-100 text-xs font-medium">
              <Icon.check aria-hidden="true" size={ICON_SIZE.xs} />
              {t("card.liveQr")}
            </span>
          )}
        </div>
      </div>
      <div className="p-4">
        {/* TZ §VIII.1 R22 — statik (eski) QR/ID ishlatilganda undash */}
        {user.tokenType === "static" && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-xs text-amber-800">
            <Icon.pending aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
            <span>{t("card.staticWarning")}</span>
          </div>
        )}
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-slate-700">{t("card.trustScore")}</span>
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-surface-sunken rounded-full overflow-hidden">
              <div className="h-full bg-brand-600 rounded-full" style={{ width: `${user.trustScore}%` }} />
            </div>
            <span className="text-sm font-semibold text-slate-900">{user.trustScore}</span>
          </div>
        </div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("card.currentBooks", { count: transactions.length })}</h3>
        {transactions.length === 0 ? (
          <p className="text-sm text-slate-500">{t("card.noBooks")}</p>
        ) : (
          <div className="space-y-2">
            {transactions.map((tx, i) => {
              const parsed = tx.dueDate ? new Date(tx.dueDate) : null;
              const due = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
              const isOverdue = due !== null && tx.status === "BORROWED" && due.getTime() < Date.now();
              return (
                <BookRow
                  key={i}
                  book={{ id: `scan-tx-${i}`, title: tx.book.title, author: tx.book.author }}
                  tone={isOverdue ? "danger" : "default"}
                  meta={
                    <div className="flex flex-col items-end gap-1">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        tx.status === "BORROWED" ? "bg-accent-100 text-accent-700" : "bg-brand-100 text-brand-700"
                      }`}>
                        {label(TRANSACTION_STATUS_LABELS, tx.status)}
                      </span>
                      {due !== null && (
                        isOverdue ? (
                          <span className="text-xs font-semibold text-red-600">
                            {t("card.daysLate", { days: overdueDays(due) })}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">{t("card.due", { date: fmtDate(due) })}</span>
                        )
                      )}
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
        <div className="mt-4 space-y-2">
          {canIssue && (
            <Link
              href={`/${locale}/dashboard/transactions?sifatId=${encodeURIComponent(user.sifatId)}`}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700 active:scale-[0.98]"
            >
              <Icon.book aria-hidden="true" size={ICON_SIZE.sm} />
              {t("card.issueBook")}
            </Link>
          )}
          <button
            type="button"
            onClick={onReset}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-surface-sunken active:scale-[0.98]"
          >
            <Icon.refresh aria-hidden="true" size={ICON_SIZE.sm} />
            {t("card.newScan")}
          </button>
        </div>
      </div>
    </div>
  );
}
