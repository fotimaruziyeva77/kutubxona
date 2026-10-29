import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { NOTIFICATION_QUEUE } from "../../infra/queue/queue-names";
import { UserStatus } from "@prisma/client";
import * as QRCode from "qrcode";
import { CompleteProfileDto, UpdateProfileDto } from "./dto/profile.dto";
import { USER_PUBLIC_SELECT_WITH_ADDRESS } from "../../common/utils/user-select.const";

// ── Plan 05-04-fix FIX A Layer 2 — per-user device-token cap. ─────────────
// 25 covers heavy multi-device users (web on 2 browsers × work/home + iOS +
// Android + tablet + reinstalls) with comfortable headroom; beyond that we
// LRU-evict (delete oldest by lastSeen) so a single account cannot bloat
// the device_tokens table and amplify push fan-out cost.
const MAX_DEVICE_TOKENS_PER_USER = 25;

// ── DTOs ──────────────────────────────────────────────────────────────────
// AUDIT-REPORT M2 — avval bu yerda TS interface'lar edi (ValidationPipe
// uchun NO-OP). Endi class-validator dekoratorli class'lar dto/profile.dto.ts
// da yashaydi; nomlar import qiluvchilar buzilmasligi uchun re-export
// qilinadi. userId class'da YO'Q — service imzosi intersection orqali oladi.
export { CompleteProfileDto, UpdateProfileDto } from "./dto/profile.dto";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional NOTIFICATION_QUEUE for FIX B — used to notify the prior owner
    // when an FCM token transfers across users (fire-and-forget). Marked
    // @Optional so existing unit tests that construct the service with only
    // a Prisma stub continue to work — when undefined, the notify path is
    // skipped (logged at debug level).
    @Optional()
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notifQueue?: Queue,
  ) {}

  // ── Plan 05-04 Task 3 — FCM token CRUD (NOTIF-02) ─────────────────────────

  /**
   * Upsert by unique `token`. Three cases:
   *
   *   - new token        → create row owned by current user (201-equivalent).
   *   - same user        → update platform + lastSeen (200-equivalent).
   *   - DIFFERENT user   → cross-user transfer. Common legit reason: a user
   *                        signs out and a friend signs in on the same shared
   *                        device, so Firebase hands the same token to a
   *                        different account. We MOVE the row to the new owner
   *                        AND write a DEVICE_TOKEN_TRANSFER row to AiAuditLog
   *                        capturing both userIds for forensic traceability
   *                        (T-05-FCM-TRANSFER per RESEARCH §STRIDE).
   *
   * Never returns the raw token plaintext outside the trusted boundary; the
   * caller exposes only id/platform/lastSeen.
   */
  async upsertFcmToken(params: {
    userId: string;
    token: string;
    platform: "web" | "android" | "ios";
  }) {
    const { userId, token, platform } = params;
    const existing = await this.prisma.deviceToken.findUnique({
      where: { token },
      select: { id: true, userId: true },
    });

    if (existing && existing.userId !== userId) {
      // ── 05-04-fix FIX B — atomic cross-user transfer ────────────────────
      // Previous impl wrote the audit row OUTSIDE the move with .catch
      // swallowing audit failures — so a soft audit failure produced a
      // silent transfer (forensic blind spot). Now audit + update run in
      // a single prisma.$transaction; if either fails, BOTH roll back.
      const priorOwnerId = existing.userId;
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.aiAuditLog.create({
          data: {
            scope: "USER",
            scopeId: userId,
            issueType: "DEVICE_TOKEN_TRANSFER",
            severity: "LOW",
            analysis: `FCM token reassigned from user ***${priorOwnerId.slice(-8)} to ***${userId.slice(-8)}`,
            recommendation: "Verify if the device is shared or compromised.",
          },
        });
        return tx.deviceToken.update({
          where: { token },
          data: { userId, platform, lastSeen: new Date() },
          select: { id: true, platform: true, lastSeen: true, createdAt: true },
        });
      });

      this.logger.log(
        `[fcm] token transferred from ***${priorOwnerId.slice(-8)} to ***${userId.slice(-8)}`,
      );

      // 05-04-fix FIX B — fire-and-forget notify to prior owner. SMS + email
      // + push (whichever channels available). Failures are debug-logged so
      // a notification outage cannot block the actual move.
      this.notifyPriorOwnerOfTransfer(priorOwnerId).catch((err: Error) =>
        this.logger.debug(`[fcm transfer notify failed] ${err.message}`),
      );

      return result;
    }

    if (existing) {
      return this.prisma.deviceToken.update({
        where: { token },
        data: { platform, lastSeen: new Date() },
        select: { id: true, platform: true, lastSeen: true, createdAt: true },
      });
    }

    // ── 05-04-fix FIX A Layer 2 — per-user cap on device tokens ───────────
    // Before insert, count this user's existing tokens. At cap, LRU-evict
    // the oldest-by-lastSeen row and write an AiAuditLog (Layer 3) so ops
    // can surface abusive registration loops.
    const tokenCount = await this.prisma.deviceToken.count({ where: { userId } });
    if (tokenCount >= MAX_DEVICE_TOKENS_PER_USER) {
      const oldest = await this.prisma.deviceToken.findFirst({
        where: { userId },
        orderBy: { lastSeen: "asc" },
        select: { id: true },
      });
      if (oldest) {
        await this.prisma.deviceToken.delete({ where: { id: oldest.id } });
      }
      // Layer 3 — audit row whenever cap is hit. Not fatal if audit fails.
      await this.prisma.aiAuditLog
        .create({
          data: {
            scope: "USER",
            scopeId: userId,
            issueType: "DEVICE_TOKEN_CAP_REACHED",
            severity: "LOW",
            analysis: `User ***${userId.slice(-8)} hit device-token cap (${MAX_DEVICE_TOKENS_PER_USER}); LRU-evicted oldest row.`,
            recommendation:
              "Investigate if the account is being used to amplify push fan-out or rotate tokens abusively.",
          },
        })
        .catch((err: Error) =>
          this.logger.warn(`[fcm cap audit failed] ${err.message}`),
        );
      this.logger.warn(
        `[fcm] device-token cap reached for user=***${userId.slice(-8)} (tokenCount=${tokenCount})`,
      );
    }

    return this.prisma.deviceToken.create({
      data: { userId, token, platform },
      select: { id: true, platform: true, lastSeen: true, createdAt: true },
    });
  }

  /**
   * 05-04-fix FIX B helper — enqueue notifications to the prior token owner
   * after a cross-user FCM transfer. Channels: SMS (if phone), email (if
   * email set), push (best-effort to remaining tokens). Fire-and-forget;
   * exceptions are caught by the caller's `.catch`. Each enqueue is isolated
   * so a single channel failure cannot abort the rest.
   */
  private async notifyPriorOwnerOfTransfer(priorOwnerId: string): Promise<void> {
    if (!this.notifQueue) return; // queue not wired in this context (e.g. unit test)
    const prior = await this.prisma.user.findUnique({
      where: { id: priorOwnerId },
      select: { phone: true },
    });
    if (!prior) return;

    const message =
      "Sizning qurilmangiz boshqa hisobga ko'chirildi. Agar bu siz bo'lmasangiz, parolingizni yangilang.";
    const subject = "[SIFAT LIBRARY] Qurilma ko'chirildi";

    // SMS — only if phone is set (always set per schema, but defensive).
    if (prior.phone) {
      await this.notifQueue
        .add("device-token-transfer-sms", {
          type: "sms",
          phone: prior.phone,
          userId: priorOwnerId,
          message,
        })
        .catch((err: Error) =>
          this.logger.debug(`[fcm transfer sms enqueue failed] ${err.message}`),
        );
    }

    // Email — admin recipients are configured separately; the User model
    // has no email column today, so we enqueue with userId only and let the
    // processor's no-recipient warn path handle it (no-op in MVP). The
    // enqueue is kept so the integration surface is in place for when an
    // email column is added (Phase 6+).
    await this.notifQueue
      .add("device-token-transfer-email", {
        type: "email",
        userId: priorOwnerId,
        subject,
        message,
      })
      .catch((err: Error) =>
        this.logger.debug(`[fcm transfer email enqueue failed] ${err.message}`),
      );

    // Push to whatever tokens remain on the prior owner (best-effort —
    // the very token that just moved is already reassigned, so this targets
    // the prior owner's OTHER devices via the userId fan-out path).
    await this.notifQueue
      .add("device-token-transfer-push", {
        type: "push",
        userId: priorOwnerId,
        title: subject,
        message,
      })
      .catch((err: Error) =>
        this.logger.debug(`[fcm transfer push enqueue failed] ${err.message}`),
      );
  }

  /**
   * Delete an FCM token by id. 404 if not found OR if owned by a different
   * user (defense-in-depth — 403 leaks existence; 404 hides it per
   * T-05-FCM-DELETE / ASVS V4).
   */
  async deleteFcmToken(userId: string, tokenId: string): Promise<void> {
    const row = await this.prisma.deviceToken.findUnique({
      where: { id: tokenId },
      select: { id: true, userId: true },
    });
    if (!row || row.userId !== userId) {
      throw new NotFoundException("Token topilmadi");
    }
    await this.prisma.deviceToken.delete({ where: { id: tokenId } });
  }

  /**
   * List the caller's tokens (no raw token plaintext — id + platform + lastSeen
   * only). Useful for "manage your devices" UI in Phase 6/7.
   */
  async listMyFcmTokens(userId: string) {
    return this.prisma.deviceToken.findMany({
      where: { userId },
      orderBy: { lastSeen: "desc" },
      select: { id: true, platform: true, lastSeen: true, createdAt: true },
    });
  }

  // ── Profil to'ldirish (qadam 2-4) ────────────────────────────────────
  // M2 — userId DTO da emas (body orqali soxtalab bo'lmaydi); controller
  // JWT sub ni intersection orqali qo'shib uzatadi.
  async completeProfile(dto: CompleteProfileDto & { userId: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (user.sifatId) throw new ConflictException("Profil allaqachon to'ldirilgan");

    const dob = new Date(dto.dob);
    if (isNaN(dob.getTime())) throw new BadRequestException("Tug'ilgan sana noto'g'ri");

    const mahalla = await this.prisma.mahalla.findUnique({
      where: { id: dto.mahallaId },
      include: { tuman: { include: { viloyat: true } } }
    });
    if (!mahalla) throw new NotFoundException("Mahalla topilmadi");

    // Unique sifatId generatsiya (atomic)
    const sifatId = await this.generateSifatId(mahalla);

    const address = await this.prisma.address.create({
      data: {
        viloyatId: dto.viloyatId,
        tumanId: dto.tumanId,
        mahallaId: dto.mahallaId,
        street: dto.street,
        house: dto.house,
        apartment: dto.apartment
      }
    });

    const isInstantActive = dto.type === "CITIZEN";

    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: {
        name: dto.name,
        dob,
        gender: dto.gender,
        type: dto.type,
        sifatId,
        addressId: address.id,
        status: isInstantActive ? UserStatus.ACTIVE : UserStatus.PENDING,
        schoolId: dto.schoolId,
        schoolClass: dto.schoolClass,
        universityId: dto.universityId,
        faculty: dto.faculty,
        direction: dto.direction,
        studyCourse: dto.studyCourse,
        organizationId: dto.organizationId,
        department: dto.department,
        position: dto.position
      },
      include: { address: true }
    });

    const qrDataUrl = await this.generateQr(sifatId);

    return {
      user: updated,
      sifatId,
      qrCode: qrDataUrl,
      status: updated.status,
      message: isInstantActive
        ? "Profil to'ldirildi. Siz faol kitobxon sifatida ro'yhatdan o'tdingiz!"
        : "Profil yuborildi. Tashkilotingiz tasdiqlashini kuting (14 kun)."
    };
  }

  // ── Profil ko'rish (GET /users/me) ────────────────────────────────────
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        address: true,
        readingIndex: {
          orderBy: { calculatedAt: "desc" },
          take: 1
        },
        transactions: {
          where: { status: { in: ["BORROWED", "RETURNED", "COMPLETED"] } },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { book: { select: { title: true, author: true } } }
        }
      }
    });

    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const qrCode = user.sifatId ? await this.generateQr(user.sifatId) : null;
    const readingScore = user.readingIndex[0]?.score ?? 0;

    // Muassasa admini boshqaradigan muassasa TURI (MAKTAB/OTM/IDORA/MAHALLA) —
    // frontend sidebar'ni shu bo'yicha filtrlaydi (maktab admini faqat Maktab
    // panelini ko'radi, Idora/OTM panellarini emas).
    //
    // Manba: muassasa institution ID'si umumiy FK orqali biriktirilgan
    // (seed organizationId ishlatadi — tur MAKTAB bo'lsa ham). directorId
    // har doim to'ldirilmagan, shuning uchun avval FK orqali, keyin fallback.
    let institutionType: string | null = null;
    if (user.role === "MUASSASA_ADMIN") {
      const instId =
        user.organizationId ?? user.schoolId ?? user.universityId ?? null;
      if (instId) {
        const inst = await this.prisma.institution.findUnique({
          where: { id: instId },
          select: { type: true }
        });
        institutionType = inst?.type ?? null;
      }
      if (!institutionType) {
        const inst = await this.prisma.institution.findFirst({
          where: { directorId: userId },
          select: { type: true }
        });
        institutionType = inst?.type ?? null;
      }
    }

    // PERF-06 — filter reading data from public response when hidden
    const result = { ...user, qrCode, readingScore, institutionType } as Record<string, unknown>;
    if (user.hideReadingHistory) {
      delete result.transactions;
      delete result.readingIndex;
    }

    // XAVFSIZLIK: `{...user}` butun Prisma qatorini yoyadi — bu bcrypt
    // `passwordHash` va `pinfl` ni ham javobga qo'shib yuborardi. Frontend
    // /users/me natijasini localStorage'ga ("sifat-auth") saqlaydi, ya'ni
    // foydalanuvchi parolining hash'i va davlat shaxs raqami brauzer
    // xotirasida yotardi: XSS, zararli kengaytma yoki umumiy kompyuterda
    // hash offline bruteforce uchun o'g'irlanishi mumkin edi.
    //
    // Bu maydonlarning IKKALASI ham frontendda hech qayerda ishlatilmaydi
    // (butun frontend bo'ylab tekshirilgan) — shuning uchun ularni olib
    // tashlash hech narsani buzmaydi. Admin endpointlarida bu allaqachon
    // tuzatilgan edi; /users/me e'tibordan chetda qolgan.
    delete result.passwordHash;
    delete result.pinfl;

    return result;
  }

  // ── Profil tahrirlash ─────────────────────────────────────────────────
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { address: true }
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const updates: Record<string, unknown> = {};
    if (dto.name) updates.name = dto.name;

    if ((dto.street || dto.house || dto.apartment) && user.address) {
      await this.prisma.address.update({
        where: { id: user.address.id },
        data: {
          street: dto.street ?? user.address.street,
          house: dto.house ?? user.address.house,
          apartment: dto.apartment ?? user.address.apartment
        }
      });
    }

    if (Object.keys(updates).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data: updates });
    }

    return this.getProfile(userId);
  }

  // ── QR ma'lumotlarini yangilash ───────────────────────────────────────
  async getQrCode(userId: string): Promise<{ sifatId: string; qrCode: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.sifatId) throw new NotFoundException("SifatID hali belgilanmagan");

    const qrCode = await this.generateQr(user.sifatId);
    return { sifatId: user.sifatId, qrCode };
  }

  // ── Admin: barcha foydalanuvchilar ────────────────────────────────────
  // `include: { address: true }` User ning barcha skalyar maydonlarini
  // (passwordHash, pinfl) javobga chiqarardi — aniq oq ro'yxat ishlatiladi.
  findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: USER_PUBLIC_SELECT_WITH_ADDRESS
    });
  }

  // ── SifatID generatsiya (mahalla sequence atomic) ─────────────────────
  private async generateSifatId(
    mahalla: { code: string; lastSeq: number; id: string }
  ): Promise<string> {
    const updated = await this.prisma.mahalla.update({
      where: { id: mahalla.id },
      data: { lastSeq: { increment: 1 } }
    });
    const seq = updated.lastSeq.toString().padStart(5, "0");
    return `SL-UZ-${mahalla.code}-${seq}`;
  }

  // ── QR kod generatsiya (Data URL) ──────────────────────────────────────
  private generateQr(sifatId: string): Promise<string> {
    const payload = JSON.stringify({ id: sifatId, ts: Date.now() });
    return QRCode.toDataURL(payload, {
      width: 300,
      margin: 2,
      color: { dark: "#1e40af", light: "#ffffff" }
    });
  }
}
