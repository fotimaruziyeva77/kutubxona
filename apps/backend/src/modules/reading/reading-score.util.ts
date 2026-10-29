/**
 * reading-score.util.ts — Reading Index hisoblash uchun YAGONA pure funksiya.
 *
 * C5 (CRITICAL) fix: ilgari reading.service.ts va ri-recalc.processor.ts
 * har RETURNED tranzaksiyani alohida sanardi (`allTx.length * COEF.LIBRARY`).
 * BITTA jismoniy kitobni ~10 marta olib-qaytarish booksCount ni 100 ga
 * to'ldirardi — Top-100 pul mukofotini "fermalash" va milliy indeksni
 * sun'iy oshirish yo'li. Tarixiy duplicate qatorlar bazada mavjud, shuning
 * uchun dedup INSERT vaqtida emas, AYNAN scoring vaqtida bajariladi:
 *
 *   - Kutubxona krediti  = RETURNED tranzaksiyalar ichida DISTINCT ASAR (×1.0)
 *     — kalit `book.isbn` (bo'lmasa `bookId`). FR1 (iyul auditi): `Book`
 *     qatori kutubxonaga bog'langan NUSXA yozuvi, asar emas — "Alpomish"
 *     2000 kutubxonada 2000 ta har xil bookId. bookId bo'yicha dedup roaming
 *     orqali (bir kitobni har kutubxonada olib-qaytarish) chetlab o'tilardi.
 *   - ISBN scan krediti  = tasdiqlangan scanlar ichida DISTINCT isbn (×0.9)
 *   - Do'kon krediti     = STORE_MANUAL ichida DISTINCT isbn (×0.9)
 *   - Mutolaa krediti    = MUTOLAA ichida DISTINCT isbn (×0.85)
 *   - E-kitob krediti    = EBOOK ichida DISTINCT isbn (×0.8)
 *
 * Mutolaa eslatmasi: syncMutolaaProgress (reading.service.ts) insert vaqtida
 * (userId, isbn, source=MUTOLAA) bo'yicha duplicate guard qiladi, lekin DB
 * darajasida unique constraint YO'Q — race condition yoki tarixiy yozuvlar
 * dublikat qoldirishi mumkin. Shu sabab scoring-time distinct-isbn qoidasi
 * MUTOLAA uchun ham defense-in-depth sifatida qo'llanadi.
 *
 * Qolgan komponentlar (consistency, diversity, discipline, activity) va
 * barcha og'irliklar ATAYIN o'zgartirilmagan — bu fix faqat dedup:
 *   - diversity allaqachon Set<genre> bilan distinct janrlarni sanaydi
 *     (bir kitobning dublikatlari bir xil janrni beradi → Set yutadi);
 *   - consistency xom event-haftalari asosida qoladi (hafta allaqachon
 *     distinct birlik — bir kitobni 4 haftada qaytarish 4 hafta faollik);
 *   - activity (FR3) 30 kunlik oynada DISTINCT ASAR soni — avval xom event
 *     soni edi va bitta kitob + roaming bilan 4 hodisada 100 ga to'lardi;
 *   - discipline har kechikkan qaytarishni alohida sanaydi (har biri real
 *     intizom hodisasi).
 *
 * Ikkala iste'molchi (on-demand service + nightly chunk processor) shu bitta
 * funksiyani chaqiradi — bir xil input uchun bir xil score KONSTRUKSIYA
 * bo'yicha kafolatlanadi.
 */

// Reading Index koeffitsientlari (TZ §4.3 bo'yicha)
export const COEF = {
  LIBRARY: 1.0,    // Kutubxona kitobi (qaytarilgan)
  ISBN_SCAN: 0.9,  // Sotib olingan (user scan)
  STORE: 0.9,      // Kitob do'koni (store_manual)
  MUTOLAA: 0.85,   // Mutolaa platformasi
  EBOOK: 0.8       // Boshqa elektron kitob
} as const;

