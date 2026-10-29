-- M-geo (2026-06-10) — Tuman/Mahalla slug unikallik kafolati.
--
-- sifat.uz/[viloyat]/[tuman] va .../mahalla-[slug] URL routing'i slug bo'yicha
-- lookup qiladi; parent scope ichida ikkita bir xil slug noto'g'ri sahifani
-- ochib yuborardi. Schema'ga @@unique([viloyatId, slug]) (Tuman) va
-- @@unique([tumanId, slug]) (Mahalla) qo'shildi.
--
-- Index nomlari Prisma'ning default naming konventsiyasiga mos
-- (<Model>_<field1>_<field2>_key) — `migrate dev` drift ko'rsatmasligi uchun.
-- IF NOT EXISTS: lokal DB'larda qo'lda yaratilgan bo'lishi mumkin bo'lgan
-- indekslar bilan to'qnashuvni oldini oladi (idempotent).
--
-- Pre-check (2026-06-10, lokal sifat DB): 31 Tuman / 38 Mahalla qatorida
-- hech qanday slug kollizi yo'q — seed o'zgarishi talab qilinmadi.

CREATE UNIQUE INDEX IF NOT EXISTS "Tuman_viloyatId_slug_key" ON "Tuman"("viloyatId", "slug");

CREATE UNIQUE INDEX IF NOT EXISTS "Mahalla_tumanId_slug_key" ON "Mahalla"("tumanId", "slug");
