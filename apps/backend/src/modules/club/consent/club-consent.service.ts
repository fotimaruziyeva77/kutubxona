import {
  Injectable,
  Logger,
  NotFoundException,
  GoneException,
  BadRequestException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";
import { RedisLockService } from "../../../infra/cache/redis-lock.service";

/**
 * Plan 06-04 SCH-04 — Parent SMS consent token deep-link service.
 *
 * Replaces the legacy "reply HA <memberId>" UX with a bcrypt-hashed token
 * sent via SMS as a deep-link. Parent taps the link → frontend SSR page
 * POSTs the token back → backend verifies via bcrypt.compare in constant
 * time + flips ClubMember.status atomically.
 *
 * Threat model:
 *   - T-06-05  Spoof: 128-bit nonce + bcrypt(10) defeats brute-force
 *   - T-06-05b Replay: consumedAt single-use field; tx writes consumedAt
 *                       in same $transaction as state flip
 *   - T-06-05c URL leak: V1 acceptable per research §Pitfall 6 (48h TTL +
 *                       single-use bounds exposure)
 *   - T-06-05d Forgery: leader never sees nonce — bcrypt hash only stored
 *   - T-06-05e Info disclosure: peek() returns minimum info per D-OQ-4
 *   - T-06-S4  Timing attack: bcrypt.compare is constant-time + 200ms
 *                       artificial delay on miss
 *
 * SMS rate-limit:
 *   - 3 attempts per memberId per 24h (defeats SMS bombing of a parent's
 *     phone if attacker repeatedly enrolls the same child).
 */

const TOKEN_TTL_HOURS = 48;
const TOKEN_TTL_SECONDS = TOKEN_TTL_HOURS * 60 * 60; // 172_800s
const BCRYPT_COST = 10;
const NONCE_BYTES = 16; // 16 bytes = 128 bits = 32 hex chars
const SMS_RATE_LIMIT_PER_DAY = 3;
const SMS_RATE_WINDOW_SECONDS = 24 * 60 * 60;
const MIN_VERIFY_DELAY_MS = 200; // anti-timing-side-channel pad
const CANDIDATE_SCAN_LIMIT = 1000; // safety cap for active-token scan

/**
 * SMS template — single-line, sanitized of newlines and semicolons.
 * Frontend deep-link must match: `sifat.uz/uz-Latn/club/consent?t={nonce}`.
 */
function buildConsentSms(childName: string, clubName: string, nonce: string): string {
  // Defang any SMS-breaking chars before interpolation.
  const safeChild = sanitizeForSms(childName);
  const safeClub = sanitizeForSms(clubName);
  return `SIFAT LIBRARY: ${safeChild} farzandingiz '${safeClub}' klubiga taklif qilingan. Tasdiqlash: sifat.uz/uz-Latn/club/consent?t=${nonce}. Muddati 48 soat.`;
}

function sanitizeForSms(s: string): string {
  return s.replace(/[\r\n;]+/g, " ").trim();
}

export type ConsentAction = "APPROVE" | "REJECT";

export interface ConsentPeekResult {
  childName: string;
  clubName: string;
  leaderName: string;
}

@Injectable()
export class ClubConsentService {
  private readonly logger = new Logger(ClubConsentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly cache: CacheService,
    private readonly lock?: RedisLockService,
  ) {}

  /**
   * Mint a new bcrypt-hashed consent token + enqueue SMS to parentPhone.
   *
   * Returns the plaintext nonce ONLY in the return value — caller MUST NOT
   * log it. The bcrypt hash is what lands in the DB.
   *
   * Rate-limited to 3 SMS sends per clubMemberId per 24h (T-06-05 SMS bomb).
   */
  async mintAndSend(args: {
    clubMemberId: string;
    parentPhone: string;
    childName: string;
    clubName: string;
  }): Promise<{ nonce: string; expiresAt: Date }> {
    // ── SMS rate-limit (3 / 24h per memberId) ─────────────────────────────
    const rlKey = `consent-sms:${args.clubMemberId}`;
    const count = await this.cache.incrWithTtl(rlKey, SMS_RATE_WINDOW_SECONDS);
    if (count > SMS_RATE_LIMIT_PER_DAY) {
      throw new BadRequestException(
        "Juda ko'p SMS so'rovi — 24 soatdan so'ng urinib ko'ring",
      );
    }

    // 32-hex nonce = 128 bits of entropy
    const nonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
    const tokenHash = await bcrypt.hash(nonce, BCRYPT_COST);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    // Upsert — one active token per clubMember (the schema enforces
    // clubMemberId UNIQUE). Re-minting replaces the old hash.
    await this.prisma.clubMemberConsentToken.upsert({
      where: { clubMemberId: args.clubMemberId },
      create: {
        clubMemberId: args.clubMemberId,
        tokenHash,
        expiresAt,
      },
      update: {
        tokenHash,
        expiresAt,
        consumedAt: null,
      },
    });

    const body = buildConsentSms(args.childName, args.clubName, nonce);
    await this.sms.sendNotification(args.parentPhone, body, args.clubMemberId);
    this.logger.log(
      `Consent SMS enqueued for member=${args.clubMemberId} (hash stored, ttl=${TOKEN_TTL_HOURS}h)`,
    );

    return { nonce, expiresAt };
  }

  /**
   * Verify a plaintext nonce against the stored bcrypt hash and flip
   * ClubMember.status accordingly.
   *
   * Per-row bcrypt scan over active+unconsumed tokens (LIMIT 1000) — at
   * realistic enrollment rates the active set is small enough that O(n) is
   * fine. A tokenLookup column for indexed lookup is deferred to V2.
   *
   * Returns the updated ClubMember on success. Throws:
   *   - NotFoundException if no match (after 200ms anti-timing pad)
   *   - GoneException if the row is expired or already consumed
   */
  async confirmByToken(token: string, action: ConsentAction): Promise<{ memberId: string; status: string; clubId: string }> {
    if (typeof token !== "string" || token.length !== NONCE_BYTES * 2) {
      // Not a well-formed nonce — short-circuit but still pad.
      await this._padDelay();
      throw new NotFoundException("Token topilmadi yoki muddati o'tgan");
    }

    const candidates = await this.prisma.clubMemberConsentToken.findMany({
      where: {
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: CANDIDATE_SCAN_LIMIT,
    });

    if (candidates.length === CANDIDATE_SCAN_LIMIT) {
      this.logger.warn(
        `confirmByToken: hit ${CANDIDATE_SCAN_LIMIT}-candidate scan cap — consider adding tokenLookup column in V2`,
      );
    }

    let matched: typeof candidates[0] | null = null;
    for (const c of candidates) {
      // bcrypt.compare is constant-time wrt the tokenHash length, so an
      // attacker cannot learn anything about which candidate matched. The
      // O(n) iteration leaks "how many active candidates exist" — that's
      // acceptable per threat model.
      // eslint-disable-next-line no-await-in-loop
      const ok = await bcrypt.compare(token, c.tokenHash);
      if (ok) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      await this._padDelay();
      throw new NotFoundException("Token topilmadi yoki muddati o'tgan");
    }

    // Defense-in-depth: re-check expiry/consumed in the tx (race-safe).
    const newStatus = action === "APPROVE" ? "ACTIVE" : "LEFT";
    const updated = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.clubMemberConsentToken.findUnique({
        where: { id: matched!.id },
      });
      if (!fresh) {
        throw new NotFoundException("Token topilmadi yoki muddati o'tgan");
      }
      if (fresh.consumedAt) {
        throw new GoneException("Token allaqachon ishlatilgan");
      }
      if (fresh.expiresAt <= new Date()) {
        throw new GoneException("Token muddati o'tgan");
      }
      await tx.clubMemberConsentToken.update({
        where: { id: fresh.id },
        data: { consumedAt: new Date() },
      });
      const memberRow = await tx.clubMember.update({
        where: { id: fresh.clubMemberId },
        data:
          action === "APPROVE"
            ? {
                status: "ACTIVE",
                parentConsented: true,
                joinedAt: new Date(),
              }
            : {
                status: "LEFT",
                parentConsented: false,
                leftAt: new Date(),
              },
      });
      await tx.aiAuditLog.create({
        data: {
          scope: "CLUB_MEMBER",
          scopeId: memberRow.id,
          issueType:
            action === "APPROVE"
              ? "PARENT_CONSENT_APPROVED"
              : "PARENT_CONSENT_REJECTED",
          severity: "LOW",
          analysis: `Parent consent ${action.toLowerCase()}d via SMS deep-link`,
          recommendation: "",
        },
      });
      return memberRow;
    });

    this.logger.log(
      `Consent ${action} member=${updated.id} status=${newStatus}`,
    );
    return { memberId: updated.id, status: newStatus, clubId: updated.clubId };
  }

  /**
   * Public peek — used by /club/consent/info SSR endpoint to render the
   * "Roziman / Rad etaman" buttons with MINIMUM info per D-OQ-4:
   *   { childName, clubName, leaderName }
   *
   * Same bcrypt scan as confirmByToken but does NOT consume the token.
   * Throws NotFoundException if no match.
   */
  async peek(token: string): Promise<ConsentPeekResult> {
    if (typeof token !== "string" || token.length !== NONCE_BYTES * 2) {
      await this._padDelay();
      throw new NotFoundException("Token topilmadi yoki muddati o'tgan");
    }

    const candidates = await this.prisma.clubMemberConsentToken.findMany({
      where: {
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: CANDIDATE_SCAN_LIMIT,
    });

    let matchedMemberId: string | null = null;
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await bcrypt.compare(token, c.tokenHash);
      if (ok) {
        matchedMemberId = c.clubMemberId;
        break;
      }
    }

    if (!matchedMemberId) {
      await this._padDelay();
      throw new NotFoundException("Token topilmadi yoki muddati o'tgan");
    }

    const member = await this.prisma.clubMember.findUnique({
      where: { id: matchedMemberId },
      include: {
        club: { select: { name: true, leaderId: true } },
      },
    });
    if (!member) {
      throw new NotFoundException("A'zolik topilmadi");
    }
    const [user, leader] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: member.userId },
        select: { name: true },
      }),
      this.prisma.user.findUnique({
        where: { id: member.club.leaderId },
        select: { name: true },
      }),
    ]);

    return {
      childName: user?.name ?? "(noma'lum)",
      clubName: member.club.name,
      leaderName: leader?.name ?? "(noma'lum)",
    };
  }

  /**
   * Plan 06-04 SCH-04 — expiry cron.
   *
   * Every 6 hours, scan expired+unconsumed tokens and flip the associated
   * ClubMember to LEFT + write AiAuditLog. Wrapped in a Redis SETNX leader
   * lock so multi-replica clusters do not double-run.
   */
  @Cron("0 */6 * * *", {
    name: "club-consent-expiry-scan",
    timeZone: "Asia/Tashkent",
  })
  async scanExpired(): Promise<void> {
    if (!this.lock) {
      this.logger.warn(
        "scanExpired skipped — RedisLockService not wired (dev/tests)",
      );
      return;
    }
    const key = "lock:club-consent-expiry-scan";
    const traceId = `consent-expiry-${Date.now()}`;
    const acquire = await this.lock.tryAcquire(key, 10 * 60, traceId); // 10 min TTL
    if (!acquire.first) {
      this.logger.log(
        "scanExpired: lock not acquired — another replica owns the run",
      );
      return;
    }
    return this._scanExpiredImpl();
  }

  /** Inner implementation — exposed for unit testing without cron timing. */
  async _scanExpiredImpl(): Promise<void> {
    const expired = await this.prisma.clubMemberConsentToken.findMany({
      where: {
        consumedAt: null,
        expiresAt: { lt: new Date() },
      },
      take: 10_000,
      select: { id: true, clubMemberId: true },
    });

    if (expired.length === 0) {
      this.logger.log("scanExpired: 0 expired tokens");
      return;
    }

    this.logger.log(`scanExpired: ${expired.length} expired tokens — flipping LEFT`);

    for (const t of expired) {
      try {
        await this.prisma.$transaction([
          this.prisma.clubMemberConsentToken.update({
            where: { id: t.id },
            data: { consumedAt: new Date() },
          }),
          this.prisma.clubMember.update({
            where: { id: t.clubMemberId },
            data: { status: "LEFT", leftAt: new Date() },
          }),
          this.prisma.aiAuditLog.create({
            data: {
              scope: "CLUB_MEMBER",
              scopeId: t.clubMemberId,
              issueType: "PARENT_CONSENT_EXPIRED",
              severity: "LOW",
              analysis: "Parent consent token expired without action (48h TTL)",
              recommendation: "Re-invite via club admin if appropriate",
            },
          }),
        ]);
      } catch (err) {
        // Don't fail the whole batch on one stale row.
        this.logger.warn(
          `scanExpired: token=${t.id} flip skipped: ${(err as Error).message}`,
        );
      }
    }
  }

  private async _padDelay(): Promise<void> {
    await new Promise((r) => setTimeout(r, MIN_VERIFY_DELAY_MS));
  }
}
