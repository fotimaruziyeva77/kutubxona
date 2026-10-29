import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { StatsGateway } from "../../infra/gateway/stats.gateway";
import { KAFKA_TOPICS } from "../../infra/kafka/kafka.service";
import { AuditService } from "./audit.service";
import { PredictService, RootCauseAnalysis } from "./predict.service";
import { AlertDispatchService } from "./alert-dispatch.service";
import { Severity } from "@prisma/client";

/**
 * KafkaAuditConsumer (AI-02 / AI-03)
 *
 * Real-time Kafka consumer for the AI audit pipeline. Subscribes to 8 topics
 * and creates AiAuditLog entries for anomalous events:
 *
 *   - FRAUD_DETECTED      -> CRITICAL audit log
 *   - TUMAN_RI_DROPPED    -> RCA via PredictService + audit log (AI-03)
 *   - RI_UPDATED          -> WARNING if delta >= 10%
 *   - BOOK_BORROWED/RETURNED -> Rapid borrow detection (>5 in 1 min window)
 *   - BOOK_RESERVED, READING_PROGRESS, ISBN_SCANNED -> debug log only
 *
 * Graceful degradation: no-ops when KAFKA_BROKERS env is unset (dev/test).
 * Backpressure: processes one message at a time (T-07-10).
 */

// ── Thresholds ──────────────────────────────────────────────────────────────
const THRESHOLDS = {
  RI_DROP_WARNING: 10,        // % delta that triggers WARNING
  RAPID_BORROW_COUNT: 5,      // borrows in 1-min window
  RAPID_BORROW_WINDOW_MS: 60_000, // 1 minute sliding window
} as const;

// ── Rapid borrow sliding window entry ───────────────────────────────────────
interface BorrowEntry {
  timestamp: number;
}

