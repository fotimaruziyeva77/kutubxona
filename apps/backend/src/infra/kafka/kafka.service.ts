import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Producer, ProducerRecord, CompressionTypes } from "kafkajs";
import { isProductionEnv } from "../../common/utils/production-env.util";

// ── Kafka topic nomlari ───────────────────────────────────────────────────────
// Plan 03-01: BADGE_EARNED + TOP100_CONFIRMED added as cross-cutting broadcast
// channels for Phase 3. GAME-02 emits badge.earned from badge.service.award();
// TOP-02 emits top100.confirmed when the monthly auto-publish cron transitions
// READY_FOR_PUBLISH → CONFIRMED. No emit helpers added here — consumer plans
// (03-02 / 03-04) wire those.
export const KAFKA_TOPICS = {
  USER_REGISTERED:        "user.registered",
  BOOK_BORROWED:          "book.borrowed",
  BOOK_RETURNED:          "book.returned",
  BOOK_RESERVED:          "book.reserved",
  READING_PROGRESS:       "reading.progress",
  ISBN_SCANNED:           "isbn.scanned",
  FRAUD_DETECTED:         "fraud.detected",
  RI_UPDATED:             "ri.updated",
  CLUB_DEBATE_ADDED:      "club.debate.added",
  LIBRARY_INACTIVE:       "library.inactive",
  TUMAN_RI_DROPPED:       "tuman.ri.dropped",
  BADGE_EARNED:           "badge.earned",
  // Gamifikatsiya poydevori — XpService faqat LEVEL OSHGANDA emit qiladi
  // (har XP qo'shilishida emas), aks holda topic har qaytarilgan kitobda
  // shovqinga to'lardi. Streak yangilanishi profil so'ralganda o'qiladi.
  XP_LEVEL_UP:            "xp.level.up",
  TOP100_CONFIRMED:       "top100.confirmed",
  // Plan 04-01 PAY-01/02/06: payment + subscription lifecycle broadcast.
  // PAYMENT_COMPLETED fires when Payme PerformTransaction or Click Complete
  // succeed (Plan 04-02). SUBSCRIPTION_ACTIVATED fires when an invoice's
  // payment completes and pushes the subscription PENDING -> ACTIVE.
  // SUBSCRIPTION_FROZEN fires on admin-initiated freeze (Plan 04-03).
  // Emit helpers added in 04-02/03 — declaration here is dependency-free.
  PAYMENT_COMPLETED:      "payment.completed",
  PAYMENT_RECEIVED:       "payment.received",
  SUBSCRIPTION_ACTIVATED: "subscription.activated",
  SUBSCRIPTION_FROZEN:    "subscription.frozen",
  // Plan 05-01 Task 3 — Phase 5 alert + system event topics.
  // RI_RISING / SYSTEM_DOWN broadcast positive + health signals consumed by
  // Plan 05-05 (audit.service consolidation) + 05-07 (StatsGateway live WS).
  // ALERT_FIRED is the cross-cutting alert lifecycle topic; ALERT_ACKNOWLEDGED
  // closes the loop when an admin marks an alert as seen. Emit helpers are
  // intentionally NOT added here per Phase 3 03-01 hygiene — Plan 05-05/07
  // wire them next to the consumer code.
  RI_RISING:              "ri.rising",
  SYSTEM_DOWN:            "system.down",
  ALERT_FIRED:            "alert.fired",
  ALERT_ACKNOWLEDGED:     "alert.acknowledged",
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export interface KafkaEvent<T = unknown> {
  topic: KafkaTopic;
  key?: string;
  value: T;
  timestamp?: string;
}

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private connected = false;

  // M17 (2026-06-10) — lazy reconnect holati. Boot'da ulanish muvaffaqiyatsiz
  // bo'lsa servis ENDI abadiy degraded rejimda qolmaydi: emit() chaqiruvida
  // cooldown (≥30s) bilan qayta ulanishga urinadi. Thundering-retry yo'q —
  // bitta in-flight urinish hammaga bo'linadi, urinishlar orasida cooldown.
  private lastReconnectAt = 0;
  private reconnectInFlight: Promise<boolean> | null = null;
  static readonly RECONNECT_COOLDOWN_MS = 30_000;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const brokers = this.config.get<string>("KAFKA_BROKERS");
    if (!brokers) {
      // AUDIT FIX H7 — production fail-closed boot assert. Kafkasiz prod boot
      // real vaqt AI audit oqimini (§VII) jimgina o'chiradi — taqiqlangan.
      // Dev/test da graceful no-op saqlanadi.
      if (isProductionEnv()) {
        throw new Error(
          "[FATAL] KAFKA_BROKERS production da majburiy — " +
            "event streaming'siz prod boot taqiqlangan (fail-closed). " +
            ".env.prod faylini to'ldiring.",
        );
      }
      this.logger.warn("KAFKA_BROKERS sozlanmagan — Kafka o'chirilgan rejimda ishlaydi");
      return;
    }

    try {
      this.kafka = new Kafka({
        clientId: "sifat-library-backend",
        brokers: brokers.split(",").map((b) => b.trim()),
        retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 3000 },
        connectionTimeout: 5000,
        requestTimeout: 10000,
      });

      this.producer = this.kafka.producer({
        allowAutoTopicCreation: true,
        transactionTimeout: 30000,
      });

      await this.producer.connect();
      this.connected = true;
      this.logger.log(`Kafka ulandi: ${brokers}`);
    } catch (err) {
      // M17 — degraded rejim endi VAQTINCHA: birinchi emit() lazy reconnect'ni
      // boshlaydi (lastReconnectAt=0 qoladi, shu sabab birinchi urinish darhol).
      this.logger.warn(`Kafka ulanishida xato (degraded mode): ${(err as Error).message}`);
      this.connected = false;
    }
  }

  // ── M17: emit-paytida lazy reconnect (cooldown bilan) ─────────────────────
  //
  // Nima uchun shunday: onModuleInit faqat BIR marta ulanardi — broker boot
  // paytida tushgan bo'lsa, butun process hayoti davomida Kafka jim o'chiq
  // qolardi (silent permanent degraded). Endi har emit() ulanmagan holatda
  // qayta urinish imkonini beradi, lekin:
  //   * urinishlar orasida ≥RECONNECT_COOLDOWN_MS (30s) — retry bo'roni yo'q;
  //   * parallel emit'lar BITTA in-flight connect promise'ini bo'lishadi;
  //   * muvaffaqiyatsiz urinishda event eski xulq bilan (debug-log) tashlanadi.
  private tryReconnect(): Promise<boolean> {
    if (!this.producer) return Promise.resolve(false);
    if (this.reconnectInFlight) return this.reconnectInFlight;

    const now = Date.now();
    if (now - this.lastReconnectAt < KafkaService.RECONNECT_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    this.lastReconnectAt = now;

    this.reconnectInFlight = (async () => {
      try {
        await this.producer!.connect();
        this.connected = true;
        this.logger.log("Kafka producer lazy reconnect muvaffaqiyatli");
        return true;
      } catch (err) {
        this.logger.warn(
          `Kafka lazy reconnect xatosi (keyingi urinish ≥${
            KafkaService.RECONNECT_COOLDOWN_MS / 1000
          }s dan so'ng): ${(err as Error).message}`,
        );
        return false;
      } finally {
        this.reconnectInFlight = null;
      }
    })();
    return this.reconnectInFlight;
  }

  async onModuleDestroy() {
    if (this.producer && this.connected) {
      await this.producer.disconnect();
      this.logger.log("Kafka producer uzildi");
    }
  }

  // ── Event chiqarish ───────────────────────────────────────────────────────

  async emit<T>(event: KafkaEvent<T>): Promise<void> {
    // M17 — producer mavjud lekin ulanmagan: lazy reconnect (cooldown bilan).
    if (!this.connected && this.producer) {
      await this.tryReconnect();
    }

    if (!this.connected || !this.producer) {
      // Kafka yo'q bo'lsa log chiqarish bilan cheklanamiz
      this.logger.debug(`[Kafka off] ${event.topic}: ${JSON.stringify(event.value)}`);
      return;
    }

    const record: ProducerRecord = {
      topic: event.topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key: event.key ?? null,
          value: JSON.stringify({
            ...event.value as object,
            _meta: {
              topic: event.topic,
              emittedAt: event.timestamp ?? new Date().toISOString(),
              service: "sifat-library-backend",
            },
          }),
          timestamp: event.timestamp ?? String(Date.now()),
        },
      ],
    };

    try {
      await this.producer.send(record);
    } catch (err) {
      // Kafka xatosi tizimni to'xtatmasin — faqat log
      this.logger.error(`Kafka emit xatosi [${event.topic}]: ${(err as Error).message}`);
    }
  }

  // ── Qulay yordamchi metodlar ──────────────────────────────────────────────

  async emitBookBorrowed(data: {
    userId: string; bookId: string; libraryId: string;
    tumanId: string; viloyatId: string;
  }) {
    await this.emit({ topic: KAFKA_TOPICS.BOOK_BORROWED, key: data.userId, value: data });
  }

  async emitBookReturned(data: {
    userId: string; bookId: string; libraryId: string;
    daysKept: number; onTime: boolean;
  }) {
    await this.emit({ topic: KAFKA_TOPICS.BOOK_RETURNED, key: data.userId, value: data });
  }

  async emitReadingProgress(data: {
    userId: string; isbn: string; pagesRead: number; totalPages: number; source: string;
  }) {
    await this.emit({ topic: KAFKA_TOPICS.READING_PROGRESS, key: data.userId, value: data });
  }

  async emitUserRegistered(data: { userId: string; tumanId: string; viloyatId: string; type: string }) {
    await this.emit({ topic: KAFKA_TOPICS.USER_REGISTERED, key: data.userId, value: data });
  }

  async emitFraudDetected(data: { userId: string; riskScore: number; flags: string[] }) {
    await this.emit({ topic: KAFKA_TOPICS.FRAUD_DETECTED, key: data.userId, value: data });
  }

  async emitRiUpdated(data: { userId: string; score: number; delta: number }) {
    await this.emit({ topic: KAFKA_TOPICS.RI_UPDATED, key: data.userId, value: data });
  }

  async emitTumanRiDropped(data: {
    tumanId: string; currentAvg: number; previousAvg: number; dropPercent: number;
  }) {
    await this.emit({ topic: KAFKA_TOPICS.TUMAN_RI_DROPPED, key: data.tumanId, value: data });
  }

  isConnected(): boolean {
    return this.connected;
  }
}