// Reading Index formulasi komponent og'irliklari (TZ §5.1)
export const WEIGHTS = {
  booksCount: 0.30,
  consistency: 0.20,
  diversity: 0.15,
  discipline: 0.15,
  activity: 0.20
} as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** RETURNED kutubxona tranzaksiyasi — scoring uchun minimal shakl. */
export interface ScoreTransaction {
  bookId?: string | null;
  returnedAt?: Date | null;
  penaltyDays?: number | null;
  book?: { genre?: string | null; isbn?: string | null } | null;
}

/**
 * Tranzaksiyaning ASAR kaliti — ISBN (kutubxonadan mustaqil), u bo'lmasa
 * bookId (nusxa). Caller `book: { select: { isbn: true } }` ni yuklashi shart,
 * aks holda dedup nusxa darajasiga tushadi (fail-safe, lekin roaming teshigi
 * qaytadi — shu sabab har ikkala iste'molchi select'i testda tekshiriladi).
 */
export function transactionWorkKey(t: ScoreTransaction): string | null | undefined {
  return t.book?.isbn || t.bookId;
}

/** Tasdiqlangan IsbnScan yozuvi — scoring uchun minimal shakl. */
export interface ScoreScan {
  isbn?: string | null;
  source?: string | null;
  confirmedAt?: Date | null;
}

export type ReadingScoreComponents = Record<string, number>;

export interface ReadingScoreResult {
  /** 0–100, bir o'nlik xonagacha yaxlitlangan. */
  score: number;
  /**
   * Top-100 auditability breakdown. C5 dan keyin total* maydonlari XOM
   * qator sonini emas, KREDITLANGAN (deduplicated) birliklar sonini
   * ko'rsatadi — auditor ko'rgan son booksCount ga kirgan son bilan mos.
   */
  components: ReadingScoreComponents;
}

/**
 * Berilgan kalit bo'yicha distinct qiymatlar soni.
 *
 * null/undefined kalitlar BITTA sentinelga yig'iladi (fail-closed):
 * productionda bookId/isbn NOT NULL, shuning uchun bu faqat nosog'lom
 * yoki mock ma'lumotda ishga tushadi va hech qachon ortiqcha kredit bermaydi.
 */
export function distinctCount<T>(
  rows: readonly T[],
  key: (row: T) => string | null | undefined
): number {
  if (rows.length === 0) return 0;
  return new Set(rows.map(key)).size;
}

/**
 * Reading Index hisoblash — pure, side-effect siz.
 *
 * @param transactions RETURNED tranzaksiyalar (1 yillik oynada, caller filtrlaydi)
 * @param scans        tasdiqlangan IsbnScan lar (1 yillik oynada, caller filtrlaydi)
 * @param now          hisoblash momenti — 30 kunlik recent oyna shundan olinadi
 */
