import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  // Default 5 s: to'liq suite parallel yurganda PDF/Excel generatsiya qiladigan
  // spec'lar (books-import, invoice) yolg'iz 16 s, yuklama ostida 200 s+ cho'zilib
  // timeout'ga tushardi (2026-10-29/30 — kod regressiyasi emas, flaky). 30 s —
  // haqiqiy osilib qolishni hali ham ushlaydi.
  testTimeout: 30_000,
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      // Pre-existing @nestjs/elasticsearch type incompatibility: the installed
      // @types don't expose runtime methods (.index, .search, .delete, .bulk,
      // .indices). Disable ts-jest diagnostics so test suites can run; real
      // type errors are caught by `npx tsc --noEmit` in CI.
      diagnostics: false,
    }],
  },
  // T6 (2026-10-31): controller'lar va guard'lar endi coverage'ga KIRADI —
  // RBAC (@Roles/@Public) va egalik tekshiruvlari (IDOR) aynan shu qatlamda,
  // ularni o'lchovdan chiqarib tashlash xavfsizlik testlarini ko'rinmas
  // qilardi. Chiqarib tashlanganlar: modul deklaratsiyalari, bootstrap,
  // infra adapterlari (tashqi servislar), dekoratorlar (metadata), mock/test.
  collectCoverageFrom: [
    "**/*.ts",
    "!**/*.module.ts",
    "!**/main.ts",
    "!**/infra/**",
    "!**/common/decorators/**",
    "!**/__tests__/**",
    "!**/__mocks__/**",
    "!**/dist/**"
  ],
  coverageThreshold: {
    global: {
      lines: 80
    }
  },
  moduleNameMapper: {
    "^@nestjs/schedule$": "<rootDir>/__mocks__/@nestjs/schedule.ts",
    // file-type is pure ESM (v19+); ts-jest cannot resolve it. Stub the
    // default export so unit tests can jest.mock("file-type", ...) freely.
    "^file-type$": "<rootDir>/__mocks__/file-type.ts"
  },
};

export default config;
