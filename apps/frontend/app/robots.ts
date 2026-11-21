import { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/uz-Latn/", "/uz-Cyrl/", "/ru/", "/kaa/"],
        disallow: [
          "/dashboard/",
          "/api/",
          "/_next/",
          "/admin/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
