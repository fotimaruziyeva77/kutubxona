import { NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ClubService, INACTIVE_THRESHOLD_DAYS, GOAL, type ClubActor } from "../club.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  institution: { findUnique: jest.fn() },
  club: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  clubMember: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  // P2 N+1 fix — getMembers endi user.findMany + readingIndex.findMany (batch)
  // ishlatadi; findUnique addMember'da qoladi.
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  readingIndex: { findFirst: jest.fn(), findMany: jest.fn() },
  bookTransaction: { count: jest.fn() },
  debate: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
  },
} as any;

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockCache = {
  remember: jest.fn().mockImplementation((_k: string, _t: number, fn: () => unknown) => fn()),
  del: jest.fn(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeClub = (overrides: object = {}) => ({
  id: "club-1",
  name: "Test Klub",
  institutionId: "inst-1",
  leaderId: "leader-1",
  goal: 20,
  quarterGoal: 5,
  description: null,
  status: "ACTIVE",
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

const makeMember = (overrides: object = {}) => ({
  id: "member-1",
  clubId: "club-1",
  userId: "user-1",
  status: "ACTIVE",
  parentPhone: null,
  parentConsented: true,
  joinedAt: new Date("2026-01-10"),
  leftAt: null,
  ...overrides,
});

// dob for adult (30 years old)
const adultDob = new Date(new Date().getFullYear() - 30, 0, 1);
// dob for minor (15 years old)
const minorDob = new Date(new Date().getFullYear() - 15, 0, 1);

// ── IDOR-H12 — mutation actors ───────────────────────────────────────────────
const makeActor = (overrides: Partial<ClubActor> = {}): ClubActor => ({
  id: "leader-1",
  role: UserRole.KLUB_RAHBARI,
  schoolId: null,
  universityId: null,
  organizationId: null,
  address: { viloyatId: null, tumanId: null },
  ...overrides,
});

// Leader of club-1 (makeClub().leaderId === "leader-1")
const leaderActor = makeActor();
// Leader of a DIFFERENT club — must be rejected on club-1 mutations
const foreignLeaderActor = makeActor({ id: "leader-other" });
// Global bypass tier
const superAdminActor = makeActor({ id: "admin-1", role: UserRole.SUPER_ADMIN });

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ClubService", () => {
  let service: ClubService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClubService(
      mockPrisma as unknown as PrismaService,
      mockSms as unknown as SmsService,
      mockCache as unknown as CacheService,
    );
  });

  // ── createClub ─────────────────────────────────────────────────────────────

  describe("createClub", () => {
    it("creates a club when institution exists", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({ id: "inst-1" });
      const createdClub = makeClub();
      mockPrisma.club.create.mockResolvedValue(createdClub);

      const result = await service.createClub({
        name: "Test Klub",
        institutionId: "inst-1",
        leaderId: "leader-1",
      });

      expect(result).toEqual(createdClub);
      expect(mockPrisma.club.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Test Klub",
            institutionId: "inst-1",
            leaderId: "leader-1",
            goal: 20,
            quarterGoal: 5,
          }),
        })
      );
    });

    it("uses provided goal and description", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue({ id: "inst-1" });
      mockPrisma.club.create.mockResolvedValue(makeClub({ goal: 30, description: "Desc" }));

      await service.createClub({
        name: "Test Klub",
        institutionId: "inst-1",
        leaderId: "leader-1",
        goal: 30,
        description: "Desc",
      });

      expect(mockPrisma.club.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ goal: 30, description: "Desc" }),
        })
      );
    });

    it("throws NotFoundException when institution not found", async () => {
      mockPrisma.institution.findUnique.mockResolvedValue(null);

      await expect(
        service.createClub({ name: "K", institutionId: "bad-id", leaderId: "l" })
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── getClub ────────────────────────────────────────────────────────────────

  describe("getClub", () => {
    it("returns club with relations", async () => {
      const club = makeClub();
      mockPrisma.club.findUnique.mockResolvedValue(club);

      const result = await service.getClub("club-1");
      expect(result).toEqual(club);
      expect(mockPrisma.club.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "club-1" } })
      );
    });

    it("throws NotFoundException when club does not exist", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);
      await expect(service.getClub("no-such-club")).rejects.toThrow(NotFoundException);
    });
  });

  // ── listClubs ──────────────────────────────────────────────────────────────

  describe("listClubs", () => {
    it("returns paginated clubs with total", async () => {
      const clubs = [makeClub()];
      mockPrisma.club.findMany.mockResolvedValue(clubs);
      mockPrisma.club.count.mockResolvedValue(1);

      const result = await service.listClubs({});
      expect(result).toEqual({ data: clubs, total: 1, limit: 50, offset: 0 });
    });

    it("applies institutionId and status filters", async () => {
      mockPrisma.club.findMany.mockResolvedValue([]);
      mockPrisma.club.count.mockResolvedValue(0);

      await service.listClubs({ institutionId: "inst-1", status: "ACTIVE", limit: 10, offset: 5 });

      expect(mockPrisma.club.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ institutionId: "inst-1", status: "ACTIVE" }),
          skip: 5,
          take: 10,
        })
      );
    });

    it("applies tumanId filter via institution", async () => {
      mockPrisma.club.findMany.mockResolvedValue([]);
      mockPrisma.club.count.mockResolvedValue(0);

      await service.listClubs({ tumanId: "tuman-1" });

      expect(mockPrisma.club.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ institution: { tumanId: "tuman-1" } }),
        })
      );
    });
  });

  // ── updateClub ─────────────────────────────────────────────────────────────

  describe("updateClub", () => {
    it("updates club and invalidates cache (own leader)", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      const updated = makeClub({ name: "New Name" });
      mockPrisma.club.update.mockResolvedValue(updated);

      const result = await service.updateClub(leaderActor, "club-1", { name: "New Name" });

      expect(mockCache.del).toHaveBeenCalledWith("club:monitoring:club-1");
      expect(result).toEqual(updated);
    });

    it("throws NotFoundException when club not found", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);
      await expect(service.updateClub(superAdminActor, "no-id", { name: "X" })).rejects.toThrow(NotFoundException);
    });
  });

  // ── addMember ──────────────────────────────────────────────────────────────

  describe("addMember", () => {
    it("adds adult member without parent consent", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        dob: adultDob,
        phone: "+998901234567",
        name: "Ali Valiyev",
      });
      const member = makeMember({ status: "ACTIVE" });
      mockPrisma.clubMember.upsert.mockResolvedValue(member);

      const result = await service.addMember(leaderActor, "club-1", "user-1");

      expect(mockPrisma.clubMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "ACTIVE", parentConsented: true }),
        })
      );
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
      expect(result).toEqual(member);
    });

    it("adds minor member with parent consent SMS", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({
        dob: minorDob,
        phone: "+998901234567",
        name: "Zafar",
      });
      const member = makeMember({ status: "PENDING", parentPhone: "+998990000001" });
      mockPrisma.clubMember.upsert.mockResolvedValue(member);

      await service.addMember(leaderActor, "club-1", "user-2", "+998990000001");

      expect(mockPrisma.clubMember.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "PENDING", parentConsented: false }),
        })
      );
      expect(mockSms.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("throws BadRequestException if minor member has no parentPhone", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ dob: minorDob, phone: "+998901234567", name: "Zafar" });

      await expect(service.addMember(leaderActor, "club-1", "user-2")).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if member already active in club", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(makeMember({ status: "ACTIVE" }));

      await expect(service.addMember(leaderActor, "club-1", "user-1")).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if club is not active", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub({ status: "INACTIVE" }));

      await expect(service.addMember(leaderActor, "club-1", "user-1")).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException if club does not exist", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);
      await expect(service.addMember(leaderActor, "bad-club", "user-1")).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException if user does not exist", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.addMember(leaderActor, "club-1", "no-user")).rejects.toThrow(NotFoundException);
    });

    it("allows re-adding a LEFT member", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(makeMember({ status: "LEFT" }));
      mockPrisma.user.findUnique.mockResolvedValue({ dob: adultDob, phone: "+998901234567", name: "Ali" });
      mockPrisma.clubMember.upsert.mockResolvedValue(makeMember({ status: "ACTIVE" }));

      const result = await service.addMember(leaderActor, "club-1", "user-1");
      expect(result.status).toBe("ACTIVE");
    });

    // Plan 06-04 SCH-04 — bcrypt-deep-link consent delegation
    it("delegates to ClubConsentService.mintAndSend when wired (Plan 06-04)", async () => {
      const mockConsent = { mintAndSend: jest.fn().mockResolvedValue({ nonce: "x", expiresAt: new Date() }) } as any;
      const svcWithConsent = new ClubService(
        mockPrisma as unknown as PrismaService,
        mockSms as unknown as SmsService,
        mockCache as unknown as CacheService,
        mockConsent,
      );

      mockPrisma.club.findUnique.mockResolvedValue(makeClub({ name: "Jadidlar Klubi" }));
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ dob: minorDob, phone: "+998901234567", name: "Zafar" });
      mockPrisma.clubMember.upsert.mockResolvedValue(
        makeMember({ id: "member-99", status: "PENDING", parentPhone: "+998990000001" }),
      );

      await svcWithConsent.addMember(leaderActor, "club-1", "user-2", "+998990000001");

      expect(mockConsent.mintAndSend).toHaveBeenCalledWith({
        clubMemberId: "member-99",
        parentPhone: "+998990000001",
        childName: "Zafar",
        clubName: "Jadidlar Klubi",
      });
      // Legacy SmsService path NOT invoked when delegate is wired
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });
  });

  // ── confirmParentConsent ───────────────────────────────────────────────────

  describe("confirmParentConsent", () => {
    it("confirms consent and sets member ACTIVE", async () => {
      const pending = makeMember({ status: "PENDING", parentPhone: "+998990000001" });
      mockPrisma.clubMember.findUnique.mockResolvedValue(pending);
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      const activated = makeMember({ status: "ACTIVE" });
      mockPrisma.clubMember.update.mockResolvedValue(activated);

      const result = await service.confirmParentConsent(leaderActor, "member-1", "+998990000001");

      expect(mockCache.del).toHaveBeenCalledWith("club:monitoring:club-1");
      expect(mockPrisma.clubMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ACTIVE", parentConsented: true }),
        })
      );
      expect(result).toEqual(activated);
    });

    it("throws NotFoundException if member not found", async () => {
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      await expect(service.confirmParentConsent(leaderActor, "bad-id", "+998990000001")).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws ForbiddenException if phone does not match", async () => {
      mockPrisma.clubMember.findUnique.mockResolvedValue(
        makeMember({ status: "PENDING", parentPhone: "+998990000001" })
      );
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      await expect(service.confirmParentConsent(leaderActor, "member-1", "+998990000002")).rejects.toThrow(
        ForbiddenException
      );
    });

    it("throws BadRequestException if member is not PENDING", async () => {
      mockPrisma.clubMember.findUnique.mockResolvedValue(
        makeMember({ status: "ACTIVE", parentPhone: "+998990000001" })
      );
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      await expect(service.confirmParentConsent(leaderActor, "member-1", "+998990000001")).rejects.toThrow(
        BadRequestException
      );
    });
  });

  // ── removeMember ───────────────────────────────────────────────────────────

  describe("removeMember", () => {
    it("marks member as LEFT", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(makeMember());
      mockPrisma.clubMember.update.mockResolvedValue(makeMember({ status: "LEFT" }));

      const result = await service.removeMember(leaderActor, "club-1", "user-1");

      expect(mockCache.del).toHaveBeenCalledWith("club:monitoring:club-1");
      expect(mockPrisma.clubMember.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "LEFT" }) })
      );
      expect(result.status).toBe("LEFT");
    });

    it("throws NotFoundException if membership not found", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findUnique.mockResolvedValue(null);
      await expect(service.removeMember(leaderActor, "club-1", "user-1")).rejects.toThrow(NotFoundException);
    });
  });

  // ── getMembers ─────────────────────────────────────────────────────────────

  describe("getMembers", () => {
    it("returns enriched member list sorted by booksThisYear", async () => {
      const members = [
        makeMember({ id: "m-1", userId: "u-1" }),
        makeMember({ id: "m-2", userId: "u-2" }),
      ];
      mockPrisma.clubMember.findMany.mockResolvedValue(members);
      // P2 N+1 fix — RI va user endi BITTA findMany bilan keladi (batch).
      mockPrisma.readingIndex.findMany.mockResolvedValue([
        { userId: "u-1", score: 70 },
        { userId: "u-2", score: 80 },
      ]);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(10);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Ali", sifatId: "SL-001", schoolClass: "10A" },
        { id: "u-2", name: "Vali", sifatId: "SL-002", schoolClass: "11B" },
      ]);

      const result = await service.getMembers("club-1");

      expect(result).toHaveLength(2);
      // sorted descending by booksThisYear
      expect(result[0].booksThisYear).toBeGreaterThanOrEqual(result[1].booksThisYear);
      expect(result[0].goalProgress).toBe(50); // 10/20 * 100
      // user shape avvalgi findUnique select bilan AYNAN bir xil
      expect(result[0].user).toEqual({ name: "Vali", sifatId: "SL-002", schoolClass: "11B" });
      expect(result[0].latestRi).toBe(80);
    });

    // P2 N+1 regression guard — a'zo soni nechta bo'lsa ham RI va user uchun
    // bittadan so'rov; per-member findFirst/findUnique YO'Q.
    it("batches RI + user lookups into single findMany calls (N+1 fix)", async () => {
      mockPrisma.clubMember.findMany.mockResolvedValue([
        makeMember({ id: "m-1", userId: "u-1" }),
        makeMember({ id: "m-2", userId: "u-2" }),
        makeMember({ id: "m-3", userId: "u-3" }),
      ]);
      mockPrisma.readingIndex.findMany.mockResolvedValue([]);
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.count.mockResolvedValue(0);

      await service.getMembers("club-1");

      expect(mockPrisma.readingIndex.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.readingIndex.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: { in: ["u-1", "u-2", "u-3"] } },
          orderBy: { calculatedAt: "desc" },
        })
      );
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ["u-1", "u-2", "u-3"] } } })
      );
      expect(mockPrisma.readingIndex.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("picks the LATEST RI per user (first row in calculatedAt DESC order wins)", async () => {
      mockPrisma.clubMember.findMany.mockResolvedValue([makeMember({ id: "m-1", userId: "u-1" })]);
      // calculatedAt DESC tartib — 91 birinchi (eng yangi), 40 eski snapshot.
      mockPrisma.readingIndex.findMany.mockResolvedValue([
        { userId: "u-1", score: 91 },
        { userId: "u-1", score: 40 },
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Ali", sifatId: "SL-001", schoolClass: "10A" },
      ]);
      mockPrisma.bookTransaction.count.mockResolvedValue(2);

      const result = await service.getMembers("club-1");
      expect(result[0].latestRi).toBe(91);
    });

    it("returns empty array when no active members", async () => {
      mockPrisma.clubMember.findMany.mockResolvedValue([]);
      const result = await service.getMembers("club-1");
      expect(result).toEqual([]);
      // Bo'sh klub uchun keraksiz batch so'rovlar ketmaydi.
      expect(mockPrisma.readingIndex.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it("handles member with no readingIndex (defaults to 0)", async () => {
      mockPrisma.clubMember.findMany.mockResolvedValue([makeMember()]);
      mockPrisma.readingIndex.findMany.mockResolvedValue([]);
      mockPrisma.bookTransaction.count.mockResolvedValue(3);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "user-1", name: "Ali", sifatId: "SL-001", schoolClass: null },
      ]);

      const result = await service.getMembers("club-1");
      expect(result[0].latestRi).toBe(0);
      expect(result[0].booksThisYear).toBe(3);
    });
  });

  // ── createDebate ───────────────────────────────────────────────────────────

  describe("createDebate", () => {
    it("creates a debate and invalidates cache", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      const debate = {
        id: "debate-1",
        clubId: "club-1",
        topic: "Kitob va hayot",
        heldAt: new Date("2026-04-01"),
        participants: 20,
      };
      mockPrisma.debate.create.mockResolvedValue(debate);

      const result = await service.createDebate(leaderActor, {
        clubId: "club-1",
        topic: "Kitob va hayot",
        heldAt: new Date("2026-04-01"),
        participants: 20,
      });

      expect(mockCache.del).toHaveBeenCalledWith("club:monitoring:club-1");
      expect(result).toEqual(debate);
    });

    // IDOR-H12 — recordedById is ALWAYS the authenticated actor; the data
    // shape no longer even accepts a client-supplied recordedById.
    it("stamps recordedById from the actor (JWT), not the payload", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.debate.create.mockResolvedValue({ id: "debate-x" });

      await service.createDebate(leaderActor, {
        clubId: "club-1",
        topic: "T",
        heldAt: new Date(),
        participants: 5,
      });

      expect(mockPrisma.debate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recordedById: "leader-1" }),
        })
      );
    });

    it("throws NotFoundException when club not found", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);
      await expect(
        service.createDebate(leaderActor, {
          clubId: "bad",
          topic: "T",
          heldAt: new Date(),
          participants: 5,
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("passes optional fields to debate.create", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.debate.create.mockResolvedValue({ id: "debate-2" });

      await service.createDebate(leaderActor, {
        clubId: "club-1",
        topic: "T",
        heldAt: new Date(),
        venue: "Konferents zal",
        participants: 10,
        summary: "Xulosa",
        mediaUrls: ["http://example.com/img.jpg"],
      });

      expect(mockPrisma.debate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venue: "Konferents zal",
            summary: "Xulosa",
            mediaUrls: ["http://example.com/img.jpg"],
          }),
        })
      );
    });
  });

  // ── IDOR-H12 — leader ownership + admin-tier scope on mutations ───────────
  describe("IDOR-H12 — club mutation ownership", () => {
    beforeEach(() => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub()); // leaderId: leader-1
    });

    it("foreign KLUB_RAHBARI cannot updateClub on another leader's club (403)", async () => {
      await expect(
        service.updateClub(foreignLeaderActor, "club-1", { name: "Hack" })
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.club.update).not.toHaveBeenCalled();
    });

    it("foreign KLUB_RAHBARI cannot addMember to another leader's club (403)", async () => {
      await expect(
        service.addMember(foreignLeaderActor, "club-1", "user-1")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.clubMember.upsert).not.toHaveBeenCalled();
    });

    it("foreign KLUB_RAHBARI cannot removeMember from another leader's club (403)", async () => {
      await expect(
        service.removeMember(foreignLeaderActor, "club-1", "user-1")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.clubMember.update).not.toHaveBeenCalled();
    });

    it("foreign KLUB_RAHBARI cannot createDebate for another leader's club (403)", async () => {
      await expect(
        service.createDebate(foreignLeaderActor, {
          clubId: "club-1",
          topic: "T",
          heldAt: new Date(),
          participants: 5,
        })
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.debate.create).not.toHaveBeenCalled();
    });

    it("foreign KLUB_RAHBARI cannot confirmParentConsent for another club's member (403)", async () => {
      mockPrisma.clubMember.findUnique.mockResolvedValue(
        makeMember({ status: "PENDING", parentPhone: "+998990000001" })
      );
      await expect(
        service.confirmParentConsent(foreignLeaderActor, "member-1", "+998990000001")
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.clubMember.update).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN bypasses the leader ownership check", async () => {
      mockPrisma.club.update.mockResolvedValue(makeClub({ name: "Admin edit" }));
      const result = await service.updateClub(superAdminActor, "club-1", { name: "Admin edit" });
      expect(result.name).toBe("Admin edit");
    });

    it("MUASSASA_ADMIN of the OWNING institution is allowed; another institution's admin is rejected", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(
        makeClub({
          institution: { id: "inst-1", type: "SCHOOL", tumanId: "t1", viloyatId: "v1" },
        })
      );
      mockPrisma.club.update.mockResolvedValue(makeClub());

      const ownInstAdmin = makeActor({
        id: "madmin-1",
        role: UserRole.MUASSASA_ADMIN,
        schoolId: "inst-1",
      });
      await expect(
        service.updateClub(ownInstAdmin, "club-1", { name: "OK" })
      ).resolves.toBeDefined();

      const otherInstAdmin = makeActor({
        id: "madmin-2",
        role: UserRole.MUASSASA_ADMIN,
        schoolId: "inst-OTHER",
      });
      await expect(
        service.updateClub(otherInstAdmin, "club-1", { name: "Hack" })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── getDebates ─────────────────────────────────────────────────────────────

  describe("getDebates", () => {
    it("returns debates for a club", async () => {
      const debates = [{ id: "d-1", clubId: "club-1", heldAt: new Date() }];
      mockPrisma.debate.findMany.mockResolvedValue(debates);

      const result = await service.getDebates("club-1", {});
      expect(result).toEqual(debates);
      expect(mockPrisma.debate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clubId: "club-1" }, take: 50 })
      );
    });

    it("applies from/to filters", async () => {
      mockPrisma.debate.findMany.mockResolvedValue([]);
      const from = new Date("2026-01-01");
      const to = new Date("2026-03-31");

      await service.getDebates("club-1", { from, to, limit: 10 });

      expect(mockPrisma.debate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            heldAt: expect.objectContaining({ gte: from, lte: to }),
          }),
          take: 10,
        })
      );
    });
  });

  // ── getClubMonitoring ──────────────────────────────────────────────────────

  describe("getClubMonitoring", () => {
    beforeEach(() => {
      // club via getClub (findUnique)
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      // members via getMembers (P2 N+1 fix — batch findMany mocklari)
      mockPrisma.clubMember.findMany.mockResolvedValue([makeMember()]);
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ userId: "user-1", score: 60 }]);
      mockPrisma.bookTransaction.count.mockResolvedValue(15);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "user-1", name: "Ali", sifatId: "SL-001", schoolClass: "10A" },
      ]);
      // quarter debates count
      mockPrisma.debate.count.mockResolvedValue(3);
      // last debate — recent (within 45 days)
      mockPrisma.debate.findFirst.mockResolvedValue({
        heldAt: new Date(Date.now() - 10 * 86_400_000),
        topic: "Recent debate",
      });
    });

    it("returns monitoring data via cache.remember", async () => {
      const result = await service.getClubMonitoring("club-1");

      expect(mockCache.remember).toHaveBeenCalledWith(
        "club:monitoring:club-1",
        300,
        expect.any(Function)
      );
      expect(result).toHaveProperty("memberStats");
      expect(result).toHaveProperty("quarterDebates", 3);
      expect(result.alert).toBeNull(); // recent debate, no alert
    });

    // P2 fix — monitoring DRAFT debatlarni sanamasligi kerak: rasmiy PQ-9
    // hisobot (getQuarterlyReport) faqat PUBLISHED sanaydi, monitoring ham
    // shu vocabulary'da bo'lishi shart.
    it("quarterDebates faqat PUBLISHED debatlarni sanaydi (PQ-9 bilan bir xil)", async () => {
      await service.getClubMonitoring("club-1");

      expect(mockPrisma.debate.count).toHaveBeenCalledTimes(1);
      expect(mockPrisma.debate.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clubId: "club-1",
            status: "PUBLISHED",
            heldAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
          }),
        })
      );
    });

    it("generates WARNING alert when debate older than 45 days", async () => {
      mockPrisma.debate.findFirst.mockResolvedValue({
        heldAt: new Date(Date.now() - 50 * 86_400_000),
        topic: "Old debate",
      });

      const result = await service.getClubMonitoring("club-1");
      expect(result.alert).not.toBeNull();
      expect(result.alert?.type).toBe("WARNING");
    });

    it("daysSinceLastDebate is null when no debates exist", async () => {
      mockPrisma.debate.findFirst.mockResolvedValue(null);

      const result = await service.getClubMonitoring("club-1");
      expect(result.daysSinceLastDebate).toBeNull();
    });
  });

  // ── getGoalProgress ────────────────────────────────────────────────────────

  describe("getGoalProgress", () => {
    beforeEach(() => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findMany.mockResolvedValue([makeMember()]);
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ userId: "user-1", score: 75 }]);
      // _countBooksThisYear + quarter count = 2 calls per member
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(12) // booksThisYear
        .mockResolvedValueOnce(3); // quarterBooks
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "user-1", name: "Ali", sifatId: "SL-001", schoolClass: "10A" },
      ]);
    });

    it("returns summary and enriched members", async () => {
      const result = await service.getGoalProgress("club-1");

      expect(result).toHaveProperty("summary");
      expect(result.summary).toHaveProperty("annualGoal", 20);
      expect(result.summary).toHaveProperty("quarterGoal", 5);
      expect(result).toHaveProperty("members");
      expect(result.members[0]).toHaveProperty("quarterBooks");
      expect(result.members[0]).toHaveProperty("quarterGoalProgress");
      expect(result.members[0]).toHaveProperty("onTrackForYear");
    });

    it("counts achievedAnnual when member meets goal", async () => {
      // reset and set booksThisYear >= 20
      mockPrisma.bookTransaction.count.mockReset();
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(20) // booksThisYear
        .mockResolvedValueOnce(5); // quarterBooks

      const result = await service.getGoalProgress("club-1");
      expect(result.summary.achievedAnnual).toBe(1);
    });
  });

  // ── getInactiveClubs ───────────────────────────────────────────────────────

  describe("getInactiveClubs", () => {
    it("returns clubs with no debates or debates older than cutoff", async () => {
      const oldDate = new Date(Date.now() - 60 * 86_400_000);
      const clubs = [
        {
          id: "club-1",
          name: "Klub A",
          institution: { name: "Maktab 1" },
          debates: [{ heldAt: oldDate }],
          _count: { members: 15 },
        },
        {
          id: "club-2",
          name: "Klub B",
          institution: { name: "Maktab 2" },
          debates: [],
          _count: { members: 5 },
        },
      ];
      mockPrisma.club.findMany.mockResolvedValue(clubs);

      const result = await service.getInactiveClubs("tuman-1");

      expect(result).toHaveLength(2);
      expect(result[0].clubId).toBe("club-1");
      expect(result[1].lastDebateAt).toBeNull();
    });

    it("excludes clubs with recent debates", async () => {
      const recentDate = new Date(Date.now() - 10 * 86_400_000);
      const clubs = [
        {
          id: "club-1",
          name: "Klub A",
          institution: { name: "Maktab 1" },
          debates: [{ heldAt: recentDate }],
          _count: { members: 15 },
        },
      ];
      mockPrisma.club.findMany.mockResolvedValue(clubs);

      const result = await service.getInactiveClubs("tuman-1");
      expect(result).toHaveLength(0);
    });

    it("uses custom inactiveDays threshold", async () => {
      mockPrisma.club.findMany.mockResolvedValue([]);
      await service.getInactiveClubs("tuman-1", 30);
      expect(mockPrisma.club.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ institution: { tumanId: "tuman-1" } }),
        })
      );
    });

    // ── Plan 06-02 SCH-09 — default threshold is now 30 days ────────────
    it("uses default INACTIVE_THRESHOLD_DAYS = 30 (was 45)", async () => {
      expect(INACTIVE_THRESHOLD_DAYS).toBe(30);

      const debate29d = new Date(Date.now() - 29 * 86_400_000);
      const debate31d = new Date(Date.now() - 31 * 86_400_000);

      const clubs = [
        // 29d ago — should NOT be included (within 30 day window)
        {
          id: "club-29d",
          name: "Recent",
          institution: { name: "Maktab A" },
          debates: [{ heldAt: debate29d }],
          _count: { members: 10 },
        },
        // 31d ago — should be included
        {
          id: "club-31d",
          name: "Stale",
          institution: { name: "Maktab B" },
          debates: [{ heldAt: debate31d }],
          _count: { members: 7 },
        },
      ];
      mockPrisma.club.findMany.mockResolvedValue(clubs);

      // No threshold passed — uses 30 default
      const result = await service.getInactiveClubs("tuman-1");
      const ids = result.map((c: any) => c.clubId);
      expect(ids).not.toContain("club-29d");
      expect(ids).toContain("club-31d");
    });

    it("admin tooling can pass thresholdDays=45 for back-compat reports", async () => {
      mockPrisma.club.findMany.mockResolvedValue([]);
      await service.getInactiveClubs("tuman-1", 45);
      // call succeeded — backward compat preserved
      expect(mockPrisma.club.findMany).toHaveBeenCalled();
    });
  });

  // ── Plan 06-02 SCH-06 — 20-book goal monitoring ─────────────────────────

  describe("getQuarterlyReport (SCH-06)", () => {
    beforeEach(() => {
      mockPrisma.club.findUnique.mockResolvedValue(makeClub());
      mockPrisma.clubMember.findMany.mockResolvedValue([
        makeMember({ id: "m-1", userId: "u-1" }),
        makeMember({ id: "m-2", userId: "u-2" }),
        makeMember({ id: "m-3", userId: "u-3" }),
        makeMember({ id: "m-4", userId: "u-4" }),
      ]);
      // getMembers enrichment (P2 N+1 fix) — RI va user BITTA findMany'da,
      // booksThisYear esa avvalgidek per-member count — 4 xil progress darajasi
      mockPrisma.readingIndex.findMany.mockResolvedValue([
        { userId: "u-1", score: 80 },
        { userId: "u-2", score: 50 },
        { userId: "u-3", score: 30 },
        { userId: "u-4", score: 10 },
      ]);
      mockPrisma.bookTransaction.count
        // getMembers: booksThisYear for each
        .mockResolvedValueOnce(18) // m-1: rate 0.9 → Q1
        .mockResolvedValueOnce(12) // m-2: rate 0.6 → Q2
        .mockResolvedValueOnce(8)  // m-3: rate 0.4 → Q3
        .mockResolvedValueOnce(2)  // m-4: rate 0.1 → Q4
        // getGoalProgress: quarterBooks for each
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Ali", sifatId: "SL-001", schoolClass: "9A" },
        { id: "u-2", name: "Vali", sifatId: "SL-002", schoolClass: "9B" },
        { id: "u-3", name: "Soli", sifatId: "SL-003", schoolClass: "10A" },
        { id: "u-4", name: "Doli", sifatId: "SL-004", schoolClass: "11A" },
      ]);
      mockPrisma.debate.count.mockResolvedValue(2); // published debates this quarter
      mockPrisma.debate.findFirst.mockResolvedValue({
        heldAt: new Date(Date.now() - 20 * 86_400_000),
      });
    });

    it("returns { goal: 20, members: [...rate, quartile], publishedDebates, inactive }", async () => {
      const result = await service.getQuarterlyReport("club-1");

      expect(result.goal).toBe(20);
      expect(result.publishedDebates).toBe(2);
      expect(result.inactive).toBe(false); // 20 days < 30 threshold
      expect(result.inactiveThresholdDays).toBe(30);
      expect(result.members).toHaveLength(4);

      const m1 = result.members.find((m: any) => m.name === "Ali");
      expect(m1?.booksReadThisYear).toBe(18);
      expect(m1?.rate).toBeCloseTo(0.9, 2);
      expect(m1?.quartile).toBe("Q1");

      const m2 = result.members.find((m: any) => m.name === "Vali");
      expect(m2?.quartile).toBe("Q2");

      const m3 = result.members.find((m: any) => m.name === "Soli");
      expect(m3?.quartile).toBe("Q3");

      const m4 = result.members.find((m: any) => m.name === "Doli");
      expect(m4?.quartile).toBe("Q4");
    });

    it("rate is capped at 1.0 when member overshoots goal", async () => {
      mockPrisma.bookTransaction.count.mockReset();
      mockPrisma.readingIndex.findMany.mockReset();
      mockPrisma.user.findMany.mockReset();
      mockPrisma.clubMember.findMany.mockResolvedValue([makeMember({ id: "m-1", userId: "u-1" })]);
      mockPrisma.readingIndex.findMany.mockResolvedValue([{ userId: "u-1", score: 80 }]);
      mockPrisma.bookTransaction.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(10);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u-1", name: "Ali", sifatId: "SL-001", schoolClass: "9A" },
      ]);

      const result = await service.getQuarterlyReport("club-1");
      expect(result.members[0].rate).toBeCloseTo(1.0);
      expect(result.members[0].quartile).toBe("Q1");
    });

    it("flags inactive when daysSinceDebate >= 30 (SCH-09)", async () => {
      mockPrisma.debate.findFirst.mockResolvedValue({
        heldAt: new Date(Date.now() - 31 * 86_400_000),
      });

      const result = await service.getQuarterlyReport("club-1");
      expect(result.inactive).toBe(true);
    });

    it("throws NotFoundException when club not found", async () => {
      mockPrisma.club.findUnique.mockResolvedValue(null);
      await expect(service.getQuarterlyReport("bad-id")).rejects.toThrow(NotFoundException);
    });
  });

  // ── GOAL constant ─────────────────────────────────────────────────────────
  describe("GOAL constant (SCH-06 D-Q2)", () => {
    it("is hardcoded to 20 per CLAUDE.md §VII", () => {
      expect(GOAL).toBe(20);
    });
  });
});
