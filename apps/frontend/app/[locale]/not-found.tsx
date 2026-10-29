import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { StatusPage } from "@/components/ui/status-page";
import { buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * 404 — sahifa topilmadi (DESIGN.md §8).
 *
 * `[locale]` segmenti ostida joylashgan, shuning uchun til konteksti mavjud
 * va barcha havolalar til prefiksini saqlaydi.
 */
export default async function LocaleNotFound() {
  const locale = await getLocale();
  const t = await getTranslations("errors");

  return (
    <StatusPage
      code="404"
      icon={Icon.search}
      title={t("notFound.title")}
      description={t("notFound.description")}
      actions={
        <>
          <Link href={`/${locale}`} className={buttonVariants({ size: "touch" })}>
            {t("actions.home")}
          </Link>
          <Link
            href={`/${locale}/search`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            {t("actions.search")}
          </Link>
        </>
      }
    />
  );
}
