import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger, Optional
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { SmsService } from "../../infra/sms/sms.service";
import { CacheService } from "../../infra/cache/cache.service";
import { ClubConsentService } from "./consent/club-consent.service";
import {
  assertInstitutionInScope,
  type InstitutionScopedUser,
  type InstitutionType,
} from "../../common/utils/admin-scope.util";

// IDOR-H12 — the authenticated mutation actor. KLUB_RAHBARI must OWN the club
// (Club.leaderId === actor.id); admin tiers are scoped via the shared
// assertInstitutionInScope util (same pattern as DebateMediaService).
export type ClubActor = InstitutionScopedUser & { id: string };

// 20 kitob yillik maqsad, choraklik = 5 ta — hardcoded per CLAUDE.md §VII + D-Q2.
// Plan 06-02 SCH-06 — keep `GOAL = 20` as a top-level constant alias so the
// grep gate (`const GOAL = 20`) lands. The legacy ANNUAL_GOAL alias is kept
// so existing call-sites do not break.
export const GOAL = 20;
const ANNUAL_GOAL = GOAL;
const QUARTER_GOAL = 5;

// Plan 06-02 SCH-09 — Inactive-club threshold lowered from 45d → 30d to align
// with Plan 05-05 ALERT-04 (CLUB_INACTIVE threshold). Admin tooling may still
// pass `inactiveDays=45` for back-compat reports.
export const INACTIVE_THRESHOLD_DAYS = 30;

@Injectable()
export class ClubService {
  private readonly logger = new Logger(ClubService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly cache: CacheService,
    // Plan 06-04 SCH-04 — bcrypt-hashed deep-link parent consent service.
    // Optional so legacy 3-arg construction in older unit tests still compiles.
    @Optional() private readonly consent?: ClubConsentService,
  ) {}

  // ── IDOR-H12 yordamchi: mutatsiya uchun klub + egalik tekshiruvi ──────────
  //
  // Loads the club WITH its institution scope row and asserts the actor may
  // mutate it:
  //   - KLUB_RAHBARI: must be THIS club's leader (Club.leaderId === actor.id);
  //   - admin tiers (SUPER_ADMIN bypass; MUASSASA/TUMAN/VILOYAT scoped):
  //     assertInstitutionInScope — mirrors debate-media.service.ts usage.
  // Fail-CLOSED: a missing institution row leaves scoped admins at 403.

