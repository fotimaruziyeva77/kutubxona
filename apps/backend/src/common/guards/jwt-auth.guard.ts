import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { Request as ExpressRequest } from "express";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

type AuthRequest = ExpressRequest & { user?: unknown };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    // @Public() bilan belgilangan route'lar token talab qilmaydi (default-deny bypass).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    const token = this.extractToken(req);

    if (!token) throw new UnauthorizedException("Token topilmadi");

    try {
      // Algoritm qat'iy HS256 — header'dagi alg ga ishonilmaydi (alg-confusion
      // va "none" hujumlarining oldini oladi; sign tomoni ham HS256).
      const payload = this.jwt.verify(token, {
        secret: this.config.get<string>("JWT_SECRET"),
        algorithms: ["HS256"]
      });
      req["user"] = payload;
      return true;
    } catch {
      throw new UnauthorizedException("Token noto'g'ri yoki muddati o'tgan");
    }
  }

  private extractToken(req: AuthRequest): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    return null;
  }
}
