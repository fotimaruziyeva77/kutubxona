import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { FamilyService } from "../family.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

const mockAddress = {
  id:        "addr-1",
  viloyatId: "v1",
  tumanId:   "t1",
  mahallaId: "m1",
  house:     "12",
  apartment: "3",
  street:    "Mustaqillik",
};

const mockUser = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id:       "u1",
  name:     "Ali Valiyev",
  phone:    "+998901234567",
  familyId: null,
  address:  mockAddress,
  addressId: "addr-1",
  // Plan 06-03 FAM-01 — opt-IN flag. Default ON in test fixture so existing
  // detect specs keep their old semantics; the new FAM-01 spec overrides
  // this to false to exercise the gate.
  familyDetectionEnabled: true,
  ...overrides,
});

const mockFamily = {
  id:        "fam-1",
  name:      "Ali Valiyev oilasi",
  addressId: "addr-1",
  viloyatId: "v1",
  tumanId:   "t1",
  mahallaId: "m1",
  members:   [{ id: "u1" }],
  createdAt: new Date(),
};

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    update:     jest.fn(),
    count:      jest.fn(),
  },
  family: {
    create:     jest.fn(),
    findUnique: jest.fn(),
    findMany:   jest.fn(),
    update:     jest.fn(),
    delete:     jest.fn(),
  },
  familyInvite: {
    findFirst:  jest.fn(),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  familyRating: {
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    upsert:     jest.fn(),
  },
  familyMembership: {
    create: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  readingIndex: {
    findFirst: jest.fn(),
  },
  bookTransaction: {
    count: jest.fn(),
  },
  // Plan 06-03 FAM-01 — opt-IN toggle writes an audit row in the same tx.
  aiAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

// Plan 06-01 FAM-03 — replica routing. Tests assert reads land here.
// P2 N+1 fix — _computeSingleFamilyRating endi per-member findFirst o'rniga
// bitta findMany (batch) ishlatadi.
const mockReplica = {
  user: { findMany: jest.fn() },
  family: { findMany: jest.fn(), findUnique: jest.fn() },
  readingIndex: { findFirst: jest.fn(), findMany: jest.fn() },
  bookTransaction: { count: jest.fn() },
};

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockCache = {
  remember: jest.fn().mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn()),
  del:      jest.fn().mockResolvedValue(undefined),
};

const makeService = () =>
  new FamilyService(
    mockPrisma as unknown as PrismaService,
    mockSms as unknown as SmsService,
    mockCache as unknown as CacheService,
    mockReplica as any,
  );

describe("FamilyService", () => {
  let service: FamilyService;

  beforeEach(() => {
    service = makeService();
    jest.clearAllMocks();
  });

  // ── createFamily ───────────────────────────────────────────────────────────
  describe("createFamily", () => {
    it("oila muvaffaqiyatli yaratiladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser());
      mockPrisma.family.create.mockResolvedValue(mockFamily);

      const result = await service.createFamily("u1");

      expect(mockPrisma.family.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ viloyatId: "v1" }),
        })
      );
      expect(result.id).toBe("fam-1");
    });

    it("oila nomi berilsa o'sha nom ishlatiladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser());
      mockPrisma.family.create.mockResolvedValue({ ...mockFamily, name: "Maxsus nom" });

      const result = await service.createFamily("u1", "Maxsus nom");
      expect(result.name).toBe("Maxsus nom");
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.createFamily("notfound")).rejects.toThrow(NotFoundException);
    });

    it("allaqachon oila a'zosi bo'lsa BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser({ familyId: "existing-fam" }));
      await expect(service.createFamily("u1")).rejects.toThrow(BadRequestException);
    });

    it("manzil yo'q bo'lsa BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser({ address: null, addressId: null }));
      await expect(service.createFamily("u1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── getFamily ──────────────────────────────────────────────────────────────
  // IDOR-H14 — getFamily now requires a viewer: only family MEMBERS or
  // admin-tier roles may read it, and under-14 names are masked.
  const memberViewer = { id: "u1", role: "KITOBXON" };
  const adminViewer = { id: "admin-1", role: "SUPER_ADMIN" };

  describe("getFamily", () => {
    it("oila va a'zolar bilan qaytaradi (a'zo so'raganda)", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({
        ...mockFamily,
        members: [
          {
            id: "u1", name: "Ali", sifatId: "SL-01", type: "CITIZEN",
            status: "ACTIVE", createdAt: new Date(),
            readingIndex: [{ score: 75, calculatedAt: new Date() }]
          }
        ],
      });

      const result = await service.getFamily("fam-1", memberViewer);

      expect(result.id).toBe("fam-1");
      expect(result.members).toHaveLength(1);
      expect(result.avgRi).toBe(75);
    });

    it("bo'sh oilada avgRi = 0 (admin so'raganda)", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({ ...mockFamily, members: [] });

      const result = await service.getFamily("fam-1", adminViewer);
      expect(result.avgRi).toBe(0);
    });

    it("RI yo'q a'zolarda avgRi = 0", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({
        ...mockFamily,
        members: [{
          id: "u1", name: "Ali", sifatId: "SL-01", type: "CITIZEN",
          status: "ACTIVE", createdAt: new Date(), readingIndex: []
        }],
      });

      const result = await service.getFamily("fam-1", memberViewer);
      expect(result.avgRi).toBe(0);
    });

    it("topilmasa NotFoundException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(null);
      await expect(service.getFamily("notfound", memberViewer)).rejects.toThrow(NotFoundException);
    });

    // ── IDOR-H14 (a): a'zo bo'lmagan KITOBXON → 403 ─────────────────────────
    it("a'zo bo'lmagan oddiy foydalanuvchi — ForbiddenException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({
        ...mockFamily,
        members: [{
          id: "u1", name: "Ali Valiyev", sifatId: "SL-01", type: "CITIZEN",
          status: "ACTIVE", createdAt: new Date(), readingIndex: []
        }],
      });

      await expect(
        service.getFamily("fam-1", { id: "stranger-99", role: "KITOBXON" })
      ).rejects.toThrow(ForbiddenException);
    });

    it("admin-tier (TUMAN_ADMIN) a'zo bo'lmasa ham ko'ra oladi", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({
        ...mockFamily,
        members: [{
          id: "u1", name: "Ali Valiyev", sifatId: "SL-01", type: "CITIZEN",
          status: "ACTIVE", createdAt: new Date(), readingIndex: []
        }],
      });

      const result = await service.getFamily("fam-1", { id: "tadmin-1", role: "TUMAN_ADMIN" });
      expect(result.id).toBe("fam-1");
    });

    // ── IDOR-H14 (b): 14 yoshgacha ismlar maskalanadi (a'zolar uchun ham) ───
    it("14 yoshgacha a'zo ismi maskalanadi, dob javobda qaytmaydi", async () => {
      const today = new Date();
      const dob12 = new Date(today.getFullYear() - 12, today.getMonth(), today.getDate());
      const dob30 = new Date(today.getFullYear() - 30, today.getMonth(), today.getDate());

      mockPrisma.family.findUnique.mockResolvedValue({
        ...mockFamily,
        members: [
          {
            id: "u1", name: "Ali Valiyev", dob: dob30, sifatId: "SL-01",
            type: "CITIZEN", status: "ACTIVE", createdAt: new Date(),
            readingIndex: [{ score: 78, calculatedAt: new Date() }]
          },
          {
            id: "u2", name: "Karim Valiyev", dob: dob12, sifatId: "SL-02",
            type: "STUDENT_SCHOOL", status: "ACTIVE", createdAt: new Date(),
            readingIndex: [{ score: 65, calculatedAt: new Date() }]
          }
        ],
      });

      const result = await service.getFamily("fam-1", memberViewer);

      const adult = result.members.find((m: { id: string }) => m.id === "u1") as { name: string; dob?: unknown };
      const minor = result.members.find((m: { id: string }) => m.id === "u2") as { name: string; dob?: unknown };
      expect(adult.name).toBe("Ali Valiyev");
      expect(minor.name).toBe("K.V.");
      // Raw dob is stripped from the response payload.
      expect(adult.dob).toBeUndefined();
      expect(minor.dob).toBeUndefined();
    });
  });

  // ── detectAndSuggestFamily ─────────────────────────────────────────────────
  describe("detectAndSuggestFamily", () => {
    it("bir xonadon foydalanuvchilari topilsa taklif qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser());
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u2", name: "Oydin Valiyeva", sifatId: "SL-02" }
      ]);

      const result = await service.detectAndSuggestFamily("u1");

      expect(result).not.toBeNull();
      expect(result!.suggestion).toBe(true);
      expect(result!.sameHouseholdUsers).toHaveLength(1);
    });

    it("bir xonadon foydalanuvchi yo'q bo'lsa null", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser());
      mockPrisma.user.findMany.mockResolvedValue([]);

      const result = await service.detectAndSuggestFamily("u1");
      expect(result).toBeNull();
    });

    it("manzil yo'q bo'lsa null", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser({ address: null }));

      const result = await service.detectAndSuggestFamily("u1");
      expect(result).toBeNull();
    });

    it("foydalanuvchi topilmasa null", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.detectAndSuggestFamily("u1");
      expect(result).toBeNull();
    });

    // ── Plan 06-03 FAM-01 — opt-IN gate ──────────────────────────────────
    it("FAM-01 opt-IN: returns null when caller has familyDetectionEnabled=false (default)", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        mockUser({ familyDetectionEnabled: false }),
      );
      // Even though same-household users may exist, the gate fires BEFORE
      // the query lands. Assert findMany never ran.
      const result = await service.detectAndSuggestFamily("u1");
      expect(result).toBeNull();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it("FAM-01 candidate WHERE includes familyDetectionEnabled=true + street + house + apartment", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        mockUser({ familyDetectionEnabled: true }),
      );
      mockPrisma.user.findMany.mockResolvedValue([
        { id: "u2", name: "Oydin", sifatId: "SL-02" },
      ]);
      await service.detectAndSuggestFamily("u1");
      const args = mockPrisma.user.findMany.mock.calls[0][0];
      expect(args.where.familyDetectionEnabled).toBe(true);
      expect(args.where.address.street).toBe("Mustaqillik");
      expect(args.where.address.house).toBe("12");
      expect(args.where.address.apartment).toBe("3");
      // Take cap at SUGGESTION_LIMIT=10
      expect(args.take).toBe(10);
    });
  });

  // ── Plan 06-03 FAM-01 — setFamilyDetectionEnabled toggle ────────────────
  describe("setFamilyDetectionEnabled", () => {
    it("flips OFF → ON + writes AiAuditLog{FAMILY_DETECTION_TOGGLED, analysis:'enabled'}", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        familyDetectionEnabled: false,
      });
      const txUser = { update: jest.fn() };
      const txAudit = { create: jest.fn() };
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({ user: txUser, aiAuditLog: txAudit }),
      );

      const result = await service.setFamilyDetectionEnabled("u1", true);

      expect(txUser.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { familyDetectionEnabled: true },
      });
      expect(txAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scope: "USER",
          scopeId: "u1",
          issueType: "FAMILY_DETECTION_TOGGLED",
          severity: "LOW",
          analysis: "enabled",
        }),
      });
      expect(result.familyDetectionEnabled).toBe(true);
      expect(result.changed).toBe(true);
    });

    it("flips ON → OFF + analysis:'disabled'", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        familyDetectionEnabled: true,
      });
      const txUser = { update: jest.fn() };
      const txAudit = { create: jest.fn() };
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({ user: txUser, aiAuditLog: txAudit }),
      );

      await service.setFamilyDetectionEnabled("u1", false);

      expect(txAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          analysis: "disabled",
        }),
      });
    });

    it("no-op when already in requested state — no tx, no audit row", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "u1",
        familyDetectionEnabled: true,
      });
      const result = await service.setFamilyDetectionEnabled("u1", true);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(result.changed).toBe(false);
    });

    it("user not found — NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.setFamilyDetectionEnabled("u1", true),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Plan 06-03 FAM-05 — getPublicFamilyProfile + maskNameIfMinor ────────
  describe("getPublicFamilyProfile", () => {
    it("masks under-14 member names via A.K. pattern + escapes family name", async () => {
      const today = new Date();
      const dob12 = new Date(
        today.getFullYear() - 12,
        today.getMonth(),
        today.getDate(),
      );
      const dob30 = new Date(
        today.getFullYear() - 30,
        today.getMonth(),
        today.getDate(),
      );

      mockReplica.family.findUnique.mockResolvedValue({
        id: "fam-1",
        name: 'Valiyev "oilasi"',
        viloyatId: "v1",
        tumanId: "t1",
        memberships: [
          { userId: "u1", joinedAt: new Date() },
          { userId: "u2", joinedAt: new Date() },
        ],
      });
      mockReplica.user.findMany.mockResolvedValue([
        {
          id: "u1",
          name: "Ali Valiyev",
          dob: dob30,
          readingIndex: [{ score: 78 }],
        },
        {
          id: "u2",
          name: "Karim Valiyev",
          dob: dob12,
          readingIndex: [{ score: 65 }],
        },
      ]);

      const result = await service.getPublicFamilyProfile("fam-1");

      // Family name HTML-escaped (defense-in-depth).
      expect(result.family.name).not.toContain('"');
      expect(result.family.name).toMatch(/&quot;|&#34;/);
      // Adult name preserved.
      const adult = result.members.find((m) => m.id === "u1");
      expect(adult?.name).toBe("Ali Valiyev");
      expect(adult?.isMinor).toBe(false);
      // Minor name masked to initials.
      const minor = result.members.find((m) => m.id === "u2");
      expect(minor?.name).toBe("K.V.");
      expect(minor?.isMinor).toBe(true);
    });

    it("topilmasa NotFoundException", async () => {
      mockReplica.family.findUnique.mockResolvedValue(null);
      await expect(
        service.getPublicFamilyProfile("notfound"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Plan 06-03 FAM-04 — _computeSingleFamilyRating routes on REPLICA ────
  describe("FAM-04 replica routing", () => {
    it("prisma.user.findMany is NEVER called from family RI compute path", async () => {
      mockReplica.family.findMany.mockResolvedValue([
        { id: "fam-1", memberships: [{ userId: "u1" }] },
      ]);
      mockReplica.readingIndex.findMany.mockResolvedValue([{ userId: "u1", score: 80 }]);
      mockReplica.bookTransaction.count.mockResolvedValue(2);
      mockPrisma.familyRating.upsert.mockResolvedValue({});

      await service.computeFamilyRatings("2026-05");

      // Spy on the primary client — no .user.findMany call should have
      // landed there during RI compute (replica owns the read path).
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      // P2 N+1 fix — RI o'qishlari replica'da BATCH findMany orqali.
      expect(mockReplica.readingIndex.findMany).toHaveBeenCalled();
      expect(mockReplica.readingIndex.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── inviteMember ───────────────────────────────────────────────────────────
  describe("inviteMember", () => {
    it("muvaffaqiyatli taklif yuboradi", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(mockFamily);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "u2", name: "Oydin", phone: "+998901234568", familyId: null })
        .mockResolvedValueOnce({ name: "Ali" }); // inviter
      mockPrisma.familyInvite.findFirst.mockResolvedValue(null);
      mockPrisma.familyInvite.create.mockResolvedValue({ id: "inv-1" });

      const result = await service.inviteMember("fam-1", "u1", "u2");

      expect(mockPrisma.familyInvite.create).toHaveBeenCalled();
      expect(mockSms.sendNotification).toHaveBeenCalled();
      expect(result.id).toBe("inv-1");
    });

    it("taklif qilinuvchida telefon yo'q — SMS yuborilmaydi", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(mockFamily);
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "u2", name: "Oydin", phone: null, familyId: null })
        .mockResolvedValueOnce({ name: "Ali" });
      mockPrisma.familyInvite.findFirst.mockResolvedValue(null);
      mockPrisma.familyInvite.create.mockResolvedValue({ id: "inv-1" });

      await service.inviteMember("fam-1", "u1", "u2");

      expect(mockSms.sendNotification).not.toHaveBeenCalled();
    });

    it("oila topilmasa NotFoundException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(null);
      await expect(service.inviteMember("notfound", "u1", "u2")).rejects.toThrow(NotFoundException);
    });

    it("oila a'zosi bo'lmasa ForbiddenException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue({ ...mockFamily, members: [{ id: "other-user" }] });
      await expect(service.inviteMember("fam-1", "u1", "u2")).rejects.toThrow(ForbiddenException);
    });

    it("taklif qilinuvchi topilmasa NotFoundException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(mockFamily);
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.inviteMember("fam-1", "u1", "u2")).rejects.toThrow(NotFoundException);
    });

    it("taklif qilinuvchi allaqachon oilada — BadRequestException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(mockFamily);
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", familyId: "other-fam" });
      await expect(service.inviteMember("fam-1", "u1", "u2")).rejects.toThrow(BadRequestException);
    });

    it("aktiv taklif mavjud — BadRequestException", async () => {
      mockPrisma.family.findUnique.mockResolvedValue(mockFamily);
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", familyId: null, phone: "..." });
      mockPrisma.familyInvite.findFirst.mockResolvedValue({ id: "existing-invite" });
      await expect(service.inviteMember("fam-1", "u1", "u2")).rejects.toThrow("Allaqachon aktiv taklif");
    });
  });

  // ── respondToInvite ────────────────────────────────────────────────────────
  describe("respondToInvite", () => {
    const pendingInvite = {
      id: "inv-1",
      familyId: "fam-1",
      inviteeId: "u2",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 48 * 3_600_000), // faol
    };

    it("taklifni rad etadi", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue(pendingInvite);
      mockPrisma.familyInvite.update.mockResolvedValue({ ...pendingInvite, status: "REJECTED" });

      const result = await service.respondToInvite("inv-1", "u2", false);

      expect(mockPrisma.familyInvite.update).toHaveBeenCalledWith({
        where: { id: "inv-1" }, data: { status: "REJECTED" }
      });
      expect(result.accepted).toBe(false);
    });

    it("taklifni qabul qiladi — oilaga qo'shiladi (tx + FamilyMembership)", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue(pendingInvite);
      mockPrisma.family.findUnique.mockResolvedValue({
        id: "fam-1", _count: { members: 3 }
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", familyId: null });

      // Plan 06-01 FAM-06 — interactive $transaction; mock the tx client.
      const txUser = {
        findUnique: jest.fn().mockResolvedValue({ familyId: null }),
        update: jest.fn().mockResolvedValue({}),
      };
      const txFamilyInvite = { update: jest.fn().mockResolvedValue({}) };
      const txFamilyMembership = { create: jest.fn().mockResolvedValue({}) };
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          user: txUser,
          familyInvite: txFamilyInvite,
          familyMembership: txFamilyMembership,
        }),
      );

      const result = await service.respondToInvite("inv-1", "u2", true);

      expect(mockPrisma.$transaction).toHaveBeenCalled();
      // Re-check fired inside tx
      expect(txUser.findUnique).toHaveBeenCalledWith({
        where: { id: "u2" },
        select: { familyId: true },
      });
      // Three writes inside the same tx
      expect(txFamilyInvite.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: "ACCEPTED" },
      });
      expect(txUser.update).toHaveBeenCalledWith({
        where: { id: "u2" },
        data: { familyId: "fam-1" },
      });
      expect(txFamilyMembership.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "u2",
          familyId: "fam-1",
          joinedAt: expect.any(Date),
        }),
      });
      expect(result.accepted).toBe(true);
      expect(result.familyId).toBe("fam-1");
    });

    it("FAM-06 TOCTOU: rolls back when re-check inside tx finds user already joined", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue(pendingInvite);
      mockPrisma.family.findUnique.mockResolvedValue({
        id: "fam-1", _count: { members: 3 }
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", familyId: null });

      // Concurrent accept already set familyId between the outer check and
      // the inner re-check.
      const txUser = {
        findUnique: jest.fn().mockResolvedValue({ familyId: "fam-other" }),
        update: jest.fn(),
      };
      const txFamilyInvite = { update: jest.fn() };
      const txFamilyMembership = { create: jest.fn() };
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          user: txUser,
          familyInvite: txFamilyInvite,
          familyMembership: txFamilyMembership,
        }),
      );

      await expect(service.respondToInvite("inv-1", "u2", true)).rejects.toThrow(
        BadRequestException,
      );
      // Writes never executed
      expect(txFamilyInvite.update).not.toHaveBeenCalled();
      expect(txUser.update).not.toHaveBeenCalled();
      expect(txFamilyMembership.create).not.toHaveBeenCalled();
    });

    it("taklif topilmasa NotFoundException", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue(null);
      await expect(service.respondToInvite("notfound", "u2", true)).rejects.toThrow(NotFoundException);
    });

    it("boshqa foydalanuvchi taklifi — ForbiddenException", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue({ ...pendingInvite, inviteeId: "u3" });
      await expect(service.respondToInvite("inv-1", "u2", true)).rejects.toThrow(ForbiddenException);
    });

    it("allaqachon javob berilgan — BadRequestException", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue({ ...pendingInvite, status: "ACCEPTED" });
      await expect(service.respondToInvite("inv-1", "u2", true)).rejects.toThrow(BadRequestException);
    });

    it("muddati o'tgan taklif — BadRequestException", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue({
        ...pendingInvite,
        expiresAt: new Date(Date.now() - 1000) // o'tgan
      });
      mockPrisma.familyInvite.update.mockResolvedValue({});

      await expect(service.respondToInvite("inv-1", "u2", true)).rejects.toThrow(BadRequestException);
    });

    it("oila to'liq (10 a'zo) — BadRequestException", async () => {
      mockPrisma.familyInvite.findUnique.mockResolvedValue(pendingInvite);
      mockPrisma.family.findUnique.mockResolvedValue({
        id: "fam-1", _count: { members: 10 }
      });

      await expect(service.respondToInvite("inv-1", "u2", true)).rejects.toThrow(BadRequestException);
    });
  });

  // ── leaveFamily ────────────────────────────────────────────────────────────
  describe("leaveFamily", () => {
    it("oiladan chiqadi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ familyId: "fam-1" });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.user.count.mockResolvedValue(2); // oilada boshqa a'zolar bor

      const result = await service.leaveFamily("u1");

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" }, data: { familyId: null }
      });
      expect(result.left).toBe(true);
      expect(mockPrisma.family.delete).not.toHaveBeenCalled();
    });

    it("oxirgi a'zo chiqsa oila o'chiriladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ familyId: "fam-1" });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.user.count.mockResolvedValue(0); // boshqa a'zo yo'q
      mockPrisma.family.delete.mockResolvedValue({});

      await service.leaveFamily("u1");

      expect(mockPrisma.family.delete).toHaveBeenCalledWith({ where: { id: "fam-1" } });
    });

    it("oilada emas — BadRequestException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ familyId: null });
      await expect(service.leaveFamily("u1")).rejects.toThrow(BadRequestException);
    });
  });

  // ── getFamilyRatings ───────────────────────────────────────────────────────
  describe("getFamilyRatings", () => {
    it("reyting ro'yhatini qaytaradi", async () => {
      mockPrisma.familyRating.findMany.mockResolvedValue([
        { id: "r1", familyId: "fam-1", avgScore: 85, rank: 1 },
        { id: "r2", familyId: "fam-2", avgScore: 72, rank: 2 },
      ]);
      mockPrisma.family.findMany.mockResolvedValue([
        { id: "fam-1", name: "Valiyev oilasi", viloyatId: "v1", tumanId: "t1" },
        { id: "fam-2", name: "Karimov oilasi", viloyatId: "v1", tumanId: "t1" },
      ]);

      const result = await service.getFamilyRatings({ tumanId: "t1" });

      expect(result).toHaveLength(2);
      expect(result[0].rank).toBe(1);
      // Plan 06-03 FAM-05 — public list returns escaped familyName.
      expect(result[0].familyName).toBe("Valiyev oilasi");
    });

    it("rank null bo'lsa index bilan to'ldiriladi", async () => {
      mockPrisma.familyRating.findMany.mockResolvedValue([
        { id: "r1", familyId: "fam-1", avgScore: 85, rank: null },
        { id: "r2", familyId: "fam-2", avgScore: 72, rank: null },
      ]);
      mockPrisma.family.findMany.mockResolvedValue([
        { id: "fam-1", name: "A", viloyatId: "v1", tumanId: "t1" },
        { id: "fam-2", name: "B", viloyatId: "v1", tumanId: "t1" },
      ]);

      const result = await service.getFamilyRatings({});

      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
    });

    it("FAM-05 — escapes family.name (defense-in-depth XSS)", async () => {
      mockPrisma.familyRating.findMany.mockResolvedValue([
        { id: "r1", familyId: "fam-1", avgScore: 90, rank: 1 },
      ]);
      mockPrisma.family.findMany.mockResolvedValue([
        {
          id: "fam-1",
          name: "<script>alert(1)</script>",
          viloyatId: "v1", tumanId: "t1",
        },
      ]);
      const result = await service.getFamilyRatings({});
      expect(result[0].familyName).not.toContain("<script>");
      expect(result[0].familyName).toMatch(/&lt;script&gt;/);
    });
  });

  // ── getFamilyRating ────────────────────────────────────────────────────────
  describe("getFamilyRating", () => {
    it("oila reytingini qaytaradi", async () => {
      const rating = { familyId: "fam-1", month: "2026-05", avgScore: 80 };
      mockPrisma.familyRating.findUnique.mockResolvedValue(rating);

      const result = await service.getFamilyRating("fam-1", "2026-05");

      expect(result).toEqual(rating);
    });

    it("reyting yo'q bo'lsa null", async () => {
      mockPrisma.familyRating.findUnique.mockResolvedValue(null);
      const result = await service.getFamilyRating("fam-1");
      expect(result).toBeNull();
    });
  });

  // ── computeFamilyRatings ───────────────────────────────────────────────────
  describe("computeFamilyRatings", () => {
    it("oilalar uchun reyting hisoblaydi (replica reads + FamilyMembership joinedAt filter)", async () => {
      const families = [
        {
          id: "fam-1",
          memberships: [{ userId: "u1" }, { userId: "u2" }],
        },
      ];
      mockReplica.family.findMany.mockResolvedValue(families);
      // P2 N+1 fix — bitta batch findMany (calculatedAt DESC), per-member emas.
      mockReplica.readingIndex.findMany.mockResolvedValue([
        { userId: "u1", score: 72 },
        { userId: "u2", score: 72 },
      ]);
      mockReplica.bookTransaction.count.mockResolvedValue(5);
      mockPrisma.familyRating.upsert.mockResolvedValue({});

      const result = await service.computeFamilyRatings("2026-05");

      expect(result.total).toBe(1);
      expect(result.computed).toBe(1);
      // Plan 06-01 FAM-03 — reads land on replica.
      expect(mockReplica.family.findMany).toHaveBeenCalled();
      expect(mockReplica.readingIndex.findMany).toHaveBeenCalledTimes(1);
      expect(mockReplica.readingIndex.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: { in: ["u1", "u2"] } }),
          orderBy: { calculatedAt: "desc" },
        }),
      );
      // Plan 06-01 FAM-03 — filter uses memberships.joinedAt, NOT members.createdAt.
      const familyCall = mockReplica.family.findMany.mock.calls[0][0];
      expect(JSON.stringify(familyCall)).toMatch(/joinedAt/);
      expect(JSON.stringify(familyCall)).not.toMatch(/"createdAt":\s*{\s*"lte"/);
      // Write path still on primary — avgScore (72+72)/2 = 72 saqlanadi.
      expect(mockPrisma.familyRating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ avgScore: 72, memberCount: 2 }),
        }),
      );
    });

    // P2 N+1 fix — natija AYNAN avvalgidek: eng so'nggi RI olinadi (DESC
    // tartibda birinchi qator), RI'si yo'q a'zo 0 ball bilan hisoblanadi.
    it("eng so'nggi RI per-user tanlanadi, RI'siz a'zo 0 hisoblanadi", async () => {
      mockReplica.family.findMany.mockResolvedValue([
        { id: "fam-1", memberships: [{ userId: "u1" }, { userId: "u2" }] },
      ]);
      // u1: ikkita snapshot (80 yangi, 20 eski) → 80 olinadi; u2: RI yo'q → 0.
      mockReplica.readingIndex.findMany.mockResolvedValue([
        { userId: "u1", score: 80 },
        { userId: "u1", score: 20 },
      ]);
      mockReplica.bookTransaction.count.mockResolvedValue(1);
      mockPrisma.familyRating.upsert.mockResolvedValue({});

      await service.computeFamilyRatings("2026-05");

      // (80 + 0) / 2 = 40
      expect(mockPrisma.familyRating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ avgScore: 40, memberCount: 2 }),
        }),
      );
    });

    it("a'zosiz oila o'tkaziladi", async () => {
      mockReplica.family.findMany.mockResolvedValue([
        { id: "fam-1", memberships: [] },
      ]);

      const result = await service.computeFamilyRatings("2026-05");

      expect(result.computed).toBe(0);
    });

    it("hisoblash xatosi bo'lsa boshqa oilalar davom etadi", async () => {
      mockReplica.family.findMany.mockResolvedValue([
        { id: "fam-1", memberships: [{ userId: "u1" }] },
        { id: "fam-2", memberships: [{ userId: "u2" }] },
      ]);
      mockReplica.readingIndex.findMany.mockResolvedValue([
        { userId: "u1", score: 60 },
        { userId: "u2", score: 60 },
      ]);
      mockReplica.bookTransaction.count.mockResolvedValue(3);
      mockPrisma.familyRating.upsert
        .mockRejectedValueOnce(new Error("DB xato"))
        .mockResolvedValueOnce({});

      const result = await service.computeFamilyRatings("2026-05");

      expect(result.computed).toBe(1); // bitta xato, bitta muvaffaqiyatli
    });
  });
});
