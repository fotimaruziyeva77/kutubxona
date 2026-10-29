import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { StatsGateway } from "../gateway/stats.gateway";
import { KAFKA_TOPICS, KafkaTopic } from "./kafka.service";
import { isProductionEnv } from "../../common/utils/production-env.util";

/**
 * KafkaConsumerService (INFRA-08)
 *
 * The existing KafkaService is producer-only — events were flowing to dead
 * infrastructure (PITFALLS S4). This consumer closes the loop: it subscribes to
 * the alert topics the producer already emits and routes each event to the
 * WebSocket gateway so admin dashboards surface them in real time.
 *
 * Built on the ALREADY-INSTALLED kafkajs client (RESEARCH: do NOT add
 * @nestjs/microservices — v10-vs-v11 version footgun; the producer already uses
 * kafkajs so the consumer shares config).
 *
 * Graceful degradation (T-05-02): when KAFKA_BROKERS is unset the consumer
 * no-ops — backend boots fine without a live Kafka broker (dev/test). The Python
 * AI engine consumer is v2-deferred (STATE.md); this NestJS consumer satisfies
 * INFRA-08 for V1.0.
 */

// Alert topiklari — gateway'ning alert kanaliga yo'naltiriladi.
// Plan 03-04 GAME-02: BADGE_EARNED qo'shildi — alohida shaxsiy room ga emit qiladi.
const ALERT_TOPICS: KafkaTopic[] = [
  KAFKA_TOPICS.TUMAN_RI_DROPPED,
  KAFKA_TOPICS.FRAUD_DETECTED,
  KAFKA_TOPICS.LIBRARY_INACTIVE,
  KAFKA_TOPICS.BADGE_EARNED,
  // XP_LEVEL_UP ham BADGE_EARNED kabi shaxsiy room ga yo'naltiriladi
  // (alert emas) — pastdagi handleMessage da alohida route qilinadi.
  KAFKA_TOPICS.XP_LEVEL_UP,
];

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private kafka: Kafka | null = null;
  private consumer: Consumer | null = null;
  private connected = false;

  // M17 (2026-06-10) — boot'da ulanish muvaffaqiyatsiz bo'lsa consumer ENDI
  // abadiy degraded qolmaydi: davriy retry timer (har 60s) ulanguncha urinadi,
  // ulanishi bilan timer to'xtatiladi. Producer'dan farqi: consumer'da
  // "emit-paytida" trigger nuqtasi yo'q, shu sabab timer ishlatiladi.
  private retryTimer: NodeJS.Timeout | null = null;
  private retryInFlight = false;
  static readonly RETRY_INTERVAL_MS = 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly gateway: StatsGateway
  ) {}

  async onModuleInit() {
    const brokers = this.config.get<string>("KAFKA_BROKERS");
    if (!brokers) {
      // AUDIT FIX H7 — production fail-closed boot assert (KafkaService bilan
      // bir xil). Dev/test da graceful degradation (T-05-02) saqlanadi.
      if (isProductionEnv()) {
        throw new Error(
          "[FATAL] KAFKA_BROKERS production da majburiy — " +
            "Kafka consumer'siz prod boot taqiqlangan (fail-closed). " +
            ".env.prod faylini to'ldiring.",
        );
      }
      // Graceful degradation (T-05-02): Kafka yo'q bo'lsa no-op — backend baribir ishga tushadi.
      this.logger.warn(
        "KAFKA_BROKERS sozlanmagan — Kafka consumer o'chirilgan rejimda (no-op)"
      );
      return;
    }

    try {
      await this.connectAndRun(brokers);
    } catch (err) {
      // Broker tushib qolsa ham tizim ishlashda davom etsin (T-05-02) —
      // lekin M17: endi davriy retry rejalashtiriladi (silent-permanent emas).
      this.logger.warn(`Kafka consumer ulanishida xato (degraded mode): ${(err as Error).message}`);
      this.connected = false;
      this.scheduleRetry(brokers);
    }
  }

  // ── M17 yordamchilari ──────────────────────────────────────────────────────

  private async connectAndRun(brokers: string): Promise<void> {
    this.kafka = new Kafka({
      clientId: "sifat-library-consumer",
      brokers: brokers.split(",").map((b) => b.trim()),
      retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 3000 },
      connectionTimeout: 5000,
      requestTimeout: 10000
    });

    this.consumer = this.kafka.consumer({ groupId: "sifat-library-stats" });
    await this.consumer.connect();

    for (const topic of ALERT_TOPICS) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => this.handleMessage(payload)
    });

    this.connected = true;
    this.logger.log(`Kafka consumer ulandi: ${brokers} | topics: ${ALERT_TOPICS.join(", ")}`);
  }

  private scheduleRetry(brokers: string): void {
    if (this.retryTimer) return; // allaqachon rejalashtirilgan
    this.retryTimer = setInterval(() => {
      void this.retryConnect(brokers);
    }, KafkaConsumerService.RETRY_INTERVAL_MS);
    // Timer process'ni tirik ushlab turmasin (graceful shutdown + jest).
    this.retryTimer.unref?.();
  }

  private stopRetryTimer(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async retryConnect(brokers: string): Promise<void> {
    if (this.connected) {
      this.stopRetryTimer();
      return;
    }
    if (this.retryInFlight) return; // parallel tick himoyasi
    this.retryInFlight = true;
    try {
      // Yarim ochiq oldingi consumer resursini tozalaymiz (socket leak'siz).
      if (this.consumer) {
        try {
          await this.consumer.disconnect();
        } catch {
          // ignore — allaqachon uzilgan bo'lishi mumkin
        }
      }
      await this.connectAndRun(brokers);
      this.stopRetryTimer();
      this.logger.log("Kafka consumer davriy retry orqali ulandi — timer to'xtatildi");
    } catch (err) {
      this.logger.warn(
        `Kafka consumer retry xatosi (${
          KafkaConsumerService.RETRY_INTERVAL_MS / 1000
        }s dan so'ng yana): ${(err as Error).message}`,
      );
    } finally {
      this.retryInFlight = false;
    }
  }

  // Health endpoint'lar uchun (KafkaService.isConnected bilan simmetrik).
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Bitta xabarni qayta ishlash. Defensiv parse + try/catch (T-05-01): buzilgan
   * yoki soxta payload consumer'ni yiqitmasligi kerak.
   *
   * Plan 03-04 GAME-02: BADGE_EARNED topic'i alohida route — alert emas,
   * balki shaxsiy user:{userId} room ga emit qilinadi.
   */
  private async handleMessage({ topic, message }: EachMessagePayload): Promise<void> {
    try {
      const raw = message.value?.toString();
      if (!raw) return;

      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // GAME-02: badge.earned → per-user WebSocket room.
      if (topic === KAFKA_TOPICS.BADGE_EARNED) {
        const userId = typeof parsed.userId === "string" ? parsed.userId : null;
        const badgeCode = typeof parsed.badgeCode === "string" ? parsed.badgeCode : null;
        if (userId && badgeCode) {
          this.gateway.emitBadgeEarned(userId, badgeCode);
        } else {
          this.logger.warn(
            `BADGE_EARNED noto'g'ri payload (userId/badgeCode yo'q): ${raw.slice(0, 200)}`,
          );
        }
        return;
      }

      // xp.levelup → per-user WebSocket room (BADGE_EARNED bilan bir xil naqsh).
      if (topic === KAFKA_TOPICS.XP_LEVEL_UP) {
        const userId = typeof parsed.userId === "string" ? parsed.userId : null;
        const level = typeof parsed.level === "number" ? parsed.level : null;
        const xp = typeof parsed.xp === "number" ? parsed.xp : null;
        if (userId && level !== null && xp !== null) {
          this.gateway.emitXpLevelUp(userId, level, xp);
        } else {
          this.logger.warn(
            `XP_LEVEL_UP noto'g'ri payload (userId/level/xp yo'q): ${raw.slice(0, 200)}`,
          );
        }
        return;
      }

      // Barcha boshqa alert topiklari gateway'ning alert kanaliga yo'naltiriladi.
      this.gateway.emitNewAlert({ topic, ...parsed });
    } catch (err) {
      this.logger.warn(
        `Kafka xabarini qayta ishlashda xato [${topic}]: ${(err as Error).message}`
      );
      // Yutib yuboramiz — bitta yomon xabar consumer loop'ini to'xtatmasin.
    }
  }

  async onModuleDestroy() {
    // M17 — retry timer shutdown'da albatta to'xtatiladi (leak'siz).
    this.stopRetryTimer();
    if (this.consumer && this.connected) {
      try {
        await this.consumer.disconnect();
        this.logger.log("Kafka consumer uzildi");
      } catch (err) {
        this.logger.warn(`Kafka consumer uzilishida xato: ${(err as Error).message}`);
      }
    }
  }
}
