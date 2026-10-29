-- Plan 06-01 Task 3 — Phase 6 schema additions (Wave 0).
--
-- Adds:
--   * User.familyDetectionEnabled BOOL DEFAULT false (FAM-01 opt-IN gate)
--   * FamilyMembership table  (FAM-03 explicit join date with backfill)
--   * AddressChangeRequest table (FAM-06 tuman-admin approval flow)
--
-- The FamilyMembership backfill writes one row per existing User where
-- familyId IS NOT NULL, with joinedAt approximated by User.createdAt — this
-- is the best available proxy for legacy rows. See RESEARCH §Pitfall 5.

-- ── User.familyDetectionEnabled ────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN "familyDetectionEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ── FamilyMembership ───────────────────────────────────────────────────────
CREATE TABLE "FamilyMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "FamilyMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FamilyMembership_userId_key" ON "FamilyMembership"("userId");
CREATE INDEX "FamilyMembership_familyId_idx" ON "FamilyMembership"("familyId");
CREATE INDEX "FamilyMembership_joinedAt_idx" ON "FamilyMembership"("joinedAt");

ALTER TABLE "FamilyMembership" ADD CONSTRAINT "FamilyMembership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FamilyMembership" ADD CONSTRAINT "FamilyMembership_familyId_fkey"
    FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill legacy rows ───────────────────────────────────────────────────
-- One row per existing (User.familyId IS NOT NULL) — joinedAt = User.createdAt
-- because the historical join date is no longer recoverable. ON CONFLICT keeps
-- the migration idempotent if it is replayed.
INSERT INTO "FamilyMembership" ("id", "userId", "familyId", "joinedAt")
SELECT
    -- gen_random_uuid() is available on Postgres >= 13 via pgcrypto/uuid-ossp.
    -- Fall back to md5(random()::text) for clusters without pgcrypto.
    md5(random()::text || clock_timestamp()::text)::text AS id,
    u."id" AS "userId",
    u."familyId" AS "familyId",
    u."createdAt" AS "joinedAt"
FROM "User" u
WHERE u."familyId" IS NOT NULL
ON CONFLICT ("userId") DO NOTHING;

-- ── AddressChangeRequest ───────────────────────────────────────────────────
CREATE TABLE "AddressChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromAddressId" TEXT,
    "toAddressId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressChangeRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AddressChangeRequest_userId_status_idx" ON "AddressChangeRequest"("userId", "status");
CREATE INDEX "AddressChangeRequest_status_createdAt_idx" ON "AddressChangeRequest"("status", "createdAt");

ALTER TABLE "AddressChangeRequest" ADD CONSTRAINT "AddressChangeRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
