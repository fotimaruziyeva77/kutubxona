import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { UserGender, UserType } from "@prisma/client";

/**
 * AUDIT-REPORT M2 — profil DTO lari avval TS interface edi, shuning uchun
 * global ValidationPipe ular uchun NO-OP bo'lardi (interface'lar runtime'da
 * yo'qoladi, metatype = Object). Endi class + class-validator dekoratorlari:
 * majburiy maydonlar, enum'lar va sana formati server tomonda tekshiriladi,
 * whitelist:true bilan begona maydonlar avtomatik olib tashlanadi.
 *
 * userId DTO da YO'Q — controller uni JWT sub dan oladi
 * (`{ ...dto, userId: user.sub }`), shuning uchun body orqali boshqa
 * foydalanuvchi profilini to'ldirib bo'lmaydi.
 */
export class CompleteProfileDto {
  // Step 2 — Shaxsiy ma'lumotlar
  @ApiProperty({ example: "Alisher Navoiy" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: "2000-01-01", description: "ISO 8601 sana" })
  @IsDateString()
  dob!: string; // ISO date string

  @ApiProperty({ enum: UserGender })
  @IsEnum(UserGender)
  gender!: UserGender;

  // Step 3 — Manzil
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  viloyatId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tumanId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  mahallaId!: string;

  @ApiProperty({ example: "Mustaqillik" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street!: string;

  @ApiProperty({ example: "12" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  house!: string;

  @ApiProperty({ example: "34" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  apartment!: string;

  // Step 4 — Foydalanuvchi turi
  @ApiProperty({ enum: UserType })
  @IsEnum(UserType)
  type!: UserType;

  // Step 4 — Qo'shimcha (tur bo'yicha ixtiyoriy)
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  schoolId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  schoolClass?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  universityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  faculty?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  direction?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  studyCourse?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  department?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  position?: string;
}

/**
 * M2 — PUT /users/me body. Barcha maydonlar ixtiyoriy, faqat string.
 * Bo'sh string ("") rad etilmaydi — service avvalgidek `if (dto.name)`
 * orqali uni no-op deb qabul qiladi (joriy semantika saqlangan).
 */
export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  street?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  house?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  apartment?: string;
}
