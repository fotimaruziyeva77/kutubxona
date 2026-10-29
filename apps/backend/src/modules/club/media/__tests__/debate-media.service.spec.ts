import {
  BadRequestException,
  PayloadTooLargeException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";

// Mock file-type sniff — controlled per-test.
const mockSniff = jest.fn();
jest.mock("file-type", () => ({
  fileTypeFromBuffer: (...args: any[]) => mockSniff(...args),
}));

// Mock sharp — both image processing AND failure paths.
const mockSharpToBuffer = jest.fn();
const mockSharpResize = jest.fn().mockReturnValue({
  jpeg: jest.fn().mockReturnValue({ toBuffer: () => mockSharpToBuffer() }),
});
const mockSharpFactory = jest.fn().mockReturnValue({
  resize: mockSharpResize,
});
jest.mock("sharp", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSharpFactory(...args),
}));

import { DebateMediaService } from "../debate-media.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { MinioService } from "../../../../infra/minio/minio.service";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeInstitution = (overrides: object = {}) => ({
  id: "inst-1",
  type: "MAKTAB",
  tumanId: "tuman-1",
  viloyatId: "viloyat-1",
  ...overrides,
});

const makeDebate = (overrides: object = {}) => ({
  id: "debate-1",
  clubId: "club-1",
  status: "DRAFT",
  club: {
    institution: makeInstitution(),
  },
  ...overrides,
});

const makeFile = (overrides: Partial<{ buffer: Buffer; originalname: string; mimetype: string; size: number }> = {}) => ({
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic bytes
  originalname: "debate.jpg",
  mimetype: "image/jpeg",
  size: 1024,
  ...overrides,
});

const superAdmin = {
  id: "user-1",
  role: "SUPER_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: null,
  address: { viloyatId: null, tumanId: null },
};

const muassasaAdmin = {
  id: "user-2",
  role: "MUASSASA_ADMIN" as const,
  schoolId: "inst-1",
  universityId: null,
  organizationId: null,
  address: { viloyatId: null, tumanId: null },
};

const outsideMuassasaAdmin = {
  id: "user-3",
  role: "MUASSASA_ADMIN" as const,
  schoolId: "inst-OTHER",
  universityId: null,
  organizationId: null,
  address: { viloyatId: null, tumanId: null },
};

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  debate: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  debateMedia: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
} as any;

