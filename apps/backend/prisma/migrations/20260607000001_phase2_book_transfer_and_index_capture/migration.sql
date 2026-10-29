-- Phase 2 Migration 2 — BookTransfer model + capture orphan composite index
--
-- This migration is part of the Phase 2 three-migration sequence:
--   20260607000000_phase2_extended_flag_and_check_constraint
--   20260607000001_phase2_book_transfer_and_index_capture  (this file)
--   20260607000002_phase2_ri_partitions
--
-- Purpose:
--   1. Create the BookTransfer table for inter-library roaming returns.
--      returnRoaming will create a PENDING row instead of bumping the source
--      library's availableCount; the confirm endpoint that flips PENDING ->
--      CONFIRMED and moves inventory is wired in Plan 02-05.
--   2. Paper-trail fix: capture the Phase 1 composite index
--      ReadingIndex_userId_calculatedAt_idx that was applied via `prisma db
--      push` in Plan 01-02 but never made it into a migration file. Using
--      CREATE INDEX IF NOT EXISTS so this is a no-op on the live dev DB
--      where the index already exists, and a real CREATE on a fresh DB.

-- 1. BookTransfer table
CREATE TABLE "BookTransfer" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "fromLibraryId" TEXT NOT NULL,
    "toLibraryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,

    CONSTRAINT "BookTransfer_pkey" PRIMARY KEY ("id")
);

-- 2. Indexes for BookTransfer
CREATE INDEX "BookTransfer_transactionId_idx" ON "BookTransfer"("transactionId");
CREATE INDEX "BookTransfer_fromLibraryId_status_idx" ON "BookTransfer"("fromLibraryId", "status");
CREATE INDEX "BookTransfer_requestedAt_idx" ON "BookTransfer"("requestedAt");

-- 3. Foreign keys for BookTransfer
ALTER TABLE "BookTransfer"
  ADD CONSTRAINT "BookTransfer_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "BookTransaction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookTransfer"
  ADD CONSTRAINT "BookTransfer_fromLibraryId_fkey"
  FOREIGN KEY ("fromLibraryId") REFERENCES "Library"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookTransfer"
  ADD CONSTRAINT "BookTransfer_toLibraryId_fkey"
  FOREIGN KEY ("toLibraryId") REFERENCES "Library"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Paper-trail fix: capture the orphan composite index from Plan 01-02.
--    IF NOT EXISTS so this is a no-op on the live dev DB (Phase 1 `prisma db
--    push` already created it) and a real CREATE on a fresh DB.
CREATE INDEX IF NOT EXISTS "ReadingIndex_userId_calculatedAt_idx"
  ON "ReadingIndex"("userId", "calculatedAt");
