import { Module } from "@nestjs/common";
import { PrometheusModule } from "@willsoto/nestjs-prometheus";
import { makeCounterProvider, makeHistogramProvider } from "@willsoto/nestjs-prometheus";
import { PublicMetricsController } from "./public-metrics.controller";

export const HTTP_REQUESTS_TOTAL = makeCounterProvider({
  name: "http_requests_total",
  help: "Jami HTTP so'rovlar",
  labelNames: ["method", "path", "status"]
});

export const HTTP_REQUEST_DURATION = makeHistogramProvider({
  name: "http_request_duration_ms",
  help: "HTTP so'rov davomiyligi (ms)",
  labelNames: ["method", "path"],
  buckets: [10, 50, 100, 200, 500, 1000, 2000]
});

export const BOOKS_BORROWED_TOTAL = makeCounterProvider({
  name: "sifat_books_borrowed_total",
  help: "Jami berilgan kitoblar soni"
});

export const ACTIVE_USERS_GAUGE = makeCounterProvider({
  name: "sifat_active_users_total",
  help: "Faol foydalanuvchilar soni"
});

@Module({
  imports: [
    PrometheusModule.register({
      path: "/metrics",
      defaultMetrics: { enabled: true },
      // AUDIT FIX (monitoring): standart controller global JwtAuthGuard
      // default-deny tufayli 401 qaytarardi. @Public() bilan belgilangan
      // custom controller scrape'ni tokensiz ochadi (tarmoq cheklovi nginx da).
      controller: PublicMetricsController
    })
  ],
  providers: [
    HTTP_REQUESTS_TOTAL,
    HTTP_REQUEST_DURATION,
    BOOKS_BORROWED_TOTAL,
    ACTIVE_USERS_GAUGE
  ],
  exports: [
    HTTP_REQUESTS_TOTAL,
    HTTP_REQUEST_DURATION,
    BOOKS_BORROWED_TOTAL,
    ACTIVE_USERS_GAUGE
  ]
})
export class MetricsModule {}