  private async getClubForMutation(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      include: {
        institution: {
          select: { id: true, type: true, tumanId: true, viloyatId: true },
        },
      },
    });
    if (!club) throw new NotFoundException("Klub topilmadi");
    return club;
  }

  private assertClubMutationAllowed(
    actor: ClubActor,
    club: {
      leaderId: string | null;
      institutionId: string;
      institution?: { type: string; tumanId?: string | null; viloyatId?: string | null } | null;
    },
  ): void {
    if ((actor.role as UserRole) === UserRole.KLUB_RAHBARI) {
      if (!club.leaderId || club.leaderId !== actor.id) {
        throw new ForbiddenException(
          "Siz bu klubning rahbari emassiz — faqat o'z klubingizni boshqara olasiz",
        );
      }
      return;
    }
    assertInstitutionInScope(actor, club.institutionId, {
      type: (club.institution?.type ?? "SCHOOL") as InstitutionType,
      tumanId: club.institution?.tumanId ?? null,
      viloyatId: club.institution?.viloyatId ?? null,
    });
  }

  // ── Klub CRUD ─────────────────────────────────────────────────────────────

  async createClub(data: {
    name: string;
    institutionId: string;
    leaderId: string;
    goal?: number;
    description?: string;
  }) {
    const institution = await this.prisma.institution.findUnique({
      where: { id: data.institutionId }
    });
    if (!institution) throw new NotFoundException("Muassasa topilmadi");

    const club = await this.prisma.club.create({
      data: {
        name: data.name,
        institutionId: data.institutionId,
        leaderId: data.leaderId,
        goal: data.goal ?? ANNUAL_GOAL,
        quarterGoal: QUARTER_GOAL,
        description: data.description ?? null
      }
    });

    this.logger.log(`Klub yaratildi: ${club.id} — ${club.name}`);
    return club;
  }

  async getClub(id: string) {
    const club = await this.prisma.club.findUnique({
      where: { id },
      include: {
        institution: { select: { id: true, name: true, type: true } },
        _count: { select: { members: true, debates: true } }
      }
    });
    if (!club) throw new NotFoundException("Klub topilmadi");
    return club;
  }

  async listClubs(filters: {
    institutionId?: string;
    tumanId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const { limit = 50, offset = 0 } = filters;
    const where = {
      ...(filters.institutionId && { institutionId: filters.institutionId }),
      ...(filters.status && { status: filters.status }),
      ...(filters.tumanId && { institution: { tumanId: filters.tumanId } })
    };

    const [clubs, total] = await Promise.all([
      this.prisma.club.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          institution: { select: { id: true, name: true } },
          _count: { select: { members: true, debates: true } }
        }
      }),
      this.prisma.club.count({ where })
    ]);

    return { data: clubs, total, limit, offset };
  }

  // IDOR-H12 — actor required; KLUB_RAHBARI may only update THEIR OWN club.
  async updateClub(actor: ClubActor, id: string, data: {
    name?: string;
    goal?: number;
    description?: string;
    status?: string;
  }) {
    const club = await this.getClubForMutation(id);
    this.assertClubMutationAllowed(actor, club);

    await this.cache.del(`club:monitoring:${id}`);
    return this.prisma.club.update({ where: { id }, data });
  }

  // ── A'zolik tizimi ────────────────────────────────────────────────────────

  // IDOR-H12 — actor required; KLUB_RAHBARI may only add members to THEIR OWN club.
  async addMember(actor: ClubActor, clubId: string, userId: string, parentPhone?: string) {
    const club = await this.getClubForMutation(clubId);
    this.assertClubMutationAllowed(actor, club);
    if (club.status !== "ACTIVE") throw new BadRequestException("Klub faol emas");

    // Avvalgi a'zolikni tekshirish
    const existing = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } }
    });
    if (existing && existing.status !== "LEFT") {
      throw new BadRequestException("Foydalanuvchi allaqachon bu klubda");
    }

    // Yoshni aniqlash
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dob: true, phone: true, name: true }
    });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    const age = this._calcAge(user.dob);
    const needsParentConsent = age < 18;

    if (needsParentConsent && !parentPhone) {
      throw new BadRequestException(
        "18 yoshgacha bo'lgan a'zolar uchun ota-ona telefon raqami kerak"
      );
    }

    const member = await this.prisma.clubMember.upsert({
      where: { clubId_userId: { clubId, userId } },
      create: {
        clubId,
        userId,
        parentPhone: needsParentConsent ? parentPhone : null,
        parentConsented: !needsParentConsent,
        status: needsParentConsent ? "PENDING" : "ACTIVE",
        joinedAt: needsParentConsent ? null : new Date()
      },
      update: {
        status: needsParentConsent ? "PENDING" : "ACTIVE",
        parentPhone: needsParentConsent ? parentPhone : null,
        parentConsented: !needsParentConsent,
        joinedAt: needsParentConsent ? null : new Date(),
        leftAt: null
      }
    });

    // Plan 06-04 SCH-04 — bcrypt-hashed deep-link SMS (replaces legacy
    // "reply HA <memberId>" UX). The ClubConsentService mints a 128-bit nonce,
    // bcrypts it, persists the hash to ClubMemberConsentToken (48h TTL), and
    // enqueues the SMS via NOTIFICATION_QUEUE with the consent deep-link.
    if (needsParentConsent && parentPhone) {
      if (this.consent) {
        await this.consent.mintAndSend({
          clubMemberId: member.id,
          parentPhone,
          childName: user.name,
          clubName: club.name,
        });
      } else {
        // Legacy fallback for tests constructed without ClubConsentService.
        await this._sendParentConsentSms(parentPhone, user.name, club.name, member.id);
      }
    }

    await this.cache.del(`club:monitoring:${clubId}`);
    return member;
  }

  // IDOR-H12 — actor required; a foreign KLUB_RAHBARI must not confirm another
  // club's member (the club is resolved via the membership row).
  async confirmParentConsent(actor: ClubActor, memberId: string, phone: string) {
    const member = await this.prisma.clubMember.findUnique({ where: { id: memberId } });
    if (!member) throw new NotFoundException("A'zolik topilmadi");

    const club = await this.getClubForMutation(member.clubId);
    this.assertClubMutationAllowed(actor, club);

    if (member.parentPhone !== phone) {
      throw new ForbiddenException("Telefon raqam mos kelmadi");
    }
    if (member.status !== "PENDING") {
      throw new BadRequestException("A'zolik allaqachon tasdiqlangan yoki bekor qilingan");
    }

    await this.cache.del(`club:monitoring:${member.clubId}`);
    return this.prisma.clubMember.update({
      where: { id: memberId },
      data: { status: "ACTIVE", parentConsented: true, joinedAt: new Date() }
    });
  }

  // IDOR-H12 — actor required; KLUB_RAHBARI may only remove members from THEIR OWN club.
  async removeMember(actor: ClubActor, clubId: string, userId: string) {
    const club = await this.getClubForMutation(clubId);
    this.assertClubMutationAllowed(actor, club);

    const member = await this.prisma.clubMember.findUnique({
      where: { clubId_userId: { clubId, userId } }
    });
    if (!member) throw new NotFoundException("A'zolik topilmadi");

    await this.cache.del(`club:monitoring:${clubId}`);
    return this.prisma.clubMember.update({
      where: { id: member.id },
      data: { status: "LEFT", leftAt: new Date() }
    });
  }

  async getMembers(clubId: string) {
    const members = await this.prisma.clubMember.findMany({
      where: { clubId, status: "ACTIVE" },
      orderBy: { joinedAt: "asc" }
    });
    if (members.length === 0) return [];

    const userIds = members.map((m) => m.userId);

    // N+1 fix (P2, 2026-06-10): avval har a'zo uchun alohida
    // readingIndex.findFirst + user.findUnique ketardi (30 a'zo = 60+ so'rov).
    // Endi ikkala lookup BITTADAN findMany({ userId: { in } }) bilan olinadi.
    // "Eng so'nggi RI" tanlash reading.service.getLeaderboard'dagi
    // latest-per-user semantikasi bilan bir xil: calculatedAt DESC tartibda
    // har user uchun BIRINCHI uchragan yozuv = eng yangisi (in-memory group).
    const [riRows, users] = await Promise.all([
      this.prisma.readingIndex.findMany({
        where: { userId: { in: userIds } },
        orderBy: { calculatedAt: "desc" },
        select: { userId: true, score: true }
      }),
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, sifatId: true, schoolClass: true }
      })
    ]);

    const latestRiByUser = new Map<string, number>();
    for (const r of riRows) {
      if (!latestRiByUser.has(r.userId)) latestRiByUser.set(r.userId, r.score);
    }
    const userById = new Map(users.map((u) => [u.id, u]));

    // booksThisYear count'lari avvalgidek qoladi (alohida COUNT semantikasi).
    const enriched = await Promise.all(
      members.map(async (m) => {
        const booksThisYear = await this._countBooksThisYear(m.userId);
        const u = userById.get(m.userId);

        return {
          ...m,
          // Avvalgi findUnique select shape bilan AYNAN bir xil natija:
          // { name, sifatId, schoolClass } yoki user topilmasa null.
          user: u ? { name: u.name, sifatId: u.sifatId, schoolClass: u.schoolClass } : null,
          latestRi: latestRiByUser.get(m.userId) ?? 0,
          booksThisYear,
          goalProgress: Math.round((booksThisYear / ANNUAL_GOAL) * 100)
        };
      })
    );

    return enriched.sort((a, b) => b.booksThisYear - a.booksThisYear);
  }

  // ── Debat qayd etish ──────────────────────────────────────────────────────

  // IDOR-H12 — actor required: KLUB_RAHBARI may only record debates for THEIR
  // OWN club, and recordedById is ALWAYS the authenticated actor (never a
  // client-supplied id).
  async createDebate(actor: ClubActor, data: {
    clubId: string;
    topic: string;
    heldAt: Date;
    venue?: string;
    participants: number;
    summary?: string;
    mediaUrls?: string[];
  }) {
    const club = await this.getClubForMutation(data.clubId);
    this.assertClubMutationAllowed(actor, club);

    const debate = await this.prisma.debate.create({
      data: {
        clubId: data.clubId,
        topic: data.topic,
        heldAt: data.heldAt,
        venue: data.venue ?? null,
        participants: data.participants,
        summary: data.summary ?? null,
        mediaUrls: data.mediaUrls ?? [],
        recordedById: actor.id
      }
    });

    await this.cache.del(`club:monitoring:${data.clubId}`);
    return debate;
  }

  async getDebates(clubId: string, filters: {
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const { limit = 50 } = filters;
    return this.prisma.debate.findMany({
      where: {
        clubId,
        ...((filters.from || filters.to) && {
          heldAt: {
            ...(filters.from && { gte: filters.from }),
            ...(filters.to   && { lte: filters.to   }),
          },
        }),
      },
      orderBy: { heldAt: "desc" },
      take: limit
    });
  }

  // ── Klub monitoring paneli ────────────────────────────────────────────────

  async getClubMonitoring(clubId: string) {
    return this.cache.remember(`club:monitoring:${clubId}`, 300, async () => {
      const club = await this.getClub(clubId);
      const members = await this.getMembers(clubId);

      // Choraklik progress
      const [year, q] = [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
      const quarterStart = new Date(year, (q - 1) * 3, 1);
      const quarterEnd = new Date(year, q * 3, 0, 23, 59, 59);

      // P2 fix (2026-06-10): monitoring DRAFT debatlarni ham sanardi — rasmiy
      // PQ-9 hisobot (getQuarterlyReport, Plan 06-04 SCH-05) esa faqat
      // PUBLISHED sanaydi. Ikkala ko'rsatkich endi bir xil vocabulary'da:
      // monitoring paneli rahbarga hisobotdagidan KO'P progress ko'rsatmaydi.
      const quarterDebates = await this.prisma.debate.count({
        where: {
          clubId,
          status: "PUBLISHED",
          heldAt: { gte: quarterStart, lte: quarterEnd }
        }
      });

      const lastDebate = await this.prisma.debate.findFirst({
        where: { clubId },
        orderBy: { heldAt: "desc" },
        select: { heldAt: true, topic: true }
      });

      // Faolsizlik tekshiruvi
      const daysSinceDebate = lastDebate
        ? Math.floor((Date.now() - lastDebate.heldAt.getTime()) / 86_400_000)
        : Infinity;

      // A'zolar bo'yicha statistika
      const memberStats = {
        total: members.length,
        onTrack: members.filter((m) => m.goalProgress >= 75).length,
        atRisk: members.filter((m) => m.goalProgress < 25).length,
        avgBooks: members.length > 0
          ? Math.round(members.reduce((s, m) => s + m.booksThisYear, 0) / members.length)
          : 0,
        avgRi: members.length > 0
          ? Math.round(members.reduce((s, m) => s + m.latestRi, 0) / members.length * 10) / 10
          : 0
      };

      return {
        club,
        memberStats,
        quarterDebates,
        quarterGoal: QUARTER_GOAL,
        quarterProgress: Math.round((quarterDebates / QUARTER_GOAL) * 100),
        daysSinceLastDebate: daysSinceDebate === Infinity ? null : daysSinceDebate,
        lastDebate,
        alert: daysSinceDebate > 45
          ? { type: "WARNING", message: `Klub ${daysSinceDebate} kun debat o'tkazmadi` }
          : null,
        members
      };
    });
  }

  // ── 20 kitob maqsadi (yillik) ─────────────────────────────────────────────

  async getGoalProgress(clubId: string) {
    const members = await this.getMembers(clubId);
    const [year, q] = [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
    const quarterStart = new Date(year, (q - 1) * 3, 1);
    const quarterEnd = new Date(year, q * 3, 0, 23, 59, 59);

    const enrichedWithQuarter = await Promise.all(
      members.map(async (m) => {
        const quarterBooks = await this.prisma.bookTransaction.count({
          where: {
            userId: m.userId,
            status: "RETURNED",
            returnedAt: { gte: quarterStart, lte: quarterEnd }
          }
        });
        return {
          ...m,
          quarterBooks,
          quarterGoalProgress: Math.round((quarterBooks / QUARTER_GOAL) * 100),
          onTrackForYear: m.booksThisYear >= (q * QUARTER_GOAL * 0.8) // 80% on-track
        };
      })
    );

    const summary = {
      year,
      quarter: q,
      annualGoal: ANNUAL_GOAL,
      quarterGoal: QUARTER_GOAL,
      totalMembers: members.length,
      achievedAnnual: enrichedWithQuarter.filter((m) => m.booksThisYear >= ANNUAL_GOAL).length,
      onTrackCount: enrichedWithQuarter.filter((m) => m.onTrackForYear).length,
      atRiskCount: enrichedWithQuarter.filter((m) => !m.onTrackForYear).length
    };

    return { summary, members: enrichedWithQuarter };
  }

  // ── Choraklik hisobot (SCH-06 + SCH-09 birgalikda) ────────────────────────
  //
  // Plan 06-02 SCH-06 — getQuarterlyReport composes:
  //   - per-member 20-book progress (rate + quartile from getGoalProgress)
  //   - PUBLISHED debate count this quarter
  //   - inactive flag (true when daysSinceDebate >= INACTIVE_THRESHOLD_DAYS)
  // ready for PDF embedding by school.service.getPq9ReportData.
  async getQuarterlyReport(clubId: string) {
    const club = await this.prisma.club.findUnique({
      where: { id: clubId },
      select: { id: true, name: true, status: true, institutionId: true },
    });
    if (!club) throw new NotFoundException("Klub topilmadi");

    const goal = await this.getGoalProgress(clubId);

    // Quarter window
    const [year, q] = [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
    const quarterStart = new Date(year, (q - 1) * 3, 1);
    const quarterEnd = new Date(year, q * 3, 0, 23, 59, 59);

    // Plan 06-04 SCH-05 — quarterly + PDF reports only count PUBLISHED debates.
    const publishedDebates = await this.prisma.debate.count({
      where: {
        clubId,
        heldAt: { gte: quarterStart, lte: quarterEnd },
        status: "PUBLISHED",
      },
    });

    const lastDebate = await this.prisma.debate.findFirst({
      where: { clubId },
      orderBy: { heldAt: "desc" },
      select: { heldAt: true },
    });

    const daysSinceDebate = lastDebate
      ? Math.floor((Date.now() - lastDebate.heldAt.getTime()) / 86_400_000)
      : Infinity;

    const inactive = daysSinceDebate >= INACTIVE_THRESHOLD_DAYS;

    // Per-member rate + quartile classification (SCH-06).
    const enrichedMembers = goal.members.map((m: any) => {
      const rate = Math.min(m.booksThisYear / GOAL, 1.0);
      let quartile: "Q1" | "Q2" | "Q3" | "Q4";
      if (rate > 0.75) quartile = "Q1";
      else if (rate > 0.5) quartile = "Q2";
      else if (rate > 0.25) quartile = "Q3";
      else quartile = "Q4";
      return {
        userId: m.userId,
        name: m.user?.name ?? "(noma'lum)",
        booksReadThisYear: m.booksThisYear,
        rate,
        quartile,
      };
    });

    return {
      clubId: club.id,
      clubName: club.name,
      goal: GOAL,
      year,
      quarter: q,
      members: enrichedMembers,
      publishedDebates,
      daysSinceDebate: daysSinceDebate === Infinity ? null : daysSinceDebate,
      inactive,
      inactiveThresholdDays: INACTIVE_THRESHOLD_DAYS,
    };
  }

  // ── Tuman admin uchun barcha klublar monitoringi ───────────────────────────
  //
  // Plan 06-02 SCH-09 — default threshold is now INACTIVE_THRESHOLD_DAYS (30).
  // Admin tooling can still pass `inactiveDays=45` for back-compat reports.

  async getInactiveClubs(tumanId: string, inactiveDays = INACTIVE_THRESHOLD_DAYS) {
    const cutoff = new Date(Date.now() - inactiveDays * 86_400_000);

    // Oxirgi debaти cutoff dan oldin bo'lgan yoki umuman yo'q klublar
    const clubs = await this.prisma.club.findMany({
      where: { status: "ACTIVE", institution: { tumanId } },
      include: {
        institution: { select: { name: true } },
        debates: {
          orderBy: { heldAt: "desc" },
          take: 1,
          select: { heldAt: true }
        },
        _count: { select: { members: true } }
      }
    });

    return clubs
      .filter((c) => {
        const lastDebate = c.debates[0]?.heldAt;
        return !lastDebate || lastDebate < cutoff;
      })
      .map((c) => ({
        clubId: c.id,
        clubName: c.name,
        institution: c.institution.name,
        memberCount: c._count.members,
        lastDebateAt: c.debates[0]?.heldAt ?? null,
        daysSinceDebate: c.debates[0]?.heldAt
          ? Math.floor((Date.now() - c.debates[0].heldAt.getTime()) / 86_400_000)
          : null
      }));
  }

  // ── Yordamchi metodlar ────────────────────────────────────────────────────

  private async _countBooksThisYear(userId: string): Promise<number> {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    return this.prisma.bookTransaction.count({
      where: {
        userId,
        status: "RETURNED",
        returnedAt: { gte: yearStart }
      }
    });
  }

  private _calcAge(dob: Date): number {
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
  }

  private async _sendParentConsentSms(
    parentPhone: string,
    childName: string,
    clubName: string,
    memberId: string
  ) {
    const msg = `SIFAT LIBRARY: ${childName} farzandingiz "${clubName}" klubiga qo'shilmoqchi. Ruxsat berish uchun: HA — ${memberId} yuborin (yoki ilova orqali tasdiqlang). SMS.uz`;
    await this.sms.sendNotification(parentPhone, msg, memberId);
  }
}
