import { NotFoundException, ConflictException } from "@nestjs/common";
import { UsersService } from "../users.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

// QR kod generatsiyasini mock qilish
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mock-qr")
}));

const mockAddress = {
  id: "addr-1", viloyatId: "v1", tumanId: "t1", mahallaId: "m1",
  street: "Mustaqillik", house: "12", apartment: "34"
};

const mockMahalla = {
  id: "m1", code: "14-001-0001", name: "Chilonzor-1", slug: "chilonzor-1",
  lastSeq: 0,
  tuman: { id: "t1", code: "14-001", viloyat: { id: "v1", code: "14" } }
};

const mockUser = {
  id: "u1", phone: "+998901234567", name: "Test User",
  sifatId: null, status: "PENDING", type: "CITIZEN", role: "KITOBXON",
  trustScore: 0, addressId: null
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma: any = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn()
  },
  mahalla: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  address: {
    create: jest.fn(),
    update: jest.fn()
  },
  // Plan 05-04 Task 3 (NOTIF-02) — DeviceToken CRUD + AiAuditLog for transfer
  deviceToken: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
  aiAuditLog: {
    create: jest.fn(),
  },
  // 05-04-fix FIX B — $transaction wrapper used for atomic cross-user
  // transfer. Default impl executes the callback against the same mock
  // (no real txn isolation in unit tests). The `any` annotation above
  // sidesteps TS's implicit-self-reference inference here.
  $transaction: jest.fn(),
};
// Bind impl after declaration to avoid self-referential type inference.
mockPrisma.$transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma),
);

// 05-04-fix FIX B — optional NOTIFICATION_QUEUE injection. Most tests pass
// undefined (the @Optional injection skips notify entirely); transfer-notify
// tests pass an explicit jest mock to assert enqueue.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeMockQueue = (): any => ({ add: jest.fn().mockResolvedValue(undefined) });

