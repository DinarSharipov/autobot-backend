import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { BotRequestSignatureService } from './bot-request-signature.service.js';

@Injectable()
export class BotServiceGuard implements CanActivate {
  constructor(private readonly signatures: BotRequestSignatureService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.authPrincipal = await this.signatures.authenticate(request);
    return true;
  }
}
