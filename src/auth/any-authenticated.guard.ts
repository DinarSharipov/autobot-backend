import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/auth/auth-principal.js';
import { BotServiceGuard } from './bot-service.guard.js';
import { BotUserGuard } from './bot-user.guard.js';
import { SessionAuthGuard } from './session-auth.guard.js';

@Injectable()
export class AnyAuthenticatedGuard implements CanActivate {
  constructor(
    private readonly browser: SessionAuthGuard,
    private readonly botService: BotServiceGuard,
    private readonly botUser: BotUserGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.get('x-autobot-signature')) {
      await this.botService.canActivate(context);
      return this.botUser.canActivate(context);
    }

    return this.browser.canActivate(context);
  }
}
