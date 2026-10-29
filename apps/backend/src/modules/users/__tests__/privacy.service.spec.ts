// ============================================================================
// Privacy Service Tests — PERF-06
// ============================================================================

import { NotFoundException } from "@nestjs/common";
import { PrivacyService } from "../privacy.service";

// ── Mock PrismaService ──────────────────────────────────────────────────────

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PrivacyService", () => {
  let service: PrivacyService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new PrivacyService(prisma as any);
  });

  describe("toggleReadingHistoryVisibility", () => {
    test("calls prisma.user.update with hideReadingHistory: true", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      prisma.user.update.mockResolvedValue({
        id: "user-1",
        hideReadingHistory: true,
      });

      const result = await service.toggleReadingHistoryVisibility(
        "user-1",
        true,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { hideReadingHistory: true },
        select: { id: true, hideReadingHistory: true },
      });
      expect(result).toEqual({ hideReadingHistory: true });
    });

    test("calls prisma.user.update with hideReadingHistory: false", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1" });
      prisma.user.update.mockResolvedValue({
        id: "user-1",
        hideReadingHistory: false,
      });

      const result = await service.toggleReadingHistoryVisibility(
        "user-1",
        false,
      );

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { hideReadingHistory: false },
        select: { id: true, hideReadingHistory: true },
      });
      expect(result).toEqual({ hideReadingHistory: false });
    });
  });

  describe("getPrivacySettings", () => {
    test("returns { hideReadingHistory: boolean }", async () => {
      prisma.user.findUnique.mockResolvedValue({
        hideReadingHistory: true,
      });

      const result = await service.getPrivacySettings("user-1");

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-1" },
        select: { hideReadingHistory: true },
      });
      expect(result).toEqual({ hideReadingHistory: true });
    });

    test("throws NotFoundException when user not found", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.getPrivacySettings("nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("filterReadingHistoryForPublic", () => {
    test("strips bookTransactions and readingIndex when hideReadingHistory is true", () => {
      const data = {
        id: "user-1",
        name: "Test User",
        bookTransactions: [{ id: "tx-1" }],
        transactions: [{ id: "tx-2" }],
        readingIndex: [{ score: 75 }],
        status: "ACTIVE",
      };

      const result = service.filterReadingHistoryForPublic(true, data);

      expect(result).not.toHaveProperty("bookTransactions");
      expect(result).not.toHaveProperty("transactions");
      expect(result).not.toHaveProperty("readingIndex");
      expect(result).toHaveProperty("name", "Test User");
      expect(result).toHaveProperty("status", "ACTIVE");
    });

    test("returns data unchanged when hideReadingHistory is false", () => {
      const data = {
        id: "user-1",
        name: "Test User",
        bookTransactions: [{ id: "tx-1" }],
        readingIndex: [{ score: 75 }],
      };

      const result = service.filterReadingHistoryForPublic(false, data);

      expect(result).toEqual(data);
    });
  });
});
