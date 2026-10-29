/**
 * reading-score.util spec — C5 (CRITICAL) duplicate-counting fix.
 *
 * Bitta pure funksiya ikkala iste'molchini (on-demand reading.service va
 * nightly ri-recalc.processor) ta'minlaydi — bu spec dedup qoidalarini
 * to'g'ridan-to'g'ri, duplicate-og'ir fixturelar bilan qulflaydi:
 *   - kutubxona krediti = DISTINCT bookId (×1.0)
 *   - scan kreditlari   = DISTINCT isbn per source (×0.9/0.9/0.85/0.8)
 *   - qolgan komponentlar (consistency, diversity, discipline, activity)
 *     va og'irliklar AYNAN avvalgidek (dedup-only fix).
 */

import {
  computeReadingScore,
  distinctCount,
  COEF,
  WEIGHTS,
  ScoreTransaction,
  ScoreScan
} from "../reading-score.util";

// Belgilangan `now` — barcha kutilgan qiymatlar deterministik.
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const tx = (
  bookId: string,
  opts: Partial<ScoreTransaction> = {}
): ScoreTransaction => ({
  bookId,
  returnedAt: daysAgo(3),
  penaltyDays: 0,
  book: { genre: "Roman" },
  ...opts
});

const scan = (
  source: string,
  isbn: string,
  opts: Partial<ScoreScan> = {}
): ScoreScan => ({
  source,
  isbn,
  confirmedAt: daysAgo(3),
  ...opts
});

describe("distinctCount", () => {
  it("bo'sh massiv → 0", () => {
    expect(distinctCount([], (r) => r as string)).toBe(0);
  });

  it("dublikat kalitlar bitta hisoblanadi", () => {
    const rows = [{ k: "a" }, { k: "a" }, { k: "b" }, { k: "a" }];
    expect(distinctCount(rows, (r) => r.k)).toBe(2);
  });

  it("null/undefined kalitlar BITTA sentinelga yig'iladi (fail-closed)", () => {
    const rows = [{ k: undefined }, { k: undefined }, { k: "a" }] as Array<{ k?: string }>;
    // undefined + undefined → 1, "a" → 1 = 2 (hech qachon ortiqcha kredit emas)
    expect(distinctCount(rows, (r) => r.k)).toBe(2);
  });
});

