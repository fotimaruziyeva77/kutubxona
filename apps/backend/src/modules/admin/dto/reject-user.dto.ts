import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * PATCH /admin/users/:id/reject — rad etish sababi.
 *
 * Sabab ixtiyoriy (mavjud klientlar bo'sh body yuboradi va ular buzilmasligi
 * kerak), lekin berilgan bo'lsa mazmunli bo'lishi shart: sabab rad etilgan
 * foydalanuvchiga SMS orqali AYNAN shu ko'rinishda yetib boradi
 * (AdminService.rejectUser), shuning uchun "x" kabi qiymatlar to'siladi.
 *
 * 300 belgi chegarasi — SMS uzunligi va audit log o'qilishi uchun.
 */
export class RejectUserDto {
  @ApiProperty({
    example: "Maktab ro'yhatida bunday o'quvchi topilmadi",
    required: false,
    minLength: 3,
    maxLength: 300,
  })
  @IsOptional()
  @IsString()
  @MinLength(3, { message: "Rad etish sababi kamida 3 belgidan iborat bo'lsin" })
  @MaxLength(300, { message: "Rad etish sababi 300 belgidan oshmasin" })
  reason?: string;
}
