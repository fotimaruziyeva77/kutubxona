import { SITE_URL } from "@/lib/site";
import { Metadata } from "next";
import { getLibrary, getLibraryByCode } from "@/lib/api/libraries";
import LibraryProfileClient from "./LibraryProfileClient";

interface Props {
  params: { code: string; locale: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  try {
    // [code] may be a real code or a raw library id (search results link by
    // libraryId when the code is absent from the payload) — try both.
    const lib = await getLibraryByCode(params.code).catch(() => getLibrary(params.code));
    const url = `${SITE_URL}/${params.locale}/library/${encodeURIComponent(lib.code || params.code)}`;
    return {
      title: lib.name,
      description: `${lib.name}${lib.address ? ` — ${lib.address}` : ""} · Fond: ${lib.fundCount} kitob. SIFAT LIBRARY orqali kitob qidiring va onlayn bron qiling.`,
      alternates: { canonical: url },
      openGraph: {
        title: lib.name,
        description: `Kutubxona kodi: ${lib.code} · ${lib.fundCount} kitob`,
        url,
        siteName: "SIFAT LIBRARY",
        images: [`${SITE_URL}/og-image.png`]
      }
    };
  } catch {
    return { title: "Kutubxona" };
  }
}

export default function LibraryProfilePage({ params }: Props) {
  return <LibraryProfileClient code={params.code} />;
}
