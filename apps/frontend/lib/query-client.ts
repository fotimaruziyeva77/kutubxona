"use client";

import { QueryClient } from "@tanstack/react-query";

/** Xatodan HTTP status: axios (`response.status`) yoki fetch o'rami (`status`). */
function httpStatus(error: unknown): number | undefined {
  const e = error as { response?: { status?: number }; status?: number } | null;
  return e?.response?.status ?? e?.status;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      // 4xx (403 ruxsat yo'q, 404, 429 juda ko'p so'rov) qayta urinish bilan
      // tuzalmaydi — qayta yuborish faqat yukni oshiradi (429 holatini
      // chuqurlashtirardi). Tarmoq/5xx xatolarida bir marta qayta urinamiz.
      retry: (failureCount, error) => {
        const status = httpStatus(error);
        if (status !== undefined && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false
    }
  }
});
