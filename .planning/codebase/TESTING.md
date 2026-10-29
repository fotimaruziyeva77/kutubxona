# Testing Patterns

**Analysis Date:** 2026-06-06

## Test Framework

**Runner:**
- Jest 30.x
- Config: `apps/backend/jest.config.ts`
- Preset: `ts-jest` (TypeScript transformation)
- Test environment: `node`

**Assertion Library:**
- Jest built-in (`expect`, `toBe`, `toEqual`, `toThrow`, `toHaveBeenCalledWith`, etc.)

**Run Commands:**
```bash
cd apps/backend
npm test                  # Run all tests
npm run test:cov          # Run with coverage
npm run typecheck         # TypeScript check (not jest)
```

## Test File Organization

**Location:**
- Tests are placed in `__tests__/` subdirectories adjacent to the code they test
- Common/shared infrastructure tests: `src/common/filters/__tests__/`, `src/common/interceptors/__tests__/`
- Module tests: `src/modules/[module]/__tests__/[module].service.spec.ts`

**Naming:**
- Pattern: `[name].spec.ts` (only `.spec.ts` files are picked up — `testRegex: ".*\\.spec\\.ts$"`)
- One spec file per service (no controller specs)

**Structure:**
```
src/
  common/
    filters/
      __tests__/all-exceptions.filter.spec.ts
      all-exceptions.filter.ts
    interceptors/
      __tests__/logging.interceptor.spec.ts
      logging.interceptor.ts
  modules/
    auth/
      __tests__/auth.service.spec.ts
      __tests__/iduz.service.spec.ts
      auth.service.ts
      auth.controller.ts
    ai/
      __tests__/ai.service.spec.ts
      __tests__/audit.service.spec.ts
      __tests__/fraud.service.spec.ts
      __tests__/nlq.service.spec.ts
      __tests__/predict.service.spec.ts
      __tests__/recommend.service.spec.ts
    [other modules with same pattern...]
  __mocks__/
    @nestjs/schedule.ts   # Manual mock for NestJS scheduler
```

## Test Structure

**Suite Organization:**
```typescript
describe("ServiceName", () => {
  let service: ServiceName;

  beforeEach(() => {
    service = new ServiceName(
      mockPrisma as unknown as PrismaService,
      mockDep2 as unknown as Dep2,
    );
    jest.clearAllMocks();
  });

  // ── methodName ──────────────────────────────────────────────────────────
  describe("methodName", () => {
    it("success case description", async () => { ... });
    it("error case — ExceptionType", async () => { ... });
  });
});
```

**Patterns:**
- `beforeEach`: Instantiate service directly (not via NestJS testing module), then `jest.clearAllMocks()`
- Section separators in `it` descriptions mirror source code style: `// ── methodName ────`
- Test descriptions in Uzbek language (matching the codebase locale)
- Happy path + all error paths explicitly tested per method

## Mocking

**Framework:** Jest built-in mocking (`jest.fn()`, `jest.clearAllMocks()`)

**Core pattern — manual mock objects at module level:**
```typescript
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn()
  },
  refreshToken: {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  }
};

const mockJwt = {
  sign: jest.fn().mockReturnValue("mock-token"),
  verify: jest.fn()
};
```

**Service instantiation — always direct constructor call:**
```typescript
// Factory function pattern (used for services with many deps):
const makeService = () =>
  new AuthService(
    mockPrisma as unknown as PrismaService,
    mockJwt as unknown as JwtService,
    mockConfig as unknown as ConfigService,
    mockSms as unknown as SmsService
  );

// Or inline in beforeEach for simpler services:
beforeEach(() => {
  service = new BooksService(
    mockPrisma as unknown as PrismaService,
    mockEs as unknown as ElasticsearchService
  );
  jest.clearAllMocks();
});
```

**Never use `@nestjs/testing` TestingModule** — all tests instantiate services directly with manual mocks.

**Prisma `$transaction` mocking — two forms:**
```typescript
// Array form (returns array directly):
mockPrisma.$transaction.mockResolvedValue([newTx, {}]);

// Callback form (passes mock prisma into the callback):
mockPrisma.$transaction.mockImplementation(async (fn) => {
  return fn(mockPrisma as unknown as typeof mockPrisma);
});

// Callback form with custom inner mocks:
mockPrisma.$transaction.mockImplementation(async (fn) => {
  return fn({
    ...mockPrisma,
    user: { ...mockPrisma.user, findUnique: jest.fn().mockResolvedValue({ trustScore: 80 }) },
  } as unknown as typeof mockPrisma);
});
```

**Cache mock — executes the callback immediately (pass-through):**
```typescript
const mockCache = {
  remember: jest.fn().mockImplementation((_key, _ttl, fn) => fn()),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
};
```

**What to Mock:**
- All external services (Prisma, Redis/CacheService, SmsService, ElasticsearchService, KafkaService)
- All cross-module service dependencies (BadgeService, InvoiceService, FraudService, etc.)
- Global fetch: `global.fetch = jest.fn()` for HTTP calls inside services

