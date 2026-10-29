# Coding Conventions

**Analysis Date:** 2026-06-06

## Naming Patterns

**Files:**
- Services: `[domain].service.ts` — e.g., `auth.service.ts`, `reading.service.ts`, `fraud.service.ts`
- Controllers: `[domain].controller.ts` — e.g., `auth.controller.ts`, `books.controller.ts`
- Modules: `[domain].module.ts` — e.g., `auth.module.ts`, `ai.module.ts`
- Tests: `[domain].service.spec.ts` placed in `__tests__/` subdirectory
- DTOs: defined inline in the same file as the controller or service that uses them (not in separate files)
- Infrastructure: `[name].service.ts` under `src/infra/[category]/`

**Functions/Methods:**
- camelCase for all methods: `findAll`, `findOne`, `createTrial`, `recalculateForUser`
- Private helpers use `_` prefix for internal utility functions: `_validatePassword`, `_assertEnvVars`
- Private helper methods without underscore prefix for domain logic: `normalizePhone`, `checkRateLimit`, `generateSifatId`
- Cron handler methods named as `autoExpireReservations`, `checkOverdueAlerts`, `recalculateAll`

**Variables/Constants:**
- SCREAMING_SNAKE_CASE for module-level constants: `OTP_TTL_MS`, `BORROW_DAYS`, `TRUST_SCORE_BONUS_THRESHOLD`, `COEF`, `WEIGHTS`
- camelCase for local variables and parameters
- Constant objects (records/maps) use SCREAMING_SNAKE_CASE key: `RISK_THRESHOLDS`, `CacheService.keys`, `CacheService.ttl`

**Classes:**
- PascalCase: `AuthService`, `BooksService`, `AllExceptionsFilter`, `LoggingInterceptor`
- DTOs: PascalCase with `Dto` suffix — `LoginDto`, `SendOtpDto`, `CompleteProfileDto`
- Interfaces with `Dto` suffix for service-layer input shapes: `CreateBookDto`, `UpdateBookDto`, `SearchBooksDto`

**Types/Interfaces:**
- PascalCase: `JwtPayload`, `AuthRequest`
- Interfaces preferred over type aliases for object shapes
- Prisma-generated enums imported directly: `UserGender`, `UserType`, `TransactionStatus`

## Code Style

**Formatting:**
- Tool: No Prettier config detected — formatting enforced via ESLint with `@typescript-eslint` rules
- Double quotes for strings throughout all files
- Trailing semicolons
- 2-space indentation
- Aligned multi-property assignments using spaces (aesthetic alignment): `const ctx  = ...`, `let status  = ...`

**Linting:**
- Config: `apps/backend/eslint.config.mjs`
- TypeScript ESLint recommended rules applied
- `@typescript-eslint/no-explicit-any`: `"warn"` (warning, not error — allows `as any` in filter bodies)
- `@typescript-eslint/no-unused-vars`: `"error"` with `argsIgnorePattern: "^_"` (unused args must be prefixed `_`)
- `@typescript-eslint/explicit-function-return-type`: `"off"` (return types inferred, not required)
- `@typescript-eslint/no-floating-promises`: `"error"` (all promises must be awaited or explicitly ignored)

**Floating promise handling:**
- Intentionally fire-and-forget calls use `.catch(() => {})` to satisfy the no-floating-promises rule:
  ```typescript
  this.badge.checkAfterReturn(tx.userId).catch(() => {});
  ```

## Import Organization

**Order (observed pattern):**
1. NestJS framework imports (`@nestjs/common`, `@nestjs/jwt`, etc.)
2. Third-party libraries (`bcrypt`, `xlsx`, `qrcode`, `ioredis`)
3. Internal infrastructure imports (`../../infra/prisma/prisma.service`)
4. Internal module imports (`../badge/badge.service`)
5. Prisma client types (`@prisma/client`)

**Path Aliases:**
- None detected — all imports use relative paths (`../../`, `../`)

**Import style:**
- Named imports only (no default imports from NestJS)
- `import * as bcrypt from "bcrypt"` for CommonJS-style modules
- `import * as XLSX from "xlsx"` for CommonJS modules

## Error Handling

**NestJS HTTP Exceptions — always throw built-in classes:**
```typescript
throw new NotFoundException("Foydalanuvchi topilmadi");
throw new BadRequestException("ISBN-13 format noto'g'ri");
throw new ForbiddenException("Ruxsat yo'q");
throw new UnauthorizedException("Token noto'g'ri yoki muddati o'tgan");
throw new ConflictException("Profil allaqachon to'ldirilgan");
```

