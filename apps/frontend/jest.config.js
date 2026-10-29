/**
 * Jest konfiguratsiyasi — `next/jest` orqali.
 *
 * NEGA BU FAYL BOR:
 * Ilgari loyihada `babel.config.js` turardi va uning izohida "Next.js buni
 * ishlatmaydi, faqat Jest uchun" deb yozilgan edi. Bu NOTO'G'RI: Next.js
 * loyiha ildizidagi babel konfigini AVTOMATIK aniqlaydi va SWC kompilyatorini
 * o'chirib, Babel'ga o'tadi. Oqibati:
 *   1. `next/font` umuman ishlamasdi ("requires SWC" xatosi) — shuning uchun
 *      mahsulotda maxsus shrift yo'q edi va har OSda boshqacha ko'rinardi;
 *   2. build sekinlashardi (SWC Babel'dan bir necha barobar tez).
 *
 * `next/jest` to'g'ri yechim: u Jest'ni Next'ning O'Z SWC transformeriga
 * ulaydi — babel kerak emas, CSS/rasm import'lari va `@/` alias'lari
 * avtomatik hal qilinadi.
 */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Next konfigi va .env fayllarini yuklash uchun ilova ildizi.
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  testPathIgnorePatterns: ["<rootDir>/.next/", "<rootDir>/node_modules/"],
};

module.exports = createJestConfig(customJestConfig);
