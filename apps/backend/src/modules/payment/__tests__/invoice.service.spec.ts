import { NotFoundException } from "@nestjs/common";
import { InvoiceService, BUXGALTER_CACHE_PATTERN } from "../invoice.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PdfService } from "../../../infra/pdf/pdf.service";

// Mock qrcode so we get a deterministic data URL in tests without paying the
// PNG-encoding cost. Real shape is validated by the regex `data:image/png;base64,...`
// which the mock satisfies.
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="
  ),
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  invoice: {
    create:     jest.fn(),
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    count:      jest.fn(),
  },
  payment: {
    findMany:  jest.fn(),
    aggregate: jest.fn(),
    groupBy:   jest.fn(),
  },
} as unknown as PrismaService;

// Plan 04-04 RPT-03 — heavy aggregations route through PrismaReplicaService.
// Default mock shape: same methods as the primary, $queryRaw for monthlyTrend.
const mockReplica = {
  invoice: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
  payment: {
    findMany: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  },
  $queryRaw: jest.fn(),
} as unknown as PrismaReplicaService;

// Plan 04-04 RPT-03 — cache.remember default passes through; tests assert
// cache hit-vs-miss explicitly.
const mockCache = {
  remember: jest.fn().mockImplementation(
    (_key: string, _ttl: number, fn: () => unknown) => fn(),
  ),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
} as unknown as CacheService;

const mockPdf = {
  generateFromHtml: jest.fn(),
} as unknown as PdfService;

