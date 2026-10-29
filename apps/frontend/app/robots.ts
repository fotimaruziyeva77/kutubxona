import { MetadataRoute } from "next";

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
    sitemap: "https://sifat.uz/sitemap.xml",
    host: "https://sifat.uz",
  };
}
