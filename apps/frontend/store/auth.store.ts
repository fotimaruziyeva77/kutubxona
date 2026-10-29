"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setAuthHintCookie, clearAuthHintCookie } from "@/lib/auth-cookie";
import { clearSyncQueue } from "@/lib/offline/sync";

// H16 legacy eviction (module init): earlier builds kept the access token in
// a standalone localStorage key that the old axios interceptor read. Nothing
// reads it anymore — scrub it eagerly so migrated sessions don't leave a
// JS-readable token behind even if the user never logs in/out again. (The
// zustand-persisted copy inside "sifat-auth" is stripped by the persist
// `migrate` below.)
if (typeof window !== "undefined") {
  window.localStorage.removeItem("accessToken");
  window.localStorage.removeItem("refreshToken");
}

interface User {
  id: string;
  phone: string;
  name: string;
  sifatId?: string;
  status: string;
  role: string;
  readingScore?: number;
  organizationId?: string;
  schoolId?: string;
  libraryId?: string;
  familyId?: string;
  // MUASSASA_ADMIN boshqaradigan muassasa turi (MAKTAB|OTM|IDORA|MAHALLA) —
  // /users/me'dan keladi. Sidebar shu bo'yicha tur-paneli filtrlanadi.
  institutionType?: string | null;
  // GET /users/me includes the caller's address (include:{address:true}). Tier
  // admins (VILOYAT_ADMIN/TUMAN_ADMIN) are geo-scoped by these ids — the stats
  // panel locks its scope to the caller's own viloyat/tuman from here.
  address?: {
    viloyatId?: string | null;
    tumanId?: string | null;
    mahallaId?: string | null;
  } | null;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  /** @alias accessToken — legacy field name kept for backwards compat */
  token: string | null;
  isAuthenticated: boolean;
  isNewUser: boolean;
  // INFRA-02: setTokens now accepts only the access token. The refresh token
  // is set by the backend as an HttpOnly cookie and is never visible to JS.
  setTokens: (access: string, isNew?: boolean) => void;
  setUser: (user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      token: null,
      isAuthenticated: false,
      isNewUser: false,

      setTokens: (accessToken, isNewUser = false) => {
        // H16: the access token is IN-MEMORY ONLY. It is deliberately NOT
        // written to localStorage and NOT persisted by the partialize below.
        // After a hard reload, lib/api/client.ts re-mints it with one silent
        // refresh against the HttpOnly refresh cookie (single-flight).
        if (typeof window !== "undefined") {
          // Legacy eviction: earlier builds wrote both tokens to
          // localStorage. Scrub them so migrating sessions don't keep
          // JS-readable copies around.
          localStorage.removeItem("accessToken");
          localStorage.removeItem("refreshToken");
        }
        // C11: drop the non-HttpOnly `sl_auth` presence cookie so the
        // middleware can gate /dashboard etc. UX gating ONLY — real
        // authorization stays on the API (JWT + RBAC). See lib/auth-cookie.ts.
        setAuthHintCookie();
        set({ accessToken, token: accessToken, isAuthenticated: true, isNewUser });
      },

      setUser: (user) => set({ user }),

      logout: () => {
        if (typeof window !== "undefined") {
          // Defensive: clear any pre-migration token copies too.
          localStorage.removeItem("accessToken");
          localStorage.removeItem("refreshToken");
        }
        // M20: a logout must also drop any offline-queued transactions, so a
        // different user on the same device (shared kiosk/librarian phone)
        // can never replay the previous session's writes. Fire-and-forget —
        // logout itself must stay synchronous.
        clearSyncQueue().catch(() => {
          /* IndexedDB unavailable (SSR/private mode) — nothing to clear */
        });
        // C11: clear the middleware presence cookie so protected routes
        // redirect to /login again.
        clearAuthHintCookie();
        set({ user: null, accessToken: null, token: null, isAuthenticated: false, isNewUser: false });
      }
    }),
    {
      name: "sifat-auth",
      // H16: accessToken REMOVED from the persisted allowlist — bearer
      // tokens never touch storage anymore (XSS hardening). Only the user
      // profile and the isAuthenticated UX flag survive reloads; the token
      // itself is re-minted via the HttpOnly refresh cookie on boot.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated
      }),
      // H16 legacy eviction: version bump strips accessToken (and any other
      // stragglers) out of previously-persisted "sifat-auth" blobs so old
      // tokens neither rehydrate into memory nor linger in localStorage.
      version: 1,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<AuthState>;
        return {
          user: state.user ?? null,
          isAuthenticated: state.isAuthenticated ?? false
        } as AuthState;
      }
    }
  )
);
