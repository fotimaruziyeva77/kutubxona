import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger, Optional
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { PrismaReplicaService } from "../../infra/prisma/prisma-replica.service";
import { SmsService } from "../../infra/sms/sms.service";
import { CacheService } from "../../infra/cache/cache.service";
import { maskNameIfMinor } from "../../common/utils/privacy-mask.util";
import { escapeHtml } from "../../common/utils/escape-html.util";

// Himoya qoidalari
const JOIN_WAIT_DAYS = 30;       // Oilaga qo'shilgandan 30 kun o'tmasdan reyting hisoblanmaydi
const INVITE_EXPIRE_HOURS = 48;  // Taklif 48 soatdan keyin muddati o'tadi
const SUGGESTION_LIMIT = 10;     // FAM-01 — at most 10 same-household candidates

// IDOR-H14 — admin tiers that may view ANY family's member detail (regional
// monitoring per CLAUDE.md §VI hierarchy). Everyone else must be a member of
// the requested family.
const FAMILY_VIEW_ADMIN_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
];

export interface FamilyViewer {
  id: string;
  role: UserRole | string;
}

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);
  /**
   * Plan 06-01 FAM-03 — heavy reads (single-family RI compute, family
   * detection lookups) route through PrismaReplicaService when wired.
   * Falls back to primary when @Optional dependency is unwired (older
   * test mocks). Writes always hit primary via this.prisma.
   */
  private readonly replica: PrismaReplicaService | PrismaService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly cache: CacheService,
    @Optional() replica?: PrismaReplicaService,
  ) {
    this.replica = (replica as unknown as PrismaService) ?? prisma;
  }

  // ── Oila yaratish ─────────────────────────────────────────────────────────

  async createFamily(creatorId: string, name?: string) {
    const creator = await this.prisma.user.findUnique({
      where: { id: creatorId },
      include: { address: true }
    });
    if (!creator) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (creator.familyId) {
      throw new BadRequestException("Siz allaqachon oila a'zosisiz. Avval oilangizdan chiqing.");
    }
    if (!creator.address) {
      throw new BadRequestException("Oila yaratish uchun avval manzilingizni kiriting");
    }

    const familyName = name ?? `${creator.name} oilasi`;

    const family = await this.prisma.family.create({
      data: {
        name: familyName,
        addressId: creator.addressId,
        viloyatId: creator.address.viloyatId,
        tumanId: creator.address.tumanId,
        mahallaId: creator.address.mahallaId,
        members: { connect: { id: creatorId } }
      }
    });

    this.logger.log(`Oila yaratildi: ${family.id} — ${family.name}`);
    return family;
  }

  // ── Oilani ko'rish ────────────────────────────────────────────────────────
  //
  // IDOR-H14 — previously ANY authenticated user could pull ANY family's full
  // member list with UNMASKED names. Now:
  //   - only members of the family OR admin-tier roles (FAMILY_VIEW_ADMIN_ROLES)
  //     may read it — everyone else gets 403;
  //   - under-14 member names are masked via maskNameIfMinor, exactly as
  //     getPublicFamilyProfile does (CLAUDE.md §V.4 + TOP-06);
  //   - raw dob is fetched only for the masking computation and never returned.

  async getFamily(id: string, viewer: FamilyViewer) {
    const family = await this.prisma.family.findUnique({
      where: { id },
      include: {
        members: {
          select: {
            id: true,
            name: true,
            dob: true,
            sifatId: true,
            type: true,
            status: true,
            createdAt: true,
            readingIndex: {
              orderBy: { calculatedAt: "desc" },
              take: 1,
              select: { score: true, calculatedAt: true }
            }
          }
        }
      }
    });
    if (!family) throw new NotFoundException("Oila topilmadi");

    const isMember = family.members.some((m) => m.id === viewer.id);
    const isAdminTier = FAMILY_VIEW_ADMIN_ROLES.includes(viewer.role as UserRole);
    if (!isMember && !isAdminTier) {
      throw new ForbiddenException("Siz bu oila a'zosi emassiz");
    }

    const members = family.members.map(({ dob, ...m }) => ({
      ...m,
      name: maskNameIfMinor(m.name, dob),
      latestRi: m.readingIndex[0] ?? null
    }));

    const avgRi = members.length > 0
      ? members.reduce((s, m) => s + (m.latestRi?.score ?? 0), 0) / members.length
      : 0;

    return { ...family, members, avgRi: Math.round(avgRi * 10) / 10 };
  }

  // ── Tizim tomonidan bir xonadon taklifi ───────────────────────────────────
  // Ro'yhat paytida bir xil manzil + xonadon raqamdan foydalanuvchilar topilsa taklif

  /**
   * Plan 06-03 FAM-01 — opt-IN gate. Auto-detection is gated by the user's
   * own User.familyDetectionEnabled BOOLEAN (D-Q3, default FALSE). The
   * candidate WHERE clause adds the same gate on the matched users so the
   * detection is mutual — both sides must have explicitly opted in.
   *
   * Manual invite (inviteMember) bypasses this gate entirely; only the
   * auto-detection surface is privacy-restricted (T-06-04 surveillance risk).
   */
  async detectAndSuggestFamily(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { address: true }
    });
    if (!user || !user.address) return null;

    // FAM-01 — opt-IN gate. Return null EARLY if caller has not opted in.
    // Defense-in-depth: even if the controller forgets to gate at the route
    // level, the service refuses to leak same-household neighbours.
    if (!user.familyDetectionEnabled) return null;

    // Bir xil viloyat + tuman + mahalla + ko'cha + uy + xonadon — AND the
    // matched user must also have familyDetectionEnabled = true.
    const sameHouseholdUsers = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        familyId: null,
        status: "ACTIVE",
        familyDetectionEnabled: true,
        address: {
          viloyatId: user.address.viloyatId,
          tumanId: user.address.tumanId,
          mahallaId: user.address.mahallaId,
          street: user.address.street,
          house: user.address.house,
          apartment: user.address.apartment
        }
      },
      select: { id: true, name: true, sifatId: true },
      take: SUGGESTION_LIMIT,
    });

    if (sameHouseholdUsers.length === 0) return null;

    return {
      suggestion: true,
      sameHouseholdUsers,
      message: `${sameHouseholdUsers.length} ta bir xonadon a'zosi topildi. Oila yaratmoqchimisiz?`
    };
  }

  // ── Plan 06-03 FAM-01 — opt-IN toggle ────────────────────────────────────
  //
  // PATCH /family/me/family-detection — body { enabled }.
  // Wrapped in $transaction so the User.familyDetectionEnabled write and the
  // AiAuditLog row land atomically (audit failure rolls back the toggle so a
  // forensic blind spot cannot ship). issueType = "FAMILY_DETECTION_TOGGLED"
  // is the canonical event tag for downstream pipelines.
  async setFamilyDetectionEnabled(userId: string, enabled: boolean) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, familyDetectionEnabled: true },
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    if (user.familyDetectionEnabled === enabled) {
      // No-op when already in the requested state; avoid writing an empty
      // audit row so we don't poison forensic timelines.
      return { familyDetectionEnabled: enabled, changed: false };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { familyDetectionEnabled: enabled },
      });
      await tx.aiAuditLog.create({
        data: {
          scope: "USER",
          scopeId: userId,
          issueType: "FAMILY_DETECTION_TOGGLED",
          severity: "LOW",
          analysis: enabled ? "enabled" : "disabled",
          recommendation: enabled
            ? "User opted into same-household auto-detection."
            : "User opted out of same-household auto-detection.",
        },
      });
    });

    // Invalidate any cached suggestions for this user's address bucket.
    await this.cache.del(`family:suggest:${userId}`);

    return { familyDetectionEnabled: enabled, changed: true };
  }

  // ── Plan 06-03 FAM-05 — Public family profile (Top-50 link target) ───────
  //
  // No-auth route. Aggregated metrics + member list with under-14 names
  // masked via maskNameIfMinor (CLAUDE.md §V.4 + Plan 03-01 TOP-06).
  // Family.name is escaped via escapeHtml (defense-in-depth — admin-vetted
  // at create-time but might contain stray quotes that need defanging).
  async getPublicFamilyProfile(familyId: string) {
    const family = await this.replica.family.findUnique({
      where: { id: familyId },
      include: {
        memberships: {
          where: { leftAt: null },
          select: { userId: true, joinedAt: true },
        },
      },
    });
    if (!family) throw new NotFoundException("Oila topilmadi");

    // Resolve member shape with names + dob + RI through the replica.
    const memberIds = family.memberships.map((m) => m.userId);
    const users = memberIds.length
      ? await this.replica.user.findMany({
          where: { id: { in: memberIds } },
          select: {
            id: true,
            name: true,
            dob: true,
            readingIndex: {
              orderBy: { calculatedAt: "desc" },
              take: 1,
              select: { score: true },
            },
          },
        })
      : [];

    const members = users.map((u) => {
      const ageMs = u.dob ? Date.now() - u.dob.getTime() : 0;
      const ageYears = u.dob ? Math.floor(ageMs / (365.25 * 86_400_000)) : null;
      return {
        id: u.id,
        name: maskNameIfMinor(u.name, u.dob),
        isMinor: ageYears !== null && ageYears <= 14,
        avgRi: u.readingIndex[0]?.score ?? 0,
      };
    });

    const avgRi = members.length
      ? members.reduce((s, m) => s + m.avgRi, 0) / members.length
      : 0;

    return {
      family: {
        id: family.id,
        // Plan 06-03 T-06-F6 — escape DB string before it crosses the API
        // boundary. The frontend re-escapes too, but defense-in-depth.
        name: escapeHtml(family.name ?? ""),
        avgRi: Math.round(avgRi * 10) / 10,
        memberCount: members.length,
        viloyatId: family.viloyatId,
        tumanId: family.tumanId,
      },
      members,
    };
  }

  // ── Taklif yuborish ───────────────────────────────────────────────────────

  async inviteMember(familyId: string, inviterId: string, inviteeId: string) {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: { members: { select: { id: true } } }
    });
    if (!family) throw new NotFoundException("Oila topilmadi");

    // Taklif yuboruvchi oila a'zosimi?
    const isInFamily = family.members.some((m) => m.id === inviterId);
    if (!isInFamily) throw new ForbiddenException("Siz bu oila a'zosi emassiz");

    const invitee = await this.prisma.user.findUnique({
      where: { id: inviteeId },
      select: { id: true, name: true, phone: true, familyId: true }
    });
    if (!invitee) throw new NotFoundException("Taklif qilinuvchi topilmadi");
    if (invitee.familyId) {
      throw new BadRequestException("Bu foydalanuvchi allaqachon boshqa oila a'zosi");
    }

    // Aktiv taklif bormi?
    const existing = await this.prisma.familyInvite.findFirst({
      where: {
        familyId,
        inviteeId,
        status: "PENDING",
        expiresAt: { gte: new Date() }
      }
    });
    if (existing) throw new BadRequestException("Allaqachon aktiv taklif mavjud");

    const expiresAt = new Date(Date.now() + INVITE_EXPIRE_HOURS * 3_600_000);

    const invite = await this.prisma.familyInvite.create({
      data: { familyId, inviterId, inviteeId, expiresAt }
    });

    // Taklif SMS
    const inviter = await this.prisma.user.findUnique({
      where: { id: inviterId },
      select: { name: true }
    });
    if (invitee.phone) {
      const msg = `SIFAT LIBRARY: ${inviter?.name ?? "Oila a'zosi"} sizni "${family.name}" oilasiga qo'shilishga taklif qildi. Tasdiqlash uchun ilovaga kiring. Muddati: 48 soat.`;
      await this.sms.sendNotification(invitee.phone, msg, invite.id);
    }

    return invite;
  }

  // ── Taklifga javob berish ─────────────────────────────────────────────────

  async respondToInvite(inviteId: string, userId: string, accept: boolean) {
    const invite = await this.prisma.familyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new NotFoundException("Taklif topilmadi");
    if (invite.inviteeId !== userId) throw new ForbiddenException("Bu taklif sizga emas");
    if (invite.status !== "PENDING") throw new BadRequestException("Taklif allaqachon javob berilgan");
    if (invite.expiresAt < new Date()) {
      await this.prisma.familyInvite.update({ where: { id: inviteId }, data: { status: "EXPIRED" } });
      throw new BadRequestException("Taklif muddati o'tgan");
    }

    if (!accept) {
      await this.prisma.familyInvite.update({ where: { id: inviteId }, data: { status: "REJECTED" } });
      return { accepted: false };
    }

    // Oila limitini tekshirish (maks 10 a'zo)
    const family = await this.prisma.family.findUnique({
      where: { id: invite.familyId },
      include: { _count: { select: { members: true } } }
    });
    if (!family) throw new NotFoundException("Oila topilmadi");
    if (family._count.members >= 10) {
      throw new BadRequestException("Oilada maksimal a'zolar soni (10) to'lgan");
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    if (user.familyId) throw new BadRequestException("Siz allaqachon boshqa oila a'zosisiz");

    // Plan 06-01 FAM-06 — interactive $transaction with re-check.
    // The outer findUnique above is a fast-path UX check; the inner re-check
    // inside the tx is the AUTHORITY. Concurrent accepts cannot end up in two
    // families because the second tx sees the first tx's write of familyId.
    // The new FamilyMembership row lands in the same transaction so the
    // 30-day waiting period (FAM-03) tracks the actual join moment.
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.user.findUnique({
        where: { id: userId },
        select: { familyId: true },
      });
      if (fresh?.familyId) {
        throw new BadRequestException(
          "Siz allaqachon boshqa oila a'zosisiz",
        );
      }
      await tx.familyInvite.update({
        where: { id: inviteId },
        data: { status: "ACCEPTED" },
      });
      await tx.user.update({
        where: { id: userId },
        data: { familyId: invite.familyId },
      });
      await tx.familyMembership.create({
        data: {
          userId,
          familyId: invite.familyId,
          joinedAt: new Date(),
        },
      });
    });

    await this.cache.del(`family:rating:${invite.familyId}`);
    return { accepted: true, familyId: invite.familyId };
  }

  // ── Oiladan chiqish ───────────────────────────────────────────────────────

  async leaveFamily(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { familyId: true }
    });
    if (!user?.familyId) throw new BadRequestException("Siz hech qanday oila a'zosi emassiz");

    const familyId = user.familyId;

    // Plan 06-01-fix audit-HIGH — stamp leftAt on the active FamilyMembership
    // row BEFORE clearing User.familyId. Without this, computeFamilyRatings
    // (which filters on memberships.where.leftAt IS NULL) would keep
    // including the departed user's RI in the family average indefinitely.
    // Also necessary for the partial-unique-index rejoin path:
    // the next respondToInvite tx.familyMembership.create needs the prior
    // active row marked inactive or the WHERE leftAt IS NULL UNIQUE
    // constraint will P2002. updateMany is intentional — if there's no
    // active row (legacy data) it's a silent no-op rather than throwing.
    await this.prisma.familyMembership.updateMany({
      where: { userId, familyId, leftAt: null },
      data: { leftAt: new Date() },
    });

    await this.prisma.user.update({ where: { id: userId }, data: { familyId: null } });

    // Oilada birorta a'zo qolmasa — oilani o'chirish
    const remainingCount = await this.prisma.user.count({ where: { familyId } });
    if (remainingCount === 0) {
      await this.prisma.family.delete({ where: { id: familyId } });
    }

    await this.cache.del(`family:rating:${familyId}`);
    return { left: true };
  }

  // ── Oila reytingi ─────────────────────────────────────────────────────────

  async getFamilyRatings(filters: {
    viloyatId?: string;
    tumanId?: string;
    mahallaId?: string;
    month?: string;
    limit?: number;
  }) {
    const { month = this._currentMonth(), limit = 50 } = filters;
    const where = {
      month,
      ...(filters.viloyatId && { family: { viloyatId: filters.viloyatId } }),
      ...(filters.tumanId && { family: { tumanId: filters.tumanId } }),
      ...(filters.mahallaId && { family: { mahallaId: filters.mahallaId } })
    };

    const ratings = await this.prisma.familyRating.findMany({
      where,
      orderBy: { avgScore: "desc" },
      take: limit,
    });

    // Plan 06-03 FAM-05 — Public list shape with escaped family names.
    // No individual member names at the list level (those land on the
    // per-family public profile, which masks under-14 names server-side).
    // FamilyRating has no FK relation to Family, so we fetch names in a
    // single batched query and zip them in.
    const familyIds = Array.from(new Set(ratings.map((r) => r.familyId)));
    const families = familyIds.length
      ? await this.prisma.family.findMany({
          where: { id: { in: familyIds } },
          select: { id: true, name: true, viloyatId: true, tumanId: true },
        })
      : [];
    const familyById = new Map(families.map((f) => [f.id, f]));

    return ratings.map((r, i) => {
      const f = familyById.get(r.familyId);
      return {
        ...r,
        rank: r.rank ?? i + 1,
        familyName: escapeHtml(f?.name ?? ""),
      };
    });
  }

  async getFamilyRating(familyId: string, month?: string) {
    const targetMonth = month ?? this._currentMonth();
    return this.cache.remember(`family:rating:${familyId}:${targetMonth}`, 600, async () => {
      return this.prisma.familyRating.findUnique({
        where: { familyId_month: { familyId, month: targetMonth } }
      });
    });
  }

  // ── Oylik oila reytingini hisoblash (scheduled job) ───────────────────────

  async computeFamilyRatings(month?: string) {
    const targetMonth = month ?? this._currentMonth();
    const [year, mon] = targetMonth.split("-").map(Number);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59);

    // Plan 06-01 FAM-03 — filter by FamilyMembership.joinedAt (NOT
    // User.createdAt). User.createdAt was wrong for legacy rows when a
    // 5-year-old user joined yesterday: the old query counted them
    // immediately because their account is old. The correct semantics is
    // "joined 30+ days ago" — which lives on FamilyMembership.joinedAt.
    const waitThreshold = new Date(Date.now() - JOIN_WAIT_DAYS * 86_400_000);
    const families = await this.replica.family.findMany({
      where: {
        memberships: {
          some: { joinedAt: { lte: waitThreshold }, leftAt: null },
        },
      },
      include: {
        memberships: {
          where: { joinedAt: { lte: waitThreshold }, leftAt: null },
          select: { userId: true },
        },
      },
    });

    let computed = 0;
    for (const family of families) {
      if (family.memberships.length === 0) continue;

      try {
        await this._computeSingleFamilyRating(
          family.id,
          family.memberships.map((m) => m.userId),
          targetMonth,
          monthEnd,
        );
        computed++;
      } catch (err) {
        this.logger.warn(`Oila reytingi xato ${family.id}: ${err}`);
      }
    }

    this.logger.log(`Oila reytingi hisoblandi: ${computed}/${families.length}`);
    return { computed, total: families.length };
  }

  private async _computeSingleFamilyRating(
    familyId: string,
    memberIds: string[],
    month: string,
    monthEnd: Date
  ) {
    // Heavy reads on replica per Plan 06-01 FAM-03 prereq.
    //
    // N+1 fix (P2, 2026-06-10): avval har a'zo uchun alohida findFirst
    // ketardi (oilada N a'zo = N so'rov × minglab oila = scheduled job'da
    // so'rov bo'roni). Endi BITTA findMany({ userId: { in } }) — "eng so'nggi
    // RI" tanlash reading.service'dagi latest-per-user semantikasi bilan bir
    // xil: calculatedAt DESC tartibda har user uchun birinchi uchragan yozuv.
    // RI'si yo'q a'zo avvalgidek 0 ball hisoblanadi — natija AYNAN bir xil.
    const riRows = await this.replica.readingIndex.findMany({
      where: { userId: { in: memberIds }, calculatedAt: { lte: monthEnd } },
      orderBy: { calculatedAt: "desc" },
      select: { userId: true, score: true }
    });
    const latestByUser = new Map<string, number>();
    for (const r of riRows) {
      if (!latestByUser.has(r.userId)) latestByUser.set(r.userId, r.score);
    }
    const riScores = memberIds.map((userId) => latestByUser.get(userId) ?? 0);

    const avgScore = riScores.reduce((s, v) => s + v, 0) / riScores.length;

    // Jami o'qilgan kitoblar (oy ichida)
    const [yearStr, monStr] = month.split("-");
    const monthStart = new Date(Number(yearStr), Number(monStr) - 1, 1);

    const totalBooks = await this.replica.bookTransaction.count({
      where: {
        userId: { in: memberIds },
        status: "RETURNED",
        returnedAt: { gte: monthStart, lte: monthEnd }
      }
    });

    // Write path stays on primary.
    await this.prisma.familyRating.upsert({
      where: { familyId_month: { familyId, month } },
      create: {
        familyId, month,
        avgScore: Math.round(avgScore * 10) / 10,
        totalBooks,
        memberCount: memberIds.length
      },
      update: {
        avgScore: Math.round(avgScore * 10) / 10,
        totalBooks,
        memberCount: memberIds.length
      }
    });
  }

  // ── Yordamchi ─────────────────────────────────────────────────────────────

  private _currentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
}
