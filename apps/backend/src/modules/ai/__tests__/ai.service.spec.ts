import { AiService } from "../ai.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { PdfService } from "../../../infra/pdf/pdf.service";
import { FraudService } from "../fraud.service";
import { AuditService } from "../audit.service";
import { NlqService } from "../nlq.service";
import { PredictService } from "../predict.service";
import { RecommendService } from "../recommend.service";
import { Severity } from "@prisma/client";
import { Queue } from "bullmq";

const mockPrisma = {
  aiAuditLog: { create: jest.fn(), findMany: jest.fn() },
  // generateAiReport (P2 XSS fix testlari) — findUnique + count + aggregate
  library: { findMany: jest.fn(), findUnique: jest.fn() },
  bookTransaction: { count: jest.fn() },
  readingIndex: { aggregate: jest.fn() },
};

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
};

const mockPdf = { generate: jest.fn() };

const mockFraud = {
  analyzeUser:          jest.fn(),
  checkTop100Candidates: jest.fn(),
  getFraudStats:        jest.fn(),
  getFraudList:         jest.fn(),
};

const mockAudit = {
  getAuditLogs:    jest.fn(),
  resolveAuditLog: jest.fn(),
};

const mockNlq = {
  query: jest.fn(),
};

const mockPredict = {
  predictTumanRi:      jest.fn(),
  predictFundShortage: jest.fn(),
  analyzeRootCause:    jest.fn(),
  nationalGoalForecast: jest.fn(),
};

const mockRecommend = {
  getRecommendations:     jest.fn(),
  getClubRecommendations: jest.fn(),
};

const mockQueue = { add: jest.fn() };

const makeService = () =>
  new AiService(
    mockPrisma as unknown as PrismaService,
    mockCache as unknown as CacheService,
    mockPdf as unknown as PdfService,
    mockFraud as unknown as FraudService,
    mockAudit as unknown as AuditService,
    mockNlq as unknown as NlqService,
    mockPredict as unknown as PredictService,
    mockRecommend as unknown as RecommendService,
    mockQueue as unknown as Queue,
  );

