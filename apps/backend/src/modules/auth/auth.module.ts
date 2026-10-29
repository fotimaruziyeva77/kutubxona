import { Global, Module } from "@nestjs/common";  // Global qo'shing
import { JwtModule } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { SmsModule } from "../../infra/sms/sms.module";
import { CacheModule } from "../../infra/cache/cache.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { IduzController } from "./iduz.controller";
import { IduzService } from "./iduz.service";

@Global()  // Shu qatorni qo'shing
@Module({
  imports: [
    PrismaModule,
    SmsModule,
    CacheModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: "15m" }
      })
    })
  ],
  controllers: [AuthController, IduzController],
  providers: [AuthService, IduzService],
  exports: [AuthService, JwtModule]  // JwtModule export qilingan — OK
})
export class AuthModule {}