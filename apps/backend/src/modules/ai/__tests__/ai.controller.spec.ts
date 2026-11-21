import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { AiController } from "../ai.controller";
import type { AiService } from "../ai.service";
import type { FraudService } from "../fraud.service";
import type { RecommendService } from "../recommend.service";
import type { PredictService } from "../predict.service";
import type { PrismaService } from "../../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";

/**
 * AiController — T6: controller qatlami coverage'ga kirdi.
 *
 * Tekshiradi: RBAC metadata (fraud/predict/audit — faqat adminlar, Top-100
 * fraud tekshiruvi va audit-log yaratish — faqat SUPER_ADMIN), review-queue'ning
 * hududiy scope'i (tuman/viloyat admin — o'z hududi, SUPER_ADMIN — butun mamlakat,
 * limit ≤ 200), decision validatsiyasi va default parametrlar (minRisk 50, limit 50,
 * months 1, recommendations 5, issue RI_DROP).
 */
/** Controller handler (metadata o'qish uchun). */
type Handler = (...args: never[]) => unknown;
const roles = (h: Handler) => new Reflector().get<UserRole[]>(ROLES_KEY, h);
const ADMIN_ROLES = [UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN, UserRole.MUASSASA_ADMIN];
const req = (role: UserRole = UserRole.SUPER_ADMIN, sub = "admin-1") => ({ user: { sub, role } });

