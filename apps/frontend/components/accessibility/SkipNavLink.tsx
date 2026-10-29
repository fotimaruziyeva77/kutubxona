"use client";

import { useTranslations } from "next-intl";

/**
 * SkipNavLink — WCAG 2.1 SC 2.4.1 (Bypass Blocks)
 *
 * Renders an anchor that is visually hidden by default but becomes
 * visible when the user presses Tab, allowing keyboard users to skip
 * navigation and jump directly to the main content area (#main-content).
 */
export function SkipNavLink() {
  const t = useTranslations("accessibility");

  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:text-blue-800 focus:px-4 focus:py-2 focus:rounded focus:shadow-lg focus:outline-2 focus:outline-blue-600 focus:font-semibold focus:text-sm"
    >
      {t("skipToContent")}
    </a>
  );
}

export default SkipNavLink;
