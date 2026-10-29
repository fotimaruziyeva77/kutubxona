-- Plan 06-01 Task 3 — ClubMemberConsentToken (SCH-04).
--
-- Bcrypt-hashed deep-link token for parent SMS consent (CLAUDE.md §VII).
-- Token TTL = 48h (enforced at write time in Plan 06-04 wiring). Plumbing only
-- in this migration — endpoint surface lives in Plan 06-04.

CREATE TABLE "ClubMemberConsentToken" (
    "id" TEXT NOT NULL,
    "clubMemberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMemberConsentToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClubMemberConsentToken_clubMemberId_key" ON "ClubMemberConsentToken"("clubMemberId");
CREATE UNIQUE INDEX "ClubMemberConsentToken_tokenHash_key" ON "ClubMemberConsentToken"("tokenHash");
CREATE INDEX "ClubMemberConsentToken_expiresAt_idx" ON "ClubMemberConsentToken"("expiresAt");

ALTER TABLE "ClubMemberConsentToken" ADD CONSTRAINT "ClubMemberConsentToken_clubMemberId_fkey"
    FOREIGN KEY ("clubMemberId") REFERENCES "ClubMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
