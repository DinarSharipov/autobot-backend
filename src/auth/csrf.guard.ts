import { CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { SessionService } from './session.service.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.authPrincipal;
    if (!principal || principal.kind !== 'browser') {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'SESSION_REQUIRED',
        'An active browser session is required.',
      );
    }

    await this.sessions.validateCsrf(principal.sessionId, request.get('x-csrf-token'));
    return true;
  }
}
