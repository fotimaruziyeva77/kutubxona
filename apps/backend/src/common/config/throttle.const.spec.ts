import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { Throttle, ThrottlerGuard, ThrottlerStorageService, ThrottlerException } from "@nestjs/throttler";
import { onlyWhenDeclared } from "./throttle.const";

// Haqiqiy ThrottlerGuard bilan: "strict" (soatiga 2 ta) faqat e'lon qilingan
// route'ga qo'llanishi, oddiy route'larni cheklamasligi tekshiriladi.
class DemoController {
  list() {}
  @Throttle({ strict: { ttl: 3_600_000, limit: 2 } })
  login() {}
}

function ctxFor(handler: () => void) {
  const req = { ip: "203.0.113.7", headers: {} };
  const res = { header: () => undefined, setHeader: () => undefined };
  return {
    getType: () => "http",
    getHandler: () => handler,
    getClass: () => DemoController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

describe("onlyWhenDeclared — nomli throttler faqat e'lon qilingan route'da", () => {
  let guard: ThrottlerGuard;

  beforeEach(async () => {
    guard = new ThrottlerGuard(
      [
        { name: "default", ttl: 60_000, limit: 1000 },
        { name: "strict", ttl: 3_600_000, limit: 2, skipIf: onlyWhenDeclared("strict") },
      ],
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  it("oddiy route (GET /books kabi) strict limitdan ko'p chaqirilsa ham ishlaydi", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(guard.canActivate(ctxFor(DemoController.prototype.list))).resolves.toBe(true);
    }
  });

  it("@Throttle({ strict }) e'lon qilingan route (login) limitdan keyin 429", async () => {
    const ctx = ctxFor(DemoController.prototype.login);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ThrottlerException);
  });
});
