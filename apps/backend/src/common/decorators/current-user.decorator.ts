import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface JwtPayload {
  sub: string;
  phone: string;
  role: string;
  iat?: number;
  exp?: number;
}

// `@CurrentUser()` returns the full JwtPayload.
// `@CurrentUser("id")` returns the user id string (mapped from payload.sub —
// our JWT puts the user id in `sub`, but call-sites read it as `id` for
// readability; mapping centralised here so callers don't need to know).
// `@CurrentUser("role")` / `@CurrentUser("phone")` return the corresponding
// payload field.
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | "id" | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    if (!user) return undefined;
    if (!data) return user;
    if (data === "id") return user.sub;
    return user[data];
  }
);
