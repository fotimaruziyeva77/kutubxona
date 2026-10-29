import { Injectable, BadRequestException, NotFoundException, UnauthorizedException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { BadgeService } from "../badge/badge.service";
import { CacheService } from "../../infra/cache/cache.service";
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import * as crypto from "crypto";
import { isDonationStubActive } from "../../common/utils/donation-stub-guard.util";
import { isProductionEnv } from "../../common/utils/production-env.util";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";
import { verifyPaymeBasicAuth } from "../payment/payme-auth.util";

type DonationPurpose = "LIBRARY_BOOKS" | "SCHOOL_BOOKS" | "GENERAL";

const PURPOSE_LABELS: Record<DonationPurpose, string> = {
  LIBRARY_BOOKS: "Kutubxona uchun kitob",
  SCHOOL_BOOKS: "Maktab uchun kitob",
  GENERAL: "Umumiy maqsad"
};

/**
 * SEC FIX C2 — Payme donate webhook body. Real Payme Merchant API posts
 * JSON-RPC 2.0 requests; the donate checkout URL carries ac.payment_id, so
 * account.payment_id is how Payme echoes our Donate.paymentId back.
 * The legacy `result.transaction` shape is ONLY honored by the dev stub path
 * (the /donate/stub/success page POSTs it — see isDonationStubActive).
 */
export interface PaymeDonateWebhookBody {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    id?: string;
    amount?: number;
    account?: { payment_id?: string };
  };
  // Dev-stub synthetic shape (never trusted outside isDonationStubActive).
  result?: { transaction?: string };
}

/**
 * SEC FIX C2 — Click donate webhook body (SHOP API form fields, all strings
 * on the wire). merchant_trans_id carries our Donate.paymentId — it is part
 * of the signed payload, unlike the previously-trusted transaction_param.
 */
export interface ClickDonateWebhookBody {
  click_trans_id?: string | number;
  service_id?: string | number;
  merchant_trans_id?: string;
  merchant_prepare_id?: string | number;
  amount?: string | number;
  action?: string | number;
  error?: number | string;
  sign_time?: string;
  sign_string?: string;
}

// Mirror of click.service.ts FIX 6 — 5-minute sign_time freshness window.
const CLICK_SIGN_TIME_SKEW_MS = 5 * 60 * 1000;

