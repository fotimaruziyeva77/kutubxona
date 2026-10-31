"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneField } from "@/components/ui/PhoneField";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { authApi } from "@/lib/api/auth";
import { usersApi } from "@/lib/api/users";
import { useAuthStore } from "@/store/auth.store";
import { fetchMyStore } from "@/lib/api/store";
import Link from "next/link";
import { LogoMark, Wordmark } from "@/components/brand/Logo";

type Mode = "login" | "forgot-send" | "forgot-verify" | "forgot-reset";

export default function LoginPage() {
  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const { setTokens, setUser } = useAuthStore();

  // DEV ONLY — when true, the forgot-password flow collapses to a single
  // card (phone + new password + confirm). The backend bypass also accepts
  // any OTP, but the UI shouldn't even ASK for one. Build is refused in
  // production via next.config.js guard.
  const skipOtp = process.env.NEXT_PUBLIC_DISABLE_OTP === "true";

  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendTimer, setResendTimer] = useState(0);

  // Kirish maydonlari
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");

  // Parol tiklash maydonlari
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const normalizePhone = (p: string) => {
    const clean = p.replace(/[\s\-\(\)]/g, "");
    return clean.startsWith("+") ? clean : "+" + clean;
  };

  /**
   * Server xatosini FOYDALANUVCHI TILIGA o'giradi.
   *
   * Muammo: rate-limitga tushganda ekranda NestJS'ning xom xabari
   * "ThrottlerException: Too Many Requests" chiqardi — inglizcha, texnik
   * va nima qilish kerakligini aytmaydi. Muassasaga sotiladigan mahsulotda
   * bu havaskorlik taassuroti beradi, qolaversa foydalanuvchi parolini
   * noto'g'ri deb o'ylab qayta-qayta urinaveradi va blokni uzaytiradi.
   *
   * NestJS validatsiya xatosi `message` ni MASSIV sifatida qaytaradi,
   * shuning uchun ikkala shakl ham qo'llab-quvvatlanadi.
   */
  const humanizeError = (e: unknown, fallback: string): string => {
    const res = (e as { response?: { status?: number; data?: { message?: unknown } } })?.response;

    if (res?.status === 429) {
      return "Urinishlar soni chegaradan oshdi. Xavfsizlik uchun kirish vaqtincha to'xtatildi — 15 daqiqadan so'ng qayta urinib ko'ring.";
    }
    if (res?.status === 401 || res?.status === 403) {
      return "Telefon raqam yoki parol noto'g'ri.";
    }

    const raw = res?.data?.message;
    const text = Array.isArray(raw) ? raw.join(". ") : typeof raw === "string" ? raw : null;

    // Framework istisno nomlari ("ThrottlerException: ...") hech qachon
    // ekranga chiqmasin — bu ichki tafsilot.
    if (!text || /Exception|Error:/i.test(text)) return fallback;
    return text;
  };

  // C11: middleware auth gate /dashboard, /profile, ... ga kirmoqchi bo'lgan
  // anonim foydalanuvchini `/login?next=<asl yo'l>` ga yuboradi. Kirish
  // muvaffaqiyatli bo'lgach o'sha yo'lga qaytaramiz. Open-redirect oldini
  // olish uchun faqat shu sayt ichidagi nisbiy yo'l ("/...") qabul qilinadi:
  // "//evil.com" (protokolsiz tashqi manzil), "/\evil.com" (brauzer "\" ni
  // "/" deb normallashtiradi) va absolyut URL lar rad etiladi.
  // window.location.search dan o'qiymiz — useSearchParams() Suspense talab
  // qiladi, bu yerda esa qiymat faqat bosish paytida kerak.
  const safeNextPath = (): string | null => {
    if (typeof window === "undefined") return null;
    const next = new URLSearchParams(window.location.search).get("next");
    if (!next) return null;
    if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
      return null;
    }
    return next;
  };

  const redirectAfterAuth = async () => {
    // ?next= bo'lsa — o'sha himoyalangan yo'lga qaytaramiz (ustuvor).
    const next = safeNextPath();
    if (next) {
      router.push(next);
      return;
    }
    // Har rol o'z paneliga tushadi — kutubxonachi/muassasa admini admin "Bosh
    // panel"iga (u /admin/* endpointlarni chaqirib 403 beradi) emas, o'z
    // paneliga boradi. DOKON_OPERATOR esa o'z do'koni CRM'iga.
    const role = useAuthStore.getState().user?.role;
    if (role === "DOKON_OPERATOR") {
      try {
        const store = await fetchMyStore();
        if (store?.slug) {
          router.push(`/${locale}/dokon/${store.slug}/dashboard`);
          return;
        }
      } catch {
        /* fallback below */
      }
    }
    // Oddiy kitobxon admin dashboardga EMAS, o'z profiliga tushadi (u yerdan
    // bosh sahifa, qidiruv, reytinglarga o'tadi). Dashboard faqat xodim/admin
    // rollari uchun.
    if (role === "KITOBXON") {
      router.push(`/${locale}/profile`);
      return;
    }
    // Rolga mos dashboard ichki paneli (yo'q bo'lsa — admin "Bosh panel").
    const ROLE_LANDING: Record<string, string> = {
      KUTUBXONACHI: "muassasa",
      MUASSASA_ADMIN: "muassasa",
      KLUB_RAHBARI: "club",
      BUXGALTER: "buxgalter",
    };
    const sub = role ? ROLE_LANDING[role] : undefined;
    router.push(`/${locale}/dashboard${sub ? `/${sub}` : ""}`);
  };

  const startResendTimer = () => {
    setResendTimer(60);
    const id = setInterval(() => {
      setResendTimer(t => { if (t <= 1) { clearInterval(id); return 0; } return t - 1; });
    }, 1000);
  };

  // ── Kirish ──────────────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!phone) { setError("Telefon raqamini kiriting"); return; }
    if (!password) { setError("Parolni kiriting"); return; }
    setLoading(true); setError("");
    try {
      const { data } = await authApi.login(normalizePhone(phone), password);
      // INFRA-02: refresh token is now an HttpOnly cookie set by the backend.
      // setTokens only takes the access token (in-memory + localStorage).
      setTokens(data.accessToken);
      const profile = await usersApi.getMe();
      setUser(profile.data);
      redirectAfterAuth();
    } catch (e: unknown) {
      setError(humanizeError(e, "Telefon yoki parol noto'g'ri"));
    } finally { setLoading(false); }
  };

  // ── Parolni unutdim — OTP yuborish ──────────────────────────────────
  const handleForgotSendOtp = async () => {
    if (!phone) { setError("Telefon raqamini kiriting"); return; }
    setLoading(true); setError("");
    try {
      await authApi.sendOtp(normalizePhone(phone), "reset");
      setMode("forgot-verify");
      startResendTimer();
    } catch (e: unknown) {
      setError(humanizeError(e, "SMS yuborishda xato"));
    } finally { setLoading(false); }
  };

  // ── Parolni unutdim — OTP tasdiqlash ────────────────────────────────
  const handleForgotVerify = async () => {
    if (otp.length !== 6) { setError("6 raqamli kodni kiriting"); return; }
    setLoading(true); setError("");
    try {
      await authApi.verifyOtp(normalizePhone(phone), otp);
      setMode("forgot-reset");
    } catch (e: unknown) {
      setError(humanizeError(e, "Noto'g'ri kod"));
    } finally { setLoading(false); }
  };

  // ── DEV-only collapsed reset: phone + new password in a single submit ──
  // sendOtp is called first so backend-side checks (rate-limit, "phone not
  // found") still surface as errors. verifyOtp is skipped — backend's
  // resetPassword endpoint does not consult OTP state. Then resetPassword.
  const handleDevReset = async () => {
    if (!phone) { setError("Telefon raqamini kiriting"); return; }
    const normalized = normalizePhone(phone);
    if (normalized.length < 12) { setError("Telefon raqamni to'g'ri kiriting (+998XXXXXXXXX)"); return; }
    if (newPassword.length < 8) { setError("Parol kamida 8 ta belgi bo'lishi kerak"); return; }
    if (newPassword !== confirmPassword) { setError("Parollar mos emas"); return; }
    setLoading(true); setError("");
    try {
      await authApi.sendOtp(normalized, "reset");
      const { data } = await authApi.resetPassword(normalized, newPassword);
      // INFRA-02: refresh token now lives in the HttpOnly cookie set by /password/reset.
      setTokens(data.accessToken);
      const profile = await usersApi.getMe();
      setUser(profile.data);
      redirectAfterAuth();
    } catch (e: unknown) {
      setError(humanizeError(e, "Parol tiklanmadi"));
    } finally { setLoading(false); }
  };

  // ── Yangi parol o'rnatish ────────────────────────────────────────────
  const handleResetPassword = async () => {
    if (newPassword.length < 8) { setError("Parol kamida 8 ta belgi bo'lishi kerak"); return; }
    if (newPassword !== confirmPassword) { setError("Parollar mos emas"); return; }
    setLoading(true); setError("");
    try {
      const { data } = await authApi.resetPassword(normalizePhone(phone), newPassword);
      // INFRA-02: refresh token now lives in the HttpOnly cookie set by /password/reset.
      setTokens(data.accessToken);
      const profile = await usersApi.getMe();
      setUser(profile.data);
      redirectAfterAuth();
    } catch (e: unknown) {
      setError(humanizeError(e, "Parol tiklanmadi"));
    } finally { setLoading(false); }
  };

  return (
    <main className="min-h-screen bg-surface-muted flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <LogoMark size={64} className="mx-auto mb-4" />
          <h1 className="text-3xl"><Wordmark /></h1>
          <p className="text-slate-500 mt-2">Milliy kitobxonlik platformasiga xush kelibsiz</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {mode === "login"         && "Tizimga kirish"}
              {mode === "forgot-send"   && (skipOtp ? t("login.devBypassReset.title") : "Parolni tiklash")}
              {mode === "forgot-verify" && "SMS kodni tasdiqlang"}
              {mode === "forgot-reset"  && "Yangi parol o'rnating"}
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            {/* ── KIRISH FORMASI ── */}
            {mode === "login" && (
              <>
                <div>
                  <label className="text-sm font-medium mb-1 block">Telefon raqam</label>
                  <PhoneField
                    value={phone}
                    onChange={setPhone}
                    onKeyDown={e => e.key === "Enter" && handleLogin()}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Parol</label>
                  <PasswordInput
                    placeholder="Parolingizni kiriting"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleLogin()}
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-sm text-brand-600 hover:underline"
                    onClick={() => { setMode("forgot-send"); setError(""); }}
                  >
                    Parolni unutdingizmi?
                  </button>
                </div>
                <Button className="w-full" size="lg" onClick={handleLogin} disabled={loading}>
                  {loading ? "Tekshirilmoqda..." : "Kirish"}
                </Button>
              </>
            )}

            {/* ── PAROLNI UNUTDIM — TELEFON ── */}
            {mode === "forgot-send" && !skipOtp && (
              <>
                <p className="text-sm text-slate-600">
                  Telefon raqamingizni kiriting — tasdiqlash kodi yuboramiz.
                </p>
                <div>
                  <label className="text-sm font-medium mb-1 block">Telefon raqam</label>
                  <PhoneField
                    value={phone}
                    onChange={setPhone}
                    onKeyDown={e => e.key === "Enter" && handleForgotSendOtp()}
                  />
                </div>
                <Button className="w-full" size="lg" onClick={handleForgotSendOtp} disabled={loading}>
                  {loading ? "Yuborilmoqda..." : "SMS olish"}
                </Button>
                <button
                  className="w-full text-sm text-slate-500 hover:text-slate-700"
                  onClick={() => { setMode("login"); setError(""); }}
                >
                  ← Kirishga qaytish
                </button>
              </>
            )}

            {/* ── DEV bypass: single-card reset (phone + new password) ── */}
            {mode === "forgot-send" && skipOtp && (
              <>
                <div className="bg-yellow-50 text-yellow-800 text-xs px-3 py-2 rounded border border-yellow-200">
                  {t("login.devBypassReset.banner")}
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Telefon raqam</label>
                  <PhoneField
                    value={phone}
                    onChange={setPhone}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Yangi parol</label>
                  <PasswordInput
                    placeholder="Kamida 8 ta belgi"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Parolni tasdiqlang</label>
                  <PasswordInput
                    placeholder="Parolni qayta kiriting"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleDevReset()}
                  />
                </div>
                <Button className="w-full" size="lg" onClick={handleDevReset} disabled={loading}>
                  {loading ? "Saqlanmoqda..." : "Parolni tiklash"}
                </Button>
                <button
                  className="w-full text-sm text-slate-500 hover:text-slate-700"
                  onClick={() => { setMode("login"); setError(""); }}
                >
                  ← Kirishga qaytish
                </button>
              </>
            )}

            {/* ── PAROLNI UNUTDIM — OTP ── */}
            {mode === "forgot-verify" && (
              <>
                <div className="bg-blue-50 text-brand-700 text-sm px-4 py-3 rounded-lg">
                  <strong>{phone}</strong> raqamiga 6 raqamli kod yuborildi
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Tasdiqlash kodi</label>
                  <Input
                    placeholder="000000"
                    maxLength={6}
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, ""))}
                    className="text-center text-3xl tracking-[0.5em] font-mono"
                    autoFocus
                    onKeyDown={e => e.key === "Enter" && handleForgotVerify()}
                  />
                </div>
                <Button className="w-full" size="lg" onClick={handleForgotVerify} disabled={loading}>
                  {loading ? "Tekshirilmoqda..." : "Tasdiqlash"}
                </Button>
                <div className="flex justify-between text-sm">
                  <button className="text-slate-500 hover:underline" onClick={() => { setMode("forgot-send"); setError(""); }}>
                    ← Orqaga
                  </button>
                  <button
                    className="text-brand-600 hover:underline disabled:text-slate-400"
                    onClick={handleForgotSendOtp}
                    disabled={resendTimer > 0 || loading}
                  >
                    {resendTimer > 0 ? `Qayta yuborish (${resendTimer}s)` : "Qayta yuborish"}
                  </button>
                </div>
              </>
            )}

            {/* ── YANGI PAROL ── */}
            {mode === "forgot-reset" && (
              <>
                <div className="bg-green-50 text-green-700 text-sm px-4 py-3 rounded-lg">
                  Telefon tasdiqlandi. Yangi parol o&apos;rnating.
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Yangi parol</label>
                  <PasswordInput
                    placeholder="Kamida 8 ta belgi"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Parolni tasdiqlang</label>
                  <PasswordInput
                    placeholder="Parolni qayta kiriting"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleResetPassword()}
                  />
                </div>
                <Button className="w-full" size="lg" onClick={handleResetPassword} disabled={loading}>
                  {loading ? "Saqlanmoqda..." : "Parolni saqlash"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-sm text-slate-500 mt-4">
          Yangi foydalanuvchimisiz?{" "}
          <Link href={`/${locale}/register`} className="text-brand-600 underline underline-offset-2">
            Ro&apos;yhatdan o&apos;tish
          </Link>
        </p>
      </div>
    </main>
  );
}