@Injectable()
export class KafkaAuditConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaAuditConsumer.name);
  private kafka: Kafka | null = null;
  private consumer: Consumer | null = null;
  private connected = false;

  /**
   * In-memory sliding window for rapid borrow detection.
   * Map<userId, BorrowEntry[]> -- bounded to 1-min window (T-07-10).
   */
  private readonly borrowWindows = new Map<string, BorrowEntry[]>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly predictService: PredictService,
    @Optional() private readonly gateway?: StatsGateway,
    @Optional() private readonly alertDispatch?: AlertDispatchService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit() {
    const brokers = this.config.get<string>("KAFKA_BROKERS");
    if (!brokers) {
      this.logger.warn(
        "KAFKA_BROKERS sozlanmagan -- KafkaAuditConsumer o'chirilgan rejimda (no-op)",
      );
      return;
    }

    try {
      this.kafka = new Kafka({
        clientId: "sifat-ai-audit-consumer",
        brokers: brokers.split(",").map((b) => b.trim()),
        retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 3000 },
        connectionTimeout: 5000,
        requestTimeout: 10000,
      });

      this.consumer = this.kafka.consumer({ groupId: "sifat-ai-audit" });
      await this.consumer.connect();

      // Subscribe to 8 topics
      const topics = [
        KAFKA_TOPICS.BOOK_BORROWED,
        KAFKA_TOPICS.BOOK_RETURNED,
        KAFKA_TOPICS.BOOK_RESERVED,
        KAFKA_TOPICS.READING_PROGRESS,
        KAFKA_TOPICS.ISBN_SCANNED,
        KAFKA_TOPICS.FRAUD_DETECTED,
        KAFKA_TOPICS.RI_UPDATED,
        KAFKA_TOPICS.TUMAN_RI_DROPPED,
      ];

      for (const topic of topics) {
        await this.consumer.subscribe({ topic, fromBeginning: false });
      }

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          try {
            const raw = payload.message.value?.toString();
            if (!raw) return;
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            await this.processAuditEvent(payload.topic, parsed);
          } catch (err) {
            this.logger.warn(
              `Kafka audit xabar xatosi [${payload.topic}]: ${(err as Error).message}`,
            );
          }
        },
      });

      this.connected = true;
      this.logger.log(
        `KafkaAuditConsumer ulandi: ${brokers} | topics: ${topics.join(", ")}`,
      );
    } catch (err) {
      this.logger.warn(
        `KafkaAuditConsumer ulanishida xato (degraded mode): ${(err as Error).message}`,
      );
      this.connected = false;
    }
  }

  async onModuleDestroy() {
    if (this.consumer && this.connected) {
      try {
        await this.consumer.disconnect();
        this.logger.log("KafkaAuditConsumer uzildi");
      } catch (err) {
        this.logger.warn(
          `KafkaAuditConsumer uzilishida xato: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Event routing ─────────────────────────────────────────────────────────

  async processAuditEvent(
    topic: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    switch (topic) {
      case KAFKA_TOPICS.FRAUD_DETECTED:
        await this._handleFraudDetected(data);
        break;

      case KAFKA_TOPICS.TUMAN_RI_DROPPED:
        await this._handleTumanRiDropped(data);
        break;

      case KAFKA_TOPICS.RI_UPDATED:
        await this._handleRiUpdated(data);
        break;

      case KAFKA_TOPICS.BOOK_BORROWED:
      case KAFKA_TOPICS.BOOK_RETURNED:
        await this._handleBookActivity(topic, data);
        break;

      default:
        // BOOK_RESERVED, READING_PROGRESS, ISBN_SCANNED -- debug log only
        this.logger.debug(
          `[audit-consumer] ${topic}: ${JSON.stringify(data).slice(0, 200)}`,
        );
        break;
    }
  }

  // ── FRAUD_DETECTED -> CRITICAL AiAuditLog ─────────────────────────────────

  private async _handleFraudDetected(data: Record<string, unknown>) {
    const userId = String(data.userId ?? "unknown");
    const riskScore = Number(data.riskScore ?? 0);
    const flags = Array.isArray(data.flags) ? data.flags : [];

    const log = await this.prisma.aiAuditLog.create({
      data: {
        scope: "USER",
        scopeId: userId,
        issueType: "FRAUD_DETECTED",
        severity: Severity.CRITICAL,
        analysis: `Fraud aniqlandi: userId=${userId}, riskScore=${riskScore}, flags=${flags.join(", ")}`,
        recommendation:
          "Foydalanuvchi profilini tekshiring va zarur hollarda bloklang.",
      },
    });

    this.gateway?.emitNewAlert({
      id: log.id,
      scope: "USER",
      scopeName: userId,
      issueType: "FRAUD_DETECTED",
      severity: "CRITICAL",
      analysis: log.analysis,
      recommendation: log.recommendation,
      createdAt: log.createdAt,
    });

    this.logger.log(`[CRITICAL] FRAUD_DETECTED: userId=${userId} riskScore=${riskScore}`);
  }

  // ── TUMAN_RI_DROPPED -> RCA + AiAuditLog (AI-03 wiring) ──────────────────

  private async _handleTumanRiDropped(data: Record<string, unknown>) {
    const tumanId = String(data.tumanId ?? "unknown");
    const dropPercent = Number(data.dropPercent ?? 0);
    const currentAvg = Number(data.currentAvg ?? 0);
    const previousAvg = Number(data.previousAvg ?? 0);

    // AI-03: Trigger Root Cause Analysis via PredictService
    let rca: RootCauseAnalysis | null = null;
    try {
      rca = await this.predictService.analyzeRootCause(tumanId, "RI_DROP");
    } catch (err) {
      this.logger.warn(
        `RCA failed for tuman ${tumanId}: ${(err as Error).message}`,
      );
    }

    const rcaSummary = rca
      ? `\nSabab tahlili: ${rca.summary}\nSabablar: ${rca.causes.map((c) => c.factor).join(", ")}`
      : "";

    const log = await this.prisma.aiAuditLog.create({
      data: {
        scope: "TUMAN",
        scopeId: tumanId,
        issueType: "RI_DROPPED",
        severity: dropPercent >= 20 ? Severity.CRITICAL : Severity.MEDIUM,
        analysis:
          `Tuman RI pasaydi: ${dropPercent.toFixed(1)}% (${previousAvg.toFixed(1)} -> ${currentAvg.toFixed(1)})` +
          rcaSummary,
        recommendation: rca?.causes[0]?.recommendation ??
          "Tuman admini kutubxona holati va faollikni tekshirsin.",
      },
    });

    this.gateway?.emitNewAlert({
      id: log.id,
      scope: "TUMAN",
      scopeName: tumanId,
      issueType: "RI_DROPPED",
      severity: dropPercent >= 20 ? "CRITICAL" : "WARNING",
      analysis: log.analysis,
      recommendation: log.recommendation,
      createdAt: log.createdAt,
    });

    this.logger.log(
      `[${dropPercent >= 20 ? "CRITICAL" : "WARNING"}] TUMAN_RI_DROPPED: ${tumanId} -${dropPercent.toFixed(1)}%`,
    );
  }

  // ── RI_UPDATED -> WARNING if delta exceeds threshold ──────────────────────

  private async _handleRiUpdated(data: Record<string, unknown>) {
    const userId = String(data.userId ?? "unknown");
    const delta = Number(data.delta ?? 0);
    const score = Number(data.score ?? 0);

    // Only create audit log when delta is a significant drop
    if (Math.abs(delta) < THRESHOLDS.RI_DROP_WARNING) return;

    if (delta < 0) {
      await this.prisma.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "RI_DROPPED",
          severity: Severity.MEDIUM,
          analysis: `Foydalanuvchi RI ${Math.abs(delta).toFixed(1)}% pasaydi (hozir: ${score.toFixed(1)})`,
          recommendation: "Kitobxon faolligini tekshiring.",
        },
      });
    }
  }

  // ── BOOK_BORROWED/RETURNED -> Rapid borrow detection ──────────────────────

  private async _handleBookActivity(
    topic: string,
    data: Record<string, unknown>,
  ) {
    if (topic !== KAFKA_TOPICS.BOOK_BORROWED) return;

    const userId = String(data.userId ?? "unknown");
    const now = Date.now();

    // Get or create window for this user
    let entries = this.borrowWindows.get(userId);
    if (!entries) {
      entries = [];
      this.borrowWindows.set(userId, entries);
    }

    // Add current borrow
    entries.push({ timestamp: now });

    // Prune entries older than the sliding window (memory-bounded, T-07-10)
    const cutoff = now - THRESHOLDS.RAPID_BORROW_WINDOW_MS;
    const filtered = entries.filter((e) => e.timestamp >= cutoff);
    this.borrowWindows.set(userId, filtered);

    // Check threshold
    if (filtered.length > THRESHOLDS.RAPID_BORROW_COUNT) {
      await this.prisma.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "RAPID_BORROW",
          severity: Severity.MEDIUM,
          analysis:
            `Shubhali tez kitob olish: ${filtered.length} ta kitob 1 daqiqada (userId=${userId})`,
          recommendation:
            "Foydalanuvchi profilini tekshiring -- soxta kitob olish ehtimoli bor.",
        },
      });

      this.logger.warn(
        `[WARNING] RAPID_BORROW: userId=${userId} borrows=${filtered.length}/min`,
      );

      // Reset window after alert to avoid duplicate alerts
      this.borrowWindows.delete(userId);
    }
  }
}
