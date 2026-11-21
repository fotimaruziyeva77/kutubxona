import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserGender, UserRole, UserType } from "@prisma/client";
import { TopController } from "../top.controller";
import type { TopService } from "../top.service";
import type { InstitutionalService } from "../institutional.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";

/**
 * TopController — T6: controller qatlami coverage'ga kirdi.
 *
 * Tekshiradi: ochiq reytinglar (TZ §5.3 — sifat.uz/top login'siz), Top-100
 * tasdiqlash oqimi (TZ §5.4: hisoblash → flag → tasdiq) FAQAT SUPER_ADMIN,
 * parametr konversiyalari (limit/offset parseInt, filtrlar o'z nomi bilan).
 */
/** Controller handler (metadata o'qish uchun). */
type Handler = (...args: never[]) => unknown;
const roles = (h: Handler) => new Reflector().get<UserRole[]>(ROLES_KEY, h);
const isPublic = (h: Handler) => new Reflector().get<boolean>(IS_PUBLIC_KEY, h);

describe("TopController", () => {
  let controller: TopController;
  let svc: Record<string, jest.Mock>;
  let institutional: Record<string, jest.Mock>;

  beforeEach(() => {
    svc = Object.fromEntries(
      [
        "getTop100", "getAvailableMonths", "getRegionalRanking", "getDraftMonth", "getAdminReviewQueue",
        "computeMonthlyTop100", "confirmMonth", "flagUser", "clearFlag", "rejectEntry", "confirmEntry",
      ].map((m) => [m, jest.fn().mockResolvedValue({ ok: m })])
    );
    institutional = { getInstitutionalRanking: jest.fn().mockResolvedValue([]) };
    controller = new TopController(svc as unknown as TopService, institutional as unknown as InstitutionalService);
  });

  it("ochiq reytinglar: Top-100, oylar, hududiy, muassasa — @Public", () => {
    for (const h of [controller.getTop100, controller.getAvailableMonths, controller.getRegional, controller.getInstitutional]) {
      expect(isPublic(h)).toBe(true);
      expect(roles(h)).toBeUndefined();
    }
  });

  it("tasdiqlash oqimi (draft, review-queue, compute, confirm, flag, clear, reject, confirmOne) — faqat SUPER_ADMIN", () => {
    for (const h of [
      controller.getDraft, controller.getAdminReviewQueue, controller.compute, controller.confirm,
      controller.flag, controller.clearFlag, controller.reject, controller.confirmOne,
    ]) {
      expect(roles(h)).toEqual([UserRole.SUPER_ADMIN]);
      expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([JwtAuthGuard, RolesGuard]);
      expect(isPublic(h)).toBeUndefined();
    }
  });

  it("getTop100: filtrlar nomi bilan, limit/offset parseInt, berilmasa undefined", async () => {
    await controller.getTop100();
    expect(svc.getTop100).toHaveBeenCalledWith({
      month: undefined, gender: undefined, ageGroup: undefined, userType: undefined, limit: undefined, offset: undefined,
    });
    await controller.getTop100("2026-10", UserGender.FEMALE, "15-30", UserType.STUDENT_UNIVERSITY, "100", "200");
    expect(svc.getTop100).toHaveBeenLastCalledWith({
      month: "2026-10", gender: UserGender.FEMALE, ageGroup: "15-30", userType: UserType.STUDENT_UNIVERSITY, limit: 100, offset: 200,
    });
  });

  it("oylar / hududiy / muassasa reytinglari — delegatsiya (institutional'ga TopService ham uzatiladi)", async () => {
    await controller.getAvailableMonths();
    expect(svc.getAvailableMonths).toHaveBeenCalledTimes(1);
    await controller.getRegional("viloyat");
    expect(svc.getRegionalRanking).toHaveBeenCalledWith("viloyat");
    await controller.getInstitutional("maktab", "50", "0", "2026-10");
    expect(institutional.getInstitutionalRanking).toHaveBeenCalledWith(
      "maktab",
      { limit: 50, offset: 0, month: "2026-10" },
      svc
    );
    await controller.getInstitutional("otm");
    expect(institutional.getInstitutionalRanking).toHaveBeenLastCalledWith(
      "otm",
      { limit: undefined, offset: undefined, month: undefined },
      svc
    );
  });

  it("admin oqimi: draft/review-queue oy bo'yicha, compute, oy tasdig'i", async () => {
    await controller.getDraft("2026-10");
    expect(svc.getDraftMonth).toHaveBeenCalledWith("2026-10");
    await controller.getAdminReviewQueue();
    expect(svc.getAdminReviewQueue).toHaveBeenCalledWith(undefined);
    await controller.compute();
    expect(svc.computeMonthlyTop100).toHaveBeenCalledTimes(1);
    await controller.confirm("2026-10");
    expect(svc.confirmMonth).toHaveBeenCalledWith("2026-10");
  });

  it("bitta ishtirokchi: flag (sabab ixtiyoriy, body bo'lmasa ham), clear, reject, confirm", async () => {
    await controller.flag("2026-10", "u-1", { reason: "bir kunda 9 kitob" });
    expect(svc.flagUser).toHaveBeenCalledWith("2026-10", "u-1", "bir kunda 9 kitob");
    await controller.flag("2026-10", "u-2", undefined as never);
    expect(svc.flagUser).toHaveBeenLastCalledWith("2026-10", "u-2", undefined);
    await controller.clearFlag("2026-10", "u-1");
    expect(svc.clearFlag).toHaveBeenCalledWith("2026-10", "u-1");
    await controller.reject("2026-10", "u-1");
    expect(svc.rejectEntry).toHaveBeenCalledWith("2026-10", "u-1");
    await controller.confirmOne("2026-10", "u-1");
    expect(svc.confirmEntry).toHaveBeenCalledWith("2026-10", "u-1");
  });
});
