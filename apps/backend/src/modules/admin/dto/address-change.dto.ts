import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Plan 06-03 FAM-06 — user-initiated address-change submission body.
 *
 * `reason` is REQUIRED (min 10 chars, max 500) per D-OQ-2 V1 contract:
 * free-text V1, document upload V2. ASVS V5 input bounds prevent a tampered
 * client from posting megabyte payloads into the audit log.
 */
export class CreateAddressChangeDto {
  @IsString()
  @IsNotEmpty()
  toAddressId!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/**
 * Plan 06-03 FAM-06 — admin approve has no body (target id in :id param).
 * Reject requires a reason (min 3 chars) so admins can't silent-reject
 * without forensic context.
 */
export class RejectAddressChangeDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Plan 06-03 FAM-06 — list filter.
 */
export class ListAddressChangeQuery {
  @IsOptional()
  @IsString()
  status?: "PENDING" | "APPROVED" | "REJECTED";
}
