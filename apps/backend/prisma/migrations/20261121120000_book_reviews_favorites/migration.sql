-- CreateTable
CREATE TABLE "BookReview" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoriteBook" (
    "userId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteBook_pkey" PRIMARY KEY ("userId","bookId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookReview_userId_bookId_key" ON "BookReview"("userId", "bookId");

-- CreateIndex
CREATE INDEX "BookReview_bookId_createdAt_idx" ON "BookReview"("bookId", "createdAt");

-- CreateIndex
CREATE INDEX "FavoriteBook_userId_createdAt_idx" ON "FavoriteBook"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookReview" ADD CONSTRAINT "BookReview_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookReview" ADD CONSTRAINT "BookReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteBook" ADD CONSTRAINT "FavoriteBook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoriteBook" ADD CONSTRAINT "FavoriteBook_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
