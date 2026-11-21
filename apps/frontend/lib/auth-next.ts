/**
 * Kirish/ro'yxatdan o'tishdan keyin qaytish yo'li (masalan kitobni bron qilish
 * sahifasi). Faqat sayt ichidagi nisbiy yo'l qabul qilinadi (open-redirect yo'q).
 */
const KEY = "sl-auth-next";

export function isSafeNextPath(next: string | null | undefined): next is string {
  return !!next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\");
}

export function saveAuthNext(next: string | null | undefined) {
  if (!isSafeNextPath(next)) return;
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* storage bloklangan */
  }
}

export function readAuthNext(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return isSafeNextPath(v) ? v : null;
  } catch {
    return null;
  }
}

export function clearAuthNext() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
