import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MinLength,
  IsIn,
} from "class-validator";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import {
  CurrentUser,
  JwtPayload,
} from "../../common/decorators/current-user.decorator";
import { AdminAccountsService } from "./admin-accounts.service";

const CREATABLE_ROLES = [
  "VILOYAT_ADMIN",
  "TUMAN_ADMIN",
  "MUASSASA_ADMIN",
  "KUTUBXONACHI",
  "KLUB_RAHBARI",
  "BUXGALTER",
  "DOKON_OPERATOR",
];

class CreateAccountBody {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() phone!: string;
  @IsString() @IsIn(CREATABLE_ROLES) role!: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() dob?: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
  @IsOptional() @IsString() viloyatId?: string;
  @IsOptional() @IsString() tumanId?: string;
  @IsOptional() @IsString() mahallaId?: string;
  @IsOptional() @IsString() organizationId?: string;
  @IsOptional() @IsString() schoolId?: string;
  @IsOptional() @IsString() universityId?: string;
}

class ResetPwdBody {
  @IsOptional() @IsString() @MinLength(8) password?: string;
}

class RegisterReaderBody {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() phone!: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() dob?: string;
  @IsOptional() @IsString() viloyatId?: string;
  @IsOptional() @IsString() tumanId?: string;
  @IsOptional() @IsString() mahallaId?: string;
  @IsOptional() @IsString() schoolClass?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsString() position?: string;
}

// Akaunt boshqaruvi FAQAT SUPER_ADMIN uchun — adminlar/xodimlar yaratish,
// vaqtinchalik parol berish, parolni tiklash va akauntni o'chirish.
@ApiTags("admin-accounts")
@ApiBearerAuth()
@Controller("admin/accounts")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Post()
  @ApiOperation({
    summary: "Yangi admin/xodim akaunti (vaqtinchalik parol bilan)",
  })
  create(@Body() dto: CreateAccountBody) {
    return this.accounts.createAccount(dto);
  }

  @Get()
  @ApiOperation({ summary: "Admin/xodim akauntlari ro'yxati" })
  list(
    @Query("role") role?: string,
    @Query("search") search?: string,
    @Query("page") page = "1",
    @Query("limit") limit = "20",
  ) {
    return this.accounts.listAccounts({
      role,
      search,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
    });
  }

  @Patch(":id/reset-password")
  @ApiOperation({ summary: "Akaunt parolini tiklash (yangi vaqtinchalik parol)" })
  reset(@Param("id") id: string, @Body() dto: ResetPwdBody) {
    return this.accounts.resetPassword(id, dto.password);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Akauntni o'chirish (yumshoq — status DELETED)" })
  remove(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.accounts.deleteAccount(id, user.sub);
  }
}

// Kutubxona/tashkilot "ish stoli" — kutubxonachi va muassasa admini walk-in
// kitobxon/xodimni ro'yhatga oladi. Akaunt boshqaruvidan (SUPER_ADMIN) alohida.
@ApiTags("library-desk")
@ApiBearerAuth()
@Controller("desk")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.KUTUBXONACHI, UserRole.MUASSASA_ADMIN, UserRole.SUPER_ADMIN)
export class LibraryDeskController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Post("readers")
  @ApiOperation({ summary: "Yangi kitobxon/xodim qo'shish (vaqtinchalik parol bilan)" })
  registerReader(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterReaderBody,
  ) {
    return this.accounts.registerReader(user.sub, dto);
  }
}
