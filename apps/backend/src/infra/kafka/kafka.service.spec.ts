import { ConfigService } from "@nestjs/config";
import { KAFKA_TOPICS, KafkaTopic, KafkaService } from "./kafka.service";

// ── M17 — kafkajs producer mock (lazy reconnect testlari uchun) ─────────────
const mockProducerConnect = jest.fn();
const mockProducerSend = jest.fn();
const mockProducerDisconnect = jest.fn();
const mockProducerFactory = jest.fn(() => ({
  connect: mockProducerConnect,
  send: mockProducerSend,
  disconnect: mockProducerDisconnect,
}));

jest.mock("kafkajs", () => ({
  Kafka: jest.fn().mockImplementation(() => ({ producer: mockProducerFactory })),
  CompressionTypes: { GZIP: 2 },
}));

/**
 * Plan 05-01 Task 3 — KAFKA_TOPICS constant surface.
 * Constants-only spec (no broker): verifies Phase 5 topics ship + existing
 * topics didn't shift (regression guard).
 *
 * AUDIT FIX H7 — production fail-closed boot assert: KAFKA_BROKERS unset +
 * NODE_ENV=production → onModuleInit throws; dev keeps the graceful no-op.
 */

describe("KAFKA_TOPICS (Plan 05-01 Phase 5 extension)", () => {
  it("preserves existing Phase 1..4 topics (regression guard)", () => {
    expect(KAFKA_TOPICS.USER_REGISTERED).toBe("user.registered");
    expect(KAFKA_TOPICS.BOOK_BORROWED).toBe("book.borrowed");
    expect(KAFKA_TOPICS.BOOK_RETURNED).toBe("book.returned");
    expect(KAFKA_TOPICS.FRAUD_DETECTED).toBe("fraud.detected");
    expect(KAFKA_TOPICS.RI_UPDATED).toBe("ri.updated");
    expect(KAFKA_TOPICS.BADGE_EARNED).toBe("badge.earned");
    expect(KAFKA_TOPICS.TOP100_CONFIRMED).toBe("top100.confirmed");
    expect(KAFKA_TOPICS.PAYMENT_COMPLETED).toBe("payment.completed");
    expect(KAFKA_TOPICS.SUBSCRIPTION_ACTIVATED).toBe("subscription.activated");
    expect(KAFKA_TOPICS.SUBSCRIPTION_FROZEN).toBe("subscription.frozen");
  });

  it("adds RI_RISING (ALERT-05) — positive RI signal", () => {
    expect(KAFKA_TOPICS.RI_RISING).toBe("ri.rising");
  });

  it("adds SYSTEM_DOWN (ALERT-06) — health probe broadcast", () => {
    expect(KAFKA_TOPICS.SYSTEM_DOWN).toBe("system.down");
  });

  it("adds ALERT_FIRED (cross-cutting alert lifecycle)", () => {
    expect(KAFKA_TOPICS.ALERT_FIRED).toBe("alert.fired");
  });

  it("adds ALERT_ACKNOWLEDGED — closes the alert loop", () => {
    expect(KAFKA_TOPICS.ALERT_ACKNOWLEDGED).toBe("alert.acknowledged");
  });

  it("KafkaTopic union widens to cover the new entries (compile-time smoke)", () => {
    const a: KafkaTopic = KAFKA_TOPICS.RI_RISING;
    const b: KafkaTopic = KAFKA_TOPICS.ALERT_FIRED;
    expect([a, b]).toEqual(["ri.rising", "alert.fired"]);
  });
});

// ── AUDIT FIX H7 — production boot assert ──────────────────────────────────

const makeConfig = (brokers?: string) =>
  ({
    get: jest.fn((key: string) => (key === "KAFKA_BROKERS" ? brokers : undefined)),
  }) as unknown as ConfigService;

