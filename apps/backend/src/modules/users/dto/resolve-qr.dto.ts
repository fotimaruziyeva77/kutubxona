import { IsString, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * TZ §VIII.1 R22 — POST /users/qr/resolve DTO.
 *
 * `token` ikki ko'rinishda keladi:
 *   - Aylanuvchi token: `${base64url(payload)}.${hmacHex}` (~115 belgi)
 *   - Legacy statik sifatId: `SL-UZ-...` (eski bosma kartalar)
 *
 * 600 belgi yuqori chegara — har ikkala formatga ham yetarli, baza/log
 * floodga qarshi himoya.
 */
export class ResolveQrDto {
  @ApiProperty({
    example: "eyJ1IjoiY2x4Li4uIiwidyI6NTkzMzYyMH0.9f2a...",
    description:
      "Aylanuvchi QR token yoki legacy statik SifatID (SL-UZ-...)",
  })
  @IsString()
  @Length(4, 600)
  token!: string;
}
