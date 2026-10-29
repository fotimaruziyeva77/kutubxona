-- Plan 06-04 SCH-05 — Debate state machine column
--
-- DRAFT  → newly created, awaiting ≥1 valid media upload
-- PUBLISHED → finalised; quarterly + PDF reports only count PUBLISHED debates
ALTER TABLE "Debate" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';

CREATE INDEX "Debate_status_idx" ON "Debate"("status");

-- Backfill any pre-existing rows (Wave 1 dev DB seed) to PUBLISHED to preserve
-- existing quarterly counts. Brand-new rows from Plan 06-04 onwards land DRAFT.
UPDATE "Debate" SET "status" = 'PUBLISHED' WHERE "createdAt" < CURRENT_TIMESTAMP;
