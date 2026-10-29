import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>("REDIS_URL") ?? "redis://localhost:6379";
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000)
    });

    this.client.on("connect", () => this.logger.log("Redis ulandi"));
    this.client.on("error", (err) => this.logger.warn(`Redis xatosi: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  // ── Asosiy operatsiyalar ──────────────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    try {
      const val = await this.client.get(key);
      if (!val) return null;
      return JSON.parse(val) as T;
    } catch {
      return null; // Redis down bo'lsa DB ga o'tamiz
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Yozish muvaffaqiyatsiz bo'lsa tizim ishlashda davom etsin
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // ignore
    }
  }

  // ── Atomik hisoblagich (rate limiting) ────────────────────────────────────
  // Fixed-window counter: INCR atomik, EXPIRE faqat birinchi urinishda (n===1)
  // o'rnatiladi — get/set ishlatilmaydi (race condition'dan saqlanish uchun).
  // Replicalar o'rtasida bo'linadi va server restart'dan keyin saqlanib qoladi.
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttlSeconds);
    return n;
  }

  // ── Atomic SETNX (payment idempotency) ────────────────────────────────────
  // Plan 04-01 PAY-01/02: single round-trip atomic acquire with TTL.
  // Returns true on first-write, false when the key already exists.
  // Redis xatosi bo'lsa safe-default false qaytaramiz (caller idempotency
  // pathini tashlamaydi — DB unique constraint baxsh-line bo'lib qoladi).
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, value, "EX", ttlSeconds, "NX");
      return result === "OK";
    } catch (err) {
      this.logger.warn(`setNx xatosi (${key}): ${(err as Error).message}`);
      return false;
    }
  }

  // ── Raw string read (idempotency cached responses) ────────────────────────
  // Plan 04-01 PAY-01/02: caller stores webhook responses as JSON strings.
  // get<T>() JSON.parse qiladi — RedisLockService o'z parse'ini qilishi
  // uchun raw qiymat kerak.
  async getRaw(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`getRaw xatosi (${key}): ${(err as Error).message}`);
      return null;
    }
  }

  // Plan 05-02-fix FIX C — SCAN-based pattern delete (replaces blocking KEYS).
  //
  // `KEYS pattern` is O(N) over the entire keyspace and blocks Redis for the
  // duration of the scan — at 5M+ keys (production target) it could stall the
  // event loop for hundreds of ms and trigger a slowlog spike. Redis docs
  // explicitly recommend against KEYS in production code.
  //
  // SCAN walks the keyspace in cursor-paged chunks (~100 keys per round-trip,
  // tunable via COUNT) and never blocks. ioredis exposes this as `scanStream`
  // which emits each chunk as a stream event. We delete chunks as they arrive
  // so memory stays bounded even when the pattern matches many keys.
  //
  // SCAN may return the same key twice across cursors (the contract is "no
  // missing keys, may yield duplicates"); DEL is idempotent so duplicates are
  // harmless. UNLINK would be non-blocking on the delete side too, but DEL
  // suffices for the small chunks SCAN produces.
  async delPattern(pattern: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = this.client.scanStream({ match: pattern, count: 100 });
        stream.on("data", (keys: string[]) => {
          if (keys.length === 0) return;
          // Pause the stream while we delete to bound the in-flight pipeline.
          stream.pause();
          this.client
            .del(...keys)
            .catch((err) => {
              this.logger.warn(
                `delPattern DEL batch xatosi (${pattern}): ${(err as Error).message}`,
              );
            })
            .finally(() => stream.resume());
        });
        stream.on("end", () => resolve());
        stream.on("error", (err) => reject(err));
      });
    } catch (err) {
      this.logger.warn(
        `delPattern xatosi (${pattern}): ${(err as Error).message}`,
      );
    }
  }

  // ── Cache-or-fetch pattern ────────────────────────────────────────────────
  //
  // M18 (2026-06-10) — single-flight stampede himoyasi. Avvalgi xulq: cache
  // miss'da HAR BIR parallel chaqiruv fn() ni o'zi hisoblardi (dogpile) —
  // 5 daqiqalik og'ir stats agregatlari TTL tugashida replikani urardi.
  //
  // Yangi oqim (signature O'ZGARMAGAN):
  //   1) get(key) hit → qaytadi (eski xulq).
  //   2) miss → setNx(`lock:remember:<key>`, 15s):
  //      * WINNER  → fn() hisoblaydi, set(), lock'ni o'chiradi;
  //      * HELD    → 5×200ms get() polling; topilsa qaytadi, topilmasa
  //                  availability > strictness — O'ZI hisoblab qaytadi;
  //      * Redis DOWN → lock bosqichi butunlay tashlanadi va eski xulq bilan
  //                  AYNAN bir xil: darhol fn() (polling kechikishisiz).
  static readonly REMEMBER_LOCK_TTL_SECONDS = 15;
  static readonly REMEMBER_POLL_ATTEMPTS = 5;
  static readonly REMEMBER_POLL_DELAY_MS = 200;

  async remember<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    // Lock holatini uch xil ajratamiz: setNx() public helper xato va "band"
    // holatlarini bitta `false` ga yig'adi — bu yerda Redis-down'ni alohida
    // bilishimiz shart (down → polling YO'Q, legacy fallthrough).
    const lockKey = `lock:remember:${key}`;
    let lockState: "WINNER" | "HELD" | "ERROR";
    try {
      const res = await this.client.set(
        lockKey, "1", "EX", CacheService.REMEMBER_LOCK_TTL_SECONDS, "NX",
      );
      lockState = res === "OK" ? "WINNER" : "HELD";
    } catch {
      lockState = "ERROR"; // Redis down — single-flight o'chiriladi
    }

    if (lockState === "HELD") {
      // Boshqa instans hisoblayapti — qisqa kutamiz (jami ~1s).
      for (let i = 0; i < CacheService.REMEMBER_POLL_ATTEMPTS; i++) {
        await this._sleep(CacheService.REMEMBER_POLL_DELAY_MS);
        const polled = await this.get<T>(key);
        if (polled !== null) return polled;
      }
      // Winner kech qoldi/o'ldi — availability uchun o'zimiz hisoblaymiz.
      const fresh = await fn();
      await this.set(key, fresh, ttlSeconds);
      return fresh;
    }

    try {
      const fresh = await fn();
      await this.set(key, fresh, ttlSeconds);
      return fresh;
    } finally {
      // ERROR holatda del() baribir no-throw (ichida catch bor).
      if (lockState === "WINNER") await this.del(lockKey);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Tayyor cache kalitlari ────────────────────────────────────────────────
  // Plan 05-01 Task 3 — Phase 5 extension:
  //   * mahallaStats (STAT-03 per Q3) — mahalla-level dashboard cache
  //   * landingPublic (LAND-01) — `/api/v1/landing/public` aggregator, short TTL
  //   * genreTrend / ageBreakdown / genderBreakdown (STAT-04..06) — scoped slices
  //   * alertDedupe (ALERT-01..06 per Q3) — day-bucketed dedup keys
  static keys = {
    nationalStats: () => "stats:national",
    viloyatStats: (id: string) => `stats:viloyat:${id}`,
    allViloyatStats: () => "stats:viloyat:all",
    tumanStats: (id: string) => `stats:tuman:${id}`,
    mahallaStats: (id: string) => `stats:mahalla:${id}`,
    top100: (month: string) => `top100:${month}`,
    genreStats: (viloyatId?: string) => `stats:genres:${viloyatId ?? "all"}`,
    genreTrend: (scope: string, scopeId: string) =>
      `stats:genres:trend:${scope}:${scopeId}`,
    ageBreakdown: (scope: string, scopeId: string) =>
      `stats:age:${scope}:${scopeId}`,
    genderBreakdown: (scope: string, scopeId: string) =>
      `stats:gender:${scope}:${scopeId}`,
    landingPublic: () => "landing:public",
    shortage: () => "stats:shortage",
    leaderboard: () => "reading:leaderboard",
    smartAlerts: () => "admin:alerts",
    alertDedupe: (alertType: string, scopeId: string, day: string) =>
      `alert:dedupe:${alertType}:${scopeId}:${day}`,
  } as const;

  // ── TTL konstantlari (soniyada) ───────────────────────────────────────────
  // Plan 05-01 Task 3 — hybrid pre-aggregation per OQ-3/D-1: 5min/15min/30min
  // tiers cover stats-stale tolerance per dashboard surface. landingPublic has
  // 30s TTL because the home page is the highest-traffic surface and should
  // feel "live" without thrashing the replica.
  static ttl = {
    stats: 5 * 60,            // 5 daqiqa (back-compat alias)
    stats5min: 5 * 60,
    stats15min: 15 * 60,
    stats30min: 30 * 60,
    landingPublic: 30,
    top100: 60 * 60,          // 1 soat
    leaderboard: 10 * 60,     // 10 daqiqa
    genres: 15 * 60,          // 15 daqiqa
    shortage: 10 * 60,        // 10 daqiqa
    alerts: 2 * 60,           // 2 daqiqa (real-timeга yaqin)
  } as const;
}
