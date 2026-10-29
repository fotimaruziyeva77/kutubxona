import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { StatsGateway } from "./stats.gateway";

@Module({
  imports: [
    // AUDIT FIX C7: StatsGateway endi handshake JWT ni tekshiradi — JwtService
    // shu modulda ro'yhatdan o'tkaziladi (global AuthModule export'iga implicit
    // bog'lanib qolmaslik uchun; users.module bilan bir xil pattern).
    // Secret JwtAuthGuard bilan AYNAN bir xil: JWT_SECRET.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET"),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [StatsGateway],
  exports: [StatsGateway]
})
export class GatewayModule {}
