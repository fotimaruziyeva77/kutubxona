import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/store/auth.store";

/**
 * Tizimdan chiqish — BOSH SAHIFAGA.
 *
 * Avval "Chiqish" login sahifasiga olib borardi: foydalanuvchi bosh sahifaga
 * qanday qaytishini bilmasdi. Endi sessiya tozalanadi va qattiq navigatsiya
 * bilan bosh sahifa ochiladi (xotiradagi barcha so'rov keshi ham tozalanadi).
 *
 * `loggingOut` bayrog'i himoyalangan sahifalar guard'iga "login'ga
 * yo'naltirma" deydi — aks holda store tozalangan zahoti guard login'ga
 * yuborib, bosh sahifa o'rniga yana login ochilardi.
 */
let loggingOut = false;

export function isLoggingOut(): boolean {
  return loggingOut;
}

export async function logoutToHome(locale: string): Promise<void> {
  loggingOut = true;
  await authApi.logout().catch(() => {});
  useAuthStore.getState().logout();
  window.location.replace(`/${locale}`);
}
