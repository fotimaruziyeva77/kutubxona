-- Migration-history backfill — schema.prisma accumulated tables, columns, and
-- one enum type over time via `prisma db push` in dev, without ever getting
-- matching migration files. No migration before this one creates: 24 tables
-- (LibraryApprovalLog, Top100Entry, Badge, UserBadge, Donate, IsbnScan,
-- ComprehensionTest, OtpCode, DemoRequest, Institution, Store, StoreProduct,
-- Club, ClubMember, Debate, FamilyInvite, FamilyRating, SchoolRating,
-- Department, BookCorner, ReadingHour, ReadingHourAttendee, ProfBook,
-- OrgRating), the InstitutionType enum, or several columns on tables that DO
-- already exist (Book.coverUrl/description/totalCount + default tweaks,
-- BookTransaction.dueDate/reservationExpiresAt, Family.addressId/viloyatId/
-- tumanId/mahallaId, Library.address/phone/workHours/latitude/longitude/
-- tumanId/viloyatId/frozenReason, Payment.cancelledAt/cancelReason,
-- User.passwordHash/pinfl).
--
-- Generated via `prisma migrate diff` between a from-scratch shadow database
-- (migrations 1-8 only, so no leftover db-push drift could hide a gap) and
-- the full schema.prisma, then hand-edited to remove anything a LATER
-- migration in this chain already creates non-idempotently (which would
-- otherwise collide): ClubMemberConsentToken/DebateMedia/ReadingHourMedia/
-- BookCornerVerification tables; Debate.status/ReadingHour.status/
-- User.hideReadingHistory columns; FamilyMembership_userId_key drop AND
-- FamilyMembership_userId_idx create (neither can run here — FamilyMembership
-- itself doesn't exist yet, it's created by the very next migration; both
-- are recreated idempotently by 20260608000004 in their proper place).
-- Never touches ReadingIndex —
-- see 20260607000002_phase2_ri_partitions for why that table intentionally
-- diverges from what a naive diff would produce.
--
-- Timestamped to sort between phase5_devicetoken and
-- phase6_family_membership_addr_change.

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('MAKTAB', 'OTM', 'IDORA', 'MAHALLA');

-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "coverUrl" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "totalCount" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "lang" SET DEFAULT 'uz',
ALTER COLUMN "pages" SET DEFAULT 0,
ALTER COLUMN "year" SET DEFAULT 0,
ALTER COLUMN "availableCount" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "BookTransaction" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "reservationExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Family" ADD COLUMN     "addressId" TEXT,
ADD COLUMN     "mahallaId" TEXT,
ADD COLUMN     "tumanId" TEXT,
ADD COLUMN     "viloyatId" TEXT;

-- AlterTable
ALTER TABLE "Library" ADD COLUMN     "address" TEXT,
ADD COLUMN     "frozenReason" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "tumanId" TEXT,
ADD COLUMN     "viloyatId" TEXT,
ADD COLUMN     "workHours" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cancelReason" INTEGER,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "pinfl" TEXT;

-- CreateTable
CREATE TABLE "LibraryApprovalLog" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryApprovalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Top100Entry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "gender" "UserGender" NOT NULL,
    "ageGroup" TEXT NOT NULL,
    "userType" "UserType" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Top100Entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donate" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "targetId" TEXT,
    "targetName" TEXT,
    "paymentId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "donorName" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IsbnScan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isbn" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'USER_SCAN',
    "storeId" TEXT,
    "orderId" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IsbnScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComprehensionTest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isbnScanId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComprehensionTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoRequest" (
    "id" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "orgType" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "type" "InstitutionType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "tumanId" TEXT NOT NULL,
    "viloyatId" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "directorId" TEXT,
    "libraryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "workingHours" JSONB,
    "logoUrl" TEXT,
    "premiumBadge" BOOLEAN NOT NULL DEFAULT false,
    "premiumSince" TIMESTAMP(3),
    "operatorId" TEXT NOT NULL,
    "hmacSecret" TEXT NOT NULL,
    "tumanId" TEXT NOT NULL,
    "viloyatId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreProduct" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "isbn" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "genre" TEXT,
    "price" INTEGER NOT NULL,
    "stockCount" INTEGER NOT NULL DEFAULT 0,
    "coverUrl" TEXT,
    "description" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'uz',
    "pages" INTEGER NOT NULL DEFAULT 0,
    "year" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Club" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "goal" INTEGER NOT NULL DEFAULT 20,
    "quarterGoal" INTEGER NOT NULL DEFAULT 5,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMember" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "parentPhone" TEXT,
    "parentConsented" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Debate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3) NOT NULL,
    "venue" TEXT,
    "participants" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "mediaUrls" TEXT[],
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Debate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyInvite" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FamilyRating" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "avgScore" DOUBLE PRECISION NOT NULL,
    "totalBooks" INTEGER NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "rank" INTEGER,
    "viloyatRank" INTEGER,
    "tumanRank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FamilyRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolRating" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "coverageRate" DOUBLE PRECISION NOT NULL,
    "avgRi" DOUBLE PRECISION NOT NULL,
    "clubActivity" DOUBLE PRECISION NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER,
    "viloyatRank" INTEGER,
    "tumanRank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "headId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookCorner" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Kitob burchagi',
    "floor" TEXT,
    "photoUrls" TEXT[],
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastVerified" TIMESTAMP(3),
    "nextReminderAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookCorner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingHour" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Kitob o''qish soati',
    "heldAt" TIMESTAMP(3) NOT NULL,
    "venue" TEXT,
    "durationMin" INTEGER NOT NULL DEFAULT 60,
    "mediaUrls" TEXT[],
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadingHour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadingHourAttendee" (
    "id" TEXT NOT NULL,
    "readingHourId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadingHourAttendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfBook" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "departmentId" TEXT,
    "isbn" TEXT,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "genre" TEXT,
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgRating" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "department" TEXT,
    "avgRi" DOUBLE PRECISION NOT NULL,
    "booksRead" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "isMvp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryApprovalLog_libraryId_idx" ON "LibraryApprovalLog"("libraryId");

