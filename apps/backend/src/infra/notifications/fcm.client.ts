import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as admin from "firebase-admin";
import { isProductionEnv } from "../../common/utils/production-env.util";

/**
 * Plan 05-01 Task 2 — Firebase Cloud Messaging (FCM) client.
 *
 * Mirrors EskizSmsClient (apps/backend/src/infra/sms/eskiz.client.ts) lazy-init
 * + dev no-op pattern exactly:
 *
 *   1. Constructor reads FCM_SERVICE_ACCOUNT_KEY_PATH via ConfigService.
 *   2. onModuleInit lazily loads the JSON file and initializes a firebase-admin
 *      App. If the env is unset → log [fcm dev no-op] and return WITHOUT throwing
 *      so local dev / unit tests boot without credentials.
 *   3. Production fail-hard is enforced earlier in main.ts._assertEnvVars via
 *      PRODUCTION_REQUIRED_ENV (FCM_SERVICE_ACCOUNT_KEY_PATH).
 *   4. send() short-circuits when the app is not initialized.
 *   5. On firebase-admin "registration-token-not-registered" /
 *      "invalid-registration-token" errors, throw InvalidFcmTokenError — Plan
 *      05-04 (notification.processor) catches that to delete the dead row.
 *
 * Threat model (T-05-06, T-05-FCM-ENV per 05-RESEARCH §STRIDE):
 *   - Token NEVER appears at info-level; logs mask as ***<last8>.
 *   - Service-account JSON is read once from disk; never logged.
 *   - Production missing env = boot throws (see main.ts).
 */

export class InvalidFcmTokenError extends Error {
  constructor(public readonly token: string) {
    super("FCM token not registered");
    this.name = "InvalidFcmTokenError";
  }
}

export interface FcmNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

@Injectable()
export class FcmClient implements OnModuleInit {
  private readonly logger = new Logger(FcmClient.name);

  private readonly keyPath?: string;
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {
    this.keyPath = this.config.get<string>("FCM_SERVICE_ACCOUNT_KEY_PATH");
  }

  onModuleInit(): void {
    if (!this.keyPath) {
      // Dev no-op: NEVER throw — mirrors EskizSmsClient PITFALLS C3.
      this.logger.warn(
        "[fcm dev no-op] FCM_SERVICE_ACCOUNT_KEY_PATH not set — push notifications disabled",
      );
      return;
    }

    try {
      const raw = fs.readFileSync(this.keyPath, "utf-8");
      const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;

      // Use a named app so multiple FcmClient instances in tests don't collide
      // with the default firebase-admin app.
      const appName = `sifat-fcm-${Date.now()}`;
      this.app = admin.initializeApp(
        { credential: admin.credential.cert(serviceAccount) },
        appName,
      );
      this.logger.log(`FCM ulandi (app=${appName})`);
    } catch (err) {
      this.logger.error(
        `FCM initializeApp xatosi: ${(err as Error).message} — push o'chirilgan rejimda`,
      );
      this.app = null;
      // Plan 05-01-fix audit-LOW — when the keyPath WAS configured (i.e. we
      // expect a working FCM in production) but the file is unreadable,
      // truncated, or malformed JSON, fail loudly rather than silently
      // degrading push notifications. Misconfigured Vault projections must
      // not pass the boot.
      if (isProductionEnv()) {
        throw err;
      }
    }
  }

  /**
   * Send a push notification to a single device token. Returns void on
   * success; throws InvalidFcmTokenError when the token is dead so the
   * caller (notification.processor in Plan 05-04) can prune the row.
   *
   * Dev no-op when env was unset: warns + returns without contacting FCM.
   */
  async sendToToken(
    token: string,
    payload: FcmNotificationPayload,
  ): Promise<void> {
    if (!this.app) {
      this.logger.warn(
        `[fcm dev no-op] would push to ${this._maskToken(token)}`,
      );
      return;
    }

    try {
      await this.app.messaging().send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });
      this.logger.log({ token: this._maskToken(token), status: "success" });
    } catch (err) {
      const code = (err as { errorInfo?: { code?: string }; code?: string })
        ?.errorInfo?.code ?? (err as { code?: string })?.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument"
      ) {
        this.logger.warn(
          `FCM dead token: ${this._maskToken(token)} (${code})`,
        );
        throw new InvalidFcmTokenError(token);
      }
      this.logger.error(
        `FCM send xatosi (${this._maskToken(token)}): ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Send to a topic (used by Plan 05-05 alert broadcasts to e.g. tuman admins).
   */
  async sendToTopic(
    topic: string,
    payload: FcmNotificationPayload,
  ): Promise<void> {
    if (!this.app) {
      this.logger.warn(`[fcm dev no-op] would push to topic=${topic}`);
      return;
    }

    try {
      await this.app.messaging().send({
        topic,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });
      this.logger.log({ topic, status: "success" });
    } catch (err) {
      this.logger.error(
        `FCM sendToTopic xatosi (topic=${topic}): ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /** Mask the token for log output — only the last 8 chars survive. */
  private _maskToken(token: string): string {
    if (!token || token.length < 8) return "***";
    return `***${token.slice(-8)}`;
  }
}