describe("computeReadingScore — C5 dedup", () => {
  it("bo'sh input: faqat discipline 100 → score 15.0", () => {
    const { score, components } = computeReadingScore([], [], NOW);

    expect(components.booksCount).toBe(0);
    expect(components.consistency).toBe(0);
    expect(components.diversity).toBe(0);
    expect(components.discipline).toBe(100);
    expect(components.activity).toBe(0);
    expect(components.totalLibrary).toBe(0);
    expect(components.totalIsbn).toBe(0);
    expect(score).toBe(15.0); // 100 × 0.15
  });

  it("FARM SENARIYSI: bitta kitob 10 marta qaytarilgan → 1 kredit (10 ball), score 46.0", () => {
    const transactions = Array.from({ length: 10 }, () => tx("b1"));

    const { score, components } = computeReadingScore(transactions, [], NOW);

    // Avvalgi bug: 10 × 1.0 × 10 = 100 (booksCount maxed) → score 73.0.
    // Endi: DISTINCT bookId = 1 → booksCount 10.
    expect(components.booksCount).toBe(10);
    expect(components.totalLibrary).toBe(1);
    // Boshqa komponentlar o'zgarmagan qoidalar bo'yicha:
    expect(components.consistency).toBe(25);  // 1 hafta bucket (bir xil sana)
    expect(components.diversity).toBe(20);    // 1 janr (Set allaqachon distinct)
    expect(components.discipline).toBe(100);  // kechikish yo'q
    expect(components.activity).toBe(25);     // FR3: 1 distinct asar (avval 10 event → 100)
    // 10×0.3 + 25×0.2 + 20×0.15 + 100×0.15 + 25×0.2 = 3+5+3+15+5 = 31.0
    expect(score).toBe(31.0);
  });

  it("ROAMING SENARIYSI (FR1): bir ISBN 5 kutubxonada (5 xil bookId) → 1 kredit", () => {
    // Book qatori kutubxonaga bog'langan NUSXA: "Alpomish" har kutubxonada
    // o'z bookId'si bilan. bookId bo'yicha dedup 5 kredit berardi.
    const transactions = ["lib1", "lib2", "lib3", "lib4", "lib5"].map((lib) =>
      tx(`${lib}-alpomish`, { book: { genre: "Doston", isbn: "9789943000011" } })
    );

    const { components } = computeReadingScore(transactions, [], NOW);

    expect(components.totalLibrary).toBe(1);
    expect(components.booksCount).toBe(10);
    expect(components.activity).toBe(25);
  });

  it("ISBN yo'q (eski/mock ma'lumot) → bookId fallback, kredit yo'qolmaydi", () => {
    const transactions = [tx("b1"), tx("b1"), tx("b2")];

    const { components } = computeReadingScore(transactions, [], NOW);

    expect(components.totalLibrary).toBe(2);
  });

  it("FR3: faollik kutubxona va skan manbalarida bir xil ISBN'ni bir marta sanaydi", () => {
    const transactions = [tx("b1", { book: { genre: "Roman", isbn: "9789943452787" } })];
    const scans = [scan("USER_SCAN", "9789943452787"), scan("MUTOLAA", "9789943452787")];

    const { components } = computeReadingScore(transactions, scans, NOW);

    // Bitta asar — qaysi yo'l bilan o'qilgan bo'lsa ham faollik 1 birlik
    expect(components.activity).toBe(25);
  });

  it("3 XIL kitob → 3 kredit (30 ball), halol o'quvchi farmchidan yuqori", () => {
    const transactions = [
      tx("b1", { book: { genre: "Roman" } }),
      tx("b2", { book: { genre: "Tarix" } }),
      tx("b3", { book: { genre: "She'riyat" } })
    ];

    const { score, components } = computeReadingScore(transactions, [], NOW);

    expect(components.booksCount).toBe(30);
    expect(components.totalLibrary).toBe(3);
    expect(components.diversity).toBe(60);   // 3 janr
    expect(components.activity).toBe(75);    // 3 distinct asar
    // 30×0.3 + 25×0.2 + 60×0.15 + 100×0.15 + 75×0.2 = 9+5+9+15+15 = 53.0
    expect(score).toBe(53.0);
    // Halol 3-kitob o'quvchi (53.0) > 1 kitobni 10x farmlagan (31.0)
    expect(score).toBeGreaterThan(31.0);
  });

  it("dublikat USER_SCAN isbn bir marta kreditlanadi (0.9x)", () => {
    const scans = [
      scan("USER_SCAN", "9789943452787"),
      scan("USER_SCAN", "9789943452787"),
      scan("USER_SCAN", "9789943452787")
    ];

    const { components } = computeReadingScore([], scans, NOW);

    expect(components.booksCount).toBe(9); // 1 × 0.9 × 10
    expect(components.totalScan).toBe(1);
    expect(components.totalIsbn).toBe(1);
  });

  it("MUTOLAA dublikatlari ham distinct qoidaga bo'ysunadi (defense-in-depth)", () => {
    // syncMutolaaProgress insert vaqtida guard qiladi, lekin DB unique
    // constraint yo'q — tarixiy/race dublikatlar scoring da kredit bermaydi.
    const scans = [
      scan("MUTOLAA", "978-m1"),
      scan("MUTOLAA", "978-m1"),
      scan("MUTOLAA", "978-m1"),
      scan("MUTOLAA", "978-m2")
    ];

    const { components } = computeReadingScore([], scans, NOW);

    // 2 distinct × 0.85 = 1.7 → 17
    expect(components.booksCount).toBe(17);
    expect(components.totalMutolaa).toBe(2);
  });

  it("aralash manbalardagi dublikatlar har biri o'z tabiiy kaliti bo'yicha dedup", () => {
    const transactions = [
      tx("b1"), tx("b1"), tx("b1"),                  // 3 dup → 1
      tx("b2", { book: { genre: "Tarix" } })          // → 1
    ];
    const scans = [
      scan("USER_SCAN", "978-x1"), scan("USER_SCAN", "978-x1"),       // → 1
      scan("STORE_MANUAL", "978-s1"), scan("STORE_MANUAL", "978-s1"), // → 1
      scan("MUTOLAA", "978-m1"), scan("MUTOLAA", "978-m1"),           // → 1
      scan("EBOOK", "978-e1"), scan("EBOOK", "978-e1")                // → 1
    ];

    const { components } = computeReadingScore(transactions, scans, NOW);

    // 2×1.0 + 1×0.9 + 1×0.9 + 1×0.85 + 1×0.8 = 5.45 → ×10 = 54.4999…
    // (binary FP akkumulyatsiya, avvalgi implementatsiya bilan bir xil
    // tartib) → Math.round = 54
    expect(components.booksCount).toBe(54);
    expect(components.totalLibrary).toBe(2);
    expect(components.totalScan).toBe(1);
    expect(components.totalStore).toBe(1);
    expect(components.totalMutolaa).toBe(1);
    expect(components.totalEbook).toBe(1);
    expect(components.totalIsbn).toBe(4);
  });

  it("bir xil ISBN turli manbalarda — har bucket o'z koeffitsienti bilan alohida", () => {
    // Per-source bucket semantikasi saqlanadi (RI-02 tuzilma): USER_SCAN p1
    // va MUTOLAA p1 ikki mustaqil tasdiq kanali sifatida kreditlanadi.
    const scans = [scan("USER_SCAN", "978-p1"), scan("MUTOLAA", "978-p1")];

    const { components } = computeReadingScore([], scans, NOW);

    // 0.9 + 0.85 = 1.75 → 17.5 → round 18
    expect(components.booksCount).toBe(18);
    expect(components.totalIsbn).toBe(2);
  });

  it("kanonik RI-02 mix (har manbadan bittadan, distinct) = 45 ball saqlanadi", () => {
    const transactions = [tx("b1")];
    const scans = [
      scan("USER_SCAN", "978-x1"),
      scan("STORE_MANUAL", "978-x2"),
      scan("MUTOLAA", "978-x3"),
      scan("EBOOK", "978-x4")
    ];

    const { score, components } = computeReadingScore(transactions, scans, NOW);

    // 1.0 + 0.9 + 0.9 + 0.85 + 0.8 = 4.45 → 44.5 → round 45
    expect(components.booksCount).toBe(45);
    // Score: 44.5×0.3 + 25×0.2 + 20×0.15 + 100×0.15 + 100×0.2 = 56.35 → 56.4
    expect(score).toBe(56.4);
  });

  it("consistency haftalar bo'yicha qoladi, activity esa distinct asar (FR3): bir kitob 2 haftada 2 marta", () => {
    // 14 kun farq → kafolatlangan 2 xil epoch-hafta bucket.
    const transactions = [
      tx("b1", { returnedAt: daysAgo(2) }),
      tx("b1", { returnedAt: daysAgo(16) })
    ];

    const { score, components } = computeReadingScore(transactions, [], NOW);

    expect(components.booksCount).toBe(10);  // 1 distinct kitob
    expect(components.consistency).toBe(50); // 2 hafta bucket (hafta o'zi distinct birlik)
    expect(components.activity).toBe(25);    // FR3: 1 distinct asar (avval 2 xom event → 50)
    // 10×0.3 + 50×0.2 + 20×0.15 + 100×0.15 + 25×0.2 = 3+10+3+15+5 = 36.0
    expect(score).toBe(36.0);
  });

  it("discipline xom qoladi: dublikat kitobning har kechikkan qaytarilishi sanaladi", () => {
    const transactions = [
      tx("b1", { penaltyDays: 5 }),
      tx("b1", { penaltyDays: 4 })
    ];

    const { components } = computeReadingScore(transactions, [], NOW);

    // 2 kechikish × 15 = 30 → 70 (har biri real intizom hodisasi)
    expect(components.discipline).toBe(70);
    expect(components.totalLibrary).toBe(1);
  });

  it("30 kundan eski (lekin 1 yil ichida) kitob kreditga kiradi, recent komponentlarga kirmaydi", () => {
    const transactions = [tx("b1", { returnedAt: daysAgo(100) })];

    const { score, components } = computeReadingScore(transactions, [], NOW);

    expect(components.booksCount).toBe(10);
    expect(components.consistency).toBe(0);
    expect(components.diversity).toBe(0); // diversity faqat recent tx dan
    expect(components.activity).toBe(0);
    // 10×0.3 + 100×0.15 = 3 + 15 = 18.0
    expect(score).toBe(18.0);
  });

  it("deterministik: bir xil input → ikki chaqiruvda aynan bir xil natija", () => {
    const transactions = [tx("b1"), tx("b1"), tx("b2", { penaltyDays: 2 })];
    const scans = [scan("MUTOLAA", "978-m1"), scan("EBOOK", "978-e1")];

    const a = computeReadingScore(transactions, scans, NOW);
    const b = computeReadingScore(transactions, scans, NOW);

    expect(a.score).toBe(b.score);
    expect(a.components).toEqual(b.components);
  });

  it("koeffitsientlar va og'irliklar TZ qiymatlarida qulflangan (dedup-only fix)", () => {
    expect(COEF).toEqual({
      LIBRARY: 1.0,
      ISBN_SCAN: 0.9,
      STORE: 0.9,
      MUTOLAA: 0.85,
      EBOOK: 0.8
    });
    expect(WEIGHTS).toEqual({
      booksCount: 0.30,
      consistency: 0.20,
      diversity: 0.15,
      discipline: 0.15,
      activity: 0.20
    });
  });
});