describe("KafkaService.onModuleInit boot assert (AUDIT FIX H7)", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("production + KAFKA_BROKERS unset → THROWS (fail-closed boot)", async () => {
    process.env.NODE_ENV = "production";
    const service = new KafkaService(makeConfig(undefined));
    await expect(service.onModuleInit()).rejects.toThrow(/KAFKA_BROKERS/);
  });

  it("dev/test + KAFKA_BROKERS unset → graceful no-op (o'chirilgan rejim)", async () => {
    process.env.NODE_ENV = "test";
    const service = new KafkaService(makeConfig(undefined));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.isConnected()).toBe(false);
  });

  it("NODE_ENV='Production' (katta harf) ham fail-closed", async () => {
    process.env.NODE_ENV = "Production";
    const service = new KafkaService(makeConfig(undefined));
    await expect(service.onModuleInit()).rejects.toThrow(/production da majburiy/);
  });
});

// ── M17 — emit-paytida lazy reconnect (cooldown bilan) ─────────────────────
//
// Avvalgi xulq: boot'da bitta connect urinishi; xato → ABADIY silent degraded.
// Yangi xulq: emit() ulanmagan holatda qayta urinadi, urinishlar orasida
// ≥30s cooldown (thundering retry yo'q), parallel emit'lar bitta in-flight
// connect'ni bo'lishadi.

describe("KafkaService M17 — lazy reconnect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("boot ulanish xatosi → keyingi emit() lazy reconnect qiladi va eventni yuboradi", async () => {
    mockProducerConnect.mockRejectedValueOnce(new Error("broker down"));
    const service = new KafkaService(makeConfig("localhost:9092"));
    await service.onModuleInit();
    expect(service.isConnected()).toBe(false);

    mockProducerConnect.mockResolvedValueOnce(undefined);
    mockProducerSend.mockResolvedValueOnce(undefined);
    await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: { userId: "u1" } });

    expect(service.isConnected()).toBe(true);
    expect(mockProducerConnect).toHaveBeenCalledTimes(2); // boot + lazy
    expect(mockProducerSend).toHaveBeenCalledTimes(1);    // event YO'QOLMADI
  });

  it("cooldown ichida ikkinchi emit qayta URINMAYDI (thundering retry yo'q)", async () => {
    mockProducerConnect.mockRejectedValue(new Error("broker down"));
    const service = new KafkaService(makeConfig("localhost:9092"));
    await service.onModuleInit(); // connect #1 (boot)

    await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} }); // connect #2 (lazy)
    await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} }); // cooldown ichida — skip

    expect(mockProducerConnect).toHaveBeenCalledTimes(2);
    expect(mockProducerSend).not.toHaveBeenCalled();
    expect(service.isConnected()).toBe(false);
  });

  it("cooldown (30s) o'tgach keyingi emit yana urinadi va ulanadi", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      mockProducerConnect.mockRejectedValue(new Error("broker down"));
      const service = new KafkaService(makeConfig("localhost:9092"));
      await service.onModuleInit();                                      // connect #1
      await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} }); // connect #2 (fail)
      await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} }); // skip (cooldown)
      expect(mockProducerConnect).toHaveBeenCalledTimes(2);

      // 30s o'tdi — broker tiklandi
      nowSpy.mockReturnValue(1_000_000 + KafkaService.RECONNECT_COOLDOWN_MS);
      mockProducerConnect.mockResolvedValue(undefined);
      mockProducerSend.mockResolvedValue(undefined);
      await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} }); // connect #3 (OK) + send

      expect(mockProducerConnect).toHaveBeenCalledTimes(3);
      expect(service.isConnected()).toBe(true);
      expect(mockProducerSend).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("KAFKA_BROKERS yo'q (dev no-op) — emit'da hech qanday reconnect urinish yo'q", async () => {
    const service = new KafkaService(makeConfig(undefined));
    await service.onModuleInit();

    await service.emit({ topic: KAFKA_TOPICS.RI_UPDATED, value: {} });

    expect(mockProducerFactory).not.toHaveBeenCalled();
    expect(mockProducerConnect).not.toHaveBeenCalled();
    expect(service.isConnected()).toBe(false);
  });
});
