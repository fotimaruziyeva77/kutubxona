import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";
import { SubscriptionStatus } from "@prisma/client";

/**
 * Plan 04-03 PAY-06 / PAY-08: admin subscription status mutation body.
 *
 * Service layer (SubscriptionService.updateStatus + assertSubscriptionTransition)
 * enforces that `reason` is non-empty when `status` is FROZEN or DELETED.
 * This DTO only enforces "if reason is present, it's a meaningful string"
 * — leaving the conditional-requirement check to the service so the single
 * source of truth for the rule is the state-machine validator.
 *
 * Plan 04-03 audit-fix FIX G — tighter reason validation.
 *   - Old @MinLength(3) accepted "   " (3 spaces) — that bypassed the spirit
 *     of "audit log row must carry a real reason".
 *   - New @Matches pattern requires a non-whitespace first char + at least
 *     2 additional non-whitespace chars. The service-side
 *     `reason.trim().length >= 3` check in assertSubscriptionTransition is
 *     the redundant defence.
 */
export class SubscriptionStatusUpdateDto {
  @IsEnum(SubscriptionStatus, {
    message: "status TRIAL | PENDING | ACTIVE | FROZEN | DELETED bo'lishi kerak",
  })
  status!: SubscriptionStatus;

  @IsOptional()
  @IsString()
  @Matches(/^\S.{2,}/, {
    message: "Sabab bo'sh joydan boshlanmasligi va kamida 3 belgi bo'lishi kerak",
  })
  reason?: string;
}
