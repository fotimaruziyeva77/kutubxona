import { IsInt, IsNotEmpty, IsString, Max, Min } from "class-validator";

/**
 * Plan 05-03 T2 (STAT-07) — POST /admin/stats/order-request payload.
 *
 * `requestedQuantity` is bounded 1..100 (Max: ASVS V5 input validation) so a
 * tampered client can't post a 10-billion order and balloon the audit log.
 */
export class OrderRequestDto {
  @IsString()
  @IsNotEmpty()
  bookId!: string;

  @IsInt()
  @Min(1)
  @Max(100)
  requestedQuantity!: number;
}
