import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      // Pre-existing @nestjs/elasticsearch type incompatibility: the installed
      // @types don't expose runtime methods (.index, .search, .delete, .bulk,
      // .indices). Disable ts-jest diagnostics so test suites can run; real
      // type errors are caught by `npx tsc --noEmit` in CI.
      diagnostics: false,
    }],
  },
  collectCoverageFrom: [
    "**/*.ts",
    "!**/*.module.ts",
    "!**/*.controller.ts",
    "!**/main.ts",
    "!**/infra/**",
    "!**/common/guards/**",
    "!**/common/decorators/**",
    "!**/__tests__/**",
    "!**/dist/**",
    "!**/app.controller.ts"
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