describe("AiService", () => {
  let service: AiService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
  });

  // ── NLQ delegation ─────────────────────────────────────────────────────────
  describe("query", () => {
    it("nlq.query ga delegat qiladi", async () => {
      const mockResponse = { answer: "Navoiyda indeks 67", data: {}, sql: "" };
      mockNlq.query.mockResolvedValue(mockResponse);

      const result = await service.query("Navoiyda kitobxonlik qanday?", "user-1");

      expect(mockNlq.query).toHaveBeenCalledWith("Navoiyda kitobxonlik qanday?", "user-1");
      expect(result).toBe(mockResponse);
    });
  });

  // ── Fraud delegation ───────────────────────────────────────────────────────
  describe("analyzeUserFraud", () => {
    it("fraud.analyzeUser ga delegat qiladi", async () => {
      const mockResult = { userId: "u1", riskScore: 30, flags: [] };
      mockFraud.analyzeUser.mockResolvedValue(mockResult);

      const result = await service.analyzeUserFraud("u1");

      expect(mockFraud.analyzeUser).toHaveBeenCalledWith("u1");
      expect(result).toBe(mockResult);
    });
  });

  describe("getFraudStats", () => {
    it("fraud.getFraudStats ga delegat qiladi", async () => {
      const stats = { total: 5, byLevel: {} };
      mockFraud.getFraudStats.mockResolvedValue(stats);

      const result = await service.getFraudStats();

      expect(mockFraud.getFraudStats).toHaveBeenCalled();
      expect(result).toBe(stats);
    });
  });

  describe("getFraudList", () => {
    it("minRisk va limit bilan delegat qiladi", async () => {
      mockFraud.getFraudList.mockResolvedValue([]);

      await service.getFraudList(70, 20);

      expect(mockFraud.getFraudList).toHaveBeenCalledWith(70, 20);
    });
  });

  // ── Audit delegation ───────────────────────────────────────────────────────
  describe("getAuditLogs", () => {
    it("audit.getAuditLogs ga delegat qiladi", async () => {
      const logs = [{ id: "l1", scope: "tuman" }];
      mockAudit.getAuditLogs.mockResolvedValue(logs);

      const result = await service.getAuditLogs({ scope: "tuman" });

      expect(mockAudit.getAuditLogs).toHaveBeenCalledWith({ scope: "tuman" });
      expect(result).toBe(logs);
    });
  });

  describe("resolveAuditLog", () => {
    it("audit.resolveAuditLog ga delegat qiladi", async () => {
      mockAudit.resolveAuditLog.mockResolvedValue({ id: "l1", resolved: true });

      const result = await service.resolveAuditLog("l1");

      expect(mockAudit.resolveAuditLog).toHaveBeenCalledWith("l1");
      expect(result).toMatchObject({ resolved: true });
    });
  });

  describe("createAuditLog", () => {
    it("prisma.aiAuditLog.create chaqiradi", async () => {
      const data = {
        scope: "tuman", scopeId: "UZ-08-012",
        issueType: "index_drop", severity: Severity.HIGH,
        analysis: "Indeks pasaydi", recommendation: "Fond yangilash"
      };
      mockPrisma.aiAuditLog.create.mockResolvedValue({ id: "new-l", ...data });

      const result = await service.createAuditLog(data);

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith({ data });
      expect(result.id).toBe("new-l");
    });
  });

  // ── Predict delegation ─────────────────────────────────────────────────────
  describe("predictTumanRi", () => {
    it("predict.predictTumanRi ga delegat qiladi", async () => {
      mockPredict.predictTumanRi.mockResolvedValue({ prediction: [67] });

      await service.predictTumanRi("tuman-1", 3);

      expect(mockPredict.predictTumanRi).toHaveBeenCalledWith("tuman-1", 3);
    });
  });

  describe("analyzeRootCause", () => {
    it("predict.analyzeRootCause ga delegat qiladi", async () => {
      mockPredict.analyzeRootCause.mockResolvedValue({ causes: [] });

      await service.analyzeRootCause("tuman-1", "RI_DROP");

      expect(mockPredict.analyzeRootCause).toHaveBeenCalledWith("tuman-1", "RI_DROP");
    });
  });

  // ── Recommend delegation ───────────────────────────────────────────────────
  describe("getRecommendations", () => {
    it("recommend.getRecommendations ga delegat qiladi", async () => {
      mockRecommend.getRecommendations.mockResolvedValue([]);

      await service.getRecommendations("u1", 5);

      expect(mockRecommend.getRecommendations).toHaveBeenCalledWith("u1", 5);
    });
  });

  describe("getClubRecommendations", () => {
    it("recommend.getClubRecommendations ga delegat qiladi", async () => {
      mockRecommend.getClubRecommendations.mockResolvedValue([]);

      await service.getClubRecommendations("club-1", 10);

      expect(mockRecommend.getClubRecommendations).toHaveBeenCalledWith("club-1", 10);
    });
  });

  // ── generateAiReport (P2 XSS fix, 2026-06-10) ──────────────────────────────
  // libName DB'dan keladi va HTML hisobotga interpolyatsiya qilinadi — endi
  // shared escapeHtml util orqali (pdf.service/invoice.service bilan bir xil).
  describe("generateAiReport", () => {
    beforeEach(() => {
      mockPrisma.bookTransaction.count.mockResolvedValue(12);
      mockPrisma.readingIndex.aggregate.mockResolvedValue({ _avg: { score: 55 } });
    });

    it("kutubxona nomidagi HTML maxsus belgilar hisobotda escape qilinadi (stored XSS yo'q)", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        name: '<script>alert("xss")</script>',
        tumanId: "t1",
        viloyatId: "v1",
      });

      const result = await service.generateAiReport("lib-1");

      expect(result.html).not.toContain("<script>");
      expect(result.html).toContain("&lt;script&gt;");
    });

    it("oddiy nom o'zgarmasdan chiqadi, html/summary/insights shakli saqlanadi", async () => {
      mockPrisma.library.findUnique.mockResolvedValue({
        name: "Karmana tuman kutubxonasi",
        tumanId: "t1",
        viloyatId: "v1",
      });

      const result = await service.generateAiReport("lib-1");

      expect(result.html).toContain("Karmana tuman kutubxonasi");
      expect(result.summary).toContain("Karmana tuman kutubxonasi");
      expect(Array.isArray(result.insights)).toBe(true);
      expect(result.insights.length).toBeGreaterThan(0);
    });
  });
});