const makeService = () =>
  new InvoiceService(mockPrisma, mockPdf, mockReplica, mockCache);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const baseInvoice = {
  id: "inv-001",
  status: "PENDING",
  amount: 2_500_000,
  createdAt: new Date("2026-03-01T00:00:00Z"),
  dueDate:   new Date("2026-03-16T00:00:00Z"),
  subscription: {
    id:        "sub-1",
    planType:  "SCH_BASIC",
    startDate: new Date("2026-03-01T00:00:00Z"),
    endDate:   new Date("2027-03-01T00:00:00Z"),
    libraryId: "lib-1",
    library:   { id: "lib-1", name: "8-maktab kutubxonasi", type: "SCH" },
  },
  payments: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InvoiceService", () => {
  let service: InvoiceService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
  });

  // ── createInvoice ───────────────────────────────────────────────────────────

  describe("createInvoice()", () => {
    it("standart 15 kunlik muddatli faktura yaratadi", async () => {
      (mockPrisma.invoice.create as jest.Mock).mockResolvedValue({ id: "inv-new" });

      const result = await service.createInvoice("sub-1", 2_500_000);

      expect(mockPrisma.invoice.create).toHaveBeenCalledTimes(1);
      const callArg = (mockPrisma.invoice.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.subscriptionId).toBe("sub-1");

      // Due date should be ~15 days from now
      const dueDiff = Math.round(
        (callArg.data.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(dueDiff).toBeGreaterThanOrEqual(14);
      expect(dueDiff).toBeLessThanOrEqual(15);

      expect(result).toEqual({ id: "inv-new" });
    });

    it("maxsus muddat (dueDays) bilan faktura yaratadi", async () => {
      (mockPrisma.invoice.create as jest.Mock).mockResolvedValue({ id: "inv-new" });

      await service.createInvoice("sub-2", 5_000_000, 30);

      const callArg = (mockPrisma.invoice.create as jest.Mock).mock.calls[0][0];
      const dueDiff = Math.round(
        (callArg.data.dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );
      expect(dueDiff).toBeGreaterThanOrEqual(29);
      expect(dueDiff).toBeLessThanOrEqual(30);
    });
  });

  // ── getInvoices ─────────────────────────────────────────────────────────────

  describe("getInvoices()", () => {
    it("filtrlar va pagination bilan fakturalarni qaytaradi", async () => {
      (mockPrisma.invoice.findMany as jest.Mock).mockResolvedValue([baseInvoice]);
      (mockPrisma.invoice.count as jest.Mock).mockResolvedValue(1);

      const result = await service.getInvoices({
        status: "PENDING",
        page: 1,
        limit: 10,
      });

      expect(result.invoices).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "PENDING" },
          skip:  0,
          take:  10,
        }),
      );
    });

    it("2-sahifada skip=50 bo'ladi", async () => {
      (mockPrisma.invoice.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.invoice.count as jest.Mock).mockResolvedValue(0);

      await service.getInvoices({ page: 2, limit: 50 });

      expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 50 }),
      );
    });

    it("libraryId filtri subscription.libraryId orqali o'tadi", async () => {
      (mockPrisma.invoice.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.invoice.count as jest.Mock).mockResolvedValue(0);

      await service.getInvoices({ libraryId: "lib-42" });

      const callArg = (mockPrisma.invoice.findMany as jest.Mock).mock.calls[0][0];
      expect(callArg.where.subscription).toEqual({ libraryId: "lib-42" });
    });

    it("from va to sanalar bo'yicha createdAt filtri qo'llanadi", async () => {
      (mockPrisma.invoice.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.invoice.count as jest.Mock).mockResolvedValue(0);

      await service.getInvoices({ from: "2026-01-01", to: "2026-03-31" });

      const callArg = (mockPrisma.invoice.findMany as jest.Mock).mock.calls[0][0];
      expect(callArg.where.createdAt).toEqual({
        gte: new Date("2026-01-01"),
        lte: new Date("2026-03-31"),
      });
    });

    it("faqat from sanasi berilsa faqat gte o'rnatiladi", async () => {
      (mockPrisma.invoice.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.invoice.count as jest.Mock).mockResolvedValue(0);

      await service.getInvoices({ from: "2026-01-01" });

      const callArg = (mockPrisma.invoice.findMany as jest.Mock).mock.calls[0][0];
      expect(callArg.where.createdAt.gte).toEqual(new Date("2026-01-01"));
      expect(callArg.where.createdAt.lte).toBeUndefined();
    });
  });

  // ── getInvoice ──────────────────────────────────────────────────────────────

  describe("getInvoice()", () => {
    it("mavjud fakturani qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(baseInvoice);
      const result = await service.getInvoice("inv-001");
      expect(result.id).toBe("inv-001");
    });

    it("faktura topilmasa NotFoundException chiqaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.getInvoice("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // ── getPaymentStats ─────────────────────────────────────────────────────────
  //
  // Plan 04-04 RPT-03 — three behavioral changes:
  //   1. Aggregations route through PrismaReplicaService, not PrismaService.
  //   2. monthlyTrend is ONE $queryRaw (date_trunc) instead of 12 aggregate()s.
  //   3. cache.remember('stats:buxgalter:{from}:{to}', 300, fn) wraps the body.

  describe("getPaymentStats() (RPT-03 replica + cache)", () => {
    const stubAgg = { _sum: { amount: 5_000_000 }, _count: { id: 5 } };
    const stubGroupBy = [
      { method: "CLICK", _sum: { amount: 3_000_000 }, _count: { id: 3 } },
      { method: "PAYME", _sum: { amount: 2_000_000 }, _count: { id: 2 } },
    ];

    beforeEach(() => {
      (mockReplica.invoice.count as jest.Mock).mockResolvedValue(10);
      (mockReplica.payment.aggregate as jest.Mock).mockResolvedValue(stubAgg);
      (mockReplica.payment.groupBy as jest.Mock).mockResolvedValue(stubGroupBy);
      (mockReplica.$queryRaw as jest.Mock).mockResolvedValue([]);
      (mockCache.remember as jest.Mock).mockImplementation(
        (_k: string, _t: number, fn: () => unknown) => fn(),
      );
    });

    it("sanasiz statistika qaytaradi", async () => {
      const result = await service.getPaymentStats();

      expect(result.totalRevenue).toBe(5_000_000);
      expect(result.byMethod).toHaveLength(2);
      expect(result.byMethod[0]).toEqual({ method: "CLICK", amount: 3_000_000, count: 3 });
      expect(result.monthlyTrend).toHaveLength(12);
    });

    it("sana oralig'i bilan filtrlash ishlaydi (replica.invoice.count)", async () => {
      await service.getPaymentStats("2026-01-01", "2026-03-31");

      // replica.invoice.count should have been called with dateFilter
      const countCalls = (mockReplica.invoice.count as jest.Mock).mock.calls;
      expect(countCalls[0][0]).toEqual(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: expect.any(Object) }) }),
      );
    });

    it("_sum.amount null bo'lganda totalRevenue 0 bo'ladi", async () => {
      (mockReplica.payment.aggregate as jest.Mock).mockResolvedValueOnce({
        _sum: { amount: null }, _count: { id: 0 },
      });
      const result = await service.getPaymentStats();
      expect(result.totalRevenue).toBe(0);
    });

    it("monthlyTrend 12 ta element qaytaradi (single $queryRaw)", async () => {
      const result = await service.getPaymentStats();
      expect(result.monthlyTrend).toHaveLength(12);
      expect(result.monthlyTrend[0]).toHaveProperty("month");
      expect(result.monthlyTrend[0]).toHaveProperty("amount");
      expect(result.monthlyTrend[0]).toHaveProperty("count");
    });

    // ── Plan 04-04 RPT-03 explicit behavioral checks ─────────────────────

    it("Test A: invokes replica.payment.groupBy (not primary)", async () => {
      await service.getPaymentStats();
      expect(mockReplica.payment.groupBy).toHaveBeenCalled();
      expect(mockPrisma.payment.groupBy).not.toHaveBeenCalled();
    });

    it("Test B: monthlyTrend uses ONE replica.$queryRaw — not 12 aggregate()", async () => {
      await service.getPaymentStats();
      // One $queryRaw for date_trunc grouping
      expect(mockReplica.$queryRaw).toHaveBeenCalledTimes(1);
      // The original 12-call aggregate pattern is gone — primary.aggregate
      // for monthlyTrend should never be called.
      expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
    });

    it("Test C: cache.remember wraps with key 'stats:buxgalter:{from}:{to}' + 300s TTL", async () => {
      await service.getPaymentStats("2026-01-01", "2026-03-31");
      expect(mockCache.remember).toHaveBeenCalledTimes(1);
      const [key, ttl] = (mockCache.remember as jest.Mock).mock.calls[0];
      expect(key).toBe("stats:buxgalter:2026-01-01:2026-03-31");
      expect(ttl).toBe(300);
    });

    it("Test D: cache hit returns cached value WITHOUT calling underlying query", async () => {
      // Simulate cache hit: remember returns the cached object directly,
      // skipping the fn callback.
      const cachedStats = {
        totalInvoices: 99,
        paidInvoices: 80,
        pendingInvoices: 19,
        totalRevenue: 999_000_000,
        byMethod: [],
        monthlyTrend: [],
      };
      (mockCache.remember as jest.Mock).mockResolvedValueOnce(cachedStats);

      const result = await service.getPaymentStats("2026-06-01", "2026-06-07");

      expect(result).toEqual(cachedStats);
      // Underlying replica queries should NOT have run on cache hit
      expect(mockReplica.invoice.count).not.toHaveBeenCalled();
      expect(mockReplica.$queryRaw).not.toHaveBeenCalled();
    });

    it("Test E: monthlyTrend zero-fills months without payments", async () => {
      // Only one month has data
      const aug = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      (mockReplica.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { month: aug, total_amount: 1_500_000, row_count: 3 },
      ]);

      const result = await service.getPaymentStats();
      expect(result.monthlyTrend).toHaveLength(12);
      // Months without rows must be zero-filled, not omitted
      const totalAmount = result.monthlyTrend.reduce((s, m) => s + m.amount, 0);
      expect(totalAmount).toBe(1_500_000);
    });
  });

  // ── Plan 04-04 RPT-03 — explicit invalidateStatsCache helper ─────────────
  describe("invalidateStatsCache()", () => {
    it("calls cache.delPattern with BUXGALTER_CACHE_PATTERN", async () => {
      await service.invalidateStatsCache();
      expect(mockCache.delPattern).toHaveBeenCalledWith(BUXGALTER_CACHE_PATTERN);
    });

    it("swallows Redis errors so callers never break on cache outage", async () => {
      (mockCache.delPattern as jest.Mock).mockRejectedValueOnce(new Error("redis down"));
      await expect(service.invalidateStatsCache()).resolves.toBeUndefined();
    });
  });

  // ── generateInvoicePdf ──────────────────────────────────────────────────────

  describe("generateInvoicePdf()", () => {
    it("PDF buffer qaytaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(baseInvoice);
      const fakeBuffer = Buffer.from("pdf-content");
      (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(fakeBuffer);

      const result = await service.generateInvoicePdf("inv-001");

      expect(mockPdf.generateFromHtml).toHaveBeenCalledTimes(1);
      const htmlArg = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
      expect(htmlArg).toContain("FAKTURA");
      expect(htmlArg).toContain("8-maktab kutubxonasi");
      expect(htmlArg).toContain("SCH_BASIC");
      expect(result).toBe(fakeBuffer);
    });

    it("invoice topilmasa NotFoundException chiqaradi", async () => {
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.generateInvoicePdf("no-such-id")).rejects.toThrow(NotFoundException);
    });

    it("to'langan invoice uchun PAID statusi HTML ga kiradi", async () => {
      const paidInvoice = { ...baseInvoice, status: "PAID" };
      (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(paidInvoice);
      (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(Buffer.from(""));

      await service.generateInvoicePdf("inv-001");

      const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
      expect(html).toContain("status-PAID");
    });

    // ── Plan 04-03 PAY-05: QR code + bank placeholder watermark ──────────────

    describe("QR code (PAY-05)", () => {
      const QRCodeMock = jest.requireMock("qrcode") as { toDataURL: jest.Mock };

      beforeEach(() => {
        (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(baseInvoice);
        (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(Buffer.from(""));
        QRCodeMock.toDataURL.mockClear();
      });

      it("QRCode.toDataURL ni sifat.uz/pay/<id> URL bilan chaqiradi", async () => {
        await service.generateInvoicePdf("inv-001");

        expect(QRCodeMock.toDataURL).toHaveBeenCalledWith(
          "https://sifat.uz/pay/inv-001",
          expect.objectContaining({
            width: 200,
            margin: 1,
            errorCorrectionLevel: "M",
          }),
        );
      });

      it("HTML ichida QR data URL <img src=...> sifatida embedlangan", async () => {
        await service.generateInvoicePdf("inv-001");

        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        // shape: <img src="data:image/png;base64,..." alt="To'lov QR kodi" ...
        expect(html).toMatch(
          /<img[^>]+src="data:image\/png;base64,[A-Za-z0-9+/=]+"[^>]*alt="To'lov QR kodi"/,
        );
      });
    });

    describe("bank placeholder watermark (PAY-05 / OQ-1)", () => {
      const originalEnv = process.env.NODE_ENV;
      const originalVerified = process.env.BANK_REKVIZIT_VERIFIED;

      beforeEach(() => {
        (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(baseInvoice);
        (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(Buffer.from(""));
        delete process.env.BANK_REKVIZIT_VERIFIED;
      });

      afterAll(() => {
        if (originalEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalEnv;
        }
        if (originalVerified === undefined) {
          delete process.env.BANK_REKVIZIT_VERIFIED;
        } else {
          process.env.BANK_REKVIZIT_VERIFIED = originalVerified;
        }
      });

      it("non-production muhitda [DEV BANK PLACEHOLDER] watermarki ko'rsatadi", async () => {
        process.env.NODE_ENV = "development";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).toContain("[DEV BANK PLACEHOLDER]");
      });

      it("production + BANK_REKVIZIT_VERIFIED=true muhitda watermark YO'Q", async () => {
        process.env.NODE_ENV = "production";
        process.env.BANK_REKVIZIT_VERIFIED = "true";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).not.toContain("[DEV BANK PLACEHOLDER]");
        expect(html).not.toContain("[BANK REKVIZIT NOT VERIFIED");
      });

      // Plan 04-03 audit-fix FIX H — production-without-verified flag must
      // show the loud red banner. Pre-fix any production deploy with the
      // unset flag silently emitted placeholder IBAN/MFO values labelled as
      // real, so an operator could send a payable-looking PDF before the
      // OQ-1 NBU handover finished.
      it("FIX H: production + BANK_REKVIZIT_VERIFIED unset → [BANK REKVIZIT NOT VERIFIED] banner", async () => {
        process.env.NODE_ENV = "production";
        // BANK_REKVIZIT_VERIFIED intentionally not set
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).toContain("[BANK REKVIZIT NOT VERIFIED");
        expect(html).toContain("DO NOT PAY");
      });

      it("FIX H: production + BANK_REKVIZIT_VERIFIED=false → unverified banner", async () => {
        process.env.NODE_ENV = "production";
        process.env.BANK_REKVIZIT_VERIFIED = "false";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).toContain("[BANK REKVIZIT NOT VERIFIED");
      });

      // Plan 04-03 audit-fix FIX H — case-normalised production check. The
      // raw process.env.NODE_ENV === 'production' compare in the pre-fix code
      // silently fell through to dev branch when NODE_ENV="Production" (case)
      // or "  production " (whitespace). isProductionEnv() trims + lowercases.
      it("FIX H: NODE_ENV='Production' (mixed case) is treated as production", async () => {
        process.env.NODE_ENV = "Production";
        process.env.BANK_REKVIZIT_VERIFIED = "true";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).not.toContain("[DEV BANK PLACEHOLDER]");
      });

      it("bank rekvizit placeholder qatorlari (NBU, IBAN, MFO) saqlanadi", async () => {
        process.env.NODE_ENV = "development";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).toContain("NBU");
        expect(html).toContain("UZ12 0000");
        expect(html).toContain("MFO");
      });

      it("invoice metadata (xaridor nomi + summa) buzilmasdan qoladi", async () => {
        process.env.NODE_ENV = "development";
        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;
        expect(html).toContain("8-maktab kutubxonasi");
        expect(html).toContain("SCH_BASIC");
        expect(html).toContain("FAKTURA");
      });
    });

    // ── Plan 04-03 audit-fix FIX A (CRITICAL SEC) — HTML injection regression
    //
    // Pre-fix: library name was spliced raw into the PDF template, so any DB-
    // controlled string (library admin's own profile field) could ship a
    // <script>...</script> or a spoofed bank rekvizit block to the printed
    // faktura. With escaping the angle brackets render as &lt; / &gt; and
    // the browser never sees a tag.
    describe("HTML injection (FIX A — CRITICAL SEC)", () => {
      const originalEnv = process.env.NODE_ENV;
      afterAll(() => {
        if (originalEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalEnv;
        }
      });

      it("escapes script tags and spoofed bank block in library name", async () => {
        process.env.NODE_ENV = "development";
        const evilInvoice = {
          ...baseInvoice,
          subscription: {
            ...baseInvoice.subscription,
            library: {
              ...baseInvoice.subscription.library,
              name: "<script>alert(1)</script><div>Bank: FAKE</div>",
            },
          },
        };
        (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(evilInvoice);
        (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(Buffer.from(""));

        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;

        // Escaped — entities are present
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain("&lt;/script&gt;");
        expect(html).toContain("&lt;div&gt;");
        // Raw HTML is NOT present (no live <script>...</script> tag from the
        // injected library name). We assert on the lowercase form because the
        // template legitimately contains <body>/<html> tags.
        expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
        expect(html).not.toMatch(/<div>Bank: FAKE<\/div>/);
      });

      it("escapes injection in lib.type, planType, and invoice.status", async () => {
        process.env.NODE_ENV = "development";
        const evilInvoice = {
          ...baseInvoice,
          status: "PE\"NDING",
          subscription: {
            ...baseInvoice.subscription,
            planType: "SCH<img src=x onerror=alert(1)>",
            library: {
              ...baseInvoice.subscription.library,
              type: "S'CH",
            },
          },
        };
        (mockPrisma.invoice.findUnique as jest.Mock).mockResolvedValue(evilInvoice);
        (mockPdf.generateFromHtml as jest.Mock).mockResolvedValue(Buffer.from(""));

        await service.generateInvoicePdf("inv-001");
        const html = (mockPdf.generateFromHtml as jest.Mock).mock.calls[0][0] as string;

        // Each special char escaped
        expect(html).toContain("&lt;img");
        expect(html).toContain("&quot;");
        expect(html).toContain("&#39;");
        // No raw image-onerror payload
        expect(html).not.toMatch(/<img src=x onerror=alert\(1\)>/);
      });
    });
  });

  // ── Plan 04-04 RPT-03 — exportToXlsx (real exceljs workbook) ─────────────

  describe("exportToXlsx() (RPT-03)", () => {
    const ExcelJSReader = require("exceljs");
    const mockPayments = [
      {
        id: "pay-1",
        transactionId: "txn-001",
        amount: 2_500_000,
        method: "CLICK",
        status: "PAID",
        paidAt: new Date("2026-03-10T10:00:00Z"),
        invoice: {
          id: "inv-xls-001",
          subscription: {
            planType: "SCH_BASIC",
            startDate: new Date("2026-03-01T00:00:00Z"),
            endDate: new Date("2027-03-01T00:00:00Z"),
            library: { name: "8-maktab kutubxonasi", type: "SCH" },
          },
        },
      },
      {
        id: "pay-2",
        transactionId: "txn-002",
        amount: 8_000_000,
        method: "PAYME",
        status: "PAID",
        paidAt: new Date("2026-03-12T11:30:00Z"),
        invoice: {
          id: "inv-xls-002",
          subscription: {
            planType: "ORG_STANDARD",
            startDate: new Date("2026-03-01T00:00:00Z"),
            endDate: new Date("2027-03-01T00:00:00Z"),
            library: { name: "Idora xizmat", type: "ORG" },
          },
        },
      },
    ];

    beforeEach(() => {
      (mockReplica.payment.findMany as jest.Mock).mockResolvedValue(mockPayments);
    });

    it("Test 1: returns a Buffer beginning with PK magic bytes (xlsx is a zip)", async () => {
      const buf = await service.exportToXlsx();
      expect(Buffer.isBuffer(buf)).toBe(true);
      // xlsx is a zip — first two bytes are 'P' (0x50) and 'K' (0x4B)
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });

    it("Test 2: workbook has sheet 'To'lovlar' with correct header row", async () => {
      const buf = await service.exportToXlsx();
      const wb = new ExcelJSReader.Workbook();
      await wb.xlsx.load(buf);
      const sheet = wb.getWorksheet("To'lovlar");
      expect(sheet).toBeDefined();
      const headerVals = sheet.getRow(1).values as any[];
      // exceljs row.values is 1-indexed (index 0 is null)
      expect(headerVals[1]).toBe("Sana");
      expect(headerVals[2]).toBe("Hujjat№");
      expect(headerVals[3]).toBe("Tashkilot nomi");
      expect(headerVals[6]).toBe("Summa");
      expect(headerVals[7]).toBe("Valyuta");
    });

    it("Test 3: each PAID payment becomes a row, ordered by paidAt ASC", async () => {
      const buf = await service.exportToXlsx();
      const wb = new ExcelJSReader.Workbook();
      await wb.xlsx.load(buf);
      const sheet = wb.getWorksheet("To'lovlar");
      // Row 1 = header, row 2 = first payment, row 3 = second.
      expect(sheet.rowCount).toBe(3);
      const r2 = sheet.getRow(2).values as any[];
      const r3 = sheet.getRow(3).values as any[];
      expect(r2[1]).toBe("2026-03-10");
      expect(r3[1]).toBe("2026-03-12");
    });

    it("Test 4: Summa column is Number (not text) so SUM() formulas work", async () => {
      const buf = await service.exportToXlsx();
      const wb = new ExcelJSReader.Workbook();
      await wb.xlsx.load(buf);
      const sheet = wb.getWorksheet("To'lovlar");
      const amountCell = sheet.getCell("F2");
      expect(typeof amountCell.value).toBe("number");
      expect(amountCell.value).toBe(2_500_000);
    });

    it("Test 5: applies date range filter via replica.payment.findMany", async () => {
      await service.exportToXlsx("2026-01-01", "2026-03-31");
      const call = (mockReplica.payment.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.paidAt).toEqual({
        gte: new Date("2026-01-01"),
        lte: new Date("2026-03-31"),
      });
    });

    // ── Plan 04-04 audit-fix FIX A (HIGH CRITICAL SEC, CWE-1236) ─────────
    //
    // CSV/Spreadsheet formula injection. A library admin who controls
    // Library.name can otherwise ship `=HYPERLINK(...)` or `=cmd|...` that
    // executes on the Buxgalter operator's machine when they open the
    // downloaded XLSX. _escapeFormulaCell prefixes such cells with an
    // apostrophe; Excel shows the text but never evaluates it.
    describe("FIX A — CSV formula injection (CWE-1236)", () => {
      const formulaPayloads = [
        ['=HYPERLINK("http://evil","x")', "=HYPERLINK"],
        ["+SUM(A1:A10)", "+SUM"],
        ["-2+5", "-2+5"],
        ["@cmd|'/c calc'!A1", "@cmd"],
        ["\tleading-tab", "\tleading-tab"],
        ["\rleading-cr", "\rleading-cr"],
      ];

      it.each(formulaPayloads)(
        "library name starting with %s → cell value prefixed with apostrophe",
        async (payload: string) => {
          (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
            {
              ...mockPayments[0],
              invoice: {
                ...mockPayments[0].invoice,
                subscription: {
                  ...mockPayments[0].invoice.subscription,
                  library: { name: payload, type: "SCH" },
                },
              },
            },
          ]);
          const buf = await service.exportToXlsx();
          const wb = new ExcelJSReader.Workbook();
          await wb.xlsx.load(buf);
          const sheet = wb.getWorksheet("To'lovlar");
          // exceljs cell.value is the post-escape string ("'=...").
          const libNameCell = sheet.getCell("C2");
          expect(String(libNameCell.value).startsWith("'")).toBe(true);
        },
      );

      it("benign library name (Cyrillic + Latin) does NOT receive an apostrophe", async () => {
        (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
          {
            ...mockPayments[0],
            invoice: {
              ...mockPayments[0].invoice,
              subscription: {
                ...mockPayments[0].invoice.subscription,
                library: { name: "Test Library", type: "SCH" },
              },
            },
          },
        ]);
        const buf = await service.exportToXlsx();
        const wb = new ExcelJSReader.Workbook();
        await wb.xlsx.load(buf);
        const sheet = wb.getWorksheet("To'lovlar");
        const libNameCell = sheet.getCell("C2");
        expect(libNameCell.value).toBe("Test Library");
      });

      it("planType, status, method also escaped if they start with a formula trigger", async () => {
        (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
          {
            ...mockPayments[0],
            method: "=evil()",
            status: "=PAID",
            invoice: {
              ...mockPayments[0].invoice,
              subscription: {
                ...mockPayments[0].invoice.subscription,
                planType: "=danger",
                library: { name: "OK", type: "=SCH" },
              },
            },
          },
        ]);
        const buf = await service.exportToXlsx();
        const wb = new ExcelJSReader.Workbook();
        await wb.xlsx.load(buf);
        const sheet = wb.getWorksheet("To'lovlar");
        // D=type, E=planType, H=status, I=method
        expect(String(sheet.getCell("D2").value).startsWith("'")).toBe(true);
        expect(String(sheet.getCell("E2").value).startsWith("'")).toBe(true);
        expect(String(sheet.getCell("H2").value).startsWith("'")).toBe(true);
        expect(String(sheet.getCell("I2").value).startsWith("'")).toBe(true);
      });
    });
  });

  // ── Plan 04-04 RPT-03 — exportTo1C (1C-Bukhgalteriya CSV) ───────────────

  describe("exportTo1C() (RPT-03 / OQ-3 / OQ-4)", () => {
    const mockPayments = [
      {
        id: "pay-1c-1",
        amount: 2_500_000,
        status: "PAID",
        paidAt: new Date("2026-03-15T10:00:00Z"),
        invoice: {
          id: "inv-A8F2C401",
          subscription: {
            planType: "SCH_STANDARD",
            startDate: new Date("2026-01-01T00:00:00Z"),
            endDate: new Date("2026-12-31T00:00:00Z"),
            library: { name: "Karmana tuman 8-maktab", type: "SCH" },
          },
        },
      },
    ];

    beforeEach(() => {
      (mockReplica.payment.findMany as jest.Mock).mockResolvedValue(mockPayments);
    });

    it("Test 1: starts with UTF-8 BOM (U+FEFF)", async () => {
      const result = await service.exportTo1C();
      expect(result.charCodeAt(0)).toBe(0xfeff);
    });

    it("Test 2: header is 11-column semicolon shape per D-1C-EXPORT", async () => {
      const result = await service.exportTo1C();
      // Strip BOM, split on CRLF
      const lines = result.slice(1).split("\r\n");
      const header = lines[0].split(";");
      expect(header).toEqual([
        "Sana",
        "Hujjat№",
        "Tashkilot nomi",
        "Tashkilot STIRi",
        "Hisob raqami",
        "Bank",
        "MFO",
        "Summa",
        "Valyuta",
        "Maqsad",
        "Status",
      ]);
      expect(header).toHaveLength(11);
    });

    it("Test 3: bank columns (STIRi, Hisob raqami, Bank, MFO) emitted EMPTY per OQ-4", async () => {
      const result = await service.exportTo1C();
      const lines = result.slice(1).split("\r\n");
      const row = lines[1].split(";");
      expect(row).toHaveLength(11);
      expect(row[3]).toBe(""); // Tashkilot STIRi
      expect(row[4]).toBe(""); // Hisob raqami
      expect(row[5]).toBe(""); // Bank
      expect(row[6]).toBe(""); // MFO
    });

    it("Test 4: data row carries Sana / Hujjat / Tashkilot / Summa / Valyuta / Status correctly", async () => {
      const result = await service.exportTo1C();
      const lines = result.slice(1).split("\r\n");
      const row = lines[1].split(";");
      expect(row[0]).toBe("2026-03-15"); // Sana
      expect(row[1]).toMatch(/^[A-Z0-9]{8}$/); // Hujjat№ — last 8 chars upper
      expect(row[2]).toBe("Karmana tuman 8-maktab"); // Tashkilot nomi
      expect(row[7]).toBe("2500000"); // Summa
      expect(row[8]).toBe("UZS"); // Valyuta
      expect(row[10]).toBe("Paid"); // Status
    });

    it("Test 5: line terminators are CRLF (RFC 4180)", async () => {
      const result = await service.exportTo1C();
      // Strip BOM, ensure CRLF separators between lines
      expect(result.slice(1)).toContain("\r\n");
    });

    it("Test 6: defensive — Library.name with semicolons converted to commas (column-parse safety)", async () => {
      (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
        {
          ...mockPayments[0],
          invoice: {
            ...mockPayments[0].invoice,
            subscription: {
              ...mockPayments[0].invoice.subscription,
              library: { ...mockPayments[0].invoice.subscription.library, name: "A;Evil;Name" },
            },
          },
        },
      ]);
      const result = await service.exportTo1C();
      const row = result.slice(1).split("\r\n")[1].split(";");
      expect(row[2]).toBe("A,Evil,Name");
      // Still 11 columns — no column injection via semicolon
      expect(row).toHaveLength(11);
    });

    // ── Plan 04-04 audit-fix FIX A (HIGH CRITICAL SEC, CWE-1236) ─────────
    describe("FIX A — 1C CSV formula injection (CWE-1236)", () => {
      it.each([
        '=HYPERLINK("http://evil","x")',
        "+SUM(A1:A10)",
        "-2+5",
        "@cmd|'/c calc'!A1",
      ])(
        "library name %s prefixed with apostrophe in Tashkilot nomi column",
        async (payload: string) => {
          (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
            {
              ...mockPayments[0],
              invoice: {
                ...mockPayments[0].invoice,
                subscription: {
                  ...mockPayments[0].invoice.subscription,
                  library: { name: payload, type: "SCH" },
                },
              },
            },
          ]);
          const result = await service.exportTo1C();
          const row = result.slice(1).split("\r\n")[1].split(";");
          expect(row[2].startsWith("'")).toBe(true);
        },
      );

      it("benign library name does NOT receive an apostrophe (regression)", async () => {
        const result = await service.exportTo1C();
        const row = result.slice(1).split("\r\n")[1].split(";");
        // mockPayments[0] has "Karmana tuman 8-maktab" — safe
        expect(row[2]).toBe("Karmana tuman 8-maktab");
      });

      it("status field escaped if a rogue value injects a formula", async () => {
        (mockReplica.payment.findMany as jest.Mock).mockResolvedValueOnce([
          {
            ...mockPayments[0],
            status: "=BAD",
          },
        ]);
        const result = await service.exportTo1C();
        const row = result.slice(1).split("\r\n")[1].split(";");
        // Status is column index 10 (last)
        expect(row[10].startsWith("'")).toBe(true);
      });
    });
  });

  // ── exportToExcel ────────────────────────────────────────────────────────────

  describe("exportToExcel()", () => {
    const mockPayments = [
      {
        id:            "pay-1",
        transactionId: "txn-001",
        amount:        2_500_000,
        method:        "CLICK",
        status:        "PAID",
        paidAt:        new Date("2026-03-10T10:00:00Z"),
        invoice: {
          subscription: {
            library: { name: "8-maktab kutubxonasi", type: "SCH" },
          },
        },
      },
    ];

    it("CSV formatida eksport qaytaradi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(mockPayments);

      const result = await service.exportToExcel();

      expect(result.csv).toContain("ID,Tranzaksiya ID");
      expect(result.csv).toContain("pay-1");
      expect(result.csv).toContain("8-maktab kutubxonasi");
      expect(result.filename).toContain(".csv");
    });

    it("sana oralig'i bilan filtrlash ishlaydi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.exportToExcel("2026-01-01", "2026-03-31");

      const callArg = (mockPrisma.payment.findMany as jest.Mock).mock.calls[0][0];
      expect(callArg.where.paidAt).toEqual({
        gte: new Date("2026-01-01"),
        lte: new Date("2026-03-31"),
      });
      expect(result.filename).toContain("2026-01-01");
      expect(result.filename).toContain("2026-03-31");
    });

    it("to'lovsiz bo'lsa bo'sh qatorli CSV qaytaradi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.exportToExcel();

      // Only header row, no data rows
      const lines = result.csv.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("ID");
    });

    it("filename sanasiz bo'lsa 'boshidan' va 'hozirgacha' o'z ichiga oladi", async () => {
      (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue([]);
      const result = await service.exportToExcel();
      expect(result.filename).toContain("boshidan");
      expect(result.filename).toContain("hozirgacha");
    });

    // ── P2 M12 (CWE-1236) — CSV formula injection + RFC 4180 quoting ──────
    //
    // exportToExcel (GET /invoices/export/csv) avval xom satrlarni
    // `r.join(",")` bilan yig'ardi — exportToXlsx/exportTo1C dagi
    // _escapeFormulaCell himoyasi BU yo'lda chetlab o'tilgan edi. Endi har
    // bir katak _csvCell dan o'tadi.
    describe("M12 — CSV formula injection (CWE-1236) va RFC 4180 quoting", () => {
      const withLibName = (name: string) => [
        {
          ...mockPayments[0],
          invoice: {
            subscription: {
              library: { name, type: "SCH" },
            },
          },
        },
      ];

      const dataRow = (csv: string) => csv.split("\n")[1];

      it.each([
        ["=HYPERLINK payload", '=HYPERLINK("http://evil","x")'],
        ["+SUM payload", "+SUM(A1:A10)"],
        ["minus payload", "-2+5"],
        ["@cmd payload", "@cmd|'/c calc'!A1"],
        ["TAB-leading payload", "\tleading-tab"],
        ["CR-leading payload", "\rleading-cr"],
      ])(
        "kutubxona nomi formula-trigger bilan boshlansa apostrof bilan zararsizlantiriladi (%s)",
        async (_label: string, payload: string) => {
          (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(
            withLibName(payload),
          );
          const result = await service.exportToExcel();
          // Katak `'` bilan boshlanadi — Excel matn sifatida ko'rsatadi,
          // hech qachon formula sifatida bajarmaydi.
          expect(result.csv).toContain("'" + payload.slice(0, 4));
          // Zararsizlantirilmagan xom payload katak boshida uchramaydi.
          expect(result.csv).not.toContain("," + payload + ",");
        },
      );

      it("=HYPERLINK nomli kutubxona: katak quote qilinadi, ichki qo'shtirnoqlar ikkilantiriladi", async () => {
        (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(
          withLibName('=HYPERLINK("http://evil","x")'),
        );
        const result = await service.exportToExcel();
        const row = dataRow(result.csv);
        // To'liq RFC 4180 shakli: "'=HYPERLINK(""http://evil"",""x"")"
        expect(row).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
        // Hech qaysi katak yalang'och `=` bilan boshlanmaydi
        for (const cell of row.split(",")) {
          expect(cell.startsWith("=")).toBe(false);
        }
      });

      it("vergulli kutubxona nomi quote qilinadi — ustun soni buzilmaydi", async () => {
        (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(
          withLibName("Karmana, 8-son maktab"),
        );
        const result = await service.exportToExcel();
        const row = dataRow(result.csv);
        expect(row).toContain('"Karmana, 8-son maktab"');
      });

      it("qo'shtirnoqli nom RFC 4180 bo'yicha ikkilantiriladi", async () => {
        (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(
          withLibName('8-"super"-maktab'),
        );
        const result = await service.exportToExcel();
        expect(result.csv).toContain('"8-""super""-maktab"');
      });

      it("yangi qatorli nom quote qilinadi — qator in'eksiyasi yo'q", async () => {
        (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(
          withLibName("Maktab\nID,EVIL,INJECTED"),
        );
        const result = await service.exportToExcel();
        // Header + (quote ichida ikki qismli) bitta data qator
        expect(result.csv).toContain('"Maktab\nID,EVIL,INJECTED"');
      });

      it("benign qiymatlar o'zgarmaydi (regression)", async () => {
        (mockPrisma.payment.findMany as jest.Mock).mockResolvedValue(mockPayments);
        const result = await service.exportToExcel();
        const row = dataRow(result.csv);
        expect(row).toBe(
          "pay-1,txn-001,8-maktab kutubxonasi,SCH,2500000,CLICK,PAID,2026-03-10",
        );
      });
    });
  });
});
