-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'BUXGALTER', 'VILOYAT_ADMIN', 'TUMAN_ADMIN', 'MUASSASA_ADMIN', 'KUTUBXONACHI', 'KLUB_RAHBARI', 'DOKON_OPERATOR', 'KITOBXON');

-- CreateTable: Geographic models
CREATE TABLE "Viloyat" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Viloyat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Viloyat_code_key" ON "Viloyat"("code");
CREATE UNIQUE INDEX "Viloyat_slug_key" ON "Viloyat"("slug");

CREATE TABLE "Tuman" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "viloyatId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tuman_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tuman_code_key" ON "Tuman"("code");
CREATE INDEX "Tuman_viloyatId_idx" ON "Tuman"("viloyatId");
ALTER TABLE "Tuman" ADD CONSTRAINT "Tuman_viloyatId_fkey" FOREIGN KEY ("viloyatId") REFERENCES "Viloyat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Mahalla" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tumanId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mahalla_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Mahalla_code_key" ON "Mahalla"("code");
CREATE INDEX "Mahalla_tumanId_idx" ON "Mahalla"("tumanId");
ALTER TABLE "Mahalla" ADD CONSTRAINT "Mahalla_tumanId_fkey" FOREIGN KEY ("tumanId") REFERENCES "Tuman"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: User — add new fields
ALTER TABLE "User"
    ADD COLUMN "sifatId" TEXT,
    ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'KITOBXON',
    ADD COLUMN "schoolId" TEXT,
    ADD COLUMN "schoolClass" TEXT,
    ADD COLUMN "universityId" TEXT,
    ADD COLUMN "faculty" TEXT,
    ADD COLUMN "direction" TEXT,
    ADD COLUMN "studyCourse" INTEGER,
    ADD COLUMN "organizationId" TEXT,
    ADD COLUMN "department" TEXT,
    ADD COLUMN "position" TEXT;

CREATE UNIQUE INDEX "User_sifatId_key" ON "User"("sifatId");
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_type_idx" ON "User"("type");

-- CreateTable: RefreshToken
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_token_idx" ON "RefreshToken"("token");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
