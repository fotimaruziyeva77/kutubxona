import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { StatusPage } from "@/components/ui/status-page";
import { buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export const metadata: Metadata = {
  title: "Ruxsat yo'q",
  // Xato sahifalari qidiruv natijalariga tushmasligi kerak.
  robots: { index: false, follow: false },
};

/**
 * 403 — ruxsat yo'q (DESIGN.md §8).
 *
 * Alohida route sifatida mavjud, chunki server komponentlari va middleware
 * `redirect()` bilan shu yerga yo'naltira oladi. Dashboard ichidagi qisman
 * bloklar uchun esa `<ForbiddenState />` komponenti ishlatiladi — u butun
 * sahifani almashtirmaydi.
 */
export default async function ForbiddenPage() {
  const locale = await getLocale();
  const t = await getTranslations("errors");

  return (
    <StatusPage
      code="403"
      icon={Icon.locked}
      tone="warning"
      title={t("forbidden.title")}
      description={t("forbidden.description")}
      actions={
        <>
          <Link href={`/${locale}`} className={buttonVariants({ size: "touch" })}>
            {t("actions.home")}
          </Link>
          <Link
            href={`/${locale}/login`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            {t("actions.login")}
          </Link>
        </>
      }
    />
  );
}
