import {
  BadRequestException,
  ConflictException,
  GoneException,
  ForbiddenException,
} from "@nestjs/common";
import { ReadingHourService } from "../reading-hour.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { CacheService } from "../../../../infra/cache/cache.service";

/**
 * Plan 06-06 ORG-03 specs — focus on:
 *   - HMAC token rotation (current + previous window grace)
 *   - timingSafeEqual usage
 *   - attendance dupe → 409
 *   - tolerance window ±2h
 *   - DRAFT/PUBLISHED/CANCELLED state machine
 *   - monthly summary excludes DRAFT
 */

const makeInstitution = (overrides: object = {}) => ({
  id: "inst-1",
  type: "IDORA",
  tumanId: "tuman-1",
  viloyatId: "viloyat-1",
  ...overrides,
});

const superAdmin = {
  role: "SUPER_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: null,
  address: { viloyatId: null, tumanId: null },
};

const muassasaAdmin = {
  role: "MUASSASA_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: "inst-1",
  address: { viloyatId: null, tumanId: null },
};

const outsideAdmin = {
  role: "MUASSASA_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: "inst-OTHER",
  address: { viloyatId: null, tumanId: null },
};

const mockPrisma: any = {
  institution: {
    findUnique: jest.fn(),
  },
  subscription: {
    findFirst: jest.fn().mockResolvedValue(null),
  },
  readingHour: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  readingHourMedia: {
    count: jest.fn(),
  },
  readingHourAttendee: {
    create: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $transaction: jest.fn().mockImplementation(async (arr: any[]) => arr),
};

const mockCache: any = {
  remember: jest.fn().mockImplementation(async (_k: string, _ttl: number, fn: any) => fn()),
};

const mockConfig: any = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === "QR_HMAC_SECRET") return "test-secret-32-bytes-long-for-jest";
    return undefined;
  }),
};

