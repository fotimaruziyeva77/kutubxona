/**
 * Fetch-like wrapper around the Axios instance.
 * Returns an object with `.ok`, `.status`, and `.json()` so that all
 * Sprint 4-6 client components can use the same interface without
 * depending on native `fetch`.
 */
import { apiClient as axiosClient } from "./api/client";

type RequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

export async function apiClient(
  path: string,
  init?: RequestInit
): Promise<FetchLikeResponse> {
  try {
    const response = await axiosClient.request({
      url: path,
      method: (init?.method ?? "GET") as any,
      headers: init?.headers,
      data: init?.body ? JSON.parse(init.body) : undefined
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.data
    };
  } catch (err: any) {
    const status = err?.response?.status ?? 500;
    const data = err?.response?.data ?? {};
    return {
      ok: false,
      status,
      json: async () => data
    };
  }
}