**What NOT to Mock:**
- The service under test itself
- Pure utility methods on the service (tested via calling the real method)
- NestJS exception classes — import real classes and use `expect(...).rejects.toThrow(NotFoundException)`

## Fixtures and Factories

**Test Data — inline constant objects at the top of each spec file:**
```typescript
const mockBook = {
  id: "b1",
  isbn: "9789943452787",
  title: "Alpomish",
  author: "Xalq dostoni",
  genre: "Epik",
  lang: "uz",
  pages: 320,
  year: 2020,
  coverUrl: null,
  totalCount: 5,
  availableCount: 5,
  libraryId: "lib1",
  library: { id: "lib1", name: "Karmana kutubxonasi" },
  createdAt: new Date(),
  updatedAt: new Date()
};

const activeUser = {
  id: "u1", type: "CITIZEN", status: "ACTIVE",
  trustScore: 80, name: "Ali",
  phone: "+998901234567", sifatId: "SL-01"
};
```

**Test Data — spread to override specific fields:**
```typescript
// Override one property for an error scenario:
{ ...activeUser, status: "BLOCKED" }
{ ...activeUser, trustScore: 25 }
{ ...availableBook, availableCount: 0 }
```

**Excel Buffer Factory (only in books.service.spec.ts):**
```typescript
const makeExcelBuffer = (rows: object[]) => {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};
```

**Location:** All fixtures are co-located in each spec file. No shared fixture files or factories.

## Coverage

**Requirements:** Lines coverage threshold: 80% (`coverageThreshold.global.lines: 80`)

**Excluded from coverage:**
- `**/*.module.ts` — NestJS module wiring
- `**/*.controller.ts` — Controllers are not unit tested
- `**/main.ts` — Bootstrap entry point
- `**/infra/**` — Infrastructure layer (Prisma, Redis, Kafka, SMS, Vault, etc.)
- `**/common/guards/**` — Guards not unit tested
- `**/common/decorators/**` — Decorators not unit tested
- `**/__tests__/**` — Test files themselves
- `**/dist/**` — Build artifacts
- `**/app.controller.ts` — Root controller

**View Coverage:**
```bash
cd apps/backend
npm run test:cov
# Output: src/coverage/lcov-report/index.html
```

## Test Types

**Unit Tests:**
- Scope: Service classes only. Each service has exactly one spec file.
- Approach: Direct instantiation with mocked dependencies. All external I/O (DB, cache, SMS, Kafka) mocked.
- Controllers, guards, decorators, and infrastructure are NOT unit tested.

**Integration Tests:**
- Not present in current codebase.

**E2E Tests:**
- Planned (Playwright mentioned in CI pipeline `ci.yml`) but not found in the source tree.
- E2E tests run on staging deploy: `develop → staging.sifat.uz → E2E tests`.

## Common Patterns

**Async Testing:**
```typescript
// Standard: async/await with rejects.toThrow for errors
it("OTP topilmasa BadRequestException", async () => {
  mockPrisma.otpCode.findUnique.mockResolvedValue(null);
  await expect(service.verifyOtp("+998901234567", "123456"))
    .rejects.toThrow(BadRequestException);
});

// Checking exact error message:
await expect(service.reserve("u1", "b1"))
  .rejects.toThrow("Bu kitob allaqachon bron qilingan");

// Observable testing (interceptor tests use done callback):
it("200 so'rovni log qiladi", (done) => {
  interceptor.intercept(ctx, handler).subscribe({
    next: () => {},
    complete: done,
  });
});
```

**Error Testing:**
```typescript
// Test each distinct error condition in its own it() block:
it("kitob topilmasa NotFoundException", async () => {
  mockPrisma.book.findUnique.mockResolvedValue(null);
  await expect(service.findOne("notfound")).rejects.toThrow(NotFoundException);
});

it("foydalanuvchi faol emas — ForbiddenException", async () => {
  mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, status: "BLOCKED" });
  await expect(service.borrow("u1", "b1")).rejects.toThrow(ForbiddenException);
});
```

**Verifying mock calls:**
```typescript
// Check args with expect.objectContaining for partial matching:
expect(mockPrisma.otpCode.upsert).toHaveBeenCalledWith(
  expect.objectContaining({ where: { phone: "+998901234567" } })
);

// Check a method was NOT called:
expect(mockPrisma.user.create).not.toHaveBeenCalled();
expect(mockJwt.sign).not.toHaveBeenCalled();

// Check call count via mock state:
mockPrisma.bookTransaction.count
  .mockResolvedValueOnce(0)  // First call: hasOverdueBooks
  .mockResolvedValueOnce(2); // Second call: activeBorrows
```

**NestJS Schedule mock** — `src/__mocks__/@nestjs/schedule.ts` replaces `@Cron` decorator with a no-op:
```typescript
// Registered in jest.config.ts:
moduleNameMapper: {
  "^@nestjs/schedule$": "<rootDir>/__mocks__/@nestjs/schedule.ts"
}
// This allows @Cron methods to be tested without the scheduler running.
```

---

*Testing analysis: 2026-06-06*
