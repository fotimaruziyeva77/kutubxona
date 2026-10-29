import { ConfigService } from "@nestjs/config";
import { CacheService } from "./cache.service";

/**
 * Stubbed ioredis client — emulates INCR + EXPIRE semantics for a fixed-window
 * counter without a live Redis connection. ioredis-mock is intentionally NOT
 * used (no new npm dependency); a hand-written stub gives us exact assertions
 * over how many times EXPIRE is invoked.
 */
class RedisStub {
  private store = new Map<string, number>();
  private ttls = new Map<string, number>();
  private stringStore = new Map<string, string>();
  public incrCalls = 0;
  public expireCalls = 0;
  public setCalls: Array<{ key: string; value: string; mode: string; ttl: number; nx: string }> = [];
  public getCalls: string[] = [];
  // Plan 05-02-fix FIX C — delPattern moved off blocking KEYS to cursor
  // SCAN. Tests need to simulate scanStream returning keys in multiple
  // batches (multi-batch behavior was the whole point of moving off KEYS).
  public delCalls: string[][] = [];
  public scanBatches: string[][] = [];

  async incr(key: string): Promise<number> {
    this.incrCalls++;
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.expireCalls++;
    this.ttls.set(key, ttlSeconds);
    return 1;
  }

  getTtl(key: string): number | undefined {
    return this.ttls.get(key);
  }

  // Mimics ioredis 5-arg signature: set(key, value, "EX", ttl, "NX")
  async set(
    key: string,
    value: string,
    mode: string,
    ttl: number,
    nx: string,
  ): Promise<"OK" | null> {
    this.setCalls.push({ key, value, mode, ttl, nx });
    if (nx === "NX" && this.stringStore.has(key)) return null;
    this.stringStore.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.stringStore.get(key) ?? null;
  }

  // M18 — CacheService.set() setex ishlatadi; remember() testlari uchun kerak.
  public setexCalls: Array<{ key: string; ttl: number; value: string }> = [];
  async setex(key: string, ttl: number, value: string): Promise<"OK"> {
    this.setexCalls.push({ key, ttl, value });
    this.stringStore.set(key, value);
    this.ttls.set(key, ttl);
    return "OK";
  }

  // Test-only: kalitni to'g'ridan-to'g'ri joylash (boshqa instans yozgani kabi).
  seedString(key: string, value: string): void {
    this.stringStore.set(key, value);
  }

  // ioredis scanStream stub. Emits the pre-staged batches one by one via the
  // event-emitter interface. Pause/resume are honored so the production code
  // path (pause → del → resume) exercises real backpressure semantics.
  scanStream(_opts: { match: string; count: number }): {
    on: (ev: string, cb: (...args: unknown[]) => void) => void;
    pause: () => void;
    resume: () => void;
  } {
    const batches = this.scanBatches;
    let paused = false;
    let i = 0;
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {
      data: [],
      end: [],
      error: [],
    };

    const tick = (): void => {
      if (paused) return;
      if (i >= batches.length) {
        for (const h of handlers.end) h();
        return;
      }
      const batch = batches[i++];
      for (const h of handlers.data) h(batch);
      // Schedule next batch on the next microtask so pause() can take effect
      // during the inline DEL call.
      void Promise.resolve().then(tick);
    };

    return {
      on: (ev, cb) => {
        if (handlers[ev]) handlers[ev].push(cb);
        if (ev === "end") {
          // Kick off the stream after listeners are attached.
          void Promise.resolve().then(tick);
        }
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        void Promise.resolve().then(tick);
      },
    };
  }

  async del(...keys: string[]): Promise<number> {
    this.delCalls.push(keys);
    for (const k of keys) {
      this.store.delete(k);
      this.stringStore.delete(k);
    }
    return keys.length;
  }
}

const makeService = (stub: RedisStub): CacheService => {
  const config = { get: jest.fn().mockReturnValue("redis://localhost:6379") };
  const service = new CacheService(config as unknown as ConfigService);
  // Inject the stub in place of the real ioredis client (private field).
  (service as unknown as { client: RedisStub }).client = stub;
  return service;
};

