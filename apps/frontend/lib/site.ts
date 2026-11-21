// Saytning ommaviy manzili (SEO: canonical, OpenGraph, sitemap, robots, JSON-LD).
// NEXT_PUBLIC_SITE_URL build paytida beriladi (deploy: https://sifatlibrary.uz);
// berilmasa — TZ dagi asosiy domen.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://sifat.uz"
).replace(/\/+$/, "");
