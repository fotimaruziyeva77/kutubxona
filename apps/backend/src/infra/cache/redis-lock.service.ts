import { Injectable, Logger } from "@nestjs/common";
import { CacheService } from "./cache.service";

/**
 * Plan 04-01 PAY-01/02 — Atomic SETNX-based webhook idempotency primitive.
 *
 * Consumed by both Payme JSON-RPC and Click HMAC webhook handlers (lands in
 * Plan 04-02). Two-layer idempotency strategy per 04-RESEARCH.md §Idempotency:
 *
 *   Layer 1: Redis SETNX (this service) — fast (1ms), atomic across replicas,
 *            replay-aware (caches the previously returned response so a
 *            duplicate webhook gets the same answer).
 *   Layer 2: Payment.transactionId DB unique constraint — backstop.
 *
 * Key shape (caller-supplied):
 *   Payme: webhook:payme:{params.id}:{method}
 *   Click: webhook:click:{click_trans_id}:{action}
 *
 * The cached response lives under `<key>:response`, JSON-stringified by
 * CacheService.set. Default TTL 24h covers the Payme 12h transaction lifetime
 * plus retransmit buffer.
 */
@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * Atomic acquire. Returns `{ first: true }` if the caller is first;
   * `{ first: false, cachedResponse }` if a previous call already acquired
   * within TTL — the cached response is the value the handler returned then,
   * so the duplicate caller receives byte-identical output.
   */
  async tryAcquire(
    key: string,
    ttlSeconds: number,
    traceId: string,
  ): Promise<{ first: boolean; cachedResponse?: unknown }> {
    const acquired = await this.cache.setNx(key, traceId, ttlSeconds);
    if (acquired) {
      return { first: true };
    }

    // Duplicate. Look up the previously stored response.
    const raw = await this.cache.getRaw(`${key}:response`);
    if (!raw) {
      // First call still in-flight, or response storage was skipped — return
      // undefined so the caller can decide to retry or surface a generic ack.
      return { first: false, cachedResponse: undefined };
    }
    try {
      return { first: false, cachedResponse: JSON.parse(raw) };
    } catch (err) {
      this.logger.warn(`Cached response parse error (${key}): ${(err as Error).message}`);
      return { first: false, cachedResponse: undefined };
    }
  }

  /**
   * Persist the handler's response so future duplicate calls replay it.
   * Uses CacheService.set which JSON-stringifies — matches the JSON.parse
   * in tryAcquire.
   */
  async storeResponse(
    key: string,
    response: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    await this.cache.set(`${key}:response`, response, ttlSeconds);
  }

  /**
   * Plan 04-02 audit-fix FIX C1 — release the lock without caching a
   * response, so a subsequent retry of the same {key} can re-run the
   * handler. Used by payment-webhook handlers when the handler returned a
   * transient error (e.g., -31001 DB blip) that must NOT be cached for 24h.
   */
  async release(key: string): Promise<void> {
    await this.cache.del(key);
  }
}
