import { useAuthStore } from "@/store/auth.store";

/**
 * Convenience hook that returns the current authenticated user.
 * Wraps useAuthStore so components don't need to import the store directly.
 */
export function useCurrentUser() {
  const { user, isAuthenticated } = useAuthStore();
  return { user, isAuthenticated };
}
