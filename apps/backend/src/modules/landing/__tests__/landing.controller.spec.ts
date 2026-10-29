import { Reflector } from "@nestjs/core";
import { LandingController } from "../landing.controller";
import { LandingService } from "../landing.service";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";

describe("LandingController", () => {
  let controller: LandingController;
  let landing: jest.Mocked<
    Pick<LandingService, "getLandingStats" | "getLandingRegions">
  >;

  beforeEach(() => {
    landing = {
      getLandingStats: jest.fn().mockResolvedValue({
        libraries: 11_000,
        users: 5_000_000,
        books: 2_500_000,
        transactionsThisMonth: 120_000,
        readingIndex: 67.3,
        lastUpdated: new Date().toISOString(),
      }),
      getLandingRegions: jest.fn().mockResolvedValue([
        { slug: "toshkent", name: "Toshkent shahar", ri: 78.3, rank: 1 },
        { slug: "navoiy", name: "Navoiy", ri: 58.1, rank: 2 },
        { slug: "xorazm", name: "Xorazm", ri: null, rank: null },
      ]),
    };
    controller = new LandingController(landing as unknown as LandingService);
  });

  it("delegates to LandingService.getLandingStats", async () => {
    const out = await controller.getStats();
    expect(landing.getLandingStats).toHaveBeenCalledTimes(1);
    expect(out.libraries).toBe(11_000);
  });

  it("getStats route is marked @Public()", () => {
    const reflector = new Reflector();
    const isPublic = reflector.get<boolean>(IS_PUBLIC_KEY, controller.getStats);
    expect(isPublic).toBe(true);
  });

  it("returns a defensive zero baseline when the service throws (T-05-LIVE-DDOS)", async () => {
    landing.getLandingStats.mockRejectedValueOnce(
      new Error("redis + replica both offline"),
    );
    const out = await controller.getStats();
    expect(out.libraries).toBe(0);
    expect(out.users).toBe(0);
    expect(out.books).toBe(0);
    expect(out.transactionsThisMonth).toBe(0);
    expect(out.readingIndex).toBe(0);
    expect(out.lastUpdated).toBe(new Date(0).toISOString());
  });

  // ── H17 — GET /landing/regions ─────────────────────────────────────────
  it("delegates to LandingService.getLandingRegions", async () => {
    const out = await controller.getRegions();
    expect(landing.getLandingRegions).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      slug: "toshkent",
      name: "Toshkent shahar",
      ri: 78.3,
      rank: 1,
    });
    // null ri/rank pass through untouched — the frontend renders them as
    // neutral "no data", it must never receive an invented number instead.
    expect(out[2].ri).toBeNull();
    expect(out[2].rank).toBeNull();
  });

  it("getRegions route is marked @Public()", () => {
    const reflector = new Reflector();
    const isPublic = reflector.get<boolean>(
      IS_PUBLIC_KEY,
      controller.getRegions,
    );
    expect(isPublic).toBe(true);
  });

  it("returns an empty list when the regions service throws (defensive)", async () => {
    landing.getLandingRegions.mockRejectedValueOnce(
      new Error("replica offline"),
    );
    await expect(controller.getRegions()).resolves.toEqual([]);
  });
});
