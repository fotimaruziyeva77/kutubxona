/**
 * P2 hygiene — GET /reading/:userId va /reading/:userId/history endi @Public
 * EMAS: o'zi YOKI xodim darajasi (transactions.controller IDOR-C3
 * getUserHistory gating bilan bir xil naqsh). Bu spec gating mantig'ini
 * unit darajasida tekshiradi (guard wiring integration qatlamida).
 */
import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ReadingController } from "../reading.controller";
import { ReadingService } from "../reading.service";

const mockReadingService = {
  getLeaderboard: jest.fn(),
  getReadingIndex: jest.fn().mockResolvedValue({ score: 42 }),
  getHistory: jest.fn().mockResolvedValue([]),
  computeDelta: jest.fn(),
  recalculateForUser: jest.fn(),
  syncMutolaaProgress: jest.fn()
};

const mockConfig = { get: jest.fn() };

const makeReq = (sub: string, role: string) => ({ user: { sub, role } });

describe("ReadingController — individual RI gating (self yoki xodim)", () => {
  let controller: ReadingController;

  beforeEach(() => {
    controller = new ReadingController(
      mockReadingService as unknown as ReadingService,
      mockConfig as unknown as ConfigService
    );
    jest.clearAllMocks();
    mockReadingService.getReadingIndex.mockResolvedValue({ score: 42 });
    mockReadingService.getHistory.mockResolvedValue([]);
  });

  describe("GET /reading/:userId (getIndex)", () => {
    it("o'zining RI sini ko'rishi mumkin", async () => {
      await controller.getIndex("u1", makeReq("u1", "KITOBXON"));
      expect(mockReadingService.getReadingIndex).toHaveBeenCalledWith("u1");
    });

    it("oddiy KITOBXON boshqa foydalanuvchining RI sini ko'ra OLMAYDI — 403", () => {
      expect(() => controller.getIndex("u2", makeReq("u1", "KITOBXON"))).toThrow(
        ForbiddenException
      );
      expect(mockReadingService.getReadingIndex).not.toHaveBeenCalled();
    });

    it.each(["KUTUBXONACHI", "MUASSASA_ADMIN", "TUMAN_ADMIN", "VILOYAT_ADMIN", "SUPER_ADMIN"])(
      "%s xodim darajasi boshqaning RI sini ko'ra oladi",
      async (role) => {
        await controller.getIndex("u2", makeReq("staff-1", role));
        expect(mockReadingService.getReadingIndex).toHaveBeenCalledWith("u2");
      }
    );
  });

  describe("GET /reading/:userId/history (getHistory)", () => {
    it("o'z tarixini ko'rishi mumkin", async () => {
      await controller.getHistory("u1", makeReq("u1", "KITOBXON"));
      expect(mockReadingService.getHistory).toHaveBeenCalledWith("u1");
    });

    it("begona KITOBXON uchun 403", () => {
      expect(() => controller.getHistory("u2", makeReq("u1", "KITOBXON"))).toThrow(
        ForbiddenException
      );
      expect(mockReadingService.getHistory).not.toHaveBeenCalled();
    });

    it("KUTUBXONACHI boshqaning tarixini ko'ra oladi (deskda xizmat)", async () => {
      await controller.getHistory("u2", makeReq("lib-1", "KUTUBXONACHI"));
      expect(mockReadingService.getHistory).toHaveBeenCalledWith("u2");
    });
  });
});
