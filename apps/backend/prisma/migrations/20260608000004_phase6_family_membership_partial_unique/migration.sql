-- Plan 06-01-fix audit-HIGH — FamilyMembership rejoin bug fix.
--
-- Drop the lifetime @unique constraint on userId and replace with a
-- partial unique index that only enforces uniqueness when leftAt IS NULL
-- ("1 user = 1 ACTIVE family", per CLAUDE.md §IV.4 / FAM-06).
--
-- Without this, leaveFamily + accept-new-invite would always P2002.
DROP INDEX IF EXISTS "FamilyMembership_userId_key";
CREATE INDEX IF NOT EXISTS "FamilyMembership_userId_idx" ON "FamilyMembership"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "FamilyMembership_userId_active_unique"
  ON "FamilyMembership"("userId") WHERE "leftAt" IS NULL;
