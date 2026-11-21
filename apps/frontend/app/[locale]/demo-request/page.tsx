"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { apiClient } from "@/lib/api-client";
import { PhoneField } from "@/components/ui/PhoneField";
import { Icon, ICON_SIZE } from "@/components/ui/icon";

/**
 * B2B demo so'rov formasi — sotuv voronkasining yagona kirish nuqtasi.
 *
 * Bu forma to'ldirilgach `POST /admin/demo-request` (ochiq endpoint) chaqiriladi,
 * lead `DemoRequest` jadvaliga yoziladi va SUPER_ADMIN paneliga
 * (`/dashboard/demo-requests`) tushadi. Shu bilan birga
 * `ADMIN_NOTIFICATION_EMAILS` manzillariga xabar yuboriladi.
 *
 * Xato ko'rsatish qoidasi: server validatsiya xabari (masalan "Telefon
 * +998XXXXXXXXX ko'rinishida bo'lishi kerak") FOYDALANUVCHIGA ko'rsatiladi.
 * Avval har qanday nosozlik "Xato yuz berdi" ga aylanardi va mijoz nimani
 * tuzatishni bilmay formani tashlab ketardi — bu to'g'ridan-to'g'ri
 * yo'qotilgan lead degani.
 */

const ORG_TYPES = [
  { value: "MAKTAB", label: "Maktab", icon: Icon.school },
  { value: "OTM", label: "OTM", icon: Icon.university },
  { value: "IDORA", label: "Idora", icon: Icon.organization },
  { value: "MAHALLA", label: "Mahalla", icon: Icon.mahalla },
  { value: "OTHER", label: "Boshqa", icon: Icon.document },
] as const;

/** NestJS ValidationPipe xabari `message` maydonida string yoki massiv bo'ladi. */
function readServerMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const m = (payload as { message?: unknown }).message;
  if (typeof m === "string") return m;
  if (Array.isArray(m) && m.length > 0 && typeof m[0] === "string") {
    return m.join(". ");
  }
  return null;
}

export default function DemoRequestPage() {
  const locale = useLocale();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [phone, setPhone] = useState("");
  const [orgType, setOrgType] = useState<string>("MAKTAB");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    // Serverga bormasdan oldingi tekshiruv — 9 raqam kiritilmagan bo'lsa
    // so'rov yubormaymiz (rate-limit hisobini behuda sarflamaslik uchun).
    if (!/^\+998\d{9}$/.test(phone)) {
      setError("Telefon raqamini to'liq kiriting: +998 va 9 ta raqam.");
      return;
    }

    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await apiClient("/admin/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: fd.get("organization"),
          phone,
          email: fd.get("email") || undefined,
          orgType,
          message: fd.get("message") || undefined,
        }),
      });

      if (res.status === 429) {
        setError(
          "Iltimos, biroz kuting va qaytadan urinib ko'ring. Bir soat ichida 3 ta so'rovdan ko'p yuborib bo'lmaydi.",
        );
        return;
      }

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(
          readServerMessage(payload) ??
            "So'rov yuborilmadi. Internetni tekshirib qaytadan urinib ko'ring.",
        );
        return;
      }

      setSent(true);
    } catch {
      setError("Tarmoq xatosi. Internetni tekshirib qaytadan urinib ko'ring.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
        <div className="card-surface w-full max-w-md rounded-2xl p-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-info-50 text-info-600">
            <Icon.success aria-hidden="true" size={32} strokeWidth={1.75} />
          </span>
          <h1 className="mt-5 text-2xl font-bold text-slate-900">
            So&apos;rovingiz qabul qilindi
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            Mutaxassisimiz <strong className="text-slate-700">24 soat ichida</strong>{" "}
            ko&apos;rsatgan raqamingizga qo&apos;ng&apos;iroq qiladi va
            platformani bepul ko&apos;rsatadi. Shoshilinch savol bo&apos;lsa —{" "}
            <a href="mailto:hamkorlik@sifat.uz" className="font-medium text-brand-600 underline underline-offset-2">
              hamkorlik@sifat.uz
            </a>
            .
          </p>
          <Link
            href={`/${locale}`}
            className="mt-7 inline-flex h-11 items-center rounded-xl bg-brand-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Bosh sahifaga
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4 py-10">
      <div className="card-surface w-full max-w-md rounded-2xl p-8">
        <Link
          href={`/${locale}`}
          className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
        >
          <Icon.next aria-hidden="true" size={ICON_SIZE.xs} className="rotate-180" />
          Bosh sahifa
        </Link>

        <h1 className="mt-4 text-2xl font-bold text-slate-900">
          Bepul demo so&apos;rash
        </h1>
        <p className="mt-1.5 text-sm text-slate-500">
          24 soat ichida mutaxassisimiz bog&apos;lanadi va tizimni muassasangiz
          misolida ko&apos;rsatadi.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div>
            <label
              htmlFor="organization"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Tashkilot nomi <span className="text-red-500">*</span>
            </label>
            <input
              id="organization"
              name="organization"
              required
              minLength={2}
              maxLength={160}
              placeholder="Masalan: Navoiy viloyati 8-maktabi"
              className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>

          <div>
            <label
              htmlFor="phone-field"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Telefon <span className="text-red-500">*</span>
            </label>
            <PhoneField value={phone} onChange={setPhone} />
            <p className="mt-1 text-xs text-slate-400">
              Aynan shu raqamga qo&apos;ng&apos;iroq qilamiz.
            </p>
          </div>

          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-slate-700">
              Tashkilot turi <span className="text-red-500">*</span>
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {ORG_TYPES.map(({ value, label, icon: TypeIcon }) => {
                const active = orgType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setOrgType(value)}
                    aria-pressed={active}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors ${
                      active
                        ? "border-brand-600 bg-brand-50 text-brand-700"
                        : "border-line bg-white text-slate-600 hover:border-brand-300"
                    }`}
                  >
                    <TypeIcon aria-hidden="true" size={ICON_SIZE.md} strokeWidth={1.75} />
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email <span className="font-normal text-slate-400">(ixtiyoriy)</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              maxLength={160}
              placeholder="info@maktab.uz"
              className="w-full rounded-xl border border-line bg-white px-4 py-2.5 text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>

          <div>
            <label
              htmlFor="message"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Xabar <span className="font-normal text-slate-400">(ixtiyoriy)</span>
            </label>
            <textarea
              id="message"
              name="message"
              rows={3}
              maxLength={2000}
              placeholder="Nechta o'quvchi/xodim bor, qaysi funksiyalar qiziq..."
              className="w-full resize-none rounded-xl border border-line bg-white px-4 py-2.5 text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              <Icon.warning aria-hidden="true" size={ICON_SIZE.sm} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-base font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? "Yuborilmoqda…" : "Demo so'rash"}
            {!loading && <Icon.next aria-hidden="true" size={ICON_SIZE.sm} />}
          </button>

          <p className="text-center text-xs text-slate-400">
            Ma&apos;lumotlaringiz faqat demo maqsadida ishlatiladi va uchinchi
            shaxslarga berilmaydi.
          </p>
        </form>
      </div>
    </div>
  );
}
