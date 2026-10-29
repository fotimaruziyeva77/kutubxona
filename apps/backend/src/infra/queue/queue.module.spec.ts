import * as fs from "fs";
import * as path from "path";
import {
  NOTIFICATION_QUEUE,
  REPORT_QUEUE,
  AI_QUEUE,
  RI_RECALC_QUEUE,
  BOOK_IMPORT_QUEUE,
  PAYMENT_TIMEOUT_QUEUE
} from "./queue.module";
import { KAFKA_TOPICS } from "../kafka/kafka.service";

describe("QueueModule constants", () => {
  it("exports the canonical queue names", () => {
    expect(NOTIFICATION_QUEUE).toBe("notifications");
    expect(REPORT_QUEUE).toBe("reports");
    expect(AI_QUEUE).toBe("ai-tasks");
    expect(RI_RECALC_QUEUE).toBe("ri-recalc");
    expect(BOOK_IMPORT_QUEUE).toBe("book-import");
  });

  // Phase 2 Plan 02-03 will attach the RiRecalcProcessor to this queue.
  // The constant must be registered before that plan ships.
  it("registers RI_RECALC_QUEUE with the literal value 'ri-recalc'", () => {
    expect(RI_RECALC_QUEUE).toBe("ri-recalc");
  });

  // Plan 04-01 PAY-04: 12-hour payment timeout queue. Processor attaches in
  // Plan 04-02; constant must be registered first so payme/click handlers can
  // @InjectQueue() before the processor exists.
  it("registers PAYMENT_TIMEOUT_QUEUE with the literal value 'payment-timeout'", () => {
    expect(PAYMENT_TIMEOUT_QUEUE).toBe("payment-timeout");
  });
});

// Audit M19 — attempts: 1 on PAYMENT_TIMEOUT / STATS_AGGREGATION / AI queues
// meant one transient DB blip permanently dropped the job (a PENDING payment
// stranded forever at the 12h mark). Processors are idempotent, so the
// retry policy is attempts: 3 + exponential backoff. Source-regex pin
// (same technique as the subscription.service FIX E timezone pin) because
// BullModule.registerQueue options are not introspectable without booting
// a Nest application + Redis.
describe("Queue retry policy (Audit M19)", () => {
  const QUEUE_MODULE_SOURCE = fs.readFileSync(
    path.resolve(__dirname, "queue.module.ts"),
    "utf-8",
  );

  const blockFor = (queueConst: string): string => {
    const match = QUEUE_MODULE_SOURCE.match(
      new RegExp(`name: ${queueConst},\\s*defaultJobOptions: \\{[\\s\\S]*?\\}`),
    );
    expect(match).not.toBeNull();
    return match![0];
  };

  it("PAYMENT_TIMEOUT_QUEUE retries transient failures (attempts: 3, exponential backoff)", () => {
    const block = blockFor("PAYMENT_TIMEOUT_QUEUE");
    expect(block).toMatch(/attempts: 3/);
    expect(block).toMatch(/backoff: \{ type: "exponential"/);
  });

  it("STATS_AGGREGATION_QUEUE retries transient failures (attempts: 3, exponential backoff)", () => {
    const block = blockFor("STATS_AGGREGATION_QUEUE");
    expect(block).toMatch(/attempts: 3/);
    expect(block).toMatch(/backoff: \{ type: "exponential"/);
  });

  it("AI_QUEUE retries transient failures (attempts: 3, exponential backoff)", () => {
    const block = blockFor("AI_QUEUE");
    expect(block).toMatch(/attempts: 3/);
    expect(block).toMatch(/backoff: \{ type: "exponential"/);
  });
});

describe("KAFKA_TOPICS payment + subscription additions (Plan 04-01)", () => {
  it("includes PAYMENT_COMPLETED with literal 'payment.completed'", () => {
    expect(KAFKA_TOPICS.PAYMENT_COMPLETED).toBe("payment.completed");
  });

  // Plan 04-01 audit-fix FIX 8 — PAYMENT_RECEIVED topic was added in the
  // Phase 4 wave-0 work but had no assertion. Phase 4 audit producers + Idora
  // event handlers depend on this literal — pin it.
  it("includes PAYMENT_RECEIVED with literal 'payment.received'", () => {
    expect(KAFKA_TOPICS.PAYMENT_RECEIVED).toBe("payment.received");
  });

  it("includes SUBSCRIPTION_ACTIVATED with literal 'subscription.activated'", () => {
    expect(KAFKA_TOPICS.SUBSCRIPTION_ACTIVATED).toBe("subscription.activated");
  });

  it("includes SUBSCRIPTION_FROZEN with literal 'subscription.frozen'", () => {
    expect(KAFKA_TOPICS.SUBSCRIPTION_FROZEN).toBe("subscription.frozen");
  });
});
