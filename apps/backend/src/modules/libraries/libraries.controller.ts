import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards
} from "@nestjs/common";
import { LibrariesService, CreateLibraryDto, UpdateLibraryDto } from "./libraries.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser, JwtPayload } from "../../common/decorators/current-user.decorator";
import { LibraryType, LibraryStatus, UserRole } from "@prisma/client";

@Controller("libraries")
export class LibrariesController {
  constructor(private readonly librariesService: LibrariesService) {}

  // ── Ochiq endpointlar (auth kerak emas — @Public, INFRA-03) ───────────────

  @Public()
  @Get()
  findAll(
    @Query("status") status?: LibraryStatus,
    @Query("type") type?: LibraryType,
    @Query("tumanId") tumanId?: string
  ) {
    return this.librariesService.findAll(status, type, tumanId);
  }

  // ── Joriy foydalanuvchining kutubxona(lar)i (RBAC scope) ──────────────────
  //
  // NOT @Public — auth required. Returns the caller's manageable libraries as
  // an array (same shape as GET /libraries) scoped by role. Frontend dropdowns
  // (Muassasa paneli + Kitob fondi) use THIS instead of GET /libraries so a
  // KUTUBXONACHI no longer sees every library in the system.
  //
  // Declared BEFORE @Get(":id") so "mine" is not captured as an :id param.
  // No RolesGuard: every authenticated role may call it; the service returns
  // [] for roles without a library-management surface.
  @Get("mine")
  @UseGuards(JwtAuthGuard)
  getMine(@CurrentUser() user: JwtPayload) {
    return this.librariesService.getManageableLibraries({
      sub: user.sub,
      role: user.role
    });
  }

  // Kitobxonning muassasa kutubxonasi (talaba/o'quvchi/xodim) — navigatsiyadagi
  // "Mening kutubxonam" havolasi uchun. ":id" dan OLDIN turishi shart. Har
  // qanday autentifikatsiyalangan rol chaqira oladi; muassasasiz fuqaroga null.
  @Get("my-institution")
  @UseGuards(JwtAuthGuard)
  getMyInstitutionLibrary(@CurrentUser("id") userId: string) {
    return this.librariesService.getMyInstitutionLibrary(userId);
  }

  @Public()
  @Get("nearby")
  findNearby(
    @Query("lat") lat: string,
    @Query("lon") lon: string,
    @Query("radius") radius?: string,
    @Query("book") book?: string
  ) {
    return this.librariesService.findNearby(
      parseFloat(lat),
      parseFloat(lon),
      radius ? parseFloat(radius) : 10,
      book
    );
  }

  @Public()
  @Get("code/:code")
  findByCode(@Param("code") code: string) {
    return this.librariesService.findByCode(code);
  }

  @Public()
  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.librariesService.findOne(id);
  }

  // ── Himoyalangan endpointlar ──────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  // Kutubxona yaratish — FAQAT Super admin (markaziy) yoki muassasa o'zini
  // ulashi (onboarding). Viloyat/tuman adminlar yarata OLMAYDI (to'lov/hisob
  // nazorati Super adminda).
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN)
  create(@Body() dto: CreateLibraryDto, @CurrentUser() user: JwtPayload) {
    return this.librariesService.create(dto, user.sub);
  }

  @Put(":id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.MUASSASA_ADMIN)
  update(@Param("id") id: string, @Body() dto: UpdateLibraryDto) {
    return this.librariesService.update(id, dto);
  }

  @Patch(":id/approve/tuman")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  approveByTuman(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.librariesService.approveByTuman(id, user.sub);
  }

  @Patch(":id/approve/super")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  approveBySuperAdmin(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.librariesService.approveBySuperAdmin(id, user.sub);
  }

  @Patch(":id/reject")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  reject(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @CurrentUser() user: JwtPayload
  ) {
    return this.librariesService.reject(id, user.sub, reason);
  }

  @Patch(":id/freeze")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  freeze(
    @Param("id") id: string,
    @Body("reason") reason: string,
    @CurrentUser() user: JwtPayload
  ) {
    return this.librariesService.freeze(id, reason, user.sub);
  }

  @Patch(":id/unfreeze")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  unfreeze(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.librariesService.unfreeze(id, user.sub);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  softDelete(
    @Param("id") id: string,
    @Body("confirmation") confirmation: string,
    @CurrentUser() user: JwtPayload
  ) {
    return this.librariesService.softDelete(id, confirmation, user.sub);
  }

  @Get(":id/inventory")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TUMAN_ADMIN, UserRole.MUASSASA_ADMIN, UserRole.KUTUBXONACHI)
  getInventory(@Param("id") id: string) {
    return this.librariesService.getInventoryReport(id);
  }

  // ── BOOK-02 (Plan 02-05): Confirm an inter-library transfer ──────────────
  // POST /libraries/:libraryId/transfers/:transferId/confirm
  // Only the source-library librarian (Institution.directorId) or an admin
  // tier (SUPER_ADMIN, TUMAN_ADMIN, VILOYAT_ADMIN) may call this. Atomically
  // marks the BookTransfer CONFIRMED and increments the source library's
  // Book.availableCount by 1.
  @Post(":libraryId/transfers/:transferId/confirm")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.KUTUBXONACHI,
    UserRole.SUPER_ADMIN,
    UserRole.TUMAN_ADMIN,
    UserRole.VILOYAT_ADMIN
  )
  confirmTransfer(
    @Param("libraryId") libraryId: string,
    @Param("transferId") transferId: string,
    @CurrentUser() user: JwtPayload
  ) {
    return this.librariesService.confirmTransfer(libraryId, transferId, {
      id: user.sub,
      role: user.role
    });
  }
}
