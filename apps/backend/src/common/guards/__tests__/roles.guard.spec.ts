import "reflect-metadata";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../roles.guard";
import { ROLES_KEY } from "../../decorators/roles.decorator";

/**
 * RolesGuard — RBAC qatlamining o'zi (T6: guard'lar coverage'ga kirdi).
 *
 * Qoidalar: @Roles yo'q → ochiq; user yo'q → 403; SUPER_ADMIN → har doim o'tadi
 * (CLAUDE.md §2.2 "Cheklov: Yo'q"); ro'yxatdagi rol → o'tadi; boshqa rol → 403.
 * Metadata avval handler'dan, bo'lmasa class'dan olinadi (getAllAndOverride).
 */
function makeCtx(opts: {
  user?: { role: UserRole } | null;
  handlerRoles?: UserRole[];
  classRoles?: UserRole[];
}): ExecutionContext {
  const handler = function handler() {};
  class Ctrl {}
  if (opts.handlerRoles) Reflect.defineMetadata(ROLES_KEY, opts.handlerRoles, handler);
  if (opts.classRoles) Reflect.defineMetadata(ROLES_KEY, opts.classRoles, Ctrl);
  return {
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => ({ user: opts.user ?? undefined }) }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  const guard = new RolesGuard(new Reflector());

  it("@Roles bo'lmagan route — hamma (autentifikatsiyadan o'tgan) uchun ochiq", () => {
    expect(guard.canActivate(makeCtx({ user: { role: UserRole.KITOBXON } }))).toBe(true);
    expect(guard.canActivate(makeCtx({ user: null }))).toBe(true);
  });

  it("bo'sh @Roles() ro'yxati ham cheklov emas", () => {
    expect(guard.canActivate(makeCtx({ user: { role: UserRole.KITOBXON }, handlerRoles: [] }))).toBe(true);
  });

  it("rol talab qilinadi, lekin req.user yo'q → 403", () => {
    expect(() =>
      guard.canActivate(makeCtx({ user: null, handlerRoles: [UserRole.TUMAN_ADMIN] }))
    ).toThrow(ForbiddenException);
  });

  it("SUPER_ADMIN ro'yxatda bo'lmasa ham o'tadi (milliy admin bypass)", () => {
    expect(
      guard.canActivate(
        makeCtx({ user: { role: UserRole.SUPER_ADMIN }, handlerRoles: [UserRole.BUXGALTER] })
      )
    ).toBe(true);
  });

  it("ro'yxatdagi rol o'tadi, boshqasi 403 (aniq xabar bilan)", () => {
    expect(
      guard.canActivate(
        makeCtx({ user: { role: UserRole.TUMAN_ADMIN }, handlerRoles: [UserRole.TUMAN_ADMIN, UserRole.VILOYAT_ADMIN] })
      )
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        makeCtx({ user: { role: UserRole.KITOBXON }, handlerRoles: [UserRole.TUMAN_ADMIN] })
      )
    ).toThrow("Bu amalni bajarish uchun vakolat yetarli emas");
  });

  it("handler'da @Roles bo'lmasa class darajasidagi @Roles amal qiladi", () => {
    expect(() =>
      guard.canActivate(makeCtx({ user: { role: UserRole.KITOBXON }, classRoles: [UserRole.MUASSASA_ADMIN] }))
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(makeCtx({ user: { role: UserRole.MUASSASA_ADMIN }, classRoles: [UserRole.MUASSASA_ADMIN] }))
    ).toBe(true);
  });

  it("handler @Roles class @Roles'ni ustidan yozadi (override, birlashtirmaydi)", () => {
    const ctx = makeCtx({
      user: { role: UserRole.MUASSASA_ADMIN },
      classRoles: [UserRole.MUASSASA_ADMIN],
      handlerRoles: [UserRole.TUMAN_ADMIN],
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
