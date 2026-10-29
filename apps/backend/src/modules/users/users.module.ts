import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { PrivacyService } from "./privacy.service";
import { QrTokenService } from "./qr-token.service";
import { BadgeModule } from "../badge/badge.module";
import { BooksModule } from "../books/books.module";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";

@Module({
  imports: [
    PrismaModule,
    // Plan 03-04 GAME-03: BadgeModule for the GET /users/me/badges endpoint.
    // BadgeService.getUserBadges feeds the profile-page BadgesGrid widget.
    BadgeModule,
    // TZ §VIII.1 R22 — QrTokenService.resolveToken BooksService.scanUserQr
    // ni qayta ishlatadi (skan oqimi payload shakli bitta joyda qoladi).
    // BooksModule BooksService ni export qiladi; aylanma import yo'q
    // (UsersModule ni faqat AppModule import qiladi).
    BooksModule,
    // 05-04-fix FIX B — NOTIFICATION_QUEUE access for cross-user FCM
    // transfer notify (fire-and-forget). Re-registering the queue is the
    // documented BullMQ pattern — the underlying queue is shared by name.
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE })
    // P2 hygiene — bu yerda ikkinchi (ortiqcha) JwtModule registratsiyasi bor
    // edi: `?? "secret"` fallback + 7d signOptions bilan. Users modulida hech
    // narsa JwtService inject qilmaydi; JwtAuthGuard esa @Global AuthModule
    // export qilgan yagona JwtModule dan (JWT_SECRET, fallback'siz) oladi.
  ],
  controllers: [UsersController],
  providers: [UsersService, PrivacyService, QrTokenService],
  exports: [UsersService, PrivacyService, QrTokenService]
})
export class UsersModule {}