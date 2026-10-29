import { NotFoundException, GoneException, BadRequestException } from "@nestjs/common";
import { ClubConsentService } from "../club-consent.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { SmsService } from "../../../../infra/sms/sms.service";
import { CacheService } from "../../../../infra/cache/cache.service";
import { RedisLockService } from "../../../../infra/cache/redis-lock.service";
import * as bcrypt from "bcrypt";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  clubMemberConsentToken: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  clubMember: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
} as any;

const mockSms = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockCache = {
  incrWithTtl: jest.fn().mockResolvedValue(1),
};

const mockLock = {
  tryAcquire: jest.fn().mockResolvedValue({ first: true }),
};

describe("ClubConsentService", () => {
  let service: ClubConsentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ClubConsentService(
      mockPrisma as unknown as PrismaService,
      mockSms as unknown as SmsService,
      mockCache as unknown as CacheService,
      mockLock as unknown as RedisLockService,
    );
  });

  // ── mintAndSend ──────────────────────────────────────────────────────────────

  describe("mintAndSend", () => {
    it("generates a 32-hex nonce, bcrypt-hashes it, persists with 48h TTL", async () => {
      mockPrisma.clubMemberConsentToken.upsert.mockResolvedValue({ id: "tok-1" });

      const result = await service.mintAndSend({
        clubMemberId: "member-1",
        parentPhone: "+998901234567",
        childName: "Ali Aliyev",
        clubName: "Jadidlar Klubi",
      });

      // 32 hex chars = 128-bit nonce
      expect(result.nonce).toMatch(/^[a-f0-9]{32}$/);

      // bcrypt hash is the persisted value — NOT the plaintext
      const upsertCall = mockPrisma.clubMemberConsentToken.upsert.mock.calls[0][0];
      expect(upsertCall.create.tokenHash).not.toBe(result.nonce);
      expect(upsertCall.create.tokenHash).toMatch(/^\$2[ab]\$/); // bcrypt prefix

      // 48h TTL
      const expectedExpiry = Date.now() + 48 * 60 * 60 * 1000;
      const actualExpiry = upsertCall.create.expiresAt.getTime();
      expect(Math.abs(actualExpiry - expectedExpiry)).toBeLessThan(5_000); // 5s slack

      // SMS body includes deep link + 48h notice — never the bcrypt hash
      const smsCall = mockSms.sendNotification.mock.calls[0];
      expect(smsCall[0]).toBe("+998901234567");
      expect(smsCall[1]).toContain("sifat.uz/uz-Latn/club/consent?t=");
      expect(smsCall[1]).toContain(result.nonce);
      expect(smsCall[1]).toContain("48");
      expect(smsCall[1]).toContain("Ali Aliyev");
      expect(smsCall[1]).toContain("Jadidlar Klubi");
    });

    it("sanitizes SMS-breaking chars (newlines, semicolons) from child + club names", async () => {
      mockPrisma.clubMemberConsentToken.upsert.mockResolvedValue({ id: "tok-1" });

      await service.mintAndSend({
        clubMemberId: "member-1",
        parentPhone: "+998901234567",
        childName: "Ali\nAliyev;injected",
        clubName: "Jadidlar\r\nKlubi",
      });

      const smsCall = mockSms.sendNotification.mock.calls[0];
      expect(smsCall[1]).not.toContain("\n");
      expect(smsCall[1]).not.toContain("\r");
      expect(smsCall[1]).not.toContain(";injected");
    });

    it("rate-limits to 3 SMS per memberId per 24h", async () => {
      mockCache.incrWithTtl.mockResolvedValueOnce(4);

      await expect(
        service.mintAndSend({
          clubMemberId: "member-1",
          parentPhone: "+998901234567",
          childName: "Ali",
          clubName: "K",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockSms.sendNotification).not.toHaveBeenCalled();
      expect(mockPrisma.clubMemberConsentToken.upsert).not.toHaveBeenCalled();
    });

    it("rate-limit key uses 24h window (86_400s)", async () => {
      mockPrisma.clubMemberConsentToken.upsert.mockResolvedValue({ id: "tok-1" });
      await service.mintAndSend({
        clubMemberId: "member-7",
        parentPhone: "+998901234567",
        childName: "Ali",
        clubName: "K",
      });
      expect(mockCache.incrWithTtl).toHaveBeenCalledWith(
        "consent-sms:member-7",
        86_400,
      );
    });
  });

  // ── confirmByToken ───────────────────────────────────────────────────────────

  describe("confirmByToken", () => {
    it("APPROVE: bcrypt.compare matches, flips ClubMember to ACTIVE in $transaction", async () => {
      const nonce = "a".repeat(32);
      const hash = await bcrypt.hash(nonce, 10);
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        {
          id: "tok-1",
          clubMemberId: "member-1",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 100_000),
          consumedAt: null,
          createdAt: new Date(),
        },
      ]);

      // $transaction(cb) runs the callback with a tx-like client
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          clubMemberConsentToken: {
            findUnique: jest.fn().mockResolvedValue({
              id: "tok-1",
              clubMemberId: "member-1",
              tokenHash: hash,
              expiresAt: new Date(Date.now() + 100_000),
              consumedAt: null,
            }),
            update: jest.fn().mockResolvedValue({}),
          },
          clubMember: {
            update: jest.fn().mockResolvedValue({ id: "member-1", clubId: "club-1" }),
          },
          aiAuditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return cb(tx);
      });

      const result = await service.confirmByToken(nonce, "APPROVE");
      expect(result).toEqual({ memberId: "member-1", status: "ACTIVE", clubId: "club-1" });
    });

    it("REJECT: flips ClubMember to LEFT + AiAuditLog issueType PARENT_CONSENT_REJECTED", async () => {
      const nonce = "b".repeat(32);
      const hash = await bcrypt.hash(nonce, 10);
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        {
          id: "tok-2",
          clubMemberId: "member-2",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 100_000),
          consumedAt: null,
          createdAt: new Date(),
        },
      ]);

      let auditIssueType: string | null = null;
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          clubMemberConsentToken: {
            findUnique: jest.fn().mockResolvedValue({
              id: "tok-2",
              clubMemberId: "member-2",
              tokenHash: hash,
              expiresAt: new Date(Date.now() + 100_000),
              consumedAt: null,
            }),
            update: jest.fn().mockResolvedValue({}),
          },
          clubMember: {
            update: jest.fn().mockResolvedValue({ id: "member-2", clubId: "club-2" }),
          },
          aiAuditLog: {
            create: jest.fn().mockImplementation((args: any) => {
              auditIssueType = args.data.issueType;
              return {};
            }),
          },
        };
        return cb(tx);
      });

      const result = await service.confirmByToken(nonce, "REJECT");
      expect(result.status).toBe("LEFT");
      expect(auditIssueType).toBe("PARENT_CONSENT_REJECTED");
    });

    it("throws 410 Gone when token already consumed (race-safe re-check inside tx)", async () => {
      const nonce = "c".repeat(32);
      const hash = await bcrypt.hash(nonce, 10);
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        {
          id: "tok-3",
          clubMemberId: "member-3",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 100_000),
          consumedAt: null,
          createdAt: new Date(),
        },
      ]);

      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          clubMemberConsentToken: {
            findUnique: jest.fn().mockResolvedValue({
              id: "tok-3",
              clubMemberId: "member-3",
              tokenHash: hash,
              expiresAt: new Date(Date.now() + 100_000),
              consumedAt: new Date(), // Already consumed!
            }),
            update: jest.fn(),
          },
          clubMember: { update: jest.fn() },
          aiAuditLog: { create: jest.fn() },
        };
        return cb(tx);
      });

      await expect(service.confirmByToken(nonce, "APPROVE")).rejects.toThrow(GoneException);
    });

    it("throws 404 NotFound when bcrypt.compare matches nothing (timing-padded)", async () => {
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([]);
      const start = Date.now();
      await expect(service.confirmByToken("d".repeat(32), "APPROVE")).rejects.toThrow(NotFoundException);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(150); // ~200ms pad
    });

    it("returns 404 (NOT 400) on malformed token — generic message defeats enumeration", async () => {
      await expect(service.confirmByToken("not-hex", "APPROVE")).rejects.toThrow(NotFoundException);
      await expect(service.confirmByToken("", "APPROVE")).rejects.toThrow(NotFoundException);
    });

    it("only scans active+unconsumed tokens (no expired in the candidate set)", async () => {
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([]);
      try {
        await service.confirmByToken("e".repeat(32), "APPROVE");
      } catch {
        // expected
      }
      const findManyCall = mockPrisma.clubMemberConsentToken.findMany.mock.calls[0][0];
      expect(findManyCall.where.consumedAt).toBeNull();
      expect(findManyCall.where.expiresAt).toEqual({ gt: expect.any(Date) });
      expect(findManyCall.take).toBe(1000);
    });
  });

  // ── peek ─────────────────────────────────────────────────────────────────────

  describe("peek", () => {
    it("returns minimum info {childName, clubName, leaderName} per D-OQ-4 (no school address)", async () => {
      const nonce = "f".repeat(32);
      const hash = await bcrypt.hash(nonce, 10);
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        {
          id: "tok-x",
          clubMemberId: "member-x",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 100_000),
          consumedAt: null,
          createdAt: new Date(),
        },
      ]);
      mockPrisma.clubMember.findUnique.mockResolvedValue({
        id: "member-x",
        userId: "user-x",
        club: { name: "Jadidlar Klubi", leaderId: "leader-x" },
      });
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ name: "Ali Aliyev" })
        .mockResolvedValueOnce({ name: "Karim Karimov" });

      const result = await service.peek(nonce);
      expect(result).toEqual({
        childName: "Ali Aliyev",
        clubName: "Jadidlar Klubi",
        leaderName: "Karim Karimov",
      });
      // Ensure NO school name / address / other PII leaked
      expect(Object.keys(result)).toEqual(["childName", "clubName", "leaderName"]);
    });

    it("does NOT consume the token (consumedAt still null after peek)", async () => {
      const nonce = "f".repeat(32);
      const hash = await bcrypt.hash(nonce, 10);
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        {
          id: "tok-x",
          clubMemberId: "member-x",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 100_000),
          consumedAt: null,
          createdAt: new Date(),
        },
      ]);
      mockPrisma.clubMember.findUnique.mockResolvedValue({
        id: "member-x",
        userId: "user-x",
        club: { name: "K", leaderId: "L" },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ name: "X" });

      await service.peek(nonce);
      expect(mockPrisma.clubMemberConsentToken.update).not.toHaveBeenCalled();
    });
  });

  // ── scanExpired cron ─────────────────────────────────────────────────────────

  describe("scanExpired (cron)", () => {
    it("skips when Redis lock not acquired (multi-replica safety)", async () => {
      mockLock.tryAcquire.mockResolvedValueOnce({ first: false });
      await service.scanExpired();
      expect(mockPrisma.clubMemberConsentToken.findMany).not.toHaveBeenCalled();
    });

    it("acquires leader lock with key lock:club-consent-expiry-scan and 10min TTL", async () => {
      mockLock.tryAcquire.mockResolvedValueOnce({ first: true });
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([]);
      await service.scanExpired();
      const lockCall = mockLock.tryAcquire.mock.calls[0];
      expect(lockCall[0]).toBe("lock:club-consent-expiry-scan");
      expect(lockCall[1]).toBe(600);
    });

    it("flips each expired token's ClubMember to LEFT + writes audit log PARENT_CONSENT_EXPIRED", async () => {
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        { id: "t1", clubMemberId: "m1" },
        { id: "t2", clubMemberId: "m2" },
      ]);
      mockPrisma.$transaction.mockResolvedValue([{}, {}, {}]);
      await service._scanExpiredImpl();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("scanExpired graceful — single failing row doesn't kill the batch", async () => {
      mockPrisma.clubMemberConsentToken.findMany.mockResolvedValue([
        { id: "t1", clubMemberId: "m1" },
        { id: "t2", clubMemberId: "m2" },
      ]);
      mockPrisma.$transaction
        .mockRejectedValueOnce(new Error("rare race"))
        .mockResolvedValueOnce([{}, {}, {}]);
      await expect(service._scanExpiredImpl()).resolves.toBeUndefined();
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });
  });
});
