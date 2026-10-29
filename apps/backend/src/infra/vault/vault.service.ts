import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as vault from "node-vault";

@Injectable()
export class VaultService implements OnModuleInit {
  private readonly logger = new Logger(VaultService.name);
  private client: vault.client;
  private cache = new Map<string, Record<string, string>>();

  constructor(private readonly config: ConfigService) {
    const isProd = process.env.NODE_ENV === "production";
    const token = this.config.get<string>("VAULT_TOKEN");

    // Production da VAULT_TOKEN majburiy — hech qanday dev-root-token fallback yo'q.
    // Bu davlat auditi talabi (PITFALLS H5).
    if (isProd && !token) {
      throw new Error(
        "[FATAL] Production da VAULT_TOKEN o'rnatilishi shart — " +
          "dev-root-token ga fallback qilinmaydi.",
      );
    }

    this.client = vault({
      apiVersion: "v1",
      endpoint: this.config.get<string>("VAULT_ADDR") ?? "http://localhost:8200",
      // Dev da yetishmagan token uchun fallback; production da bu yo'lga yetib bo'lmaydi.
      token: token ?? "dev-root-token",
    });
  }

  async onModuleInit() {
    try {
      await this.client.health();
      this.logger.log("Vault ulanish muvaffaqiyatli");
    } catch (err) {
      // Production da Vault yetib bo'lmasligi — fatal xato (sekretlarni majburlash).
      if (process.env.NODE_ENV === "production") {
        // Asl sababni ham qo'shamiz: ulanish rad etildimi, token eskirganmi
        // yoki TLS muammosimi — busiz operator konteyner logidan ayta olmaydi.
        throw new Error(
          "[FATAL] Production da Vault health check muvaffaqiyatsiz — " +
            "ishga tushish to'xtatildi. VAULT_ADDR/VAULT_TOKEN ni tekshiring. " +
            `Sabab: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.logger.warn("Vault mavjud emas — .env dan o'qiladi");
    }
  }

  async getSecret(path: string): Promise<Record<string, string>> {
    if (this.cache.has(path)) {
      return this.cache.get(path)!;
    }

    try {
      const result = await this.client.read(`sifat/data/${path}`);
      const data = result.data?.data ?? {};
      this.cache.set(path, data);
      return data;
    } catch {
      this.logger.warn(`Vault da "${path}" topilmadi — .env ishlatiladi`);
      return {};
    }
  }

  async get(path: string, key: string, fallback?: string): Promise<string> {
    const secrets = await this.getSecret(path);
    return secrets[key] ?? fallback ?? this.config.get<string>(key.toUpperCase()) ?? "";
  }

  clearCache() {
    this.cache.clear();
  }
}
