import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { AnyAuthenticatedGuard } from './any-authenticated.guard.js';
import { CsrfGuard } from './csrf.guard.js';

@Injectable()
export class MutationAuthGuard implements CanActivate {
  constructor(
    private readonly authenticated: AnyAuthenticatedGuard,
    private readonly csrf: CsrfGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.authenticated.canActivate(context);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.authPrincipal?.kind === 'browser' ? this.csrf.canActivate(context) : true;
  }
}
