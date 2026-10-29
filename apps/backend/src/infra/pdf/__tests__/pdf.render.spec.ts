/**
 * AUDIT FIX H11 — PdfService.generateFromHtml render-yo'li spetsifikatsiyasi.
 *
 * Qamrov:
 *   1. Executable tanlash tartibi:
 *      PUPPETEER_EXECUTABLE_PATH → ma'lum tizim yo'llari (existsSync) →
 *      @sparticuz/chromium faqat oxirgi chora.
 *   2. Singleton browser: ketma-ket renderlar bitta launch; uzilgan browser
 *      keyingi so'rovda qayta launch qilinadi.
 *   3. Semafor: bir vaqtda maksimal 2 sahifa render (3-chisi navbatda kutadi).
 *   4. Sahifa har doim finally da yopiladi; umumiy browser per-request yopilmaydi.
 *
 * puppeteer-core, @sparticuz/chromium va fs.existsSync mock qilinadi —
 * haqiqiy Chromium ishga tushirilmaydi.
 */

const mockLaunch = jest.fn();
const mockSparticuzExecutablePath = jest.fn();
const mockExistsSync = jest.fn();

jest.mock("puppeteer-core", () => ({
  __esModule: true,
  default: { launch: mockLaunch },
}));

jest.mock("@sparticuz/chromium", () => ({
  __esModule: true,
  default: { executablePath: mockSparticuzExecutablePath },
}));

jest.mock("fs", () => ({
  ...jest.requireActual<typeof import("fs")>("fs"),
  existsSync: mockExistsSync,
}));

import { PdfService } from "../pdf.service";

// ── Fixture'lar ─────────────────────────────────────────────────────────────

type Gate = { resolvers: Array<() => void> };

const makeFakePage = (gate?: Gate) => ({
  setContent: jest.fn(() => {
    if (!gate) return Promise.resolve();
    return new Promise<void>((resolve) => gate.resolvers.push(resolve));
  }),
  pdf: jest.fn(async () => Buffer.from("PDF-BYTES")),
  close: jest.fn(async () => undefined),
});

