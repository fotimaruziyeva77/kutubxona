"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useAuthStore } from "@/store/auth.store";
import { authApi } from "@/lib/api/auth";
import { refreshAccessToken } from "@/lib/api/client";
import { hasAuthHintCookie } from "@/lib/auth-cookie";
// Plan 05-04 Task 4 (NOTIF-02 frontend) — silently register the caller's FCM
// token on dashboard mount IF Notification.permission === 'granted'. NEVER
// auto-prompts; explicit flow lives in lib/fcm-client.ts for a later UI.
import { FcmTokenRegistrar } from "@/components/fcm/FcmTokenRegistrar";
import { LocaleThemeControl } from "@/components/LocaleThemeControl";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Icon, ICON_SIZE, type LucideIcon } from "@/components/ui/icon";
import { LogoMark, Wordmark } from "@/components/brand/Logo";
import { EASE_MODAL } from "@/lib/motion";

// Plan 04-03 audit-fix FIX F — sidebar entries for the new billing pages.
// Pre-fix, /dashboard/subscriptions and /dashboard/library/billing pages
// existed but were orphaned — there was no nav entry, so an admin / library
// admin had to type the URL by hand. Adding them here makes them discoverable
// AND role-filtered (the role-filter is shared by the existing visibleItems
// pipeline below).
// Rol kodlarini o'zbekcha ko'rinadigan nomga aylantiramiz — sidebar pastida
// "Profil" o'rniga foydalanuvchi ismi + roli ko'rsatiladi (noaniqlik yo'qoladi).
const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  VILOYAT_ADMIN: "Viloyat admin",
  TUMAN_ADMIN: "Tuman admin",
  MUASSASA_ADMIN: "Muassasa admin",
  KUTUBXONACHI: "Kutubxonachi",
  KLUB_RAHBARI: "Klub rahbari",
  DOKON_OPERATOR: "Do'kon operatori",
  BUXGALTER: "Buxgalter",
  KITOBXON: "Kitobxon",
};

const NAV_ITEMS: {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: string[];
}[] = [
  { href: "",             label: "Bosh panel",        icon: Icon.stats,        roles: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] },
  { href: "stats",        label: "Statistika",        icon: Icon.trendUp,      roles: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] },
  { href: "alerts",       label: "Smart alertlar",    icon: Icon.bell,         roles: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] },
  { href: "muassasa",     label: "Muassasa paneli",   icon: Icon.organization, roles: ["MUASSASA_ADMIN", "KUTUBXONACHI"] },
  { href: "school",       label: "Maktab paneli",     icon: Icon.school,       roles: ["SUPER_ADMIN", "TUMAN_ADMIN", "MUASSASA_ADMIN"] },
  { href: "club",         label: "Jadidlar izidan",   icon: Icon.club,         roles: ["SUPER_ADMIN", "TUMAN_ADMIN", "MUASSASA_ADMIN", "KLUB_RAHBARI"] },
  { href: "libraries",    label: "Kutubxonalar",      icon: Icon.library,      roles: ["SUPER_ADMIN", "TUMAN_ADMIN", "VILOYAT_ADMIN", "MUASSASA_ADMIN", "KUTUBXONACHI"] },
  { href: "books",        label: "Kitob fondi",       icon: Icon.book,         roles: ["SUPER_ADMIN", "KUTUBXONACHI", "MUASSASA_ADMIN"] },
  { href: "transactions", label: "Kitob jarayonlari", icon: Icon.refresh,      roles: ["SUPER_ADMIN", "KUTUBXONACHI", "MUASSASA_ADMIN"] },
  { href: "users/pending",label: "Tasdiqlash",        icon: Icon.pending,      roles: ["SUPER_ADMIN", "MUASSASA_ADMIN", "TUMAN_ADMIN"] },
  { href: "accounts",     label: "Adminlar",          icon: Icon.readers,      roles: ["SUPER_ADMIN"] },
  { href: "ai",           label: "AI tizimi",         icon: Icon.sparkle,      roles: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] },
  { href: "demo-requests",label: "Demo so'rovlar",    icon: Icon.checklist,    roles: ["SUPER_ADMIN"] },
  { href: "family",       label: "Oila reytingi",     icon: Icon.family,       roles: ["SUPER_ADMIN", "VILOYAT_ADMIN", "TUMAN_ADMIN"] },
  { href: "idora",        label: "Idora paneli",      icon: Icon.organization, roles: ["SUPER_ADMIN", "MUASSASA_ADMIN"] },
  { href: "otm",          label: "OTM paneli",        icon: Icon.university,   roles: ["SUPER_ADMIN", "MUASSASA_ADMIN"] },
  { href: "buxgalter",    label: "Buxgalter",         icon: Icon.payment,      roles: ["SUPER_ADMIN", "BUXGALTER"] },
  // Plan 04-03 audit-fix FIX F — new billing-related entries.
  { href: "subscriptions",label: "Obunalar",          icon: Icon.document,     roles: ["SUPER_ADMIN", "BUXGALTER"] },
  { href: "library/billing", label: "Hisob",          icon: Icon.payment,      roles: ["MUASSASA_ADMIN", "KUTUBXONACHI"] },
];

