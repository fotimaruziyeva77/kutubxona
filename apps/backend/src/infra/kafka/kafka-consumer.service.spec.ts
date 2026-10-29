import { ConfigService } from "@nestjs/config";
import { KafkaConsumerService } from "./kafka-consumer.service";
import { StatsGateway } from "../gateway/stats.gateway";
import { KAFKA_TOPICS } from "./kafka.service";

/**
 * KafkaConsumerService spec (INFRA-08).
 *
 * Pins two contracts:
 *   1. A consumed message on an alert topic routes to the gateway's emit helper
 *      with the parsed payload.
 *   2. When KAFKA_BROKERS is unset, onModuleInit no-ops (no connection attempt,
 *      no throw) — so dev/test do not break when Kafka is absent.
 *
 * kafkajs is mocked: we capture the eachMessage handler passed to consumer.run
 * and invoke it directly with a fabricated message, asserting the gateway is hit.
 */

// ── kafkajs mock ───────────────────────────────────────────────────────────
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockSubscribe = jest.fn().mockResolvedValue(undefined);
const mockRun = jest.fn().mockResolvedValue(undefined);

const mockConsumer = {
  connect: mockConnect,
  disconnect: mockDisconnect,
  subscribe: mockSubscribe,
  run: mockRun
};

const mockConsumerFactory = jest.fn(() => mockConsumer);

jest.mock("kafkajs", () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: mockConsumerFactory
  }))
}));

// ── Helpers ────────────────────────────────────────────────────────────────
const makeConfig = (brokers?: string) =>
  ({
    get: jest.fn((key: string) => (key === "KAFKA_BROKERS" ? brokers : undefined))
  }) as unknown as ConfigService;

const makeGateway = () =>
  ({
    emitNewAlert: jest.fn(),
    emitBadgeEarned: jest.fn(),
    emitXpLevelUp: jest.fn(),
  }) as unknown as StatsGateway;

// Build a kafkajs-style message envelope (value is a Buffer of JSON).
const makeMessage = (payload: unknown) => ({
  topic: KAFKA_TOPICS.TUMAN_RI_DROPPED,
  partition: 0,
  message: {
    value: Buffer.from(JSON.stringify(payload)),
    key: null,
    timestamp: String(Date.now()),
    offset: "0"
  }
});