describe("AiController", () => {
  let controller: AiController;
  let aiService: Record<string, jest.Mock>;
  let fraudService: Record<string, jest.Mock>;
  let recommendService: Record<string, jest.Mock>;
  let predictService: Record<string, jest.Mock>;
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    const mocks = (names: string[]) =>
      Object.fromEntries(names.map((m) => [m, jest.fn().mockResolvedValue({ ok: m })]));
    aiService = mocks([
      "query", "getNlqHistory", "getFraudStats", "getFraudList", "analyzeUserFraud",
      "checkTop100Fraud", "getAuditLogs", "createAuditLog", "resolveAuditLog", "generateAiReport",
    ]);
    fraudService = mocks(["getReviewQueue", "resolveReview"]);
    recommendService = mocks(["getRecommendations", "getClubRecommendations"]);
    predictService = mocks(["nationalGoalForecast", "predictTumanRi", "predictFundShortage", "analyzeRootCause"]);
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ address: { tumanId: "UZ-08-012", viloyatId: "UZ-08" } }),
      },
    };
    controller = new AiController(
      aiService as unknown as AiService,
      fraudService as unknown as FraudService,
      recommendService as unknown as RecommendService,
      predictService as unknown as PredictService,
      prisma as unknown as PrismaService
    );
  });

  // ── Guard va RBAC metadata ─────────────────────────────────────────────────
  it("class darajasida JwtAuthGuard; admin route'larida RolesGuard + @Roles", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AiController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.query)).toEqual([RolesGuard]);
    expect(roles(controller.query)).toEqual(ADMIN_ROLES);
    expect(roles(controller.getAuditLogs)).toEqual(ADMIN_ROLES);
    expect(roles(controller.predictFundShortage)).toEqual(ADMIN_ROLES);
  });

  it("RBAC: fraud ro'yxati/queue — hududiy adminlar (muassasa emas); Top-100 fraud va audit-log yaratish — faqat SUPER_ADMIN", () => {
    const regional = [UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN];
    expect(roles(controller.getFraudStats)).toEqual(regional);
    expect(roles(controller.getFraudList)).toEqual(regional);
    expect(roles(controller.getFraudReviewQueue)).toEqual(regional);
    expect(roles(controller.resolveFraudReview)).toEqual(regional);
    expect(roles(controller.analyzeUserFraud)).toEqual([UserRole.SUPER_ADMIN, UserRole.TUMAN_ADMIN]);
    expect(roles(controller.checkTop100Fraud)).toEqual([UserRole.SUPER_ADMIN]);
    expect(roles(controller.createAuditLog)).toEqual([UserRole.SUPER_ADMIN]);
    expect(roles(controller.nationalGoalForecast)).toEqual([UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN]);
    // Boshqa foydalanuvchi/klub tavsiyalari — o'qish tarixi haqida ma'lumot (R5):
    // 2026-10-31 gacha @Roles'siz edi, endi faqat adminlar (klub — rahbari ham)
    expect(roles(controller.getRecommendationsForUser)).toEqual(ADMIN_ROLES);
    expect(roles(controller.getRecommendations)).toEqual(ADMIN_ROLES);
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.getRecommendations)).toEqual([RolesGuard]);
    expect(roles(controller.getClubRecommendations)).toEqual([...ADMIN_ROLES, UserRole.KLUB_RAHBARI]);
    for (const h of [controller.getFraudList, controller.query, controller.getAuditLogs]) {
      expect(roles(h)).not.toContain(UserRole.KITOBXON);
    }
  });

  it("o'z tavsiyalari va NLQ tarixi — har qanday autentifikatsiyalangan foydalanuvchi (@Roles yo'q), faqat o'zi (req.user.sub)", async () => {
    expect(roles(controller.getMyRecommendations)).toBeUndefined();
    expect(roles(controller.getNlqHistory)).toBeUndefined();
    await controller.getMyRecommendations(req(UserRole.KITOBXON, "reader-1"));
    expect(recommendService.getRecommendations).toHaveBeenCalledWith("reader-1", 5);
    await controller.getMyRecommendations(req(UserRole.KITOBXON, "reader-1"), "3");
    expect(recommendService.getRecommendations).toHaveBeenLastCalledWith("reader-1", 3);
    await controller.getNlqHistory(req(UserRole.KITOBXON, "reader-1"));
    expect(aiService.getNlqHistory).toHaveBeenCalledWith("reader-1");
  });

  // ── NLQ ────────────────────────────────────────────────────────────────────
  it("query: savol va so'rovchi id'si aiService'ga", async () => {
    await controller.query({ question: "Navoiyda bu oy kitobxonlik qanday?" }, req());
    expect(aiService.query).toHaveBeenCalledWith("Navoiyda bu oy kitobxonlik qanday?", "admin-1");
  });

  // ── Fraud ──────────────────────────────────────────────────────────────────
  it("fraud: stats/list/analyze/top100 delegatsiya; list default minRisk 50, limit 50", async () => {
    await controller.getFraudStats();
    expect(aiService.getFraudStats).toHaveBeenCalledTimes(1);
    await controller.getFraudList();
    expect(aiService.getFraudList).toHaveBeenCalledWith(50, 50);
    await controller.getFraudList("70", "10");
    expect(aiService.getFraudList).toHaveBeenLastCalledWith(70, 10);
    await controller.analyzeUserFraud("u-9");
    expect(aiService.analyzeUserFraud).toHaveBeenCalledWith("u-9");
    await controller.checkTop100Fraud();
    expect(aiService.checkTop100Fraud).toHaveBeenCalledTimes(1);
  });

  it("review-queue: SUPER_ADMIN — butun mamlakat (DB so'ralmaydi), default limit 50 / offset 0", async () => {
    await controller.getFraudReviewQueue(req());
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(fraudService.getReviewQueue).toHaveBeenCalledWith({
      tier: "SUPER_ADMIN", scopeId: undefined, limit: 50, offset: 0,
    });
  });

  it("review-queue: TUMAN_ADMIN — o'z tumani, VILOYAT_ADMIN — o'z viloyati (manzil DB'dan), limit 200 bilan cheklanadi", async () => {
    await controller.getFraudReviewQueue(req(UserRole.TUMAN_ADMIN, "tuman-1"), "500", "10");
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tuman-1" } }));
    expect(fraudService.getReviewQueue).toHaveBeenCalledWith({
      tier: "TUMAN_ADMIN", scopeId: "UZ-08-012", limit: 200, offset: 10,
    });

    await controller.getFraudReviewQueue(req(UserRole.VILOYAT_ADMIN, "vil-1"), "20");
    expect(fraudService.getReviewQueue).toHaveBeenLastCalledWith({
      tier: "VILOYAT_ADMIN", scopeId: "UZ-08", limit: 20, offset: 0,
    });
  });

  it("review-queue: admin manzili yo'q bo'lsa scopeId undefined (servis bo'sh ro'yxat qaytaradi, xato emas)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await controller.getFraudReviewQueue(req(UserRole.TUMAN_ADMIN, "tuman-2"));
    expect(fraudService.getReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ tier: "TUMAN_ADMIN", scopeId: undefined }));
  });

  it("resolveFraudReview: decision faqat approve/reject; ko'rib chiquvchi = req.user.sub", async () => {
    expect(() =>
      controller.resolveFraudReview(req(), "u-9", { decision: "maybe" as never })
    ).toThrow(BadRequestException);
    expect(fraudService.resolveReview).not.toHaveBeenCalled();
    await controller.resolveFraudReview(req(UserRole.TUMAN_ADMIN, "tuman-1"), "u-9", { decision: "approve", notes: "tekshirildi" });
    expect(fraudService.resolveReview).toHaveBeenCalledWith("tuman-1", "u-9", "approve", "tekshirildi");
  });

  // ── Audit loglar ───────────────────────────────────────────────────────────
  it("audit-logs: resolved 'true'/'false' → boolean, berilmasa undefined; limit Number", async () => {
    await controller.getAuditLogs();
    expect(aiService.getAuditLogs).toHaveBeenCalledWith({ scope: undefined, severity: undefined, resolved: undefined, limit: undefined });
    await controller.getAuditLogs("tuman", "KRITIK", "false", "25");
    expect(aiService.getAuditLogs).toHaveBeenLastCalledWith({ scope: "tuman", severity: "KRITIK", resolved: false, limit: 25 });
    await controller.getAuditLogs(undefined, undefined, "true");
    expect(aiService.getAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({ resolved: true }));

    const body = { scope: "tuman", scopeId: "UZ-08-012", issueType: "RI_DROP", severity: "KRITIK" } as never;
    await controller.createAuditLog(body);
    expect(aiService.createAuditLog).toHaveBeenCalledWith(body);
    await controller.resolveAuditLog("log-1");
    expect(aiService.resolveAuditLog).toHaveBeenCalledWith("log-1");
  });

  // ── Bashorat va sabab tahlili ──────────────────────────────────────────────
  it("predict: milliy maqsad, tuman RI (months default 1), fond yetishmovchiligi, scope RI", async () => {
    await controller.nationalGoalForecast();
    expect(predictService.nationalGoalForecast).toHaveBeenCalledTimes(1);
    await controller.predictTumanRi("UZ-08-012");
    expect(predictService.predictTumanRi).toHaveBeenCalledWith("UZ-08-012", 1);
    await controller.predictTumanRi("UZ-08-012", "3");
    expect(predictService.predictTumanRi).toHaveBeenLastCalledWith("UZ-08-012", 3);
    await controller.predictFundShortage("lib-1");
    expect(predictService.predictFundShortage).toHaveBeenCalledWith("lib-1");
    await controller.predictScopeRi("tuman", "UZ-08-012", "2");
    expect(predictService.predictTumanRi).toHaveBeenLastCalledWith("UZ-08-012", 2);
  });

  it("root-cause: issue default RI_DROP (tuman va scope variantlari)", async () => {
    await controller.analyzeRootCause("UZ-08-012");
    expect(predictService.analyzeRootCause).toHaveBeenCalledWith("UZ-08-012", "RI_DROP");
    await controller.analyzeRootCause("UZ-08-012", "LOW_COVERAGE");
    expect(predictService.analyzeRootCause).toHaveBeenLastCalledWith("UZ-08-012", "LOW_COVERAGE");
    await controller.predictScopeCauses("tuman", "UZ-08-012", "INACTIVE_LIBRARY");
    expect(predictService.analyzeRootCause).toHaveBeenLastCalledWith("UZ-08-012", "INACTIVE_LIBRARY");
  });

  // ── Tavsiyalar va hisobot ──────────────────────────────────────────────────
  it("tavsiyalar: foydalanuvchi/klub bo'yicha, limit default 5", async () => {
    await controller.getRecommendationsForUser("u-2");
    expect(recommendService.getRecommendations).toHaveBeenCalledWith("u-2", 5);
    await controller.getRecommendations("u-3", "8");
    expect(recommendService.getRecommendations).toHaveBeenLastCalledWith("u-3", 8);
    await controller.getClubRecommendations("c-1");
    expect(recommendService.getClubRecommendations).toHaveBeenCalledWith("c-1", 5);
    await controller.generateReport("lib-1");
    expect(aiService.generateAiReport).toHaveBeenCalledWith("lib-1");
  });
});
