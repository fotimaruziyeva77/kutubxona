-- Audit HIGH H4 — store purchase webhook idempotency.
--
-- order_id was HMAC-verified (part of the signature payload) and then
-- DISCARDED: never stored, never uniqueness-checked. The dedup keyed on
-- (storeId, isbn, userId), so:
--   (a) N legitimate purchases of the same ISBN by one user collapsed to 1;
--   (b) a store could vary order_id to defeat the intended idempotency;
--   (c) two concurrent identical webhooks both passed findFirst and both
--       inserted (race) — Reading Index inflation, the R3 prize-fraud vector.
--
-- Fix: persist orderId and enforce one row per (storeId, orderId). The
-- index name matches Prisma's default for @@unique([storeId, orderId]) so
-- `migrate dev` never reports drift. PG15 default is NULLS DISTINCT, so
-- user self-scans (storeId IS NULL, orderId IS NULL) are never blocked.
ALTER TABLE "IsbnScan" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "IsbnScan_storeId_orderId_key"
  ON "IsbnScan"("storeId", "orderId");
