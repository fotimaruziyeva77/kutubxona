/**
 * Demo kitob katalogi — 95 ta unikal sarlavha.
 *
 * NEGA ALOHIDA FAYL: seed.ts allaqachon 1200+ qator. Katalog — sof
 * ma'lumot (mantiq yo'q), shuning uchun uni ajratish seed mantiqini
 * o'qishni osonlashtiradi va katalogni kengaytirish uchun seed'ga
 * tegish shart bo'lmaydi.
 *
 * `shelves` — kitob qaysi demo kutubxonalarda turishi. Bitta sarlavha bir
 * nechta kutubxonada bo'lishi MUMKIN va bu to'g'ri: milliy tarmoqda
 * "O'tkan kunlar" ham tuman, ham maktab kutubxonasida bo'ladi. Har bir
 * (kutubxona, sarlavha) juftligi alohida `Book` qatori bo'ladi — sxemada
 * nusxa (BookCopy) modeli yo'q, inventar `totalCount`/`availableCount`
 * hisoblagichlari bilan yuritiladi.
 *
 * Taqsimot mantiqi:
 *   GOV — tuman kutubxonasi: eng keng fond (milliy + jahon + zamonaviy)
 *   SCH — maktab: dastur adabiyoti, bolalar, jahon klassikasi
 *   UNI — OTM: jahon klassikasi, ilmiy-ommabop, biznes
 *   ORG — idora: kasbiy rivojlanish, biznes, boshqaruv
 *   MAH — mahalla: ommabop badiiy adabiyot, bolalar
 */

export type ShelfCode = "GOV" | "SCH" | "UNI" | "ORG" | "MAH";

export interface DemoBook {
  title: string;
  author: string;
  genre: string;
  /** Kitob tili — o'zbek nashri "uz-Latn", asl chet tilidagilari "en"/"ru". */
  lang: string;
  pages: number;
  year: number;
  shelves: ShelfCode[];
}

