import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { GeoService } from "./geo.service";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("geo")
@Controller("geo")
export class GeoController {
  constructor(private readonly geoService: GeoService) {}

  // Ro'yhatdan o'tish kaskadi — auth kerak emas (@Public, INFRA-03)
  @Public()
  @Get("viloyatlar")
  @ApiOperation({ summary: "Barcha viloyatlar ro'yhati" })
  getViloyatlar() {
    return this.geoService.getViloyatlar();
  }

  @Public()
  @Get("viloyatlar/:viloyatId/tumanlar")
  @ApiOperation({ summary: "Viloyat tumanlari" })
  getTumanlar(@Param("viloyatId") viloyatId: string) {
    return this.geoService.getTumanlar(viloyatId);
  }

  @Public()
  @Get("tumanlar/:tumanId/mahallalar")
  @ApiOperation({ summary: "Tuman mahallalari" })
  getMahallalar(@Param("tumanId") tumanId: string) {
    return this.geoService.getMahallalar(tumanId);
  }
}
