import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";

/**
 * Global Exception Filter — barcha xatoliklarni bir formatda qaytaradi.
 *
 * Standart javob formati:
 * {
 *   statusCode: number,
 *   message: string | string[],
 *   error: string,
 *   timestamp: string,
 *   path: string
 * }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx  = host.switchToHttp();
    const req  = ctx.getRequest<Request>();
    const res  = ctx.getResponse<Response>();

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = "Ichki server xatosi";
    let error   = "Internal Server Error";

    // ── NestJS HTTP xatoliklar ───────────────────────────────────────────
    if (exception instanceof HttpException) {
      status  = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === "string") {
        message = resp;
      } else if (typeof resp === "object" && resp !== null) {
        message = (resp as any).message ?? message;
        error   = (resp as any).error ?? error;
      }
    }

    // ── Prisma xatoliklar ────────────────────────────────────────────────
    else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      status = HttpStatus.CONFLICT;
      switch (exception.code) {
        case "P2002":
          message = "Bu ma'lumot allaqachon mavjud (unique constraint)";
          error   = "Duplicate Entry";
          break;
        case "P2025":
          status  = HttpStatus.NOT_FOUND;
          message = "Ma'lumot topilmadi";
          error   = "Not Found";
          break;
        case "P2003":
          message = "Bog'liq ma'lumot topilmadi (foreign key)";
          error   = "Foreign Key Violation";
          break;
        default:
          message = `Database xatosi: ${exception.code}`;
          error   = "Database Error";
      }
      this.logger.warn(
        `Prisma ${exception.code}: ${exception.message.slice(0, 200)}`,
      );
    }

    // ── Prisma validation xatoliklar ─────────────────────────────────────
    else if (exception instanceof Prisma.PrismaClientValidationError) {
      status  = HttpStatus.BAD_REQUEST;
      message = "Ma'lumot validatsiya xatosi";
      error   = "Validation Error";
      this.logger.warn(`Prisma validation: ${exception.message.slice(0, 200)}`);
    }

    // ── Kutilmagan xatoliklar ─────────────────────────────────────────────
    else {
      const err = exception as Error;
      this.logger.error(
        `Kutilmagan xato [${req.method} ${req.url}]: ${err?.message ?? "unknown"}`,
        err?.stack,
      );
    }

    // ── Javob ─────────────────────────────────────────────────────────────
    res.status(status).json({
      statusCode: status,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: req.url,
    });
  }
}
