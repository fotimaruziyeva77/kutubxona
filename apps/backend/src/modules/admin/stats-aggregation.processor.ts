import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Inject, Logger, forwardRef } from "@nestjs/common";
import { Job } from "bullmq";
import { STATS_AGGREGATION_QUEUE } from "../../infra/queue/queue-names";
import { AdminService } from "./admin.service";

export interface StatsAggregationJobData {
  viloyatId?: string;
  tumanId?: string;
}

/**
 * Plan 05-02 Task 2 (STAT-03) — Pre-aggregation worker.
 *
 * Consumes:
 *   - `warm-national` — calls AdminService.getNationalStats (single key)
 *   - `warm-viloyat`  — { viloyatId }: calls AdminService.getViloyatStats(viloyatId)
 *   - `warm-tuman`    — { tumanId }:   calls AdminService.getTumanStats(tumanId)
 *
 * The handlers DO NOT supply a `user` arg, so the service-layer scope assert
 * is bypassed (internal cron context — the cron has implicit super-admin
 * authority). cache.remember writes through to Redis under the existing keys.
 *
 * forwardRef avoids the circular dep when AdminService both depends on the
 * processor (via @InjectQueue) AND the processor depends on AdminService.
 */
@Processor(STATS_AGGREGATION_QUEUE)
export class StatsAggregationProcessor extends WorkerHost {
  private readonly logger = new Logger(StatsAggregationProcessor.name);

  constructor(
    @Inject(forwardRef(() => AdminService))
    private readonly admin: AdminService,
  ) {
    super();
  }

  async process(job: Job<StatsAggregationJobData>): Promise<void> {
    switch (job.name) {
      case "warm-national": {
        await this.admin.getNationalStats();
        return;
      }
      case "warm-viloyat": {
        if (!job.data.viloyatId) {
          throw new Error("warm-viloyat job missing viloyatId");
        }
        await this.admin.getViloyatStats(job.data.viloyatId);
        return;
      }
      case "warm-tuman": {
        if (!job.data.tumanId) {
          throw new Error("warm-tuman job missing tumanId");
        }
        await this.admin.getTumanStats(job.data.tumanId);
        return;
      }
      default:
        throw new Error(`Noma'lum stats job: ${job.name}`);
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job<StatsAggregationJobData>, error: Error) {
    this.logger.error(
      `Stats aggregation job '${job.name}' failed: ${error.message}`,
      { jobId: job.id, data: job.data },
    );
  }

  @OnWorkerEvent("completed")
  onCompleted(job: Job) {
    this.logger.debug(`Stats job '${job.name}' tugadi: ${job.id}`);
  }
}