export const DEMO_BOOKS: DemoBook[] = [
  // ── O'zbek va mumtoz adabiyot ───────────────────────────────────────────
  { title: "O'tkan kunlar", author: "Abdulla Qodiriy", genre: "Roman", lang: "uz-Latn", pages: 384, year: 2019, shelves: ["GOV", "SCH", "MAH"] },
  { title: "Mehrobdan chayon", author: "Abdulla Qodiriy", genre: "Roman", lang: "uz-Latn", pages: 288, year: 2021, shelves: ["GOV", "SCH"] },
  { title: "Kecha va kunduz", author: "Cho'lpon", genre: "Roman", lang: "uz-Latn", pages: 320, year: 2018, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Yulduzli tunlar", author: "Pirimqul Qodirov", genre: "Tarixiy roman", lang: "uz-Latn", pages: 448, year: 2020, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Sarob", author: "Abdulla Qahhor", genre: "Roman", lang: "uz-Latn", pages: 240, year: 2020, shelves: ["GOV", "SCH"] },
  { title: "Sinchalak", author: "Said Ahmad", genre: "Qissa", lang: "uz-Latn", pages: 176, year: 2019, shelves: ["GOV", "MAH"] },
  { title: "Ufq", author: "Said Ahmad", genre: "Roman", lang: "uz-Latn", pages: 512, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Shum bola", author: "G'afur G'ulom", genre: "Bolalar adabiyoti", lang: "uz-Latn", pages: 160, year: 2022, shelves: ["SCH", "MAH"] },
  { title: "Navoiy", author: "Oybek", genre: "Tarixiy roman", lang: "uz-Latn", pages: 560, year: 2018, shelves: ["GOV", "UNI"] },
  { title: "Qutlug' qon", author: "Oybek", genre: "Roman", lang: "uz-Latn", pages: 424, year: 2018, shelves: ["GOV", "SCH"] },
  { title: "Ikki eshik orasi", author: "O'tkir Hoshimov", genre: "Roman", lang: "uz-Latn", pages: 400, year: 2017, shelves: ["GOV", "SCH", "MAH"] },
  { title: "Dunyoning ishlari", author: "O'tkir Hoshimov", genre: "Qissa", lang: "uz-Latn", pages: 208, year: 2020, shelves: ["GOV", "MAH"] },
  { title: "Daftar hoshiyasidagi bitiklar", author: "O'tkir Hoshimov", genre: "Esse", lang: "uz-Latn", pages: 192, year: 2021, shelves: ["GOV", "ORG"] },
  { title: "Bahor qaytmaydi", author: "O'tkir Hoshimov", genre: "Qissa", lang: "uz-Latn", pages: 224, year: 2019, shelves: ["GOV", "MAH"] },
  { title: "Nur borki, soya bor", author: "O'tkir Hoshimov", genre: "Roman", lang: "uz-Latn", pages: 336, year: 2018, shelves: ["GOV"] },
  { title: "Boburnoma", author: "Zahiriddin Muhammad Bobur", genre: "Tarix", lang: "uz-Latn", pages: 480, year: 2016, shelves: ["GOV", "UNI", "ORG"] },
  { title: "Xamsa", author: "Alisher Navoiy", genre: "Doston", lang: "uz-Latn", pages: 640, year: 2020, shelves: ["GOV", "UNI"] },
  { title: "Mahbub ul-qulub", author: "Alisher Navoiy", genre: "Nasr", lang: "uz-Latn", pages: 176, year: 2021, shelves: ["GOV", "UNI"] },
  { title: "Hayrat ul-abror", author: "Alisher Navoiy", genre: "Doston", lang: "uz-Latn", pages: 288, year: 2020, shelves: ["GOV", "UNI"] },
  { title: "Farhod va Shirin", author: "Alisher Navoiy", genre: "Doston", lang: "uz-Latn", pages: 320, year: 2020, shelves: ["GOV", "SCH"] },
  { title: "Layli va Majnun", author: "Alisher Navoiy", genre: "Doston", lang: "uz-Latn", pages: 272, year: 2020, shelves: ["GOV", "SCH"] },
  { title: "Saddi Iskandariy", author: "Alisher Navoiy", genre: "Doston", lang: "uz-Latn", pages: 400, year: 2020, shelves: ["GOV", "UNI"] },

  // ── Jahon klassikasi ────────────────────────────────────────────────────
  { title: "Alkimyogar", author: "Paulo Coelho", genre: "Roman", lang: "uz-Latn", pages: 192, year: 2021, shelves: ["GOV", "SCH", "MAH"] },
  { title: "1984", author: "George Orwell", genre: "Distopiya", lang: "uz-Latn", pages: 328, year: 2020, shelves: ["GOV", "UNI", "MAH"] },
  { title: "Hayvonlar fermasi", author: "George Orwell", genre: "Satira", lang: "uz-Latn", pages: 144, year: 2020, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Kichkina shahzoda", author: "Antoine de Saint-Exupéry", genre: "Bolalar adabiyoti", lang: "uz-Latn", pages: 112, year: 2022, shelves: ["SCH", "MAH"] },
  { title: "Urush va tinchlik", author: "Lev Tolstoy", genre: "Roman", lang: "uz-Latn", pages: 1280, year: 2017, shelves: ["GOV", "UNI"] },
  { title: "Anna Karenina", author: "Lev Tolstoy", genre: "Roman", lang: "uz-Latn", pages: 864, year: 2018, shelves: ["GOV", "UNI"] },
  { title: "Jinoyat va jazo", author: "Fyodor Dostoyevskiy", genre: "Roman", lang: "uz-Latn", pages: 576, year: 2019, shelves: ["GOV", "UNI", "SCH"] },
  { title: "Aka-uka Karamazovlar", author: "Fyodor Dostoyevskiy", genre: "Roman", lang: "uz-Latn", pages: 928, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Telba", author: "Fyodor Dostoyevskiy", genre: "Roman", lang: "uz-Latn", pages: 656, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Qimorboz", author: "Fyodor Dostoyevskiy", genre: "Qissa", lang: "uz-Latn", pages: 176, year: 2020, shelves: ["GOV", "MAH"] },
  { title: "Don Kixot", author: "Miguel de Cervantes", genre: "Roman", lang: "uz-Latn", pages: 928, year: 2017, shelves: ["GOV", "UNI"] },
  { title: "Romeo va Juletta", author: "William Shakespeare", genre: "Drama", lang: "uz-Latn", pages: 160, year: 2021, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Hamlet", author: "William Shakespeare", genre: "Drama", lang: "uz-Latn", pages: 208, year: 2021, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Otello", author: "William Shakespeare", genre: "Drama", lang: "uz-Latn", pages: 176, year: 2021, shelves: ["GOV", "UNI"] },
  { title: "Makbet", author: "William Shakespeare", genre: "Drama", lang: "uz-Latn", pages: 160, year: 2021, shelves: ["GOV", "UNI"] },
  { title: "Graf Monte-Kristo", author: "Alexandre Dumas", genre: "Sarguzasht", lang: "uz-Latn", pages: 1104, year: 2018, shelves: ["GOV", "SCH", "MAH"] },
  { title: "Uch mushketyor", author: "Alexandre Dumas", genre: "Sarguzasht", lang: "uz-Latn", pages: 704, year: 2018, shelves: ["GOV", "SCH", "MAH"] },
  { title: "Robinzon Kruzo", author: "Daniel Defoe", genre: "Sarguzasht", lang: "uz-Latn", pages: 288, year: 2020, shelves: ["SCH", "MAH"] },
  { title: "Mobi Dik", author: "Herman Melville", genre: "Roman", lang: "uz-Latn", pages: 624, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Oqartish qushi", author: "Harper Lee", genre: "Roman", lang: "uz-Latn", pages: 336, year: 2020, shelves: ["GOV", "SCH", "UNI"] },
  { title: "Buyuk Getsbi", author: "F. Scott Fitzgerald", genre: "Roman", lang: "uz-Latn", pages: 208, year: 2020, shelves: ["GOV", "UNI"] },
  { title: "Javdarzordagi xaloskor", author: "J. D. Salinger", genre: "Roman", lang: "uz-Latn", pages: 256, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Yuz yil tanholik", author: "Gabriel García Márquez", genre: "Roman", lang: "uz-Latn", pages: 448, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Vabo", author: "Albert Camus", genre: "Roman", lang: "uz-Latn", pages: 320, year: 2020, shelves: ["GOV", "UNI"] },
  { title: "Begona", author: "Albert Camus", genre: "Roman", lang: "uz-Latn", pages: 144, year: 2020, shelves: ["GOV", "UNI"] },
  { title: "Jarayon", author: "Franz Kafka", genre: "Roman", lang: "uz-Latn", pages: 272, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Metamorfoza", author: "Franz Kafka", genre: "Qissa", lang: "uz-Latn", pages: 96, year: 2019, shelves: ["GOV", "UNI"] },
  { title: "Faust", author: "Johann Wolfgang von Goethe", genre: "Drama", lang: "uz-Latn", pages: 432, year: 2018, shelves: ["GOV", "UNI"] },

  // ── Shaxsiy rivojlanish va psixologiya ──────────────────────────────────
  { title: "Atomik odatlar", author: "James Clear", genre: "Shaxsiy rivojlanish", lang: "uz-Latn", pages: 320, year: 2022, shelves: ["ORG", "UNI", "MAH"] },
  { title: "48 Qonun", author: "Robert Greene", genre: "Psixologiya", lang: "uz-Latn", pages: 480, year: 2021, shelves: ["ORG", "UNI"] },
  { title: "Odam ma'noni izlaydi", author: "Viktor Frankl", genre: "Psixologiya", lang: "uz-Latn", pages: 208, year: 2021, shelves: ["ORG", "UNI", "MAH"] },
  { title: "Boy ota, kambag'al ota", author: "Robert Kiyosaki", genre: "Moliya", lang: "uz-Latn", pages: 336, year: 2022, shelves: ["ORG", "UNI", "MAH"] },
  { title: "Deep Work", author: "Cal Newport", genre: "Shaxsiy rivojlanish", lang: "en", pages: 304, year: 2016, shelves: ["ORG", "UNI"] },
  { title: "Ikigai", author: "Héctor García & Francesc Miralles", genre: "Shaxsiy rivojlanish", lang: "uz-Latn", pages: 208, year: 2022, shelves: ["ORG", "MAH"] },
  { title: "The Psychology of Money", author: "Morgan Housel", genre: "Moliya", lang: "en", pages: 256, year: 2020, shelves: ["ORG", "UNI"] },
  { title: "Think and Grow Rich", author: "Napoleon Hill", genre: "Shaxsiy rivojlanish", lang: "en", pages: 320, year: 2019, shelves: ["ORG", "MAH"] },
  { title: "The Subtle Art of Not Giving a F*ck", author: "Mark Manson", genre: "Shaxsiy rivojlanish", lang: "en", pages: 224, year: 2016, shelves: ["ORG", "UNI"] },
  { title: "Can't Hurt Me", author: "David Goggins", genre: "Biografiya", lang: "en", pages: 364, year: 2018, shelves: ["ORG", "UNI"] },
  { title: "The Mountain Is You", author: "Brianna Wiest", genre: "Psixologiya", lang: "en", pages: 240, year: 2020, shelves: ["ORG", "MAH"] },
  { title: "Richest Man in Babylon", author: "George S. Clason", genre: "Moliya", lang: "en", pages: 194, year: 2018, shelves: ["ORG", "MAH"] },
  { title: "Start With Why", author: "Simon Sinek", genre: "Biznes", lang: "en", pages: 256, year: 2011, shelves: ["ORG", "UNI"] },
  { title: "The 7 Habits of Highly Effective People", author: "Stephen Covey", genre: "Shaxsiy rivojlanish", lang: "en", pages: 432, year: 2020, shelves: ["ORG", "UNI"] },
  { title: "Eat That Frog", author: "Brian Tracy", genre: "Shaxsiy rivojlanish", lang: "en", pages: 144, year: 2017, shelves: ["ORG", "MAH"] },
  { title: "The Power of Now", author: "Eckhart Tolle", genre: "Falsafa", lang: "en", pages: 236, year: 2004, shelves: ["ORG", "UNI"] },
  { title: "The Four Agreements", author: "Don Miguel Ruiz", genre: "Falsafa", lang: "en", pages: 160, year: 2018, shelves: ["ORG", "MAH"] },
  { title: "Sapiens", author: "Yuval Noah Harari", genre: "Tarix", lang: "uz-Latn", pages: 512, year: 2021, shelves: ["GOV", "UNI", "ORG"] },
  { title: "Homo Deus", author: "Yuval Noah Harari", genre: "Tarix", lang: "uz-Latn", pages: 464, year: 2021, shelves: ["UNI", "ORG"] },

  // ── Zamonaviy badiiy adabiyot ───────────────────────────────────────────
  { title: "The Midnight Library", author: "Matt Haig", genre: "Roman", lang: "en", pages: 304, year: 2020, shelves: ["GOV", "MAH"] },
  { title: "The Silent Patient", author: "Alex Michaelides", genre: "Triller", lang: "en", pages: 336, year: 2019, shelves: ["GOV", "MAH"] },
  { title: "The Kite Runner", author: "Khaled Hosseini", genre: "Roman", lang: "en", pages: 400, year: 2013, shelves: ["GOV", "UNI"] },
  { title: "A Thousand Splendid Suns", author: "Khaled Hosseini", genre: "Roman", lang: "en", pages: 432, year: 2008, shelves: ["GOV", "UNI"] },
  { title: "Verity", author: "Colleen Hoover", genre: "Triller", lang: "en", pages: 336, year: 2018, shelves: ["MAH"] },
  { title: "It Ends With Us", author: "Colleen Hoover", genre: "Roman", lang: "en", pages: 384, year: 2016, shelves: ["MAH"] },
  { title: "The Seven Husbands of Evelyn Hugo", author: "Taylor Jenkins Reid", genre: "Roman", lang: "en", pages: 400, year: 2017, shelves: ["GOV", "MAH"] },
  { title: "Fourth Wing", author: "Rebecca Yarros", genre: "Fantastika", lang: "en", pages: 528, year: 2023, shelves: ["MAH"] },
  { title: "The Housemaid", author: "Freida McFadden", genre: "Triller", lang: "en", pages: 336, year: 2022, shelves: ["MAH"] },

  // ── Biznes, boshqaruv, biografiya ───────────────────────────────────────
  { title: "The Let Them Theory", author: "Mel Robbins", genre: "Shaxsiy rivojlanish", lang: "en", pages: 352, year: 2024, shelves: ["ORG"] },
  { title: "Dopamine Nation", author: "Anna Lembke", genre: "Psixologiya", lang: "en", pages: 304, year: 2021, shelves: ["ORG", "UNI"] },
  { title: "The Almanack of Naval Ravikant", author: "Eric Jorgenson", genre: "Biznes", lang: "en", pages: 244, year: 2020, shelves: ["ORG", "UNI"] },
  { title: "Essentialism", author: "Greg McKeown", genre: "Shaxsiy rivojlanish", lang: "en", pages: 272, year: 2014, shelves: ["ORG", "UNI"] },
  { title: "Never Split the Difference", author: "Chris Voss", genre: "Biznes", lang: "en", pages: 288, year: 2016, shelves: ["ORG", "UNI"] },
  { title: "Zero to One", author: "Peter Thiel", genre: "Biznes", lang: "en", pages: 224, year: 2014, shelves: ["ORG", "UNI"] },
  { title: "Hooked", author: "Nir Eyal", genre: "Biznes", lang: "en", pages: 256, year: 2014, shelves: ["ORG", "UNI"] },
  { title: "The Lean Startup", author: "Eric Ries", genre: "Biznes", lang: "en", pages: 336, year: 2011, shelves: ["ORG", "UNI"] },
  { title: "The Millionaire Fastlane", author: "MJ DeMarco", genre: "Moliya", lang: "en", pages: 336, year: 2011, shelves: ["ORG"] },
  { title: "Shoe Dog", author: "Phil Knight", genre: "Biografiya", lang: "en", pages: 400, year: 2016, shelves: ["ORG", "UNI"] },
  { title: "Elon Musk", author: "Walter Isaacson", genre: "Biografiya", lang: "en", pages: 688, year: 2023, shelves: ["ORG", "UNI"] },
  { title: "Steve Jobs", author: "Walter Isaacson", genre: "Biografiya", lang: "en", pages: 656, year: 2011, shelves: ["ORG", "UNI"] },
  { title: "The Diary of a CEO", author: "Steven Bartlett", genre: "Biznes", lang: "en", pages: 336, year: 2023, shelves: ["ORG"] },
  { title: "Thinking, Fast and Slow", author: "Daniel Kahneman", genre: "Psixologiya", lang: "en", pages: 512, year: 2011, shelves: ["ORG", "UNI"] },
  { title: "The Courage to Be Disliked", author: "Ichiro Kishimi & Fumitake Koga", genre: "Psixologiya", lang: "en", pages: 288, year: 2018, shelves: ["ORG", "UNI"] },
  { title: "Meditations", author: "Marcus Aurelius", genre: "Falsafa", lang: "en", pages: 256, year: 2006, shelves: ["ORG", "UNI"] },
  { title: "Atomic Habits Workbook", author: "James Clear", genre: "Shaxsiy rivojlanish", lang: "en", pages: 208, year: 2023, shelves: ["ORG"] },
];

/**
 * ISBN generatori. Mavjud seed `9789943000001..014` blokini band qilgan,
 * shuning uchun yangi katalog `9789943001000` dan boshlanadi — kesishuv yo'q.
 *
 * `books.service.ts` faqat FORMATNI tekshiradi (13 raqam, 978/979 bilan
 * boshlanadi) — nazorat raqami hisoblanmaydi, shuning uchun ketma-ket
 * generatsiya yaroqli.
 */
export const DEMO_ISBN_BASE = 9789943001000;

export function demoIsbn(index: number): string {
  return String(DEMO_ISBN_BASE + index);
}
