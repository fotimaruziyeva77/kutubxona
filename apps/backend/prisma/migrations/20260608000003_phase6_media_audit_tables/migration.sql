-- Plan 06-01 Task 3 — Media-audit tables (SCH-05 + ORG-03 + ORG-04).
--
-- Structured media trails replace ad-hoc TEXT[] URL columns on Debate,
-- ReadingHour, and BookCorner. Stores mimeType, sizeBytes, uploadedBy for
-- audit and for the MinIO presigned URL fetch path.

-- ── DebateMedia (SCH-05) ───────────────────────────────────────────────────
CREATE TABLE "DebateMedia" (
    "id" TEXT NOT NULL,
    "debateId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "thumbnailUrl" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebateMedia_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DebateMedia_debateId_idx" ON "DebateMedia"("debateId");

ALTER TABLE "DebateMedia" ADD CONSTRAINT "DebateMedia_debateId_fkey"
    FOREIGN KEY ("debateId") REFERENCES "Debate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ReadingHourMedia (ORG-03) ──────────────────────────────────────────────
CREATE TABLE "ReadingHourMedia" (
    "id" TEXT NOT NULL,
    "readingHourId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadingHourMedia_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReadingHourMedia_readingHourId_idx" ON "ReadingHourMedia"("readingHourId");

ALTER TABLE "ReadingHourMedia" ADD CONSTRAINT "ReadingHourMedia_readingHourId_fkey"
    FOREIGN KEY ("readingHourId") REFERENCES "ReadingHour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BookCornerVerification (ORG-04) ────────────────────────────────────────
CREATE TABLE "BookCornerVerification" (
    "id" TEXT NOT NULL,
    "bookCornerId" TEXT NOT NULL,
    "verifiedById" TEXT NOT NULL,
    "photoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookCornerVerification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookCornerVerification_bookCornerId_createdAt_idx" ON "BookCornerVerification"("bookCornerId", "createdAt");

ALTER TABLE "BookCornerVerification" ADD CONSTRAINT "BookCornerVerification_bookCornerId_fkey"
    FOREIGN KEY ("bookCornerId") REFERENCES "BookCorner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
