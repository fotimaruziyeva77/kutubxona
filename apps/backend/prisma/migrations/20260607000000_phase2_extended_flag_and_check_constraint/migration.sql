-- Phase 2 Migration 1 — BookTransaction.extended Boolean + Book.availableCount CHECK constraint
--
-- This migration is part of the Phase 2 three-migration sequence:
--   20260607000000_phase2_extended_flag_and_check_constraint  (this file)
--   20260607000001_phase2_book_transfer_and_index_capture
--   20260607000002_phase2_ri_partitions
--
-- Purpose:
--   1. Add `extended Boolean` to BookTransaction so extendDueDate stops using
--      the `penaltyDays = -1` magic-number sentinel (H6).
--   2. Backfill: any existing row with penaltyDays = -1 becomes
--      {extended: true, penaltyDays: 0} — keeps semantic intent but normalizes
--      the data so the existing `penaltyDays > 0` overdue filter keeps working.
--   3. Add a DB-level CHECK constraint on Book.availableCount so the BOOK-05
--      interactive-transaction work in Plan 02-02 Task 5 has a server-side
--      invariant the race-loser will hit at the DB layer (P2010 surface).

-- 0. FIX (migration history bug): `penaltyDays` was added to schema.prisma
--    at some point but no migration ever created the column on the real
--    table — `init` never had it, and no migration between init and this
--    one adds it either. Every attempt to run this migration against a
--    real database failed with "column penaltyDays does not exist" (P3018)
--    before reaching the UPDATE below. Since this migration has never
--    successfully applied anywhere, it's safe to patch here rather than
--    rewriting the historical `init` migration.
ALTER TABLE "BookTransaction"
  ADD COLUMN "penaltyDays" INTEGER NOT NULL DEFAULT 0;

-- 1. Add the extended column (NOT NULL DEFAULT false → safe on a table with data)
ALTER TABLE "BookTransaction"
  ADD COLUMN "extended" BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill any legacy magic-number rows. After this update, penaltyDays = -1
--    no longer exists anywhere in the table. New code in transactions.service.ts
--    (extendDueDate) writes `extended = true` instead.
UPDATE "BookTransaction"
   SET "extended" = true,
       "penaltyDays" = 0
 WHERE "penaltyDays" = -1;

-- 3. CHECK constraint — availableCount must never go negative. The interactive
--    $transaction work in Plan 02-02 Task 5 catches the P2010 error this raises
--    and rethrows BadRequestException("Inventory race condition — retry") so
--    callers see a clean 400 rather than a 500.
ALTER TABLE "Book"
  ADD CONSTRAINT "book_availablecount_nonneg" CHECK ("availableCount" >= 0);
