import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "./common/decorators/public.decorator";

@ApiTags("health")
@Controller()
export class AppController {
  private readonly startTime = Date.now();

  @Public()
  @Get("health")
  @ApiOperation({ summary: "Health check — monitoring uchun" })
  health() {
    return {
      service: "sifat-library-backend",
      status: "ok",
      version: process.env.npm_package_version ?? "1.0.0",
      environment: process.env.NODE_ENV ?? "development",
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get("health/ready")
  @ApiOperation({ summary: "Readiness check — deployment uchun" })
  ready() {
    // Kubernetes/Docker readiness probe
    return { ready: true };
  }
}
