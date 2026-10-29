import { Controller, Get, Param, UseGuards, Request, ForbiddenException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { XpService } from "./xp.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

// reading.controller.ts dagi RI_VIEWER_ROLES bilan bir xil: XP/streak ham
// shaxsiy o'qish faoliyati ma'lumoti, shuning uchun bir xil gating.
const XP_VIEWER_ROLES: ReadonlySet<string> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.VILOYAT_ADMIN,
  UserRole.TUMAN_ADMIN,
  UserRole.MUASSASA_ADMIN,
  UserRole.KUTUBXONACHI,
]);

@ApiTags("xp")
@ApiBearerAuth()
@Controller("xp")
export class XpController {
  constructor(private readonly xpService: XpService) {}

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "O'z XP / level / streak holatim" })
  getMine(@Request() req: { user: { sub: string } }) {
    return this.xpService.getForUser(req.user.sub);
  }

  @Get(":userId")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Foydalanuvchi XP / level / streak (o'zi yoki xodim)" })
  getForUser(
    @Param("userId") userId: string,
    @Request() req: { user: { sub: string; role: string } },
  ) {
    const isSelf = req.user.sub === userId;
    if (!isSelf && !XP_VIEWER_ROLES.has(req.user.role)) {
      throw new ForbiddenException("Faqat o'z XP holatingizni ko'rishingiz mumkin");
    }
    return this.xpService.getForUser(userId);
  }
}
