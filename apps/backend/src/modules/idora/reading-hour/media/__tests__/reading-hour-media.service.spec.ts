import {
  BadRequestException,
  PayloadTooLargeException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";

// Mock file-type sniff — controlled per-test.
const mockSniff = jest.fn();
jest.mock("file-type", () => ({
  fileTypeFromBuffer: (...args: any[]) => mockSniff(...args),
}));

import { ReadingHourMediaService } from "../reading-hour-media.service";
import { PrismaService } from "../../../../../infra/prisma/prisma.service";
import { MinioService } from "../../../../../infra/minio/minio.service";

const makeInstitution = (overrides: object = {}) => ({
  id: "inst-1",
  type: "IDORA",
  tumanId: "tuman-1",
  viloyatId: "viloyat-1",
  ...overrides,
});

const makeEvent = (overrides: object = {}) => ({
  id: "rh-1",
  institutionId: "inst-1",
  ...overrides,
});

const makeFile = (
  overrides: Partial<{
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }> = {},
) => ({
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  originalname: "evidence.jpg",
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

const _muassasaAdmin = {
  id: "user-2",
  role: "MUASSASA_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: "inst-1",
  address: { viloyatId: null, tumanId: null },
};

const outsideAdmin = {
  id: "user-3",
  role: "MUASSASA_ADMIN" as const,
  schoolId: null,
  universityId: null,
  organizationId: "inst-OTHER",
  address: { viloyatId: null, tumanId: null },
};

const mockPrisma = {
  institution: {
    findUnique: jest.fn(),
  },
  readingHour: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  readingHourMedia: {
    count: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
} as any;

const mockMinio = {
  bucketReadingHours: "readinghour-media",
  putObject: jest.fn().mockResolvedValue(undefined),
  presignedGetUrl: jest.fn().mockResolvedValue("https://signed.example/foo"),
} as any;

describe("ReadingHourMediaService", () => {
  let service: ReadingHourMediaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReadingHourMediaService(
      mockPrisma as unknown as PrismaService,
      mockMinio as unknown as MinioService,
    );
    mockSniff.mockResolvedValue({ mime: "image/jpeg", ext: "jpg" });
    mockPrisma.institution.findUnique.mockResolvedValue(makeInstitution());
  });

  describe("uploadMedia — size cap", () => {
    it("rejects > 50MB with PayloadTooLargeException", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      const file = makeFile({ size: 51_000_000 });
      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", file),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });

    it("accepts exactly 50_000_000 bytes", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockPrisma.readingHourMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.readingHour.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const file = makeFile({ size: 50_000_000 });
      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", file),
      ).resolves.toBeTruthy();
    });
  });

  describe("uploadMedia — 4-file cap", () => {
    it("rejects 5th file for the same event", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(4);

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(/Maksimal 4 ta fayl/);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });
  });

  describe("uploadMedia — file-type sniff", () => {
    it("rejects unsniffable buffer", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce(undefined);

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-whitelisted MIME", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({
        mime: "application/x-executable",
        ext: "exe",
      });

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(/qabul qilinmaydi/);
    });

    it("rejects declared/detected mismatch (claimed jpeg, actually gif)", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockSniff.mockResolvedValueOnce({ mime: "image/gif", ext: "gif" });

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(/qabul qilinmaydi|mos kelmaydi/);
    });

    it("accepts mp4 video (HR reading-hour speech recording)", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockPrisma.readingHourMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.readingHour.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});
      mockSniff.mockResolvedValueOnce({ mime: "video/mp4", ext: "mp4" });

      await expect(
        service.uploadMedia(
          superAdmin as any,
          "inst-1",
          "rh-1",
          makeFile({ mimetype: "video/mp4" }),
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe("uploadMedia — MinIO key safety", () => {
    it("uses backend-controlled cuid in key, NEVER user filename", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockPrisma.readingHourMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.readingHour.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      const file = makeFile({ originalname: "../../etc/passwd.jpg" });
      await service.uploadMedia(superAdmin as any, "inst-1", "rh-1", file);

      const [bucket, key] = mockMinio.putObject.mock.calls[0];
      expect(bucket).toBe("readinghour-media");
      expect(key).toMatch(/^reading-hours\/inst-1\/rh-1\/[0-9a-f]{24}\.jpg$/);
      expect(key).not.toContain("passwd");
    });

    it("uses MINIO_BUCKET_READINGHOURS bucket", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.count.mockResolvedValue(0);
      mockPrisma.readingHourMedia.create.mockResolvedValue({ id: "m1" });
      mockPrisma.readingHour.update.mockResolvedValue({});
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile());

      expect(mockMinio.putObject).toHaveBeenCalledWith(
        "readinghour-media",
        expect.any(String),
        expect.any(Buffer),
        "image/jpeg",
        expect.objectContaining({ readingHourId: "rh-1", uploadedBy: "user-1" }),
      );
    });
  });

  describe("uploadMedia — scope guard", () => {
    it("rejects outside MUASSASA_ADMIN BEFORE putObject", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());

      await expect(
        service.uploadMedia(outsideAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(ForbiddenException);
      expect(mockMinio.putObject).not.toHaveBeenCalled();
    });

    it("rejects cross-event institutionId mismatch", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue({
        ...makeEvent(),
        institutionId: "inst-OTHER",
      });

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-1", makeFile()),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects missing event with 404", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadMedia(superAdmin as any, "inst-1", "rh-MISSING", makeFile()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("listMedia + getSignedUrl", () => {
    it("listMedia returns presigned URLs with 3600s TTL", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.findMany.mockResolvedValue([
        {
          id: "m1",
          url: "reading-hours/inst-1/rh-1/abc.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
        },
      ]);

      const rows = await service.listMedia(superAdmin as any, "inst-1", "rh-1");

      expect(mockMinio.presignedGetUrl).toHaveBeenCalledWith(
        "readinghour-media",
        "reading-hours/inst-1/rh-1/abc.jpg",
        3600,
      );
      expect(rows[0].url).toBe("https://signed.example/foo");
    });

    it("getSignedUrl rejects mediaId from another event", async () => {
      mockPrisma.readingHour.findUnique.mockResolvedValue(makeEvent());
      mockPrisma.readingHourMedia.findUnique.mockResolvedValue({
        id: "m1",
        readingHourId: "rh-OTHER",
        url: "x",
        mimeType: "image/jpeg",
      });

      await expect(
        service.getSignedUrl(superAdmin as any, "inst-1", "rh-1", "m1"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
