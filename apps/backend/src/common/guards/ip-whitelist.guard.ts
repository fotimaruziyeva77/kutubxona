import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { isProductionEnv } from "../utils/production-env.util";

/**
 * Plan 03-01 Task 1 — DONAT-01 hardening primitive.
 * Plan 04-02 audit-fix Group A (A1, A2) — fail-CLOSED in production +
 * drop X-Forwarded-For spoof surface in favour of Express `trust proxy`.
 *
 * Reads a CSV env var (default `PAYME_IP_WHITELIST`) and enforces that
 * incoming requests originate from one of the listed source IPs.
 *
 *   - In PRODUCTION (NODE_ENV=production), an unset/empty CSV is FATAL:
 *     a [SECURITY] error is logged and `ForbiddenException` is thrown.
 *     This prevents a misconfigured prod container from silently accepting
 *     webhook traffic from anywhere on the internet.
 *   - In dev/staging the guard remains permissive (returns true) when the
 *     env is unset — operator-friendly default for local testing.
 *
 * Per-route env-key override via the sibling `@IpWhitelist("CLICK_IP_WHITELIST")`
 * decorator. Default key when no metadata is set: `PAYME_IP_WHITELIST`.
 *
 * Consumer plan 03-03 wires this onto the donate webhook endpoints alongside
 * `@Public()` (webhook is external by definition).
 *
 * IP resolution: relies on Express `req.ip`, which is correctly populated when
 * the bootstrap calls `app.set('trust proxy', N)` per the deployment topology.
 * The pre-04-02 implementation also parsed `X-Forwarded-For` directly — that
 * was a SPOOF SURFACE because an attacker could set the header to any
 * whitelisted IP and bypass the guard regardless of Express trust-proxy
 * config. Removed; `req.ip` is the only source of truth.
 */

export const IP_WHITELIST_ENV_KEY = "ipWhitelistEnvKey" as const;

/** Per-route decorator: `@IpWhitelist("CLICK_IP_WHITELIST")`. */
export const IpWhitelist = (envKey: string) =>
  SetMetadata(IP_WHITELIST_ENV_KEY, envKey);

const DEFAULT_ENV_KEY = "PAYME_IP_WHITELIST";

@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);
  // Track keys for which we have already warned about empty config so the
  // permissive-fallback warning fires at most once per process lifetime.
  private readonly warnedKeys = new Set<string>();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const envKey =
      this.reflector.getAllAndOverride<string>(IP_WHITELIST_ENV_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? DEFAULT_ENV_KEY;

    const csv = this.config.get<string>(envKey);
    if (!csv || csv.trim() === "") {
      // FIX A1 — fail-CLOSED in production. An empty CSV in prod means the
      // operator forgot to configure the whitelist; allowing traffic from
      // anywhere on the public internet (especially for payment webhooks) is
      // unacceptable. Throwing ForbiddenException is loud + visible + safe.
      if (isProductionEnv()) {
        this.logger.error(
          `[SECURITY] ${envKey} is unset in production — refusing all webhook traffic. ` +
            `Set this env to a CSV of allowed IPs from the payment provider's docs before deploying.`,
        );
        throw new ForbiddenException("IP whitelist required in production");
      }

      // Dev/staging: permissive fallback for operator convenience.
      if (!this.warnedKeys.has(envKey)) {
        this.warnedKeys.add(envKey);
        this.logger.warn(
          `[IpWhitelistGuard] ${envKey} is unset — webhook permits ALL source IPs (dev/staging only). ` +
            `Set this env to a CSV of allowed IPs before going to production.`,
        );
      }
      return true;
    }

    const allowed = new Set(
      csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

    const req = ctx.switchToHttp().getRequest();
    const clientIp = this.extractClientIp(req);

    if (clientIp && allowed.has(clientIp)) return true;

    throw new ForbiddenException("IP whitelist rejected");
  }

  /**
   * FIX A2 — single source of truth: Express `req.ip`. Express derives this
   * correctly per `app.set('trust proxy', N)` configured in main.ts. Manually
   * peeking at X-Forwarded-For (which the pre-04-02 code did) bypassed
   * trust-proxy entirely and let any attacker spoof a whitelisted IP via the
   * header. `req.connection.remoteAddress` retained ONLY as a defensive
   * last-resort for unusual transports.
   */
  private extractClientIp(req: unknown): string | null {
    const r = req as {
      ip?: string;
      connection?: { remoteAddress?: string };
    };
    if (r.ip) return r.ip;
    return r.connection?.remoteAddress ?? null;
  }
}
