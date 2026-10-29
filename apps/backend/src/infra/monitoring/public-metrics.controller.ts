import { Controller, Get, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { PrometheusController } from "@willsoto/nestjs-prometheus";
import type { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";

/**
 * AUDIT FIX (monitoring) — Prometheus /metrics endpointi.
 *
 * Global JwtAuthGuard default-deny rejimida ishlaydi (INFRA-03), shuning
 * uchun kutubxonaning standart PrometheusController'i 401 qaytarardi va
 * Prometheus scrape hech qachon muvaffaqiyatli bo'lmasdi. Bu controller
 * @Public() bilan token talabini olib tashlaydi.
 *
 * Tarmoq darajasidagi cheklov (faqat ichki monitoring tarmog'idan kirish)
 * nginx vazifasi — endpoint o'zi hech qanday shaxsiy ma'lumot bermaydi,
 * faqat agregat texnik metrikalar.
 *
 * Route path'i metrics.module.ts dagi PrometheusModule.register({ path })
 * orqali Reflect metadata bilan o'rnatiladi.
 */
@ApiExcludeController()
@Controller()
export class PublicMetricsController extends PrometheusController {
  @Public()
  @Get()
  async index(@Res({ passthrough: true }) response: Response): Promise<string> {
    return super.index(response);
  }
}
