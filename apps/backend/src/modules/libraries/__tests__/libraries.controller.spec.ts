import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { LibraryStatus, LibraryType, UserRole } from "@prisma/client";
import { LibrariesController } from "../libraries.controller";
import type { LibrariesService } from "../libraries.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import type { JwtPayload } from "../../../common/decorators/current-user.decorator";

/**
 * LibrariesController — T6: controller qatlami coverage'ga kirdi.
 *
 * Tekshiradi: qaysi route ochiq (@Public — ro'yxat, yaqin kutubxonalar, kod/ID
 * bo'yicha profil), qaysi faqat SUPER_ADMIN (tasdiq/rad/muzlatish/o'chirish —
 * TZ §13.2 "faqat admin qo'lda"), hamda handler'lar servisga so'rovchi (sub/rol)
 * bilan delegatsiya qilishi — `update` uchun bu IDOR tuzatishining kirish nuqtasi.
 */
/** Controller handler (metadata o'qish uchun). */
type Handler = (...args: never[]) => unknown;
const roles = (h: Handler) => new Reflector().get<UserRole[]>(ROLES_KEY, h);
const isPublic = (h: Handler) => new Reflector().get<boolean>(IS_PUBLIC_KEY, h);
const guards = (h: Handler) => Reflect.getMetadata(GUARDS_METADATA, h);
const user = { sub: "u-admin", role: UserRole.MUASSASA_ADMIN } as unknown as JwtPayload;

