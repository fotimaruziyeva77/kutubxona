import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { AppInfraModule } from "./infra/app-infra.module";
import { MetricsModule } from "./infra/monitoring/metrics.module";
import { QueueModule } from "./infra/queue/queue.module";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { LibrariesModule } from "./modules/libraries/libraries.module";
import { BooksModule } from "./modules/books/books.module";
import { TransactionsModule } from "./modules/transactions/transactions.module";
import { ReadingModule } from "./modules/reading/reading.module";
import { AdminModule } from "./modules/admin/admin.module";
import { LandingModule } from "./modules/landing/landing.module";
import { AiModule } from "./modules/ai/ai.module";
import { GeoModule } from "./modules/geo/geo.module";
import { TopModule } from "./modules/top/top.module";
import { DonateModule } from "./modules/donate/donate.module";
import { BadgeModule } from "./modules/badge/badge.module";
import { XpModule } from "./modules/xp/xp.module";
import { SchoolModule } from "./modules/school/school.module";
import { ClubModule } from "./modules/club/club.module";
import { FamilyModule } from "./modules/family/family.module";
import { IdoraModule } from "./modules/idora/idora.module";
import { PaymentModule } from "./modules/payment/payment.module";
import { StoreModule } from "./modules/store/store.module";
import { OtmModule } from "./modules/otm/otm.module";
import { GatewayModule } from "./infra/gateway/gateway.module";
import { AppController } from "./app.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),

    // ── Global rate limiting ──────────────────────────────────────────────
    // Umumiy: 100 so'rov/daqiqa
    // Auth endpointlar alohida @Throttle() bilan cheklangan
    // Limitlar env-orqali sozlanadi (xavfsiz default'lar saqlanadi). Reverse-proxy
    // ortida (Next rewrite / ngrok) butun trafik bitta IP'dan ko'rinadi, shuning
    // uchun bunday topologiyada THROTTLE_LIMIT ni oshirish kerak bo'ladi.
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),   // 1 daqiqa (ms)
        limit: Number(process.env.THROTTLE_LIMIT ?? 100)      // 100 so'rov/daqiqa
      },
      {
        name: "strict",
        ttl: Number(process.env.THROTTLE_STRICT_TTL_MS ?? 3_600_000), // 1 soat (ms)
        limit: Number(process.env.THROTTLE_STRICT_LIMIT ?? 10)        // Auth: 10/soat
      }
    ]),

    AppInfraModule,
    MetricsModule,
    QueueModule,
    AuthModule,
    UsersModule,
    LibrariesModule,
    BooksModule,
    TransactionsModule,
    ReadingModule,
    AdminModule,
    LandingModule,
    AiModule,
    GeoModule,
    TopModule,
    DonateModule,
    BadgeModule,
    XpModule,
    SchoolModule,
    ClubModule,
    FamilyModule,
    IdoraModule,
    PaymentModule,
    StoreModule,
    OtmModule,
    GatewayModule
  ],
  controllers: [AppController],
  providers: [
    // Global guard tartibi: avval rate-limit, keyin autentifikatsiya.
    // ThrottlerGuard global sifatida qo'llanadi
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    },
    // JwtAuthGuard global default-deny — har bir route token talab qiladi,
    // faqat @Public() bilan belgilanganlar ochiq (INFRA-03).
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    }
  ]
})
export class AppModule {}
