import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { Request } from "express";

/**
 * Har bir HTTP so'rovni loglaydi:
 * → [GET] /api/v1/books/search?q=Alpomish  200  45ms
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req    = context.switchToHttp().getRequest<Request>();
    const method = req.method;
    const url    = req.url;
    const start  = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const res  = context.switchToHttp().getResponse();
          const ms   = Date.now() - start;
          const code = res.statusCode;

          // 5xx — error level
          if (code >= 500) {
            this.logger.error(`[${method}] ${url}  ${code}  ${ms}ms`);
          } else if (code >= 400) {
            this.logger.warn(`[${method}] ${url}  ${code}  ${ms}ms`);
          } else {
            this.logger.log(`[${method}] ${url}  ${code}  ${ms}ms`);
          }
        },
        error: () => {
          const ms = Date.now() - start;
          this.logger.error(`[${method}] ${url}  ERROR  ${ms}ms`);
        },
      }),
    );
  }
}