describe("UsersService", () => {
  let service: UsersService;

  beforeEach(() => {
    service = new UsersService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
    // Re-bind $transaction after clearAllMocks because the implementation
    // is wiped — callbacks must continue to execute against mockPrisma.
    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma),
    );
  });

  // ── completeProfile ──────────────────────────────────────────────────────
  describe("completeProfile", () => {
    const validDto = {
      userId: "u1", name: "Alisher Navoiy",
      dob: "2000-01-01", gender: "MALE" as const,
      viloyatId: "v1", tumanId: "t1", mahallaId: "m1",
      street: "Mustaqillik", house: "12", apartment: "34",
      type: "CITIZEN" as const
    };

    it("CITIZEN turida darhol ACTIVE bo'ladi va sifatId generatsiya qiladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.mahalla.findUnique.mockResolvedValue(mockMahalla);
      mockPrisma.mahalla.update.mockResolvedValue({ ...mockMahalla, lastSeq: 1 });
      mockPrisma.address.create.mockResolvedValue(mockAddress);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser, sifatId: "SL-UZ-14-001-0001-00001", status: "ACTIVE", address: mockAddress
      });

      const result = await service.completeProfile(validDto);
      expect(result.sifatId).toBe("SL-UZ-14-001-0001-00001");
      expect(result.user.status).toBe("ACTIVE");
      expect(result.qrCode).toContain("data:image/png");
    });

    it("STUDENT_SCHOOL turida status PENDING qoladi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.mahalla.findUnique.mockResolvedValue(mockMahalla);
      mockPrisma.mahalla.update.mockResolvedValue({ ...mockMahalla, lastSeq: 2 });
      mockPrisma.address.create.mockResolvedValue(mockAddress);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser, sifatId: "SL-UZ-14-001-0001-00002", status: "PENDING",
        type: "STUDENT_SCHOOL", address: mockAddress
      });

      const result = await service.completeProfile({ ...validDto, type: "STUDENT_SCHOOL" });
      expect(result.user.status).toBe("PENDING");
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.completeProfile(validDto)).rejects.toThrow(NotFoundException);
    });

    it("profil allaqachon to'ldirilgan bo'lsa ConflictException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, sifatId: "SL-UZ-14-001-0001-00001" });
      await expect(service.completeProfile(validDto)).rejects.toThrow(ConflictException);
    });

    it("mahalla topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.mahalla.findUnique.mockResolvedValue(null);
      await expect(service.completeProfile(validDto)).rejects.toThrow(NotFoundException);
    });
  });

  // ── getProfile ───────────────────────────────────────────────────────────
  describe("getProfile", () => {
    it("profil va QR kodni qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser, sifatId: "SL-UZ-14-001-0001-00001",
        address: mockAddress,
        readingIndex: [{ score: 75 }],
        transactions: []
      });
      const result = await service.getProfile("u1");
      expect(result.sifatId).toBe("SL-UZ-14-001-0001-00001");
      expect(result.qrCode).toContain("data:image/png");
      expect(result.readingScore).toBe(75);
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getProfile("nonexistent")).rejects.toThrow(NotFoundException);
    });

    // ── Regressiya: maxfiy maydonlar sizib chiqmasligi ────────────────────
    // getProfile `{...user}` bilan butun Prisma qatorini yoyadi. Himoyasiz
    // qolsa, bcrypt passwordHash va PINFL /users/me javobiga tushadi, frontend
    // esa uni localStorage'ga saqlaydi → XSS/umumiy qurilmada parol hash'i
    // offline bruteforce uchun o'g'irlanadi. Bu HAQIQIY xato edi: brauzer
    // localStorage'ida "$2b$12$..." hash ochiq yotgani aniqlandi.
    it("passwordHash va pinfl javobga TUSHMAYDI", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUser,
        passwordHash: "$2b$12$super-secret-bcrypt-hash",
        pinfl: "12345678901234",
        sifatId: "SL-UZ-14-001-0001-00001",
        address: mockAddress,
        readingIndex: [{ score: 75 }],
        transactions: []
      });

      const result = await service.getProfile("u1");

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("pinfl");
      expect(JSON.stringify(result)).not.toContain("$2b$12$");
      expect(JSON.stringify(result)).not.toContain("12345678901234");
      // Qolgan profil ma'lumotlari o'z joyida
      expect(result.sifatId).toBe("SL-UZ-14-001-0001-00001");
      expect(result.readingScore).toBe(75);
    });
  });

  // ── updateProfile ────────────────────────────────────────────────────────
  describe("updateProfile", () => {
    const userWithAddress = {
      ...mockUser,
      sifatId: "SL-UZ-14-001-0001-00001",
      address: { id: "addr-1", street: "Mustaqillik", house: "12", apartment: "34" }
    };

    it("ism yangilanadi", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(userWithAddress)
        .mockResolvedValueOnce({ ...userWithAddress, name: "Yangi Ism", address: userWithAddress.address, readingIndex: [], transactions: [] });
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.updateProfile("u1", { name: "Yangi Ism" });
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: "Yangi Ism" } })
      );
      expect(result).toBeDefined();
    });

    it("manzil yangilanadi", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(userWithAddress)
        .mockResolvedValueOnce({ ...userWithAddress, address: userWithAddress.address, readingIndex: [], transactions: [] });
      mockPrisma.address.update.mockResolvedValue({});

      await service.updateProfile("u1", { street: "Yangi ko'cha" });
      expect(mockPrisma.address.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "addr-1" } })
      );
    });

    it("foydalanuvchi topilmasa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.updateProfile("notfound", { name: "X" })).rejects.toThrow(NotFoundException);
    });
  });

  // ── getQrCode ─────────────────────────────────────────────────────────────
  describe("getQrCode", () => {
    it("sifatId va QR kodni qaytaradi", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, sifatId: "SL-UZ-14-001-0001-00001" });
      const result = await service.getQrCode("u1");
      expect(result.sifatId).toBe("SL-UZ-14-001-0001-00001");
      expect(result.qrCode).toContain("data:image/png");
    });

    it("sifatId yo'q bo'lsa NotFoundException", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, sifatId: null });
      await expect(service.getQrCode("u1")).rejects.toThrow(NotFoundException);
    });
  });

  // ── findAll ──────────────────────────────────────────────────────────────
  describe("findAll", () => {
    it("pagination bilan ro'yhat qaytaradi", async () => {
      mockPrisma.user.findMany.mockResolvedValue([mockUser, mockUser]);
      const result = await service.findAll(1, 20);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 })
      );
      expect(result).toHaveLength(2);
    });

    it("2-sahifada skip=20 bo'ladi", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      await service.findAll(2, 20);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 20 })
      );
    });
  });

  // ── Plan 05-04 Task 3 — FCM token CRUD (NOTIF-02) ──────────────────────
  describe("upsertFcmToken", () => {
    const token = "a".repeat(150);

    it("yangi token uchun create chaqiriladi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);
      mockPrisma.deviceToken.count.mockResolvedValue(0);
      mockPrisma.deviceToken.create.mockResolvedValue({
        id: "dt-1",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      await service.upsertFcmToken({ userId: "u1", token, platform: "web" });

      expect(mockPrisma.deviceToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { userId: "u1", token, platform: "web" },
        }),
      );
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("bir xil userId uchun update — auditlog YO'Q", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u1" });
      mockPrisma.deviceToken.update.mockResolvedValue({
        id: "dt-1",
        platform: "android",
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      await service.upsertFcmToken({ userId: "u1", token, platform: "android" });

      expect(mockPrisma.deviceToken.update).toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });

    it("boshqa userId — DEVICE_TOKEN_TRANSFER auditlog yoziladi va token ko'chiriladi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u-old" });
      mockPrisma.deviceToken.update.mockResolvedValue({
        id: "dt-1",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await service.upsertFcmToken({ userId: "u-new", token, platform: "web" });

      // 05-04-fix FIX B — audit + update wrapped in $transaction.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: "DEVICE_TOKEN_TRANSFER",
            scope: "USER",
            scopeId: "u-new",
          }),
        }),
      );
      expect(mockPrisma.deviceToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { token },
          data: expect.objectContaining({ userId: "u-new", platform: "web" }),
        }),
      );
    });

    // 05-04-fix FIX B Layer 1 — atomic rollback.
    it("FIX B: aiAuditLog.create throws → deviceToken.update NOT called (rollback)", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u-old" });
      mockPrisma.aiAuditLog.create.mockRejectedValue(new Error("DB down"));

      await expect(
        service.upsertFcmToken({ userId: "u-new", token, platform: "web" }),
      ).rejects.toThrow(/DB down/);

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalled();
      // Atomic guarantee: when audit throws inside the txn, the update never runs.
      expect(mockPrisma.deviceToken.update).not.toHaveBeenCalled();
    });

    // 05-04-fix FIX B Layer 2 — successful transfer enqueues a prior-owner notify.
    it("FIX B: successful transfer enqueues notify to prior owner via NOTIFICATION_QUEUE", async () => {
      const queue = makeMockQueue();
      const svc = new UsersService(
        mockPrisma as unknown as PrismaService,
        queue as unknown as import("bullmq").Queue,
      );
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u-old" });
      mockPrisma.deviceToken.update.mockResolvedValue({
        id: "dt-1",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });
      mockPrisma.aiAuditLog.create.mockResolvedValue({});
      mockPrisma.user.findUnique.mockResolvedValue({ phone: "+998900000000" });

      await svc.upsertFcmToken({ userId: "u-new", token, platform: "web" });

      // Wait one tick so the fire-and-forget notifyPriorOwnerOfTransfer settles.
      await new Promise((r) => setImmediate(r));

      // Channels enqueued: sms + email + push, all targeting the PRIOR owner.
      const types = (queue.add as jest.Mock).mock.calls.map((c) => c[1].type);
      expect(types).toEqual(expect.arrayContaining(["sms", "email", "push"]));
      const userIds = (queue.add as jest.Mock).mock.calls
        .map((c) => c[1].userId)
        .filter((v) => v !== undefined);
      userIds.forEach((id) => expect(id).toBe("u-old"));
      // SMS phone resolves from prior owner's user record.
      const smsCall = (queue.add as jest.Mock).mock.calls.find((c) => c[1].type === "sms");
      expect(smsCall[1].phone).toBe("+998900000000");
      expect(smsCall[1].message).toContain("qurilmangiz boshqa hisobga ko'chirildi");
    });

    // 05-04-fix FIX A Layer 2 — per-user cap LRU-evict.
    it("FIX A: 25 ta token bo'lsa, 26-chisi qo'shilishidan oldin oldest LRU-evict bo'ladi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);
      mockPrisma.deviceToken.count.mockResolvedValue(25);
      mockPrisma.deviceToken.findFirst.mockResolvedValue({ id: "dt-oldest" });
      mockPrisma.deviceToken.delete.mockResolvedValue({});
      mockPrisma.deviceToken.create.mockResolvedValue({
        id: "dt-new",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await service.upsertFcmToken({ userId: "u-cap", token, platform: "web" });

      expect(mockPrisma.deviceToken.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "u-cap" },
          orderBy: { lastSeen: "asc" },
        }),
      );
      expect(mockPrisma.deviceToken.delete).toHaveBeenCalledWith({ where: { id: "dt-oldest" } });
      expect(mockPrisma.deviceToken.create).toHaveBeenCalled();
    });

    // 05-04-fix FIX A Layer 3 — cap audit log.
    it("FIX A: cap hit DEVICE_TOKEN_CAP_REACHED auditlog yozadi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);
      mockPrisma.deviceToken.count.mockResolvedValue(25);
      mockPrisma.deviceToken.findFirst.mockResolvedValue({ id: "dt-oldest" });
      mockPrisma.deviceToken.delete.mockResolvedValue({});
      mockPrisma.deviceToken.create.mockResolvedValue({
        id: "dt-new",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });
      mockPrisma.aiAuditLog.create.mockResolvedValue({});

      await service.upsertFcmToken({ userId: "u-cap", token, platform: "web" });

      expect(mockPrisma.aiAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issueType: "DEVICE_TOKEN_CAP_REACHED",
            scope: "USER",
            scopeId: "u-cap",
          }),
        }),
      );
    });

    // 05-04-fix FIX A Layer 2 — under cap, NO eviction.
    it("FIX A: cap dan past bo'lsa, evict bo'lmaydi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);
      mockPrisma.deviceToken.count.mockResolvedValue(10);
      mockPrisma.deviceToken.create.mockResolvedValue({
        id: "dt-new",
        platform: "web",
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      await service.upsertFcmToken({ userId: "u-small", token, platform: "web" });

      expect(mockPrisma.deviceToken.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.deviceToken.delete).not.toHaveBeenCalled();
      expect(mockPrisma.aiAuditLog.create).not.toHaveBeenCalled();
    });
  });

  // ── 05-04-fix FIX A Layer 1 — controller throttle metadata ─────────────
  describe("FIX A: device-tokens controller throttle", () => {
    it("@Throttle decorator metadata is attached to registerFcmToken", async () => {
      // Ensure reflect-metadata polyfill is loaded (Nest brings it transitively).
      await import("reflect-metadata");
      const { UsersController } = await import("../users.controller");
      const proto = UsersController.prototype as unknown as Record<string, unknown>;
      const fn = proto.registerFcmToken as object;
      // Across @nestjs/throttler versions the key is either THROTTLER_LIMIT
      // / THROTTLER_TTL or a single combined key. We assert at least one
      // throttler-prefixed metadata key exists on the method.
      const keys = (Reflect as unknown as { getMetadataKeys: (t: object) => unknown[] })
        .getMetadataKeys(fn);
      const hasThrottle = keys.some((k) => String(k).toLowerCase().includes("throttl"));
      expect(hasThrottle).toBe(true);
    });
  });

  describe("deleteFcmToken", () => {
    it("404 — token topilmasa NotFoundException", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);
      await expect(service.deleteFcmToken("u1", "dt-missing")).rejects.toThrow(NotFoundException);
      expect(mockPrisma.deviceToken.delete).not.toHaveBeenCalled();
    });

    it("404 — token boshqa foydalanuvchiniki bo'lsa (existence yashiriladi)", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u-other" });
      await expect(service.deleteFcmToken("u1", "dt-1")).rejects.toThrow(NotFoundException);
      expect(mockPrisma.deviceToken.delete).not.toHaveBeenCalled();
    });

    it("o'z tokenini o'chiradi", async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ id: "dt-1", userId: "u1" });
      mockPrisma.deviceToken.delete.mockResolvedValue({});

      await service.deleteFcmToken("u1", "dt-1");
      expect(mockPrisma.deviceToken.delete).toHaveBeenCalledWith({ where: { id: "dt-1" } });
    });
  });

  describe("listMyFcmTokens", () => {
    it("o'z tokenlarini lastSeen DESC tartibida qaytaradi (token plaintext YO'Q)", async () => {
      mockPrisma.deviceToken.findMany.mockResolvedValue([
        { id: "dt-2", platform: "android", lastSeen: new Date("2026-06-06"), createdAt: new Date() },
        { id: "dt-1", platform: "web", lastSeen: new Date("2026-06-05"), createdAt: new Date() },
      ]);

      const result = await service.listMyFcmTokens("u1");

      expect(mockPrisma.deviceToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "u1" },
          orderBy: { lastSeen: "desc" },
          select: { id: true, platform: true, lastSeen: true, createdAt: true },
        }),
      );
      expect(result).toHaveLength(2);
      result.forEach((r: unknown) => {
        expect(r).not.toHaveProperty("token");
      });
    });
  });
});
