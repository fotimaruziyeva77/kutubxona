import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Telegram Gateway (https://core.telegram.org/gateway) — tasdiqlash kodini
 * telefon raqamga Telegram'ning rasmiy "Verification Codes" chati orqali yuboradi.
 * Bot shart emas: foydalanuvchi Telegram'da shu raqam bilan ro'yhatdan o'tgan bo'lsa yetarli.
 *
 * Yoqish: OTP_CHANNEL=telegram va TELEGRAM_GATEWAY_TOKEN (gateway.telegram.org → API token).
 * Kod matni hech qachon log qilinmaydi.
 */
@Injectable()
export class TelegramGatewayClient {
  private readonly logger = new Logger(TelegramGatewayClient.name);
  private readonly token?: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>("TELEGRAM_GATEWAY_TOKEN")?.trim();
    this.token = raw && raw !== "not-configured" ? raw : undefined;
    this.baseUrl = this.config.get<string>("TELEGRAM_GATEWAY_BASE_URL") ?? "https://gatewayapi.telegram.org";
  }

  get isConfigured(): boolean {
    return Boolean(this.token);
  }

  async sendCode(phone: string, code: string, ttlSeconds: number): Promise<void> {
    if (!this.token) {
      throw new ServiceUnavailableException("Telegram orqali kod yuborish sozlanmagan");
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/sendVerificationMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ phone_number: phone, code, ttl: ttlSeconds }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.logger.error(`Telegram Gateway'ga ulanib bo'lmadi: ${(e as Error).message}`);
      throw new ServiceUnavailableException("Kod yuborilmadi, birozdan keyin qayta urinib ko'ring");
    }

    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && json.ok) {
      this.logger.log({ phone: this.mask(phone), channel: "telegram", status: "success" });
      return;
    }

    const err = json.error ?? `HTTP_${res.status}`;
    this.logger.error(`Telegram Gateway xatosi: ${err} (${this.mask(phone)})`);
    // Raqamda Telegram yo'q / raqam yaroqsiz — foydalanuvchiga aniq sabab.
    if (/PHONE_NUMBER|USER|NOT_FOUND|CANNOT_SEND/i.test(err)) {
      throw new BadRequestException(
        "Bu raqamga Telegram orqali kod yuborib bo'lmadi. Raqamingiz Telegram'da ro'yhatdan o'tganini tekshiring.",
      );
    }
    throw new ServiceUnavailableException("Kod yuborilmadi, birozdan keyin qayta urinib ko'ring");
  }

  private mask(phone: string): string {
    return phone.length > 6 ? `${phone.slice(0, 6)}***${phone.slice(-2)}` : "***";
  }
}
