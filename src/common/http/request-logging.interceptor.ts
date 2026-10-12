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
import { MetricsService } from '../observability/metrics.service.js';

type RoutedRequest = { route?: { path?: unknown }; path: string };

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();

    return next.handle().pipe(
      tap({
        complete: () => {
          const durationSeconds = (performance.now() - startedAt) / 1000;
          const routedRequest = request as unknown as RoutedRequest;
          const route =
            typeof routedRequest.route?.path === 'string'
              ? routedRequest.route.path
              : routedRequest.path;
          this.metrics.increment('autobot_http_requests_total', {
            method: request.method,
            route,
            status: response.statusCode,
          });
          this.metrics.observe('autobot_http_request_duration_seconds', durationSeconds, {
            method: request.method,
            route,
          });
          this.logger.log({
            event: 'http_request_completed',
            requestId: (request as RequestWithId).requestId,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            durationMs: Math.round(durationSeconds * 100_000) / 100,
          });
        },
      }),
    );
  }
}
