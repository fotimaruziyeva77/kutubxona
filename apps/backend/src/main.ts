import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ValidationPipe, Logger } from "@nestjs/common";
import * as helmetPkg from "helmet";
const helmet = (helmetPkg as any).default ?? helmetPkg;
import * as cookieParserPkg from "cookie-parser";
const cookieParser = (cookieParserPkg as any).default ?? cookieParserPkg;
import { AppModule } from "./app.module";
import { initSentry } from "./infra/monitoring/sentry";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { _assertDonationStubGuard } from "./common/utils/donation-stub-guard.util";
import {
  _assertSubscriptionStubGuard,
  isSubscriptionStubActive,
} from "./common/utils/subscription-stub-guard.util";
import {
  _assertEnvVars,
  PRODUCTION_REQUIRED_ENV,
  isProductionEnv,
} from "./common/utils/production-env.util";

// Re-export for back-compat / spec convenience (Plan 03-01 D-DONAT-01).
export { _assertDonationStubGuard } from "./common/utils/donation-stub-guard.util";
// Plan 04-01 OQ-6: re-export so spec can import without booting AppModule.
export {
  _assertSubscriptionStubGuard,
  isSubscriptionStubActive,
} from "./common/utils/subscription-stub-guard.util";
// Plan 04-01 audit-fix FIX 2: case-insensitive production normalizer.
export { isProductionEnv } from "./common/utils/production-env.util";