describe("CacheService.incrWithTtl", () => {
  let stub: RedisStub;
  let service: CacheService;

  beforeEach(() => {
    stub = new RedisStub();
    service = makeService(stub);
  });

  it("returns 1 on the first call for a fresh key and sets the TTL on that first hit", async () => {
    const n = await service.incrWithTtl("otp:rl:+998901234567", 3600);

    expect(n).toBe(1);
    expect(stub.expireCalls).toBe(1);
    expect(stub.getTtl("otp:rl:+998901234567")).toBe(3600);
  });

  it("returns an incrementing count on subsequent calls and does NOT reset the TTL", async () => {
    const key = "otp:rl:+998901234567";

    const first = await service.incrWithTtl(key, 3600);
    const second = await service.incrWithTtl(key, 3600);
    const third = await service.incrWithTtl(key, 3600);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
    // EXPIRE must be set only once (first hit) — fixed-window, not sliding.
    expect(stub.expireCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 04-01 PAY-01/02: setNx + getRaw — atomic webhook idempotency primitives.
// ─────────────────────────────────────────────────────────────────────────────

describe("CacheService.setNx", () => {
  let stub: RedisStub;
  let service: CacheService;

  beforeEach(() => {
    stub = new RedisStub();
    service = makeService(stub);
  });

  it("first call returns true and invokes ioredis set with EX/NX args", async () => {
    const ok = await service.setNx("webhook:payme:tx-1", "trace-A", 60);
    expect(ok).toBe(true);
    expect(stub.setCalls).toHaveLength(1);
    expect(stub.setCalls[0]).toEqual({
      key: "webhook:payme:tx-1",
      value: "trace-A",
      mode: "EX",
      ttl: 60,
      nx: "NX",
    });
  });

  it("second call on the same key returns false (duplicate)", async () => {
    await service.setNx("webhook:payme:tx-1", "trace-A", 60);
    const second = await service.setNx("webhook:payme:tx-1", "trace-B", 60);
    expect(second).toBe(false);
  });
});

describe("CacheService.getRaw", () => {
  let stub: RedisStub;
  let service: CacheService;

  beforeEach(() => {
    stub = new RedisStub();
    service = makeService(stub);
  });

  it("returns the raw string written by setNx without JSON parsing", async () => {
    await service.setNx("k1", "raw-string-value", 60);
    const value = await service.getRaw("k1");
    expect(value).toBe("raw-string-value");
  });

  it("returns null for missing keys", async () => {
    const value = await service.getRaw("missing-key");
    expect(value).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 05-02-fix FIX C — delPattern moved off blocking KEYS to cursor-paged
// SCAN. Verifies multi-batch deletion and that KEYS is NEVER invoked.
// ─────────────────────────────────────────────────────────────────────────────

describe("CacheService.delPattern (SCAN-based)", () => {
  let stub: RedisStub;
  let service: CacheService;

  beforeEach(() => {
    stub = new RedisStub();
    service = makeService(stub);
  });

  it("walks multiple SCAN batches and DELs each chunk", async () => {
    stub.scanBatches = [
      ["stats:viloyat:a", "stats:viloyat:b"],
      ["stats:viloyat:c"],
      ["stats:viloyat:d", "stats:viloyat:e", "stats:viloyat:f"],
    ];

    await service.delPattern("stats:*");

    // Each SCAN batch produced exactly one DEL call.
    expect(stub.delCalls).toHaveLength(3);
    expect(stub.delCalls[0]).toEqual(["stats:viloyat:a", "stats:viloyat:b"]);
    expect(stub.delCalls[1]).toEqual(["stats:viloyat:c"]);
    expect(stub.delCalls[2]).toEqual([
      "stats:viloyat:d",
      "stats:viloyat:e",
      "stats:viloyat:f",
    ]);
  });

  it("does not call the blocking KEYS command", async () => {
    // The legacy implementation used client.keys(pattern). If anyone reverts,
    // this test fails because RedisStub does NOT expose a keys() method —
    // and the new SCAN path completes happily on empty input.
    expect(
      (stub as unknown as { keys?: unknown }).keys,
    ).toBeUndefined();

    stub.scanBatches = [];
    await expect(service.delPattern("stats:*")).resolves.toBeUndefined();
  });

  it("empty pattern (no batches) completes without invoking DEL", async () => {
    stub.scanBatches = [];
    await service.delPattern("nothing:*");
    expect(stub.delCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M18 (2026-06-10) — remember() single-flight stampede himoyasi.
//   * hit → fn chaqirilmaydi (eski xulq);
//   * miss + lock WINNER → fn bir marta, set, lock del;
//   * miss + lock HELD → polling, winner natijasi qaytadi; winner kech qolsa
//     availability uchun o'zi hisoblaydi;
//   * Redis DOWN → polling YO'Q, legacy fallthrough bilan AYNAN bir xil.
// ─────────────────────────────────────────────────────────────────────────────

describe("CacheService.remember (M18 single-flight)", () => {
  let stub: RedisStub;
  let service: CacheService;

  beforeEach(() => {
    stub = new RedisStub();
    service = makeService(stub);
  });

  it("cache hit — fn chaqirilmaydi, lock olinmaydi (eski xulq)", async () => {
    stub.seedString("stats:national", JSON.stringify({ v: 1 }));
    const fn = jest.fn();

    const out = await service.remember("stats:national", 300, fn as () => Promise<unknown>);

    expect(out).toEqual({ v: 1 });
    expect(fn).not.toHaveBeenCalled();
    expect(stub.setCalls).toHaveLength(0); // lock SET..NX umuman yo'q
  });

  it("miss — lock winner fn() ni BIR marta hisoblaydi, set qiladi, lockni o'chiradi", async () => {
    const fn = jest.fn().mockResolvedValue({ fresh: true });

    const out = await service.remember("stats:national", 300, fn);

    expect(out).toEqual({ fresh: true });
    expect(fn).toHaveBeenCalledTimes(1);
    // Lock SET key "EX" 15 "NX" bilan olingan
    expect(stub.setCalls).toHaveLength(1);
    expect(stub.setCalls[0]).toMatchObject({
      key: "lock:remember:stats:national",
      mode: "EX",
      ttl: CacheService.REMEMBER_LOCK_TTL_SECONDS,
      nx: "NX",
    });
    // Qiymat odatdagidek setex orqali yozilgan (TTL caller'niki)
    expect(stub.setexCalls[0]).toMatchObject({ key: "stats:national", ttl: 300 });
    // Lock finally blokida o'chirilgan
    expect(stub.delCalls.flat()).toContain("lock:remember:stats:national");
  });

  it("lock band — loser polling bilan winner natijasini oladi (fn CHAQIRILMAYDI)", async () => {
    // Boshqa instans lock'ni ushlab turibdi
    stub.seedString("lock:remember:stats:national", "1");
    const fn = jest.fn();

    const pending = service.remember("stats:national", 300, fn as () => Promise<unknown>);
    // Boshlang'ich miss + lock HELD bosqichi o'tib bo'lishini kutamiz,
    // KEYIN winner natijani yozadi — qiymat birinchi poll'da topiladi.
    await new Promise((r) => setTimeout(r, 10));
    stub.seedString("stats:national", JSON.stringify({ fromWinner: true }));

    const out = await pending;
    expect(out).toEqual({ fromWinner: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("winner kech qolsa — polldan keyin loser O'ZI hisoblaydi (availability)", async () => {
    stub.seedString("lock:remember:k1", "1"); // lock band, qiymat hech qachon kelmaydi
    const fn = jest.fn().mockResolvedValue("computed-by-loser");

    const out = await service.remember("k1", 60, fn);

    expect(out).toBe("computed-by-loser");
    expect(fn).toHaveBeenCalledTimes(1);
    // Loser ham natijani keshga yozadi
    expect(stub.setexCalls[0]).toMatchObject({ key: "k1" });
    // Loser BOSHQANING lock'ini o'chirmaydi
    expect(stub.delCalls.flat()).not.toContain("lock:remember:k1");
  }, 10_000);

  it("Redis down — polling YO'Q, fn darhol hisoblanadi (legacy xulq bilan bir xil)", async () => {
    const downClient = {
      get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      setex: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      del: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
    const config = { get: jest.fn().mockReturnValue("redis://localhost:6379") };
    const downService = new CacheService(config as unknown as ConfigService);
    (downService as unknown as { client: typeof downClient }).client = downClient;

    const fn = jest.fn().mockResolvedValue(42);
    const out = await downService.remember("k-down", 60, fn);

    expect(out).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    // get faqat BIR marta (boshlang'ich miss) — polling loop ishlamagan,
    // ya'ni Redis-down fallthrough legacy bilan aynan bir xil va kechikishsiz.
    expect(downClient.get).toHaveBeenCalledTimes(1);
  });

  it("winner fn() xato bersa — lock baribir o'chiriladi, xato yuqoriga chiqadi", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("compute fail"));

    await expect(service.remember("k-err", 60, fn)).rejects.toThrow("compute fail");
    expect(stub.delCalls.flat()).toContain("lock:remember:k-err");
    // Xato bo'lgani uchun qiymat yozilmagan
    expect(stub.setexCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 05-01 Task 3 — Phase 5 cache-key + TTL surface.
// STAT-03..06 + LAND-01 + ALERT-01..06 key shapes; regression-guard the
// existing keys so Phase 5 doesn't accidentally break consumers.
// ─────────────────────────────────────────────────────────────────────────────

describe("CacheService.keys (Plan 05-01 Phase 5 extension)", () => {
  it("preserves existing keys (regression guard)", () => {
    expect(CacheService.keys.nationalStats()).toBe("stats:national");
    expect(CacheService.keys.viloyatStats("nav")).toBe("stats:viloyat:nav");
    expect(CacheService.keys.allViloyatStats()).toBe("stats:viloyat:all");
    expect(CacheService.keys.tumanStats("karmana")).toBe("stats:tuman:karmana");
    expect(CacheService.keys.genreStats()).toBe("stats:genres:all");
    expect(CacheService.keys.genreStats("nav")).toBe("stats:genres:nav");
    expect(CacheService.keys.shortage()).toBe("stats:shortage");
    expect(CacheService.keys.smartAlerts()).toBe("admin:alerts");
  });

  it("mahallaStats (STAT-03 per Q3) — mahalla-level dashboard cache", () => {
    expect(CacheService.keys.mahallaStats("yangiobod")).toBe(
      "stats:mahalla:yangiobod",
    );
  });

  it("landingPublic (LAND-01) — home page aggregator", () => {
    expect(CacheService.keys.landingPublic()).toBe("landing:public");
  });

  it("genreTrend (STAT-06) — scope-qualified genre trend slice", () => {
    expect(CacheService.keys.genreTrend("viloyat", "nav")).toBe(
      "stats:genres:trend:viloyat:nav",
    );
  });

  it("ageBreakdown (STAT-05) — scope-qualified age slice", () => {
    expect(CacheService.keys.ageBreakdown("tuman", "karmana")).toBe(
      "stats:age:tuman:karmana",
    );
  });

  it("genderBreakdown (STAT-04) — scope-qualified gender slice", () => {
    expect(CacheService.keys.genderBreakdown("national", "all")).toBe(
      "stats:gender:national:all",
    );
  });

  it("alertDedupe (ALERT-01..06 per Q3) — day-bucketed dedup key", () => {
    expect(
      CacheService.keys.alertDedupe("LIBRARY_INACTIVE", "lib-1", "2026-06-07"),
    ).toBe("alert:dedupe:LIBRARY_INACTIVE:lib-1:2026-06-07");
  });
});

describe("CacheService.ttl (Plan 05-01 Phase 5 extension)", () => {
  it("preserves existing TTLs (regression guard)", () => {
    expect(CacheService.ttl.stats).toBe(5 * 60);
    expect(CacheService.ttl.top100).toBe(60 * 60);
    expect(CacheService.ttl.alerts).toBe(2 * 60);
  });

  it("exports stats5min/15min/30min hybrid pre-agg tiers (OQ-3 / D-1)", () => {
    expect(CacheService.ttl.stats5min).toBe(300);
    expect(CacheService.ttl.stats15min).toBe(900);
    expect(CacheService.ttl.stats30min).toBe(1800);
  });

  it("landingPublic = 30s — high-traffic surface, near-live feel", () => {
    expect(CacheService.ttl.landingPublic).toBe(30);
  });
});