describe("KafkaConsumerService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("KAFKA_BROKERS o'rnatilmaganda", () => {
    it("onModuleInit ulanishga urinmaydi va throw qilmaydi (graceful no-op)", async () => {
      const service = new KafkaConsumerService(makeConfig(undefined), makeGateway());

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(mockConsumerFactory).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockSubscribe).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });

    // AUDIT FIX H7 — production fail-closed boot assert
    it("production da onModuleInit THROWS (fail-closed boot, H7)", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        const service = new KafkaConsumerService(makeConfig(undefined), makeGateway());
        await expect(service.onModuleInit()).rejects.toThrow(/KAFKA_BROKERS/);
        expect(mockConsumerFactory).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe("KAFKA_BROKERS o'rnatilganda", () => {
    it("consumer yaratiladi, mavjud topic'larga obuna bo'ladi va run() chaqiriladi", async () => {
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), makeGateway());

      await service.onModuleInit();

      expect(mockConsumerFactory).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalledTimes(1);

      // Mavjud producer topic'lariga obuna bo'lganini tekshiramiz.
      const subscribedTopics = mockSubscribe.mock.calls.map((c) => c[0]?.topic ?? c[0]?.topics);
      const flat = subscribedTopics.flat();
      expect(flat).toContain(KAFKA_TOPICS.TUMAN_RI_DROPPED);
      expect(flat).toContain(KAFKA_TOPICS.FRAUD_DETECTED);
    });

    it("kelgan xabar parse qilinib gateway.emitNewAlert ga yo'naltiriladi", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();

      // consumer.run ga berilgan eachMessage handler'ni qo'lga olamiz.
      const runArg = mockRun.mock.calls[0][0];
      expect(typeof runArg.eachMessage).toBe("function");

      const payload = { tumanId: "UZ-08-012", dropPercent: 15 };
      await runArg.eachMessage(makeMessage(payload));

      expect(gateway.emitNewAlert).toHaveBeenCalledTimes(1);
      const emitted = (gateway.emitNewAlert as jest.Mock).mock.calls[0][0];
      expect(emitted).toMatchObject({ tumanId: "UZ-08-012", dropPercent: 15 });
    });

    it("(Plan 03-04 GAME-02) BADGE_EARNED → gateway.emitBadgeEarned ga uzatiladi", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();
      const runArg = mockRun.mock.calls[0][0];

      const badgePayload = { userId: "u123", badgeCode: "FIRST_BOOK", awardedAt: "2026-06-06T00:00:00Z" };
      const badgeMessage = {
        topic: KAFKA_TOPICS.BADGE_EARNED,
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(badgePayload)),
          key: null,
          timestamp: String(Date.now()),
          offset: "0",
        },
      };

      await runArg.eachMessage(badgeMessage);

      expect(gateway.emitBadgeEarned).toHaveBeenCalledWith("u123", "FIRST_BOOK");
      // Important: badge events do NOT also go to emitNewAlert.
      expect(gateway.emitNewAlert).not.toHaveBeenCalled();
    });

    it("(Plan 03-04 GAME-02) BADGE_EARNED noto'g'ri payload (userId yo'q) → emit qilinmaydi", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();
      const runArg = mockRun.mock.calls[0][0];

      const badPayload = { foo: "bar" };
      await runArg.eachMessage({
        topic: KAFKA_TOPICS.BADGE_EARNED,
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(badPayload)),
          key: null,
          timestamp: String(Date.now()),
          offset: "0",
        },
      });

      expect(gateway.emitBadgeEarned).not.toHaveBeenCalled();
    });

    it("XP_LEVEL_UP → gateway.emitXpLevelUp ga uzatiladi (alert kanaliga EMAS)", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();
      const runArg = mockRun.mock.calls[0][0];

      await runArg.eachMessage({
        topic: KAFKA_TOPICS.XP_LEVEL_UP,
        partition: 0,
        message: {
          value: Buffer.from(
            JSON.stringify({ userId: "u123", level: 2, xp: 330, occurredAt: "2026-08-01T00:00:00Z" }),
          ),
          key: null,
          timestamp: String(Date.now()),
          offset: "0",
        },
      });

      expect(gateway.emitXpLevelUp).toHaveBeenCalledWith("u123", 2, 330);
      expect(gateway.emitNewAlert).not.toHaveBeenCalled();
    });

    it("XP_LEVEL_UP noto'g'ri payload (level yo'q) → emit qilinmaydi", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();
      const runArg = mockRun.mock.calls[0][0];

      await runArg.eachMessage({
        topic: KAFKA_TOPICS.XP_LEVEL_UP,
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify({ userId: "u123" })),
          key: null,
          timestamp: String(Date.now()),
          offset: "0",
        },
      });

      expect(gateway.emitXpLevelUp).not.toHaveBeenCalled();
      expect(gateway.emitNewAlert).not.toHaveBeenCalled();
    });

    it("buzilgan (noto'g'ri JSON) xabar consumer'ni yiqitmaydi (defensiv parse)", async () => {
      const gateway = makeGateway();
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), gateway);

      await service.onModuleInit();
      const runArg = mockRun.mock.calls[0][0];

      const badMessage = {
        topic: KAFKA_TOPICS.TUMAN_RI_DROPPED,
        partition: 0,
        message: { value: Buffer.from("{not-json"), key: null, offset: "1" }
      };

      await expect(runArg.eachMessage(badMessage)).resolves.toBeUndefined();
      expect(gateway.emitNewAlert).not.toHaveBeenCalled();
    });
  });

  describe("onModuleDestroy", () => {
    it("ulangan consumer'ni uzadi", async () => {
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), makeGateway());
      await service.onModuleInit();

      await service.onModuleDestroy();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it("consumer ulanmagan bo'lsa (brokers yo'q) destroy throw qilmaydi", async () => {
      const service = new KafkaConsumerService(makeConfig(undefined), makeGateway());
      await service.onModuleInit();

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(mockDisconnect).not.toHaveBeenCalled();
    });
  });

  // ── M17 — davriy retry timer (boot xatosidan keyin) ───────────────────────
  //
  // Avvalgi xulq: boot'da bitta connect; xato → ABADIY silent degraded.
  // Yangi xulq: har 60s qayta urinadi, ulanishi bilan timer to'xtaydi.

  describe("M17 — davriy retry timer", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("boot xatosi → 60s da qayta urinadi; ulanagach timer TO'XTAYDI", async () => {
      mockConnect.mockRejectedValueOnce(new Error("broker down"));
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), makeGateway());

      await service.onModuleInit();
      expect(service.isConnected()).toBe(false);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      // 60s — retry tick: bu safar broker tiklangan
      await jest.advanceTimersByTimeAsync(KafkaConsumerService.RETRY_INTERVAL_MS);
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(service.isConnected()).toBe(true);

      // Yana 2 daqiqa — ulanib bo'lgach QAYTA urinish yo'q (timer to'xtagan)
      await jest.advanceTimersByTimeAsync(2 * KafkaConsumerService.RETRY_INTERVAL_MS);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it("broker tushib turaversa — har 60s da yana urinadi (ulanmaguncha)", async () => {
      mockConnect.mockRejectedValue(new Error("broker down"));
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), makeGateway());

      await service.onModuleInit(); // urinish #1
      await jest.advanceTimersByTimeAsync(KafkaConsumerService.RETRY_INTERVAL_MS); // #2
      await jest.advanceTimersByTimeAsync(KafkaConsumerService.RETRY_INTERVAL_MS); // #3

      expect(mockConnect).toHaveBeenCalledTimes(3);
      expect(service.isConnected()).toBe(false);
    });

    it("onModuleDestroy retry timerni to'xtatadi (shutdown leak yo'q)", async () => {
      mockConnect.mockRejectedValue(new Error("broker down"));
      const service = new KafkaConsumerService(makeConfig("localhost:9092"), makeGateway());

      await service.onModuleInit();
      await service.onModuleDestroy();

      await jest.advanceTimersByTimeAsync(5 * KafkaConsumerService.RETRY_INTERVAL_MS);
      expect(mockConnect).toHaveBeenCalledTimes(1); // faqat boot urinishi
    });

    it("KAFKA_BROKERS yo'q (dev no-op) — retry timer umuman yaratilmaydi", async () => {
      const service = new KafkaConsumerService(makeConfig(undefined), makeGateway());
      await service.onModuleInit();

      await jest.advanceTimersByTimeAsync(5 * KafkaConsumerService.RETRY_INTERVAL_MS);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });
  });
});
