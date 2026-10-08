import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

import type { RequestWithId } from './request-id.middleware.js';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();

    return next.handle().pipe(
      tap({
        complete: () => {
          this.logger.log({
            event: 'http_request_completed',
            requestId: (request as RequestWithId).requestId,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          });
        },
      }),
    );
  }
}
