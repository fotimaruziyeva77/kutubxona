import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import type { Request } from "express";
import { ClubController } from "../club.controller";
import type { ClubService } from "../club.service";
import type { ClubConsentService } from "../consent/club-consent.service";
import type { DebateMediaService } from "../media/debate-media.service";
import type { CacheService } from "../../../infra/cache/cache.service";
import type { PrismaService } from "../../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import type { JwtPayload } from "../../../common/decorators/current-user.decorator";

/**
 * ClubController (Jadidlar izidan) — T6: controller qatlami coverage'ga kirdi.
 *
 * Nimani tekshiradi:
 *  - RBAC metadata: qaysi route kimga ochiq (@Roles / @Public) — PQ-9 8-band
 *    klublari faqat muassasa/tuman/viloyat adminlari va klub rahbari uchun;
 *  - ota-ona rozilik endpoint'lari: ochiq, lekin IP bo'yicha rate-limit (10/soat);
 *  - handler'lar servisga TO'G'RI argumentlar bilan delegatsiya qiladi
 *    (default limit/offset/kun, Date konversiyasi, actor = DB'dagi rol + manzil).
 */
const payload = { sub: "u-leader", role: UserRole.KLUB_RAHBARI } as unknown as JwtPayload;

function makeReq(forwarded?: string, remote = "9.9.9.9"): Request {
  return {
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    socket: { remoteAddress: remote },
  } as unknown as Request;
}

/** Controller handler (metadata o'qish uchun). */
type Handler = (...args: never[]) => unknown;
const roles = (h: Handler) => new Reflector().get<UserRole[]>(ROLES_KEY, h);
const isPublic = (h: Handler) => new Reflector().get<boolean>(IS_PUBLIC_KEY, h);

