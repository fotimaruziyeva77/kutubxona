"use client";

// ============================================================================
// Lite Mode Banner — PWA-04
// ============================================================================
// Fixed banner displayed when a 2G connection is detected. Informs the user
// that lite mode is active (no images loaded). Exports a LiteModeProvider
// context so layout components can read isLiteMode to skip Image components.
// ============================================================================

import { createContext, useContext, type ReactNode } from "react";
import { useNetworkStatus } from "@/lib/offline/network-status";

// ── Lite Mode Context ──────────────────────────────────────────────────────

interface LiteModeContextValue {
  isLiteMode: boolean;
}

const LiteModeContext = createContext<LiteModeContextValue>({
  isLiteMode: false,
});

export function useLiteMode(): LiteModeContextValue {
  return useContext(LiteModeContext);
}

// ── Provider ───────────────────────────────────────────────────────────────

export function LiteModeProvider({ children }: { children: ReactNode }) {
  const { is2G } = useNetworkStatus();

  return (
    <LiteModeContext.Provider value={{ isLiteMode: is2G }}>
      {children}
    </LiteModeContext.Provider>
  );
}

// ── Banner Component ───────────────────────────────────────────────────────

export function LiteModeBanner() {
  const { isLiteMode } = useLiteMode();

  if (!isLiteMode) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-50 bg-brand-600 text-white text-center py-2 px-4 text-sm font-medium shadow-md"
    >
      <span>
        2G tarmoq aniqlandi - yengil rejim faollashtirildi. Rasmlar
        yuklanmaydi.
      </span>
    </div>
  );
}