const mockMinio = {
  bucketDebates: "debate-media",
  putObject: jest.fn().mockResolvedValue(undefined),
  presignedGetUrl: jest.fn().mockResolvedValue("https://signed.example/foo"),
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DebateMediaService", () => {
  let service: DebateMediaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DebateMediaService(
      mockPrisma as unknown as PrismaService,
      mockMinio as unknown as MinioService,
    );
    // Default: valid JPEG sniff for image tests
    mockSniff.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });
    mockSharpToBuffer.mockResolvedValue(Buffer.from("thumb"));
  });

  describe("uploadDebateMedia — size cap", () => {
    it("rejects file > 50MB with PayloadTooLargeException", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      const file = makeFile({ size: 51_000_000 });
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });

    it("50_000_000 byte cap constant matches plan", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      // Exactly cap should pass
      const file = makeFile({ size: 50_000_000 });
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file),
      ).resolves.toBeTruthy();
    });
  });

  describe("uploadDebateMedia — 4-file cap", () => {
    it("rejects 5th file for the same debate", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(4);

      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(/Maksimal 4 ta fayl/);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });
  });

  describe("uploadDebateMedia — file-type sniff", () => {
    it("rejects when magic-byte sniff returns nothing", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce(undefined);

      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-whitelisted MIME (application/x-executable)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({
        mime: "application/x-executable",
        ext: "exe",
      });

      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(/qabul qilinmaydi/);
    });

    it("rejects declared/detected MIME mismatch (claimed jpeg, actually gif)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({ mime: "image/gif", ext: "gif" });

      const file = makeFile({ mimetype: "image/jpeg" });
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file),
      ).rejects.toThrow(/qabul qilinmaydi|mos kelmaydi/);
    });

    it("allows image/jpg ↔ image/jpeg tolerance", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({ mime: "image/jpeg", ext: "jpg" });
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const file = makeFile({ mimetype: "image/jpg" });
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file),
      ).resolves.toBeTruthy();
    });
  });

  describe("uploadDebateMedia — MinIO key safety", () => {
    it("never uses user-supplied filename in the MinIO key (path traversal mitigation)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const file = makeFile({ originalname: "../../etc/passwd.jpg" });
      const result = await service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file);

      expect(result.url).not.toContain("passwd");
      expect(result.url).not.toContain("..");
      expect(result.url).toMatch(/^inst-1\/debate-1\/[a-f0-9]+\.jpg$/);

      const putCall = mockMinio.putObject.mock.calls[0];
      expect(putCall[1]).toMatch(/^inst-1\/debate-1\/[a-f0-9]+\.jpg$/);
    });

    it("calls MinIO putObject TWICE for images (original + thumbnail)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile());
      expect(mockMinio.putObject).toHaveBeenCalledTimes(2);
      const secondKey = mockMinio.putObject.mock.calls[1][1];
      expect(secondKey).toMatch(/-thumb\.jpg$/);
    });

    it("does NOT call MinIO putObject for thumbnail when file is video/mp4", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({ mime: "video/mp4", ext: "mp4" });
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const file = makeFile({ mimetype: "video/mp4" });
      await service.uploadDebateMedia(superAdmin, "club-1", "debate-1", file);
      expect(mockMinio.putObject).toHaveBeenCalledTimes(1); // original only
    });

    it("thumbnail failure is non-fatal — original upload still succeeds, thumbnailUrl=null", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockSharpToBuffer.mockRejectedValueOnce(new Error("corrupt image"));
      mockPrisma.debateMedia.create.mockImplementation((args: any) => ({
        id: "m1",
        ...args.data,
      }));
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const result = await service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile());
      expect(result.thumbnailUrl).toBeNull();
    });
  });

  describe("uploadDebateMedia — scope guard", () => {
    it("rejects MUASSASA_ADMIN of a different school (T-06-06)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);

      await expect(
        service.uploadDebateMedia(outsideMuassasaAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(ForbiddenException);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });

    it("MUASSASA_ADMIN of the same school succeeds", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);
      mockPrisma.debateMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.debate.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await expect(
        service.uploadDebateMedia(muassasaAdmin, "club-1", "debate-1", makeFile()),
      ).resolves.toBeTruthy();
    });
  });

  describe("uploadDebateMedia — state machine", () => {
    it("rejects upload to a PUBLISHED debate", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate({ status: "PUBLISHED" }));
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(/Tasdiqlangan/);
    });

    it("404 on missing debate", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(null);
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects when clubId param does not match debate.clubId", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate({ clubId: "club-OTHER" }));
      await expect(
        service.uploadDebateMedia(superAdmin, "club-1", "debate-1", makeFile()),
      ).rejects.toThrow(/boshqa klubga/);
    });
  });

  describe("finalizeDebate", () => {
    it("requires ≥1 DebateMedia before flipping to PUBLISHED", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.count.mockResolvedValue(0);

      await expect(
        service.finalizeDebate(superAdmin, "club-1", "debate-1"),
      ).rejects.toThrow(/1 ta foto/);
    });

    it("flips DRAFT → PUBLISHED + writes DEBATE_PUBLISHED audit log", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate({ status: "DRAFT" }));
      mockPrisma.debateMedia.count.mockResolvedValue(1);
      mockPrisma.$transaction.mockResolvedValue([{}, {}]);

      const result = await service.finalizeDebate(superAdmin, "club-1", "debate-1");
      expect(result).toEqual({ id: "debate-1", status: "PUBLISHED" });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("rejects double-finalize (already PUBLISHED → 400)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate({ status: "PUBLISHED" }));
      await expect(
        service.finalizeDebate(superAdmin, "club-1", "debate-1"),
      ).rejects.toThrow(/allaqachon tasdiqlangan/);
    });

    it("scope guard runs before media count check (forbidden user does not see counts)", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      // Force scope to throw before count call
      await expect(
        service.finalizeDebate(outsideMuassasaAdmin, "club-1", "debate-1"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("listDebateMedia", () => {
    it("returns presigned URLs with 1h TTL", async () => {
      mockPrisma.debate.findUnique.mockResolvedValue(makeDebate());
      mockPrisma.debateMedia.findMany.mockResolvedValue([
        {
          id: "m1",
          url: "key-1",
          thumbnailUrl: "key-1-thumb",
          mimeType: "image/jpeg",
        },
      ]);

      const result = await service.listDebateMedia(superAdmin, "club-1", "debate-1");
      expect(result).toHaveLength(1);
      expect(mockMinio.presignedGetUrl).toHaveBeenCalledWith(
        "debate-media",
        "key-1",
        3600,
      );
      expect(mockMinio.presignedGetUrl).toHaveBeenCalledWith(
        "debate-media",
        "key-1-thumb",
        3600,
      );
    });
  });
});
