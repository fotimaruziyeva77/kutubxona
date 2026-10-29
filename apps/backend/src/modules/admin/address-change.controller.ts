import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { AddressChangeService } from "./address-change.service";
import { PrismaService } from "../../infra/prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  CurrentUser,
  JwtPayload,
} from "../../common/decorators/current-user.decorator";
import {
  CreateAddressChangeDto,
  RejectAddressChangeDto,
} from "./dto/address-change.dto";

/**
 * Plan 06-03 FAM-06 — Address-change endpoint set.
 *
 *   POST  /family/address-change            user submits (any authed user)
 *   GET   /family/address-change            scope-filtered admin list
 *   PATCH /family/address-change/:id/approve  TUMAN_ADMIN+
 *   PATCH /family/address-change/:id/reject   TUMAN_ADMIN+
 *
 * All admin mutations resolve the caller's scope from User.address via
 * resolveCallerScope (mirrors AdminController), then assertTumanInScope
 * inside the service layer (fail-CLOSED).
 */
@ApiTags("address-change")
@ApiBearerAuth()
@Controller("family/address-change")
@UseGuards(JwtAuthGuard)
export class AddressChangeController {
  constructor(
    private readonly service: AddressChangeService,
    private readonly prisma: PrismaService,
  ) {}

  // Resolve the caller's geo scope from their address row. Mirrors
  // AdminController.resolveCallerScope.
  private async resolveCallerScope(payload: JwtPayload) {
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        role: true,
        address: { select: { viloyatId: true, tumanId: true } },
      },
    });
    return {
      role: u?.role ?? (payload.role as UserRole),
      address: {
        viloyatId: u?.address?.viloyatId ?? null,
        tumanId: u?.address?.tumanId ?? null,
      },
    };
  }

  // POST — user-initiated address-change.
  @Post()
  @ApiOperation({
    summary: "Manzil o'zgartirish so'rovi yuborish (FAM-06)",
  })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateAddressChangeDto,
  ) {
    return this.service.createRequest(user.sub, dto);
  }

  // GET — scope-filtered list (admins only).
  @Get()
  @UseGuards(RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.BUXGALTER,
    UserRole.VILOYAT_ADMIN,
    UserRole.TUMAN_ADMIN,
  )
  @ApiOperation({ summary: "Manzil o'zgartirish so'rovlari (admin)" })
  async list(
    @CurrentUser() user: JwtPayload,
    @Query("status") status?: string,
  ) {
    const caller = await this.resolveCallerScope(user);
    return this.service.listRequests(caller, status);
  }

  // PATCH — approve.
  @Patch(":id/approve")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Manzil o'zgartirish so'rovini tasdiqlash" })
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
  ) {
    const caller = await this.resolveCallerScope(user);
    return this.service.approveRequest(caller, id, user.sub);
  }

  // PATCH — reject.
  @Patch(":id/reject")
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.VILOYAT_ADMIN, UserRole.TUMAN_ADMIN)
  @ApiOperation({ summary: "Manzil o'zgartirish so'rovini rad qilish" })
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body() dto: RejectAddressChangeDto,
  ) {
    const caller = await this.resolveCallerScope(user);
    return this.service.rejectRequest(caller, id, user.sub, dto);
  }
}