-- CreateIndex
CREATE INDEX "Top100Entry_month_rank_idx" ON "Top100Entry"("month", "rank");

-- CreateIndex
CREATE INDEX "Top100Entry_month_gender_idx" ON "Top100Entry"("month", "gender");

-- CreateIndex
CREATE INDEX "Top100Entry_month_userType_idx" ON "Top100Entry"("month", "userType");

-- CreateIndex
CREATE UNIQUE INDEX "Top100Entry_userId_month_key" ON "Top100Entry"("userId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_code_key" ON "Badge"("code");

-- CreateIndex
CREATE INDEX "UserBadge_userId_idx" ON "UserBadge"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBadge_userId_badgeId_key" ON "UserBadge"("userId", "badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "Donate_paymentId_key" ON "Donate"("paymentId");

-- CreateIndex
CREATE INDEX "Donate_status_idx" ON "Donate"("status");

-- CreateIndex
CREATE INDEX "Donate_createdAt_idx" ON "Donate"("createdAt");

-- CreateIndex
CREATE INDEX "IsbnScan_userId_idx" ON "IsbnScan"("userId");

-- CreateIndex
CREATE INDEX "IsbnScan_isbn_idx" ON "IsbnScan"("isbn");

-- CreateIndex
CREATE UNIQUE INDEX "IsbnScan_storeId_orderId_key" ON "IsbnScan"("storeId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ComprehensionTest_isbnScanId_key" ON "ComprehensionTest"("isbnScanId");

-- CreateIndex
CREATE INDEX "ComprehensionTest_userId_idx" ON "ComprehensionTest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OtpCode_phone_key" ON "OtpCode"("phone");

-- CreateIndex
CREATE INDEX "DemoRequest_status_idx" ON "DemoRequest"("status");

-- CreateIndex
CREATE INDEX "DemoRequest_createdAt_idx" ON "DemoRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Institution_code_key" ON "Institution"("code");

-- CreateIndex
CREATE INDEX "Institution_tumanId_idx" ON "Institution"("tumanId");

-- CreateIndex
CREATE INDEX "Institution_viloyatId_idx" ON "Institution"("viloyatId");

-- CreateIndex
CREATE INDEX "Institution_type_idx" ON "Institution"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- CreateIndex
CREATE INDEX "Store_slug_idx" ON "Store"("slug");

-- CreateIndex
CREATE INDEX "Store_tumanId_idx" ON "Store"("tumanId");

-- CreateIndex
CREATE INDEX "Store_viloyatId_idx" ON "Store"("viloyatId");

-- CreateIndex
CREATE INDEX "Store_operatorId_idx" ON "Store"("operatorId");

-- CreateIndex
CREATE INDEX "StoreProduct_storeId_idx" ON "StoreProduct"("storeId");

-- CreateIndex
CREATE INDEX "StoreProduct_isbn_idx" ON "StoreProduct"("isbn");

-- CreateIndex
CREATE UNIQUE INDEX "StoreProduct_storeId_isbn_key" ON "StoreProduct"("storeId", "isbn");

-- CreateIndex
CREATE INDEX "Club_institutionId_idx" ON "Club"("institutionId");

-- CreateIndex
CREATE INDEX "Club_leaderId_idx" ON "Club"("leaderId");

-- CreateIndex
CREATE INDEX "ClubMember_clubId_idx" ON "ClubMember"("clubId");

-- CreateIndex
CREATE INDEX "ClubMember_userId_idx" ON "ClubMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMember_clubId_userId_key" ON "ClubMember"("clubId", "userId");

-- CreateIndex
CREATE INDEX "Debate_clubId_idx" ON "Debate"("clubId");

-- CreateIndex
CREATE INDEX "Debate_heldAt_idx" ON "Debate"("heldAt");

-- CreateIndex
CREATE INDEX "FamilyInvite_inviteeId_idx" ON "FamilyInvite"("inviteeId");

-- CreateIndex
CREATE INDEX "FamilyInvite_familyId_idx" ON "FamilyInvite"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyInvite_familyId_inviteeId_key" ON "FamilyInvite"("familyId", "inviteeId");

-- CreateIndex
CREATE INDEX "FamilyRating_month_avgScore_idx" ON "FamilyRating"("month", "avgScore");

-- CreateIndex
CREATE UNIQUE INDEX "FamilyRating_familyId_month_key" ON "FamilyRating"("familyId", "month");

-- CreateIndex
CREATE INDEX "SchoolRating_month_totalScore_idx" ON "SchoolRating"("month", "totalScore");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolRating_institutionId_month_key" ON "SchoolRating"("institutionId", "month");

-- CreateIndex
CREATE INDEX "Department_institutionId_idx" ON "Department"("institutionId");

-- CreateIndex
CREATE INDEX "BookCorner_institutionId_idx" ON "BookCorner"("institutionId");

-- CreateIndex
CREATE INDEX "ReadingHour_institutionId_idx" ON "ReadingHour"("institutionId");

-- CreateIndex
CREATE INDEX "ReadingHour_heldAt_idx" ON "ReadingHour"("heldAt");

-- CreateIndex
CREATE INDEX "ReadingHourAttendee_readingHourId_idx" ON "ReadingHourAttendee"("readingHourId");

-- CreateIndex
CREATE UNIQUE INDEX "ReadingHourAttendee_readingHourId_userId_key" ON "ReadingHourAttendee"("readingHourId", "userId");

-- CreateIndex
CREATE INDEX "ProfBook_institutionId_idx" ON "ProfBook"("institutionId");

-- CreateIndex
CREATE INDEX "ProfBook_departmentId_idx" ON "ProfBook"("departmentId");

-- CreateIndex
CREATE INDEX "OrgRating_institutionId_month_idx" ON "OrgRating"("institutionId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "OrgRating_institutionId_month_userId_key" ON "OrgRating"("institutionId", "month", "userId");

-- CreateIndex
CREATE INDEX "Book_libraryId_idx" ON "Book"("libraryId");

-- CreateIndex
CREATE INDEX "BookTransaction_userId_status_idx" ON "BookTransaction"("userId", "status");

-- CreateIndex
CREATE INDEX "BookTransaction_status_dueDate_idx" ON "BookTransaction"("status", "dueDate");

-- CreateIndex
CREATE INDEX "BookTransaction_reservationExpiresAt_idx" ON "BookTransaction"("reservationExpiresAt");

-- CreateIndex
CREATE INDEX "Family_tumanId_idx" ON "Family"("tumanId");

-- CreateIndex
CREATE INDEX "Family_mahallaId_idx" ON "Family"("mahallaId");

-- CreateIndex
CREATE UNIQUE INDEX "FraudScore_userId_key" ON "FraudScore"("userId");

-- CreateIndex
CREATE INDEX "FraudScore_riskScore_idx" ON "FraudScore"("riskScore");

-- CreateIndex
CREATE INDEX "FraudScore_action_idx" ON "FraudScore"("action");

-- CreateIndex
CREATE INDEX "Library_status_idx" ON "Library"("status");

-- CreateIndex
CREATE INDEX "Library_type_idx" ON "Library"("type");

-- CreateIndex
CREATE INDEX "Library_tumanId_idx" ON "Library"("tumanId");

-- CreateIndex
CREATE INDEX "Library_viloyatId_idx" ON "Library"("viloyatId");

-- CreateIndex
CREATE UNIQUE INDEX "Mahalla_tumanId_slug_key" ON "Mahalla"("tumanId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tuman_viloyatId_slug_key" ON "Tuman"("viloyatId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_pinfl_key" ON "User"("pinfl");

-- AddForeignKey
ALTER TABLE "LibraryApprovalLog" ADD CONSTRAINT "LibraryApprovalLog_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Top100Entry" ADD CONSTRAINT "Top100Entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donate" ADD CONSTRAINT "Donate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IsbnScan" ADD CONSTRAINT "IsbnScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComprehensionTest" ADD CONSTRAINT "ComprehensionTest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComprehensionTest" ADD CONSTRAINT "ComprehensionTest_isbnScanId_fkey" FOREIGN KEY ("isbnScanId") REFERENCES "IsbnScan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreProduct" ADD CONSTRAINT "StoreProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Debate" ADD CONSTRAINT "Debate_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReadingHourAttendee" ADD CONSTRAINT "ReadingHourAttendee_readingHourId_fkey" FOREIGN KEY ("readingHourId") REFERENCES "ReadingHour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfBook" ADD CONSTRAINT "ProfBook_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