// Faqat shu (xodim/admin) rollar admin dashboardida ishlaydi. KITOBXON
// (oddiy kitobxon/o'quvchi) va DOKON_OPERATOR bu yerga TEGISHLI EMAS — ular
// o'z sahifalariga yo'naltiriladi (profil / do'kon CRM). Bu darvoza barcha
// /dashboard/* sahifalarini bir joyda himoyalaydi (frontend RBAC qatlami;
// backend allaqachon har endpointni @Roles bilan tekshiradi).
const DASHBOARD_ROLES = [
  "SUPER_ADMIN",
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
  "KLUB_RAHBARI",
  "BUXGALTER",
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAuthenticated, accessToken, logout } = useAuthStore();
  const role = user?.role ?? "";

  const handleLogout = async () => {
    await authApi.logout().catch(() => {});
    logout();
    router.replace(`/${locale}/login`);
  };

  // C11: zustand/persist localStorage'dan SINXRON qayta tiklanadi, lekin SSR
  // markup har doim boshlang'ich ("kirilmagan") holat bilan chiziladi. Shu
  // sabab redirect qarorini faqat mountdan keyin (store hidratlangach)
  // qabul qilamiz — aks holda hydration mismatch yoki yolg'on redirect
  // bo'ladi. Hidratsiyagacha minimal yuklash holati ko'rsatiladi.
  const reduce = useReducedMotion();
  const [hydrated, setHydrated] = useState(false);
  // Mobil sidebar (drawer) holati — kichik ekranda hamburger bilan ochiladi.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  // Sahifa o'zgarganda mobil drawer yopiladi.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!hydrated) return;

    // H16: access token endi HECH QAYERDA persist qilinmaydi (XSS himoyasi).
    // Hard reload'dan keyin in-memory token bo'lmaydi — lekin `sl_auth`
    // cookie tirik sessiya borligiga ishora qilsa, redirect QILMASDAN bitta
    // silent refresh (single-flight, lib/api/client.ts) bilan tokenni qayta
    // olamiz. Muvaffaqiyatda setTokens isAuthenticated'ni true qiladi va bu
    // effect qayta ishlab guard'dan o'tadi; muvaffaqiyatsizlikda markaziy
    // logout yo'li cookie'ni tozalaydi va effect login'ga yo'naltiradi.
    if (!accessToken && hasAuthHintCookie()) {
      refreshAccessToken().catch(() => {
        // Markaziy yo'l (doRefresh) logout + redirect'ni AYNAN BIR MARTA
        // bajargan; bu yerda qo'shimcha harakat shart emas.
      });
      return;
    }

    if (!isAuthenticated) {
      // Middleware `sl_auth` cookie orqali allaqachon gate qiladi, lekin bu
      // faqat UX to'sig'i — cookie qo'lda yasalishi mumkin. Bu yerda store
      // holatiga tayangan ikkinchi qatlam: kirilmagan bo'lsa login'ga.
      router.replace(
        `/${locale}/login?next=${encodeURIComponent(pathname)}`
      );
      return;
    }

    // Rol darvozasi: dashboard faqat xodim/admin rollari uchun. KITOBXON yoki
    // DOKON_OPERATOR noto'g'ri kelib qolsa (URL/eski link), o'z profiliga
    // yo'naltiramiz — admin panelini ko'rmaydi. role bo'sh (hali yuklanmagan)
    // bo'lsa tegmaymiz: noaniqlikda yolg'on redirect bermaymiz.
    if (role && !DASHBOARD_ROLES.includes(role)) {
      router.replace(`/${locale}/profile`);
    }
  }, [hydrated, isAuthenticated, accessToken, role, locale, pathname, router]);

  // C11 nav fix: rol hali yo'q (anonim yoki profil yuklanmagan) bo'lsa HECH
  // QANDAY admin havola ko'rsatilmaydi. Avvalgi `!role || ...` sharti rol
  // bo'sh bo'lganda BARCHA havolalarni ochib yuborar edi.
  // MUASSASA_ADMIN — muassasa turiga xos panellar (Maktab/OTM/Idora) FAQAT o'z
  // turiga mos bo'lganda ko'rinadi (maktab admini Idora/OTM panellarini umuman
  // ko'rmaydi). institutionType /users/me'dan keladi. Super/tuman/viloyat
  // adminlar bu filtрдан ta'sirlanmaydi (ular barcha turlarni nazorat qiladi).
  const institutionType = user?.institutionType ?? null;
  const TYPE_PANEL: Record<string, string> = {
    school: "MAKTAB",
    otm: "OTM",
    idora: "IDORA",
  };
  const visibleItems = role
    ? NAV_ITEMS.filter((item) => {
        if (!(item.roles.includes(role) || role === "SUPER_ADMIN")) return false;
        if (role === "MUASSASA_ADMIN") {
          const requiredType = TYPE_PANEL[item.href];
          // Tur aniqlangan bo'lsa va mos kelmasa — yashir. Aniqlanmagan bo'lsa
          // (institutionType null) hech narsani yashirmaymiz (xavfsiz fallback).
          if (requiredType && institutionType && requiredType !== institutionType) {
            return false;
          }
        }
        return true;
      })
    : [];

  if (!hydrated || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <p className="text-sm text-slate-400">Yuklanmoqda...</p>
      </div>
    );
  }

  // Rol darvozasi (render): noto'g'ri rol (KITOBXON/DOKON_OPERATOR) dashboard
  // kontentini umuman ko'rmaydi — useEffect yo'naltirgunча "yo'naltirilmoqda".
  if (role && !DASHBOARD_ROLES.includes(role)) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center">
        <p className="text-sm text-slate-400">Yo'naltirilmoqda…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Plan 05-04 Task 4 — silent FCM registrar (renders nothing). */}
      <FcmTokenRegistrar />

      <div className="md:flex">
        {/* Mobil backdrop — drawer ochiq bo'lsa */}
        <AnimatePresence>
          {sidebarOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-40 bg-black/40 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
          )}
        </AnimatePresence>

        {/* Sidebar — mobil drawer (siljiydi), desktopda doimiy ustun */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-line flex flex-col transform transition-transform duration-200 ease-out md:sticky md:top-0 md:h-screen md:z-auto md:w-56 md:translate-x-0 md:shrink-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="p-4 border-b border-line flex items-center justify-between">
            <Link href={`/${locale}`} onClick={() => setSidebarOpen(false)} className="flex items-center gap-2.5">
              <LogoMark size={28} className="shrink-0" />
              <Wordmark className="text-base" />
              <span className="text-xs font-medium text-slate-400">admin</span>
            </Link>
            <button
              onClick={() => setSidebarOpen(false)}
              aria-label="Yopish"
              className="md:hidden p-1 text-slate-400 hover:text-slate-700"
            >
              <Icon.close aria-hidden="true" size={ICON_SIZE.md} />
            </button>
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
            {visibleItems.map((item) => {
              const href = `/${locale}/dashboard${item.href ? `/${item.href}` : ""}`;
              const active = item.href
                ? pathname.includes(`/dashboard/${item.href}`)
                : pathname.endsWith("/dashboard");
              const ItemIcon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={href}
                  onClick={() => setSidebarOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "text-brand-700"
                      : "text-slate-600 hover:bg-surface-muted hover:text-slate-900"
                  }`}
                >
                  {/* Faol fon ALOHIDA qatlam va `layoutId` bilan — shu sabab
                      bo'limlar orasida o'tganda indikator sakramasdan siljiydi
                      (shared layout animation). Gradient + shadow o'rniga
                      yumshoq fon: yon panel kontentni bosmasligi kerak. */}
                  {active && (
                    <motion.span
                      layoutId={reduce ? undefined : "nav-active"}
                      transition={EASE_MODAL}
                      aria-hidden="true"
                      className="absolute inset-0 rounded-lg bg-blue-50"
                    />
                  )}
                  <ItemIcon
                    aria-hidden="true"
                    size={ICON_SIZE.md}
                    strokeWidth={active ? 2.2 : 1.75}
                    className="relative shrink-0"
                  />
                  <span className="relative truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="p-3 border-t border-line">
            <Link
              href={`/${locale}/profile`}
              onClick={() => setSidebarOpen(false)}
              className="flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-surface-muted transition"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Icon.reader aria-hidden="true" size={ICON_SIZE.sm} />
              </span>
              <span className="flex flex-col min-w-0">
                <span className="font-semibold text-slate-900 truncate">
                  {user?.name ?? "Profil"}
                </span>
                <span className="text-xs text-slate-400 truncate">
                  {ROLE_LABELS[role] ?? role ?? "Foydalanuvchi"}
                </span>
              </span>
            </Link>

            <button
              onClick={handleLogout}
              className="mt-1 w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                <Icon.logout aria-hidden="true" size={ICON_SIZE.sm} />
              </span>
              Chiqish
            </button>
          </div>
        </aside>

        {/* Main ustun — yuqorida til/tema paneli (suzuvchi EMAS, top-bar ichida
            — endi sahifa tugmalarini bosmaydi). Chap tomonда mobil hamburger. */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-white border-b border-line px-4 h-14">
            <div className="flex items-center gap-3 md:hidden">
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="Menyu"
                className="-ml-1 p-2 text-slate-700 hover:bg-surface-sunken rounded-lg"
              >
                <Icon.menu aria-hidden="true" size={ICON_SIZE.lg} />
              </button>
              <Link href={`/${locale}`} className="flex items-center gap-2.5">
                <LogoMark size={28} className="shrink-0" />
                <Wordmark className="text-base" />
                <span className="text-xs font-medium text-slate-400">admin</span>
              </Link>
            </div>
            {/* Desktopda chap bo'sh — control o'ngga suriladi */}
            <div className="hidden md:block" />
            <LocaleThemeControl inline />
          </header>
          <main className="flex-1 overflow-x-hidden">{children}</main>
        </div>
      </div>
    </div>
  );
}
