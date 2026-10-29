"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { locales } from "@/i18n";

// Har bir til uchun ona tilidagi nomi (tarjima shart emas) + qisqa belgi.
const LOCALE_LABELS: Record<string, { native: string; short: string }> = {
  "uz-Latn": { native: "Oʻzbekcha", short: "UZ" },
  "uz-Cyrl": { native: "Ўзбекча", short: "ЎЗ" },
  ru: { native: "Русский", short: "RU" },
  kaa: { native: "Qaraqalpaqsha", short: "QQ" },
};

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const PILL =
  // DESIGN.md §9 — barmoq nishoni min ~44px. Ilgari py-1.5 (34px) edi va
  // mobil ekranda tilni almashtirish uchun aniq tekkizish talab qilinardi.
  "flex items-center gap-1.5 rounded-full bg-white border border-line shadow-sm text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 min-h-11 px-3.5 text-sm font-medium";

export function LocaleThemeControl({ inline = false }: { inline?: boolean } = {}) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  // `mounted` — hydration nomuvofiqligining oldini oladi: no-flash skript
  // hidratsiyadan OLDIN <html>'ga .dark qo'shishi mumkin, shunda tema tugmasi
  // ikonkasi/aria-label serverda (isDark=false) va klientda (isDark=true)
  // farq qilib React ogohlantirish berardi. Mount bo'lguncha neytral holat.
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Boshlang'ich tema holatini DOM'dan o'qiymiz (no-flash skript allaqachon
  // <html>'ga .dark qo'ygan bo'lishi mumkin).
  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  // Menyudan tashqariga bosilganda yopish.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function switchLocale(next: string) {
    setMenuOpen(false);
    if (next === locale) return;
    const parts = pathname.split("/");
    if ((locales as readonly string[]).includes(parts[1])) {
      parts[1] = next; // mavjud lokal segmentni almashtiramiz
    } else {
      parts.splice(1, 0, next);
    }
    const search = typeof window !== "undefined" ? window.location.search : "";
    router.push((parts.join("/") || `/${next}`) + search);
    router.refresh();
  }

  function toggleTheme() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* localStorage bloklangan bo'lishi mumkin — e'tiborsiz */
    }
    setIsDark(next);
  }

  const current = LOCALE_LABELS[locale] ?? LOCALE_LABELS["uz-Latn"];

  // Suzuvchi nusxa FAQAT o'z top-bar'i yo'q sahifalarda ko'rsatiladi.
  // Dashboard va landing o'z panelida `inline` nusxani render qiladi —
  // ikkalasi bir vaqtda chizilsa boshqaruvlar ustma-ust tushib qolardi.
  //
  // Bu qaror MOUNTDAN KEYIN qabul qilinadi. Sababi: `usePathname()` statik
  // prerender paytida (sahifada `generateStaticParams` bor) klientdagidan
  // boshqa qiymat berishi mumkin — o'shanda server "bor", klient "yo'q" deb
  // chizib hydration daraxti buzilardi va butun sahifa xato chegarasiga
  // tushardi. Server har doim `null` chizadi, ko'rinish faqat klientda
  // hal qilinadi; element `position: fixed` bo'lgani uchun layout sakramaydi.
  const stripped = pathname.replace(`/${locale}`, "") || "/";
  const hasOwnBar = pathname.includes("/dashboard") || stripped === "/";
  if (!inline && (!mounted || hasOwnBar)) return null;

  return (
    <div className={inline ? "flex items-center gap-1.5" : "locale-theme-control"} ref={ref}>
      {/* Til almashtirgich */}
      <div className="relative">
        <button
          type="button"
          className={PILL}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-label="Tilni o'zgartirish"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <GlobeIcon />
          <span>{current.short}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {menuOpen && (
          <ul
            role="listbox"
            className="absolute right-0 mt-2 w-44 rounded-xl bg-white border border-line shadow-lg overflow-hidden py-1"
          >
            {locales.map((loc) => {
              const label = LOCALE_LABELS[loc] ?? { native: loc, short: loc };
              const active = loc === locale;
              return (
                <li key={loc} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => switchLocale(loc)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
                      active
                        ? "bg-blue-50 text-brand-700 font-semibold"
                        : "text-slate-700 hover:bg-surface-sunken"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-bold opacity-60 w-6">{label.short}</span>
                      {label.native}
                    </span>
                    {active && <CheckIcon />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Kun/Tun toggle — mount bo'lguncha ikonka ko'rsatilmaydi (hydration
          nomuvofiqligini oldini olish). suppressHydrationWarning ichki
          ikonka almashinuvini React tekshiruvidan chiqaradi. */}
      <button
        type="button"
        onClick={toggleTheme}
        className="flex items-center justify-center rounded-full bg-white border border-line shadow-sm text-slate-700 transition-colors hover:bg-surface-muted active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 h-11 w-11"
        aria-label={mounted && isDark ? "Kunduzgi rejim" : "Tungi rejim"}
        title={mounted && isDark ? "Kunduzgi rejim" : "Tungi rejim"}
        suppressHydrationWarning
      >
        <span suppressHydrationWarning>
          {mounted && isDark ? <SunIcon /> : <MoonIcon />}
        </span>
      </button>
    </div>
  );
}