describe("ReadingHourService", () => {
  let service: ReadingHourService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.institution.findUnique.mockResolvedValue(makeInstitution());
    mockPrisma.subscription.findFirst.mockResolvedValue(null);
    mockCache.remember.mockImplementation(async (_k: string, _ttl: number, fn: any) => fn());
    service = new ReadingHourService(
      mockPrisma as unknown as PrismaService,
      mockCache as unknown as CacheService,
      mockConfig as any,
    );
  });

  // ── Scope + subscription guards ──────────────────────────────────────────

  describe("scope guards", () => {
    it("rejects non-IDORA institutions", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce({
        ...makeInstitution(),
        type: "MAKTAB",
      });
      await expect(
        service.createReadingHour("inst-1", "u1", { heldAt: new Date().toISOString() }, superAdmin as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects outside MUASSASA_ADMIN", async () => {
      await expect(
        service.createReadingHour(
          "inst-1",
          "u1",
          { heldAt: new Date().toISOString() },
          outsideAdmin as any,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("rejects FROZEN subscription (not SUPER_ADMIN)", async () => {
      mockPrisma.institution.findUnique.mockResolvedValueOnce({
        ...makeInstitution(),
      });
      mockPrisma.institution.findUnique.mockResolvedValueOnce({
        libraryId: "lib-1",
      });
      mockPrisma.subscription.findFirst.mockResolvedValueOnce({
        status: "FROZEN",
      });
      await expect(
        service.createReadingHour(
          "inst-1",
          "u1",
          { heldAt: new Date().toISOString() },
          muassasaAdmin as any,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("SUPER_ADMIN bypasses subscription gate", async () => {
      mockPrisma.subscription.findFirst.mockResolvedValueOnce({ status: "FROZEN" });
      mockPrisma.readingHour.create.mockResolvedValue({ id: "rh-1" });
      await expect(
        service.createReadingHour(
          "inst-1",
          "u1",
          { heldAt: new Date().toISOString() },
          superAdmin as any,
        ),
      ).resolves.toBeTruthy();
    });
  });

  // ── HMAC rotating QR ─────────────────────────────────────────────────────

  describe("generateQrToken + verifyQrToken", () => {
    beforeEach(() => {
      mockPrisma.readingHour.findUnique.mockResolvedValue({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
      });
    });

    it("generates token with payload + hmac and 5min expiry", async () => {
      const result = await service.generateQrToken(
        "inst-1",
        "rh-1",
        superAdmin as any,
      );
      expect(result.token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
      const ttl = result.expiresAt.getTime() - result.windowStart;
      expect(ttl).toBe(5 * 60 * 1000); // 300000 ms
    });

    it("current-window token verifies and creates attendance", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(),
        title: "Test",
      });
      mockPrisma.readingHourAttendee.create.mockResolvedValue({ id: "att-1" });

      const res = await service.markAttendanceByToken("rh-1", qr.token, {
        id: "user-1",
        organizationId: "inst-1",
      });
      expect(res.attendeeId).toBe("att-1");
      expect(mockPrisma.readingHourAttendee.create).toHaveBeenCalled();
    });

    it("previous-window token still verifies (clock-drift grace)", async () => {
      // Generate token at fixed time, then verify 5 minutes later.
      const fixedNow = 1_700_000_000_000;
      const windowMs = 5 * 60 * 1000;
      const w0 = Math.floor(fixedNow / windowMs) * windowMs;
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);

      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);
      expect(qr.windowStart).toBe(w0);

      // Advance to next window — previous-window token must still verify.
      nowSpy.mockReturnValue(fixedNow + windowMs + 1000);
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(fixedNow),
        title: "Test",
      });
      mockPrisma.readingHourAttendee.create.mockResolvedValue({ id: "att-2" });

      const res = await service.markAttendanceByToken("rh-1", qr.token, {
        id: "user-2",
        organizationId: "inst-1",
      });
      expect(res.attendeeId).toBe("att-2");
      nowSpy.mockRestore();
    });

    it("two-window-stale token rejects with 410 Gone", async () => {
      const fixedNow = 1_700_000_000_000;
      const windowMs = 5 * 60 * 1000;
      const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);

      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      // Advance two full windows — token is now stale.
      nowSpy.mockReturnValue(fixedNow + 2 * windowMs + 1000);
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(fixedNow),
      });

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-3",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(GoneException);
      nowSpy.mockRestore();
    });

    it("tampered HMAC rejects with 410 Gone", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);
      // Flip the entire HMAC suffix to all zeros — guaranteed-different value
      // since legitimate HMACs are 64 hex chars of high-entropy output.
      const [payload] = qr.token.split(".");
      const tampered = `${payload}.${"0".repeat(64)}`;

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(),
      });

      await expect(
        service.markAttendanceByToken("rh-1", tampered, {
          id: "user-4",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(GoneException);
    });

    it("uses crypto.timingSafeEqual for HMAC compare", () => {
      // Static grep gate confirms timingSafeEqual is wired; this asserts the
      // service module imports it.
      const src = require("fs").readFileSync(
        require("path").join(__dirname, "..", "reading-hour.service.ts"),
        "utf8",
      );
      expect(src).toMatch(/crypto\.timingSafeEqual/);
    });

    it("payload-readingHourId mismatch rejects (substitution attack)", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-OTHER",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(),
      });

      // Verify against a DIFFERENT event id — payload binds to rh-1.
      await expect(
        service.markAttendanceByToken("rh-OTHER", qr.token, {
          id: "user-5",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(GoneException);
    });
  });

  // ── Attendance tolerance + dupe ─────────────────────────────────────────

  describe("markAttendanceByToken — tolerance + dupe", () => {
    it("rejects attendance > 2h before/after scheduledAt", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      // heldAt set 3 hours ago — outside ±2h tolerance.
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      });

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-6",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("DRAFT event rejects attendance", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "DRAFT",
        heldAt: new Date(),
      });

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-7",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("CANCELLED event rejects attendance", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "CANCELLED",
        heldAt: new Date(),
      });

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-8",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("cross-org user rejected (T-06-R2)", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(),
      });

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-9",
          organizationId: "inst-OTHER",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("dupe attendance (P2002) → 409 ConflictException", async () => {
      const qr = await service.generateQrToken("inst-1", "rh-1", superAdmin as any);

      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
        heldAt: new Date(),
      });
      const p2002 = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      mockPrisma.readingHourAttendee.create.mockRejectedValueOnce(p2002);

      await expect(
        service.markAttendanceByToken("rh-1", qr.token, {
          id: "user-10",
          organizationId: "inst-1",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── State machine ───────────────────────────────────────────────────────

  describe("finalize + delete state machine", () => {
    it("finalize DRAFT→PUBLISHED requires ≥1 media", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "DRAFT",
      });
      mockPrisma.readingHourMedia.count.mockResolvedValueOnce(0);

      await expect(
        service.finalizeReadingHour("inst-1", "rh-1", superAdmin as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("finalize with ≥1 media transitions to PUBLISHED", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "DRAFT",
      });
      mockPrisma.readingHourMedia.count.mockResolvedValueOnce(1);
      mockPrisma.$transaction.mockResolvedValueOnce([
        { id: "rh-1", status: "PUBLISHED" },
        {},
      ]);

      const res = await service.finalizeReadingHour(
        "inst-1",
        "rh-1",
        superAdmin as any,
      );
      expect(res.status).toBe("PUBLISHED");
    });

    it("delete PUBLISHED rejected for non-SUPER_ADMIN", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "PUBLISHED",
      });
      mockPrisma.institution.findUnique.mockResolvedValueOnce(makeInstitution());

      await expect(
        service.deleteReadingHour("inst-1", "rh-1", muassasaAdmin as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("delete DRAFT allowed for MUASSASA_ADMIN", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValueOnce({
        id: "rh-1",
        institutionId: "inst-1",
        status: "DRAFT",
      });
      mockPrisma.readingHour.delete.mockResolvedValueOnce({ id: "rh-1" });

      const res = await service.deleteReadingHour(
        "inst-1",
        "rh-1",
        muassasaAdmin as any,
      );
      expect(res.deleted).toBe(true);
    });
  });

  // ── Monthly summary ─────────────────────────────────────────────────────

  describe("getReadingHoursSummary", () => {
    it("excludes DRAFT/CANCELLED rows from monthly counts", async () => {
      const now = new Date();
      mockPrisma.readingHour.findMany.mockResolvedValueOnce([
        { heldAt: now },
        { heldAt: now },
      ]);
      mockPrisma.readingHour.count.mockResolvedValueOnce(2);
      mockPrisma.readingHour.findFirst.mockResolvedValueOnce({ heldAt: now });

      const summary = await service.getReadingHoursSummary(
        "inst-1",
        superAdmin as any,
      );
      expect(summary.total).toBe(2);
      expect(summary.byMonth).toHaveLength(12);

      // Verify the WHERE clause includes status: PUBLISHED.
      const findManyArgs = mockPrisma.readingHour.findMany.mock.calls[0][0];
      expect(findManyArgs.where.status).toBe("PUBLISHED");
    });

    it("byMonth returns last 12 months (chronological)", async () => {
      mockPrisma.readingHour.findMany.mockResolvedValueOnce([]);
      mockPrisma.readingHour.count.mockResolvedValueOnce(0);
      mockPrisma.readingHour.findFirst.mockResolvedValueOnce(null);

      const summary = await service.getReadingHoursSummary(
        "inst-1",
        superAdmin as any,
      );
      expect(summary.byMonth).toHaveLength(12);
      expect(summary.byMonth[0].ym).toMatch(/^\d{4}-\d{2}$/);
      expect(summary.lastEventAt).toBeNull();
    });
  });
});
