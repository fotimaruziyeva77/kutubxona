import {
  IsString,
  IsNumber,
  IsOptional,
  IsObject,
  IsIn,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * Plan 04-02 PAY-01 — Typed DTOs for the Payme JSON-RPC 2.0 webhook payload.
 *
 * Per https://developer.payme.uz/, the merchant API exposes six methods:
 *   CheckPerformTransaction, CreateTransaction, PerformTransaction,
 *   CancelTransaction, CheckTransaction, GetStatement.
 *
 * Plan 04-02 audit-fix FIX D4 — the per-method DTOs below
 * (CheckPerformTransactionParamsDto, CreateTransactionParamsDto, etc.) are
 * RETAINED as documentation of the wire contract even though the dispatcher
 * does NOT plumb them through class-validator. Payme's JSON-RPC params shape
 * is method-dependent and class-validator's discriminator support is not
 * a clean fit. The actual runtime contract is enforced inline in
 * PaymeService.handleWebhook via concrete defensive checks
 * (Number.isFinite for amount, presence of params.account.invoiceId, etc.).
 * Keep this file in sync when Payme's API spec changes — that helps future
 * maintainers understand what each handler expects to receive.
 */

const PAYME_METHODS = [
  "CheckPerformTransaction",
  "CreateTransaction",
  "PerformTransaction",
  "CancelTransaction",
  "CheckTransaction",
  "GetStatement",
] as const;

export class PaymeRpcAccountDto {
  @IsString()
  invoiceId!: string;
}

export class CheckPerformTransactionParamsDto {
  @IsObject()
  @ValidateNested()
  @Type(() => PaymeRpcAccountDto)
  account!: PaymeRpcAccountDto;

  @IsNumber()
  amount!: number;
}

export class CreateTransactionParamsDto {
  @IsString()
  id!: string;

  @IsNumber()
  time!: number;

  @IsNumber()
  amount!: number;

  @IsObject()
  @ValidateNested()
  @Type(() => PaymeRpcAccountDto)
  account!: PaymeRpcAccountDto;
}

export class PerformTransactionParamsDto {
  @IsString()
  id!: string;
}

export class CancelTransactionParamsDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsNumber()
  reason?: number;
}

export class CheckTransactionParamsDto {
  @IsString()
  id!: string;
}

export class GetStatementParamsDto {
  @IsNumber()
  from!: number;

  @IsNumber()
  to!: number;
}

/**
 * The top-level JSON-RPC envelope. `method` is required and constrained to the
 * six known method names. `params` is validated structurally as an object —
 * the per-method narrowing happens inside the dispatcher.
 */
export class PaymeRpcRequestDto {
  @IsString()
  jsonrpc!: string;

  // Payme allows numeric or string ids; class-validator IsString is too narrow
  // and IsNumber too narrow, so we accept either as a permissive primitive.
  // The DTO discriminator only cares about method; id is echoed back unchanged.
  id!: number | string;

  @IsString()
  @IsIn(PAYME_METHODS as unknown as string[])
  method!: string;

  @IsObject()
  params!: Record<string, unknown>;
}
