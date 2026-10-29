import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";

/**
 * Demo so'rov (B2B lead) DTO'lari.
 *
 * NEGA KERAK: `POST /admin/demo-request` ochiq (@Public) endpoint va avval
 * `@Body()` inline TypeScript tipi bilan qabul qilinardi. Global
 * ValidationPipe FAQAT class-validator dekoratorlari bor SINF'lar ustida
 * ishlaydi — inline tip bilan u umuman ishga tushmaydi. Natijada:
 *   • cheksiz uzunlikdagi matn to'g'ridan-to'g'ri DB'ga tushardi (disk DoS),
 *   • `orgType` ixtiyoriy qiymat bo'lishi mumkin edi va admin panelidagi
 *     STATUS/TYPE xaritalaridan tushib qolardi,
 *   • telefon formati tekshirilmasdi — sotuv bo'limi qo'ng'iroq qila
 *     olmaydigan "lead" yig'ilardi,
 *   • CR/LF belgilari admin email xabarnomasiga tushardi (header injection
 *     sinfidagi xavf; escapeHtml uni yopadi, lekin kirishda to'sish arzonroq).
 *
 * Har bir maydon TRIM qilinadi: "  " (faqat bo'shliq) yuborilsa
 * `@MinLength` ushlaydi, aks holda bo'sh tashkilot nomi saqlanardi.
 */

/** Formaga mos tashkilot turlari — frontend select bilan bir xil ro'yxat. */
export const DEMO_ORG_TYPES = [
  "MAKTAB",
  "OTM",
  "IDORA",
  "MAHALLA",
  "OTHER",
] as const;

/** CRM holatlari — server tomonda majburlanadi (avval erkin matn edi). */
export const DEMO_REQUEST_STATUSES = [
  "PENDING",
  "CONTACTED",
  "CLOSED",
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export class CreateDemoRequestDto {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: "Tashkilot nomi kamida 2 belgi bo'lishi kerak" })
  @MaxLength(160, { message: "Tashkilot nomi 160 belgidan oshmasligi kerak" })
  @Matches(/^[^\r\n]+$/, {
    message: "Tashkilot nomida yangi qator belgisi bo'lmasligi kerak",
  })
  // Burchakli qavslar hech bir haqiqiy muassasa nomida uchramaydi, lekin
  // `<script>` ko'rinishidagi qiymat DB'da qolib, admin paneli va email
  // shabloniga tushadi. Chiqishda ikkalasi ham ekranlaydi (React avtomatik,
  // email `escapeHtml` bilan), shuning uchun bu QO'SHIMCHA qatlam — lekin
  // kirishda to'sish arzonroq va CRM ro'yxatini toza saqlaydi.
  @Matches(/^[^<>]+$/, {
    message: "Tashkilot nomida < va > belgilari bo'lmasligi kerak",
  })
  organization!: string;

  /**
   * O'zbekiston raqami: +998 + 9 raqam. Kosmetik ajratgichlar (bo'shliq,
   * defis, qavs) qabul qilinadi va tekshirishdan oldin olib tashlanadi —
   * foydalanuvchi "+998 90 123 45 67" deb yozsa ham forma o'tadi.
   */
  @Transform(({ value }) =>
    typeof value === "string" ? value.replace(/[\s\-()]/g, "") : value,
  )
  @IsString()
  @Matches(/^\+998\d{9}$/, {
    message: "Telefon +998XXXXXXXXX ko'rinishida bo'lishi kerak",
  })
  phone!: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail({}, { message: "Email formati noto'g'ri" })
  @MaxLength(160)
  email?: string;

  @IsIn(DEMO_ORG_TYPES as unknown as string[], {
    message: `orgType ${DEMO_ORG_TYPES.join(" | ")} dan biri bo'lishi kerak`,
  })
  orgType!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: "Xabar 2000 belgidan oshmasligi kerak" })
  message?: string;
}

export class UpdateDemoRequestDto {
  @IsOptional()
  @IsIn(DEMO_REQUEST_STATUSES as unknown as string[], {
    message: `status ${DEMO_REQUEST_STATUSES.join(" | ")} dan biri bo'lishi kerak`,
  })
  status?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: "Izoh 2000 belgidan oshmasligi kerak" })
  adminNote?: string;
}
