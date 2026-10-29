/**
 * Plan 05-08 RPT-02 — AdminService.generateMonthlyReports cron contract.
 *
 * Covers:
 *   - 215 jobs enqueued: 1 national + N viloyat + M tuman.
 *   - Deterministic jobId per (scope, scopeId, YYYY-MM).
 *   - SETNX leader lock prevents double-enqueue on concurrent replicas.
 *   - ADMIN_NOTIFICATION_EMAILS fallback used for national recipients.
 */
import type { Queue } from "bullmq";
import { AdminService } from "../admin.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

describe("AdminService.generateMonthlyReports (Plan 05-08 RPT-02)", () => {
  const makePrisma = () =>
    ({
      viloyat: { findMany: jest.fn().mockResolvedValue([{ id: "UZ-08" }, { id: "UZ-09" }]) },
      tuman: { findMany: jest.fn().mockResolvedValue([{ id: "UZ-08-012" }]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    }) as unknown as PrismaService;

  const makeCache = (leaderAcquired = true) =>
    ({
      remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      setNx: jest.fn().mockResolvedValue(leaderAcquired),
    }) as unknown as CacheService;

  const makeReportQueue = () =>
    ({
      addBulk: jest.fn().mockResolvedValue([]),
      add: jest.fn().mockResolvedValue({ id: "j" }),
    }) as unknown as Queue;

  const makeStatsQueue = () => ({ add: jest.fn(), addBulk: jest.fn() } as unknown as Queue);

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_NOTIFICATION_EMAILS;
    process.env.ADMIN_NOTIFICATION_EMAILS = "admin1@sifat.uz,admin2@sifat.uz";
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADMIN_NOTIFICATION_EMAILS;
    else process.env.ADMIN_NOTIFICATION_EMAILS = originalEnv;
  });

  it("enqueues 1 national + N viloyat + M tuman jobs with deterministic jobIds", async () => {
    const prisma = makePrisma();
    const cache = makeCache(true);
    const reportQueue = makeReportQueue();
    const statsQueue = makeStatsQueue();

    const svc = new AdminService(
      prisma,
      {} as SmsService,
      cache,
      undefined,
      statsQueue,
      undefined,
      undefined,
      reportQueue,
    );

    await svc.generateMonthlyReports();

    expect(cache.setNx).toHaveBeenCalledWith(
      expect.stringMatching(/^cron:monthly-reports:\d{4}-\d{2}$/),
      "1",
      2 * 60 * 60,
    );
    expect(reportQueue.addBulk).toHaveBeenCalledTimes(1);
    const jobs = (reportQueue.addBulk as jest.Mock).mock.calls[0][0];
    // 1 national + 2 viloyat (mocked) + 1 tuman (mocked) = 4
    expect(jobs).toHaveLength(4);

    // Every jobId follows the deterministic shape.
    //
    // Ajratgich `:` EMAS, `-`: BullMQ custom jobId'da ikki nuqtadan
    // boshqa sonini rad etadi ("Custom Id cannot contain :"), shuning
    // uchun eski `monthly-report:national:UZ:2026-07` shakli ishga
    // tushganda istisno tashlar va hisobot umuman navbatga tushmasdi.
    // Bu test o'sha buzuq shaklni tasdiqlagani uchun xato ko'rinmay
    // qolgan edi. buildJobId() ga qarang.
    const jobIdRegex = /^monthly-report-(national|viloyat|tuman)-[^:]+-\d{4}-\d{2}$/;
    for (const j of jobs) {
      expect(j.opts.jobId).toMatch(jobIdRegex);
    }

    // National job MUST carry admin-fallback recipients (Q7).
    const nationalJob = jobs.find((j: any) => j.data.scope === "national");
    expect(nationalJob).toBeDefined();
    expect(nationalJob.data.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "admin1@sifat.uz" }),
        expect.objectContaining({ email: "admin2@sifat.uz" }),
      ]),
    );
    expect(nationalJob.opts.jobId).toMatch(/monthly-report-national-UZ-\d{4}-\d{2}/);
  });

  it("skips when SETNX leader lock fails (multi-replica dedupe)", async () => {
    const prisma = makePrisma();
    const cache = makeCache(false);
    const reportQueue = makeReportQueue();
    const statsQueue = makeStatsQueue();

    const svc = new AdminService(
      prisma,
      {} as SmsService,
      cache,
      undefined,
      statsQueue,
      undefined,
      undefined,
      reportQueue,
    );

    await svc.generateMonthlyReports();
    expect(reportQueue.addBulk).not.toHaveBeenCalled();
  });

  it("no-op when reportQueue not wired (older DI signature)", async () => {
    const prisma = makePrisma();
    const cache = makeCache(true);
    const statsQueue = makeStatsQueue();

    const svc = new AdminService(prisma, {} as SmsService, cache, undefined, statsQueue);

    await expect(svc.generateMonthlyReports()).resolves.toBeUndefined();
    expect(cache.setNx).not.toHaveBeenCalled();
  });

  it("falls back to ADMIN_NOTIFICATION_EMAILS for viloyat/tuman when User.email is missing", async () => {
    const prisma = makePrisma();
    const cache = makeCache(true);
    const reportQueue = makeReportQueue();
    const statsQueue = makeStatsQueue();

    const svc = new AdminService(
      prisma,
      {} as SmsService,
      cache,
      undefined,
      statsQueue,
      undefined,
      undefined,
      reportQueue,
    );

    await svc.generateMonthlyReports();

    const jobs = (reportQueue.addBulk as jest.Mock).mock.calls[0][0];
    const viloyatJob = jobs.find((j: any) => j.scope === "viloyat" || j.data?.scope === "viloyat");
    expect(viloyatJob).toBeDefined();
    expect(viloyatJob.data.recipients.length).toBeGreaterThan(0);
    // recipients fall back to ADMIN_NOTIFICATION_EMAILS
    expect(viloyatJob.data.recipients[0].email).toMatch(/sifat\.uz$/);
  });
});
