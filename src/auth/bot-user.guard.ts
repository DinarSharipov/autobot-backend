import { CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { ApiHttpException } from '../common/http/api-http.exception.js';
import { IdentityService } from '../users/identity.service.js';

@Injectable()
export class BotUserGuard implements CanActivate {
  constructor(private readonly identities: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const servicePrincipal = request.authPrincipal;
    if (!servicePrincipal || servicePrincipal.kind !== 'bot-service') {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'BOT_AUTH_REQUIRED',
        'Authenticated bot service access is required.',
      );
    }

    const user = await this.identities.findByTelegramUserId(servicePrincipal.telegramUserId);
    if (!user || user.status !== 'ACTIVE') {
      throw new ApiHttpException(
        HttpStatus.UNAUTHORIZED,
        'TELEGRAM_USER_NOT_RESOLVED',
        'The Telegram user has not been resolved.',
      );
    }

    request.authPrincipal = {
      ...servicePrincipal,
      kind: 'bot-user',
      userId: user.id,
    };
    return true;
  }
}
