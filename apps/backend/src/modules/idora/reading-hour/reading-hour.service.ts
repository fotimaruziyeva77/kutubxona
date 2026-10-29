import {
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  GoneException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../../infra/prisma/prisma-replica.service";
import { CacheService } from "../../../infra/cache/cache.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
} from "../../../common/utils/admin-scope.util";
import { UserRole } from "@prisma/client";

/**
 * Plan 06-06 ORG-03 — Reading Hour (kitob o'qish soati) CRUD + HMAC-rotating
 * QR + attendance + monthly summary.
 *
 * Security boundaries:
 *   - QR token rotates every 5 minutes (CLAUDE.md §VIII.1 dynamic QR;
 *     §XV.R22 screenshot-replay defence).
 *   - Verify accepts CURRENT and PREVIOUS window for clock-drift tolerance.
 *   - crypto.timingSafeEqual on the HMAC compare — never `===`.
 *   - assertInstitutionInScope BEFORE any side effect (create/finalize/attend).
 *   - Subscription gate (ACTIVE/TRIAL) on event creation.
 *   - Attendance uses ReadingHourAttendee.@@unique(readingHourId,userId);
 *     P2002 unique-violation → 409 Conflict.
 *   - Attendance tolerance: |scheduledAt - now| ≤ 2 hours (rejects backdated
 *     events / replay long after event ended).
 *
 * Threat model:
 *   - T-06-R1 (screenshot replay): rotating-HMAC + previous-window grace.
 *   - T-06-R2 (cross-org scan): user.organizationId === event.institutionId.
 *   - T-06-R3 (dupe attendance): @@unique constraint + 409 response.
 *   - T-06-R4 (backdated event): ±2h scheduledAt window.
 *   - T-06-R8 (subscription bypass): assertSubscriptionActive on create.
 */

const QR_WINDOW_MS = 5 * 60 * 1000; // 5 minute rotation
const ATTEND_TOLERANCE_MS = 2 * 60 * 60 * 1000; // ±2 hours around scheduledAt

export interface CreateReadingHourDto {
  title?: string;
  heldAt: string;
  venue?: string;
  durationMin?: number;
  notes?: string;
}

export interface QrTokenResult {
  token: string;
  expiresAt: Date;
  windowStart: number;
}