const logger = new Logger("Bootstrap");

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Sentry uchun raw body kerak (webhook imzolari)
    rawBody: true,
  });

  // Body limitlarini oshiramiz — do'kon Excel importi faylni base64 JSON ichida
  // yuboradi (katta katalog ~MB), shuningdek kitob muqovasi data-URL'lari.
  // Default 100kb yetmaydi. rawBody bilan yonma-yon ishlaydi.
  app.useBodyParser("json", { limit: "15mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "15mb" });

  // ── Express trust proxy (Plan 04-02 audit-fix FIX A2) ─────────────────────
  // Tells Express how many reverse-proxy hops are in front of the app so
  // `req.ip` resolves to the real client IP from the X-Forwarded-For header
  // — but only in trusted positions. The IpWhitelistGuard reads ONLY req.ip
  // so trust-proxy is the single source of truth for client-IP derivation.
  //
  // Default: 1 hop (Nginx terminates TLS in front of the Node process). When
  // running behind a different topology (e.g., Nginx -> Cloudflare -> app),
  // set TRUSTED_PROXY to the number of hops or a comma-separated CIDR list.
  // See Express docs: https://expressjs.com/en/guide/behind-proxies.html
  const trustedProxy = process.env.TRUSTED_PROXY ?? "1";
  const trustedProxyValue = /^\d+$/.test(trustedProxy)
    ? Number(trustedProxy)
    : trustedProxy;
  app.getHttpAdapter().getInstance().set("trust proxy", trustedProxyValue);

  // ── Global API prefix ─────────────────────────────────────────────────────
  // Barcha endpointlar /api/... dan boshlanadi (health va docs bundan mustasno)
  app.setGlobalPrefix("api", { exclude: ["health", "/"] });

  // Plan 04-01 audit-fix FIX 2 — case + whitespace-tolerant production check.
  // Stub guards already normalize via toLowerCase().trim(); make isProd match so
  // CORS, helmet, Swagger, and env-var assertion all branch consistently when
  // NODE_ENV="Production" / " production " / "PRODUCTION".
  const isProd = isProductionEnv();

  // ── Security: Helmet (HTTP security headers) ─────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: ["'self'"],
              frameSrc: ["'none'"],
            },
          }
        : false, // Dev da CSP o'chiriladi (Swagger uchun)
      crossOriginEmbedderPolicy: false, // Swagger UI uchun
    }),
  );

  // ── Cookie parser (INFRA-02) ─────────────────────────────────────────────
  // Must run BEFORE any route so /auth/refresh can read req.cookies.refreshToken.
  // No secret arg — refresh-token cookies are HMAC-signed JWTs already; we
  // don't use Express signed cookies on top of that.
  app.use(cookieParser());

  // ── CORS ─────────────────────────────────────────────────────────────────
  const allowedOrigins = isProd
    ? ["https://sifat.uz", "https://www.sifat.uz"]
    : [
        "http://localhost:3000",
        "https://dev.sifat.uz",
        "https://staging.sifat.uz",
        "https://sifat.uz",
      ];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With"],
  });

  // ── Global Validation Pipe ────────────────────────────────────────────────
  // Barcha DTO lar class-validator orqali tekshiriladi
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,          // Noto'g'ri maydonlar avtomatik o'chiriladi
      forbidNonWhitelisted: false, // Qo'shimcha maydonlar xato qaytarmasin (ixtiyoriy)
      transform: true,          // String → Number/Boolean avtomatik konversiya
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ── Global Exception Filter ───────────────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());

  // ── Global Logging Interceptor ────────────────────────────────────────────
  app.useGlobalInterceptors(new LoggingInterceptor());

  // ── Swagger (faqat production da o'chiriladi) ─────────────────────────────
  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle("SIFAT Library API")
      .setDescription("Milliy Kitobxonlik Platformasi — Backend API")
      .setVersion("1.0.0")
      .addBearerAuth()
      .addTag("auth", "Autentifikatsiya")
      .addTag("books", "Kitoblar")
      .addTag("libraries", "Kutubxonalar")
      .addTag("reading", "Reading Index")
      .addTag("top", "Reytinglar")
      .addTag("school", "Maktab")
      .addTag("otm", "OTM")
      .addTag("idora", "Idora")
      .addTag("store", "Do'kon")
      .addTag("payment", "To'lov")
      .addTag("ai", "AI tizimi")
      .build();

    const document = SwaggerModule.createDocument(app, config);
    // setGlobalPrefix "api" bilan Swagger "docs" → /docs ga o'rnatiladi
    // Lekin biz uni /api/docs da saqlaymiz (exclude orqali)
    SwaggerModule.setup("docs", app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: "alpha",
      },
    });

    logger.log("📚 Swagger UI: http://localhost:4000/docs");
  }

  // ── Production startup tekshiruvlari ─────────────────────────────────────
  // Plan 04-01 Task 2: PAYME_*/CLICK_* secrets added to the required set per
  // §VIII.3 Vault fail-hard. PAYME_LOGIN, PAYME_TEST_KEY also added because
  // payme.service.ts uses them for Basic Auth username allowlist + sandbox key.
  if (isProd) {
    _assertEnvVars(PRODUCTION_REQUIRED_ENV);
  }

  // Plan 03-01 DONAT-01: fail-CLOSED if the donation payment stub is active
  // in production. Mirrors DEV_OTP_BYPASS allowlist semantics. MUST run before
  // app.listen() so a misconfigured prod container exits non-zero on boot.
  _assertDonationStubGuard(process.env);

  // Plan 04-01 OQ-6: same fail-CLOSED pattern for subscription payment stub.
  _assertSubscriptionStubGuard(process.env);

  // ── Graceful shutdown (AUDIT FIX H6) ─────────────────────────────────────
  // SIGTERM/SIGINT da Nest lifecycle hook'larini (onModuleDestroy,
  // beforeApplicationShutdown, onApplicationShutdown) ishga tushiradi —
  // BullMQ worker'lar joriy jobni tugatadi, Kafka producer/consumer va
  // Prisma/Redis ulanishlari toza yopiladi. Busiz rolling-deploy paytida
  // yarim bajarilgan joblar va ochiq ulanishlar qoladi.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 4000;
  await app.listen(port);

  logger.log(`🚀 Backend ishga tushdi: port ${port} | muhit: ${process.env.NODE_ENV ?? "development"}`);

  // ── DEV_OTP_BYPASS startup banner ────────────────────────────────────────
  // Loud warning when the OTP bypass is active. Mirrors the same fail-CLOSED
  // allowlist used inside AuthService.isOtpBypassed() — must stay in sync.
  const otpBypassActive =
    process.env.DEV_OTP_BYPASS === "true" &&
    ["development", "test", "dev"].includes(
      (process.env.NODE_ENV || "").toLowerCase().trim(),
    );
  if (otpBypassActive) {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("[SECURITY] DEV_OTP_BYPASS is ACTIVE");
    logger.warn("OTP send/verify endpoints will skip SMS and auto-accept any code.");
    logger.warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
    logger.warn("DO NOT use this in any environment with real users.");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  // ── DEV_DONATION_PAYMENT_STUB startup banner ─────────────────────────────
  // Plan 03-01 D-DONAT-01: same allowlist as DEV_OTP_BYPASS — only honored in
  // dev/test. Production fail-hard is enforced earlier in _assertDonationStubGuard.
  const donationStubActive =
    process.env.DEV_DONATION_PAYMENT_STUB === "true" &&
    ["development", "test", "dev"].includes(
      (process.env.NODE_ENV || "").toLowerCase().trim(),
    );
  if (donationStubActive) {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("[SECURITY] DEV_DONATION_PAYMENT_STUB is ACTIVE");
    logger.warn("Donations skip real Payme/Click and auto-complete via stub webhook.");
    logger.warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
    logger.warn("DO NOT use this in any environment with real users.");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  // ── DEV_SUBSCRIPTION_PAYMENT_STUB startup banner ─────────────────────────
  // Plan 04-01 OQ-6: same allowlist + fail-hard semantics as the donation stub
  // banner above. Production hard-fail is enforced earlier in
  // _assertSubscriptionStubGuard.
  if (isSubscriptionStubActive(process.env)) {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("[SECURITY] DEV_SUBSCRIPTION_PAYMENT_STUB is ACTIVE");
    logger.warn(
      "Payme/Click subscription webhooks short-circuit to synthetic success in dev only.",
    );
    logger.warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
    logger.warn("DO NOT use this in any environment with real users.");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  // ── DEV_FCM_STUB startup banner (Plan 05-01) ─────────────────────────────
  // Banner fires when FCM_SERVICE_ACCOUNT_KEY_PATH is unset AND we are NOT in
  // production. Production path can never reach here because
  // _assertEnvVars(PRODUCTION_REQUIRED_ENV) above throws when the key is
  // missing. The banner mirrors DEV_DONATION_PAYMENT_STUB shape so operators
  // see a consistent "stub active" log at boot.
  if (!process.env.FCM_SERVICE_ACCOUNT_KEY_PATH && !isProductionEnv()) {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("[SECURITY] DEV_FCM_STUB ACTIVE");
    logger.warn(
      "FCM_SERVICE_ACCOUNT_KEY_PATH unset — push notifications are no-op.",
    );
    logger.warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
    logger.warn("DO NOT use this in any environment with real users.");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  // ── DEV_MAIL_STUB startup banner (Plan 05-01) ────────────────────────────
  // Same pattern for SMTP. Production fail-hard upstream guarantees SMTP_HOST
  // is set in prod boots — this banner only fires in dev/test.
  if (!process.env.SMTP_HOST && !isProductionEnv()) {
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.warn("[SECURITY] DEV_MAIL_STUB ACTIVE");
    logger.warn("SMTP_HOST unset — email delivery is no-op.");
    logger.warn(`NODE_ENV=${process.env.NODE_ENV || "(unset)"}`);
    logger.warn("DO NOT use this in any environment with real users.");
    logger.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
}

// _assertEnvVars + PRODUCTION_REQUIRED_ENV are defined and exported at the
// top of this file (Plan 04-01 Task 2) so main.spec can drive them as pure
// functions without booting AppModule.

// Only auto-bootstrap when invoked as the main entry point. This lets the
// spec import re-exports (e.g. `_assertDonationStubGuard`) without spinning
// up a NestJS app.
if (require.main === module) {
  // Bootstrap xatosi (masalan _assertEnvVars yiqilishi) unhandled rejection
  // bo'lib qolmasligi kerak: konteyner orkestratori uchun aniq exit kodi va
  // o'qiladigan log yozamiz, aks holda sabab stack ichida ko'milib ketadi.
  bootstrap().catch((err) => {
    logger.error(
      `Bootstrap muvaffaqiyatsiz: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    process.exit(1);
  });
}
