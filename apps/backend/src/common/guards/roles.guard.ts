import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { JwtPayload } from "../decorators/current-user.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ]);

    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user as JwtPayload;

    if (!user) throw new ForbiddenException("Ruxsat yo'q");

    // SUPER_ADMIN bypass — the national super admin has unrestricted access to
    // every role-gated route by definition (see CLAUDE.md §2.2: "Barcha tizim,
    // ... Cheklov: Yo'q"). Without this, each @Roles(...) list had to remember
    // to include SUPER_ADMIN, and any omission (e.g. a route gated to
    // FINANCIAL_ADMIN_ROLES) 403'd the super admin. Bypassing here is the
    // correct broad fix and matches how super admin is expected to behave.
    if ((user.role as UserRole) === UserRole.SUPER_ADMIN) return true;

    const hasRole = required.includes(user.role as UserRole);
    if (!hasRole) throw new ForbiddenException("Bu amalni bajarish uchun vakolat yetarli emas");

    return true;
  }
}
