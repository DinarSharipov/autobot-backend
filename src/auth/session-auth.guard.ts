import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { SessionService } from './session.service.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.sessions.authenticate(request);
    request.authPrincipal = session.principal;
    request.sessionExpiresAt = session.expiresAt;
    return true;
  }
}
