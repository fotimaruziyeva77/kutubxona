import {
  IsString,
  IsNumber,
  IsOptional,
  IsNotEmpty,
} from "class-validator";

/**
 * Plan 04-02 PAY-02 — Typed DTOs for the Click webhook form-encoded payload.
 *
 * Per https://docs.click.uz/en/click-api-request/, Click posts `application/x-www-form-urlencoded`
 * to /prepare and /complete with these fields. NestJS body parser converts
 * form-data to a plain object — class-validator decorators run after that.
 *
 * Note: Click sends every field as a string (form encoding has no type
 * distinction), even numeric-looking values like `amount` and `error`. We
 * accept string-or-number on `error` because some integration tests post JSON
 * with numeric error.
 */

export class ClickPrepareDto {
  @IsString()
  @IsNotEmpty()
  click_trans_id!: string;

  @IsString()
  @IsNotEmpty()
  service_id!: string;

  @IsOptional()
  @IsString()
  click_paydoc_id?: string;

  @IsString()
  @IsNotEmpty()
  merchant_trans_id!: string;

  @IsString()
  @IsNotEmpty()
  amount!: string;

  // Click sends action as the string "0" for prepare or "1" for complete.
  // The runtime guard in click.service.ts coerces and rejects mismatch.
  @IsNotEmpty()
  action!: string | number;

  @IsNumber()
  error!: number;

  @IsOptional()
  @IsString()
  error_note?: string;

  @IsString()
  @IsNotEmpty()
  sign_time!: string;

  @IsString()
  @IsNotEmpty()
  sign_string!: string;
}

export class ClickCompleteDto {
  @IsString()
  @IsNotEmpty()
  click_trans_id!: string;

  @IsString()
  @IsNotEmpty()
  service_id!: string;

  @IsOptional()
  @IsString()
  click_paydoc_id?: string;

  @IsString()
  @IsNotEmpty()
  merchant_trans_id!: string;

  // Complete REQUIRES merchant_prepare_id — see Plan 04-01 FIX 1 guard.
  @IsString()
  @IsNotEmpty()
  merchant_prepare_id!: string;

  @IsString()
  @IsNotEmpty()
  amount!: string;

  @IsNotEmpty()
  action!: string | number;

  @IsNumber()
  error!: number;

  @IsOptional()
  @IsString()
  error_note?: string;

  @IsString()
  @IsNotEmpty()
  sign_time!: string;

  @IsString()
  @IsNotEmpty()
  sign_string!: string;
}
