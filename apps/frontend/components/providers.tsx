"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { ToastProvider } from "@/components/ui/toast";
import type { ReactNode } from "react";

// NOTE: the offline banner is mounted ONCE in app/[locale]/layout.tsx via
// components/offline/OfflineBanner (the PWA-03 version with SyncStatusBadge).
// A second, simpler banner used to be mounted here too — both rendered on
// every offline event, stacked on top of each other. Keep this provider
// banner-free.
export function Providers({ children }: { children: ReactNode }) {
  // ToastProvider QueryClientProvider ICHIDA: mutatsiya callback'lari
  // (onSuccess/onError) useToast() ni chaqiradi, ya'ni toast konteksti
  // query konteksti ostidagi daraxtga yetib borishi kerak.
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
