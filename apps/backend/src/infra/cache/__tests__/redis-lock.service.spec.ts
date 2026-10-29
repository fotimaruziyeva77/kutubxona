import { CacheService } from "../cache.service";
import { RedisLockService } from "../redis-lock.service";

/**
 * Plan 04-01 PAY-01/02 — RedisLockService unit spec.
 *
 * Mocks CacheService at the public surface (setNx / getRaw / set) — the
 * ioredis client itself is stubbed in cache.service.spec.ts, so this spec
 * only validates the lock semantics on top of CacheService.
 */

function makeCacheMock(): jest.Mocked<Pick<CacheService, "setNx" | "getRaw" | "set">> {
  return {
    setNx: jest.fn(),
    getRaw: jest.fn(),
    set: jest.fn(),
  } as unknown as jest.Mocked<Pick<CacheService, "setNx" | "getRaw" | "set">>;
}

describe("RedisLockService.tryAcquire", () => {
  let cache: jest.Mocked<Pick<CacheService, "setNx" | "getRaw" | "set">>;
  let svc: RedisLockService;

  beforeEach(() => {
    cache = makeCacheMock();
    svc = new RedisLockService(cache as unknown as CacheService);
  });

  it("first call: setNx succeeds -> returns { first: true }", async () => {
    cache.setNx.mockResolvedValue(true);

    const result = await svc.tryAcquire("webhook:payme:tx-1:CreateTransaction", 86400, "trace-A");

    expect(result).toEqual({ first: true });
    expect(cache.setNx).toHaveBeenCalledWith(
      "webhook:payme:tx-1:CreateTransaction",
      "trace-A",
      86400,
    );
    expect(cache.getRaw).not.toHaveBeenCalled();
  });

  it("duplicate call: setNx fails and a cached response exists -> returns { first: false, cachedResponse }", async () => {
    cache.setNx.mockResolvedValue(false);
    cache.getRaw.mockResolvedValue(JSON.stringify({ result: { allow: true } }));

    const result = await svc.tryAcquire("webhook:payme:tx-1:CreateTransaction", 86400, "trace-B");

    expect(result).toEqual({ first: false, cachedResponse: { result: { allow: true } } });
    expect(cache.getRaw).toHaveBeenCalledWith("webhook:payme:tx-1:CreateTransaction:response");
  });

  it("duplicate call: no cached response -> returns { first: false, cachedResponse: undefined }", async () => {
    cache.setNx.mockResolvedValue(false);
    cache.getRaw.mockResolvedValue(null);

    const result = await svc.tryAcquire("webhook:payme:tx-2:CreateTransaction", 86400, "trace-C");

    expect(result).toEqual({ first: false, cachedResponse: undefined });
  });

  it("duplicate call: cached response is malformed JSON -> returns undefined and does not throw", async () => {
    cache.setNx.mockResolvedValue(false);
    cache.getRaw.mockResolvedValue("not-json-{}}");

    const result = await svc.tryAcquire("webhook:click:ct-1:0", 86400, "trace-D");

    expect(result).toEqual({ first: false, cachedResponse: undefined });
  });
});

describe("RedisLockService.storeResponse", () => {
  it("stores under the <key>:response namespace with the configured TTL", async () => {
    const cache = makeCacheMock();
    const svc = new RedisLockService(cache as unknown as CacheService);

    await svc.storeResponse(
      "webhook:payme:tx-1:CreateTransaction",
      { result: { allow: true } },
      86400,
    );

    expect(cache.set).toHaveBeenCalledWith(
      "webhook:payme:tx-1:CreateTransaction:response",
      { result: { allow: true } },
      86400,
    );
  });
});