@Injectable()
export class DonateService {
  private readonly logger = new Logger(DonateService.name);
  private readonly paymeSecretKey: string;
  private readonly paymeTestKey: string;
  private readonly clickSecretKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly badge: BadgeService,
    private readonly cache: CacheService,
    private readonly config: ConfigService
  ) {
    // SEC FIX C2 — same key sources as the hardened PaymeService/ClickService.
    this.paymeSecretKey = this.config.get("PAYME_SECRET_KEY", "");
    this.paymeTestKey = this.config.get("PAYME_TEST_KEY", "");
    this.clickSecretKey = this.config.get("CLICK_SECRET_KEY", "");
  }

  // ── DONAT-01: dev stub flag predicate (mirrors auth.service.isOtpBypassed) ─
  private _isStubActive(): boolean {
    return isDonationStubActive(process.env);
  }

  // ── Donat yaratish (to'lov boshlashdan oldin) ────────────────────────────
  async initiateDonation(data: {
    userId?: string;
    amount: number;
    purpose: DonationPurpose;
    targetId?: string;
    targetName?: string;
    method: PaymentMethod;
    donorName?: string;
    isPublic?: boolean;
  }) {
    if (data.amount < 1000) {
      throw new BadRequestException("Minimal donat miqdori: 1,000 so'm");
    }
    if (data.amount > 100_000_000) {
      throw new BadRequestException("Maksimal donat miqdori: 100,000,000 so'm");
    }

    const paymentId = randomUUID();

    const donate = await this.prisma.donate.create({
      data: {
        userId: data.userId ?? null,
        amount: data.amount,
        purpose: data.purpose,
        targetId: data.targetId ?? null,
        targetName: data.targetName ?? PURPOSE_LABELS[data.purpose],
        paymentId,
        method: data.method,
        status: PaymentStatus.PENDING,
        donorName: data.donorName ?? null,
        isPublic: data.isPublic ?? true
      }
    });

    // DONAT-01: when the dev/test stub flag is honored (D-3) we short-circuit
    // to a synthetic in-app success page. Production never reaches here
    // because Plan 03-01 _assertDonationStubGuard throws at boot when the
    // flag is set under NODE_ENV=production.
    let paymentUrl: string;
    if (this._isStubActive()) {
      paymentUrl = `/donate/stub/success?paymentId=${paymentId}`;
    } else {
      paymentUrl = this.buildPaymentUrl(data.method, paymentId, data.amount);
    }

    return { donate, paymentUrl };
  }

  // ── SEC FIX C2: Payme donate webhook (REAL verification) ─────────────────
  // Pre-fix, _verifyPaymeSignature was a `return true` stub AND the controller
  // derived success from the attacker-controlled `!!body.result?.transaction`.
  // Now:
  //   1) The Basic Authorization header is verified against the Payme merchant
  //      key with timingSafeEqual via the shared verifyPaymeBasicAuth helper
  //      (empty/missing keys fail closed). The sandbox "Paycom" test-key
  //      branch is only honored outside production (SEC FIX H2 parity).
  //   2) Success derives ONLY from the JSON-RPC method: PerformTransaction →
  //      PAID, CancelTransaction → FAILED. Check/Create/other methods are
  //      acknowledged WITHOUT touching donation state (so the idempotency
  //      cache can't be poisoned before the perform arrives).
  // Dev exception: when isDonationStubActive (DEV_DONATION_PAYMENT_STUB=true +
  // NODE_ENV ∈ {development,test,dev}; production boot-guard throws if set),
  // the synthetic `{ id, result.transaction }` body POSTed by the
  // /donate/stub/success page is accepted without auth — same as before.
  async handlePaymeCallback(
    authHeader: string | undefined,
    body: PaymeDonateWebhookBody,
  ) {
    if (this._isStubActive()) {
      // DONAT-01 dev-stub path (frontend stub success page, no auth header).
      const stubPaymentId = body?.result?.transaction ?? body?.id;
      if (typeof stubPaymentId !== "string" || stubPaymentId.length === 0) {
        throw new BadRequestException("paymentId topilmadi");
      }
      return this.handlePaymentWebhook(stubPaymentId, !!body?.result?.transaction);
    }

    // Fail-closed Basic auth — identical mechanics to PaymeService._verifyAuth.
    verifyPaymeBasicAuth(authHeader, {
      secretKey: this.paymeSecretKey,
      testKey: this.paymeTestKey,
      allowTestKey: !isProductionEnv(),
    });

    const method = body?.method;
    if (typeof method !== "string" || method.length === 0) {
      throw new BadRequestException("Noto'g'ri so'rov: method yo'q");
    }

    // Only Perform/Cancel mutate donation state.
    if (method !== "PerformTransaction" && method !== "CancelTransaction") {
      this.logger.log(`Payme donate webhook: holatga ta'sir qilmaydigan method (${method})`);
      return { received: true };
    }

    // Donate checkout URL is built with ac.payment_id=<Donate.paymentId>, so
    // Payme echoes it back inside params.account. (The donate MVP does not
    // store Payme's own transaction id, hence no params.id lookup.)
    const paymentId = body?.params?.account?.payment_id;
    if (typeof paymentId !== "string" || paymentId.length === 0) {
      throw new BadRequestException("Noto'g'ri so'rov: account.payment_id yo'q");
    }

    return this.handlePaymentWebhook(paymentId, method === "PerformTransaction");
  }

  // ── SEC FIX C2: Click donate webhook (REAL verification) ─────────────────
  // Pre-fix, _verifyClickSignature was a `return true` stub AND the controller
  // derived success from `!body.error` — omitting `error` yielded PAID.
  // Now the md5 sign_string is verified exactly per the official Click formula
  // used in click.service.ts (incl. service_id and the 5-minute sign_time
  // freshness window), and success derives ONLY from verified semantics:
  // action="1" (complete) with error=0 → PAID; action="1" with error≠0 →
  // FAILED; action="0" (prepare) acknowledges without state change.
  async handleClickCallback(body: ClickDonateWebhookBody) {
    const {
      click_trans_id,
      service_id,
      merchant_trans_id,
      merchant_prepare_id,
      amount,
      action,
      error,
      sign_time,
      sign_string,
    } = body ?? {};

    // Fail closed when the merchant secret is not configured — md5 over an
    // empty secret would otherwise be attacker-computable.
    if (!this.clickSecretKey) {
      this.logger.warn("[SECURITY] CLICK_SECRET_KEY sozlanmagan — donate webhook rad etildi");
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }

    const actionStr = String(action);
    // Cross-action replay protection (mirror of click.service FIX 1): only
    // prepare ("0") and complete ("1") are valid actions.
    if (actionStr !== "0" && actionStr !== "1") {
      this.logger.warn(
        `[SECURITY] Click donate webhook: noma'lum action=${JSON.stringify(action)}`,
      );
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }
    // Complete MUST carry merchant_prepare_id — without this requirement a
    // captured Prepare body (signed with the prepare formula) could be
    // replayed as a Complete (click.service FIX 1 parity).
    if (actionStr === "1" && (merchant_prepare_id === undefined || merchant_prepare_id === null || merchant_prepare_id === "")) {
      this.logger.warn(
        "[SECURITY] Click donate webhook: complete merchant_prepare_id siz keldi",
      );
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }

    // sign_time 5-minute freshness window (click.service FIX 6 / FIX D1).
    if (!this._isClickSignTimeFresh(sign_time)) {
      this.logger.warn(
        `[SECURITY] Click donate webhook: sign_time eskirgan yoki noto'g'ri: ${sign_time}`,
      );
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }

    // service_id check when configured (click.service PAY-02 / R8 parity).
    const expectedServiceId = this.config.get<string>("CLICK_SERVICE_ID", "");
    if (expectedServiceId && String(service_id) !== expectedServiceId) {
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }

    // Official Click md5 formula (click.service._makeSign parity):
    //   prepare:  md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)
    //   complete: md5(click_trans_id + service_id + SECRET + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
    const raw =
      actionStr === "1"
        ? `${click_trans_id}${service_id}${this.clickSecretKey}${merchant_trans_id}${merchant_prepare_id}${amount}${action}${sign_time}`
        : `${click_trans_id}${service_id}${this.clickSecretKey}${merchant_trans_id}${amount}${action}${sign_time}`;
    const expectedSign = crypto.createHash("md5").update(raw).digest("hex");
    if (!this._safeHexEqual(expectedSign, String(sign_string ?? ""))) {
      throw new UnauthorizedException("Imzo tasdiqlanmadi");
    }

    // Signature valid from here on. merchant_trans_id is part of the signed
    // payload and carries our Donate.paymentId.
    if (typeof merchant_trans_id !== "string" || merchant_trans_id.length === 0) {
      throw new BadRequestException("Noto'g'ri so'rov: merchant_trans_id yo'q");
    }

    if (actionStr === "0") {
      // Prepare — acknowledge only; donation stays PENDING until complete.
      return { received: true };
    }

    // Complete: error is REQUIRED. A signed complete without a coercible
    // error field is malformed — reject rather than guess (fail closed).
    const errorNum = error === undefined || error === null || error === "" ? NaN : Number(error);
    if (!Number.isFinite(errorNum)) {
      throw new BadRequestException("Noto'g'ri so'rov: error maydoni yo'q");
    }

    return this.handlePaymentWebhook(merchant_trans_id, errorNum === 0);
  }

  // ── To'lov webhook yadrosi (faqat tekshiruvdan O'TGAN chaqiruvlar uchun) ──
  // DONAT-01: idempotency wrap — duplicate paymentId hits return the cached
  // response without touching the DB or invoking badge checks. Cache TTL is
  // 7 days (RESEARCH R3).
  // SEC FIX C2: provider verification now happens BEFORE this core, in
  // handlePaymeCallback / handleClickCallback. NEVER expose this method via a
  // route — it performs no authentication itself.
  async handlePaymentWebhook(paymentId: string, success: boolean) {
    return this.cache.remember(
      `donate:webhook:${paymentId}`,
      7 * 24 * 3600,
      async () => {
        const donate = await this.prisma.donate.findUnique({ where: { paymentId } });
        if (!donate) throw new NotFoundException("Donat topilmadi");

        await this.prisma.donate.update({
          where: { paymentId },
          data: {
            status: success ? PaymentStatus.PAID : PaymentStatus.FAILED
          }
        });

        if (success) {
          this.logger.log(`Donat tasdiqlandi: ${paymentId}, ${donate.amount} so'm`);
          if (donate.userId) {
            this.badge.checkAfterDonation(donate.userId).catch(() => {});
          }
        }

        return { received: true };
      },
    );
  }

  // ── Ochiq donatchilar ro'yhati ───────────────────────────────────────────
  // TOP-06: per D-TOP-06 minor names (≤14) are masked via maskNameIfMinor.
  // The mask applies only when the linked userId resolves to a child; if
  // userId is null (anonymous donor with parent-typed donorName), keep
  // donorName as-is.
  async getPublicDonors(limit = 50) {
    const donations = await this.prisma.donate.findMany({
      where: { status: PaymentStatus.PAID, isPublic: true },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        user: { select: { name: true, sifatId: true, dob: true } }
      }
    });

    return donations.map((d) => ({
      amount: d.amount,
      purpose: d.purpose,
      purposeLabel: PURPOSE_LABELS[d.purpose as DonationPurpose] ?? d.purpose,
      targetName: d.targetName,
      donorName: this._resolveDonorName(
        d.user as { name: string | null; dob: Date | null } | null,
        d.donorName,
      ),
      sifatId: d.user?.sifatId ?? null,
      createdAt: d.createdAt
    }));
  }

  /**
   * Resolve a display name for a donor:
   *  - If we have a linked user, run maskNameIfMinor (returns initials when ≤14).
   *  - Else fall back to the donor-typed name.
   *  - Else "Anonim".
   * Per D-TOP-06: anonymization is irreversible at the response layer — the
   * raw name never leaves the backend for a minor user.
   */
  private _resolveDonorName(
    user: { name: string | null; dob: Date | null } | null | undefined,
    donorName: string | null | undefined,
  ): string {
    if (user && user.dob) {
      return maskNameIfMinor(user.name, user.dob);
    }
    if (user && user.name) {
      return user.name;
    }
    return donorName ?? "Anonim";
  }

  // ── Statistika ───────────────────────────────────────────────────────────
  async getStats() {
    const [totalRaw, spentRaw, countRaw] = await Promise.all([
      this.prisma.donate.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { amount: true }
      }),
      this.prisma.donate.aggregate({
        where: { status: PaymentStatus.PAID, targetId: { not: null } },
        _sum: { amount: true }
      }),
      this.prisma.donate.count({ where: { status: PaymentStatus.PAID } })
    ]);

    const total = Number(totalRaw._sum.amount ?? 0);
    const spent = Number(spentRaw._sum.amount ?? 0);

    return {
      totalCollected: total,
      totalSpent: spent,
      remaining: total - spent,
      donorCount: countRaw
    };
  }

  // ── DONAT-02: sarflanish tarixi (jamoatchilik uchun) ─────────────────────
  // Returns the most recent N PAID donations where targetId is set (i.e.,
  // money was directed at a specific recipient). The frontend `/donate` page
  // already polls /donate/spending; before this method that endpoint 404'd.
  async getSpendingHistory(limit = 20) {
    const rows = await this.prisma.donate.findMany({
      where: { status: PaymentStatus.PAID, targetId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        amount: true,
        targetName: true,
        purpose: true,
        createdAt: true,
      },
    });
    return rows.map((d) => ({
      id: d.id,
      amount: Number(d.amount),
      description: d.targetName ?? PURPOSE_LABELS[d.purpose as DonationPurpose] ?? "Sarflandi",
      libraryName: d.targetName,
      createdAt: d.createdAt,
    }));
  }

  // ── DONAT-03: admin breakdown (SUPER_ADMIN + BUXGALTER) ──────────────────
  // Groups all PAID donations by recipient and by purpose. Anonymous donors
  // (userId IS NULL) are bucketed by their target+purpose only — donor
  // identity is not exposed at the admin layer either (T-03-03-I-2).
  async getAdminBreakdown() {
    const [byTarget, byPurpose, donorCount] = await Promise.all([
      this.prisma.donate.groupBy({
        by: ["targetId", "targetName"],
        where: { status: PaymentStatus.PAID },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.donate.groupBy({
        by: ["purpose"],
        where: { status: PaymentStatus.PAID },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.donate.count({ where: { status: PaymentStatus.PAID } }),
    ]);

    return {
      byTarget: byTarget.map((r) => ({
        targetId: r.targetId,
        targetName: r.targetName,
        totalAmount: Number(r._sum.amount ?? 0),
        donationCount: r._count.id,
      })),
      byPurpose: byPurpose.map((r) => ({
        purpose: r.purpose,
        purposeLabel: PURPOSE_LABELS[r.purpose as DonationPurpose] ?? r.purpose,
        totalAmount: Number(r._sum.amount ?? 0),
        donationCount: r._count.id,
      })),
      totalDonorCount: donorCount,
    };
  }

  // ── Sarflash qayd etish (admin) ──────────────────────────────────────────
  async recordSpending(donateId: string, targetId: string, targetName: string) {
    return this.prisma.donate.update({
      where: { id: donateId },
      data: { targetId, targetName }
    });
  }

  // ── Top-50 donatchilar (jami sarflangan miqdor bo'yicha) ────────────────
  // TOP-06: minor donor names masked at the response layer.
  async getTopDonors(limit = 50) {
    const result = await this.prisma.donate.groupBy({
      by: ["userId", "donorName"],
      where: { status: PaymentStatus.PAID, isPublic: true, userId: { not: null } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
      take: limit
    });

    const userIds = result.map((r) => r.userId).filter(Boolean) as string[];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, sifatId: true, dob: true }
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return result.map((r, i) => {
      const user = r.userId ? userMap.get(r.userId) : null;
      return {
        rank: i + 1,
        totalAmount: Number(r._sum.amount ?? 0),
        donorName: this._resolveDonorName(
          user
            ? { name: user.name, dob: user.dob }
            : null,
          r.donorName,
        ),
        sifatId: user?.sifatId ?? null
      };
    });
  }

  // ── SEC FIX C2: Click verification helpers (click.service.ts parity) ─────

  /**
   * Constant-time hex compare — mirror of ClickService._safeHexEqual
   * (Plan 04-01 audit-fix FIX 5). timingSafeEqual throws on length mismatch;
   * length-check first and treat any throw as inequality.
   */
  private _safeHexEqual(a: string, b: string): boolean {
    try {
      const aBuf = Buffer.from(a, "hex");
      const bBuf = Buffer.from(b, "hex");
      if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
      return crypto.timingSafeEqual(aBuf, bBuf);
    } catch {
      return false;
    }
  }

  /**
   * sign_time 5-minute freshness — mirror of ClickService._isSignTimeFresh
   * (Plan 04-01 FIX 6 + Plan 04-02 FIX D1). Click sends "YYYY-MM-DD HH:MM:SS"
   * as Asia/Tashkent wall-clock (UTC+5); anchor with +05:00 unless the value
   * is already ISO 8601. Returns false on unparseable input.
   */
  private _isClickSignTimeFresh(signTime: string | undefined): boolean {
    if (!signTime || typeof signTime !== "string") return false;
    const iso = signTime.includes("T")
      ? signTime
      : signTime.replace(" ", "T") + "+05:00";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return false;
    return Math.abs(Date.now() - ts) <= CLICK_SIGN_TIME_SKEW_MS;
  }

  // ── Payme/Click to'lov URL yasash (stub) ─────────────────────────────────
  private buildPaymentUrl(method: PaymentMethod, paymentId: string, amount: number): string {
    const amountTiyin = Math.round(amount * 100);
    if (method === PaymentMethod.PAYME) {
      const params = Buffer.from(
        `m=MERCHANT_ID;ac.payment_id=${paymentId};a=${amountTiyin};l=uz`
      ).toString("base64");
      return `https://checkout.paycom.uz/${params}`;
    }
    if (method === PaymentMethod.CLICK) {
      return `https://my.click.uz/services/pay?service_id=CLICK_SERVICE_ID&merchant_id=CLICK_MERCHANT_ID&amount=${amount}&transaction_param=${paymentId}&return_url=https://sifat.uz/donate/callback`;
    }
    return `https://sifat.uz/donate/bank?id=${paymentId}&amount=${amount}`;
  }
}
