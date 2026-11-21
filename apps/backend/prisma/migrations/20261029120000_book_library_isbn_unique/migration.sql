-- FR2 (iyul auditi, XATOLIKLAR-2026-07.md): Book = kutubxonadagi NUSXA yozuvi;
-- bir kutubxonada bir ISBN uchun bitta qator bo'lishi kerak. Aks holda Excel
-- import ikki marta yurgizilsa yoki kitob qo'lda qayta qo'shilsa ikkinchi
-- bookId paydo bo'lar va bitta jismoniy kitob ikki karra kredit berar edi.
--
-- 1) Mavjud dublikatlar birlashtiriladi: (libraryId, isbn) guruhida eng eski
--    qator qoladi, nusxa sonlari unga qo'shiladi, tranzaksiyalar (Book ga
--    yagona FK — BookTransaction.bookId) unga ko'chiriladi, qolganlari
--    o'chiriladi. Dev bazada 2026-10-29: 0 ta guruh — bo'sh yuradi.
-- 2) Unique indeks — Prisma nomi "Book_libraryId_isbn_key".

CREATE TEMP TABLE book_keep AS
SELECT DISTINCT ON ("libraryId", isbn) id AS keep_id, "libraryId", isbn
FROM "Book"
ORDER BY "libraryId", isbn, "createdAt" ASC, id ASC;

CREATE TEMP TABLE book_dups AS
SELECT b.id, k.keep_id
FROM "Book" b
JOIN book_keep k ON k."libraryId" = b."libraryId" AND k.isbn = b.isbn
WHERE b.id <> k.keep_id;

UPDATE "Book" b
SET "totalCount"     = b."totalCount"     + s.total_sum,
    "availableCount" = b."availableCount" + s.avail_sum
FROM (
  SELECT d.keep_id,
         SUM(x."totalCount")     AS total_sum,
         SUM(x."availableCount") AS avail_sum
  FROM book_dups d
  JOIN "Book" x ON x.id = d.id
  GROUP BY d.keep_id
) s
WHERE b.id = s.keep_id;

UPDATE "BookTransaction" t
SET "bookId" = d.keep_id
FROM book_dups d
WHERE t."bookId" = d.id;

DELETE FROM "Book" b
USING book_dups d
WHERE b.id = d.id;

DROP TABLE book_dups;
DROP TABLE book_keep;

CREATE UNIQUE INDEX "Book_libraryId_isbn_key" ON "Book"("libraryId", "isbn");
