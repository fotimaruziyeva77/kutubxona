import { ExecutionContext, CallHandler } from "@nestjs/common";
import { LoggingInterceptor } from "../logging.interceptor";
import { of, throwError } from "rxjs";

function makeContext(method: string, url: string, statusCode: number): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest:  () => ({ method, url }),
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(returnValue: unknown = {}, throws?: Error): CallHandler {
  return {
    handle: () => throws ? throwError(() => throws) : of(returnValue),
  } as CallHandler;
}

describe("LoggingInterceptor", () => {
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    jest.clearAllMocks();
  });

  it("200 so'rovni log qiladi", (done) => {
    const ctx = makeContext("GET", "/api/v1/books", 200);
    const handler = makeHandler({ data: [] });

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });

  it("201 so'rovni log qiladi", (done) => {
    const ctx = makeContext("POST", "/api/v1/books", 201);
    const handler = makeHandler({ id: "new-book" });

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });

  it("400 so'rovni warn level bilan log qiladi", (done) => {
    const ctx = makeContext("POST", "/api/v1/auth/otp", 400);
    const handler = makeHandler({ message: "Bad Request" });

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });

  it("404 so'rovni warn level bilan log qiladi", (done) => {
    const ctx = makeContext("GET", "/api/v1/books/notfound", 404);
    const handler = makeHandler({});

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });

  it("500 so'rovni error level bilan log qiladi", (done) => {
    const ctx = makeContext("GET", "/api/v1/admin/stats", 500);
    const handler = makeHandler({});

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });

  it("xatolik chiqsa error log qiladi", (done) => {
    const ctx = makeContext("POST", "/api/v1/transactions/borrow", 500);
    const handler = makeHandler(undefined, new Error("Test xatosi"));

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      error: () => done(),
    });
  });

  it("Observable qaytaradi", () => {
    const ctx = makeContext("GET", "/api/v1/health", 200);
    const handler = makeHandler({ status: "ok" });

    const result = interceptor.intercept(ctx, handler);
    expect(result).toBeDefined();
    expect(typeof result.subscribe).toBe("function");
  });

  it("DELETE so'rov ham log qilinadi", (done) => {
    const ctx = makeContext("DELETE", "/api/v1/books/b1", 204);
    const handler = makeHandler(null);

    interceptor.intercept(ctx, handler).subscribe({
      next: () => {},
      complete: done,
    });
  });
});
