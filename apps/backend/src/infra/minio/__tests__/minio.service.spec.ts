import { ConfigService } from "@nestjs/config";
import { MinioService } from "../minio.service";

// We replace the inner `client` with a manual mock after construction.
const makeMockClient = () => ({
  bucketExists: jest.fn(),
  makeBucket: jest.fn(),
  putObject: jest.fn(),
  getObject: jest.fn(),
  presignedGetObject: jest.fn(),
});

const cfg = (overrides: Record<string, string | undefined> = {}) => {
  const map: Record<string, string | undefined> = {
    MINIO_ENDPOINT: "localhost",
    MINIO_PORT: "9000",
    MINIO_USE_SSL: "false",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
    MINIO_BUCKET_DEBATES: "debate-media",
    MINIO_BUCKET_BOOKCORNERS: "bookcorner-photos",
    MINIO_BUCKET_READINGHOURS: "readinghour-media",
    ...overrides,
  };
  return { get: (k: string) => map[k] } as unknown as ConfigService;
};

describe("MinioService (Plan 06-01)", () => {
  describe("dev no-op (MINIO_ENDPOINT unset)", () => {
    let service: MinioService;
    let warnSpy: jest.SpyInstance;

    beforeEach(async () => {
      service = new MinioService(cfg({ MINIO_ENDPOINT: undefined }));
      warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => undefined);
      await service.onModuleInit();
    });

    it("logs [minio dev no-op] when endpoint is unset", () => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[minio dev no-op]"),
      );
    });

    it("putObject throws 'MinIO not configured'", async () => {
      await expect(
        service.putObject(
          "debate-media",
          "k",
          Buffer.from("x"),
          "image/png",
        ),
      ).rejects.toThrow("MinIO not configured");
    });

    it("presignedGetUrl throws 'MinIO not configured' (even within valid TTL)", async () => {
      await expect(
        service.presignedGetUrl("debate-media", "k", 600),
      ).rejects.toThrow("MinIO not configured");
    });

    it("ensureBucket throws 'MinIO not configured'", async () => {
      await expect(service.ensureBucket("debate-media")).rejects.toThrow(
        "MinIO not configured",
      );
    });
  });

  describe("with mocked client", () => {
    let service: MinioService;
    let mockClient: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
      service = new MinioService(cfg());
      mockClient = makeMockClient();
      (service as any).client = mockClient;
    });

    it("putObject calls client.putObject with size + Content-Type metadata", async () => {
      mockClient.putObject.mockResolvedValue({});
      const buf = Buffer.from("hello");
      await service.putObject("debate-media", "x/y.png", buf, "image/png");

      expect(mockClient.putObject).toHaveBeenCalledWith(
        "debate-media",
        "x/y.png",
        buf,
        buf.length,
        expect.objectContaining({ "Content-Type": "image/png" }),
      );
    });

    it("getObject delegates to client.getObject", async () => {
      const stream = {} as NodeJS.ReadableStream;
      mockClient.getObject.mockResolvedValue(stream);

      const result = await service.getObject("debate-media", "x/y.png");

      expect(result).toBe(stream);
      expect(mockClient.getObject).toHaveBeenCalledWith(
        "debate-media",
        "x/y.png",
      );
    });

    it("presignedGetUrl returns URL when ttl in range", async () => {
      mockClient.presignedGetObject.mockResolvedValue("https://example/sig");
      const url = await service.presignedGetUrl("debate-media", "k", 1800);
      expect(url).toBe("https://example/sig");
      expect(mockClient.presignedGetObject).toHaveBeenCalledWith(
        "debate-media",
        "k",
        1800,
      );
    });

    it("presignedGetUrl throws when ttl > 3600 (hard cap, non-negotiable)", async () => {
      await expect(
        service.presignedGetUrl("debate-media", "k", 7200),
      ).rejects.toThrow(/3600/);
      expect(mockClient.presignedGetObject).not.toHaveBeenCalled();
    });

    it("presignedGetUrl throws when ttl < 60 (lower bound)", async () => {
      await expect(
        service.presignedGetUrl("debate-media", "k", 30),
      ).rejects.toThrow(/60/);
    });

    it("ensureBucket no-ops when bucket already exists (idempotent)", async () => {
      mockClient.bucketExists.mockResolvedValue(true);
      await service.ensureBucket("debate-media");
      expect(mockClient.makeBucket).not.toHaveBeenCalled();
    });

    it("ensureBucket creates bucket when missing", async () => {
      mockClient.bucketExists.mockResolvedValue(false);
      mockClient.makeBucket.mockResolvedValue({});
      await service.ensureBucket("debate-media");
      expect(mockClient.makeBucket).toHaveBeenCalledWith("debate-media", "");
    });
  });
});