@Injectable()
export class ReadingHourService {
  private readonly logger = new Logger(ReadingHourService.name);
  private readonly qrSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    @Optional() private readonly replicaParam?: PrismaReplicaService,
  ) {
    this.qrSecret =
      this.config.get<string>("QR_HMAC_SECRET") ??
      "dev-qr-hmac-secret-rotateMe";
    if (
      this.qrSecret === "dev-qr-hmac-secret-rotateMe" &&
      process.env.NODE_ENV === "production"
    ) {
      // Fail-CLOSED in prod when secret was not provisioned.
      throw new Error("QR_HMAC_SECRET must be set in production");
    }
  }

  private get r(): PrismaService | PrismaReplicaService {
    return (this.replicaParam as PrismaReplicaService | undefined) ?? this.prisma;
  }

  // ── Scope + subscription guards (mirror IdoraService internals) ──────────

  private async _assertScope(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (!user) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { id: true, type: true, viloyatId: true, tumanId: true },
    });
    if (!inst) throw new NotFoundException("Idora topilmadi");
    if (inst.type !== "IDORA") {
      throw new BadRequestException(
        "Kitob o'qish soati faqat idora muassasalari uchun",
      );
    }
    assertInstitutionInScope(user, institutionId, {
      viloyatId: inst.viloyatId,
      tumanId: inst.tumanId,
      type: inst.type as any,
    });
  }

  private async _assertSubscriptionActive(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<void> {
    if (user?.role === UserRole.SUPER_ADMIN) return;
    const inst = await this.r.institution.findUnique({
      where: { id: institutionId },
      select: { libraryId: true },
    });
    if (!inst?.libraryId) return; // GOV/MAH free tier
    const sub = await this.r.subscription.findFirst({
      where: { libraryId: inst.libraryId },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    if (!sub) return;
    if (sub.status !== "ACTIVE" && sub.status !== "TRIAL") {
      throw new ForbiddenException(
        "Idora obunasi muzlatilgan/o'chirilgan — to'lov amalga oshiring",
      );
    }
  }

  // ── HMAC rotating-window helpers ─────────────────────────────────────────

  /**
   * Floor `now` to the 5-minute rotation bucket. Pure function for testability.
   */
  private getCurrentWindow(now: number = Date.now()): number {
    return Math.floor(now / QR_WINDOW_MS) * QR_WINDOW_MS;
  }

  private signWindow(readingHourId: string, windowStart: number): string {
    return crypto
      .createHmac("sha256", this.qrSecret)
      .update(`${readingHourId}|${windowStart}`)
      .digest("hex");
  }

  // ── Reading Hour CRUD + state machine ────────────────────────────────────

  async createReadingHour(
    institutionId: string,
    recordedById: string,
    dto: CreateReadingHourDto,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    await this._assertSubscriptionActive(institutionId, user);

    if (!dto?.heldAt) {
      throw new BadRequestException("heldAt majburiy");
    }
    const heldAt = new Date(dto.heldAt);
    if (Number.isNaN(heldAt.getTime())) {
      throw new BadRequestException("heldAt formati noto'g'ri");
    }

    const row = await this.prisma.readingHour.create({
      data: {
        institutionId,
        recordedById,
        title: dto.title?.trim() || "Kitob o'qish soati",
        heldAt,
        venue: dto.venue,
        durationMin: dto.durationMin ?? 60,
        notes: dto.notes,
        status: "DRAFT",
        mediaUrls: [],
      } as any,
    });

    await this.prisma.aiAuditLog.create({
      data: {
        scope: "READING_HOUR",
        scopeId: row.id,
        issueType: "READING_HOUR_CREATED",
        severity: "LOW",
        analysis: `Reading Hour created by ${recordedById} for institution ${institutionId}`,
        recommendation: "",
      },
    });

    return row;
  }

  async listReadingHours(
    institutionId: string,
    opts: { month?: string; status?: string; page?: number; limit?: number } = {},
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const { page = 1, limit = 20, status, month } = opts;
    const skip = (page - 1) * limit;

    const where: any = { institutionId };
    if (status && status !== "ALL") {
      where.status = status;
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      const monthStart = new Date(Date.UTC(y, m - 1, 1));
      const monthEnd = new Date(Date.UTC(y, m, 1));
      where.heldAt = { gte: monthStart, lt: monthEnd };
    } else if (!month) {
      // Default last 3 months
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 3);
      where.heldAt = { gte: cutoff };
    }

    const [items, total] = await Promise.all([
      this.r.readingHour.findMany({
        where,
        include: { _count: { select: { attendances: true, media: true } } },
        orderBy: { heldAt: "desc" },
        skip,
        take: limit,
      }),
      this.r.readingHour.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async getReadingHourDetail(
    institutionId: string,
    readingHourId: string,
    user?: InstitutionScopedUser,
  ) {
    await this._assertScope(institutionId, user);
    const event = await this.r.readingHour.findUnique({
      where: { id: readingHourId },
      include: {
        attendances: {
          select: { id: true, userId: true, markedAt: true },
          orderBy: { markedAt: "asc" },
        },
        media: {
          select: {
            id: true,
            url: true,
            mimeType: true,
            sizeBytes: true,
            uploadedAt: true,
          },
          orderBy: { uploadedAt: "asc" },
        },
      },
    });
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new NotFoundException("Tadbir topilmadi");
    }
    return event;
  }

  /**
   * Finalize a DRAFT reading hour → PUBLISHED. Requires ≥1 ReadingHourMedia
   * row (mirror Plan 06-04 debate finalize gate).
   */
  async finalizeReadingHour(
    institutionId: string,
    readingHourId: string,
    user?: InstitutionScopedUser,
  ): Promise<{ id: string; status: "PUBLISHED" }> {
    await this._assertScope(institutionId, user);
    const event = await this.prisma.readingHour.findUnique({
      where: { id: readingHourId },
      select: { id: true, institutionId: true, status: true },
    } as any);
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new NotFoundException("Tadbir topilmadi");
    }
    if ((event as any).status === "PUBLISHED") {
      throw new BadRequestException("Tadbir allaqachon tasdiqlangan");
    }

    const mediaCount = await this.prisma.readingHourMedia.count({
      where: { readingHourId },
    });
    if (mediaCount < 1) {
      throw new BadRequestException(
        "Hech bo'lmaganda 1 ta foto yoki video yuklang",
      );
    }

    await this.prisma.$transaction([
      this.prisma.readingHour.update({
        where: { id: readingHourId },
        data: { status: "PUBLISHED" } as any,
      }),
      this.prisma.aiAuditLog.create({
        data: {
          scope: "READING_HOUR",
          scopeId: readingHourId,
          issueType: "READING_HOUR_PUBLISHED",
          severity: "LOW",
          analysis: `Reading Hour finalised with ${mediaCount} media`,
          recommendation: "",
        },
      }),
    ]);

    return { id: readingHourId, status: "PUBLISHED" };
  }

  async deleteReadingHour(
    institutionId: string,
    readingHourId: string,
    user?: InstitutionScopedUser,
  ): Promise<{ deleted: true }> {
    await this._assertScope(institutionId, user);
    const event = await this.prisma.readingHour.findUnique({
      where: { id: readingHourId },
      select: { id: true, institutionId: true, status: true },
    } as any);
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new NotFoundException("Tadbir topilmadi");
    }
    if (
      (event as any).status !== "DRAFT" &&
      user?.role !== UserRole.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        "Tasdiqlangan tadbirni faqat SUPER_ADMIN o'chira oladi",
      );
    }
    await this.prisma.readingHour.delete({ where: { id: readingHourId } });
    return { deleted: true };
  }

  // ── QR token (rotating HMAC) ─────────────────────────────────────────────

  /**
   * Generate a token signed over (readingHourId | windowStart). Rotates every
   * 5 minutes — caller must refresh just before expiresAt.
   *
   * Token format: `${base64url(payload)}.${hmacHex}` where payload encodes
   * { readingHourId, windowBucket } so verify can re-check the URL parameter
   * against the embedded id (defence-in-depth against URL substitution).
   */
  async generateQrToken(
    institutionId: string,
    readingHourId: string,
    user?: InstitutionScopedUser,
  ): Promise<QrTokenResult> {
    await this._assertScope(institutionId, user);
    const event = await this.r.readingHour.findUnique({
      where: { id: readingHourId },
      select: { id: true, institutionId: true, status: true },
    } as any);
    if (!event) throw new NotFoundException("Tadbir topilmadi");
    if (event.institutionId !== institutionId) {
      throw new NotFoundException("Tadbir topilmadi");
    }
    if ((event as any).status === "CANCELLED") {
      throw new BadRequestException("Bekor qilingan tadbir uchun QR yo'q");
    }

    const windowStart = this.getCurrentWindow();
    const payload = JSON.stringify({
      readingHourId,
      windowBucket: windowStart,
    });
    const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
    const hmac = this.signWindow(readingHourId, windowStart);
    return {
      token: `${payloadB64}.${hmac}`,
      expiresAt: new Date(windowStart + QR_WINDOW_MS),
      windowStart,
    };
  }

  /**
   * Verify HMAC against current AND previous window (clock-drift grace).
   * Constant-time compare via crypto.timingSafeEqual.
   *
   * Returns the parsed payload on success. Throws GoneException (410) on stale
   * or malformed tokens — never reveal which.
   */
  private verifyQrToken(
    readingHourId: string,
    token: string,
  ): { readingHourId: string; windowBucket: number } {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      throw new GoneException("QR muddati o'tdi");
    }
    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new GoneException("QR muddati o'tdi");
    }
    const [payloadB64, providedHmac] = parts;

    let payload: { readingHourId: string; windowBucket: number };
    try {
      const json = Buffer.from(payloadB64, "base64url").toString("utf8");
      payload = JSON.parse(json);
    } catch {
      throw new GoneException("QR muddati o'tdi");
    }

    // Defence-in-depth: payload id must match URL-bound id.
    if (payload.readingHourId !== readingHourId) {
      throw new GoneException("QR muddati o'tdi");
    }

    const now = Date.now();
    const currentWindow = this.getCurrentWindow(now);
    const previousWindow = currentWindow - QR_WINDOW_MS;

    // The payload's window must be either current or previous (clock-drift).
    if (
      payload.windowBucket !== currentWindow &&
      payload.windowBucket !== previousWindow
    ) {
      throw new GoneException("QR muddati o'tdi");
    }

    const expectedHmac = this.signWindow(readingHourId, payload.windowBucket);
    let providedBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      providedBuf = Buffer.from(providedHmac, "hex");
      expectedBuf = Buffer.from(expectedHmac, "hex");
    } catch {
      throw new GoneException("QR muddati o'tdi");
    }
    if (providedBuf.length !== expectedBuf.length) {
      throw new GoneException("QR muddati o'tdi");
    }
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      throw new GoneException("QR muddati o'tdi");
    }

    return payload;
  }

  /**
   * Record attendance from a public scan-page POST.
   *
   * Throws:
   *   - GoneException (410) — invalid/stale token
   *   - BadRequestException (400) — event DRAFT/CANCELLED or outside time window
   *   - ConflictException (409) — duplicate attendance (P2002)
   *   - ForbiddenException (403) — user belongs to different organization
   */
  async markAttendanceByToken(
    readingHourId: string,
    token: string,
    user: { id: string; organizationId?: string | null; role?: string },
  ): Promise<{ markedAt: Date; attendeeId: string }> {
    this.verifyQrToken(readingHourId, token);

    const event = await this.prisma.readingHour.findUnique({
      where: { id: readingHourId },
      select: {
        id: true,
        institutionId: true,
        status: true,
        heldAt: true,
        title: true,
      },
    } as any);
    if (!event) throw new NotFoundException("Tadbir topilmadi");

    if ((event as any).status === "DRAFT") {
      throw new BadRequestException(
        "Tadbir hali tasdiqlanmagan — qatnashish mumkin emas",
      );
    }
    if ((event as any).status === "CANCELLED") {
      throw new BadRequestException("Tadbir bekor qilingan");
    }

    // Cross-org scan defence (T-06-R2): unless SUPER_ADMIN, user must belong
    // to the institution.
    if (
      user.role !== "SUPER_ADMIN" &&
      user.organizationId &&
      user.organizationId !== event.institutionId
    ) {
      throw new ForbiddenException("Sizning idoraga tegishli emas");
    }

    // Backdated/replay defence (T-06-R4): ±2h around scheduledAt.
    const drift = Math.abs(event.heldAt.getTime() - Date.now());
    if (drift > ATTEND_TOLERANCE_MS) {
      throw new BadRequestException(
        "Tadbir vaqtidan tashqarida — qatnashish mumkin emas",
      );
    }

    const markedAt = new Date();
    try {
      const row = await this.prisma.readingHourAttendee.create({
        data: { readingHourId, userId: user.id, markedAt },
      });
      await this.prisma.aiAuditLog.create({
        data: {
          scope: "READING_HOUR",
          scopeId: readingHourId,
          issueType: "READING_HOUR_ATTEND",
          severity: "LOW",
          analysis: `Attendance marked for user ${user.id}`,
          recommendation: "",
        },
      });
      return { markedAt, attendeeId: row.id };
    } catch (err: any) {
      if (err?.code === "P2002") {
        throw new ConflictException("Allaqachon belgilangan");
      }
      this.logger.error(
        `Attendance create failed (event=${readingHourId}, user=${user.id}): ${err?.message}`,
      );
      throw err;
    }
  }

  // ── Monthly summary (consumed by Plan 06-05 PQ-9 PDF) ────────────────────

  /**
   * Returns last-12-months counts plus this-month + total + lastEventAt.
   * PUBLISHED only — DRAFT/CANCELLED excluded.
   */
  async getReadingHoursSummary(
    institutionId: string,
    user?: InstitutionScopedUser,
  ): Promise<{
    thisMonth: number;
    total: number;
    lastEventAt: Date | null;
    byMonth: Array<{ ym: string; count: number }>;
  }> {
    await this._assertScope(institutionId, user);

    return this.cache.remember(
      `idora:reading-hour:summary:${institutionId}`,
      300,
      async () => {
        // Last 12 months window (inclusive).
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const events = await this.r.readingHour.findMany({
          where: {
            institutionId,
            status: "PUBLISHED",
            heldAt: { gte: start },
          } as any,
          select: { heldAt: true },
        });
        const counts = new Map<string, number>();
        for (const ev of events) {
          const d = ev.heldAt;
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          counts.set(ym, (counts.get(ym) ?? 0) + 1);
        }
        const byMonth: Array<{ ym: string; count: number }> = [];
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          byMonth.push({ ym, count: counts.get(ym) ?? 0 });
        }
        const thisMonthYm = byMonth[byMonth.length - 1].ym;
        const thisMonth = counts.get(thisMonthYm) ?? 0;

        const [total, last] = await Promise.all([
          this.r.readingHour.count({
            where: { institutionId, status: "PUBLISHED" } as any,
          }),
          this.r.readingHour.findFirst({
            where: { institutionId, status: "PUBLISHED" } as any,
            orderBy: { heldAt: "desc" },
            select: { heldAt: true },
          }),
        ]);

        return {
          thisMonth,
          total,
          lastEventAt: last?.heldAt ?? null,
          byMonth,
        };
      },
    );
  }
}
