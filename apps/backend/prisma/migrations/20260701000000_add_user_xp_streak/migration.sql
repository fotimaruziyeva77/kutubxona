-- Gamifikatsiya poydevori — UserXp (XP + Level + Streak).
--
-- Har foydalanuvchi uchun bitta qator (userId unique). Qator birinchi
-- tasdiqlangan o'qish hodisasida lazy yaratiladi (XpService.award upsert) —
-- 5M mavjud foydalanuvchi uchun oldindan backfill qilinmaydi.
--
-- ReadingIndex/AiAuditLog `migrate diff` chiqishida har doim "PK ni tiklash"
-- taklifi bo'ladi (ular qo'lda PARTITION BY RANGE ga o'tkazilgan — qarang
-- 20260607000002 va 20260609000000). Bu migratsiyaga ATAYIN kiritilmagan.

CREATE TABLE "UserXp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserXp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserXp_userId_key" ON "UserXp"("userId");

-- Leaderboard/reyting so'rovlari uchun (ORDER BY xp DESC).
CREATE INDEX "UserXp_xp_idx" ON "UserXp"("xp");

ALTER TABLE "UserXp" ADD CONSTRAINT "UserXp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
