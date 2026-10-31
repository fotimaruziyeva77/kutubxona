"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneField } from "@/components/ui/PhoneField";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { authApi } from "@/lib/api/auth";
import { usersApi } from "@/lib/api/users";
import { geoApi, type GeoItem } from "@/lib/api/geo";
import { useAuthStore } from "@/store/auth.store";
import { useQuery } from "@tanstack/react-query";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/** Barcha qadamlarda bir xil xato ko'rinishi (role="alert" bilan). */
function FormError({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {children}
    </p>
  );
}

/** Select — Input bilan bir xil uslub (qo'lda "w-full border" har xil edi). */
const SELECT_CLASS =
  "h-10 w-full rounded-lg border border-line-strong bg-white px-3 text-sm " +
  "focus:outline-none focus:ring-2 focus:ring-brand-500 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Tur bo'yicha qo'shimcha maydon — yorliqli va boshqariladigan.
 * Ilgari bular yorliqsiz, boshqarilmaydigan Input lar edi: placeholder
 * fokusda yo'qolardi va tur almashganda eski matn ekranda qolib ketardi.
 */
function ExtraField({
  id, label, placeholder, value, onChange, type = "text", hint,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string | number | undefined;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

type UserType = "CITIZEN" | "STUDENT_SCHOOL" | "STUDENT_UNIVERSITY" | "GOVERNMENT_EMPLOYEE" | "TEACHER";

// Yorliq va tavsiflar RegisterPage.types.<value>.{label,desc} kalitlaridan
// olinadi — render vaqtida tp() bilan.
const USER_TYPE_VALUES: UserType[] = [
  "CITIZEN",
  "STUDENT_SCHOOL",
  "STUDENT_UNIVERSITY",
  "GOVERNMENT_EMPLOYEE",
  "TEACHER"
];

// Ochiq (auth'siz) muassasa qidiruv endpointi backend'da YO'Q —
// GET /school/institutions faqat admin rollarga ochiq. Shu sabab muassasa nomi
// maydonlari erkin matn: yozilgani admin tasdiqlash bosqichida tekshiriladi
// (hint kaliti: RegisterPage.freeTextHint).

export default function RegisterPage() {
  const t = useTranslations();
  const tp = useTranslations("RegisterPage");
  const locale = useLocale();
  const router = useRouter();
  const { setTokens } = useAuthStore();

  // DEV ONLY — when true, step 1 collapses to phone+password (no OTP UI).
  // Build is refused in production via next.config.js guard.
  const skipOtp = process.env.NEXT_PUBLIC_DISABLE_OTP === "true";

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resendTimer, setResendTimer] = useState(0);

  // Step 1 — telefon + OTP + parol
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(skipOtp);
  const [otpVerified, setOtpVerified] = useState(skipOtp);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Step 2
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState<"MALE" | "FEMALE">("MALE");

  // Step 3 — manzil
  const [viloyatId, setViloyatId] = useState("");
  const [tumanId, setTumanId] = useState("");
  const [mahallaId, setMahallaId] = useState("");
  const [street, setStreet] = useState("");
  const [house, setHouse] = useState("");
  const [apartment, setApartment] = useState("");
  const [privateHouse, setPrivateHouse] = useState(false);

  // Step 4 — tur
  const [userType, setUserType] = useState<UserType>("CITIZEN");
  const [extraData, setExtraData] = useState<Record<string, string | number>>({});

  // Geo data — isError ham olinadi: so'rov yiqilsa dropdown abadiy bo'sh
  // qolar edi, endi xato bloki + "Qayta urinish" ko'rsatiladi.
  const viloyatlarQ = useQuery({
    queryKey: ["viloyatlar"],
    queryFn: () => geoApi.getViloyatlar().then((r) => r.data),
    enabled: step === 3
  });
  const viloyatlar = viloyatlarQ.data ?? [];

  const tumanlarQ = useQuery({
    queryKey: ["tumanlar", viloyatId],
    queryFn: () => geoApi.getTumanlar(viloyatId).then((r) => r.data),
    enabled: !!viloyatId
  });
  const tumanlar = tumanlarQ.data ?? [];

  const mahallalarQ = useQuery({
    queryKey: ["mahallalar", tumanId],
    queryFn: () => geoApi.getMahallalar(tumanId).then((r) => r.data),
    enabled: !!tumanId
  });
  const mahallalar = mahallalarQ.data ?? [];

  const geoError = viloyatlarQ.isError || tumanlarQ.isError || mahallalarQ.isError;
  const retryGeo = () => {
    if (viloyatlarQ.isError) viloyatlarQ.refetch();
    if (tumanlarQ.isError) tumanlarQ.refetch();
    if (mahallalarQ.isError) mahallalarQ.refetch();
  };

  // Interval unmount'da ham tozalanadi — ilgari sahifadan chiqib ketilsa
  // taymer ishlashda davom etib, yo'q komponentga setState chaqirardi.
  const resendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      if (resendIntervalRef.current) clearInterval(resendIntervalRef.current);
    };
  }, []);

  const startResendTimer = () => {
    if (resendIntervalRef.current) clearInterval(resendIntervalRef.current);
    setResendTimer(60);
    resendIntervalRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) {
          if (resendIntervalRef.current) {
            clearInterval(resendIntervalRef.current);
            resendIntervalRef.current = null;
          }
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  };

  const normalizePhone = (p: string) => {
    const clean = p.replace(/[\s\-\(\)]/g, "");
    return clean.startsWith("+") ? clean : "+" + clean;
  };

  // To'liq raqam: 998 + 9 raqam = 12 ta raqam. Ilgari length<9 tekshiruvi
  // chala raqamlarni ham o'tkazib yuborardi.
  const phoneDigitsOk = (p: string) =>
    normalizePhone(p).replace(/\D/g, "").length === 12;

  const handleSendOtp = async () => {
    if (!phoneDigitsOk(phone)) { setError(tp("errors.phoneIncomplete")); return; }
    setLoading(true); setError("");
    try {
      await authApi.sendOtp(normalizePhone(phone), "register");
      setOtpSent(true);
      startResendTimer();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? tp("errors.generic"));
    } finally { setLoading(false); }
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) { setError(tp("errors.otpLength")); return; }
    setLoading(true); setError("");
    try {
      await authApi.verifyOtp(normalizePhone(phone), otp);
      setOtpVerified(true);
      setError("");
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? tp("errors.wrongCode"));
    } finally { setLoading(false); }
  };

  const handleSetPassword = async () => {
    // In the prod path, phone is already validated by handleSendOtp before we
    // arrive here. In the skipOtp single-card path, this is the FIRST place
    // we see the user-typed phone, so we must validate here too.
    if (!phoneDigitsOk(phone)) {
      setError(tp("errors.phoneIncomplete"));
      return;
    }
    if (password.length < 8) { setError(tp("errors.passwordMin")); return; }
    if (password !== confirmPassword) { setError(tp("errors.passwordMismatch")); return; }
    setLoading(true); setError("");
    try {
      const { data } = await authApi.completeRegister(normalizePhone(phone), password);
      // INFRA-02: refresh token is set by the backend as an HttpOnly cookie.
      // setTokens only takes (accessToken, isNewUser).
      setTokens(data.accessToken, data.isNewUser);
      setStep(2);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? tp("errors.generic"));
    } finally { setLoading(false); }
  };

  const handleStep2 = () => {
    if (!name.trim()) { setError(tp("errors.nameRequired")); return; }
    if (!dob) { setError(tp("errors.dobRequired")); return; }
    setError("");
    setStep(3);
  };

  const handleStep3 = () => {
    if (!viloyatId || !tumanId || !mahallaId) { setError(tp("errors.regionRequired")); return; }
    if (!street.trim()) { setError(tp("errors.streetRequired")); return; }
    if (!house.trim()) { setError(tp("errors.houseRequired")); return; }
    // Xususiy uyda xonadon raqami yo'q. Ilgari u qat'iy majburiy edi va
    // hovlida yashovchilar (shahar markazidan tashqarida — ko'pchilik)
    // ro'yxatdan umuman o'ta olmasdi. Backend bo'sh qiymatni qabul qilmaydi,
    // shu sabab "0" yuboramiz: ko'cha+uy+"0" bitta xonadon sifatida qoladi,
    // ya'ni oila aniqlash mantig'i buzilmaydi.
    if (!privateHouse && !apartment.trim()) { setError(tp("errors.apartmentRequired")); return; }
    setError("");
    setStep(4);
  };

  const handleCompleteProfile = async () => {
    setLoading(true); setError("");
    try {
      const { data } = await usersApi.completeProfile({
        name, dob, gender,
        viloyatId, tumanId, mahallaId,
        street, house,
        apartment: privateHouse ? "0" : apartment,
        type: userType,
        ...extraData
      });
      // Maxfiylik: sifatId URL query orqali EMAS (tarix/referrer ga sizmasin) —
      // sessionStorage orqali uzatiladi; success sahifa hard-refresh holatida
      // profilni o'zi yuklab oladi.
      try {
        sessionStorage.setItem("sl-register-sifat-id", data.sifatId);
      } catch { /* storage bloklangan — success sahifa profil orqali oladi */ }
      router.push(`/${locale}/register/success`);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(msg ?? tp("errors.generic"));
    } finally { setLoading(false); }
  };

  // 1-qadam formasi: bosqichga qarab Enter to'g'ri amalni bajaradi.
  const handleStep1Submit = () => {
    if (skipOtp) { handleSetPassword(); return; }
    if (!otpSent) { handleSendOtp(); return; }
    if (!otpVerified) { handleVerifyOtp(); return; }
    handleSetPassword();
  };

  // "Tur" — mavhum ot edi, 14 yoshli o'quvchi uni tushunmaydi.
  const steps = [
    tp("steps.phone"),
    tp("steps.personal"),
    tp("steps.address"),
    tp("steps.who"),
    tp("steps.done")
  ];

  return (
    // items-start: 4-qadam kartasi telefon ekranidan baland, items-center
    // esa toshib ketgan flex bolasining TEPASINI qirqib tashlaydi.
    <main className="min-h-screen bg-surface-muted flex items-start justify-center p-4 py-8">
      <div className="w-full max-w-lg">
        {/* Qadamlar */}
        <div className="mb-8">
          <div className="flex items-center gap-1">
            {steps.map((s, i) => (
              <div key={s} className="flex-1 flex flex-col items-center gap-1">
                <div
                  aria-current={step === i + 1 ? "step" : undefined}
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                    step > i + 1 ? "bg-info-500 text-white"
                    : step === i + 1 ? "bg-brand-600 text-white"
                    : "bg-surface-sunken text-slate-500"
                  }`}
                >
                  {step > i + 1
                    ? <Icon.check aria-hidden="true" size={ICON_SIZE.sm} strokeWidth={2.5} />
                    : i + 1}
                </div>
                <span className="text-xs text-slate-500 hidden sm:block">{s}</span>
              </div>
            ))}
          </div>
          {/* Telefonda yorliqlar sig'maydi — beshta nomsiz doira qoladi va
              foydalanuvchi qayerdaligini bilmaydi. Joriy qadamni yozib
              qo'yamiz. */}
          <p className="mt-2 text-center text-sm font-medium text-slate-600 sm:hidden">
            {step}/{steps.length} · {steps[step - 1]}
          </p>
        </div>

        <Card>
          {/* STEP 1 — Telefon → OTP → Parol */}
          {step === 1 && (
            <>
              <CardHeader>
                <CardTitle>
                  {skipOtp ? t("register.devBypass.title")
                    : !otpSent ? tp("step1.titlePhone")
                    : !otpVerified ? tp("step1.titleOtp")
                    : tp("step1.titlePassword")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* form — Enter bosilganda joriy bosqich amali bajariladi. */}
                <form
                  className="space-y-4"
                  onSubmit={(e) => { e.preventDefault(); handleStep1Submit(); }}
                >
                  {error && <FormError>{error}</FormError>}

                  {/* DEV bypass: phone + password in a single card */}
                  {skipOtp ? (
                    <>
                      <div className="bg-yellow-50 text-yellow-800 text-xs px-3 py-2 rounded border border-yellow-200">
                        {t("register.devBypass.banner")}
                      </div>
                      {/* PhoneField/PasswordInput `id` qabul qilmaydi — label
                          o'rab olish (implicit) orqali bog'lanadi. */}
                      <label className="block">
                        <span className="text-sm font-medium mb-1 block">{tp("step1.phoneLabel")}</span>
                        <PhoneField
                          value={phone}
                          onChange={setPhone}
                          autoFocus
                        />
                      </label>
                      <label className="block">
                        <span className="text-sm font-medium mb-1 block">{tp("step1.passwordLabel")}</span>
                        <PasswordInput
                          placeholder={tp("step1.passwordPlaceholder")}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </label>
                      <label className="block">
                        <span className="text-sm font-medium mb-1 block">{tp("step1.confirmLabel")}</span>
                        <PasswordInput
                          placeholder={tp("step1.confirmPlaceholder")}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                        />
                      </label>
                      <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? tp("step1.continuing") : tp("step1.continue")}
                      </Button>
                    </>
                  ) : (
                    <>
                      {/* 1a: Telefon kiritish */}
                      {!otpSent && (
                        <>
                          <label className="block">
                            <span className="text-sm font-medium mb-1 block">{tp("step1.phoneLabel")}</span>
                            <PhoneField value={phone} onChange={setPhone} />
                          </label>
                          <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? tp("step1.sending") : tp("step1.sendSms")}
                          </Button>
                        </>
                      )}

                      {/* 1b: OTP tasdiqlash */}
                      {otpSent && !otpVerified && (
                        <>
                          <div className="bg-blue-50 text-brand-700 text-sm px-3 py-2 rounded">
                            {tp.rich("step1.otpSentTo", {
                              phone,
                              strong: (chunks) => <strong>{chunks}</strong>
                            })}
                          </div>
                          <div>
                            <label htmlFor="reg-otp" className="text-sm font-medium mb-1 block">{tp("step1.otpLabel")}</label>
                            <Input
                              id="reg-otp"
                              placeholder="000000"
                              maxLength={6}
                              value={otp}
                              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                              className="text-center text-2xl tracking-widest"
                              autoFocus
                            />
                          </div>
                          <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? tp("step1.verifying") : tp("step1.verify")}
                          </Button>
                          <div className="flex justify-between text-sm">
                            <button
                              type="button"
                              className="text-slate-500 hover:underline"
                              onClick={() => { setOtpSent(false); setOtp(""); setError(""); }}
                            >
                              {tp("step1.changeNumber")}
                            </button>
                            <button
                              type="button"
                              className="text-brand-600 hover:underline disabled:text-slate-400"
                              onClick={handleSendOtp}
                              disabled={resendTimer > 0 || loading}
                            >
                              {resendTimer > 0 ? tp("step1.resendIn", { seconds: resendTimer }) : tp("step1.resend")}
                            </button>
                          </div>
                        </>
                      )}

                      {/* 1c: Parol o'rnatish */}
                      {otpVerified && (
                        <>
                          <div className="bg-green-50 text-green-700 text-sm px-3 py-2 rounded">
                            {tp("step1.phoneVerified")}
                          </div>
                          <label className="block">
                            <span className="text-sm font-medium mb-1 block">{tp("step1.passwordLabel")}</span>
                            <PasswordInput
                              placeholder={tp("step1.passwordPlaceholder")}
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              autoFocus
                            />
                          </label>
                          <label className="block">
                            <span className="text-sm font-medium mb-1 block">{tp("step1.confirmLabel")}</span>
                            <PasswordInput
                              placeholder={tp("step1.confirmPlaceholder")}
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                            />
                          </label>
                          <Button type="submit" className="w-full" disabled={loading}>
                            {loading ? tp("step1.continuing") : tp("step1.continue")}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </form>
              </CardContent>
            </>
          )}

          {/* STEP 2 — Shaxsiy ma'lumotlar */}
          {step === 2 && (
            <>
              <CardHeader><CardTitle>{tp("step2.title")}</CardTitle></CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(e) => { e.preventDefault(); handleStep2(); }}
                >
                  {error && <FormError>{error}</FormError>}
                  <div>
                    <label htmlFor="reg-name" className="text-sm font-medium mb-1 block">{tp("step2.nameLabel")}</label>
                    <Input id="reg-name" placeholder={tp("step2.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="reg-dob" className="text-sm font-medium mb-1 block">{tp("step2.dobLabel")}</label>
                    <Input
                      id="reg-dob"
                      type="date"
                      value={dob}
                      onChange={(e) => setDob(e.target.value)}
                      min="1920-01-01"
                      max={new Date().toISOString().split("T")[0]}
                    />
                  </div>
                  <fieldset>
                    <legend className="text-sm font-medium mb-2 block">{tp("step2.genderLabel")}</legend>
                    <div className="flex gap-4">
                      {(["MALE", "FEMALE"] as const).map((g) => (
                        <label key={g} className="flex items-center gap-2 cursor-pointer">
                          <input type="radio" name="gender" value={g} checked={gender === g} onChange={() => setGender(g)} />
                          <span>{g === "MALE" ? tp("step2.male") : tp("step2.female")}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {/* 2-qadamda "Orqaga" yo'q edi: telefon raqamini xato
                      yozgan odam uni tuzatish uchun ortga qayta olmasdi. */}
                  <div className="flex gap-3">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => { setError(""); setStep(1); }}>
                      {tp("back")}
                    </Button>
                    <Button type="submit" className="flex-1">{tp("continue")}</Button>
                  </div>
                </form>
              </CardContent>
            </>
          )}

          {/* STEP 3 — Manzil */}
          {step === 3 && (
            <>
              <CardHeader><CardTitle>{tp("step3.title")}</CardTitle></CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(e) => { e.preventDefault(); handleStep3(); }}
                >
                  {error && <FormError>{error}</FormError>}
                  {geoError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                    >
                      <p>{tp("step3.geoError")}</p>
                      <button
                        type="button"
                        onClick={retryGeo}
                        className="mt-1 font-medium underline hover:no-underline"
                      >
                        {tp("step3.retry")}
                      </button>
                    </div>
                  )}
                  <div>
                    <label htmlFor="reg-viloyat" className="text-sm font-medium mb-1 block">{tp("step3.viloyat")}</label>
                    <select
                      id="reg-viloyat"
                      className={SELECT_CLASS}
                      value={viloyatId}
                      onChange={(e) => { setViloyatId(e.target.value); setTumanId(""); setMahallaId(""); }}
                    >
                      <option value="">{tp("step3.select")}</option>
                      {(viloyatlar as GeoItem[]).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-tuman" className="text-sm font-medium mb-1 block">{tp("step3.tuman")}</label>
                    <select
                      id="reg-tuman"
                      className={SELECT_CLASS}
                      value={tumanId}
                      onChange={(e) => { setTumanId(e.target.value); setMahallaId(""); }}
                      disabled={!viloyatId}
                    >
                      <option value="">{tp("step3.select")}</option>
                      {(tumanlar as GeoItem[]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="reg-mahalla" className="text-sm font-medium mb-1 block">{tp("step3.mahalla")}</label>
                    <select
                      id="reg-mahalla"
                      className={SELECT_CLASS}
                      value={mahallaId}
                      onChange={(e) => setMahallaId(e.target.value)}
                      disabled={!tumanId}
                    >
                      <option value="">{tp("step3.select")}</option>
                      {(mahallalar as GeoItem[]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="reg-street" className="text-sm font-medium mb-1 block">{tp("step3.street")}</label>
                      <Input id="reg-street" placeholder={tp("step3.streetPlaceholder")} value={street} onChange={(e) => setStreet(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="reg-house" className="text-sm font-medium mb-1 block">{tp("step3.house")}</label>
                      <Input id="reg-house" placeholder="12" value={house} onChange={(e) => setHouse(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="reg-apartment" className="text-sm font-medium mb-1 block">{tp("step3.apartment")}</label>
                    <Input
                      id="reg-apartment"
                      placeholder="34"
                      value={apartment}
                      disabled={privateHouse}
                      onChange={(e) => setApartment(e.target.value)}
                    />
                    <label className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                      <input
                        type="checkbox"
                        checked={privateHouse}
                        onChange={(e) => {
                          setPrivateHouse(e.target.checked);
                          if (e.target.checked) setApartment("");
                        }}
                        className="h-4 w-4"
                      />
                      {tp("step3.privateHouse")}
                    </label>
                  </div>
                  <div className="flex gap-3">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => setStep(2)}>{tp("back")}</Button>
                    <Button type="submit" className="flex-1">{tp("continue")}</Button>
                  </div>
                </form>
              </CardContent>
            </>
          )}

          {/* STEP 4 — Foydalanuvchi turi */}
          {step === 4 && (
            <>
              <CardHeader><CardTitle>{tp("step4.title")}</CardTitle></CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(e) => { e.preventDefault(); handleCompleteProfile(); }}
                >
                  {error && <FormError>{error}</FormError>}
                  <div className="space-y-2">
                    {USER_TYPE_VALUES.map((value) => (
                      <label
                        key={value}
                        className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                          userType === value ? "border-brand-600 bg-brand-50" : "border-line hover:border-line-strong"
                        }`}
                      >
                        {/* Turni almashtirganda extraData ni TOZALAYMIZ. Aks
                            holda "Talaba" → fakultet yozib → "O'qituvchi" ga
                            o'tilganda payload ichida eski `faculty` qolib
                            ketardi, ekranda esa ko'rinmasdi. */}
                        <input
                          type="radio"
                          name="userType"
                          value={value}
                          checked={userType === value}
                          onChange={() => { setUserType(value); setExtraData({}); }}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="font-medium text-sm">{tp(`types.${value}.label`)}</p>
                          <p className="text-xs text-slate-500">{tp(`types.${value}.desc`)}</p>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Qo'shimcha maydonlar */}
                  {/* Barcha maydonlar boshqariladigan (controlled) — qiymat
                      extraData dan o'qiladi, shuning uchun tur almashganda
                      ekran ham, payload ham birga tozalanadi. Muassasa nomi
                      maydonlari erkin matn (ochiq qidiruv endpointi yo'q) —
                      hint bilan halol aytiladi. */}
                  {userType === "STUDENT_SCHOOL" && (
                    <div className="space-y-3 p-3 bg-surface-muted rounded-lg">
                      <ExtraField id="x-school" label={tp("step4.school")} placeholder={tp("step4.schoolPlaceholder")}
                        hint={tp("freeTextHint")}
                        value={extraData.schoolId} onChange={(v) => setExtraData((d) => ({ ...d, schoolId: v }))} />
                      <ExtraField id="x-class" label={tp("step4.class")} placeholder={tp("step4.classPlaceholder")}
                        value={extraData.schoolClass} onChange={(v) => setExtraData((d) => ({ ...d, schoolClass: v }))} />
                    </div>
                  )}
                  {userType === "STUDENT_UNIVERSITY" && (
                    <div className="space-y-3 p-3 bg-surface-muted rounded-lg">
                      <ExtraField id="x-uni" label={tp("step4.university")} placeholder={tp("step4.universityPlaceholder")}
                        hint={tp("freeTextHint")}
                        value={extraData.universityId} onChange={(v) => setExtraData((d) => ({ ...d, universityId: v }))} />
                      <ExtraField id="x-fac" label={tp("step4.faculty")} placeholder={tp("step4.facultyPlaceholder")}
                        value={extraData.faculty} onChange={(v) => setExtraData((d) => ({ ...d, faculty: v }))} />
                      <ExtraField id="x-dir" label={tp("step4.direction")} placeholder={tp("step4.directionPlaceholder")}
                        value={extraData.direction} onChange={(v) => setExtraData((d) => ({ ...d, direction: v }))} />
                      <ExtraField id="x-course" label={tp("step4.course")} placeholder="1" type="number"
                        value={extraData.studyCourse} onChange={(v) => setExtraData((d) => ({ ...d, studyCourse: v === "" ? "" : Number(v) }))} />
                    </div>
                  )}
                  {(userType === "GOVERNMENT_EMPLOYEE" || userType === "TEACHER") && (
                    <div className="space-y-3 p-3 bg-surface-muted rounded-lg">
                      <ExtraField id="x-org" label={tp("step4.organization")} placeholder={tp("step4.organizationPlaceholder")}
                        hint={tp("freeTextHint")}
                        value={extraData.organizationId} onChange={(v) => setExtraData((d) => ({ ...d, organizationId: v }))} />
                      <ExtraField id="x-dept" label={tp("step4.department")} placeholder={tp("step4.departmentPlaceholder")}
                        value={extraData.department} onChange={(v) => setExtraData((d) => ({ ...d, department: v }))} />
                      <ExtraField id="x-pos" label={tp("step4.position")} placeholder={tp("step4.positionPlaceholder")}
                        value={extraData.position} onChange={(v) => setExtraData((d) => ({ ...d, position: v }))} />
                    </div>
                  )}

                  <div className="flex gap-3">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => setStep(3)}>{tp("back")}</Button>
                    <Button type="submit" className="flex-1" disabled={loading}>
                      {loading ? tp("step4.submitting") : tp("step4.submit")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </>
          )}
        </Card>

        <p className="text-center text-sm text-slate-500 mt-4">
          {tp("haveAccount")}{" "}
          <a href={`/${locale}/login`} className="text-brand-600 underline underline-offset-2">{tp("login")}</a>
        </p>
      </div>
    </main>
  );
}
