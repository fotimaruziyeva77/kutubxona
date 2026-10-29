-- Plan 06-06 ORG-03 — Reading Hour DRAFT/PUBLISHED/CANCELLED state machine.
-- Pre-existing dev rows are backfilled to PUBLISHED so monthly counts
-- (consumed by Plan 06-05 PQ-9 PDF) don't regress.

ALTER TABLE "ReadingHour" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';
CREATE INDEX "ReadingHour_status_idx" ON "ReadingHour"("status");
UPDATE "ReadingHour" SET "status" = 'PUBLISHED' WHERE "createdAt" < CURRENT_TIMESTAMP;
