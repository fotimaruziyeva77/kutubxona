/**
 * I7 — getFamily har bir a'zo uchun `joinedFamilyAt` (FamilyMembership.joinedAt,
 * ISO) qaytaradi. FamilyMembership yozuvi bo'lmagan eski a'zolar uchun null —
 * frontend "Invalid Date" / "NaN kun" ko'rsatmasligi uchun.
 */
import { FamilyService } from "../family.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { SmsService } from "../../../infra/sms/sms.service";
import { CacheService } from "../../../infra/cache/cache.service";

const mockPrisma = { family: { findUnique: jest.fn() } };

const makeService = () =>
  new FamilyService(
    mockPrisma as unknown as PrismaService,
    {} as SmsService,
    {} as CacheService,
    {} as never,
  );

const member = (id: string) => ({
  id, name: `A'zo ${id}`, sifatId: `SL-${id}`, type: "CITIZEN",
  status: "ACTIVE", createdAt: new Date("2026-01-01T00:00:00Z"), readingIndex: [],
});

describe("FamilyService.getFamily — joinedFamilyAt (I7)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a'zolik sanasini FamilyMembership.joinedAt dan ISO ko'rinishida qaytaradi", async () => {
    const joined = new Date("2026-09-10T08:00:00.000Z");
    mockPrisma.family.findUnique.mockResolvedValue({
      id: "fam-1", name: "Oila",
      members: [member("u1"), member("u2")],
      memberships: [{ userId: "u1", joinedAt: joined }],
    });

    const result = await makeService().getFamily("fam-1", { id: "u1", role: "KITOBXON" });

    const u1 = result.members.find((m) => m.id === "u1");
    const u2 = result.members.find((m) => m.id === "u2");
    expect(u1?.joinedFamilyAt).toBe("2026-09-10T08:00:00.000Z");
    // FamilyMembership yo'q — null (sana uydirilmaydi)
    expect(u2?.joinedFamilyAt).toBeNull();
    // Ichki memberships ro'yxati javobga chiqmaydi
    expect((result as Record<string, unknown>).memberships).toBeUndefined();
  });

  it("faqat faol (leftAt=null) a'zoliklar so'raladi", async () => {
    mockPrisma.family.findUnique.mockResolvedValue({
      id: "fam-1", name: "Oila", members: [member("u1")], memberships: [],
    });

    await makeService().getFamily("fam-1", { id: "u1", role: "KITOBXON" });

    const args = mockPrisma.family.findUnique.mock.calls[0][0];
    expect(args.include.memberships.where).toEqual({ leftAt: null });
  });
});
