import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * PrismaReplicaService (RI-01 — Plan 02-03 Task 1)
 *
 * A SECOND PrismaClient instance pointed at DATABASE_REPLICA_URL so the RI
 * nightly batch can fan out reads to the streaming-standby provisioned in
 * Phase 1 INFRA-09/10, leaving the primary DB free for live traffic.
 *
 * Graceful degradation (mirrors the Phase 1 KafkaConsumerService pattern):
 * when DATABASE_REPLICA_URL is unset (dev, CI, single-node prod) the client
 * silently falls back to DATABASE_URL with a logger.warn line. Boot stays
 * green — the batch just hits the primary, which is fine for small datasets.
 *
 * Threat model (Plan 02-03):
 * - T-02-12 (DoS via queue flooding) — defended at the queue layer (jobId
 *   dedupe in Task 3); this service has no public surface.
 * - Replica is a read-only role; failed reads cannot corrupt the primary.
 */
@Injectable()
export class PrismaReplicaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaReplicaService.name);

  constructor() {
    const replicaUrl = process.env.DATABASE_REPLICA_URL;
    const primaryUrl = process.env.DATABASE_URL;
    const url = replicaUrl ?? primaryUrl ?? "";

    super({
      datasources: { db: { url } },
      log: ["error", "warn"]
    });

    if (!replicaUrl) {
      // Logger is initialized BEFORE super() returns in the property initializer
      // order, but the linter prefers explicit construction; use a local logger
      // here to avoid a `this` reference before super.
      const logger = new Logger(PrismaReplicaService.name);
      logger.warn(
        "PrismaReplicaService falling back to primary DATABASE_URL — DATABASE_REPLICA_URL not set; RI batch will hit primary."
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
