import { Job } from "bullmq";
import { StatsAggregationProcessor } from "../stats-aggregation.processor";
import { AdminService } from "../admin.service";

describe("StatsAggregationProcessor (Plan 05-02 T2, STAT-03)", () => {
  let admin: jest.Mocked<Pick<AdminService, "getNationalStats" | "getViloyatStats" | "getTumanStats">>;
  let processor: StatsAggregationProcessor;

  beforeEach(() => {
    admin = {
      getNationalStats: jest.fn().mockResolvedValue({}),
      getViloyatStats: jest.fn().mockResolvedValue({}),
      getTumanStats: jest.fn().mockResolvedValue({}),
    };
    processor = new StatsAggregationProcessor(admin as unknown as AdminService);
  });

  const makeJob = (name: string, data: any = {}): Job =>
    ({ id: "j1", name, data, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job);

  it("'warm-national' job calls AdminService.getNationalStats", async () => {
    await processor.process(makeJob("warm-national"));
    expect(admin.getNationalStats).toHaveBeenCalledTimes(1);
  });

  it("'warm-viloyat' job calls AdminService.getViloyatStats with the viloyatId", async () => {
    await processor.process(makeJob("warm-viloyat", { viloyatId: "UZ-08" }));
    expect(admin.getViloyatStats).toHaveBeenCalledWith("UZ-08");
  });

  it("'warm-tuman' job calls AdminService.getTumanStats with the tumanId", async () => {
    await processor.process(makeJob("warm-tuman", { tumanId: "UZ-08-012" }));
    expect(admin.getTumanStats).toHaveBeenCalledWith("UZ-08-012");
  });

  it("'warm-viloyat' job without viloyatId throws", async () => {
    await expect(
      processor.process(makeJob("warm-viloyat", {})),
    ).rejects.toThrow(/viloyatId/);
  });

  it("'warm-tuman' job without tumanId throws", async () => {
    await expect(
      processor.process(makeJob("warm-tuman", {})),
    ).rejects.toThrow(/tumanId/);
  });

  it("unknown job name throws", async () => {
    await expect(
      processor.process(makeJob("warm-mahalla", { mahallaId: "m1" })),
    ).rejects.toThrow(/Noma'lum stats job/);
    expect(admin.getNationalStats).not.toHaveBeenCalled();
  });

  it("internal cron calls bypass scope assert (no user arg passed)", async () => {
    await processor.process(makeJob("warm-viloyat", { viloyatId: "UZ-08" }));
    // The processor MUST NOT supply a user — that's how the service knows
    // this is a trusted internal cron call and skips the scope assertion.
    expect(admin.getViloyatStats).toHaveBeenCalledWith("UZ-08");
    expect(admin.getViloyatStats.mock.calls[0]).toHaveLength(1);
  });
});
