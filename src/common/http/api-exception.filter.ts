import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { RequestWithId } from './request-id.middleware.js';

type ExceptionBody = {
  code?: string;
  message?: string | string[];
  details?: Record<string, unknown>;
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = (request as RequestWithId).requestId ?? 'unknown';
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionBody = this.getExceptionBody(exception);

    if (status >= 500) {
      this.logger.error({
        event: 'http_request_failed',
        requestId,
        method: request.method,
        path: request.path,
        status,
        exception: exception instanceof Error ? exception.name : 'UnknownError',
      });
    }

    response.status(status).json({
      error: {
        code: exceptionBody.code ?? this.defaultCode(status),
        message: this.safeMessage(status, exceptionBody.message),
        details: exceptionBody.details ?? this.validationDetails(exceptionBody.message),
        requestId,
      },
    });
  }

  private getExceptionBody(exception: unknown): ExceptionBody {
    if (!(exception instanceof HttpException)) {
      return {};
    }

    const response = exception.getResponse();
    return typeof response === 'string' ? { message: response } : response;
  }

  private safeMessage(status: number, message: string | string[] | undefined): string {
    if (status >= 500) {
      return status === 503
        ? 'A required service is temporarily unavailable.'
        : 'An unexpected error occurred.';
    }

    if (Array.isArray(message)) {
      return 'Request validation failed.';
    }

    return message ?? 'Request failed.';
  }

  private validationDetails(message: string | string[] | undefined): Record<string, unknown> {
    return Array.isArray(message) ? { issues: message } : {};
  }

  private defaultCode(status: number): string {
    const codes: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'DEPENDENCY_UNAVAILABLE',
    };

    return codes[status] ?? 'INTERNAL_ERROR';
  }
}
