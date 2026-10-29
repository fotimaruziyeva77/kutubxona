import { GeoService } from "../geo.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

const mockPrisma = {
  viloyat: { findMany: jest.fn() },
  tuman: { findMany: jest.fn() },
  mahalla: { findMany: jest.fn() }
};

describe("GeoService", () => {
  let service: GeoService;

  beforeEach(() => {
    service = new GeoService(mockPrisma as unknown as PrismaService);
    jest.clearAllMocks();
  });

  it("getViloyatlar barcha viloyatlarni qaytaradi", async () => {
    mockPrisma.viloyat.findMany.mockResolvedValue([
      { id: "v1", code: "14", name: "Toshkent shahar", slug: "toshkent" }
    ]);
    const result = await service.getViloyatlar();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: "14", name: "Toshkent shahar" });
  });

  it("getTumanlar viloyatId bo'yicha filterlaydi", async () => {
    mockPrisma.tuman.findMany.mockResolvedValue([
      { id: "t1", code: "14-001", name: "Chilonzor", slug: "chilonzor" }
    ]);
    const result = await service.getTumanlar("v1");
    expect(mockPrisma.tuman.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { viloyatId: "v1" } })
    );
    expect(result).toHaveLength(1);
  });

  it("getMahallalar tumanId bo'yicha filterlaydi", async () => {
    mockPrisma.mahalla.findMany.mockResolvedValue([
      { id: "m1", code: "14-001-0001", name: "Chilonzor-1", slug: "chilonzor-1" }
    ]);
    const result = await service.getMahallalar("t1");
    expect(mockPrisma.mahalla.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tumanId: "t1" } })
    );
    expect(result).toHaveLength(1);
  });
});
