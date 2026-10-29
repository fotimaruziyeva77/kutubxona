import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isProductionEnv } from "../../common/utils/production-env.util";

/**
 * Eskiz.uz SMS HTTP client.
 *
 * Flow:
 *   1. authenticate() POSTs {email, password} to {base}/api/auth/login → bearer token
 *   2. Token cached in-memory (Pitfall 5 — never re-auth per message)
 *   3. sendSms(phone, message) POSTs {mobile_phone, message, from} to {base}/api/message/sms/send
 *   4. On HTTP 401: clear cache → authenticate once → retry the send once
 *
 * Threat model (T-01-02/T-01-03): credentials read from ConfigService/Vault;
 * token kept only as an instance field (never persisted); no token or password ever logged.
 *
 * Dev no-op: when ESKIZ_EMAIL/ESKIZ_PASSWORD are unset, sendSms logs a warning and returns —
 * lets local dev / unit-tests for other services run without real credentials.
 *
 * AUDIT FIX H7 — production fail-closed: prodda creds yo'q bo'lsa onModuleInit
 * boot paytidayoq throw qiladi (Vault fail-hard semantikasi). Aks holda OTP
 * SMS'lar jimgina yuborilmay qoladi va hech kim tizimga kira olmaydi.
 */
@Injectable()
export class EskizSmsClient implements OnModuleInit {
  private readonly logger = new Logger(EskizSmsClient.name);

  private readonly email?: string;
  private readonly password?: string;
  private readonly from: string;
  private readonly baseUrl: string;

  /** Cached bearer token. Cleared on 401, refreshed by authenticate(). */
  private token: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.email = this.config.get<string>("ESKIZ_EMAIL");
    this.password = this.config.get<string>("ESKIZ_PASSWORD");
    this.from = this.config.get<string>("ESKIZ_FROM") ?? "4546";
    this.baseUrl = this.config.get<string>("ESKIZ_BASE_URL") ?? "https://notify.eskiz.uz";
  }

  /**
   * AUDIT FIX H7 — fail-closed boot assert. Production da ESKIZ creds yo'q
   * bo'lsa modul init paytida throw (send paytida emas) — Vault fail-hard
   * bilan bir xil semantika. Dev/test da warn+no-op saqlanadi (sendSms ichida).
   */
  onModuleInit(): void {
    if (isProductionEnv() && (!this.email || !this.password)) {
      throw new Error(
        "[FATAL] ESKIZ_EMAIL/ESKIZ_PASSWORD production da majburiy — " +
          "SMS yuborilmaydigan prod boot taqiqlangan (fail-closed). " +
          ".env.prod yoki Vault sozlamalarini to'ldiring.",
      );
    }
  }

  /**
   * Send an SMS via Eskiz.uz. Authenticates lazily; caches the bearer token across calls.
   * Returns void; throws on terminal failure (non-401 non-2xx, or 401 after one retry).
   */
  async sendSms(phone: string, message: string): Promise<void> {
    if (!this.email || !this.password) {
      // PITFALLS C3 / dev no-op: do NOT throw — let dev/test environments boot without creds.
      // (Production bu nuqtaga yetib kelmaydi — onModuleInit boot'da yiqitadi.)
      this.logger.warn(
        `[eskiz dev no-op] ESKIZ_EMAIL not set — would have sent SMS to ${this._maskPhone(phone)}`,
      );
      return;
    }

    if (!this.token) {
      await this._authenticate();
    }

    const mobilePhone = this._normalizePhone(phone);
    let res = await this._postSend(mobilePhone, message);

    if (res.status === 401) {
      // Token expired or revoked → re-auth once + retry once (PITFALLS Pitfall 5)
      this.token = null;
      await this._authenticate();
      res = await this._postSend(mobilePhone, message);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Log status only (never the message body — T-01-04 OTP minimization)
      this.logger.error(`Eskiz SMS yuborilmadi: status=${res.status} detail=${detail.slice(0, 200)}`);
      this.logger.log({ phone: this._maskPhone(phone), status: "fail" });
      throw new Error(`Eskiz send failed: ${res.status}`);
    }

    // NOTIF-01 delivery-status log (never includes the message body or token)
    this.logger.log({ phone: this._maskPhone(phone), status: "success" });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async _authenticate(): Promise<void> {
    const body = new URLSearchParams({
      email: this.email ?? "",
      password: this.password ?? "",
    });

    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      this.token = null;
      this.logger.error(`Eskiz auth muvaffaqiyatsiz: status=${res.status}`);
      throw new Error(`Eskiz auth failed: ${res.status}`);
    }

    const json = (await res.json()) as { data?: { token?: string }; token?: string };
    // Eskiz returns { data: { token } } per docs; accept top-level { token } too as defence-in-depth.
    const token = json?.data?.token ?? json?.token;
    if (!token) {
      throw new Error("Eskiz auth response missing token");
    }
    this.token = token;
  }

  private async _postSend(mobilePhone: string, message: string): Promise<Response> {
    const body = new URLSearchParams({
      mobile_phone: mobilePhone,
      message,
      from: this.from,
    });
    return fetch(`${this.baseUrl}/api/message/sms/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${this.token ?? ""}`,
      },
      body: body.toString(),
    });
  }

  /**
   * Eskiz expects digits-only mobile_phone (e.g., 998901234567).
   * Accept inputs like "+998901234567" or "998901234567" or "901234567".
   */
  private _normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("998")) return digits;
    if (digits.length === 9) return `998${digits}`;
    return digits;
  }

  /** Mask the middle of the phone for log output (T-01-02 / privacy). */
  private _maskPhone(raw: string): string {
    const d = raw.replace(/\D/g, "");
    if (d.length < 6) return "***";
    return `${d.slice(0, 5)}***${d.slice(-2)}`;
  }
}
