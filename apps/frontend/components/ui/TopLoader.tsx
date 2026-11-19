"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Sahifalar orasida o'tishda yuqoridagi ingichka progress chizig'i.
 * Ichki havola bosilganda (yoki GET forma yuborilganda) boshlanadi, yangi
 * sahifa (pathname) ochilganda tugaydi. 12 soniyadan oshsa o'zi yopiladi.
 */
export function TopLoader() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const startedAt = useRef<string | null>(null);

  useEffect(() => {
    const start = (url: URL) => {
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      startedAt.current = location.pathname + location.search;
      setPhase("loading");
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      const raw = a.getAttribute("href") ?? "";
      if (raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return;
      start(new URL(a.href, location.href));
    };
    const onSubmit = (e: SubmitEvent) => {
      const f = e.target as HTMLFormElement | null;
      if (!f || e.defaultPrevented || (f.method || "get").toLowerCase() !== "get" || !f.action) return;
      start(new URL(f.action, location.href));
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
    };
  }, []);

  // Yangi sahifa ochildi — chiziqni oxirigacha to'ldirib, so'ng yashiramiz.
  useEffect(() => {
    if (startedAt.current === null) return;
    startedAt.current = null;
    setPhase("done");
    const t = setTimeout(() => setPhase("idle"), 450);
    return () => clearTimeout(t);
  }, [pathname]);

  useEffect(() => {
    if (phase !== "loading") return;
    const t = setTimeout(() => setPhase("idle"), 12_000);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "idle") return null;
  return <div aria-hidden="true" className={`top-loader top-loader--${phase}`} />;
}
