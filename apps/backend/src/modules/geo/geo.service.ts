import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service";

@Injectable()
export class GeoService {
  constructor(private readonly prisma: PrismaService) {}

  getViloyatlar() {
    return this.prisma.viloyat.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, slug: true }
    });
  }

  getTumanlar(viloyatId: string) {
    return this.prisma.tuman.findMany({
      where: { viloyatId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, slug: true }
    });
  }

  getMahallalar(tumanId: string) {
    return this.prisma.mahalla.findMany({
      where: { tumanId },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, slug: true }
    });
  }
}