describe("ClubController", () => {
  let controller: ClubController;
  let clubService: Record<string, jest.Mock>;
  let consentService: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let mediaService: Record<string, jest.Mock>;
  let prisma: { user: { findUnique: jest.Mock } };

  const dbUser = {
    role: UserRole.KLUB_RAHBARI,
    schoolId: "school-8",
    universityId: null,
    organizationId: null,
    address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
  };
  const expectedActor = {
    id: "u-leader",
    role: UserRole.KLUB_RAHBARI,
    schoolId: "school-8",
    universityId: null,
    organizationId: null,
    address: { viloyatId: "UZ-08", tumanId: "UZ-08-012" },
  };

  beforeEach(() => {
    clubService = Object.fromEntries(
      [
        "createClub", "listClubs", "getInactiveClubs", "getClub", "updateClub",
        "getClubMonitoring", "getGoalProgress", "getMembers", "addMember",
        "confirmParentConsent", "removeMember", "createDebate", "getDebates",
      ].map((m) => [m, jest.fn().mockResolvedValue({ ok: m })])
    );
    consentService = {
      peek: jest.fn().mockResolvedValue({ clubName: "8-maktab klubi" }),
      confirmByToken: jest.fn().mockResolvedValue({ status: "APPROVED" }),
    };
    cache = { incrWithTtl: jest.fn().mockResolvedValue(1) };
    mediaService = {
      uploadDebateMedia: jest.fn().mockResolvedValue({ id: "m1" }),
      finalizeDebate: jest.fn().mockResolvedValue({ finalized: true }),
      listDebateMedia: jest.fn().mockResolvedValue([]),
    };
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(dbUser) } };
    controller = new ClubController(
      clubService as unknown as ClubService,
      consentService as unknown as ClubConsentService,
      cache as unknown as CacheService,
      mediaService as unknown as DebateMediaService,
      prisma as unknown as PrismaService
    );
  });

  // ── Guard va RBAC metadata ─────────────────────────────────────────────────
  it("class darajasida JwtAuthGuard + RolesGuard (default-deny)", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ClubController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("RBAC: klub yaratish faqat admin'lar, a'zo chiqarish/debat — klub rahbari ham", () => {
    expect(roles(controller.createClub)).toEqual([
      UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.TUMAN_ADMIN,
    ]);
    expect(roles(controller.createClub)).not.toContain(UserRole.KLUB_RAHBARI);
    expect(roles(controller.removeMember)).toContain(UserRole.KLUB_RAHBARI);
    expect(roles(controller.createDebate)).toContain(UserRole.KLUB_RAHBARI);
    expect(roles(controller.listClubs)).toEqual(
      expect.arrayContaining([UserRole.VILOYAT_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.KLUB_RAHBARI])
    );
    // Faolsiz klublar — hududiy monitoring, klub rahbari ko'rmaydi
    expect(roles(controller.getInactiveClubs)).toEqual([
      UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN,
    ]);
    for (const h of [controller.createClub, controller.getClub, controller.getMembers, controller.uploadDebateMedia]) {
      expect(roles(h)).not.toContain(UserRole.KITOBXON);
    }
  });

  it("ota-ona rozilik endpoint'lari @Public (SMS havolasi login'siz ochiladi) va @Roles'siz", () => {
    expect(isPublic(controller.getConsentInfo)).toBe(true);
    expect(isPublic(controller.submitConsent)).toBe(true);
    expect(roles(controller.getConsentInfo)).toBeUndefined();
    expect(roles(controller.submitConsent)).toBeUndefined();
    expect(isPublic(controller.createClub)).toBeUndefined();
  });

  // ── Rozilik: rate-limit va validatsiya ─────────────────────────────────────
  it("consent/info: token bo'lmasa 400, bo'lsa peek(token)", async () => {
    await expect(controller.getConsentInfo("", makeReq())).rejects.toThrow(BadRequestException);
    await expect(controller.getConsentInfo("tok-1", makeReq())).resolves.toEqual({ clubName: "8-maktab klubi" });
    expect(consentService.peek).toHaveBeenCalledWith("tok-1");
  });

  it("consent: IP bo'yicha 10 so'rov/soat — kalit x-forwarded-for'ning BIRINCHI IP'si, 11-chi so'rov 400", async () => {
    await controller.getConsentInfo("tok", makeReq("203.0.113.7, 10.0.0.1"));
    expect(cache.incrWithTtl).toHaveBeenCalledWith("consent-rl:203.0.113.7", 3600);

    await controller.getConsentInfo("tok", makeReq(undefined, "198.51.100.2"));
    expect(cache.incrWithTtl).toHaveBeenLastCalledWith("consent-rl:198.51.100.2", 3600);

    cache.incrWithTtl.mockResolvedValueOnce(11);
    await expect(controller.getConsentInfo("tok", makeReq())).rejects.toThrow("Juda ko'p so'rov");
    expect(consentService.peek).toHaveBeenCalledTimes(2);
  });

  it("consent submit: token kerak, action faqat APPROVE/REJECT, keyin confirmByToken", async () => {
    await expect(
      controller.submitConsent({ token: "", action: "APPROVE" }, makeReq())
    ).rejects.toThrow("Token kerak");
    await expect(
      controller.submitConsent({ token: "t", action: "MAYBE" as never }, makeReq())
    ).rejects.toThrow("APPROVE yoki REJECT");
    await expect(controller.submitConsent({ token: "t", action: "REJECT" }, makeReq())).resolves.toEqual({
      status: "APPROVED",
    });
    expect(consentService.confirmByToken).toHaveBeenCalledWith("t", "REJECT");
  });

  // ── Oddiy delegatsiya va default'lar ───────────────────────────────────────
  it("createClub / getClub / monitoring / goal-progress / members — to'g'ridan-to'g'ri delegatsiya", async () => {
    const body = { name: "Jadidlar", institutionId: "i1", leaderId: "u-leader", goal: 20 };
    await controller.createClub(body);
    expect(clubService.createClub).toHaveBeenCalledWith(body);
    await controller.getClub("c1");
    await controller.getMonitoring("c1");
    await controller.getGoalProgress("c1");
    await controller.getMembers("c1");
    expect(clubService.getClub).toHaveBeenCalledWith("c1");
    expect(clubService.getClubMonitoring).toHaveBeenCalledWith("c1");
    expect(clubService.getGoalProgress).toHaveBeenCalledWith("c1");
    expect(clubService.getMembers).toHaveBeenCalledWith("c1");
  });

  it("listClubs: limit/offset default 50/0, berilsa Number", async () => {
    await controller.listClubs();
    expect(clubService.listClubs).toHaveBeenCalledWith({
      institutionId: undefined, tumanId: undefined, status: undefined, limit: 50, offset: 0,
    });
    await controller.listClubs("i1", "t1", "ACTIVE", "10", "20");
    expect(clubService.listClubs).toHaveBeenLastCalledWith({
      institutionId: "i1", tumanId: "t1", status: "ACTIVE", limit: 10, offset: 20,
    });
  });

  it("getInactiveClubs: default 45 kun (TZ §7.2 — klub 45 kun debat o'tkazmasa)", async () => {
    await controller.getInactiveClubs("t1");
    expect(clubService.getInactiveClubs).toHaveBeenCalledWith("t1", 45);
    await controller.getInactiveClubs("t1", "30");
    expect(clubService.getInactiveClubs).toHaveBeenLastCalledWith("t1", 30);
  });

  it("getDebates delegatsiya (clubId uzatiladi)", async () => {
    await controller.getDebates("c1", "2026-01-01", "2026-02-01", "5");
    expect(clubService.getDebates).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(clubService.getDebates.mock.calls[0])).toContain("c1");
  });

  // ── Actor (egalik) — DB'dagi rol va manzil bilan ───────────────────────────
  it("updateClub / addMember / confirmConsent / removeMember: actor DB'dan (rol, muassasa, manzil) + id = sub", async () => {
    await controller.updateClub("c1", { goal: 25 }, payload);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-leader" } }));
    expect(clubService.updateClub).toHaveBeenCalledWith(expectedActor, "c1", { goal: 25 });

    await controller.addMember("c1", { userId: "s-1", parentPhone: "+998901112233" }, payload);
    expect(clubService.addMember).toHaveBeenCalledWith(expectedActor, "c1", "s-1", "+998901112233");

    await controller.confirmConsent("m-1", { parentPhone: "+998901112233" }, payload);
    expect(clubService.confirmParentConsent).toHaveBeenCalledWith(expectedActor, "m-1", "+998901112233");

    await controller.removeMember("c1", "s-1", payload);
    expect(clubService.removeMember).toHaveBeenCalledWith(expectedActor, "c1", "s-1");
  });

  it("actor: foydalanuvchi DB'da topilmasa rol JWT'dan, qolganlari null (403 servis qatlamida)", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await controller.removeMember("c1", "s-1", payload);
    expect(clubService.removeMember).toHaveBeenCalledWith(
      {
        id: "u-leader",
        role: UserRole.KLUB_RAHBARI,
        schoolId: null,
        universityId: null,
        organizationId: null,
        address: { viloyatId: null, tumanId: null },
      },
      "c1",
      "s-1"
    );
  });

  it("createDebate: heldAt → Date, clubId path'dan, qolgan maydonlar body'dan", async () => {
    await controller.createDebate(
      "c1",
      { topic: "Alpomish", heldAt: "2026-03-15T10:00:00.000Z", venue: "Zal", participants: 12, mediaUrls: ["a.jpg"] },
      payload
    );
    expect(clubService.createDebate).toHaveBeenCalledWith(expectedActor, {
      topic: "Alpomish",
      venue: "Zal",
      participants: 12,
      summary: undefined,
      mediaUrls: ["a.jpg"],
      clubId: "c1",
      heldAt: new Date("2026-03-15T10:00:00.000Z"),
    });
  });

  // ── Debat media ────────────────────────────────────────────────────────────
  it("uploadDebateMedia: fayl yo'q → 400; bor → buffer/nom/mime/hajm bilan mediaService", async () => {
    await expect(
      controller.uploadDebateMedia("c1", "d1", undefined as unknown as Express.Multer.File, payload)
    ).rejects.toThrow("Fayl topilmadi");
    expect(mediaService.uploadDebateMedia).not.toHaveBeenCalled();

    const file = {
      buffer: Buffer.from("img"), originalname: "debat.jpg", mimetype: "image/jpeg", size: 3,
    } as unknown as Express.Multer.File;
    await controller.uploadDebateMedia("c1", "d1", file, payload);
    expect(mediaService.uploadDebateMedia).toHaveBeenCalledWith(expectedActor, "c1", "d1", {
      buffer: file.buffer, originalname: "debat.jpg", mimetype: "image/jpeg", size: 3,
    });
  });

  it("finalizeDebate / listDebateMedia: actor bilan delegatsiya", async () => {
    await controller.finalizeDebate("c1", "d1", payload);
    expect(mediaService.finalizeDebate).toHaveBeenCalledWith(expectedActor, "c1", "d1");
    await controller.listDebateMedia("c1", "d1", payload);
    expect(mediaService.listDebateMedia).toHaveBeenCalledWith(expectedActor, "c1", "d1");
  });
});