export function computeReadingScore(
  transactions: readonly ScoreTransaction[],
  scans: readonly ScoreScan[],
  now: Date
): ReadingScoreResult {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS);

  const recentTx = transactions.filter(
    (t) => t.returnedAt && t.returnedAt >= thirtyDaysAgo
  );
  const recentScans = scans.filter(
    (s) => s.confirmedAt && s.confirmedAt >= thirtyDaysAgo
  );

  // Per-source bucketlar (RI-02 / STORE-03 koeffitsient tuzilmasi saqlanadi).
  const scanRows    = scans.filter((s) => s.source === "USER_SCAN");
  const storeRows   = scans.filter((s) => s.source === "STORE_MANUAL");
  const mutolaaRows = scans.filter((s) => s.source === "MUTOLAA");
  const ebookRows   = scans.filter((s) => s.source === "EBOOK");

  // ── Komponent 1: Kitoblar soni (30%) — C5 + FR1 DEDUP ────────────────────
  // Har manba ichida tabiiy kalit bo'yicha DISTINCT sanash: bir kitobni
  // 10 marta qaytarish endi 10.0 emas, 1.0 kredit beradi. Kutubxona uchun
  // kalit ISBN — bir asarni 10 kutubxonada olib-qaytarish ham 1.0.
  const libDistinct     = distinctCount(transactions, transactionWorkKey);
  const scanDistinct    = distinctCount(scanRows,     (s) => s.isbn);
  const storeDistinct   = distinctCount(storeRows,    (s) => s.isbn);
  const mutolaaDistinct = distinctCount(mutolaaRows,  (s) => s.isbn);
  const ebookDistinct   = distinctCount(ebookRows,    (s) => s.isbn);

  const totalWeighted =
    libDistinct     * COEF.LIBRARY +
    scanDistinct    * COEF.ISBN_SCAN +
    storeDistinct   * COEF.STORE +
    mutolaaDistinct * COEF.MUTOLAA +
    ebookDistinct   * COEF.EBOOK;
  const booksCountScore = Math.min(totalWeighted * 10, 100);

  // ── Komponent 2: Muntazamlik (20%) — o'zgarmagan (xom event haftalari) ────
  const weekBuckets = new Set<number>();
  for (const t of recentTx) {
    if (t.returnedAt) weekBuckets.add(Math.floor(t.returnedAt.getTime() / WEEK_MS));
  }
  for (const s of recentScans) {
    if (s.confirmedAt) weekBuckets.add(Math.floor(s.confirmedAt.getTime() / WEEK_MS));
  }
  const consistencyScore = Math.min(weekBuckets.size * 25, 100);

  // ── Komponent 3: Janr xilma-xilligi (15%) — allaqachon distinct ──────────
  // Set<genre> dublikat kitob tranzaksiyalarini tabiiy yutadi: bir kitobning
  // 10 nusxa qaytarilishi bitta janr qo'shadi. Semantika o'zgartirilmagan.
  const genres = new Set(
    recentTx.map((t) => t.book?.genre).filter((g): g is string => Boolean(g))
  );
  const diversityScore = Math.min(genres.size * 20, 100);

  // ── Komponent 4: Qaytarish intizomi (15%) — o'zgarmagan (xom) ────────────
  const lateReturns = transactions.filter((t) => (t.penaltyDays ?? 0) > 0).length;
  const disciplineScore = Math.max(0, 100 - lateReturns * 15);

  // ── Komponent 5: Faollik (20%) — FR3: 30 kunda DISTINCT asar (100 cap) ───
  // Xom hodisa soni emas: bitta kitobni 4 marta (yoki 4 kutubxonada)
  // qaytarish 1 asar = 25 ball. Kutubxona va skan manbalari bitta Set'da —
  // bir asar qaysi yo'l bilan o'qilgan bo'lsa ham bir marta.
  const recentWorks = new Set<string>();
  for (const t of recentTx) {
    const k = transactionWorkKey(t);
    if (k) recentWorks.add(k);
  }
  for (const s of recentScans) {
    if (s.isbn) recentWorks.add(s.isbn);
  }
  const activityScore = Math.min(recentWorks.size * 25, 100);

  const score =
    booksCountScore  * WEIGHTS.booksCount +
    consistencyScore * WEIGHTS.consistency +
    diversityScore   * WEIGHTS.diversity +
    disciplineScore  * WEIGHTS.discipline +
    activityScore    * WEIGHTS.activity;

  return {
    score: Math.round(score * 10) / 10,
    components: {
      booksCount: Math.round(booksCountScore),
      consistency: Math.round(consistencyScore),
      diversity: Math.round(diversityScore),
      discipline: Math.round(disciplineScore),
      activity: Math.round(activityScore),
      // C5: kreditlangan (distinct) birliklar — booksCount bilan auditable mos.
      totalLibrary: libDistinct,
      totalScan: scanDistinct,
      totalStore: storeDistinct,
      totalMutolaa: mutolaaDistinct,
      totalEbook: ebookDistinct,
      // Backward-compat aggregate: barcha kutubxona-bo'lmagan manbalar yig'indisi
      // (endi kreditlangan birliklarda).
      totalIsbn: scanDistinct + storeDistinct + mutolaaDistinct + ebookDistinct
    }
  };
}
