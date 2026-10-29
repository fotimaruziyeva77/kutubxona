import { IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

/**
 * Plan 05-04 Task 3 — POST /admin/test-push DTO (SUPER_ADMIN only).
 *
 * Used by ops for FCM live verification AND by the Plan 05-05 ALERT-06
 * system-down test path. Target userId is required; title is optional and
 * defaults inside NotificationProcessor to "SIFAT LIBRARY".
 */
export class TestPushDto {
  @ApiProperty({ example: "ckxxxxxxxxxxxxxxxxxx" })
  @IsString()
  userId!: string;

  @ApiProperty({ example: "Test push", required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ example: "Bu sinov bildirishnomasi." })
  @IsString()
  @MaxLength(500)
  message!: string;
}