**Global exception filter:** `src/common/filters/all-exceptions.filter.ts`
- Catches all exceptions globally
- Maps `Prisma.PrismaClientKnownRequestError` codes to HTTP status codes:
  - `P2002` → 409 Conflict ("Duplicate Entry")
  - `P2025` → 404 Not Found
  - `P2003` → 409 Conflict ("Foreign Key Violation")
- Maps `Prisma.PrismaClientValidationError` → 400 Bad Request
- All responses share a single format: `{ statusCode, message, error, timestamp, path }`

**Elasticsearch/Redis failures — silent fallback:**
```typescript
// ES down bo'lsa Prisma fallback
try {
  const esResult = await this.es.search(...);
  ...
} catch {
  return this.searchFallback(dto);
}

// ES indekslash muvaffaqiyatsiz bo'lsa log qilamiz, lekin xato chiqarmaymiz
try {
  await this.es.index(...);
} catch {
  // ignore
}
```

**Cache errors — always silent, never throw:**
```typescript
async get<T>(key: string): Promise<T | null> {
  try {
    ...
  } catch {
    return null; // Redis down bo'lsa DB ga o'tamiz
  }
}
```

**Prisma transactions — two forms:**
```typescript
// Array form (simple parallel ops):
await this.prisma.$transaction([
  this.prisma.bookTransaction.update(...),
  this.prisma.book.update(...)
]);

// Callback form (complex, sequential ops):
await this.prisma.$transaction(async (p) => {
  await p.bookTransaction.update(...);
  await p.book.update(...);
  await p.user.update(...);
});
```

## Logging

**Framework:** NestJS built-in `Logger` (from `@nestjs/common`)

**Pattern — each service instantiates its own logger:**
```typescript
private readonly logger = new Logger(AuthService.name);
```

**Log levels used:**
- `this.logger.log(...)` — informational (successful operations, counts)
- `this.logger.warn(...)` — recoverable errors (Prisma P2002/P2003, Redis errors)
- `this.logger.error(...)` — unexpected errors with stack trace (500-level)

**HTTP request logging:** `LoggingInterceptor` at `src/common/interceptors/logging.interceptor.ts`
- Format: `[METHOD] /path/to/endpoint  STATUS_CODE  Xms`
- Severity: 5xx → error, 4xx → warn, 2xx/3xx → log

**Messages in Uzbek language** throughout the codebase (consistent with project locale).

## Comments

**When to Comment:**
- Section separators using `// ── Section Name ────────` dashes pattern (very prevalent)
- Inline explanation for non-obvious logic or business rules
- Block comments `/** ... */` for JSDoc only on complex public interfaces (e.g., `AllExceptionsFilter`)
- Uzbek language used in comments and log messages throughout

**Comment style examples:**
```typescript
// ── Telefon normalize ────────────────────────────────────────────────
private normalizePhone(phone: string): string { ... }

// Barcha eski tokenlarni bekor qilish (xavfsizlik)
await this.prisma.refreshToken.updateMany(...)

// ES down bo'lsa Prisma fallback
```

**No JSDoc on service methods** — comments are inline or section separators.

## Function Design

**Size:** Services contain multiple methods, but individual methods stay focused (20–80 lines typical). The `TransactionsService` is the largest at 722 lines.

**Parameters:** Services receive dependencies via constructor injection. Methods take primitive types or DTO interfaces (not class instances from HTTP layer).

**Return Values:**
- Services return plain objects or Prisma model instances (not Response objects)
- Boolean results wrapped in objects: `return { returned: true, penaltyDays }`, `return { confirmed: true }`
- Message results: `return { message: "SMS yuborildi" }`

**Async/Await:** All database and external calls use `async/await`. No raw Promise chains.

## Module Design

**Exports:**
- Each module has a corresponding `*.module.ts` that declares providers and exports services
- Services are exported from modules for cross-module injection
- Infrastructure services (`PrismaService`, `CacheService`, `SmsService`) re-exported from `AppInfraModule`

**Barrel Files:**
- Used for guards: `src/common/guards/index.ts` exports `JwtAuthGuard` and `RolesGuard`
- Not used elsewhere — direct imports are preferred

**DTO Location:**
- Controller-layer DTOs (class-validator decorated classes) are co-located in the controller file
- Service-layer DTOs (TypeScript interfaces) are co-located in the service file

---

*Convention analysis: 2026-06-06*