describe("LibrariesController", () => {
  let controller: LibrariesController;
  let svc: Record<string, jest.Mock>;

  beforeEach(() => {
    svc = Object.fromEntries(
      [
        "findAll", "getManageableLibraries", "getMyInstitutionLibrary", "findNearby", "findByCode",
        "findOne", "create", "update", "approveByTuman", "approveBySuperAdmin", "reject", "freeze",
        "unfreeze", "softDelete", "getInventoryReport", "confirmTransfer",
      ].map((m) => [m, jest.fn().mockResolvedValue({ ok: m })])
    );
    controller = new LibrariesController(svc as unknown as LibrariesService);
  });

  it("ochiq route'lar: ro'yxat, yaqin kutubxonalar, kod va ID bo'yicha profil (@Public)", () => {
    for (const h of [controller.findAll, controller.findNearby, controller.findByCode, controller.findOne]) {
      expect(isPublic(h)).toBe(true);
      expect(roles(h)).toBeUndefined();
    }
    // 'mine' va 'my-institution' — faqat autentifikatsiya, rol cheklovisiz
    for (const h of [controller.getMine, controller.getMyInstitutionLibrary]) {
      expect(isPublic(h)).toBeUndefined();
      expect(guards(h)).toEqual([JwtAuthGuard]);
      expect(roles(h)).toBeUndefined();
    }
  });

  it("RBAC: yaratish/tahrirlash — SUPER_ADMIN + MUASSASA_ADMIN; tasdiq/rad/muzlatish/o'chirish — faqat SUPER_ADMIN", () => {
    expect(roles(controller.create)).toEqual([UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN]);
    expect(roles(controller.update)).toEqual([UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN]);
    expect(guards(controller.update)).toEqual([JwtAuthGuard, RolesGuard]);
    for (const h of [
      controller.approveByTuman, controller.approveBySuperAdmin, controller.reject,
      controller.freeze, controller.unfreeze, controller.softDelete,
    ]) {
      expect(roles(h)).toEqual([UserRole.SUPER_ADMIN]);
    }
    expect(roles(controller.getInventory)).toEqual(
      expect.arrayContaining([UserRole.KUTUBXONACHI, UserRole.TUMAN_ADMIN, UserRole.MUASSASA_ADMIN])
    );
    expect(roles(controller.confirmTransfer)).toEqual(
      expect.arrayContaining([UserRole.KUTUBXONACHI, UserRole.VILOYAT_ADMIN])
    );
    expect(roles(controller.confirmTransfer)).not.toContain(UserRole.MUASSASA_ADMIN);
    expect(roles(controller.confirmTransfer)).not.toContain(UserRole.KITOBXON);
  });

  it("ochiq qidiruv: findAll filtrlari, nearby parseFloat + radius default 10 km, kod/ID", async () => {
    await controller.findAll(LibraryStatus.ACTIVE, LibraryType.SCH, "UZ-08-012");
    expect(svc.findAll).toHaveBeenCalledWith(LibraryStatus.ACTIVE, LibraryType.SCH, "UZ-08-012");
    await controller.findAll();
    expect(svc.findAll).toHaveBeenLastCalledWith(undefined, undefined, undefined);

    await controller.findNearby("41.31", "69.28");
    expect(svc.findNearby).toHaveBeenCalledWith(41.31, 69.28, 10, undefined);
    await controller.findNearby("41.31", "69.28", "2.5", "Alpomish");
    expect(svc.findNearby).toHaveBeenLastCalledWith(41.31, 69.28, 2.5, "Alpomish");

    await controller.findByCode("LIB-SCH-08012-008");
    expect(svc.findByCode).toHaveBeenCalledWith("LIB-SCH-08012-008");
    await controller.findOne("lib-1");
    expect(svc.findOne).toHaveBeenCalledWith("lib-1");
  });

  it("mine / my-institution: so'rovchi JWT'dan (sub + rol / id)", async () => {
    await controller.getMine(user);
    expect(svc.getManageableLibraries).toHaveBeenCalledWith({ sub: "u-admin", role: UserRole.MUASSASA_ADMIN });
    await controller.getMyInstitutionLibrary("u-reader");
    expect(svc.getMyInstitutionLibrary).toHaveBeenCalledWith("u-reader");
  });

  it("create / update: dto + so'rovchi (update'da {sub, role} — egalik tekshiruvi servisda, IDOR)", async () => {
    const createDto = { name: "8-maktab kutubxonasi", type: LibraryType.SCH } as never;
    await controller.create(createDto, user);
    expect(svc.create).toHaveBeenCalledWith(createDto, "u-admin");

    const updateDto = { address: "Karmana, 1-uy", phone: "+998712000000" } as never;
    await controller.update("lib-1", updateDto, user);
    expect(svc.update).toHaveBeenCalledWith("lib-1", updateDto, { sub: "u-admin", role: UserRole.MUASSASA_ADMIN });
  });

  it("holat boshqaruvi: approve/reject/freeze/unfreeze/softDelete — id, sabab/tasdiq va admin sub", async () => {
    const admin = { sub: "u-super", role: UserRole.SUPER_ADMIN } as unknown as JwtPayload;
    await controller.approveByTuman("lib-1", admin);
    expect(svc.approveByTuman).toHaveBeenCalledWith("lib-1", "u-super");
    await controller.approveBySuperAdmin("lib-1", admin);
    expect(svc.approveBySuperAdmin).toHaveBeenCalledWith("lib-1", "u-super");
    await controller.reject("lib-1", "Hujjat to'liq emas", admin);
    expect(svc.reject).toHaveBeenCalledWith("lib-1", "u-super", "Hujjat to'liq emas");
    await controller.freeze("lib-1", "To'lov yo'q", admin);
    expect(svc.freeze).toHaveBeenCalledWith("lib-1", "To'lov yo'q", "u-super");
    await controller.unfreeze("lib-1", admin);
    expect(svc.unfreeze).toHaveBeenCalledWith("lib-1", "u-super");
    await controller.softDelete("lib-1", "ROZIMAN", admin);
    expect(svc.softDelete).toHaveBeenCalledWith("lib-1", "ROZIMAN", "u-super");
  });

  it("inventarizatsiya hisoboti va roaming transfer tasdig'i", async () => {
    await controller.getInventory("lib-1");
    expect(svc.getInventoryReport).toHaveBeenCalledWith("lib-1");
    const librarian = { sub: "u-lib", role: UserRole.KUTUBXONACHI } as unknown as JwtPayload;
    await controller.confirmTransfer("lib-1", "tr-1", librarian);
    expect(svc.confirmTransfer).toHaveBeenCalledWith("lib-1", "tr-1", { id: "u-lib", role: UserRole.KUTUBXONACHI });
  });
});
