import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import type { Response } from "express";
import { BooksController } from "../books.controller";
import type { BooksService } from "../books.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";

/**
 * BooksController — T6: controller qatlami coverage'ga kirdi.
 *
 * Tekshiradi: ochiq katalog (ro'yxat, qidiruv, ISBN, bitta kitob — login'siz),
 * fond boshqaruvi faqat kutubxonachi/muassasa admin/super admin, o'chirish —
 * kutubxonachiga EMAS; QR skan — kutubxonachi; Excel shablon javob sarlavhalari;
 * import — fayl buferi + kutubxona + so'rovchi bilan navbatga.
 */
/** Controller handler (metadata o'qish uchun). */
type Handler = (...args: never[]) => unknown;
const roles = (h: Handler) => new Reflector().get<UserRole[]>(ROLES_KEY, h);
const isPublic = (h: Handler) => new Reflector().get<boolean>(IS_PUBLIC_KEY, h);
const STAFF = [UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN];

describe("BooksController", () => {
  let controller: BooksController;
  let svc: Record<string, jest.Mock>;

  beforeEach(() => {
    svc = Object.fromEntries(
      [
        "findAll", "search", "lookupIsbn", "scanUserQr", "buildBookTemplate", "findOne",
        "create", "enqueueImport", "getImportStatus", "update", "remove",
      ].map((m) => [m, jest.fn().mockResolvedValue({ ok: m })])
    );
    controller = new BooksController(svc as unknown as BooksService);
  });

  it("ochiq katalog: ro'yxat, qidiruv, ISBN, bitta kitob — @Public, rol cheklovisiz", () => {
    for (const h of [controller.findAll, controller.search, controller.lookupIsbn, controller.findOne]) {
      expect(isPublic(h)).toBe(true);
      expect(roles(h)).toBeUndefined();
    }
  });

  it("RBAC: fond boshqaruvi — xodimlar; o'chirish — kutubxonachiga emas; QR skan — kutubxonachi", () => {
    for (const h of [controller.create, controller.update, controller.importExcel, controller.getImportStatus, controller.downloadTemplate]) {
      expect(roles(h)).toEqual(expect.arrayContaining(STAFF));
      expect(roles(h)).not.toContain(UserRole.KITOBXON);
      expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([JwtAuthGuard, RolesGuard]);
    }
    expect(roles(controller.remove)).toEqual([UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN]);
    expect(roles(controller.remove)).not.toContain(UserRole.KUTUBXONACHI);
    expect(roles(controller.scanQr)).toEqual(STAFF);
    expect(isPublic(controller.scanQr)).toBeUndefined();
  });

  it("findAll: page/limit Number'ga, berilmasa undefined (servis default'i)", async () => {
    await controller.findAll();
    expect(svc.findAll).toHaveBeenCalledWith(undefined, undefined, undefined);
    await controller.findAll("lib-1", "2", "50");
    expect(svc.findAll).toHaveBeenLastCalledWith("lib-1", 2, 50);
  });

  it("search / lookupIsbn / findOne / scanQr — to'g'ridan-to'g'ri delegatsiya", async () => {
    const dto = { q: "Alpomish", page: 1, limit: 20 };
    await controller.search(dto as never);
    expect(svc.search).toHaveBeenCalledWith(dto);
    await controller.lookupIsbn("9789943452787");
    expect(svc.lookupIsbn).toHaveBeenCalledWith("9789943452787");
    await controller.findOne("b-1");
    expect(svc.findOne).toHaveBeenCalledWith("b-1");
    await controller.scanQr("SL-UZ-08-012-0045-00847");
    expect(svc.scanUserQr).toHaveBeenCalledWith("SL-UZ-08-012-0045-00847");
  });

  it("downloadTemplate: xlsx sarlavhalari (Content-Type/Disposition/Length) va buffer res.end bilan", async () => {
    const buf = Buffer.from("xlsx-bytes");
    svc.buildBookTemplate.mockResolvedValueOnce(buf);
    const res = { set: jest.fn(), end: jest.fn() } as unknown as Response;
    await controller.downloadTemplate(res);
    expect(res.set).toHaveBeenCalledWith({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="sifat-kitob-shablon.xlsx"',
      "Content-Length": String(buf.length),
    });
    expect(res.end).toHaveBeenCalledWith(buf);
  });

  it("create / update / remove / import holati — delegatsiya", async () => {
    const createDto = { isbn: "9789943452787", title: "Alpomish", libraryId: "lib-1" } as never;
    await controller.create(createDto);
    expect(svc.create).toHaveBeenCalledWith(createDto);
    const updateDto = { availableCount: 3 } as never;
    await controller.update("b-1", updateDto);
    expect(svc.update).toHaveBeenCalledWith("b-1", updateDto);
    await controller.remove("b-1");
    expect(svc.remove).toHaveBeenCalledWith("b-1");
    await controller.getImportStatus("job-7");
    expect(svc.getImportStatus).toHaveBeenCalledWith("job-7");
  });

  it("importExcel: fayl buferi, kutubxona va so'rovchi id'si bilan navbatga (202 Accepted)", async () => {
    const file = { buffer: Buffer.from("PK..."), originalname: "fond.xlsx" } as never;
    await controller.importExcel(file, "lib-1", "u-lib");
    expect(svc.enqueueImport).toHaveBeenCalledWith(Buffer.from("PK..."), "lib-1", "u-lib");
  });
});
