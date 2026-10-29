import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client } from "minio";

/**
 * Plan 06-01 Task 1 — MinIO storage wrapper (Phase 6 SCH-05/ORG-04/UNI-03).
 *
 * Mirrors the EskizSmsClient / FcmClient / MailClient dev-fallback pattern:
 *   1. Constructor reads MINIO_ENDPOINT / PORT / ACCESS_KEY / SECRET_KEY /
 *      USE_SSL via ConfigService.
 *   2. onModuleInit lazily creates the MinIO Client. If MINIO_ENDPOINT is
 *      unset, logs `[minio dev no-op]` ONCE and leaves this.client = null.
 *      Methods then throw "MinIO not configured" — NEVER silent-succeed.
 *   3. Production fail-hard is enforced earlier in main.ts._assertEnvVars via
 *      PRODUCTION_REQUIRED_ENV (extension lands alongside this commit).
 *   4. ensureBucket runs at module init for the 3 required buckets (DEBATES,
 *      BOOKCORNERS, READINGHOURS). Fail-soft on unreachable MinIO so dev boots
 *      even with the docker container down.
 *
 * Threat model:
 *   - T-06-07 (Info disclosure via leaked URL): presignedGetUrl hard-caps TTL
 *     at 3600s and rejects values below 60s or above the cap. Non-negotiable
 *     per CONTEXT.md OQ-decision.
 *   - Backend-controlled keys only — no user-supplied bucket name ever
 *     reaches the SDK.
 */

const MAX_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);

  private readonly endpoint?: string;
  private readonly port: number;
  private readonly useSSL: boolean;
  private readonly accessKey?: string;
  private readonly secretKey?: string;

  /** Buckets required by Phase 6 — created on init when MinIO is reachable. */
  readonly bucketDebates: string;
  readonly bucketBookCorners: string;
  readonly bucketReadingHours: string;

  private client: Client | null = null;
  private warnedDisabled = false;

  constructor(private readonly config: ConfigService) {
    this.endpoint = this.config.get<string>("MINIO_ENDPOINT") || undefined;
    this.port = Number(this.config.get<string>("MINIO_PORT") ?? "9000");
    this.useSSL =
      (this.config.get<string>("MINIO_USE_SSL") ?? "false").toLowerCase() ===
      "true";
    this.accessKey = this.config.get<string>("MINIO_ACCESS_KEY") || undefined;
    this.secretKey = this.config.get<string>("MINIO_SECRET_KEY") || undefined;
    this.bucketDebates =
      this.config.get<string>("MINIO_BUCKET_DEBATES") ?? "debate-media";
    this.bucketBookCorners =
      this.config.get<string>("MINIO_BUCKET_BOOKCORNERS") ??
      "bookcorner-photos";
    this.bucketReadingHours =
      this.config.get<string>("MINIO_BUCKET_READINGHOURS") ??
      "readinghour-media";
  }

  async onModuleInit(): Promise<void> {
    if (!this.endpoint) {
      this._warnDisabled();
      return;
    }

    try {
      this.client = new Client({
        endPoint: this.endpoint,
        port: this.port,
        useSSL: this.useSSL,
        accessKey: this.accessKey ?? "",
        secretKey: this.secretKey ?? "",
      });
      this.logger.log(
        `MinIO ulandi: ${this.endpoint}:${this.port} (ssl=${this.useSSL})`,
      );

      // Bootstrap the 3 required buckets — fail-soft so dev boots even when
      // the docker container is down.
      await Promise.all([
        this._ensureBucketSafe(this.bucketDebates),
        this._ensureBucketSafe(this.bucketBookCorners),
        this._ensureBucketSafe(this.bucketReadingHours),
      ]);
    } catch (err) {
      this.logger.error(
        `MinIO ulanish xatosi: ${(err as Error).message} — uploads will throw at call time`,
      );
      this.client = null;
    }
  }

  /**
   * Idempotent bucket creation. Caller guarantees `bucket` is a backend-owned
   * literal (never user-supplied).
   */
  async ensureBucket(bucket: string): Promise<void> {
    this._assertClient();
    const exists = await this.client!.bucketExists(bucket);
    if (!exists) {
      await this.client!.makeBucket(bucket, "");
      this.logger.log(`MinIO bucket yaratildi: ${bucket}`);
    }
  }

  /**
   * Upload an object to MinIO.
   * Returns void; the caller composes the URL via presignedGetUrl when needed.
   */
  async putObject(
    bucket: string,
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    this._assertClient();
    const meta: Record<string, string> = {
      "Content-Type": contentType,
      ...(metadata ?? {}),
    };
    await this.client!.putObject(bucket, key, buffer, buffer.length, meta);
  }

  /**
   * Stream an object back. Returns the MinIO stream — caller pipes to
   * response or buffers for processing.
   */
  async getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    this._assertClient();
    return this.client!.getObject(bucket, key);
  }

  /**
   * Generate a short-lived signed GET URL.
   * Hard-capped at 3600s (1 hour) per CONTEXT.md OQ-decision (T-06-07).
   * Throws on out-of-range TTL — never silently clamp.
   */
  async presignedGetUrl(
    bucket: string,
    key: string,
    ttlSeconds: number = MAX_TTL_SECONDS,
  ): Promise<string> {
    if (
      !Number.isFinite(ttlSeconds) ||
      ttlSeconds < MIN_TTL_SECONDS ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new Error(
        `MinIO presignedGetUrl TTL must be between ${MIN_TTL_SECONDS}s and ${MAX_TTL_SECONDS}s (got ${ttlSeconds})`,
      );
    }
    this._assertClient();
    return this.client!.presignedGetObject(bucket, key, ttlSeconds);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _assertClient(): void {
    if (!this.client) {
      throw new Error("MinIO not configured");
    }
  }

  private _warnDisabled(): void {
    if (this.warnedDisabled) return;
    this.warnedDisabled = true;
    this.logger.warn(
      "[minio dev no-op] MINIO_ENDPOINT not set — uploads will throw",
    );
  }

  private async _ensureBucketSafe(bucket: string): Promise<void> {
    try {
      const exists = await this.client!.bucketExists(bucket);
      if (!exists) {
        await this.client!.makeBucket(bucket, "");
        this.logger.log(`MinIO bucket yaratildi: ${bucket}`);
      }
    } catch (err) {
      this.logger.warn(
        `MinIO bucket ensure skipped (${bucket}): ${(err as Error).message}`,
      );
    }
  }
}