const makeFakeBrowser = (gate?: Gate) => {
  const pages: ReturnType<typeof makeFakePage>[] = [];
  const browser = {
    connected: true,
    newPage: jest.fn(async () => {
      const page = makeFakePage(gate);
      pages.push(page);
      return page;
    }),
    close: jest.fn(async () => undefined),
    pages,
  };
  return browser;
};

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe("PdfService render path (AUDIT FIX H11)", () => {
  const ORIGINAL_EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
  });

  afterAll(() => {
    if (ORIGINAL_EXEC_PATH === undefined) {
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      process.env.PUPPETEER_EXECUTABLE_PATH = ORIGINAL_EXEC_PATH;
    }
  });

  // ── 1. Executable tanlash tartibi ─────────────────────────────────────────

  describe("resolveExecutablePath tartibi", () => {
    const resolvePath = (svc: PdfService): Promise<string> =>
      (svc as unknown as { resolveExecutablePath: () => Promise<string> })
        .resolveExecutablePath();

    it("PUPPETEER_EXECUTABLE_PATH eng yuqori ustunlikka ega (Dockerfile yo'li)", async () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = "/usr/bin/chromium-browser";
      // Tizim yo'llari mavjud bo'lsa ham env yutadi
      mockExistsSync.mockReturnValue(true);

      const svc = new PdfService();
      await expect(resolvePath(svc)).resolves.toBe("/usr/bin/chromium-browser");
      // sparticuz UMUMAN chaqirilmaydi
      expect(mockSparticuzExecutablePath).not.toHaveBeenCalled();
      // env o'rnatilganda existsSync ham shart emas (operator yo'li ustun)
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it("env unset → birinchi MAVJUD tizim yo'li tanlanadi (existsSync)", async () => {
      mockExistsSync.mockImplementation(
        (p: string) => p === "/usr/bin/google-chrome-stable",
      );

      const svc = new PdfService();
      await expect(resolvePath(svc)).resolves.toBe("/usr/bin/google-chrome-stable");
      expect(mockSparticuzExecutablePath).not.toHaveBeenCalled();
    });

    it("alpine yo'li /usr/bin/chromium-browser google-chrome'dan OLDIN tekshiriladi", async () => {
      mockExistsSync.mockReturnValue(true); // hammasi mavjud

      const svc = new PdfService();
      await expect(resolvePath(svc)).resolves.toBe("/usr/bin/chromium-browser");
    });

    it("env unset + tizim yo'llari yo'q → @sparticuz/chromium OXIRGI chora", async () => {
      mockSparticuzExecutablePath.mockResolvedValue("/tmp/sparticuz/chromium");

      const svc = new PdfService();
      await expect(resolvePath(svc)).resolves.toBe("/tmp/sparticuz/chromium");
      expect(mockSparticuzExecutablePath).toHaveBeenCalledTimes(1);
    });

    it("sparticuz ham yiqilsa → tushunarli xato", async () => {
      mockSparticuzExecutablePath.mockRejectedValue(new Error("no chromium"));

      const svc = new PdfService();
      await expect(resolvePath(svc)).rejects.toThrow(/Chromium topilmadi/);
    });
  });

  // ── 2. Singleton browser ──────────────────────────────────────────────────

  describe("singleton browser", () => {
    beforeEach(() => {
      process.env.PUPPETEER_EXECUTABLE_PATH = "/fake/chrome";
    });

    it("ketma-ket renderlar BITTA browser'ni qayta ishlatadi (launch 1 marta)", async () => {
      const browser = makeFakeBrowser();
      mockLaunch.mockResolvedValue(browser);

      const svc = new PdfService();
      const pdf1 = await svc.generateFromHtml("<h1>1</h1>");
      const pdf2 = await svc.generateFromHtml("<h1>2</h1>");

      expect(Buffer.isBuffer(pdf1)).toBe(true);
      expect(Buffer.isBuffer(pdf2)).toBe(true);
      expect(mockLaunch).toHaveBeenCalledTimes(1);
      expect(browser.newPage).toHaveBeenCalledTimes(2);
      // Sahifalar yopildi, umumiy browser esa YOPILMADI
      for (const page of browser.pages) {
        expect(page.close).toHaveBeenCalledTimes(1);
      }
      expect(browser.close).not.toHaveBeenCalled();
    });

    it("uzilgan browser keyingi so'rovda QAYTA launch qilinadi", async () => {
      const browser1 = makeFakeBrowser();
      const browser2 = makeFakeBrowser();
      mockLaunch
        .mockResolvedValueOnce(browser1)
        .mockResolvedValueOnce(browser2);

      const svc = new PdfService();
      await svc.generateFromHtml("<h1>1</h1>");

      // Chromium crash simulyatsiyasi
      browser1.connected = false;

      await svc.generateFromHtml("<h1>2</h1>");

      expect(mockLaunch).toHaveBeenCalledTimes(2);
      expect(browser2.newPage).toHaveBeenCalledTimes(1);
    });

    it("xato yo'lida ham sahifa yopiladi, umumiy browser yopilmaydi", async () => {
      const browser = makeFakeBrowser();
      mockLaunch.mockResolvedValue(browser);

      const svc = new PdfService();
      // Birinchi sahifaning pdf() chaqiruvi yiqiladi
      browser.newPage.mockImplementationOnce(async () => {
        const page = makeFakePage();
        page.pdf.mockRejectedValue(new Error("render crash"));
        browser.pages.push(page);
        return page;
      });

      await expect(svc.generateFromHtml("<h1>x</h1>")).rejects.toThrow("render crash");
      expect(browser.pages[0].close).toHaveBeenCalledTimes(1);
      expect(browser.close).not.toHaveBeenCalled();

      // Semafor sliti bo'shatilgan — keyingi render ishlaydi
      await expect(svc.generateFromHtml("<h1>y</h1>")).resolves.toBeInstanceOf(Buffer);
    });

    it("onModuleDestroy umumiy browser'ni yopadi (graceful shutdown)", async () => {
      const browser = makeFakeBrowser();
      mockLaunch.mockResolvedValue(browser);

      const svc = new PdfService();
      await svc.generateFromHtml("<h1>1</h1>");
      await svc.onModuleDestroy();

      expect(browser.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. Semafor (MAX 2 parallel render) ───────────────────────────────────

  describe("render semafori", () => {
    beforeEach(() => {
      process.env.PUPPETEER_EXECUTABLE_PATH = "/fake/chrome";
    });

    it("3 parallel so'rovda bir vaqtda faqat 2 sahifa ochiladi", async () => {
      const gate: Gate = { resolvers: [] };
      const browser = makeFakeBrowser(gate);
      mockLaunch.mockResolvedValue(browser);

      const svc = new PdfService();
      const p1 = svc.generateFromHtml("<h1>1</h1>");
      const p2 = svc.generateFromHtml("<h1>2</h1>");
      const p3 = svc.generateFromHtml("<h1>3</h1>");

      await flush();

      // Faqat 2 ta sahifa ochildi — 3-chi navbatda
      expect(browser.newPage).toHaveBeenCalledTimes(2);
      expect(gate.resolvers).toHaveLength(2);

      // Birinchi render tugaydi → slot bo'shaydi → 3-chi boshlanadi
      gate.resolvers[0]();
      await p1;
      await flush();

      expect(browser.newPage).toHaveBeenCalledTimes(3);

      // Qolganlarini tugatamiz
      gate.resolvers[1]();
      gate.resolvers[2]();
      await Promise.all([p2, p3]);

      // Bitta browser, 3 sahifa, hammasi yopilgan
      expect(mockLaunch).toHaveBeenCalledTimes(1);
      for (const page of browser.pages) {
        expect(page.close).toHaveBeenCalledTimes(1);
      }
      expect(browser.close).not.toHaveBeenCalled();
    });
  });
});
